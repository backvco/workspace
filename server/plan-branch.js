// Plan integration branches. Tickets in an plan don't merge to a core branch
// (dev/qa/main) mid-chain — they accumulate on a shared per-repo integration
// branch `plan/<slug>`, forked off origin/<base>. Each ticket works on its own
// agent/<id> branch forked off the plan branch (so it sees prior accepted work);
// on accept, agent/<id> is merged into the plan branch and pushed. The whole plan
// lands on a core branch only via one operator-opened PR at the end.
//
// Merges happen in a throwaway worktree (the plan branch is never left checked
// out), serialized per repo+plan by a small async mutex so concurrent accepts /
// spawns don't race the ref.
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

const sh = (cmd, args, opts = {}) =>
  new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 22, ...opts }, (e, o, er) =>
    res({ ok: !e, out: (o || '').toString(), err: (er || '').toString() })));
const git = (repo, args, opts) => sh('git', ['-C', repo, ...args], opts);

let seq = 0;
const tmpName = () => { seq += 1; return `${process.pid}-${seq}`; };
function integRoot(cfg) { return path.join(cfg.projectRoots[0], '.agent-worktrees'); }

// --- per-key serialization (repo + plan branch) ------------------------------
const chains = new Map();
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next.finally(() => { if (chains.get(key) === next) chains.delete(key); }));
  return next;
}

// --- naming ------------------------------------------------------------------
export function planSlug(plan) {
  return String(plan || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan';
}
// The integration branch for a task: an explicit stored planBranch wins, else
// derived from the plan title. Null for ad-hoc (no-plan) tickets.
export function planBranchFor(task) {
  if (task && task.planBranch) return task.planBranch;
  if (task && task.plan) return `plan/${planSlug(task.plan)}`;
  return null;
}

// Point a local branch at <ref> without checking it out (safe when not in any
// worktree). Used to keep the plan branch tracking origin between operations.
async function setBranch(repo, branch, ref) {
  return git(repo, ['branch', '-f', branch, ref]);
}
async function exists(repo, ref) {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', ref])).ok;
}

// Ensure the local plan branch ref is current before an agent forks off it:
//   - if origin has it  -> local plan = origin/plan
//   - else              -> local plan = origin/<base>  (first ticket of the plan)
// Returns the ref name the caller should fork from.
export async function ensurePlanBase(cfg, repo, planBranch, baseBranch) {
  return withLock(`${repo}::${planBranch}`, async () => {
    await git(repo, ['fetch', 'origin', baseBranch]);
    await git(repo, ['fetch', 'origin', planBranch]); // best-effort; no-op if absent
    if (await exists(repo, `origin/${planBranch}`)) await setBranch(repo, planBranch, `origin/${planBranch}`);
    else if (await exists(repo, `origin/${baseBranch}`)) await setBranch(repo, planBranch, `origin/${baseBranch}`);
    else await setBranch(repo, planBranch, baseBranch);
    return planBranch;
  });
}

// Merge an accepted ticket's branch into its plan branch and push. Done in a
// throwaway worktree so the plan branch is never left checked out. On conflict,
// returns {ok:false, conflict:true, files} WITHOUT aborting state on the real
// branch — the caller decides whether to run the fixer.
// @returns {Promise<{ok:boolean, conflict?:boolean, files?:string[], err?:string, wt?:string, planBranch?:string}>}
export async function landToPlan(cfg, task) {
  const repo = task.dir;
  const planBranch = planBranchFor(task);
  const baseBranch = task.baseBranch || 'dev';
  return withLock(`${repo}::${planBranch}`, async () => {
    await git(repo, ['fetch', 'origin', baseBranch]);
    await git(repo, ['fetch', 'origin', planBranch]);
    if (await exists(repo, `origin/${planBranch}`)) await setBranch(repo, planBranch, `origin/${planBranch}`);
    else if (!(await exists(repo, planBranch))) await setBranch(repo, planBranch, `origin/${baseBranch}`);
    const wt = path.join(integRoot(cfg), `${path.basename(repo)}-${planSlug(planBranch)}-${tmpName()}`);
    await git(repo, ['worktree', 'prune']); // drop stale registrations from past crashes
    // DETACHED worktree: never check out the plan branch BY NAME (that locks it, so
    // a leftover land worktree would block the next land with "branch already used
    // by worktree"). We merge in a detached HEAD at the branch tip and push HEAD to
    // the branch ref, so concurrent/leftover land worktrees can't conflict.
    const add = await git(repo, ['worktree', 'add', '--detach', wt, planBranch]);
    if (!add.ok) return { ok: false, err: add.err || 'plan worktree add failed', planBranch };
    const merge = await git(wt, ['merge', '--no-ff', task.branch, '-m', `Integrate ${task.id} (${task.title || ''}) into ${planBranch}`]);
    if (merge.ok) {
      const push = await git(wt, ['push', 'origin', `HEAD:refs/heads/${planBranch}`]);
      if (push.ok) await advanceLocal(repo, wt, planBranch); // keep the local ref in step with origin
      cleanup(repo, wt);
      return push.ok ? { ok: true, planBranch } : { ok: false, err: push.err || 'push failed', planBranch };
    }
    // Conflict: leave the merge in progress in <wt> for the fixer to act on.
    const files = (await git(wt, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
    return { ok: false, conflict: true, files, wt, planBranch };
  });
}

// Finish a conflicted land after the fixer resolved (commit + push) or abort it.
export async function finishConflictedLand(cfg, repo, wt, planBranch, { commit }) {
  if (commit) {
    await git(wt, ['add', '-A']);
    const c = await git(wt, ['commit', '--no-edit']);
    if (!c.ok) { cleanup(repo, wt); return { ok: false, err: c.err || 'commit failed' }; }
    const push = await git(wt, ['push', 'origin', `HEAD:refs/heads/${planBranch}`]);
    if (push.ok) await advanceLocal(repo, wt, planBranch);
    cleanup(repo, wt);
    return push.ok ? { ok: true } : { ok: false, err: push.err };
  }
  await git(wt, ['merge', '--abort']);
  cleanup(repo, wt);
  return { ok: true, aborted: true };
}

// Fast-forward the local plan branch ref to the just-pushed merge commit. Safe
// because the branch is never checked out (land worktrees are detached), so
// `git branch -f` can't hit "refusing to update checked out branch".
async function advanceLocal(repo, wt, planBranch) {
  const sha = (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
  if (sha) await setBranch(repo, planBranch, sha);
}

function cleanup(repo, wt) {
  git(repo, ['worktree', 'remove', '--force', wt]).then(() => git(repo, ['worktree', 'prune'])).catch(() => {});
  try { rmSync(wt, { recursive: true, force: true }); } catch {}
}

// Open the single plan -> core PR (operator-triggered). Pushes the plan branch
// first so origin has it. Never merges; just creates the PR.
export async function openPlanPR(cfg, repo, planBranch, baseBranch, title, body) {
  await git(repo, ['fetch', 'origin', planBranch]);
  if (!(await exists(repo, `origin/${planBranch}`))) return { ok: false, err: 'plan branch has no commits on origin yet' };
  const r = await sh('gh', ['pr', 'create', '--repo', await ghRepo(repo), '--base', baseBranch, '--head', planBranch, '--title', title, '--body', body || ''], { cwd: repo });
  return { ok: r.ok, url: (r.out || '').trim(), err: r.err };
}
async function ghRepo(repo) {
  const r = await git(repo, ['config', '--get', 'remote.origin.url']);
  const m = (r.out || '').trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : '';
}
