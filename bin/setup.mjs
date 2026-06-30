#!/usr/bin/env node
// Workspace setup wizard. Invoked by install.sh AFTER the bash bootstrap (git +
// Node 22 + clone + npm install). Handles all interactive configuration and
// orchestrates the privileged bash helpers in bin/. No external dependencies.
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { resolveNs } from 'node:dns/promises';
import { ReadStream } from 'node:tty';
import {
  existsSync, readFileSync, writeFileSync, copyFileSync, createReadStream, openSync, mkdirSync
} from 'node:fs';

const RAW = 'https://raw.githubusercontent.com/backvco/workspace/master';
const C = { b: '\x1b[1m', dim: '\x1b[2m', blue: '\x1b[1;34m', red: '\x1b[1;31m', off: '\x1b[0m' };
const say = (s) => console.log(`\n${C.b}${s}${C.off}`);

// Guess the DNS provider from the domain's nameservers, to preselect the menu.
async function recommendProvider(domain) {
  try {
    const zone = domain.split('.').slice(-2).join('.');
    const ns = (await resolveNs(zone)).join(' ').toLowerCase();
    if (ns.includes('cloudflare')) return 'cloudflare';
    if (ns.includes('awsdns')) return 'route53';
    if (ns.includes('googledomains') || ns.includes('ns-cloud') || ns.includes('google')) return 'google';
    if (ns.includes('digitalocean')) return 'digitalocean';
  } catch { /* lookup failed - fall through */ }
  return 'cloudflare';
}

// Free-text prompt. Opens /dev/tty fresh per question (works under curl | bash).
const ask = (q, def = '') => new Promise((res) => {
  if (!existsSync('/dev/tty')) return res(def);
  const input = createReadStream('/dev/tty');
  const r = createInterface({ input, output: process.stdout });
  r.question(q, (a) => { r.close(); input.destroy(); res(((a || '').trim()) || def); });
});

// Arrow-key menu. items: [{value,label}] or [string]. Returns the chosen value.
// Up/Down (or j/k) to move, 1-9 to jump, Enter to pick. Falls back to the default
// when there's no TTY. Restores the terminal before returning (so child scripts run clean).
function menu(title, items, def = 0) {
  const opts = items.map((it) => (typeof it === 'string' ? { value: it, label: it } : it));
  return new Promise((resolve) => {
    let input, fd;
    try { fd = openSync('/dev/tty', 'r'); input = new ReadStream(fd); } catch { return resolve(opts[def].value); }
    if (!input.isTTY) { try { input.destroy(); } catch {} return resolve(opts[def].value); }
    let idx = Math.max(0, Math.min(def, opts.length - 1));
    const out = process.stdout;
    out.write(`\n${C.b}${title}${C.off}\n`);
    const draw = (first) => {
      if (!first) out.write(`\x1b[${opts.length}A`);
      opts.forEach((o, i) => {
        out.write('\x1b[2K');
        out.write(i === idx ? `${C.blue}> ${o.label}${C.off}\n` : `  ${C.dim}${o.label}${C.off}\n`);
      });
    };
    draw(true);
    input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    const finish = (val, label) => {
      try { input.setRawMode(false); input.pause(); input.destroy(); } catch {}
      out.write(`${C.dim}  selected: ${label}${C.off}\n`);
      resolve(val);
    };
    input.on('data', (k) => {
      if (k === '\x1b[A' || k === '\x1bOA' || k === 'k') { idx = (idx - 1 + opts.length) % opts.length; draw(); }
      else if (k === '\x1b[B' || k === '\x1bOB' || k === 'j') { idx = (idx + 1) % opts.length; draw(); }
      else if (k === '\r' || k === '\n') finish(opts[idx].value, opts[idx].label);
      else if (k === '\x03') { try { input.setRawMode(false); input.destroy(); } catch {} process.exit(130); }
      else if (/^[1-9]$/.test(k) && Number(k) <= opts.length) { idx = Number(k) - 1; draw(); finish(opts[idx].value, opts[idx].label); }
    });
  });
}
const yesno = (title, defYes = true) =>
  menu(title, [{ value: true, label: 'Yes' }, { value: false, label: 'No' }], defYes ? 0 : 1);

// Run a command with inherited stdio (its own prompts/output go to the terminal).
const run = (cmd, args = []) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;

