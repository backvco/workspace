// Garbage collection + reuse for the plan verifier's git worktrees.
//
// The verifier (server/plan-review.js) reads each repo at a clean origin/<base>
// checkout. Rather than create-and-destroy a throwaway worktree per run (which
// leaks `.agent-worktrees/verify-*` dirs whenever the API restarts mid-verify and
// the cleanup never runs), we keep ONE reusable detached worktree per repo,
// `verify-<repo-basename>`, reset to the fresh base on each use and touched so GC
// can tell when it last mattered. Idle ones are swept on a timer; on boot we wipe
// every leftover verify worktree (nothing can be mid-verify across a restart).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { listRepos } from './git.js';
import { q } from './db.js';

const sh = (cmd, args, opts = {}) =>
  new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 24, ...opts }, (e, o, er) =>
    res({ ok: !e, out: (o || '').toString(), err: (er || '').toString() })));

const worktreeRoot = (cfg) => path.join(cfg.projectRoots[0], '.agent-worktrees');
const TOUCH = '.verify-last'; // marker file whose mtime = last time a verify used this tree
const isVerifyTree = (p) => path.basename(p).startsWith('verify-');

// Serialize operations on a single worktree path so two concurrent verifies that
// reuse the same repo's tree can't reset/read it at the same time.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.then(() => {}, () => {}));
  return next;
}

// Ensure a reusable, clean detached worktree at origin/<base> for `repo`. Returns
// { path, ok }; on any git failure falls back to reading the live repo ({ok:false}).
export async function acquireVerifyTree(cfg, repo, base) {
  const root = worktreeRoot(cfg);
  const wt = path.join(root, `verify-${path.basename(repo)}`);
  return withLock(wt, async () => {
    try {
      mkdirSync(root, { recursive: true });
      await sh('git', ['-C', repo, 'fetch', 'origin', base]);
      const hasRemote = (await sh('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `origin/${base}`])).ok;
      const start = hasRemote ? `origin/${base}` : base;
      let ready = false;
      if (existsSync(path.join(wt, '.git'))) {
        // Reuse: hard-reset the existing tree to the fresh base.
        ready = (await sh('git', ['-C', wt, 'checkout', '--detach', '--force', start])).ok;
        if (!ready) { // corrupt/stale — drop and recreate
          await sh('git', ['-C', repo, 'worktree', 'remove', '--force', wt]);
          await sh('git', ['-C', repo, 'worktree', 'prune']);
        }
      }
      if (!ready) {
        await sh('git', ['-C', repo, 'worktree', 'prune']);
        ready = (await sh('git', ['-C', repo, 'worktree', 'add', '--detach', '--force', wt, start])).ok;
      }
      if (!ready) return { path: repo, ok: false };
      await sh('git', ['-C', wt, 'clean', '-fdq']); // wipe a prior run's untracked leftovers
      try { writeFileSync(path.join(wt, TOUCH), String(Date.now())); } catch {}
      return { path: wt, ok: true };
    } catch {
      return { path: repo, ok: false };
    }
  });
}

// Remove verify worktrees. `all` wipes every one (boot); otherwise only those idle
// longer than the TTL. Always prunes stale registrations afterward.
export async function gcVerifyWorktrees(cfg, { all = false } = {}) {
  const ttl = cfg.verifyWorktreeTtlMs || 7200000;
  const now = Date.now();
  let removed = 0;
  for (const r of listRepos(cfg)) {
    const repo = r.path;
    const list = await sh('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
    if (!list.ok) continue;
    const paths = list.out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim());
    for (const wt of paths) {
      if (!isVerifyTree(wt)) continue;
      let idle = all;
      if (!all) {
        let last = 0;
        try { last = Number(readFileSync(path.join(wt, TOUCH), 'utf8')) || 0; } catch {}
        if (!last) { try { last = statSync(wt).mtimeMs; } catch {} }
        idle = !last || (now - last) > ttl;
      }
      if (idle && await withLock(wt, async () => (await sh('git', ['-C', repo, 'worktree', 'remove', '--force', wt])).ok)) removed++;
    }
    await sh('git', ['-C', repo, 'worktree', 'prune']);
  }
  return { removed };
}

// Boot reconciliation: no verify can survive an API restart, so clear any stuck
// `verifying` flag (else re-verify is blocked by the in-flight guard) and wipe
// every leftover verify worktree.
export async function reconcileVerifyState(cfg) {
  try {
    await q(cfg, `UPDATE planners SET data = jsonb_set(data, '{verifying}', 'false'::jsonb) WHERE data->>'verifying' = 'true'`);
  } catch (e) { console.error('[verify-gc] flag reconcile failed:', e.message); }
  try {
    const { removed } = await gcVerifyWorktrees(cfg, { all: true });
    if (removed) console.log(`[verify-gc] removed ${removed} leftover verify worktree(s) at boot`);
  } catch (e) { console.error('[verify-gc] boot sweep failed:', e.message); }
}

// Periodic idle sweep so reused trees don't live forever.
export function startWorktreeGc(cfg) {
  const ms = cfg.worktreeGcIntervalMs || 3600000;
  const iv = setInterval(() => {
    gcVerifyWorktrees(cfg).then(({ removed }) => { if (removed) console.log(`[verify-gc] swept ${removed} idle verify worktree(s)`); })
      .catch((e) => console.error('[verify-gc] sweep failed:', e.message));
  }, ms);
  iv.unref?.();
  return iv;
}
