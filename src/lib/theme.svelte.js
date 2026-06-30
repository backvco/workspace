/** @type {'light'|'dark'|'system'} */
let mode = $state('system');
/** Resolved theme — true when dark is actually applied (accounts for system). */
let resolvedDark = $state(false);
/** @type {MediaQueryList|null} */
let mq = null;

const DARK_CANVAS = '#0d1117';
const LIGHT_CANVAS = '#ffffff';

function applyTheme() {
  if (typeof document === 'undefined') return;
  const dark = mode === 'dark' || (mode === 'system' && (mq?.matches ?? false));
  resolvedDark = dark;
  document.documentElement.classList.toggle('dark', dark);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', dark ? DARK_CANVAS : LIGHT_CANVAS);
}

/** @param {'light'|'dark'|'system'} m */
export function setMode(m) {
  mode = m;
  try { localStorage.setItem('theme', m); } catch {}
  applyTheme();
}

export function cycleMode() {
  const order = /** @type {const} */ (['light', 'dark', 'system']);
  setMode(order[(order.indexOf(mode) + 1) % 3]);
}

export const themeStore = {
  get mode() { return mode; },
  /** Resolved: true when dark is actually showing (system included). */
  get dark() { return resolvedDark; }
};

// GitHub Dark / Light terminal palettes (full 16-color ANSI), matched to the
// app's GitHub-based tokens so terminal output is cohesive in both themes.
const TERM_DARK = {
  background: '#0d1117', foreground: '#e6edf3',
  cursor: '#e6edf3', cursorAccent: '#0d1117', selectionBackground: '#264f78',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
  brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
};
const TERM_LIGHT = {
  background: '#ffffff', foreground: '#1f2328',
  cursor: '#1f2328', cursorAccent: '#ffffff', selectionBackground: '#add6ff',
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00',
  blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01',
  brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f'
};
/** xterm ITheme for the current resolved theme. */
export const terminalTheme = () => (resolvedDark ? TERM_DARK : TERM_LIGHT);

/** Call from onMount — wires the matchMedia listener and syncs from localStorage. */
export function initTheme() {
  try {
    const saved = /** @type {'light'|'dark'|'system'} */ (localStorage.getItem('theme'));
    if (saved === 'light' || saved === 'dark' || saved === 'system') mode = saved;
  } catch {}
  mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', applyTheme);
  applyTheme();
  return () => mq?.removeEventListener('change', applyTheme);
}
