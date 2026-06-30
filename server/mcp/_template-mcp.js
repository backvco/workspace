#!/usr/bin/env node
// TEMPLATE MCP tool. Copy to server/mcp/<name>-mcp.js and fill in TOOLS. This is
// a dependency-free stdio JSON-RPC (MCP) server — the plumbing at the bottom is
// boilerplate you can leave as-is. See BUILDING-TOOLS.md.
import { createInterface } from 'node:readline';

const PORT = process.env.WORKSPACE_PORT || '5301';
const BASE = `http://127.0.0.1:${PORT}/api`;

// Helper for talking to the workspace-api (or any HTTP service).
async function rest(path, method = 'GET', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  try { return JSON.parse(await res.text()); } catch { return {}; }
}

// ── Define your tools here ──────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'example_action',
    description: 'Describe clearly what this does — Claude reads this to decide when to call it.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'what to echo' } },
      required: ['message']
    },
    run: async (args) => {
      // do the work; return any JSON-serializable value
      return { echoed: args.message };
    }
  },
  {
    name: 'workspace_api',
    description: 'Example of calling the workspace API with the rest() helper (GET or POST). Delete if your tool talks to nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'API path, e.g. /stats' },
        method: { type: 'string', description: 'GET (default) or POST' },
        body: { type: 'object', description: 'optional JSON body for POST/PUT' }
      },
      required: ['path']
    },
    run: async (args) => rest(args.path, args.method || 'GET', args.body)
  }
];
// ────────────────────────────────────────────────────────────────────────────

// JSON-RPC plumbing (boilerplate).
function send(m) { process.stdout.write(JSON.stringify(m) + '\n'); }
const ok = (id, r) => send({ jsonrpc: '2.0', id, result: r });
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') return ok(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'TEMPLATE', version: '1.0.0' } });
  if (method === 'ping') return ok(id, {});
  if (method && method.startsWith('notifications/')) return;
  if (method === 'tools/list') return ok(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return err(id, -32602, `unknown tool: ${params?.name}`);
    try { return ok(id, { content: [{ type: 'text', text: JSON.stringify(await tool.run(params.arguments || {})) }] }); }
    catch (e) { return ok(id, { isError: true, content: [{ type: 'text', text: String((e && e.message) || e) }] }); }
  }
  if (id !== undefined) err(id, -32601, `method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => { const s = line.trim(); if (!s) return; let r; try { r = JSON.parse(s); } catch { return; } handle(r).catch(() => {}); });
rl.on('close', () => process.exit(0));
