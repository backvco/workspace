// WebSocket <-> tmux-backed PTY bridge. One ws connection = one tmux client.
// Protocol (JSON text frames from client): {t:'i',d}=input, {t:'r',cols,rows}=resize.
// Server -> client frames are raw terminal output (text).
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { attachArgs, enableClipboard, scrollSession } from './tmux.js';
import { sessionName } from './config.js';
import { projectDir } from './projects.js';
import { wsAuthOk, originAllowed } from './auth.js';

const TERM_RE = /^\/ws\/term\/([\w-]+)$/;

export function installTerminals(server, cfg) {
  const wss = new WebSocketServer({ noServer: true });
  // Let tmux selections reach the browser clipboard via OSC 52.
  enableClipboard().catch(() => {});

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://local');
    const m = url.pathname.match(TERM_RE);
    if (!m) return; // let other upgrade handlers (e.g. vite HMR) deal with it
    // Block cross-site WebSocket hijacking before doing anything else.
    if (!originAllowed(req, cfg)) { try { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch {} socket.destroy(); return; }
    // Enforce auth (when enabled): the session cookie rides along on the upgrade.
    if (!(await wsAuthOk(cfg, req))) { try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch {} socket.destroy(); return; }
    // WS can't send headers, so the active project arrives as ?ws=<id>.
    const wsId = url.searchParams.get('ws') || 'default';
    const session = sessionName(cfg, wsId, m[1]);
    let cwd;
    try { cwd = await projectDir(cfg, wsId); } catch { cwd = cfg.termCwd; }
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, session, cfg, cwd));
  });
}

function bridge(ws, session, cfg, cwd) {
  let term;
  try {
    term = pty.spawn(process.env.WORKSPACE_TMUX_BIN || 'tmux', attachArgs(session), {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || cfg.termCwd,
      env: process.env
    });
  } catch (e) {
    try { ws.send(`\r\n[workspace] failed to start terminal: ${e.message}\r\n`); } catch {}
    ws.close();
    return;
  }

  const onData = (d) => { try { ws.send(d); } catch {} };
  term.onData(onData);
  term.onExit(() => { try { ws.close(); } catch {} });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'scroll' && typeof msg.lines === 'number') {
      // Touch-swipe scroll: route through tmux copy-mode so the tmux scrollback
      // buffer is accessible (xterm only shows the current screen, not tmux's buffer).
      scrollSession(session, msg.lines).catch(() => {});
    } else if (msg.t === 'r') {
      // Drop degenerate sizes outright. A real, visible terminal is never this
      // small (a phone in portrait is still ~40+ cols), so anything under this
      // floor is a hidden/collapsed host — honoring it would shrink the tmux
      // window and make the inner program (the agent CLI) spam its wrapped
      // statusline into scrollback. Keep the last good size instead.
      const cols = msg.cols | 0, rows = msg.rows | 0;
      if (cols >= 20 && rows >= 4) term.resize(cols, rows);
    }
  });

  // Browser/tab closed: kill only the tmux CLIENT pty. The tmux SESSION (and
  // the agent CLI inside it) keeps running, ready for the next attach.
  ws.on('close', () => { try { term.kill(); } catch {} });
  ws.on('error', () => { try { term.kill(); } catch {} });
}
