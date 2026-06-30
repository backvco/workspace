// Idle agent-session reaper.
//
// Agent/chat/planner tmux sessions are only torn down on explicit accept/delete
// (see agents.js stopAgent/removeTask, planners.js stopPlanner). A finished or
// stalled agent therefore parks at a prompt indefinitely, holding its claude
// process plus its MCP servers — hundreds of MB each, multiplied across every
// live agent. Left alone they accumulate until the box runs out of memory.
//
// This sweeps agent-owned sessions with no tmux activity for longer than the
// configured idle TTL and kills them. It targets ONLY sessions derived from DB
// state (agent tasks, their chats, plan-review chats, planners) — never the
// operator's manual terminal tabs. Nothing is lost: every ticket has a durable
// claudeSessionId and its state lives in Postgres, so reopening the chat just
// --resumes it. A session that is actively streaming output (its claude footer
// shows "esc to interrupt") is skipped regardless of the timer, so a
// long-running-but-quiet agent is safe.
//
// Settings (enabled / idleMs / intervalMs) are admin-editable at runtime (see
// the Settings > Sessions tab) and persisted in the `settings` table, falling
// back to cfg.agentIdleReapMs / cfg.agentReapIntervalMs (env-configured) until
// an admin saves an override.
import { execFile } from 'node:child_process';
import { sessionName } from './config.js';
import { planBranchFor } from './plan-branch.js';
import { q } from './db.js';

const SETTINGS_KEY = 'reaper.config';

const sh = (cmd, args) =>
  new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 22 }, (e, o, er) =>
    res({ ok: !e, out: (o || '').toString(), err: (er || '').toString() })));

export async function getReaperSettings(cfg) {
  let v = {};
  try { v = (await q(cfg, 'SELECT value FROM settings WHERE key = $1', [SETTINGS_KEY]))[0]?.value || {}; } catch {}
  return {
    enabled: v.enabled !== false, // default on
    idleMs: Number(v.idleMs) || cfg.agentIdleReapMs || 1800000,
    intervalMs: Number(v.intervalMs) || cfg.agentReapIntervalMs || 300000,
  };
}

export async function setReaperSettings(cfg, patch) {
  const cur = await getReaperSettings(cfg);
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
    // clamp to sane bounds: 1min-24h idle TTL, 30s-1h sweep interval
    idleMs: Math.max(60000, Math.min(86400000, Number(patch.idleMs ?? cur.idleMs) || cur.idleMs)),
    intervalMs: Math.max(30000, Math.min(3600000, Number(patch.intervalMs ?? cur.intervalMs) || cur.intervalMs)),
  };
  await q(cfg, `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
                ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`, [SETTINGS_KEY, JSON.stringify(next)]);
  return next;
}

// Map of session name -> {kind, label, ns} for every session derived from
// current DB state (agent tasks, their chats, plan-review chats, planners).
async function ownedSessions(cfg) {
  const m = new Map();
  try {
    const tasks = await q(cfg, 'SELECT data FROM agent_tasks');
    for (const { data: t } of tasks) {
      const ns = t.ns || 'default';
      m.set(sessionName(cfg, ns, t.id), { kind: 'agent', label: t.title || t.id, ns });
      m.set(sessionName(cfg, ns, `chat-${t.id}`), { kind: 'chat', label: `Chat: ${t.title || t.id}`, ns });
      if (t.plan) {
        const key = `plan-chat-${planBranchFor(t) || t.plan}`.replace(/[^\w-]/g, '_');
        m.set(sessionName(cfg, ns, key), { kind: 'plan-chat', label: `Plan review: ${t.plan}`, ns });
      }
    }
  } catch (e) { console.error('[agent-reaper] task query failed:', e.message); }
  try {
    const planners = await q(cfg, 'SELECT data FROM planners');
    for (const { data: p } of planners) {
      m.set(sessionName(cfg, p.ns || 'default', `plan-${p.id}`), { kind: 'planner', label: `Plan: ${p.name || p.id}`, ns: p.ns || 'default' });
    }
  } catch (e) { console.error('[agent-reaper] planner query failed:', e.message); }
  return m;
}

// Map of live session name -> seconds since last activity.
async function liveSessions() {
  const r = await sh('tmux', ['list-sessions', '-F', '#{session_name} #{session_activity}']);
  const m = new Map();
  if (!r.ok) return m; // no server / no sessions
  const nowSec = Math.floor(Date.now() / 1000);
  for (const line of r.out.split('\n')) {
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const name = line.slice(0, sp);
    const act = Number(line.slice(sp + 1));
    if (name && act) m.set(name, nowSec - act);
  }
  return m;
}

// A session whose claude UI is mid-run shows "esc to interrupt" in its footer.
// Never reap those, even if tmux activity looks stale.
async function isActivelyRunning(session) {
  const r = await sh('tmux', ['capture-pane', '-p', '-t', session]);
  return r.ok && /esc to interrupt/.test(r.out);
}

export async function reapIdleAgents(cfg, settings) {
  const s = settings || await getReaperSettings(cfg);
  const ttlSec = s.idleMs / 1000;
  const owned = await ownedSessions(cfg);
  if (!owned.size) return { reaped: 0 };
  const live = await liveSessions();
  let reaped = 0;
  for (const [name, idleSec] of live) {
    if (!owned.has(name) || idleSec < ttlSec) continue;
    if (await isActivelyRunning(name)) continue;
    if ((await sh('tmux', ['kill-session', '-t', name])).ok) {
      reaped++;
      console.log(`[agent-reaper] killed idle session ${name} (idle ${Math.round(idleSec / 60)}m)`);
    }
  }
  return { reaped };
}

// Every live agent-owned session with its idle time + kind/label, for the
// admin Settings UI. Sorted most-idle first.
export async function listOwnedSessions(cfg) {
  const owned = await ownedSessions(cfg);
  const live = await liveSessions();
  const out = [];
  for (const [name, idleSec] of live) {
    const meta = owned.get(name);
    if (!meta) continue;
    out.push({ name, ...meta, idleSec, active: await isActivelyRunning(name) });
  }
  out.sort((a, b) => b.idleSec - a.idleSec);
  return out;
}

// Manually kill ONE owned session right now, regardless of idle time — an
// explicit admin action. Still refuses anything not in the owned set, so the
// operator's manual terminal tabs are never reachable from here.
export async function killOwnedSession(cfg, name) {
  const owned = await ownedSessions(cfg);
  if (!owned.has(name)) return { error: 'not an agent-owned session' };
  return { ok: (await sh('tmux', ['kill-session', '-t', name])).ok };
}

// Checks every 30s whether a sweep is due (cheap — no DB/tmux read unless the
// configured interval has elapsed), so an admin's interval change takes effect
// on the next check without restarting the process.
export function startAgentReaper(cfg) {
  let lastSweep = 0;
  const iv = setInterval(() => {
    (async () => {
      const s = await getReaperSettings(cfg);
      if (!s.enabled) return;
      if (Date.now() - lastSweep < s.intervalMs) return;
      lastSweep = Date.now();
      const r = await reapIdleAgents(cfg, s);
      if (r.reaped) console.log(`[agent-reaper] sweep: reaped ${r.reaped}`);
    })().catch((e) => console.error('[agent-reaper] sweep failed:', e.message));
  }, 30000);
  iv.unref?.();
  return iv;
}
