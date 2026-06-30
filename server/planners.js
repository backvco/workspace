// Plan-with-Claude: a live, interactive Claude session (tmux) seeded in planning
// mode and run at the project (container) level so it can read every repo's
// CLAUDE.md + code. You chat with it; when you agree it runs `plan-emit '<json>'`
// to push a proposed ticket breakdown to the board, which you create as a batch
// (tagged with a shared plan). Read-only permission profile — it never edits code.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { sessionName } from './config.js';
import { q } from './db.js';
import { listRepos } from './git.js';
import { projectDir } from './projects.js';
import { createMany } from './agents.js';
import { reviewPlan } from './plan-review.js';
import { fixTickets } from './plan-fixer.js';
import { planSlug } from './plan-branch.js';
import { preflightRepos, preflightSummary } from './preflight.js';

const sh = (cmd, args, opts = {}) =>
  new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 22, ...opts }, (e, o, er) =>
    res({ ok: !e, out: (o || '').toString(), err: (er || '').toString() })));

let seq = 0;
const genId = () => { seq += 1; return `pl${Date.now().toString(36)}${seq.toString(36)}`; };

// --- per-ticket verify tracking ---------------------------------------------
// A content signature over the fields the verifier actually judges. Unchanged
// signature => the ticket's prior verdict still holds, so re-verify can skip it.
function ticketSig(t) {
  const key = JSON.stringify({
    repo: t.repo || t.dir || '', title: t.title || '', goal: t.goal || '',
    criteria: t.criteria || '', steps: t.steps || '', context: t.context || '',
    role: t.role || '',
    dependsOn: (t.dependsOn || []).slice().sort((a, b) => a - b)
  });
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}
const SEV_RANK = { high: 3, medium: 2, low: 1 };
function worstSeverity(findings) {
  let m = 0; for (const f of findings) m = Math.max(m, SEV_RANK[String(f?.severity).toLowerCase()] || 0);
  return ['none', 'low', 'medium', 'high'][m];
}
// Rebuild the flat review (findings re-tagged to current 1-based positions) from
// the per-signature cache, so the panel shows every ticket's standing verdict.
function mergeReview(list, sigs, bySig) {
  const findings = [];
  for (let i = 0; i < list.length; i++) for (const f of (bySig[sigs[i]]?.findings || [])) findings.push({ ...f, ticket: i + 1 });
  for (const f of (bySig._plan?.findings || [])) findings.push({ ...f, ticket: 0 });
  const withIssues = list.filter((_, i) => (bySig[sigs[i]]?.status) === 'issue').length;
  const clean = list.length - withIssues;
  return { severity: worstSeverity(findings), summary: `${clean}/${list.length} tickets verified clean${withIssues ? `, ${withIssues} with issues` : ''}.`, findings };
}
// Drop cache entries for signatures no longer present (keep _plan).
function pruneSigs(sigs, bySig) {
  const keep = new Set(sigs); keep.add('_plan');
  const out = {}; for (const k of Object.keys(bySig)) if (keep.has(k)) out[k] = bySig[k];
  return out;
}
// Attach per-proposed-ticket verify status (for the draft panel badges).
export function enrichPlanner(p) {
  if (!p) return p;
  const bySig = (p.verify && p.verify.bySig) || {};
  const verifyStatus = (p.proposed || []).map((t) => {
    const e = bySig[ticketSig(t)];
    return { status: e ? e.status : 'unverified', findings: e?.findings || [] };
  });
  return { ...p, verifyStatus };
}

// The planner's tmux session lives under its project's ws namespace so the UI's
// embedded terminal (sessionKey 'plan-<id>') attaches to it.
const plannerSession = (cfg, p) => sessionName(cfg, p.ns || 'default', `plan-${p.id}`);

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