// Is the provider's CLI installed AND authenticated on THIS machine? (Used to
// default the this/other-machine prompt.) Token providers need no CLI here.
function cliReady(prov) {
  if (prov === 'route53') return has('aws') && spawnSync('aws', ['sts', 'get-caller-identity'], { stdio: 'ignore' }).status === 0;
  if (prov === 'google') return has('gcloud') &&
    spawnSync('sh', ['-c', "gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q ."], { stdio: 'ignore' }).status === 0;
  return true;
}

function banner() {
  process.stdout.write(C.blue +
`   __        __
   \\ \\      / /
    \\ \\ /\\ / /
     \\ V  V /
      \\_/\\_/  ai
` + C.off + C.dim + '   Workspace AI  -  setup\n' + C.off);
}

// Print a command in a clearly copy-able block.
function copyBlock(heading, cmd) {
  const bar = '-'.repeat(Math.min(78, Math.max(cmd.length + 2, heading.length)));
  console.log(`\n${C.b}${heading}${C.off}`);
  console.log(C.dim + bar + C.off);
  console.log(cmd);
  console.log(C.dim + bar + C.off + '\n');
}

// The code-server upstream chosen by bin/setup-code-server (free port / reused
// instance), recorded in .code-server-upstream. Falls back to the historical default.
const codeUpstream = () =>
  (existsSync('.code-server-upstream') ? readFileSync('.code-server-upstream', 'utf8').trim() : '') || '127.0.0.1:8080';

// Bind-test a port on 127.0.0.1 (where the app binds). Resolves:
//   'ok'        - free + bindable
//   'in-use'    - something is already listening (EADDRINUSE)
//   'protected' - privileged/system-protected; needs root (EACCES, e.g. <1024)
//   'bad'       - invalid / otherwise unusable
function portStatus(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? 'in-use' : e.code === 'EACCES' ? 'protected' : 'bad'));
    srv.once('listening', () => srv.close(() => resolve('ok')));
    try { srv.listen(port, '127.0.0.1'); } catch { resolve('bad'); }
  });
}
// First free+usable port at/after `start` (to suggest a conflict-free default).
async function firstFree(start) {
  for (let p = start; p < start + 50; p++) if ((await portStatus(p)) === 'ok') return p;
  return start;
}
// Suggest a free default, let the user override, and validate their choice is
// actually free + usable - re-prompting with the reason until it is.
async function pickPort(label, preferred) {
  const def = await firstFree(preferred);
  if (def !== preferred) console.log(`${C.dim}  (default ${preferred} is busy; suggesting ${def})${C.off}`);
  for (;;) {
    const port = Number((await ask(`${label} port [${def}]: `, String(def))).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) { console.log('  Enter a port number between 1 and 65535.'); continue; }
    const st = await portStatus(port);
    if (st === 'ok') return String(port);
    console.log(st === 'in-use' ? `  Port ${port} is already in use - choose another.`
      : st === 'protected' ? `  Port ${port} is privileged/protected (needs root) - choose a port >= 1024.`
      : `  Port ${port} isn't usable - choose another.`);
  }
}

// Replace KEY= line (commented or not) in .env, or append it.
function setEnv(key, val) {
  let txt = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  const re = new RegExp(`^[# ]*${key}=.*$`, 'm');
  if (re.test(txt)) txt = txt.replace(re, `${key}=${val}`);
  else txt += (txt.endsWith('\n') || txt === '' ? '' : '\n') + `${key}=${val}\n`;
  writeFileSync('.env', txt);
}

// Prominent up-front warning: reaching + signing into this app = a shell on the box.
function securityWarning() {
  const line = '='.repeat(74);
  console.log(`\n${C.red}${line}`);
  console.log('  SECURITY WARNING - this grants TERMINAL / SHELL ACCESS to this server');
  console.log(`${line}${C.off}`);
  console.log('  Workspace lets anyone who can reach it AND sign in run commands, edit');
  console.log('  files, and open a terminal on this machine - the same as giving them SSH.');
  console.log(`  ${C.b}Treat access to this app as full control of this server.${C.off}`);
  console.log('');
  console.log(`  ${C.b}Before exposing it:${C.off}`);
  console.log('    - ENABLE AUTH (this wizard sets it up by default for remote setups),');
  console.log('    - keep it on a private mesh or behind your reverse proxy + IP allowlist,');
  console.log('    - only create accounts for people you trust with this server.');
  console.log(`${C.red}${line}${C.off}`);
}

