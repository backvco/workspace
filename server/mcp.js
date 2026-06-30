// MCP management. Two scopes:
//  - global  : user-scope servers (shared everywhere) managed via the `claude mcp` CLI.
//  - project : a repo's own .mcp.json, loaded only when claude runs in that dir.
// DB templates turn a connection form into the right server entry.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SECRET_RE = /(pass|password|token|secret|key)/i;
const HOME = process.env.HOME || '/home/ubuntu';
function globalPath() { return path.join(HOME, '.claude.json'); }

function claude(cfg, args) {
  return new Promise((resolve) => {
    execFile(cfg.claudeBin, args, { maxBuffer: 1 << 20 }, (err, out, errOut) =>
      resolve({ ok: !err, out: (out || '').toString(), err: (errOut || '').toString() }));
  });
}

// --- redaction for display ---
function maskConn(s) {
  return String(s).replace(/(:\/\/[^:]+:)[^@]+(@)/, '$1***$2');
}
function summarize(server) {
  const cmd = [server.command, ...(server.args || [])].join(' ');
  return maskConn(cmd) || (server.url ? `${server.url} (http)` : '(custom)');
}

// Classify a server and, for DBs, pull back the editable fields (never the password).
function detectKind(s) {
  if (s.url || s.type === 'http') return 'http';
  const a = (s.args || []).join(' ');
  if (a.includes('server-postgres')) return 'postgres';
  if (a.includes('mcp-server-mysql')) return 'mysql';
  return 'command';
}
function dbFields(s, kind) {
  try {
    if (kind === 'postgres') {
      const conn = (s.args || []).find((x) => /^postgres/.test(x));
      const u = new URL(conn);
      return { host: u.hostname, port: u.port, database: decodeURIComponent(u.pathname.slice(1)), user: decodeURIComponent(u.username) };
    }
    if (kind === 'mysql') {
      const e = s.env || {};
      return { host: e.MYSQL_HOST, port: e.MYSQL_PORT, database: e.MYSQL_DB, user: e.MYSQL_USER };
    }
  } catch {}
  return null;
}
function describe(name, s) {
  const kind = detectKind(s);
  return { name, kind, summary: summarize(s), fields: dbFields(s, kind) };
}

// --- global (user scope) ---
export function readGlobal() {
  try {
    const j = JSON.parse(readFileSync(globalPath(), 'utf8'));
    const servers = j.mcpServers || {};
    return Object.entries(servers).map(([name, s]) => describe(name, s));
  } catch {
    return [];
  }
}
export function getRawGlobal(name) {
  try { return (JSON.parse(readFileSync(globalPath(), 'utf8')).mcpServers || {})[name] || null; } catch { return null; }
}
export async function addGlobal(cfg, name, server) {
  let args;
  if (server.url) {
    args = ['mcp', 'add', '--transport', 'http', name, server.url];
    for (const [k, v] of Object.entries(server.headers || {})) args.push('-H', `${k}: ${v}`);
  } else {
    args = ['mcp', 'add', name, '-s', 'user'];
    for (const [k, v] of Object.entries(server.env || {})) args.push('-e', `${k}=${v}`);
    args.push('--', server.command, ...(server.args || []));
  }
  return claude(cfg, args);
}
export async function removeGlobal(cfg, name) {
  return claude(cfg, ['mcp', 'remove', name, '-s', 'user']);
}

// --- project (.mcp.json) ---
function projectFile(p) { return path.join(p, '.mcp.json'); }
export function readProject(projectPath) {
  try {
    const j = JSON.parse(readFileSync(projectFile(projectPath), 'utf8'));
    const servers = j.mcpServers || {};
    return Object.entries(servers).map(([name, s]) => describe(name, s));
  } catch {
    return [];
  }
}
export function getRawProject(projectPath, name) {
  try { return (JSON.parse(readFileSync(projectFile(projectPath), 'utf8')).mcpServers || {})[name] || null; } catch { return null; }
}
export function writeProjectServer(projectPath, name, server) {
  let j = { mcpServers: {} };
  if (existsSync(projectFile(projectPath))) {
    try { j = JSON.parse(readFileSync(projectFile(projectPath), 'utf8')); } catch {}
  }
  j.mcpServers = j.mcpServers || {};
  j.mcpServers[name] = server;
  writeFileSync(projectFile(projectPath), JSON.stringify(j, null, 2));
}
export function removeProjectServer(projectPath, name) {
  if (!existsSync(projectFile(projectPath))) return;
  const j = JSON.parse(readFileSync(projectFile(projectPath), 'utf8'));
  if (j.mcpServers) delete j.mcpServers[name];
  writeFileSync(projectFile(projectPath), JSON.stringify(j, null, 2));
}

// --- discover candidate projects ---
export function listProjects(cfg) {
  const out = [];
  for (const root of cfg.projectRoots) {
    let entries = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const e of entries) {
      if (e.startsWith('.')) continue; // skip dotfiles/dirs
      const p = path.join(root, e);
      try {
        if (!statSync(p).isDirectory()) continue;
        out.push({ path: p, name: e, hasMcp: existsSync(projectFile(p)) });
      } catch {}
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// --- DB templates: form -> MCP server entry ---
export function buildDbServer(kind, c) {
  if (kind === 'postgres') {
    const conn = `postgresql://${c.user}:${c.password}@${c.host}:${c.port || 5432}/${c.database}`;
    return { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', conn] };
  }
  if (kind === 'mysql') {
    return {
      command: 'npx',
      args: ['-y', '@benborla29/mcp-server-mysql'],
      env: {
        MYSQL_HOST: c.host, MYSQL_PORT: String(c.port || 3306), MYSQL_USER: c.user,
        MYSQL_PASS: c.password, MYSQL_DB: c.database || '',
        ALLOW_INSERT_OPERATION: 'false', ALLOW_UPDATE_OPERATION: 'false', ALLOW_DELETE_OPERATION: 'false'
      }
    };
  }
  // custom: caller supplies command/args/env
  return { command: c.command, args: c.args || [], ...(c.env ? { env: c.env } : {}) };
}

// On edit, the UI leaves the password blank to keep the current one. Recover it
// server-side so the secret never has to round-trip through the browser.
export function existingPassword(cfg, scope, projectPath, name) {
  const s = scope === 'global' ? getRawGlobal(name) : getRawProject(projectPath, name);
  if (!s) return '';
  const kind = detectKind(s);
  if (kind === 'postgres') {
    try { return new URL((s.args || []).find((x) => /^postgres/.test(x))).password; } catch { return ''; }
  }
  if (kind === 'mysql') return (s.env || {}).MYSQL_PASS || '';
  return '';
}

// Relocate a server between scopes (global <-> project, project <-> project).
// Reads the raw config server-side, writes it to the target, removes the source.
export async function moveServer(cfg, name, from, to) {
  const raw = from.scope === 'global' ? getRawGlobal(name) : getRawProject(from.projectPath, name);
  if (!raw) return { ok: false, error: 'source server not found' };
  if (to.scope === 'global') {
    const r = await addGlobal(cfg, name, raw);
    if (!r.ok) return { ok: false, error: r.err || 'add to global failed' };
  } else {
    if (!to.projectPath) return { ok: false, error: 'target projectPath required' };
    writeProjectServer(to.projectPath, name, raw);
  }
  if (from.scope === 'global') await removeGlobal(cfg, name);
  else removeProjectServer(from.projectPath, name);
  return { ok: true };
}

export { SECRET_RE };
