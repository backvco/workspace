// Postgres backups: pg_dump (compressed custom format) into WORKSPACE_BACKUP_DIR,
// with list / download / delete, a guarded restore, retention (keep last N), and an
// in-app scheduler (off / hourly / daily / weekly). Backups contain ALL data, so the
// routes that expose them are behind the auth gate and the files are chmod 600.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync, createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import { q } from './db.js';

// Our own filenames only - guards list/delete/download/restore against path tricks.
const NAME_RE = /^workspace-\d{8}-\d{6}\.dump$/;
const SCHEDULES = ['off', 'hourly', 'daily', 'weekly'];
const INTERVAL_MS = { hourly: 3600e3, daily: 86400e3, weekly: 604800e3 };
const DEFAULTS = { schedule: 'off', retention: 7 };

const has = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const dockerHas = (name) => { try { return execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').includes(name); } catch { return false; } };
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

function parseDbUrl(url) {
  const u = new URL(url);
  return { host: u.hostname, port: u.port || '5432', db: decodeURIComponent(u.pathname.replace(/^\//, '')), user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
}

// How to run pg_dump/pg_restore: host CLI (preferred) or `docker exec` into the
// bundled workspace-db container. Returns null if neither is available.
function runner(cfg) {
  if (!cfg.databaseUrl) return null;
  const d = parseDbUrl(cfg.databaseUrl);
  if (has('pg_dump')) return { mode: 'host', d };
  if (dockerHas('workspace-db')) return { mode: 'docker', d };
  return null;
}
export function backupsAvailable(cfg) { return !!runner(cfg); }

export function ensureDir(cfg) { mkdirSync(cfg.backupDir, { recursive: true, mode: 0o700 }); }
function info(cfg, name) { const s = statSync(path.join(cfg.backupDir, name)); return { name, size: s.size, mtime: Math.round(s.mtimeMs) }; }

export function listBackups(cfg) {
  ensureDir(cfg);
  return readdirSync(cfg.backupDir).filter((n) => NAME_RE.test(n)).map((n) => info(cfg, n)).sort((a, b) => b.mtime - a.mtime);
}
export function backupFile(cfg, name) {
  name = String(name || '');
  if (!NAME_RE.test(name)) return null;
  // Resolve and confine the path INSIDE the backup dir. The regex already blocks
  // separators/`..`, but resolve + startsWith is the explicit path-injection guard.
  const dir = path.resolve(cfg.backupDir);
  const f = path.resolve(dir, name);
  if (f !== path.join(dir, name) || !f.startsWith(dir + path.sep)) return null;
  return existsSync(f) ? f : null;
}
export function deleteBackup(cfg, name) { const f = backupFile(cfg, name); if (!f) return false; unlinkSync(f); return true; }

// --- settings (schedule + retention) in the settings table, like auth.enabled ---
export async function getBackupSettings(cfg) {
  let v = {};
  try { v = (await q(cfg, 'SELECT value FROM settings WHERE key = $1', ['backup.config']))[0]?.value || {}; } catch {}
  return { ...DEFAULTS, ...v };
}
export async function setBackupSettings(cfg, patch) {
  const next = { ...(await getBackupSettings(cfg)), ...patch };
  if (!SCHEDULES.includes(next.schedule)) return { error: 'schedule must be off, hourly, daily or weekly' };
  next.retention = Math.max(1, Math.min(365, Number(next.retention) || 7));
  await q(cfg, `INSERT INTO settings (key, value) VALUES ('backup.config', $1::jsonb)
                ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`, [JSON.stringify(next)]);
  return next;
}

async function enforceRetention(cfg) {
  const { retention } = await getBackupSettings(cfg);
  for (const b of listBackups(cfg).slice(retention)) { try { unlinkSync(path.join(cfg.backupDir, b.name)); } catch {} }
}

// Run pg_dump -> a new .dump file. Resolves with the file's info, or rejects.
export async function createBackup(cfg) {
  const r = runner(cfg);
  if (!r) throw new Error('No pg_dump available. Install postgresql-client, or run the bundled Docker Postgres.');
  ensureDir(cfg);
  const name = `workspace-${stamp()}.dump`;
  const file = path.join(cfg.backupDir, name);
  const args = ['-Fc', '--no-owner', '--no-privileges'];
  await new Promise((resolve, reject) => {
    const child = r.mode === 'host'
      ? spawn('pg_dump', [...args, '-d', cfg.databaseUrl], { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('docker', ['exec', '-e', `PGPASSWORD=${r.d.pass}`, 'workspace-db', 'pg_dump', ...args, '-U', r.d.user, '-d', r.d.db], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(file, { mode: 0o600 });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.stdout.on('error', reject); // handle errors on the SOURCE stream too
    out.on('error', reject);
    child.stdout.pipe(out);
    child.on('close', (code) => code === 0 ? resolve() : (() => { try { unlinkSync(file); } catch {} reject(new Error(err.trim() || `pg_dump exited ${code}`)); })());
  });
  await enforceRetention(cfg);
  return info(cfg, name);
}

// Guarded restore: pg_restore --clean --if-exists overwrites the live DB.
export async function restoreBackup(cfg, name) {
  const f = backupFile(cfg, name);
  if (!f) throw new Error('backup not found');
  const r = runner(cfg);
  if (!r) throw new Error('No pg_restore available.');
  const args = ['--clean', '--if-exists', '--no-owner', '--no-privileges'];
  await new Promise((resolve, reject) => {
    const child = r.mode === 'host'
      ? spawn('pg_restore', [...args, '-d', cfg.databaseUrl], { stdio: ['pipe', 'ignore', 'pipe'] })
      : spawn('docker', ['exec', '-i', '-e', `PGPASSWORD=${r.d.pass}`, 'workspace-db', 'pg_restore', ...args, '-U', r.d.user, '-d', r.d.db], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    const rs = createReadStream(f);
    rs.on('error', reject);          // source stream errors
    child.stdin.on('error', reject); // and the destination (e.g. EPIPE)
    rs.pipe(child.stdin);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.trim() || `pg_restore exited ${code}`)));
  });
  return true;
}

// --- in-app scheduler (checks every 5 min whether a backup is due) ---
let timer = null;
async function lastRun(cfg) { try { return Number((await q(cfg, 'SELECT value FROM settings WHERE key = $1', ['backup.lastRun']))[0]?.value || 0); } catch { return 0; } }
async function setLastRun(cfg, ms) { await q(cfg, `INSERT INTO settings (key, value) VALUES ('backup.lastRun', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`, [JSON.stringify(ms)]); }

export function startBackupScheduler(cfg) {
  if (timer) return;
  const tick = async () => {
    try {
      const s = await getBackupSettings(cfg);
      if (s.schedule === 'off' || !backupsAvailable(cfg)) return;
      if (Date.now() - (await lastRun(cfg)) < INTERVAL_MS[s.schedule]) return;
      await createBackup(cfg);
      await setLastRun(cfg, Date.now());
      console.log(`[backup] scheduled ${s.schedule} backup complete`);
    } catch (e) { console.error('[backup] scheduler:', e?.message || e); }
  };
  timer = setInterval(tick, 5 * 60 * 1000);
  setTimeout(tick, 15000); // also shortly after boot
}
