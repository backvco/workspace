// Filesystem access for the Files tool, hard-guarded to the configured project
// roots so nothing outside them can be read or written.
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_READ = 2 * 1024 * 1024; // 2 MB

// Resolve `p` and confirm it sits inside a configured project root, defeating
// `..` traversal. Throws otherwise. Exported so route handlers (e.g. git) can
// confine client-supplied paths to the same roots.
export function ensureWithin(cfg, p) {
  const rp = path.resolve(String(p ?? ''));
  const ok = cfg.projectRoots.some((r) => {
    const root = path.resolve(r);
    return rp === root || rp.startsWith(root + path.sep);
  });
  if (!ok) throw new Error('path outside allowed roots');
  return rp;
}
// Boolean form for guard clauses.
export function withinRoots(cfg, p) {
  try { ensureWithin(cfg, p); return true; } catch { return false; }
}

export function list(cfg, p) {
  const dir = ensureWithin(cfg, p);
  const entries = readdirSync(dir).map((name) => {
    const fp = path.join(dir, name);
    let isDir = false, size = 0;
    try { const st = statSync(fp); isDir = st.isDirectory(); size = st.size; } catch {}
    return { name, path: fp, isDir, size };
  });
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  return { path: dir, entries };
}

export function read(cfg, p) {
  const fp = ensureWithin(cfg, p);
  const st = statSync(fp);
  if (st.isDirectory()) throw new Error('is a directory');
  if (st.size > MAX_READ) throw new Error('file too large to edit (>2MB)');
  const buf = readFileSync(fp);
  if (buf.includes(0)) throw new Error('binary file');
  return buf.toString('utf8');
}

export function write(cfg, p, content) {
  const fp = ensureWithin(cfg, p);
  writeFileSync(fp, content ?? '');
  return fp;
}
