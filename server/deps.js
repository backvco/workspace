// First-run dependency check: verify the external tools and the database the app
// relies on are actually present, and print a clear pass/fail report at boot. We report
// rather than auto-install — installing needs sudo and differs per OS/distro.
import { accessSync, existsSync, statSync, constants } from 'node:fs';
import path from 'node:path';
import { q } from './db.js';

// Is an executable named `name` reachable? Absolute/relative paths are checked
// directly; bare names are looked up on PATH.
function hasBin(name) {
  if (!name) return false;
  if (name.includes('/')) {
    try { accessSync(name, constants.X_OK); return true; } catch { return false; }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { accessSync(path.join(dir, name), constants.X_OK); return true; } catch {}
  }
  return false;
}

// Returns { lines, hardMissing } — printable report + the list of missing REQUIRED
// dependencies (a non-empty list should abort boot).
export async function checkDependencies(cfg) {
  const lines = [];
  const hardMissing = [];

  const bins = [
    { label: 'tmux', bin: 'tmux', required: true, hint: 'install tmux (e.g. `sudo apt install tmux`)' },
    { label: 'git', bin: 'git', required: true, hint: 'install git (e.g. `sudo apt install git`)' },
    { label: `agent CLI (${cfg.claudeBin})`, bin: cfg.claudeBin, required: true,
      hint: 'install Claude Code: `npm install -g @anthropic-ai/claude-code` (or set WORKSPACE_CLAUDE_BIN to your agent CLI)' }
  ];
  for (const b of bins) {
    const ok = hasBin(b.bin);
    lines.push(`  ${ok ? '[ok]' : '[--]'} ${b.label}${ok ? '' : `  — ${b.hint}`}`);
    if (!ok && b.required) hardMissing.push(b.label);
  }

  // Configured project roots must exist (terminals open there, repos are scanned
  // there). A missing root means terminals/file ops would fail with cryptic errors.
  for (const root of (cfg.projectRoots || [])) {
    let ok = false;
    try { ok = existsSync(root) && statSync(root).isDirectory(); } catch {}
    lines.push(`  ${ok ? '[ok]' : '[--]'} project root ${root}${ok ? '' : '  — does not exist; create it (mkdir -p) or fix WORKSPACE_PROJECT_ROOTS'}`);
    if (!ok) hardMissing.push(`project root ${root}`);
  }

  // Postgres reachability (the app stores all structured state here).
  let dbOk = false, dbErr = '';
  try { await q(cfg, 'SELECT 1'); dbOk = true; } catch (e) { dbErr = e.message; }
  lines.push(`  ${dbOk ? '[ok]' : '[--]'} Postgres connection${dbOk ? '' : `  — ${dbErr}; check WORKSPACE_DATABASE_URL and that Postgres is running`}`);
  if (!dbOk) hardMissing.push('Postgres');

  return { lines, hardMissing };
}
