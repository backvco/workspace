// Thin promise wrappers around the tmux CLI. The persistence model lives here:
// a terminal websocket spawns a tmux *client*; killing that client (browser
// close) never touches the tmux *session*, so long-running work survives.
import { execFile } from 'node:child_process';

const TMUX = process.env.WORKSPACE_TMUX_BIN || 'tmux';

function run(args) {
  return new Promise((resolve) => {
    execFile(TMUX, args, { maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || '').toString() });
    });
  });
}

// Args to attach-or-create a session as a pty client.
export function attachArgs(session) {
  return ['new-session', '-A', '-s', session];
}

// Make tmux push its copy buffer to the client terminal via OSC 52, so a mouse
// selection inside a pane reaches the browser's clipboard (xterm decodes the
// OSC 52). Without this tmux only copies to its own buffer. Global + idempotent;
// new sessions inherit it. Safe to call repeatedly on startup.
export async function enableClipboard() {
  await run(['start-server']);
  // 'on' makes tmux emit OSC 52 from its own copy commands. The pty's TERM
  // (xterm-256color) already matches tmux's default `xterm*:clipboard` feature,
  // so no terminal-features override is needed.
  await run(['set-option', '-g', 'set-clipboard', 'on']);
  // Size each window to the LATEST attached client. This means when you open a
  // session on iPhone it immediately resizes to the phone's width, even if a
  // desktop previously had it wider. Each terminal tab is its own session with
  // one active client at a time, so 'latest' = that one client's size, which is
  // always correct. The server still drops degenerate sizes (terminals.js ≥20c).
  await run(['set-option', '-g', 'window-size', 'latest']);
  // Forward the pane title (set by the inner program via OSC 0/2 — e.g. Claude
  // Code's short task summary) to the attached client as OSC 2, so a terminal tab
  // can auto-name itself. The 'title' terminal-feature is on by default for
  // xterm* and our pty attaches as xterm-256color, so the client receives it.
  // '#T' = the pane title only (no session/window decoration).
  await run(['set-option', '-g', 'set-titles', 'on']);
  await run(['set-option', '-g', 'set-titles-string', '#T']);
}

export async function listSessions() {
  const { ok, out } = await run(['list-sessions', '-F', '#{session_name}']);
  return ok ? out.trim().split('\n').filter(Boolean) : [];
}

export async function hasSession(session) {
  const { ok } = await run(['has-session', '-t', session]);
  return ok;
}

export async function killSession(session) {
  return (await run(['kill-session', '-t', session])).ok;
}

// Rename a session (used to move a terminal tab between projects so its live
// shell follows). No-op if the source session doesn't exist.
export async function renameSession(from, to) {
  if (!(await hasSession(from))) return false;
  return (await run(['rename-session', '-t', from, to])).ok;
}

// Type literal text into the session's active pane (used to inject image paths
// into the focused Claude Code prompt). `-l` = literal, no key interpretation.
export async function sendText(session, text) {
  return (await run(['send-keys', '-t', session, '-l', text])).ok;
}

// Scroll the session's tmux scrollback buffer from a touch swipe.
// lines > 0 = scroll up (see older content), lines < 0 = scroll down.
// Enters copy-mode with -e so tmux auto-exits when scrolled back to the bottom.
export async function scrollSession(session, lines) {
  const abs = Math.abs(lines);
  if (abs === 0) return;
  const direction = lines > 0 ? 'scroll-up' : 'scroll-down';
  await run(['copy-mode', '-e', '-t', session]);
  await run(['send-keys', '-t', session, '-X', '-N', String(abs), direction]);
}
