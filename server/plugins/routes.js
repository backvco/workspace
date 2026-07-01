// Plugin seam routes, mounted at /api/plugins (inside the authed main router).
//
//   GET  /api/plugins                 -> discovery: enabled plugins (for the UI)
//   ANY  /api/plugins/:name/proxy/*   -> auth-gated reverse-proxy to the plugin
//                                        service (so the app's login covers it)
//   GET  /api/plugins/host/*          -> the host API (internal-token gated); how
//                                        a plugin reuses core projects/git/tmux
//
// This is the ONLY agent-management-adjacent code in the OSS core, and it is
// generic (not feature-specific): the plugin is any external service.
import express from 'express';
import { listPlugins, getPlugin } from './registry.js';
import { buildHostApi } from './host-api.js';

export function buildPluginRouter(cfg) {
  const r = express.Router();
  const host = buildHostApi(cfg);
  r.use(express.json({ limit: '256kb' }));

  // Discovery — what the UI needs to know to embed plugin tools.
  r.get('/', (req, res) => {
    res.json(listPlugins(cfg).map((p) => ({ name: p.name, label: p.label })));
  });

  // Host API — a plugin calls these with the per-process internal token.
  const internalOnly = (req, res, next) => {
    const tok = req.get('x-workspace-token');
    if (!tok || tok !== cfg.internalToken) return res.status(403).json({ error: 'host api requires the internal token' });
    next();
  };
  r.get('/host/version', internalOnly, (req, res) => res.json({ version: host.version }));
  r.get('/host/roots', internalOnly, (req, res) => res.json(host.roots()));
  r.get('/host/projects', internalOnly, async (req, res) => {
    try { res.json(await host.projects()); } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });
  r.get('/host/repos', internalOnly, (req, res) => res.json(host.repos()));
  r.get('/host/git/status', internalOnly, async (req, res) => {
    try { res.json(await host.gitStatus(String(req.query.repo || ''))); } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });
  r.get('/host/git/branches', internalOnly, async (req, res) => {
    try { res.json(await host.gitBranches(String(req.query.repo || ''))); } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Reverse-proxy to a plugin's own service. The iframe + the plugin UI's API
  // calls go through here, so they inherit the workspace login (the plugin never
  // needs to be exposed publicly). Non-streaming; websockets are a follow-up.
  r.all('/:name/proxy/*', async (req, res) => {
    const plugin = getPlugin(cfg, req.params.name);
    if (!plugin) return res.status(404).json({ error: `unknown plugin: ${req.params.name}` });
    const rest = req.params[0] || '';
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const target = `${plugin.url}/${rest}${qs}`;
    try {
      const init = { method: req.method, headers: { 'x-forwarded-host': req.get('host') || '' } };
      if (!['GET', 'HEAD'].includes(req.method)) {
        init.headers['content-type'] = req.get('content-type') || 'application/json';
        init.body = req.is('application/json') ? JSON.stringify(req.body ?? {}) : undefined;
      }
      const upstream = await fetch(target, init);
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.set('content-type', ct);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch (e) {
      res.status(502).json({ error: `plugin ${req.params.name} unreachable: ${String(e?.message || e)}` });
    }
  });

  return r;
}
