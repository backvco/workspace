#!/usr/bin/env node
// db-ping - test a Postgres connection. Used by the setup wizard to validate a
// connection string before saving it. Lives in server/ so it resolves the API's
// `pg` dependency. Exit 0 = reachable, 1 = failed (prints the reason), 2 = no URL.
import pg from 'pg';

const url = process.argv[2] || process.env.WORKSPACE_DATABASE_URL || '';
if (!url) { console.error('no connection URL given'); process.exit(2); }

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 6000 });
try {
  await client.connect();
  await client.query('SELECT 1');
  process.exit(0);
} catch (e) {
  console.error(`  ${e?.message || e}`);
  process.exit(1);
} finally {
  try { await client.end(); } catch {}
}
