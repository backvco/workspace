// Idle agent-session reaper.
//
// Agent/chat/planner tmux sessions are only torn down on explicit accept/delete
// (see agents.js stopAgent/removeTask, planners.js stopPlanner). A finished or
// stalled agent therefore parks at a prompt indefinitely, holding its claude
// process plus its MCP servers — hundreds of MB each, multiplied across every
// live agent. Left alone they accumulate until the box runs out of memory.
//
// This sweeps agent-owned sessions with no tmux activity for longer than
// cfg.agentIdleReapMs and kills them. It targets ONLY sessions derived from DB
// state (agent tasks, their chats, planners) — never the operator's manual
// terminal tabs. Nothing is lost: every ticket has a durable claudeSessionId and
// its state lives in Postgres, so reopening the chat just --resumes it. A session
// that is actively streaming output (its claude footer shows "esc to interrupt")
// is skipped regardless of the timer, so a long-running-but-quiet agent is safe.
import { execFile } from 'node:child_process';
import { sessionName } from './config.js';
import { q } from './db.js';

const sh = (cmd, args) =>
  new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 22 }, (e, o, er) =>
    res({ ok: !e, out: (o || '').toString(), err: (er || '').toString() })));

// All session names owned by the agent system, from current DB state.
async function ownedSessions(cfg) {
  const names = new Set();
  try {
    const tasks = await q(cfg, 'SELECT data FROM agent_tasks');
    for (const { data: t } of tasks) {
      const ns = t.ns || 'default';
      names.add(sessionName(cfg, ns, t.id));
      names.add(sessionName(cfg, ns, `chat-${t.id}`));
    }
  } catch (e) { console.error('[agent-reaper] task query failed:', e.message); }
  try {
    const planners = await q(cfg, 'SELECT data FROM planners');
    for (const { data: p } of planners) names.add(sessionName(cfg, p.ns || 'default', `plan-${p.id}`));
  } catch (e) { console.error('[agent-reaper] planner query failed:', e.message); }
  return names;
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

export async function reapIdleAgents(cfg) {
  const ttlSec = (cfg.agentIdleReapMs || 1800000) / 1000;
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

export function startAgentReaper(cfg) {
  const ms = cfg.agentReapIntervalMs || 300000;
  const iv = setInterval(() => {
    reapIdleAgents(cfg).catch((e) => console.error('[agent-reaper] sweep failed:', e.message));
  }, ms);
  iv.unref?.();
  return iv;
}
