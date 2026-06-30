// The single client-side seam. Same-origin by default (vite/nginx forward
// /api and /ws to workspace-api). To embed in another app, point these at
// that app's mount path.
export const API_BASE = '';
export const WS_TERM_PATH = '/ws/term';

// Build-time FALLBACK for the embedded code-server URL. Prefer the runtime config
// (server /api/config <- WORKSPACE_CODE_SERVER_URL), which the Code tab fetches so
// the URL can change without a rebuild. This VITE_ var only helps embedded builds.
export const CODE_SERVER_URL = import.meta.env.VITE_CODE_SERVER_URL || '';

/** @param {string} path */
export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

/** @param {string} path */
export function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
