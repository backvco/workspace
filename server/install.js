// The portable entry point. Mount the whole workspace backend onto an existing
// Express app + http server. A host app (or any host) calls this with its own
// app/server and a config override (e.g. a per-user resolveWorkspaceId).
import { defaultConfig } from './config.js';
import { buildRouter } from './routes.js';
import { installTerminals } from './terminals.js';
import { startWorktreeGc } from './worktree-gc.js';
import { startAgentReaper } from './agent-reaper.js';
import { startBackupScheduler } from './backups.js';
import { getAuthEnabled } from './auth.js';

export function installWorkspace(app, server, overrides = {}) {
  const cfg = { ...defaultConfig, ...overrides };
  const base = overrides.apiBase || '/api';
  app.use(base, buildRouter(cfg));
  installTerminals(server, cfg);
  startWorktreeGc(cfg); // periodic sweep of idle verify worktrees
  startAgentReaper(cfg); // periodic sweep of idle agent/chat/planner sessions
  startBackupScheduler(cfg); // scheduled pg_dump backups (off until enabled in Settings)
  getAuthEnabled(cfg).catch(() => {}); // prime the auth-enabled cache for the ws gate
  return cfg;
}
