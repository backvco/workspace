// Project registry (Postgres). A "project" is a domain: a directory carrying its
// own CLAUDE.md / MCP / memory. The active project scopes the whole UI — its id
// is the `workspaceId` everything else namespaces by (tabs, sessions, …).
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { q } from './db.js';

let seq = 0;
function genId() { seq += 1; return `p${Date.now().toString(36)}${seq.toString(36)}`; }

// The configured roots a project can be added from (from WORKSPACE_PROJECT_ROOTS).
// `label` is the root's basename, used to group projects in the rail.
export function listRoots(cfg) {
  return (cfg.projectRoots || []).map((root) => ({ root, label: path.basename(root) || root }));
}

// A fresh database starts with an empty board — projects are added by the user
// from the configured roots (no machine-specific seed).
export async function loadProjects(cfg) {
  const rows = await q(cfg, 'SELECT data FROM projects ORDER BY ord');
  return rows.map((r) => r.data);
}

export async function addProject(cfg, input) {
  if (!input || !input.dir || !input.label) return { error: 'label and dir required' };
  // Default the display group to the basename of the configured root it lives under.
  const owningRoot = (cfg.projectRoots || []).filter((root) => input.dir.startsWith(root)).sort((a, b) => b.length - a.length)[0];
  const p = {
    id: genId(),
    label: input.label,
    dir: input.dir,
    type: input.type || 'code',
    group: input.group || (owningRoot ? path.basename(owningRoot) : 'Projects'),
    defaultModel: input.defaultModel || '',
    defaultPermission: input.defaultPermission || 'guarded'
  };
  await q(cfg, 'INSERT INTO projects (id, data) VALUES ($1, $2::jsonb)', [p.id, JSON.stringify(p)]);
  return p;
}

// Folders under a configured root that can be added as a project. Lists every
// directory (containers + repos), but does NOT descend into a git repo (so we
// don't surface a repo's internal src/, server/, … dirs). Already-added folders
// are excluded so the picker only shows what's addable.
export async function availableFolders(cfg, rootArg) {
  const roots = cfg.projectRoots || [];
  // Accept a specific root, else default to the first configured one.
  const root = roots.includes(rootArg) ? rootArg : roots[0];
  if (!root) return [];
  const added = new Set((await loadProjects(cfg)).map((p) => p.dir));
  const out = [];
  const scan = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue;
      const p = path.join(dir, e);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      if (!added.has(p)) out.push({ dir: p, label: p.slice(root.length + 1) });
      const isRepo = existsSync(path.join(p, '.git'));
      if (!isRepo && depth > 1) scan(p, depth - 1);
    }
  };
  scan(root, 3);
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

export async function removeProject(cfg, id) {
  await q(cfg, 'DELETE FROM projects WHERE id = $1', [id]);
  return true;
}

// Working directory for a project id (scopes new terminals). 'default'/unknown
// fall back to the workspace root.
export async function projectDir(cfg, id) {
  if (!id || id === 'default' || id === 'overview') return cfg.termCwd;
  const rows = await q(cfg, 'SELECT data FROM projects WHERE id = $1', [id]);
  return rows[0] ? rows[0].data.dir : cfg.termCwd;
}

// Which project a directory belongs to (longest matching dir prefix). Used to
// file a ticket under the right project from its target directory.
export async function projectIdForDir(cfg, dir) {
  if (!dir) return 'default';
  const ps = (await loadProjects(cfg)).filter((p) => dir.startsWith(p.dir)).sort((a, b) => b.dir.length - a.dir.length);
  return ps[0] ? ps[0].id : 'default';
}
