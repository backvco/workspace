// Agent Manager (Postgres-backed). Tickets are first-class: created in 'todo'
// (no agent), dispatched with startTask() which spawns a Claude Code agent as a
// tmux session in the ticket's project namespace (a git worktree for code repos),
// then driven through a gated pipeline. State writes go through a row lock so
// concurrent agent events + operator actions can't clobber each other.
//
// Lifecycle: todo -> planning -> plan-review -> executing -> (blocked) -> review -> done
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { sessionName } from './config.js';
import { listRepos, defaultBranch } from './git.js';
import { planBranchFor, ensurePlanBase, landToPlan, finishConflictedLand, openPlanPR } from './plan-branch.js';
import { q, lockedUpdate, withTx } from './db.js';
import { runReview } from './agent-review.js';
import { adviseBacklog, enhanceTicket, planTickets } from './agent-assist.js';
import { projectIdForDir, projectDir } from './projects.js';
import { rolePrompt } from './roles.js';

const sh = (cmd, args, opts = {}) =>
  new Promise((res) =>
    execFile(cmd, args, { maxBuffer: 1 << 22, ...opts }, (e, o, er) =>
      res({ ok: !e, out: (o || '').toString(), err: (er || '').toString() })));

function worktreeBase(cfg) {
  const d = path.join(cfg.projectRoots[0] || '/workspace', '.agent-worktrees');
  mkdirSync(d, { recursive: true });
  return d;
}

let seq = 0;
function genId() { seq += 1; return `a${Date.now().toString(36)}${seq.toString(36)}`; }

// Session name for a task: namespaced by the ticket's project (ns).
function sessionFor(cfg, task) { return sessionName(cfg, task.ns || 'default', task.id); }

