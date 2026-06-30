// Tiny, dependency-free `.env` loader. Reads `<appRoot>/.env` (KEY=VALUE per line)
// and sets any key NOT already present in process.env — so a real environment
// (systemd EnvironmentFile, shell exports, container env) always wins over the file.
// Supports `#` comments, blank lines, `export KEY=...`, and single/double quotes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let loaded = false;

/** Load `.env` from the app root once. Safe to call repeatedly. */
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = process.env.WORKSPACE_ENV_FILE || path.join(appRoot, '.env');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return; } // no .env is fine (env may be set externally)
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
