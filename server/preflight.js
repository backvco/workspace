// Pre-flight baseline check for the planner. Before a planning session starts we
// verify every repo in scope is sitting on a known-good baseline, so the planner
// reasons about — and the agents it spawns fork off — the same remote truth:
//   - app repos  (integration branch dev/develop): on that branch, clean, synced
//     to origin/<base>.
//   - sdk repos  (main/master, published to npmjs): on that branch + the local
//     package.json version matches the latest published on npmjs, so the code in
//     scope reflects what consumers actually install.
// Philosophy: HARD-BLOCK only when the baseline is UNKNOWN (no origin/<base>, or a
// fetch failed). Local WIP — uncommitted changes, unpushed commits, a parked
// feature branch, a stale sdk version — is a WARNING, not a block: agents fork
// from origin/<base> (and work in their own worktrees, leaving the live checkout
// clean), so in-progress work is never lost, but the operator should KNOW it
// isn't in the baseline the plan is built on.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { listRepos, status, currentBranch, fetchRemote, revParse, aheadBehind } from './git.js';
import { projectDir } from './projects.js';

const sh = (cmd, args, opts = {}) =>
  new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 22, timeout: 20000, ...opts }, (e, o, er) =>
    res({ ok: !e, out: (o || '').toString(), err: (er || '').toString() })));

function readPkg(repo) {
  try { return JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')); } catch { return null; }
}

// Latest version published on npmjs (null if unpublished / lookup failed).
async function npmLatest(name) {
  if (!name) return null;
  const r = await sh('npm', ['view', name, 'version']);
  return r.ok ? r.out.trim() : null;
}

// Classify a repo and pick the branch its work must start from. The convention
// here: app repos integrate on dev/develop; SDKs (the published packages under a
// `sdks/` dir) cut from main/master and ship to npmjs. Branch existence alone is
// unreliable — some SDK repos carry a stray origin/dev — so the `sdks/` path is
// the primary SDK signal, with a publishable package.json as the fallback signal.
const underSdks = (repo) => /(^|\/)sdks\//.test(repo);

async function classify(repo) {
  const ex = {};
  for (const b of ['dev', 'develop', 'main', 'master']) ex[b] = !!(await revParse(repo, `origin/${b}`));
  const pkg = readPkg(repo);
  const publishable = !!(pkg && pkg.name && pkg.private !== true);
  if (underSdks(repo)) {
    const base = ex.main ? 'main' : ex.master ? 'master' : ex.dev ? 'dev' : ex.develop ? 'develop' : null;
    return { kind: 'sdk', base, pkg, publishable };
  }
  const base = ex.dev ? 'dev' : ex.develop ? 'develop' : ex.main ? 'main' : ex.master ? 'master' : null;
  const kind = (base === 'main' || base === 'master') && publishable ? 'sdk' : 'app';
  return { kind, base, pkg, publishable };
}

export async function checkRepo(repo) {
  const name = path.basename(repo);
  const fetched = await fetchRemote(repo);
  const { kind, base, pkg, publishable } = await classify(repo);
  const branch = await currentBranch(repo);
  const dirty = (await status(repo)).length;
  const messages = [];

  // No integration branch on the remote → the one true hard block: we literally
  // have no known start point to fork work from.
  if (!base) {
    return {
      path: repo, name, kind, base: null, branch, dirty, ahead: 0, behind: 0,
      status: 'block',
      messages: [`No dev/main/master branch on origin${fetched.ok ? '' : ' (git fetch failed — remote unreachable?)'} — the start point is unknown.`]
    };
  }

  const ab = branch === base ? await aheadBehind(repo, `origin/${base}`) : null;
  let level = 'ok';
  const warn = (m) => { level = 'warn'; messages.push(m); };

  if (branch !== base) warn(`Live checkout is on '${branch}', not '${base}'. The plan is built on origin/${base}; edits on '${branch}' won't be in that baseline.`);
  if (dirty) warn(`${dirty} uncommitted change(s) in the live checkout — not in origin/${base}, so the plan won't account for them (they're safe; agents work in separate worktrees).`);
  if (ab?.behind) warn(`Local ${base} is ${ab.behind} commit(s) behind origin/${base} — \`git pull\` to refresh the baseline.`);
  if (ab?.ahead) warn(`Local ${base} has ${ab.ahead} unpushed commit(s) — not on origin/${base}, so the plan won't include them.`);

  const out = {
    path: repo, name, kind, base, branch, dirty,
    ahead: ab?.ahead || 0, behind: ab?.behind || 0, status: level, messages
  };

  if (kind === 'sdk' && publishable) {
    const pubName = pkg.name;
    const local = pkg.version || null;
    const latest = await npmLatest(pubName);
    out.npm = { name: pubName, local, latest };
    if (latest && local && latest !== local) {
      if (out.status !== 'block') out.status = 'warn';
      out.messages.push(`${pubName}: local ${local} ≠ npmjs latest ${latest}. Plan against ${latest} (what consumers install) — bump/publish or pull before building on it.`);
    }
  }
  return out;
}

// Check every repo under a project dir. Repos are checked concurrently (each does
// a network fetch + maybe an npm lookup), so a 12-repo project stays snappy.
export async function preflightRepos(repos) {
  const results = await Promise.all(repos.map(checkRepo));
  const blocked = results.some((r) => r.status === 'block');
  const warned = results.some((r) => r.status === 'warn');
  return { ok: !blocked, blocked, warned, repos: results };
}

// The repo paths in a project's scope (cheap — no network), so a caller can show
// the list immediately and check each one with progress.
export async function scopedRepos(cfg, project) {
  const ns = project || 'default';
  const dir = await projectDir(cfg, ns);
  const repos = listRepos(cfg).map((r) => r.path).filter((x) => x.startsWith(dir));
  return { ns, dir, repos };
}

export async function preflightProject(cfg, project) {
  const { ns, dir, repos } = await scopedRepos(cfg, project);
  const report = await preflightRepos(repos);
  return { ...report, project: ns, dir };
}

// A compact baseline summary for the planner's seed prompt, so the planning
// Claude reasons from the verified state instead of guessing at the live tree.
export function preflightSummary(report) {
  if (!report?.repos?.length) return '';
  const lines = report.repos.map((r) => {
    const tag = r.status === 'ok' ? 'clean & synced' : r.messages.join(' ');
    const npm = r.npm ? ` [npm ${r.npm.name}: local ${r.npm.local ?? '?'} / latest ${r.npm.latest ?? '?'}]` : '';
    return `- ${r.path} → base origin/${r.base} (${r.kind})${npm}: ${tag}`;
  });
  return [
    `Repository baseline (verified just now — agents will fork from origin/<base>, so plan against THAT, not the live working copy):`,
    ...lines,
    `If a repo shows uncommitted or unpushed work above, that work is NOT in the baseline — do not assume it exists. Flag any repo you must build on that is behind origin or whose sdk version is stale.`
  ].join('\n');
}
