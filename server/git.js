// Git access for the Changes tool: discover repos, list working-tree changes,
// and fetch the committed (HEAD) version of a file so the UI can diff it against
// what's on disk. All read-only.
import { execFile } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 1 << 24 }, (err, out, errOut) =>
      resolve({ ok: !err, out: (out || '').toString(), err: (errOut || '').toString() }));
  });
}

// Walk roots for git repos. We stop descending once a dir IS a repo (repos don't
// nest here, and this avoids scanning source trees), so we can go deep enough to
// reach container-of-containers layouts (e.g. a monorepo of repos with nested
// sub-packages) without being slow.
export function listRepos(cfg) {
  const repos = [];
  const scan = (dir, depth) => {
    if (existsSync(path.join(dir, '.git'))) { repos.push({ path: dir, name: path.basename(dir) }); return; }
    if (depth <= 0) return;
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue;
      const p = path.join(dir, e);
      try { if (statSync(p).isDirectory()) scan(p, depth - 1); } catch {}
    }
  };
  for (const root of cfg.projectRoots) scan(root, 5);
  repos.sort((a, b) => a.path.localeCompare(b.path));
  return repos;
}

export async function status(repo) {
  const r = await git(repo, ['status', '--porcelain', '-uall']);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l) => {
    const x = l[0], y = l[1];
    const file = l.slice(3).replace(/^"(.*)"$/, '$1');
    return { x, y, file, code: (x + y).trim() || '??', staged: x !== ' ' && x !== '?', unstaged: y !== ' ' };
  });
}

// Committed version of a file (empty string if the file is new / untracked).
export async function headVersion(repo, file) {
  const r = await git(repo, ['show', `HEAD:${file}`]);
  return r.ok ? r.out : '';
}

// Content of a file at any ref (branch/commit), '' if absent there.
export async function showAtRef(repo, ref, file) {
  const r = await git(repo, ['show', `${ref}:${file}`]);
  return r.ok ? r.out : '';
}
// Files differing between two refs (read-only; does not touch the working tree).
export async function diffRefs(repo, a, b) {
  const r = await git(repo, ['diff', '--name-status', a, b]);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l) => {
    const parts = l.split('\t');
    return { code: parts[0], file: parts[parts.length - 1] };
  });
}

// --- branches ---
export async function currentBranch(repo) {
  const r = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.out.trim() : '';
}
export async function branches(repo) {
  const r = await git(repo, ['branch', '--format=%(refname:short)']);
  const list = r.ok ? r.out.split('\n').filter(Boolean) : [];
  return { current: await currentBranch(repo), branches: list, default: await defaultBranch(repo) };
}
// The branch agents should fork off / PR into: prefer origin/HEAD, else a
// conventional integration branch, else the current branch. Never assume the
// live checkout's parked branch is a sane base.
export async function defaultBranch(repo) {
  const head = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out.trim()) return head.out.trim().replace(/^origin\//, '');
  const r = await git(repo, ['branch', '--format=%(refname:short)']);
  const list = r.ok ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  for (const cand of ['dev', 'develop', 'main', 'master']) if (list.includes(cand)) return cand;
  return (await currentBranch(repo)) || 'main';
}
// Refresh remote refs so ahead/behind + origin/<base> comparisons reflect the
// real remote. Quiet + pruned so a stale local ref can't mask a moved baseline.
export function fetchRemote(repo) {
  return git(repo, ['fetch', '--quiet', '--prune', 'origin']);
}
// Resolve a ref to a commit sha ('' if it doesn't exist — e.g. no origin/<base>).
export async function revParse(repo, ref) {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', ref]);
  return r.ok ? r.out.trim() : '';
}
// How far `ref` (default HEAD) has diverged from `base`: commits ref-has-but-base
// -lacks (ahead) and base-has-but-ref-lacks (behind). null if either ref is absent.
export async function aheadBehind(repo, base, ref = 'HEAD') {
  const r = await git(repo, ['rev-list', '--left-right', '--count', `${base}...${ref}`]);
  if (!r.ok) return null;
  const [behind, ahead] = r.out.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { ahead, behind };
}
export function checkout(repo, branch) { return git(repo, ['checkout', branch]); }
export function createBranch(repo, name, from) {
  return git(repo, from ? ['checkout', '-b', name, from] : ['checkout', '-b', name]);
}

// --- staging / commit / push ---
export function stage(repo, files) { return git(repo, ['add', '--', ...files]); }
export function stageAll(repo) { return git(repo, ['add', '-A']); }
export function unstage(repo, files) { return git(repo, ['restore', '--staged', '--', ...files]); }
export function commit(repo, message) { return git(repo, ['commit', '-m', message]); }
export function push(repo, branch, setUpstream) {
  return git(repo, setUpstream ? ['push', '-u', 'origin', branch] : ['push']);
}

// --- PR via gh (already authenticated) ---
function gh(cwd, args) {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, maxBuffer: 1 << 22 }, (err, out, errOut) =>
      resolve({ ok: !err, out: (out || '').toString(), err: (errOut || '').toString() }));
  });
}
export async function createPR(repo, base, title, body) {
  const r = await gh(repo, ['pr', 'create', '--base', base, '--title', title, '--body', body || '']);
  return { ok: r.ok, url: r.out.trim(), err: r.err };
}
