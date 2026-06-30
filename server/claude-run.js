// Shared headless-`claude -p` runner with a LIVENESS timeout instead of a fixed
// deadline. The recurring problem with fixed wall-clock timeouts: too short kills
// legitimate long work (a big review/verify), too long lets a truly-hung run waste
// minutes — and any single value is a guess. Instead we run with
// `--output-format stream-json --verbose` (claude emits an event per step) and kill
// ONLY when it produces no output for `idleMs` (genuinely stuck). A long-but-
// progressing run never gets cut off; `capMs` is just a generous backstop against a
// pathological loop. The final `result` event carries the same fields as
// `--output-format json` (result text, is_error, subtype).
import { spawn } from 'node:child_process';

/**
 * @param {string} cmd full shell command; MUST use `--output-format stream-json --verbose`
 * @param {{idleMs?:number, capMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, result:string|null, isError:boolean, subtype:string, killed:''|'idle'|'cap', err:string}>}
 */
export function runClaudeStream(cmd, { idleMs = 150000, capMs = 1800000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('bash', ['-lc', cmd], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ ok: false, result: null, isError: true, subtype: 'spawn', killed: '', err: String(e) }); return; }

    let buf = '', err = '', result = null, isError = false, subtype = '', killed = '';
    /** @type {any} */ let idle; /** @type {any} */ let cap;
    const clear = () => { clearTimeout(idle); clearTimeout(cap); };
    // Any output (an event) proves liveness → restart the idle countdown.
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => { killed = 'idle'; try { child.kill('SIGTERM'); } catch {} }, idleMs); };

    cap = setTimeout(() => { killed = 'cap'; try { child.kill('SIGTERM'); } catch {} }, capMs);
    bump();

    child.stdout.on('data', (d) => {
      bump();
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { const ev = JSON.parse(line); if (ev.type === 'result') { result = ev.result ?? null; isError = !!ev.is_error; subtype = ev.subtype || ''; } } catch {}
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clear(); resolve({ ok: false, result: null, isError: true, subtype: 'spawn', killed, err: String(e) }); });
    child.on('close', () => { clear(); resolve({ ok: result != null && !isError && !killed, result, isError, subtype, killed, err: err.slice(-500) }); });
  });
}
