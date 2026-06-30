// Standalone entry: a minimal Express + http server that mounts the workspace
// backend. When embedding elsewhere, skip this file and call installWorkspace()
// against the host app instead.
import express from 'express';
import http from 'node:http';
import { installWorkspace } from './install.js';
import { validateConfig, defaultConfig } from './config.js';
import { checkDependencies } from './deps.js';
import { initSchema } from './db.js';
import { reconcileVerifyState } from './worktree-gc.js';

// Fail fast on missing required config before standing anything up.
try { validateConfig(defaultConfig); }
catch (e) { console.error('\n[workspace] ' + e.message + '\n'); process.exit(1); }

const app = express();
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'workspace-api' }));
const server = http.createServer(app);

(async () => {
  // Show a clear ✓/✗ of the external tools + database the app needs, and refuse
  // to boot if a hard requirement is missing (point the operator at the fixer).
  const dep = await checkDependencies(defaultConfig);
  console.log('[workspace] dependency check:\n' + dep.lines.join('\n'));
  if (dep.hardMissing.length) {
    console.error(
      `\n[workspace] missing required dependencies: ${dep.hardMissing.join(', ')}.` +
      `\n[workspace] run ./bin/install-deps to install the system tools` +
      `; for Postgres, check WORKSPACE_DATABASE_URL and that the server is running.\n`);
    process.exit(1);
  }

  const cfg = installWorkspace(app, server);
  await initSchema(cfg); // ensure the schema exists before accepting requests
  server.listen(cfg.port, cfg.host, () => console.log(`workspace-api on http://${cfg.host}:${cfg.port}`));
  // Boot reconcile (clear stuck verifying flags, wipe leftover verify worktrees).
  // Fire-and-forget so a slow git sweep can't delay accepting requests.
  reconcileVerifyState(cfg).catch((e) => console.error('[verify-gc] reconcile failed:', e.message));
})().catch((e) => { console.error('workspace-api boot failed:', e.message); process.exit(1); });
