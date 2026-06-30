#!/usr/bin/env node
// set-backup <off|hourly|daily|weekly> [retention] - configure scheduled database
// backups (writes to the settings table the in-app scheduler reads). Used by the
// setup wizard; also runnable directly. Needs WORKSPACE_DATABASE_URL reachable.
import { defaultConfig } from '../server/config.js';
import { initSchema } from '../server/db.js';
import { setBackupSettings, backupsAvailable } from '../server/backups.js';

const schedule = process.argv[2] || 'off';
const retention = Number(process.argv[3] || 7);
const cfg = defaultConfig;

try {
  await initSchema(cfg); // idempotent - ensure the settings table exists
  const out = await setBackupSettings(cfg, { schedule, retention });
  if (out.error) { console.error(out.error); process.exit(1); }
  if (out.schedule === 'off') console.log('Automatic backups: off (back up manually in Settings).');
  else {
    console.log(`Automatic backups: ${out.schedule}, keep last ${out.retention}.`);
    if (!backupsAvailable(cfg)) console.log('NOTE: no pg_dump / workspace-db container found yet - install postgresql-client or use the Docker DB so backups can run.');
  }
  process.exit(0);
} catch (e) {
  console.error(e?.message || e);
  process.exit(1);
}