export async function createPlanner(cfg, { project, goal, override }) {
  const ns = project || 'default';
  const dir = await projectDir(cfg, ns);
  const id = genId();
  const repos = listRepos(cfg).map((r) => r.path).filter((x) => x.startsWith(dir));
  // Gate the planner on a known-good baseline. A hard block (unknown start point)
  // refuses to start unless explicitly overridden; warnings (local WIP, stale sdk)
  // pass through but are surfaced to the planning Claude in the seed.
  const preflight = await preflightRepos(repos);
  if (preflight.blocked && !override) return { error: 'preflight', preflight };
  const title = (goal || 'planning session').slice(0, 60);
  const p = { id, ns, dir, title, planName: title, proposed: [], preflight, createdAt: Date.now() };
  trustDir(dir);
  const baseline = preflightSummary(preflight);
  const seed = [
    `You are a planning assistant for the project at ${dir}.`,
    repos.length ? `Repos in this project:\n${repos.map((r) => `- ${r}`).join('\n')}` : '',
    baseline,
    goal ? `The operator wants to plan: ${goal}` : `Ask the operator what they want to build.`,
    ``,
    `## YOUR JOB`,
    `Have a focused conversation to fully understand the work, then research the code thoroughly and propose a ticket plan. Every ticket must be complete enough for a junior developer to implement without asking questions. Every fact must come from actual code or docs — never assumed.`,
    ``,
    `## PHASE 1 — UNDERSTAND`,
    goal
      ? `You have the goal. Ask 2-3 targeted questions to clarify anything that would affect the design or scope — interfaces, edge cases, existing patterns to follow. Keep it short.`
      : `Ask the operator what they want to build. Then ask 2-3 targeted questions.`,
    `When you are confident you understand the full scope, say: "I have what I need — ready to research and draft the tickets. Shall I proceed?" Wait for confirmation before continuing.`,
    ``,
    `## PHASE 2 — RESEARCH & DRAFT (after operator confirms)`,
    ``,
    `Research BEFORE writing any ticket. Use sub-agents to keep your context clean:`,
    `  claude -p --max-turns 20 --model sonnet --settings '${permFile}' "Read [files]. Answer ONLY: [specific questions — names, signatures, field casing, shapes]. Bullet points with file:line citations only." 2>&1`,
    `Run independent research tasks in parallel (bash background jobs). Use WebSearch + WebFetch for any external library or API.`,
    ``,
    `You MUST confirm before writing any ticket:`,
    `- CLAUDE.md in each repo that will change`,
    `- The actual files, routes, schemas, and functions you plan to touch (exact names, arg order, field casing)`,
    `- Both sides of every interface between tickets (producer shape must match consumer shape)`,
    `- package.json for every repo (exact package names and versions)`,
    `- Auth/middleware on any route being added or called`,
    `- Current docs for any external library (WebSearch + WebFetch)`,
    ``,
    `CROSS-REPO HANDOFF: if ticket B consumes a package ticket A builds, A must include a publish step and B must pin the new version. A plain dependsOn only orders work.`,
    ``,
    `## TICKET FORMAT`,
    `Fields: title, goal, criteria, steps, context, role, repo (ABSOLUTE path), dependsOn (0-based indexes)`,
    ``,
    `- goal: 2-4 sentences — what to build, exact files/functions involved (file:line), why`,
    `- criteria: verifiable acceptance checks — each testable by a specific command or observable output`,
    `- steps: numbered, file-by-file implementation guide — exact file, exact change, exact location`,
    `- context: background for a junior dev — patterns to follow (file:line), gotchas, design rationale`,
    `- ONE ticket = ONE repo, ONE PR. No two parallel tickets touch the same files.`,
    ``,
    `When done, call propose_tickets (from the tickets MCP) or run plan-emit with the JSON array.`,
    `After proposing, tell the operator: "Tickets are on the board — click Build & Validate in the Plan panel to automatically validate and fix them."`,
    ``,
    `Begin now.`
  ].filter(Boolean).join('\n').replace(/'/g, `'\\''`);
  const permFile = path.join(cfg.agentPermDir, 'planner.json');
  const mcpScript = path.join(cfg.appRoot, 'server', 'mcp', 'tickets-mcp.js');
  const mcpConfig = JSON.stringify({ mcpServers: { tickets: { command: 'node', args: [mcpScript], env: { WORKSPACE_PORT: String(cfg.port), WORKSPACE_API_TOKEN: cfg.internalToken, PLANNER_ID: id } } } });
  const runCmd = `cd '${dir}' && PATH='${cfg.binDir}':"$PATH" PLANNER_ID='${id}' WORKSPACE_PORT='${cfg.port}' WORKSPACE_API_TOKEN='${cfg.internalToken}' ${cfg.claudeBin || 'claude'} --model opus --mcp-config '${mcpConfig}' --settings '${permFile}' '${seed}'`;
  const r = await sh('tmux', ['new-session', '-d', '-s', plannerSession(cfg, p), 'bash', '-lc', runCmd]);
  if (!r.ok) return { error: r.err || 'failed to start planner' };
  await q(cfg, 'INSERT INTO planners (id, data) VALUES ($1, $2::jsonb)', [id, JSON.stringify(p)]);
  return p;
}

export async function getPlanner(cfg, id) {
  const r = await q(cfg, 'SELECT data FROM planners WHERE id = $1', [id]);
  return r[0] ? r[0].data : null;
}

// All live planning sessions (most recent first). Lets any device discover an
// in-progress Plan-with-Claude — the session lives server-side, so the panel
// shouldn't depend on one device's localStorage.
export async function listPlanners(cfg) {
  return (await q(cfg, 'SELECT data FROM planners ORDER BY created_at DESC')).map((r) => r.data);
}

export async function setProposed(cfg, id, tickets) {
  const p = await getPlanner(cfg, id);
  if (!p) return false;
  p.proposed = Array.isArray(tickets) ? tickets : [];
  p.updatedAt = Date.now();
  await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(p), id]);
  return true;
}

export async function stopPlanner(cfg, id) {
  const p = await getPlanner(cfg, id);
  if (p) await sh('tmux', ['kill-session', '-t', plannerSession(cfg, p)]);
  await q(cfg, 'DELETE FROM planners WHERE id = $1', [id]);
  return true;
}

// Run the plan verifier and persist the result. INCREMENTAL: each ticket carries
// a content signature; a re-verify only (re)checks tickets whose signature changed
// since they were last graded — unchanged tickets keep their cached verdict, so a
// refine round only re-validates what was actually edited (and a no-op re-verify
// spends nothing). The full plan is still sent as context so cross-ticket deps and
// handoffs are checked, but only the changed tickets are graded.
export async function verifyPlanner(cfg, id, tickets) {
  const p = await getPlanner(cfg, id);
  if (!p) return { error: 'planner not found' };
  const list = (Array.isArray(tickets) ? tickets : p.proposed) || [];
  if (!list.length) return { error: 'no tickets to verify' };
  // Don't double-spend if a verify is already in flight (the running flag is
  // server-side, so it survives the operator switching tabs / devices). The guard
  // expires a bit past the verifier's own wall-clock limit so a crashed run can't
  // wedge the planner; a clean restart also clears the flag (worktree-gc.js).
  const guardMs = (cfg.verifierCapMs || 1800000) + 120000;
  if (p.verifying && p.verifyStartedAt && Date.now() - p.verifyStartedAt < guardMs) return { verifying: true, note: 'a verify is already running' };

  const prev = (p.verify && p.verify.bySig) || {};
  const sigs = list.map(ticketSig);
  const dirtyIdx = list.map((_, i) => i).filter((i) => !prev[sigs[i]]);

  // Everything already has a cached verdict → no LLM call; just re-emit the merged
  // review against the current ordering.
  if (!dirtyIdx.length) {
    const review = mergeReview(list, sigs, prev);
    const cur = (await getPlanner(cfg, id)) || p;
    cur.review = review; cur.reviewedAt = Date.now(); cur.verify = { bySig: pruneSigs(sigs, prev) };
    await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(cur), id]);
    return { ...review, incremental: true, rechecked: 0 };
  }

  p.verifying = true; p.verifyStartedAt = Date.now();
  await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(p), id]);
  let out;
  try {
    const focus = dirtyIdx.map((i) => i + 1); // 1-based ticket numbers to grade
    const raw = await reviewPlan(cfg, p, list, sh, focus);
    if (raw.failed) { out = raw; }
    else {
      const byNum = {};
      for (const f of (raw.findings || [])) (byNum[f.ticket] ||= []).push(f);
      const bySig = {};
      for (let i = 0; i < list.length; i++) {
        if (prev[sigs[i]] && !dirtyIdx.includes(i)) { bySig[sigs[i]] = prev[sigs[i]]; continue; }
        const fs = (byNum[i + 1] || []).map((f) => ({ ...f }));
        bySig[sigs[i]] = { status: fs.length ? 'issue' : 'clean', findings: fs };
      }
      bySig._plan = { findings: (byNum[0] || []).map((f) => ({ ...f })) }; // plan-wide, always fresh
      out = { ...mergeReview(list, sigs, bySig), rechecked: dirtyIdx.length, _bySig: bySig };
    }
  } finally {
    const cur = (await getPlanner(cfg, id)) || p;
    cur.verifying = false;
    if (out && out._bySig) { cur.verify = { bySig: out._bySig }; cur.review = mergeReview(list, sigs, out._bySig); cur.reviewedAt = Date.now(); delete out._bySig; }
    else if (out) { cur.review = out; cur.reviewedAt = Date.now(); } // failed: surface message, keep cache
    await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(cur), id]);
  }
  return out;
}

// Set the editable plan name on the planner (used as the plan when tickets are
// created). Defaults to the planner title until the operator renames it.
export async function setPlanName(cfg, id, name) {
  const p = await getPlanner(cfg, id);
  if (!p) return { error: 'planner not found' };
  p.planName = String(name || '').slice(0, 80);
  await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(p), id]);
  return { ok: true, planName: p.planName };
}

// Type a message into the planner's live tmux session (interactive Claude).
function sendToPlanner(cfg, p, text) {
  const session = plannerSession(cfg, p);
  return sh('tmux', ['send-keys', '-t', session, '-l', text])
    .then(() => sh('tmux', ['send-keys', '-t', session, 'Enter']).then((r) => r.ok));
}

// Push selected verifier findings INTO the planner chat with an instruction to
// revise the affected tickets and re-propose. The verifier runs as a separate
// sub-agent, so without this its findings never reach the chat's context.
export async function refineFromReview(cfg, id, findings) {
  const p = await getPlanner(cfg, id);
  if (!p) return { error: 'planner not found' };
  const list = (Array.isArray(findings) && findings.length ? findings : (p.review && p.review.findings) || []);
  if (!list.length) return { error: 'no findings selected' };
  const lines = list.map((f) => `(#${f.ticket || 'plan'}, ${f.severity}) ${String(f.issue || '').slice(0, 400)}${f.fix ? ` — suggested fix: ${String(f.fix).slice(0, 400)}` : ''}`).join('\n');
  const permFile = path.join(cfg.agentPermDir, 'planner.json');
  const msg = [
    `The plan verifier flagged these issues with the proposed tickets:`,
    lines,
    ``,
    `Before revising any ticket, RE-READ the actual source files for each issue — do not update ticket text based on the finding description alone. The verifier read the real code at the base branch; your fix must match what the code actually contains.`,
    `For each finding: (1) identify the specific file(s) involved, (2) open and read them to confirm the correct name/path/signature/shape, (3) revise the ticket based only on what you confirmed.`,
    `Use a sub-agent to read without polluting your context:`,
    `  claude -p --max-turns 10 --model sonnet --settings '${permFile}' "Read [file]. Confirm specifically: [question about the issue]. Output bullet-point facts only." 2>&1`,
    `After confirming all fixes, call plan-emit or propose_tickets with the FULL revised ticket array. Do not guess — if you are unsure, read the code first.`
  ].join('\n');
  const ok = await sendToPlanner(cfg, p, msg);
  return { ok, sent: list.length };
}

// Create the proposed tickets as a dependency-wired batch tagged with this
// planner's plan. Optionally pass an edited ticket list. Verification is NOT run
// here — it's an explicit, on-demand step (the 🔎 Verify button) so we don't burn
// tokens on a verify for every Create.
export async function createFromPlanner(cfg, id, tickets) {
  const p = await getPlanner(cfg, id);
  if (!p) return { error: 'planner not found' };
  const list = (Array.isArray(tickets) ? tickets : p.proposed) || [];
  const plan = (p.planName || p.title || 'plan').trim();
  // Stamp ONE unique integration branch for the whole batch so two plans with the
  // same (often default) title never collide on plan/<slug>.
  const planBranch = `plan/${planSlug(plan)}-${id.slice(-4)}`;
  const r = await createMany(cfg, list.map((t) => ({ ...t, plan, planBranch })));
  await setProposed(cfg, id, []); // clear the proposed list so the panel section goes away
  return r;
}

// Server-side build loop: verify → headless fix → re-verify, up to MAX_ROUNDS.
// Runs async (fire-and-forget from the route). Progress tracked in planner.buildStatus
// so the UI can poll it. No tmux injection — the fixer is a headless claude -p agent
// that reads the real code and rewrites failing tickets directly.
export async function buildAndValidate(cfg, id) {
  const p = await getPlanner(cfg, id);
  if (!p) return { error: 'planner not found' };

  // Guard: one build at a time; stale guard expires after 35 min
  const guardMs = 35 * 60 * 1000;
  if (p.building && p.buildStartedAt && Date.now() - p.buildStartedAt < guardMs) {
    return { building: true, note: 'already running' };
  }

  const MAX_ROUNDS = 4;
  let lastFindings = [];

  // Mark building
  const init = { ...p, building: true, buildStartedAt: Date.now(), buildRound: 0, buildStatus: 'starting…' };
  await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(init), id]);

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const cur = await getPlanner(cfg, id);
      if (!cur) break;
      const list = cur.proposed || [];
      if (!list.length) {
        cur.building = false; cur.buildStatus = 'no tickets to validate';
        await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(cur), id]);
        return { ok: false, reason: 'no tickets' };
      }

      // --- VERIFY ---
      cur.buildRound = round + 1;
      cur.buildStatus = `round ${round + 1}/${MAX_ROUNDS}: verifying ${list.length} ticket${list.length > 1 ? 's' : ''}…`;
      await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(cur), id]);

      const raw = await reviewPlan(cfg, cur, list, sh, null); // null = verify all tickets

      if (raw.failed) {
        const c = await getPlanner(cfg, id);
        c.building = false; c.buildStatus = `verify failed: ${raw.summary} — try Build again`;
        await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(c), id]);
        return { failed: true, reason: raw.summary };
      }

      // Update bySig cache and review so per-ticket badges update in the UI
      const sigs = list.map(ticketSig);
      const byNum = {};
      for (const f of (raw.findings || [])) (byNum[f.ticket] ||= []).push(f);
      const bySig = {};
      for (let i = 0; i < list.length; i++) {
        const fs = (byNum[i + 1] || []).map((f) => ({ ...f }));
        bySig[sigs[i]] = { status: fs.length ? 'issue' : 'clean', findings: fs };
      }
      bySig._plan = { findings: (byNum[0] || []).map((f) => ({ ...f })) };
      const review = mergeReview(list, sigs, bySig);

      const actionable = (raw.findings || []).filter((f) => f.severity === 'high' || f.severity === 'medium');
      lastFindings = actionable;

      // Persist verify state so badges and review panel update live
      const afterVerify = await getPlanner(cfg, id);
      afterVerify.verify = { bySig }; afterVerify.review = review; afterVerify.reviewedAt = Date.now();
      afterVerify.buildRound = round + 1;

      if (!actionable.length) {
        afterVerify.building = false;
        afterVerify.buildStatus = `✅ all ${list.length} ticket${list.length > 1 ? 's' : ''} validated — ready to Create`;
        await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(afterVerify), id]);
        return { ok: true, rounds: round + 1 };
      }

      if (round === MAX_ROUNDS - 1) {
        const remaining = [...new Set(actionable.map((f) => f.ticket).filter((n) => n > 0))];
        afterVerify.building = false;
        afterVerify.buildStatus = `${actionable.length} issue${actionable.length > 1 ? 's' : ''} remain on ticket${remaining.length > 1 ? 's' : ''} ${remaining.map((n) => `#${n}`).join(', ')} after ${MAX_ROUNDS} rounds — review the findings and update the planner chat`;
        await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(afterVerify), id]);
        return { ok: false, findings: actionable };
      }

      // --- FIX ---
      const failingNums = [...new Set(actionable.map((f) => f.ticket).filter((n) => n > 0))];
      afterVerify.buildStatus = `round ${round + 1}/${MAX_ROUNDS}: fixing ticket${failingNums.length > 1 ? 's' : ''} ${failingNums.map((n) => `#${n}`).join(', ')}…`;
      await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(afterVerify), id]);

      const fixed = await fixTickets(cfg, afterVerify, list, actionable);

      if (fixed.failed) {
        const c = await getPlanner(cfg, id);
        c.building = false; c.buildStatus = `fixer failed: ${fixed.reason} — try Build again`;
        await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(c), id]);
        return { failed: true, reason: fixed.reason };
      }

      // Persist revised tickets; clear bySig for fixed tickets so next verify re-grades them
      const afterFix = await getPlanner(cfg, id);
      afterFix.proposed = fixed.tickets;
      afterFix.buildStatus = `round ${round + 1}/${MAX_ROUNDS}: fixed (${fixed.summary}) — re-verifying…`;
      // Clear cache only for the tickets that were revised
      const newSigs = fixed.tickets.map(ticketSig);
      const prunedBySig = {};
      for (let i = 0; i < list.length; i++) {
        if (failingNums.includes(i + 1)) continue; // drop cache → forces fresh verify
        if (bySig[sigs[i]]) prunedBySig[newSigs[i]] = bySig[sigs[i]];
      }
      afterFix.verify = { bySig: prunedBySig };
      await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(afterFix), id]);
    }
  } catch (e) {
    const c = await getPlanner(cfg, id);
    if (c) {
      c.building = false; c.buildStatus = `build error — try again`;
      await q(cfg, 'UPDATE planners SET data = $1::jsonb WHERE id = $2', [JSON.stringify(c), id]);
    }
    throw e;
  }

  return { ok: false, findings: lastFindings };
}
