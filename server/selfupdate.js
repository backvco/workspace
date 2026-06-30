// Self-update: report whether the workspace's OWN checkout is behind its git
// remote, and (on request) fast-forward pull + redeploy. Operates on THIS repo
// (the live checkout that serves the app) — not on a project repo.
//
// The build half is already automated: bin/deploy-ui stamps .deploy-rev and the
// workspace-ui-deploy watcher rebuilds whenever HEAD != .deploy-rev. The only
// gap this fills is the *pull* — nothing otherwise brings origin/<branch> into
// the live checkout. After a pull we kick deploy-ui ourselves (detached) so the
// user gets an immediate build instead of waiting out the watcher's debounce;
// deploy-ui's flock serialises us against the watcher so there's no double build.
import { execFile, spawn } from 'node:child_process';
import { readFileSync, openSync } from 'node:fs';
import path from 'node:path';

// server/ lives directly under the checkout root, regardless of the API's cwd.
const REPO = path.resolve(import.meta.dirname, '..');
const DEPLOY_LOG = '/tmp/workspace-selfupdate.log';

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: REPO, maxBuffer: 1 << 24 }, (err, out, errOut) =>
      resolve({ ok: !err, out: (out || '').toString(), err: (errOut || '').toString() }));
  });
}

const short = (s) => (s || '').trim().slice(0, 9);

// Commit currently serving, stamped by bin/deploy-ui ('' if never deployed).
function deployedRev() {
  try { return readFileSync(path.join(REPO, '.deploy-rev'), 'utf8').trim(); }
  catch { return ''; }
}

let updating = false;

/**
 * Fetch origin, then compare local HEAD vs origin/<branch> and vs the deployed
 * build. `behind` > 0 => a pull is available; `buildStale` => HEAD isn't the
 * build that's running yet (the watcher will catch up, or deploy now).
 */
export async function updateStatus() {
  const branch = ((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'master').trim();
  await git(['fetch', '--quiet', '--prune', 'origin']);
  const head = (await git(['rev-parse', 'HEAD'])).out.trim();
  const remote = (await git(['rev-parse', '--verify', '--quiet', `origin/${branch}`])).out.trim();

  let ahead = 0, behind = 0, incoming = [];
  if (remote) {
    const ab = await git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
    if (ab.ok) { const [a, b] = ab.out.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0); ahead = a; behind = b; }
    if (behind > 0) {
      const log = await git(['log', '--no-merges', '--pretty=%h\t%s', `HEAD..origin/${branch}`, '-n', '20']);
      if (log.ok) incoming = log.out.split('\n').filter(Boolean).map((l) => {
        const i = l.indexOf('\t');
        return { hash: l.slice(0, i), subject: l.slice(i + 1) };
      });
    }
  }
  const dirty = !!(await git(['status', '--porcelain'])).out.trim();
  const deployed = deployedRev();
  return {
    branch,
    head: short(head),
    remote: short(remote),
    deployed: short(deployed),
    ahead, behind, incoming, dirty, updating,
    updateAvailable: behind > 0,
    buildStale: !!deployed && deployed !== head,
    // A fast-forward pull needs no local-only commits. A dirty tree is allowed
    // through — git refuses with a clear message if the changes actually clash,
    // which we surface verbatim rather than pre-judging.
    canFastForward: behind > 0 && ahead === 0,
  };
}

// deploy-ui (build ~1min + restart) runs detached so the HTTP request returns
// immediately; the UI polls updateStatus() to watch the new build land.
function deployDetached() {
  const fd = openSync(DEPLOY_LOG, 'a');
  const child = spawn(path.join(REPO, 'bin', 'deploy-ui'), ['--auto'], {
    cwd: REPO, detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
}

/** Pull (fast, synchronous) then kick a detached deploy. */
export async function runUpdate() {
  if (updating) return { ok: false, error: 'an update is already in progress' };
  updating = true;
  try {
    const branch = ((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'master').trim();
    const pull = await git(['pull', '--ff-only', 'origin', branch]);
    if (!pull.ok) return { ok: false, error: (pull.err || pull.out).trim() || 'git pull --ff-only failed' };
    const head = short((await git(['rev-parse', 'HEAD'])).out);
    deployDetached();
    return { ok: true, deploying: true, head };
  } finally {
    updating = false;
  }
}
