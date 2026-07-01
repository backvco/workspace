// Host API — the STABLE surface a plugin may call to reuse the core (projects,
// git, tmux) instead of reimplementing it. Kept deliberately small and curated:
// this is the open, versioned seam between the OSS app and a (closed) plugin.
//
// Plugins call these over HTTP at /api/plugins/host/* authenticated with the
// per-process internal token (same mechanism the spawned agent CLIs use). See
// server/plugins/routes.js for the wiring.
import { loadProjects, listRoots } from '../projects.js';
import { listRepos, status as gitStatus, branches as gitBranches } from '../git.js';

// API version — bump on any breaking change to the surface below.
export const HOST_API_VERSION = 1;

/**
 * Build the host API bound to a config. Every method is a thin, read-only-ish
 * wrapper over an existing core module so behavior stays identical.
 * @param {any} cfg
 */
export function buildHostApi(cfg) {
  return {
    version: HOST_API_VERSION,
    /** Active project id for a request (mirrors the core's scoping). */
    workspaceId: (req) => cfg.resolveWorkspaceId(req),
    /** Configured project roots. */
    roots: () => listRoots(cfg),
    /** All discovered projects (dirs the app manages). */
    projects: () => loadProjects(cfg),
    /** Git repos under the project roots. */
    repos: () => listRepos(cfg),
    /** git status for one repo (absolute path). */
    gitStatus: (repo) => gitStatus(repo),
    /** branches for one repo. */
    gitBranches: (repo) => gitBranches(repo)
  };
}
