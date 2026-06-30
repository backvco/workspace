// Tool builder: the catalog of MCP tools (built-in + scaffolded), installing a
// tool into a project's .mcp.json, and scaffolding a new tool with Claude from
// the template. "Tools" = MCP servers under server/mcp/ (see BUILDING-TOOLS.md).
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { writeProjectServer, removeProjectServer, readProject } from './mcp.js';
import { loadProjects } from './projects.js';

const sh = (cmd, args, opts = {}) =>
  new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 22, ...opts }, (e, o, er) =>
    res({ ok: !e, out: (o || '').toString(), err: (er || '').toString() })));

const mcpDir = (cfg) => path.join(cfg.appRoot, 'server', 'mcp');

function builtins(cfg) {
  return [{
    id: 'tickets', name: 'tickets', label: 'Tickets board',
    description: 'Create, list, link and start tickets on the board — gives an agent native ticket actions.',
    script: path.join(mcpDir(cfg), 'tickets-mcp.js')
  }];
}
// Any *-mcp.js that isn't a built-in or the template = a scaffolded custom tool.
function scaffolded(cfg) {
  const known = new Set([...builtins(cfg).map((b) => path.basename(b.script)), '_template-mcp.js']);
  let files = [];
  try { files = readdirSync(mcpDir(cfg)); } catch {}
  return files.filter((f) => f.endsWith('-mcp.js') && !known.has(f)).map((f) => {
    const name = f.replace(/-mcp\.js$/, '');
    return { id: name, name, label: name, description: '(custom tool)', script: path.join(mcpDir(cfg), f) };
  });
}
export function listTools(cfg) { return [...builtins(cfg), ...scaffolded(cfg)]; }
const serverFor = (cfg, t) => ({ command: 'node', args: [t.script], env: { WORKSPACE_PORT: String(cfg.port) } });

export async function toolsCatalog(cfg) {
  const projects = await loadProjects(cfg);
  const has = (dir, name) => { try { return readProject(dir).some((s) => s.name === name); } catch { return false; } };
  const tools = listTools(cfg).map((t) => ({
    id: t.id, name: t.name, label: t.label, description: t.description, builtin: t.description !== '(custom tool)',
    installedIn: projects.filter((p) => has(p.dir, t.name)).map((p) => p.id)
  }));
  return { tools, projects: projects.map((p) => ({ id: p.id, label: `${p.group} / ${p.label}` })) };
}

export async function installTool(cfg, { tool, project }) {
  const t = listTools(cfg).find((x) => x.id === tool);
  if (!t) return { error: 'unknown tool' };
  const p = (await loadProjects(cfg)).find((x) => x.id === project);
  if (!p) return { error: 'unknown project' };
  writeProjectServer(p.dir, t.name, serverFor(cfg, t));
  return { ok: true, file: `${p.dir}/.mcp.json` };
}
export async function uninstallTool(cfg, { tool, project }) {
  const p = (await loadProjects(cfg)).find((x) => x.id === project);
  if (!p) return { error: 'unknown project' };
  removeProjectServer(p.dir, tool);
  return { ok: true };
}

// Scaffold a new MCP tool with Claude (headless): it writes the server code from
// the template + contract; we save it to server/mcp/<name>-mcp.js.
export async function scaffoldTool(cfg, { name, description }) {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) return { error: 'name must be lowercase letters, numbers and dashes' };
  if (!description) return { error: 'describe what the tool should do' };
  const dir = mcpDir(cfg);
  // name is already restricted to [a-z0-9-] above; basename is belt-and-suspenders
  // (no path separators reach the join) and makes the sanitizer explicit.
  const file = path.join(dir, `${path.basename(name)}-mcp.js`);
  if (existsSync(file)) return { error: 'a tool with that name already exists' };
  const template = readFileSync(path.join(dir, '_template-mcp.js'), 'utf8');
  const guide = readFileSync(path.join(dir, 'BUILDING-TOOLS.md'), 'utf8');
  const permFile = path.join(cfg.agentPermDir, 'guarded.json');
  const prompt = [
    `Write a complete MCP tool server named "${name}" that does the following:`,
    description,
    ``,
    `Follow this template EXACTLY (keep the JSON-RPC plumbing; only change serverInfo.name to "${name}" and the TOOLS array):`,
    '```js', template, '```',
    `Contract reference:`, guide,
    ``,
    `Write the file to ${file} using your Write tool. The file must be valid Node ESM and dependency-free.`
  ].join('\n').replace(/'/g, `'\\''`);
  const r = await sh('bash', ['-lc', `cd '${dir}' && ${cfg.claudeBin || 'claude'} -p --model opus --settings '${permFile}' '${prompt}'`], { timeout: 240000 });
  if (!existsSync(file)) return { error: 'Claude did not produce the file', detail: (r.out || r.err || '').slice(0, 300) };
  return { ok: true, id: name, file };
}
