// Postgres storage. One pool, a tiny schema, and a row-locked update helper so
// concurrent agent events can't clobber each other. Structured app state lives
// here (projects, tabs, agents, events); blobs stay on disk.
import pg from 'pg';

let pool;
export function getPool(cfg) {
  if (!pool) {
    if (!cfg.databaseUrl) throw new Error('WORKSPACE_DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 20, connectionTimeoutMillis: 10000 });
  }
  return pool;
}

/** @param {any} cfg @param {string} text @param {any[]} [params] */
export async function q(cfg, text, params = []) {
  return (await getPool(cfg).query(text, params)).rows;
}

// Run fn inside a transaction on a single dedicated client (BEGIN/COMMIT, ROLLBACK
// on throw). Use for multi-statement atomic work (e.g. lock a row + write an event).
/** @param {any} cfg @param {(client:any)=>Promise<any>} fn */
export async function withTx(cfg, fn) {
  const client = await getPool(cfg).connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Run a mutation against one row under a transaction + FOR UPDATE lock — the
// read-modify-write is serialized, so parallel writers don't lose updates.
/** @param {any} cfg @param {string} table @param {string} id @param {(data:any)=>void} mutate */
export async function lockedUpdate(cfg, table, id, mutate) {
  const client = await getPool(cfg).connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT data FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!r.rows[0]) { await client.query('ROLLBACK'); return false; }
    const data = r.rows[0].data;
    mutate(data);
    data.updatedAt = Date.now();
    await client.query(`UPDATE ${table} SET data = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(data), id]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function initSchema(cfg) {
  await q(cfg, `CREATE TABLE IF NOT EXISTS projects (
    id text PRIMARY KEY, data jsonb NOT NULL, ord bigserial)`);
  await q(cfg, `CREATE TABLE IF NOT EXISTS tabs (
    workspace_id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`);
  await q(cfg, `CREATE TABLE IF NOT EXISTS agent_tasks (
    id text PRIMARY KEY, data jsonb NOT NULL,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
  await q(cfg, `CREATE TABLE IF NOT EXISTS agent_events (
    id bigserial PRIMARY KEY, task_id text, event text, message text, at timestamptz DEFAULT now())`);
  await q(cfg, `CREATE INDEX IF NOT EXISTS agent_events_task ON agent_events (task_id, at)`);
  await q(cfg, `CREATE TABLE IF NOT EXISTS agent_templates (
    id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz DEFAULT now())`);
  await q(cfg, `CREATE TABLE IF NOT EXISTS planners (
    id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz DEFAULT now())`);
  // Optional auth: accounts + a tiny key/value settings store (auth.enabled, …).
  await q(cfg, `CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz DEFAULT now())`);
  await q(cfg, `CREATE TABLE IF NOT EXISTS settings (
    key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now())`);
  // WebAuthn / passkeys: short-lived registration & login challenges. Rows are
  // single-use (deleted on verify) and expire after a few minutes (see passkeys.js).
  // user_id is null for the pre-session login flow (discoverable credentials).
  await q(cfg, `CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id text PRIMARY KEY, user_id text, kind text NOT NULL,
    challenge text NOT NULL, created_at timestamptz DEFAULT now())`);
}