async function main() {
  banner();
  securityWarning();
  if (!await yesno('I understand this gives terminal access to this server - continue?', true)) {
    console.log('\nAborted - nothing was changed.');
    process.exit(0);
  }

  say('Installing system tools (tmux, git, build toolchain)...');
  run('./bin/install-deps');

  // The API is its own package (server/) with a native module (node-pty). Install
  // its deps now that the build toolchain is present - needed for both local and
  // service runs, so do it regardless of how the app is started later.
  if (!existsSync('server/node_modules/express')) {
    say('Installing server (API) dependencies...');
    spawnSync('npm', ['install'], { stdio: 'inherit', cwd: 'server' }); // cwd, not --prefix
    if (!existsSync('server/node_modules/express'))
      console.log('WARNING: server deps did not install (node-pty build?). On macOS run: xcode-select --install, then (cd server && npm install).');
  }

  if (!has('claude')) {
    say('Installing Claude Code (agent CLI)...');
    if (!run('npm', ['install', '-g', '@anthropic-ai/claude-code']))
      run('sudo', ['npm', 'install', '-g', '@anthropic-ai/claude-code']);
  }

  // Ensure .env exists early so the DB step can write WORKSPACE_DATABASE_URL into it.
  if (!existsSync('.env')) copyFileSync('.env.example', '.env');

  // --- Postgres ---
  const dbChoice = await menu('Database', [
    { value: 'docker', label: 'Run Postgres in Docker now (recommended)' },
    { value: 'existing', label: 'Connect to an existing Postgres (I have connection details)' },
    { value: 'skip', label: "Skip - I'll set WORKSPACE_DATABASE_URL myself later" }], 0);
  if (dbChoice === 'docker') {
    // Custom host port in case 5432 is taken (e.g. another Postgres on this box).
    const port = await ask('Host port to publish Postgres on [5432]: ', '5432');
    run('./bin/install-deps', ['--docker-postgres', port]); // writes the URL to .env
  } else if (dbChoice === 'existing') {
    // Prompt for a connection URL, TEST it, and let the user retry on failure.
    for (;;) {
      const url = await ask('Postgres URL  postgres://user:pass@host:port/dbname : ', '');
      if (!url) { if (await yesno('No URL entered. Try again?', true)) continue; break; }
      say('Testing the connection...');
      if (run('node', ['server/db-ping.mjs', url])) {
        setEnv('WORKSPACE_DATABASE_URL', url);
        console.log('Connected - WORKSPACE_DATABASE_URL saved to .env.');
        break;
      }
      if (!await yesno('Connection failed (reason above). Try again?', true)) break;
    }
  }

  // --- .env (project roots + session key) ---
  say('Writing .env');
  const home = process.env.HOME || '/root';
  const roots = await ask(`Project root directory to work under [${home}]: `, home);
  for (let d of roots.split(',')) {
    d = d.trim();
    if (!d || existsSync(d)) continue;
    say(`Creating project root ${d}`);
    try { mkdirSync(d, { recursive: true }); }
    catch { if (run('sudo', ['mkdir', '-p', d])) run('sudo', ['chown', `${process.env.USER || 'root'}:`, d]); }
  }
  // WORKSPACE_DATABASE_URL is written by install-deps (Docker) or left for the user
  // to set (Skip). Don't overwrite it here.
  setEnv('WORKSPACE_PROJECT_ROOTS', roots);
  if (!/^WORKSPACE_SESSION_KEY=.+/m.test(readFileSync('.env', 'utf8')))
    setEnv('WORKSPACE_SESSION_KEY', randomBytes(32).toString('hex'));

  // --- Database backups --- (needs a reachable DB, so only when we set one up)
  if (dbChoice !== 'skip') {
    const bdir = await ask('Backup directory [blank = data/backups]: ', '');
    if (bdir) setEnv('WORKSPACE_BACKUP_DIR', bdir);
    const sched = await menu('Automatic database backups (manage anytime in Settings -> Backups)', [
      { value: 'daily', label: 'Daily (recommended)' },
      { value: 'weekly', label: 'Weekly' },
      { value: 'hourly', label: 'Hourly' },
      { value: 'off', label: 'Off - back up manually' }], 0);
    run('node', ['bin/set-backup.mjs', sched]);
  }

  // --- Ports --- (the app binds these on 127.0.0.1; the reverse proxy sits in front).
  // We suggest a free default, then validate the operator's choice is free + usable.
  say('Ports (bound on 127.0.0.1; your reverse proxy / dev server sits in front)');
  const apiPort = await pickPort('API (workspace-api)', 5301);
  const uiPort = await pickPort('UI production build (workspace-ui)', 3000);
  process.env.WORKSPACE_PORT = apiPort;   // so child scripts (setup-tls) use it too
  setEnv('WORKSPACE_PORT', apiPort);
  setEnv('WORKSPACE_UI_PORT', uiPort);    // record for doctor + setup-service

  // --- access: local vs remote ---
  let domain = '', svc = false, httpsPort = '443', tlsOk = true, tlsKind = '', tlsProv = '', authOn = false;
  const access = await menu('How will you reach Workspace?', [
    { value: 'remote', label: 'Remote - from your iPhone/iPad & other devices (private mesh + HTTPS)' },
    { value: 'local', label: 'Local only - this machine at http://localhost (no iPhone/iPad access)' }], 0);

  if (access === 'remote') {
    // mesh - detect an installed/connected client and preselect it (connected wins).
    const tsConn = has('tailscale') && spawnSync('tailscale', ['ip', '-4'], { stdio: 'ignore' }).status === 0;
    const nbConn = has('netbird') && spawnSync('sh', ['-c', 'netbird status 2>/dev/null | grep -qi "netbird ip"'], { stdio: 'ignore' }).status === 0;
    const tsTag = tsConn ? ' (connected)' : has('tailscale') ? ' (installed)' : '';
    const nbTag = nbConn ? ' (connected)' : has('netbird') ? ' (installed)' : '';
    let mdef = 0;
    if (nbConn) mdef = 2; else if (tsConn) mdef = 1;
    else if (has('netbird')) mdef = 2; else if (has('tailscale')) mdef = 1;
    const meshKind = await menu('Private mesh (reach this server with no public ports)', [
      { value: 'skip', label: 'Skip - I have my own networking / public domain' },
      { value: 'tailscale', label: `Tailscale${tsTag}` },
      { value: 'netbird', label: `NetBird (self-hosted supported)${nbTag}` }], mdef);
    if (meshKind === 'tailscale') run('./bin/setup-mesh', ['tailscale']);
    else if (meshKind === 'netbird') run('./bin/setup-mesh', ['netbird']);

    // 'tailscale serve' HTTPS only makes sense when Tailscale is the active mesh.
    const tsAvailable = meshKind === 'tailscale' ||
      (has('tailscale') && spawnSync('tailscale', ['ip', '-4'], { stdio: 'ignore' }).status === 0);

    // Reverse proxy + HTTPS. Two families: "set it up for me" (managed Caddy) vs
    // "I'll run my own proxy + SSL" (we just build the app + show the ports).
    const tlsItems = [];
    if (tsAvailable) tlsItems.push({ value: 'tailscale', label: 'Tailscale serve - HTTPS on your tailnet, nothing public, no domain needed' });
    tlsItems.push({ value: 'dns', label: "Set it up for me: Let's Encrypt via DNS-01 (your domain, no public ports)" });
    tlsItems.push({ value: 'caddy', label: "Set it up for me: Let's Encrypt via HTTP-01 (needs public 80/443)" });
    tlsItems.push({ value: 'self', label: "I'll run my OWN reverse proxy + SSL - just install the app + show me the ports" });
    tlsItems.push({ value: 'nginx', label: 'I use nginx - print a server block to add (then certbot)' });
    tlsItems.push({ value: 'skip', label: 'Skip - localhost only / decide later' });
    const tls = await menu('Reverse proxy + HTTPS (clipboard/paste/PWA need HTTPS off localhost)', tlsItems, 0);
    tlsKind = tls;

    if (tls === 'tailscale') {
      run('sudo', ['tailscale', 'serve', '--bg', '5300']);
      say('Serving on your tailnet over HTTPS.');
    } else if (tls === 'dns' || tls === 'caddy') {
      domain = await ask('Domain: ', '');
      if (domain) {
        const port = await ask('HTTPS port [443] (a custom port has no :80 redirect): ', '443');
        httpsPort = port;
        const allow = await ask('Restrict to IPs/subnets? (comma-separated CIDRs, blank = open): ', '');
        say('Building the production UI...'); run('npm', ['run', 'build']);
        setEnv('WORKSPACE_PUBLIC_HOST', domain);
        setEnv('WORKSPACE_PUBLIC_URL', `https://${domain}${port !== '443' ? ':' + port : ''}`);
        const extra = [...(port !== '443' ? ['--port', port] : []), ...(allow ? ['--allow', allow] : [])];
        // Optional embedded VS Code (code-server), served same-origin at /code and
        // gated by THIS app's login via the proxy's forward_auth.
        if (await yesno('Embed VS Code (code-server) in a tab, gated by your app login?', true)) {
          if (run('./bin/setup-code-server')) { // picks a free port / reuses an existing one
            setEnv('WORKSPACE_CODE_SERVER_URL', '/code');
            extra.push('--code-server', codeUpstream());
            console.log('NOTE: /code is a full editor + terminal, only protected once you ENABLE AUTH in Settings.');
          }
        }
        if (tls === 'dns') {
          const rec = await recommendProvider(domain);
          const provs = ['cloudflare', 'route53', 'google', 'digitalocean'];
          const prov = await menu(`DNS provider (auto-detected from nameservers: ${rec})`,
            provs.map((p) => ({ value: p, label: p === rec ? `${p}  (recommended)` : p })), provs.indexOf(rec));
          tlsProv = prov;
          // Reuse an existing credential from a prior install if it still works;
          // if one exists but is broken, offer to replace it.
          const v = spawnSync('./bin/dns-credentials', ['verify', prov], { stdio: 'ignore' }).status;
          let create = true;
          if (v === 0) create = !(await yesno(`A working ${prov} DNS credential is already configured here. Reuse it?`, true));
          else if (v === 2) create = await yesno(`A ${prov} DNS credential exists but FAILED validation. Replace it?`, true);

          if (create) {
            // Default this/other based on whether the provider CLI is ready right here.
            const ready = cliReady(prov);
            const where = await menu('Where is the provider CLI authenticated?', [
              { value: 'this', label: `This machine - create the credential here now${ready ? '' : '  (CLI not detected here)'}` },
              { value: 'other', label: 'Another machine - print a command, paste the result back' }], ready ? 0 : 1);
            if (where === 'other') {
              copyBlock(`COPY this and run it where the ${prov} CLI is logged in:`,
                `curl -fsSL ${RAW}/bin/dns-credentials -o dns-cred.sh && bash dns-cred.sh ${prov} ${domain} --export`);
              console.log('Then paste the blob it prints below:');
              run('./bin/dns-credentials', ['import']);
            } else {
              run('./bin/dns-credentials', [prov, domain]);
            }
          }
          tlsOk = run('./bin/setup-tls', [domain, uiPort, '--dns', prov, ...extra]);
        } else {
          tlsOk = run('./bin/setup-tls', [domain, uiPort, ...extra]);
        }
      }
    } else if (tls === 'self' || tls === 'nginx') {
      // We build the app + install the services; the operator runs their own proxy/TLS.
      domain = await ask('Public domain (so the app trusts the origin; blank to skip): ', '');
      if (domain) { setEnv('WORKSPACE_PUBLIC_HOST', domain); setEnv('WORKSPACE_PUBLIC_URL', `https://${domain}`); }
      say('Building the production UI...'); run('npm', ['run', 'build']);
      if (tls === 'nginx') {
        say(`Add this nginx server block, then run: sudo certbot --nginx -d ${domain || '<your-domain>'}`);
        run('./bin/print-proxy', ['nginx', domain || 'your.domain', uiPort, '']);
      } else {
        say('Run your own reverse proxy in front of these (terminate TLS there):');
        console.log(`  /api/* and /ws/*  ->  127.0.0.1:${apiPort}   (the API)`);
        console.log(`  everything else   ->  127.0.0.1:${uiPort}   (the UI production build)`);
        console.log('\nReference config (Caddy):');
        run('./bin/print-proxy', ['caddy', domain || 'your.domain', uiPort, '']);
        if (await yesno('Also install code-server (VS Code)?', true)) {
          if (run('./bin/setup-code-server')) {
            const up = codeUpstream();
            setEnv('WORKSPACE_CODE_SERVER_URL', '/code');
            console.log('\nAdd a gated /code route to YOUR proxy so VS Code shares the app login. Caddy:');
            console.log('  handle_path /code/* {');
            console.log(`    forward_auth 127.0.0.1:${apiPort} { uri /api/auth/check }`);
            console.log(`    reverse_proxy ${up}`);
            console.log('  }');
          }
        }
      }
    }

    // A managed-TLS failure: stop here so the error stays on screen (not buried).
    if (domain && !tlsOk) {
      const retry = `./bin/setup-tls ${domain} ${uiPort}${tlsKind === 'dns' ? ` --dns ${tlsProv}` : ''}${httpsPort !== '443' ? ` --port ${httpsPort}` : ''}`;
      say('TLS setup did NOT complete - see the error just above.');
      console.log(`Fix it, then retry just this step (the error will be the last thing printed):\n  ${retry}`);
      console.log(process.platform === 'darwin'
        ? `More detail:  tail -50 ${process.env.HOME}/Library/Logs/Workspace/caddy.log`
        : 'More detail:  journalctl -u caddy -n 50 --no-pager');
      return;
    }
    // Boot services for any non-skip path (independent of who manages TLS).
    // bin/setup-service itself picks systemd vs a macOS LaunchDaemon.
    const canService = has('systemctl') || process.platform === 'darwin';
    const svcKind = process.platform === 'darwin' ? 'LaunchDaemon' : 'systemd';
    if (tls !== 'skip' && tls !== 'tailscale' && canService &&
        await yesno(`Install + start ${svcKind} services (API :${apiPort} + UI :${uiPort}) on boot?`, true))
      svc = run('./bin/setup-service', [uiPort]);

    // This server is now reachable remotely. Auth is OFF by default, which means
    // anyone who can reach it has full access - so require a login by default.
    if (tls !== 'skip') {
      if (await yesno('Require a login to reach Workspace (recommended) - create your user now?', true)) {
        if (run('node', ['bin/enable-auth.mjs'])) authOn = true;
        else console.log('Could not enable auth now - run "node bin/enable-auth.mjs" (or enable it in Settings) before exposing the server.');
      } else {
        console.log('WARNING: auth is OFF - anyone who can reach this server has full shell access.');
      }
    }
  }

  // --- done --- (a managed-TLS failure already returned above with its error)
  const url = domain ? `https://${domain}${httpsPort !== '443' ? ':' + httpsPort : ''}` : '';
  const selfProxy = tlsKind === 'self' || tlsKind === 'nginx';
  say('Setup complete');
  if (svc && selfProxy) console.log(`Running as ${svcKind} services: API on 127.0.0.1:${apiPort}, UI on 127.0.0.1:${uiPort}.\nPoint your reverse proxy at them${domain ? ` and open ${url}` : ''}.`);
  else if (svc) console.log(`Running as ${svcKind} services behind your reverse proxy. Open  ${url}`);
  else if (domain) console.log(`Run the production build behind your proxy:\n  node server/index.js              # API :${apiPort}\n  PORT=${uiPort} node build         # UI  :${uiPort}\nThen open  ${url}`);
  else console.log(`Start it in two terminals:\n  1) node server/index.js     # API :${apiPort}\n  2) npm run dev              # UI  :5300 (vite)\nThen open  http://localhost:5300`);
  console.log("\nLog in to the agent CLI before starting (required):  claude");
  if (authOn) console.log(`${C.b}Auth is ON${C.off} - a login is required. Manage users in Settings.`);
  else {
    console.log(`${C.b}IMPORTANT: auth is OFF${C.off} - anyone who can reach this server has full shell access.`);
    console.log('Before exposing it, require a login:  node bin/enable-auth.mjs   (or enable it in Settings).');
  }

  // Health check: shows exactly what's up and what to start/fix. (Not-yet-started
  // services will show as fixes to run - that doubles as your start instructions.)
  console.log('');
  run('./bin/doctor');
  console.log('\nRe-run the health check anytime with:  ./bin/doctor');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.message || e); process.exit(1); });
