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

// Turn a git remote URL (ssh or https) into a browsable GitHub repo URL, or
// '' if it's not a GitHub remote we can link to.
function githubRepoUrl(remoteUrl) {
  const m = (remoteUrl || '').trim().match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : '';
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
  const repoUrl = githubRepoUrl((await git(['remote', 'get-url', 'origin'])).out);

  let ahead = 0, behind = 0, incoming = [];
  if (remote) {
    const ab = await git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
    if (ab.ok) { const [a, b] = ab.out.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0); ahead = a; behind = b; }
    if (behind > 0) {
      const log = await git(['log', '--no-merges', '--pretty=%h\t%s', `HEAD..origin/${branch}`, '-n', '20']);
      if (log.ok) incoming = log.out.split('\n').filter(Boolean).map((l) => {
        const i = l.indexOf('\t');
        const hash = l.slice(0, i);
        return { hash, subject: l.slice(i + 1), url: repoUrl ? `${repoUrl}/commit/${hash}` : '' };
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
    repoUrl,
    deployedUrl: repoUrl && deployed ? `${repoUrl}/commit/${deployed}` : '',
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

// Restart a workspace-* service, detached. A short sleep lets the HTTP response
// for the triggering request finish flushing before the service manager kills
// the process — matters when the service being restarted is our own (the API).
// systemd on Linux; a LaunchDaemon (bin/lib/service.sh's naming: "workspace-api"
// -> label "com.workspace.api") on macOS.
function restartServiceDetached(unit) {
  const fd = openSync(DEPLOY_LOG, 'a');
  const restartCmd = process.platform === 'darwin'
    ? `sudo launchctl kickstart -k system/com.workspace.${unit.replace(/^workspace-/, '')}`
    : `sudo systemctl restart ${unit}`;
  const child = spawn('bash', ['-c', `sleep 0.3 && ${restartCmd}`], {
    detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
}

export function restartApi() { restartServiceDetached('workspace-api'); }
export function restartUi() { restartServiceDetached('workspace-ui'); }

/**
 * Bring the checkout to origin/<branch> then kick a detached deploy.
 * - normal: `git pull --ff-only` — refuses (returns the error) if the checkout
 *   has diverged, so a deploy box can never silently lose local commits.
 * - force: `git fetch` + `git reset --hard origin/<branch>` — the escape hatch
 *   for a box that diverged (e.g. origin was force-pushed/rewritten). DESTRUCTIVE:
 *   discards any local commits/changes on the checkout.
 */
export async function runUpdate(force = false) {
  if (updating) return { ok: false, error: 'an update is already in progress' };
  updating = true;
  try {
    const branch = ((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'master').trim();
    if (force) {
      const fetch = await git(['fetch', '--prune', 'origin']);
      if (!fetch.ok) return { ok: false, error: (fetch.err || 'git fetch failed').trim() };
      const reset = await git(['reset', '--hard', `origin/${branch}`]);
      if (!reset.ok) return { ok: false, error: (reset.err || 'git reset --hard failed').trim() };
    } else {
      const pull = await git(['pull', '--ff-only', 'origin', branch]);
      if (!pull.ok) return { ok: false, error: (pull.err || pull.out).trim() || 'git pull --ff-only failed' };
    }
    const head = short((await git(['rev-parse', 'HEAD'])).out);
    deployDetached();
    // server/** may have changed too; restart the API unconditionally rather
    // than diffing changed paths, so a pull never leaves it serving stale code.
    restartApi();
    return { ok: true, deploying: true, head };
  } finally {
    updating = false;
  }
}
