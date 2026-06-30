#!/usr/bin/env node
// enable-auth - create the first user and turn auth ON (writes to the DB), so the
// server requires a login. The wizard runs this for remote/exposed setups; you can
// also run it directly:  node bin/enable-auth.mjs [username]
import { openSync, existsSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import { defaultConfig } from '../server/config.js';
import { initSchema } from '../server/db.js';
import { createUser, setAuthEnabled } from '../server/auth.js';

const cfg = defaultConfig;

// Prompt on /dev/tty (works under `curl | bash`); hidden = don't echo (passwords).
function prompt(q, hidden = false) {
  return new Promise((resolve) => {
    if (!existsSync('/dev/tty')) return resolve('');
    let input;
    try { input = new ReadStream(openSync('/dev/tty', 'r')); } catch { return resolve(''); }
    if (!input.isTTY) { try { input.destroy(); } catch {} return resolve(''); }
    process.stdout.write(q);
    let buf = '';
    input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    input.on('data', (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          try { input.setRawMode(false); input.pause(); input.destroy(); } catch {}
          process.stdout.write('\n'); return resolve(buf);
        } else if (c === '\x7f' || c === '\b') { if (buf) { buf = buf.slice(0, -1); if (!hidden) process.stdout.write('\b \b'); } }
        else if (c === '\x03') { process.stdout.write('\n'); process.exit(130); }
        else { buf += c; if (!hidden) process.stdout.write(c); }
      }
    });
  });
}

async function main() {
  if (!cfg.sessionKey) {
    console.error('WORKSPACE_SESSION_KEY is not set in .env - it signs sessions, so auth cannot be enabled.');
    process.exit(1);
  }
  await initSchema(cfg); // idempotent - make sure users/settings tables exist

  const username = (process.argv[2] || (await prompt('Choose a username: '))).trim();
  if (!username) { console.error('No username given.'); process.exit(1); }

  let password = '';
  for (;;) {
    password = await prompt('Choose a password (min 8 chars): ', true);
    if (password.length >= 8) break;
    console.log('  too short - try again.');
  }
  if ((await prompt('Confirm password: ', true)) !== password) { console.error('Passwords did not match.'); process.exit(1); }

  const made = await createUser(cfg, username, password);
  if (made?.error) { console.error(`Could not create user: ${made.error}`); process.exit(1); }
  const en = await setAuthEnabled(cfg, true);
  if (en?.error) { console.error(`Could not enable auth: ${en.error}`); process.exit(1); }

  console.log(`\nAuth is ENABLED. Sign in as "${username}". Manage users + auth anytime in Settings.`);
  process.exit(0);
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
