// Host API — the STABLE surface a plugin may call to reuse the core (projects,
// git, tmux sessions) instead of reimplementing it. Kept small and curated: the
// open, versioned seam between the OSS app and a (closed) plugin.
//
// Plugins call these over HTTP at /api/plugins/host/* authenticated with the
// per-process internal token (server/plugins/routes.js). SECURITY (doc 23): every
// path is scoped to cfg.projectRoots and every tmux session is minted+namespaced by
// the core, so the plugin can never touch a path or session outside the workspace.
import path from 'node:path';
import { loadProjects, listRoots } from '../projects.js';
import { listRepos, status as gitStatus, branches as gitBranches } from '../git.js';
import { sessionName } from '../config.js';
import { listSessions, hasSession, killSession, sendText, sendKeys, newSession, capturePane } from '../tmux.js';

// API version — bump on any breaking change to the surface below.
export const HOST_API_VERSION = 2;

// Resolve a path and require it to sit inside a configured project root.
function assertInRoots(cfg, p) {
  const abs = path.resolve(p || '');
  const ok = (cfg.projectRoots || []).some((root) => {
    const r = path.resolve(root);
    return abs === r || abs.startsWith(r + path.sep);
  });
  if (!ok) throw new Error(`path outside project roots: ${p}`);
  return abs;
}

// Mint the tmux session name for a plugin (wsId, key). The plugin never names
// sessions itself → it can only ever address its OWN namespaced sessions.
function mgSession(cfg, wsId, key) {
  return sessionName(cfg, wsId, `mg-${String(key).replace(/[^\w.-]/g, '_')}`);
}

export function buildHostApi(cfg) {
  return {
    version: HOST_API_VERSION,
    workspaceId: (req) => cfg.resolveWorkspaceId(req),
    roots: () => listRoots(cfg),
    projects: () => loadProjects(cfg),
    repos: () => listRepos(cfg),
    gitStatus: (repo) => gitStatus(assertInRoots(cfg, repo)),
    gitBranches: (repo) => gitBranches(assertInRoots(cfg, repo)),

    // --- driven tmux sessions (guarded + namespaced) ---
    session: {
      /** Ensure a detached session running `command` in `cwd` (path-guarded). */
      ensure: async (wsId, key, { cwd, command, env } = {}) => {
        const name = mgSession(cfg, wsId, key);
        if (cwd) assertInRoots(cfg, cwd);
        if (!(await hasSession(name))) await newSession(name, { cwd, command, env });
        return { name, existed: false };
      },
      exists: (wsId, key) => hasSession(mgSession(cfg, wsId, key)),
      /** Type literal text (no submit). */
      send: (wsId, key, text) => sendText(mgSession(cfg, wsId, key), text),
      /** Send interpreted keys, e.g. 'Enter' / 'Escape'. */
      keys: (wsId, key, keys) => sendKeys(mgSession(cfg, wsId, key), keys),
      /** Read the tail of the pane (polled, read-only view). */
      capture: (wsId, key, lines) => capturePane(mgSession(cfg, wsId, key), lines),
      kill: (wsId, key) => killSession(mgSession(cfg, wsId, key)),
      /** This ws's plugin sessions only. */
      list: async (wsId) => {
        const prefix = mgSession(cfg, wsId, '');
        return (await listSessions()).filter((s) => s.startsWith(prefix));
      }
    }
  };
}
