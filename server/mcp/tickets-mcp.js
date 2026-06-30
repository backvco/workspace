#!/usr/bin/env node
// Tickets MCP server — a dependency-free stdio JSON-RPC (MCP) server that exposes
// the ticket board as proper schema'd tools, backed by the workspace-api REST
// endpoints. Any Claude agent (the planner, a working agent, the advisor) can
// create/list/link/start tickets natively instead of formatting JSON into a CLI.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
// convention). No SDK, no deps. Env: WORKSPACE_PORT (default 5301), PLANNER_ID
// (when launched inside a planning session, enables propose_tickets).
import { createInterface } from 'node:readline';

const PORT = process.env.WORKSPACE_PORT || '5301';
const BASE = `http://127.0.0.1:${PORT}/api`;
const PLANNER_ID = process.env.PLANNER_ID || '';
const API_TOKEN = process.env.WORKSPACE_API_TOKEN || ''; // bypasses auth when enabled

async function rest(path, method = 'GET', body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (API_TOKEN) headers['x-workspace-token'] = API_TOKEN;
    const res = await fetch(`${BASE}${path}`, {
      method, signal: ac.signal,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally {
    clearTimeout(t);
  }
}

const TICKET_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'short title' },
    goal: { type: 'string', description: 'what to build (2-4 sentences): which files/functions/routes are involved with file:line citations, and why this change is needed' },
    criteria: { type: 'string', description: 'verifiable acceptance checks — each must be testable by running a specific command or inspecting a specific output' },
    steps: { type: 'string', description: 'numbered implementation steps; each step names the exact file to open and the exact change to make (add function X, update field Y from old to new, insert route at line ~N) — detailed enough for a junior developer to follow without guessing' },
    context: { type: 'string', description: 'background a junior developer needs: existing patterns to follow (with file:line citations), gotchas, why certain design choices were made' },
    role: { type: 'string', enum: ['implementer', 'reviewer', 'planner', 'writer', 'triage'] },
    repo: { type: 'string', description: 'absolute path of the repo this ticket works in' },
    dependsOn: { type: 'array', items: { type: 'integer' }, description: '0-based indexes of earlier tickets in this array that must finish first' }
  },
  required: ['title', 'goal', 'repo']
};

// Tool definitions: schema + handler. propose_tickets only appears in a planning session.
const TOOLS = [
  {
    name: 'create_tickets',
    description: 'Create a batch of backlog tickets at once, wiring dependsOn into real dependencies. Tickets are created as "to do" (no agent spawned). Returns the created ids.',
    inputSchema: { type: 'object', properties: { tickets: { type: 'array', items: TICKET_SCHEMA }, plan: { type: 'string', description: 'optional shared group/plan name' } }, required: ['tickets'] },
    run: async (a) => {
      const tickets = (a.tickets || []).map((t) => ({ ...t, plan: a.plan || t.plan }));
      const r = await rest('/agents/plan-create', 'POST', { tickets });
      return { created: (r.created || []).map((t) => ({ id: t.id, title: t.title, repo: t.dir })) };
    }
  },
  {
    name: 'create_ticket',
    description: 'Create a single backlog ticket (no agent spawned). Returns its id.',
    inputSchema: TICKET_SCHEMA,
    run: async (a) => {
      const r = await rest('/agents', 'POST', { dir: a.repo, title: a.title, goal: a.goal, criteria: a.criteria, steps: a.steps, context: a.context, role: a.role, start: false });
      return { id: r.id, title: r.title };
    }
  },
  {
    name: 'list_tickets',
    description: 'List tickets. Optionally filter by status and/or by the repo path prefix.',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, repoPrefix: { type: 'string' } } },
    run: async (a) => {
      let tasks = (await rest('/agents')).tasks || [];
      if (a.status) tasks = tasks.filter((t) => t.status === a.status);
      if (a.repoPrefix) tasks = tasks.filter((t) => (t.dir || '').startsWith(a.repoPrefix));
      return { tickets: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, repo: t.dir, role: t.role, plan: t.plan, blockedBy: t.blockedBy })) };
    }
  },
  {
    name: 'get_ticket',
    description: 'Get one ticket by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (a) => {
      const t = ((await rest('/agents')).tasks || []).find((x) => x.id === a.id);
      return t || { error: 'not found' };
    }
  },
  {
    name: 'update_ticket',
    description: 'Edit an existing ticket\'s title/goal/criteria/role. Use to ripple changes to a SIBLING ticket — only after the operator approves.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' }, criteria: { type: 'string' }, steps: { type: 'string' }, context: { type: 'string' }, role: { type: 'string' } }, required: ['id'] },
    run: async (a) => rest(`/agents/${encodeURIComponent(a.id)}/update`, 'POST', { title: a.title, goal: a.goal, criteria: a.criteria, steps: a.steps, context: a.context, role: a.role })
  },
  {
    name: 'link_tickets',
    description: 'Set a ticket\'s dependencies (it is blocked until every id in blockedBy is done).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, blockedBy: { type: 'array', items: { type: 'string' } } }, required: ['id', 'blockedBy'] },
    run: async (a) => rest(`/agents/${encodeURIComponent(a.id)}/links`, 'POST', { blockedBy: a.blockedBy })
  },
  {
    name: 'start_ticket',
    description: 'Dispatch a to-do ticket: spawn its agent and move it to planning. Fails if blocked by unfinished dependencies.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (a) => rest(`/agents/${encodeURIComponent(a.id)}/start`, 'POST')
  }
];

if (PLANNER_ID) {
  TOOLS.unshift({
    name: 'propose_tickets',
    description: 'Propose a ticket breakdown to the operator for review (does NOT create them). Use this in a planning session once you and the operator agree. They review and click Create all.',
    inputSchema: { type: 'object', properties: { tickets: { type: 'array', items: TICKET_SCHEMA } }, required: ['tickets'] },
    run: async (a) => {
      await rest(`/planners/${encodeURIComponent(PLANNER_ID)}/tickets`, 'POST', { tickets: a.tickets || [] });
      return { proposed: (a.tickets || []).length, note: 'Sent to the board for the operator to review and Create.' };
    }
  });
}

// --- JSON-RPC plumbing ---
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function result(id, r) { send({ jsonrpc: '2.0', id, result: r }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return result(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tickets', version: '1.0.0' } });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // no reply
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') {
    return result(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return error(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const out = await tool.run(params.arguments || {});
      return result(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      return result(id, { isError: true, content: [{ type: 'text', text: String(e && e.message || e) }] });
    }
  }
  if (id !== undefined) error(id, -32601, `method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let req;
  try { req = JSON.parse(s); } catch { return; }
  handle(req).catch((e) => { if (req.id !== undefined) error(req.id, -32603, String(e?.message || e)); });
});
rl.on('close', () => process.exit(0));