// Scope an agent's MCP to ONLY the tickets server. Without an explicit
// --mcp-config, a spawned agent inherits the operator's global ~/.claude.json
// (playwright/kubernetes/mysql/github), spawning that whole heavy fleet per agent
// — hundreds of MB each, multiplied across every live agent. Agents only need
// `tickets`. Returns a shell-quoted ` --mcp-config '...'` fragment.
function ticketsMcpArg(cfg, task) {
  const mcpScript = path.join(cfg.appRoot, 'server', 'mcp', 'tickets-mcp.js');
  const mcpConfig = JSON.stringify({ mcpServers: { tickets: { command: 'node', args: [mcpScript], env: { WORKSPACE_PORT: String(cfg.port), WORKSPACE_API_TOKEN: cfg.internalToken, AGENT_TASK_ID: task.id } } } }).replace(/'/g, `'\\''`);
  return ` --mcp-config '${mcpConfig}'`;
}

async function getTask(cfg, id) {
  const r = await q(cfg, 'SELECT data FROM agent_tasks WHERE id = $1', [id]);
  return r[0] ? r[0].data : null;
}

async function sendLine(cfg, session, text) {
  await sh('tmux', ['send-keys', '-t', session, '-l', text]);
  return (await sh('tmux', ['send-keys', '-t', session, 'Enter'])).ok;
}
async function alive(session) { return (await sh('tmux', ['has-session', '-t', session])).ok; }

// Repos discovered under the configured roots, labeled by their path relative to
// the owning root (so the label stays short and readable, e.g. `app/server`).
export function listTargets(cfg) {
  const roots = cfg.projectRoots || [];
  const rel = (p) => {
    const root = roots.filter((r) => p.startsWith(r)).sort((a, b) => b.length - a.length)[0];
    return root ? p.slice(root.length).replace(/^\//, '') || path.basename(p) : p;
  };
  return listRepos(cfg).map((r) => ({ dir: r.path, label: rel(r.path), type: 'code' }));
}

async function isGitRepo(d) { return (await sh('git', ['-C', d, 'rev-parse', '--is-inside-work-tree'])).ok; }

// Pre-accept Claude Code's workspace-trust dialog for a dir (each fresh worktree
// would otherwise prompt and block the agent). Atomic write into ~/.claude.json.
function trustDir(dir) {
  const f = path.join(process.env.HOME || '/home/ubuntu', '.claude.json');
  let j;
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { return; }
  j.projects = j.projects || {};
  if (j.projects[dir] && j.projects[dir].hasTrustDialogAccepted === true) return;
  j.projects[dir] = { ...(j.projects[dir] || {}), hasTrustDialogAccepted: true };
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(j, null, 2));
  renameSync(tmp, f);
}

function seedPrompt(task) {
  const base = task.baseBranch || 'dev';
  const planBranch = planBranchFor(task);
  const forkedFrom = planBranch ? `${planBranch} (the plan integration branch)` : base;
  // Plan tickets integrate via the plan branch on accept — they must NOT open a
  // PR into a core branch. Ad-hoc tickets PR into their base as before.
  const finish = !task.branch
    ? `3) When finished: make atomic commits (follow the git workflow); if the repo has a remote, push and open a PR (\`gh pr create --base ${base}\`). Then run:  agent-report done "<summary + PR url>".`
    : planBranch
      ? `3) When finished: commit your work on THIS branch (${task.branch}) — do NOT create a new branch and do NOT open a PR. Make atomic commits, then push this branch (\`git push -u origin ${task.branch}\`). Your work is integrated into ${planBranch} when the operator accepts — never push or PR to ${base}/qa/main. Then run:  agent-report done "<summary>".`
      : `3) When finished: commit your work on THIS branch (${task.branch}) — do NOT create a new branch. Make atomic commits (follow the git workflow); if the repo has a remote, push this branch and open a PR (\`gh pr create --base ${base}\`). Then run:  agent-report done "<summary + PR url>".`;
  return [
    `You are an autonomous agent working on ONE task in: ${task.cwd}`,
    `Follow this project's CLAUDE.md standards exactly.${task.branch ? ` You are on branch ${task.branch} (forked from ${forkedFrom}).` : ''}`,
    rolePrompt(task.role),
    ``,
    `TASK: ${task.goal}`,
    task.criteria ? `DONE WHEN: ${task.criteria}` : '',
    task.steps ? `\nSTEPS:\n${task.steps}` : '',
    task.context ? `\nCONTEXT:\n${task.context}` : '',
    ``,
    `Report status with the \`agent-report\` command so your operator can manage you:`,
    `1) FIRST produce a short numbered PLAN, then run:  agent-report plan "<the plan>"  and STOP — do NOT write code until I reply "Approved".`,
    `2) If blocked or you need a decision, run:  agent-report ask "<question>"  and STOP, wait for my answer.`,
    finish,
    `Work autonomously between these checkpoints.`
  ].filter((x) => x !== undefined).join('\n');
}

// Spawn the agent's tmux session. Mutates task with cwd/worktree/branch/session.
async function spawnAgent(cfg, task, { command } = {}) {
  let cwd = task.dir;
  task.worktree = null;
  task.branch = null;
  if (await isGitRepo(task.dir)) {
    // Pin the fork base: an explicit per-ticket baseBranch, else the repo's
    // default. NEVER inherit whatever branch the live checkout is parked on.
    const base = task.baseBranch || (await defaultBranch(task.dir));
    task.baseBranch = base;
    task.branch = `agent/${task.id}`;
    task.worktree = path.join(worktreeBase(cfg), `${path.basename(task.dir)}-${task.id}`);
    // Fork base: tickets in an plan fork off the shared plan branch (so they see
    // prior accepted work); ad-hoc tickets fork off the freshest origin/<base>.
    const planBranch = planBranchFor(task);
    let start;
    if (planBranch) {
      task.planBranch = planBranch;
      start = await ensurePlanBase(cfg, task.dir, planBranch, base);
    } else {
      await sh('git', ['-C', task.dir, 'fetch', 'origin', base]);
      const remoteRef = `origin/${base}`;
      const hasRemote = (await sh('git', ['-C', task.dir, 'rev-parse', '--verify', '--quiet', remoteRef])).ok;
      start = hasRemote ? remoteRef : base;
    }
    const r = await sh('git', ['-C', task.dir, 'worktree', 'add', '-b', task.branch, task.worktree, start]);
    if (!r.ok) return { ok: false, error: r.err || `git worktree add failed (base ${start})` };
    cwd = task.worktree;
  }
  task.cwd = cwd;
  trustDir(cwd);
  const claude = cfg.claudeBin || 'claude';
  const model = task.model ? ` --model ${task.model}` : '';
  const permFile = path.join(cfg.agentPermDir, `${task.permission || 'guarded'}.json`);
  const seed = seedPrompt(task).replace(/'/g, `'\\''`);
  const session = sessionFor(cfg, task);
  // Pin the ticket's durable Claude session id so enhance/resume/chat all share context.
  const sid = task.claudeSessionId ? ` --session-id ${task.claudeSessionId}` : '';
  const mcp = ticketsMcpArg(cfg, task);
  const runCmd = command ||
    `cd '${cwd}' && PATH='${cfg.binDir}':"$PATH" AGENT_TASK_ID='${task.id}' WORKSPACE_PORT='${cfg.port}' WORKSPACE_API_TOKEN='${cfg.internalToken}' ${claude}${model}${sid}${mcp} --permission-mode default --settings '${permFile}' '${seed}'`;
  const r = await sh('tmux', ['new-session', '-d', '-s', session, 'bash', '-lc', runCmd]);
  if (!r.ok) return { ok: false, error: r.err || 'tmux spawn failed' };
  return { ok: true };
}

export async function stopAgent(cfg, id) {
  const t = await getTask(cfg, id);
  return t ? (await sh('tmux', ['kill-session', '-t', sessionFor(cfg, t)])).ok : false;
}

export async function loadTasks(cfg) {
  const rows = await q(cfg, 'SELECT data FROM agent_tasks ORDER BY created_at DESC');
  return rows.map((r) => r.data);
}

// Create a ticket. Default lands in 'todo' (no agent); pass start:true to dispatch
// immediately (the classic "launch an agent now").
export async function createTask(cfg, input) {
  if (!input.dir) return { error: 'dir required' };
  // Validate the target against known repos/folders so a mistyped repo path from
  // the planner fails loudly instead of forking an agent in a random directory.
  const targets = listTargets(cfg);
  if (!targets.some((t) => t.dir === input.dir)) return { error: `unknown target repo: ${input.dir}` };
  const model = input.model || (cfg.roleModels && cfg.roleModels[input.role || '']) || '';
  const permission = (cfg.agentPermissions || []).includes(input.permission) ? input.permission : (cfg.defaultAgentPermission || 'guarded');
  const ns = input.project || await projectIdForDir(cfg, input.dir);
  const task = {
    id: genId(),
    title: input.title || (input.goal || '').slice(0, 60) || 'task',
    dir: input.dir,
    baseBranch: input.baseBranch || '', // pinned fork/PR base; resolved at spawn if empty
    ns,
    goal: input.goal || '',
    role: input.role || '',
    model,
    permission,
    criteria: input.criteria || '',
    steps: input.steps || '',
    context: input.context || '',
    plan: input.plan || '',
    planBranch: input.planBranch || '', // shared integration branch; stable per batch
    claudeSessionId: input.claudeSessionId || randomUUID(), // one durable Claude session per ticket (resume/enhance/chat)
    // Hands-off: autonomous tickets auto-approve their plan and auto-accept on a
    // PASS auto-review (so it implies autoReview), and auto-start when unblocked.
    autonomous: !!input.autonomous,
    autoReview: !!input.autoReview || !!input.autonomous,
    autoStart: !!input.autoStart || !!input.autonomous,
    blockedBy: Array.isArray(input.blockedBy) ? input.blockedBy : [],
    links: Array.isArray(input.links) ? input.links : [],
    state: 'todo',
    needsYou: false,
    rank: -Date.now(), // manual board order within a column (newest-first default)
    createdAt: Date.now()
  };
  await q(cfg, 'INSERT INTO agent_tasks (id, data) VALUES ($1, $2::jsonb)', [task.id, JSON.stringify(task)]);
  if (input.start) return (await startTask(cfg, task.id)) || task;
  return task;
}

// Dispatch a 'todo' ticket: spawn its agent and move it to 'planning'.
export async function startTask(cfg, id) {
  const task = await getTask(cfg, id);
  if (!task) return { error: 'not found' };
  if (task.state !== 'todo' && task.state !== 'error') return task;
  // Dependency gate: don't dispatch until every blocker ticket is done.
  if (Array.isArray(task.blockedBy) && task.blockedBy.length) {
    const rows = await q(cfg, 'SELECT data FROM agent_tasks WHERE id = ANY($1)', [task.blockedBy]);
    const open = rows.map((r) => r.data).filter((b) => b.state !== 'done');
    if (open.length) return { error: `blocked by ${open.length} unfinished ticket(s)`, blocked: true };
  }
  const sp = await spawnAgent(cfg, task);
  task.state = sp.ok ? 'planning' : 'error';
  if (!sp.ok) task.error = sp.error; else delete task.error;
  task.startedAt = Date.now();
  task.updatedAt = Date.now();
  await q(cfg, 'UPDATE agent_tasks SET data = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(task), id]);
  return task;
}

export async function listAgents(cfg) {
  const tasks = await loadTasks(cfg);
  const doneSet = new Set(tasks.filter((t) => t.state === 'done').map((t) => t.id));
  for (const t of tasks) {
    t.depBlocked = Array.isArray(t.blockedBy) && t.blockedBy.some((bid) => !doneSet.has(bid));
    if (t.state === 'todo') { t.status = 'todo'; continue; }
    if (t.state === 'error') { t.status = 'error'; continue; }
    const ok = await alive(sessionFor(cfg, t));
    t.status = !ok && t.state !== 'done' ? 'ended' : t.state;
  }
  return tasks;
}

// Reorder: assign rank by position for an ordered list of ticket ids (a column's
// new order after a drag). Ranks are small integers so they sort before the
// creation-time defaults of untouched tickets.
export async function reorderTickets(cfg, ids) {
  if (!Array.isArray(ids)) return false;
  for (let i = 0; i < ids.length; i++) await setState(cfg, ids[i], { rank: i });
  return true;
}

// Patch a ticket's dependency links and/or its auto-start flag.
export function setLinks(cfg, id, patch) {
  const p = {};
  if (Array.isArray(patch.blockedBy)) p.blockedBy = patch.blockedBy;
  if (Array.isArray(patch.links)) p.links = patch.links;
  if (typeof patch.autoStart === 'boolean') p.autoStart = patch.autoStart;
  if (typeof patch.autoReview === 'boolean') p.autoReview = patch.autoReview;
  if (typeof patch.autonomous === 'boolean') {
    p.autonomous = patch.autonomous;
    if (patch.autonomous) { p.autoReview = true; p.autoStart = true; } // implied
  }
  return setState(cfg, id, p);
}

// When a ticket is accepted (done), auto-dispatch any to-do dependents that opted
// into auto-start and whose blockers are now ALL done — so a linked chain flows
// on its own. Best-effort; chains as each link is accepted.
async function advanceDependents(cfg, completedId) {
  const all = await loadTasks(cfg);
  const doneSet = new Set(all.filter((t) => t.state === 'done').map((t) => t.id));
  for (const t of all) {
    if (t.state !== 'todo' || !t.autoStart || t.paused) continue; // a paused plan holds before the next ticket
    if (!Array.isArray(t.blockedBy) || !t.blockedBy.includes(completedId)) continue;
    if (t.blockedBy.every((bid) => doneSet.has(bid))) await startTask(cfg, t.id);
  }
}

// --- Plan-level controls -----------------------------------------------------
// Tickets are grouped into an plan by their integration branch (planBranchFor).
async function planGroup(cfg, task) {
  const key = planBranchFor(task);
  if (!key) return { key: null, tickets: [] };
  const tickets = (await loadTasks(cfg)).filter((t) => planBranchFor(t) === key);
  return { key, tickets };
}

// Start every ready, not-paused, to-do ticket in an plan (blockers all done).
async function dispatchReadyInPlan(cfg, key) {
  const all = await loadTasks(cfg);
  const doneSet = new Set(all.filter((t) => t.state === 'done').map((t) => t.id));
  let started = 0;
  for (const t of all) {
    if (planBranchFor(t) !== key || t.state !== 'todo' || t.paused) continue;
    if ((t.blockedBy || []).every((bid) => doneSet.has(bid))) { await startTask(cfg, t.id); started += 1; }
  }
  return started;
}

// Pause: hold before the NEXT ticket. Running agents are untouched — the current
// ticket finishes (and, if autonomous, auto-accepts + lands); only auto-dispatch
// of further tickets is suppressed until resume. Harms nothing.
export async function pausePlan(cfg, id) {
  const task = await getTask(cfg, id);
  if (!task) return { error: 'not found' };
  const { key, tickets } = await planGroup(cfg, task);
  if (!key) return { error: 'ticket is not part of an plan' };
  for (const t of tickets) await setState(cfg, t.id, { paused: true });
  return { ok: true, paused: true, count: tickets.length };
}

export async function resumePlan(cfg, id) {
  const task = await getTask(cfg, id);
  if (!task) return { error: 'not found' };
  const { key, tickets } = await planGroup(cfg, task);
  if (!key) return { error: 'ticket is not part of an plan' };
  for (const t of tickets) await setState(cfg, t.id, { paused: false });
  const started = await dispatchReadyInPlan(cfg, key);
  return { ok: true, paused: false, started };
}

// Run: make the whole plan autonomous (auto-approve plans, auto-accept on PASS,
// auto-advance), clear any pause, and start every ready ticket in one click.
export async function runPlan(cfg, id) {
  const task = await getTask(cfg, id);
  if (!task) return { error: 'not found' };
  const { key, tickets } = await planGroup(cfg, task);
  if (!key) return { error: 'ticket is not part of an plan' };
  for (const t of tickets) await setState(cfg, t.id, { paused: false, autonomous: true, autoReview: true, autoStart: true });
  const started = await dispatchReadyInPlan(cfg, key);
  return { ok: true, started };
}

// Claude-assisted backlog help (headless, read-only).
export async function adviseTickets(cfg, project) {
  const all = await loadTasks(cfg);
  const tickets = (project ? all.filter((t) => (t.ns || 'default') === project) : all)
    .filter((t) => !['done', 'ended'].includes(t.state));
  const dir = tickets[0] && tickets[0].dir;
  return adviseBacklog(cfg, tickets, dir, sh);
}
export async function enhanceTicketDraft(cfg, input) {
  if (!input || !input.dir) return { error: 'dir required' };
  return enhanceTicket(cfg, input, sh);
}
// Plan an outcome into proposed tickets (not yet created).
export async function planForProject(cfg, { goal, project, dir }) {
  if (!goal) return { error: 'goal required' };
  let d = dir || (project ? await projectDir(cfg, project) : '') || cfg.termCwd;
  const repos = listRepos(cfg).map((r) => r.path).filter((p) => p.startsWith(d));
  return planTickets(cfg, { goal, dir: d, repos }, sh);
}
// Create a batch of tickets (from the planner), wiring dependsOn indexes into
// blockedBy ids. All land as 'todo' (no agents spawned).
export async function createMany(cfg, tickets) {
  if (!Array.isArray(tickets)) return { error: 'tickets array required' };
  const ids = [];
  const created = [];
  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i] || {};
    const blockedBy = (Array.isArray(t.dependsOn) ? t.dependsOn : []).map((idx) => ids[idx]).filter(Boolean);
    const task = await createTask(cfg, {
      dir: t.repo || t.dir, baseBranch: t.baseBranch, title: t.title, goal: t.goal, criteria: t.criteria,
      steps: t.steps, context: t.context,
      role: t.role, plan: t.plan, planBranch: t.planBranch, blockedBy, autonomous: !!t.autonomous,
      autoStart: t.autoStart ?? blockedBy.length > 0, // dependents auto-flow once their blockers finish
      start: false
    });
    ids[i] = task && task.id;
    created.push(task);
  }
  return { created };
}

export async function listEvents(cfg, id) {
  return q(cfg, 'SELECT event, message, at FROM agent_events WHERE task_id = $1 ORDER BY at DESC LIMIT 200', [id]);
}

// Events from the agent (`agent-report`) + Claude Code hooks, in one row-locked
// transaction (state + event log stay atomic). Auto-reviews on 'done' if enabled.
export async function recordEvent(cfg, id, event, message) {
  const task = await withTx(cfg, async (client) => {
    const r = await client.query('SELECT data FROM agent_tasks WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rows[0]) return null;
    const t = r.rows[0].data;
    // A finished ticket (accepted/ended) must not be revived by its now-idle agent's
    // late chatter — e.g. Claude Code's "waiting for your input" notification, which
    // would otherwise flip a done ticket back to needsYou and make it look stuck.
    const terminal = t.state === 'done' || t.state === 'ended';
    if (event === 'active') { t.needsYou = false; }
    else if (terminal) { if (message) t.lastEvent = message; } // log only; never un-finish it
    else if (event === 'plan') { t.state = 'plan-review'; t.plan = message; t.needsYou = true; }
    else if (event === 'ask') { t.state = 'blocked'; t.question = message; t.needsYou = true; }
    else if (event === 'done') { t.state = 'review'; t.summary = message; t.needsYou = true; }
    else if (event === 'reviewed') { t.review = message; t.reviewedAt = Date.now(); }
    else if (event === 'progress') { t.lastEvent = message; }
    else if (event === 'notification') { t.needsYou = true; t.lastEvent = message || 'needs input'; }
    t.updatedAt = Date.now();
    await client.query('UPDATE agent_tasks SET data = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(t), id]);
    await client.query('INSERT INTO agent_events (task_id, event, message) VALUES ($1, $2, $3)', [id, event, message || '']);
    return t;
  });
  // Hands-off automation (fire-and-forget so the event response stays fast).
  if (task && event === 'plan' && task.autonomous) {
    approveAgent(cfg, id).catch(() => {}); // auto-approve the plan
  } else if (task && event === 'done' && task.autoReview && task.worktree) {
    runReview(cfg, task, sh, setState).then((verdict) => {
      // autonomous: auto-accept only on a clean review; ISSUES stops for the operator
      if (task.autonomous && typeof verdict === 'string' && /^PASS/i.test(verdict)) acceptAgent(cfg, id).catch(() => {});
    }).catch(() => {});
  }
  return !!task;
}

function setState(cfg, id, patch) {
  return lockedUpdate(cfg, 'agent_tasks', id, (t) => Object.assign(t, patch));
}

// Operator actions (board -> agent).
export async function approveAgent(cfg, id) {
  const t = await getTask(cfg, id);
  if (t) await sendLine(cfg, sessionFor(cfg, t), 'Approved — proceed with the plan.');
  return setState(cfg, id, { state: 'executing', needsYou: false });
}
export async function replyAgent(cfg, id, text) {
  const t = await getTask(cfg, id);
  if (t) await sendLine(cfg, sessionFor(cfg, t), text || 'Please continue.');
  return setState(cfg, id, { state: 'executing', needsYou: false });
}
export async function acceptAgent(cfg, id) {
  const task = await getTask(cfg, id);
  // Plan tickets land into their integration branch (never a core branch) before
  // they count as done, so dependents fork off a base that contains this work.
  if (task && task.branch && task.worktree && planBranchFor(task)) {
    const land = await landToPlan(cfg, task);
    if (!land.ok && land.conflict) {
      const outcome = await resolveLandConflict(cfg, task, land);
      if (!outcome.landed) {
        // Risk too high to auto-merge: keep the ticket in review, surface the
        // fixer's risk profile + proposal, and do NOT advance dependents.
        await setState(cfg, id, { state: 'review', needsYou: true, landConflict: outcome });
        return { blocked: true, landConflict: outcome };
      }
    } else if (!land.ok) {
      await setState(cfg, id, { state: 'review', needsYou: true, landError: land.err });
      return { error: land.err };
    }
  }
  const r = await setState(cfg, id, { state: 'done', needsYou: false, landed: true, landConflict: null });
  // Proactive teardown: an accepted ticket is terminal — its work agent has
  // committed/landed and will never be sent more input (discuss uses the separate
  // chat-<id> session, resumed from the durable claudeSessionId). Kill both its
  // tmux sessions now so the claude process + tickets MCP are freed immediately,
  // rather than lingering until the idle reaper sweeps them. Fire-and-forget.
  if (task) {
    sh('tmux', ['kill-session', '-t', sessionFor(cfg, task)]).catch(() => {});
    sh('tmux', ['kill-session', '-t', sessionName(cfg, task.ns || 'default', `chat-${id}`)]).catch(() => {});
  }
  advanceDependents(cfg, id).catch(() => {}); // fire-and-forget: dispatch ready dependents
  return r;
}

// A merge conflict landing an plan ticket. A headless fixer agent resolves it in
// the in-progress merge worktree and self-rates the risk. Low risk auto-commits +
// pushes (operator not involved); medium/high aborts and returns the risk profile
// + proposal for the operator. Read+write perms scoped to the merge worktree.
async function resolveLandConflict(cfg, task, land) {
  const permFile = path.join(cfg.agentPermDir, 'full.json');
  const prompt = [
    `You are resolving a git merge conflict while integrating ticket "${task.title || task.id}" into the plan branch ${land.planBranch}.`,
    `TASK the ticket implemented: ${task.goal}`,
    `Conflicted files: ${(land.files || []).join(', ') || '(see git status)'}.`,
    `Resolve every conflict so BOTH sides' intent is preserved; run any quick project checks (e.g. node --check) on files you touch. Do NOT run git commit, git merge, or git push.`,
    `Then assess the RISK that your resolution is wrong: "low" = mechanical / non-overlapping edits you are confident in; "medium"/"high" = overlapping semantics you are unsure about.`,
    `Output ONLY one JSON object, no prose: {"risk":"low|medium|high","summary":"<what conflicted and how you resolved it>","proposal":"<what you changed / what the operator should check>"}`
  ].join('\n').replace(/'/g, `'\\''`);
  const cmd = `cd '${land.wt}' && ${cfg.claudeBin || 'claude'} -p --model opus --settings '${permFile}' '${prompt}'`;
  let risk = 'high', summary = 'fixer did not return a verdict', proposal = '';
  try {
    const r = await sh('bash', ['-lc', cmd], { timeout: 300000 });
    const j = parseJson(r.out || '');
    if (j) { risk = /^(low|medium|high)$/i.test(j.risk) ? j.risk.toLowerCase() : 'high'; summary = String(j.summary || summary).slice(0, 400); proposal = String(j.proposal || '').slice(0, 600); }
  } catch (e) { summary = `fixer failed to run (${e})`; }
  if (risk === 'low') {
    const fin = await finishConflictedLand(cfg, task.dir, land.wt, land.planBranch, { commit: true });
    if (fin.ok) return { landed: true, autoResolved: true, risk, summary, proposal, files: land.files };
    summary = `${summary} — auto-commit failed: ${fin.err || ''}`;
  }
  await finishConflictedLand(cfg, task.dir, land.wt, land.planBranch, { commit: false }); // abort; operator resolves
  return { landed: false, risk, summary, proposal, files: land.files, planBranch: land.planBranch };
}

function parseJson(out) {
  const t = out.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch {}
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  return null;
}

// Open the single plan -> core PR once every ticket in the plan is done.
export async function openPlanPRForTask(cfg, id) {
  const task = await getTask(cfg, id);
  if (!task) return { error: 'not found' };
  const planBranch = planBranchFor(task);
  if (!planBranch) return { error: 'ticket is not part of an plan' };
  const all = await loadTasks(cfg);
  const siblings = all.filter((t) => planBranchFor(t) === planBranch && t.dir === task.dir);
  const open = siblings.filter((t) => t.state !== 'done');
  if (open.length) return { error: `${open.length} plan ticket(s) in this repo not done yet` };
  return openPlanPR(cfg, task.dir, planBranch, task.baseBranch || 'dev', `${task.plan || planBranch}`,
    `Plan integration: ${task.plan || planBranch}\n\nTickets:\n${siblings.map((t) => `- ${t.title}`).join('\n')}`);
}

// Edit a ticket's editable fields (used by the operator and by a ticket's own
// Claude session via the tickets MCP `update_ticket`, to ripple changes to siblings).
export async function updateTask(cfg, id, patch) {
  /** @type {Record<string,string>} */
  const allowed = {};
  for (const k of ['title', 'goal', 'criteria', 'steps', 'context', 'role']) if (typeof patch?.[k] === 'string') allowed[k] = patch[k];
  if (!Object.keys(allowed).length) return { error: 'nothing to update' };
  return (await setState(cfg, id, allowed)) || { error: 'not found' };
}

// Rename an plan (display name) across all its tickets. The integration branch
// (planBranch) is intentionally left untouched — it's the git branch already in
// use; only the human-facing plan label changes.
export async function renamePlan(cfg, from, to) {
  const a = String(from || '').trim(); const b = String(to || '').trim();
  if (!a || !b) return { error: 'from and to are required' };
  if (a === b) return { ok: true, renamed: 0 };
  const rows = await q(cfg, `SELECT id FROM agent_tasks WHERE data->>'plan' = $1`, [a]);
  let renamed = 0;
  for (const r of rows) if (await setState(cfg, r.id, { plan: b })) renamed++;
  return { ok: true, renamed };
}

// Archive (or unarchive) an plan — sets planArchived on every ticket in the plan.
// Archived plans are hidden from the board by default but remain queryable.
export async function archivePlan(cfg, planName, archived = true) {
  const name = String(planName || '').trim();
  if (!name) return { error: 'planName is required' };
  const rows = await q(cfg, `SELECT id FROM agent_tasks WHERE data->>'plan' = $1`, [name]);
  let updated = 0;
  for (const r of rows) if (await setState(cfg, r.id, { planArchived: archived })) updated++;
  return { ok: true, updated };
}

// Recreate a ticket's worktree (e.g. for resume after it was removed): reuse the
// agent/<id> branch if it still exists, else fork off the plan branch / base.
async function recreateWorktree(cfg, task) {
  const base = task.baseBranch || (await defaultBranch(task.dir));
  const branch = task.branch || `agent/${task.id}`;
  const wt = path.join(worktreeBase(cfg), `${path.basename(task.dir)}-${task.id}`);
  const hasBranch = (await sh('git', ['-C', task.dir, 'rev-parse', '--verify', '--quiet', branch])).ok;
  let r;
  if (hasBranch) r = await sh('git', ['-C', task.dir, 'worktree', 'add', wt, branch]);
  else {
    const planBranch = planBranchFor(task);
    const start = planBranch ? await ensurePlanBase(cfg, task.dir, planBranch, base) : base;
    r = await sh('git', ['-C', task.dir, 'worktree', 'add', '-b', branch, wt, start]);
  }
  if (!r.ok) return { error: r.err || 'failed to recreate worktree' };
  await setState(cfg, task.id, { worktree: wt, branch });
  task.worktree = wt; task.branch = branch;
  return { ok: true };
}

// A focused preamble injected when (re)opening a ticket's Claude session: keep it
// on THIS ticket, give it the plan background, and gate sibling edits on permission.
async function ticketPreamble(cfg, task) {
  const all = await loadTasks(cfg);
  const siblings = task.plan ? all.filter((t) => t.plan === task.plan && t.id !== task.id) : [];
  const lines = siblings.map((t) => `  - [${t.state}] ${t.title} (${path.basename(t.dir)}) {id:${t.id}}`).join('\n');
  return [
    `You are resuming work on ONE ticket. Stay focused on THIS ticket only.`,
    `TICKET ${task.id}: ${task.title}`,
    task.goal ? `GOAL: ${task.goal}` : '',
    task.criteria ? `DONE WHEN: ${task.criteria}` : '',
    task.plan ? `\nPart of plan "${task.plan}". Sibling tickets:\n${lines || '  (none)'}` : '',
    `\nIf your work here implies changes to other tickets, ASK me first. With my explicit approval you MAY update a sibling via the tickets MCP (update_ticket / list_tickets / get_ticket). Never edit a sibling ticket without asking.`,
    `Summarize where this ticket stands and what you'd do next, then wait for my instructions.`
  ].filter(Boolean).join('\n');
}

// Open (or reattach) a full Claude chat on a ticket's durable session, in its
// worktree, with the tickets MCP + an plan-context preamble. Returns the terminal
// sessionKey for the UI to attach a tab to.
export async function openTicketChat(cfg, id, instruction = '') {
  const task = await getTask(cfg, id);
  if (!task) return { error: 'not found' };
  if (!task.branch || !task.claudeSessionId) return { error: 'Start this ticket first — its Claude session is created when the agent runs.' };
  if (!task.worktree || !existsSync(task.worktree)) {
    const re = await recreateWorktree(cfg, task);
    if (re.error) return re;
  }
  const sessionKey = `chat-${task.id}`;
  const session = sessionName(cfg, task.ns || 'default', sessionKey);
  if (!(await alive(session))) {
    const claude = cfg.claudeBin || 'claude';
    const permFile = path.join(cfg.agentPermDir, `${task.permission || 'guarded'}.json`);
    const mcp = ticketsMcpArg(cfg, task);
    // An optional opening instruction (e.g. discuss the review findings) is baked
    // into the boot prompt so Claude starts the conversation on-topic.
    const base = await ticketPreamble(cfg, task);
    const preamble = `${base}${instruction ? `\n\n${instruction}` : ''}`.replace(/'/g, `'\\''`);
    const cmd = `cd '${task.worktree}' && PATH='${cfg.binDir}':"$PATH" AGENT_TASK_ID='${task.id}' WORKSPACE_PORT='${cfg.port}' WORKSPACE_API_TOKEN='${cfg.internalToken}' ${claude} --resume ${task.claudeSessionId}${mcp} --settings '${permFile}' '${preamble}'`;
    const r = await sh('tmux', ['new-session', '-d', '-s', session, 'bash', '-lc', cmd]);
    if (!r.ok) return { error: r.err || 'failed to open chat' };
  } else if (instruction) {
    // Chat already open — send the instruction into it (single line so a stray
    // newline can't submit it early).
    await sendLine(cfg, session, instruction.replace(/\s*\n\s*/g, ' '));
  }
  return { ok: true, sessionKey, ns: task.ns || 'default', title: task.title };
}

// Open the ticket chat seeded to talk through the auto-reviewer's findings: explain
// each, offer concrete resolution options to pick from (incl. "discuss further"),
// and wait — so the operator can resolve issues they don't know the answer to.
export async function discussTicket(cfg, id) {
  const task = await getTask(cfg, id);
  if (!task) return { error: 'not found' };
  const review = String(task.review || 'the review findings on this ticket');
  const instruction = [
    `The automated code reviewer flagged the following on the work you committed for this ticket:`,
    `"${review}"`,
    ``,
    `Help me decide how to resolve this — I may not know the right answer myself. For EACH issue raised:`,
    `1. explain it in plain terms and why it matters here (cite the file/function),`,
    `2. give 2-3 concrete resolution options with their tradeoffs,`,
    `3. say which you'd recommend and why.`,
    `Then present ONE numbered menu of actions I can choose from (make the last option "discuss further"). Do NOT change any code yet — wait for me to choose.`,
    `When I pick a fix: apply it and make atomic commits on THIS ticket's branch (do NOT open a PR or push to a base branch). THEN — only after it's committed and you believe the issue is resolved — run exactly:  agent-report done "<one-line summary of the fix>"`,
    `That hands the ticket back to the pipeline: it gets re-reviewed and, in autonomous mode, auto-accepted on a clean review, which unblocks the next ticket — so the plan continues on its own. Run agent-report done ONCE, only after committing the approved fix. If a fix would touch a sibling ticket, ask me first.`
  ].join('\n');
  return openTicketChat(cfg, id, instruction);
}

// Open ONE chat about a whole plan — for reviewing/testing the completed work. It
// knows every ticket (goal/result/review) and reads the ACTUAL integrated changes
// on each repo's plan branch, then summarizes and walks the operator through testing.
// A fresh session (not a single ticket's --resume) since it spans tickets/repos.
export async function openPlanChat(cfg, id) {
  const task = await getTask(cfg, id);
  if (!task) return { error: 'not found' };
  if (!task.plan) return { error: 'ticket is not part of an plan' };
  const ns = task.ns || 'default';
  const dir = await projectDir(cfg, ns);
  const tickets = (await loadTasks(cfg)).filter((t) => t.plan === task.plan).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  // Sanitize to [\w-] (same rule as sessionName) so it has NO '/' — the terminal
  // websocket route is /ws/term/<key> with key matching [\w-]+, and the plan branch
  // name contains a slash that would otherwise break the URL and hang on "connecting".
  const sessionKey = `plan-chat-${planBranchFor(task) || task.plan}`.replace(/[^\w-]/g, '_');
  const session = sessionName(cfg, ns, sessionKey);
  if (!(await alive(session))) {
    // One line per repo: how to see that repo's integrated plan-branch changes.
    /** @type {Map<string,{eb:string,base:string}>} */
    const byRepo = new Map();
    for (const t of tickets) { const eb = planBranchFor(t); if (t.dir && eb && !byRepo.has(t.dir)) byRepo.set(t.dir, { eb, base: t.baseBranch || 'dev' }); }
    const repoLines = [...byRepo.entries()].map(([repo, v]) =>
      `- ${repo}: plan branch ${v.eb} off origin/${v.base}.  See it:  git -C ${repo} fetch -q origin ${v.eb} ${v.base} ; git -C ${repo} log --oneline origin/${v.base}..origin/${v.eb} ; git -C ${repo} diff origin/${v.base}...origin/${v.eb}`).join('\n');
    const ticketLines = tickets.map((t, i) =>
      `#${i + 1} [${t.state}] ${t.title} (${path.basename(t.dir || '')})\n   goal: ${(t.goal || '—').slice(0, 300)}\n   done-when: ${(t.criteria || '—').slice(0, 200)}\n   result: ${(t.summary || '—').slice(0, 300)}\n   review: ${(t.review || '—').slice(0, 200)}`).join('\n');
    const seed = [
      `You are helping me REVIEW and TEST a completed plan before I merge it. Read freely and run read-only git/inspection commands; ask before changing any code.`,
      `PLAN: ${task.plan}`,
      ``,
      `Tickets in this plan (each built by a separate agent, then integrated):`,
      ticketLines,
      ``,
      `The integrated work lives on these plan branches (one per repo):`,
      repoLines || '(none found)',
      ``,
      `FIRST: read the ACTUAL changes on those plan branches with the git commands above (don't guess). THEN give me (1) a concise summary of what was built across the whole plan and how the pieces fit together, and (2) a concrete step-by-step way to test it end-to-end (exact commands / endpoints / what to click). After that, answer my questions as I test.`
    ].filter(Boolean).join('\n').replace(/'/g, `'\\''`);
    trustDir(dir);
    const claude = cfg.claudeBin || 'claude';
    const permFile = path.join(cfg.agentPermDir, `${task.permission || 'guarded'}.json`);
    // Empty MCP config so this chat doesn't inherit the operator's global ~/.claude.json
    // MCP fleet (playwright/k8s/mysql/github) — a review/test chat needs none of it.
    const cmd = `cd '${dir}' && PATH='${cfg.binDir}':"$PATH" ${claude} --model opus --mcp-config '{"mcpServers":{}}' --settings '${permFile}' '${seed}'`;
    const r = await sh('tmux', ['new-session', '-d', '-s', session, 'bash', '-lc', cmd]);
    if (!r.ok) return { error: r.err || 'failed to open plan chat' };
  }
  return { ok: true, sessionKey, ns, title: `Plan: ${task.plan}` };
}

// --- apply an plan's branches into the LIVE working trees, so the operator can run
// and test the integrated work locally before merging the plan PR; and restore the
// repos to their base branch afterward. State (per-repo previous branch + whether we
// stashed) is recorded on disk so Restore is faithful. ------------------------------
function planLocalStateFile(cfg) { return path.join(cfg.dataDir, 'plan-local.json'); }
function readPlanLocalState(cfg) { try { return JSON.parse(readFileSync(planLocalStateFile(cfg), 'utf8')); } catch { return {}; } }
function writePlanLocalState(cfg, s) { try { mkdirSync(cfg.dataDir, { recursive: true }); writeFileSync(planLocalStateFile(cfg), JSON.stringify(s, null, 2)); } catch {} }

// Build a map of pm2 process cwd → [process names] so we can find which processes
// to restart when a repo changes branch.
async function pm2CwdMap() {
  const r = await sh('pm2', ['jlist']);
  if (!r.ok || !r.out.trim()) return {};
  try {
    const procs = JSON.parse(r.out);
    /** @type {Record<string,string[]>} */
    const map = {};
    for (const p of procs) {
      const cwd = p.pm2_env?.pm_cwd || p.pm2_env?.cwd || '';
      if (!cwd) continue;
      (map[cwd] ||= []).push(p.name);
    }
    return map;
  } catch { return {}; }
}

// Find pm2 process names whose cwd is inside the given repo directory.
function pm2ForRepo(map, repoDir) {
  const names = new Set();
  for (const [cwd, procs] of Object.entries(map)) {
    if (cwd === repoDir || cwd.startsWith(repoDir + '/')) for (const n of procs) names.add(n);
  }
  return [...names];
}

// The distinct repos an plan touches, each with its plan branch + base.
async function planRepos(cfg, task) {
  const tickets = (await loadTasks(cfg)).filter((t) => t.plan === task.plan);
  /** @type {Map<string,{eb:string,base:string}>} */
  const repos = new Map();
  for (const t of tickets) { const eb = planBranchFor(t); if (t.dir && eb && !repos.has(t.dir)) repos.set(t.dir, { eb, base: t.baseBranch || 'dev' }); }
  return repos;
}

export async function applyPlanLocal(cfg, id) {
  const task = await getTask(cfg, id);
  if (!task) return { error: 'not found' };
  if (!task.plan) return { error: 'ticket is not part of an plan' };
  const planBranch = planBranchFor(task);
  const repos = await planRepos(cfg, task);
  const state = readPlanLocalState(cfg);
  const applied = [];
  const results = [];
  const pm2map = await pm2CwdMap();

  for (const [repo, v] of repos) {
    const name = path.basename(repo);
    const cur = (await sh('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
    await sh('git', ['-C', repo, 'fetch', 'origin', v.eb]);
    if (!(await sh('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `origin/${v.eb}`])).ok) {
      results.push({ repo: name, ok: false, msg: `origin/${v.eb} not found` }); continue;
    }
    // Stash any local edits so checkout can't fail or lose work.
    const dirty = (await sh('git', ['-C', repo, 'status', '--porcelain'])).out.trim().length > 0;
    let stashed = false;
    if (dirty) stashed = (await sh('git', ['-C', repo, 'stash', 'push', '-u', '-m', `plan-local:${planBranch}`])).ok;
    const co = await sh('git', ['-C', repo, 'checkout', '-B', v.eb, `origin/${v.eb}`]);
    if (!co.ok) {
      if (stashed) await sh('git', ['-C', repo, 'stash', 'pop']);
      results.push({ repo: name, ok: false, msg: (co.err || '').slice(0, 160).trim() }); continue;
    }
    applied.push({ dir: repo, prevBranch: cur || v.base, stashed });

    // npm install if package.json or lockfile changed vs previous branch
    const pkgDiff = (await sh('git', ['-C', repo, 'diff', `${cur}..HEAD`, '--name-only', '--', 'package.json', 'package-lock.json'])).out.trim();
    let npmInstalled = false; let npmError = null;
    if (pkgDiff) {
      const ni = await sh('npm', ['install', '--prefer-offline'], { cwd: repo });
      npmInstalled = ni.ok;
      if (!ni.ok) npmError = (ni.err || ni.out || '').slice(0, 200).trim();
    }

    // Restart pm2 processes whose cwd lives inside this repo
    const pm2names = pm2ForRepo(pm2map, repo);
    const pm2results = [];
    for (const pm2name of pm2names) {
      const r = await sh('pm2', ['restart', pm2name]);
      pm2results.push({ name: pm2name, ok: r.ok, msg: r.ok ? '' : (r.err || '').slice(0, 100).trim() });
    }

    results.push({ repo: name, ok: true, branch: v.eb, prevBranch: cur, stashed, pkgChanged: !!pkgDiff, npmInstalled, npmError, pm2: pm2results });
  }
  if (applied.length) { state[planBranch] = { plan: task.plan, repos: applied, appliedAt: Date.now() }; writePlanLocalState(cfg, state); }
  return { ok: applied.length > 0, plan: task.plan, results };
}

export async function revertPlanLocal(cfg, id) {
  const task = await getTask(cfg, id);
  if (!task) return { error: 'not found' };
  if (!task.plan) return { error: 'ticket is not part of an plan' };
  const planBranch = planBranchFor(task);
  const state = readPlanLocalState(cfg);
  const rec = state[planBranch];
  let list = rec && rec.repos;
  if (!list) {
    const repos = await planRepos(cfg, task);
    list = [...repos.entries()].map(([dir, v]) => ({ dir, prevBranch: v.base, stashed: false }));
  }
  const results = [];
  const pm2map = await pm2CwdMap();

  for (const r of list) {
    const name = path.basename(r.dir);
    const cur = (await sh('git', ['-C', r.dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
    const co = await sh('git', ['-C', r.dir, 'checkout', r.prevBranch]);
    if (!co.ok) { results.push({ repo: name, ok: false, msg: (co.err || '').slice(0, 160).trim() }); continue; }
    let stashRestored = false;
    if (r.stashed) stashRestored = (await sh('git', ['-C', r.dir, 'stash', 'pop'])).ok;

    // npm install if package.json changed going back to base
    const pkgDiff = (await sh('git', ['-C', r.dir, 'diff', `${cur}..HEAD`, '--name-only', '--', 'package.json', 'package-lock.json'])).out.trim();
    let npmInstalled = false; let npmError = null;
    if (pkgDiff) {
      const ni = await sh('npm', ['install', '--prefer-offline'], { cwd: r.dir });
      npmInstalled = ni.ok;
      if (!ni.ok) npmError = (ni.err || ni.out || '').slice(0, 200).trim();
    }

    // Restart pm2 processes
    const pm2names = pm2ForRepo(pm2map, r.dir);
    const pm2results = [];
    for (const pm2name of pm2names) {
      const rv = await sh('pm2', ['restart', pm2name]);
      pm2results.push({ name: pm2name, ok: rv.ok, msg: rv.ok ? '' : (rv.err || '').slice(0, 100).trim() });
    }

    results.push({ repo: name, ok: true, branch: r.prevBranch, stashRestored, pkgChanged: !!pkgDiff, npmInstalled, npmError, pm2: pm2results });
  }
  delete state[planBranch]; writePlanLocalState(cfg, state);
  return { ok: true, plan: task.plan, results };
}

// Which plans are currently applied locally (for the UI button state).
export function planLocalApplied(cfg) { return Object.keys(readPlanLocalState(cfg)); }

export async function removeTask(cfg, id) {
  const t = await getTask(cfg, id);
  if (t) await sh('tmux', ['kill-session', '-t', sessionFor(cfg, t)]);
  if (t) await sh('tmux', ['kill-session', '-t', sessionName(cfg, t.ns || 'default', `chat-${id}`)]);
  if (t && t.worktree) await sh('git', ['-C', t.dir, 'worktree', 'remove', '--force', t.worktree]);
  await q(cfg, 'DELETE FROM agent_tasks WHERE id = $1', [id]);
  await q(cfg, 'DELETE FROM agent_events WHERE task_id = $1', [id]);
  return true;
}
