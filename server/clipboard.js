// Clipboard store: list / serve / prune the pasted images that POST /paste writes
// under each workspace's clipboardDir. Files are named `paste-<ms>.<ext>`.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const NAME_RE = /^paste-\d+\.[a-z0-9]+$/i;
const EXT_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// One workspace's clipboard items, newest first, plus the total byte size.
export function listClipboard(cfg, wsId) {
  const dir = cfg.clipboardDir(wsId);
  let names = [];
  try { names = readdirSync(dir); } catch { return { items: [], totalBytes: 0 }; }
  const items = [];
  let totalBytes = 0;
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    let st;
    try { st = statSync(path.join(dir, name)); } catch { continue; }
    if (!st.isFile()) continue;
    const ext = name.split('.').pop().toLowerCase();
    items.push({ name, size: st.size, mtime: st.mtimeMs, ext, type: EXT_TYPE[ext] || 'application/octet-stream' });
    totalBytes += st.size;
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return { items, totalBytes };
}

// Resolve a clipboard file name to its absolute path, confined to the workspace's
// clipboard dir (rejects traversal / unexpected names). Returns null if invalid.
export function clipboardFilePath(cfg, wsId, name) {
  if (!NAME_RE.test(String(name || ''))) return null;
  const dir = cfg.clipboardDir(wsId);
  const file = path.resolve(dir, name);
  if (file !== path.join(dir, name)) return null; // no traversal past the dir
  return file;
}

// Delete items: { all:true } wipes everything, otherwise olderThanMs drops items
// whose mtime is older than (now - olderThanMs). Returns count + bytes freed.
export function pruneClipboard(cfg, wsId, { all = false, olderThanMs = null } = {}) {
  const dir = cfg.clipboardDir(wsId);
  const { items } = listClipboard(cfg, wsId);
  const cutoff = olderThanMs != null ? Date.now() - Number(olderThanMs) : null;
  let removed = 0, freedBytes = 0;
  for (const it of items) {
    if (!all && (cutoff == null || it.mtime >= cutoff)) continue;
    try { unlinkSync(path.join(dir, it.name)); removed++; freedBytes += it.size; } catch {}
  }
  return { removed, freedBytes };
}
