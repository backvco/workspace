// Image paste bridge: send the blob to the server, which stores it and (when a
// tab is given) types the saved path into that terminal's tmux session.
import { apiUrl } from './config.js';

/** @param {File} file @param {string} [tabKey] @param {string} [wsId] */
export async function uploadImage(file, tabKey, wsId) {
  const body = await file.arrayBuffer();
  const q = tabKey ? `?tab=${encodeURIComponent(tabKey)}` : '';
  // The server resolves the workspace (and thus the tmux session name to inject
  // into) from x-workspace-project. Without it, wsId falls back to 'default' and
  // injection silently fails for every non-General project.
  /** @type {Record<string, string>} */
  const headers = { 'content-type': file.type || 'image/png' };
  if (wsId) headers['x-workspace-project'] = wsId;
  const res = await fetch(apiUrl(`/api/paste${q}`), {
    method: 'POST',
    headers,
    body
  });
  if (!res.ok) throw new Error(`paste -> ${res.status}`);
  return res.json(); // { path, injected }
}

// Copy text to the OS clipboard. Uses the SYNCHRONOUS hidden-textarea +
// execCommand('copy') path FIRST: the async Clipboard API (navigator.clipboard
// .writeText) can resolve "successfully" yet never populate the OS clipboard in
// some Chrome/Mac states — execCommand is the same path the browser's native
// right-click → Copy uses, and is reliable. Falls back to writeText only if the
// sync path fails. Must run in a user gesture (mouseup / keydown / tap).
/** @param {string} text */
export async function copyText(text) {
  if (!text) return false;
  // Synchronous path — proven reliable (same mechanism as native Copy).
  try {
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    active?.focus?.(); // restore focus to the terminal
    if (ok) return true;
  } catch { /* fall through to async API */ }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* nothing left to try */ }
  return false;
}

// Read the OS clipboard via the async Clipboard API. iOS Safari (13.4+) never
// fires a `paste` event carrying an image into a focused div, but it DOES honor
// navigator.clipboard.read() when called inside a user gesture (a tap) — that's
// how touch users paste a screenshot. Returns the first image as a File plus any
// plain text. Throws if the API is missing or the user denies access.
/** @returns {Promise<{ image: File | null, text: string }>} */
export async function readClipboard() {
  if (!navigator.clipboard?.read) {
    // No async read (older Safari): text-only fallback.
    const text = navigator.clipboard?.readText ? await navigator.clipboard.readText() : '';
    return { image: null, text: text || '' };
  }
  const items = await navigator.clipboard.read();
  let image = null;
  let text = '';
  for (const it of items) {
    const imgType = it.types.find((t) => t.startsWith('image/'));
    if (imgType && !image) {
      const blob = await it.getType(imgType);
      const ext = imgType.split('/')[1] || 'png';
      image = new File([blob], `pasted.${ext}`, { type: imgType });
    } else if (it.types.includes('text/plain') && !text) {
      text = await (await it.getType('text/plain')).text();
    }
  }
  return { image, text };
}

// Pull the first image out of a clipboard/drag event, if any.
/** @param {ClipboardEvent | DragEvent} ev */
export function imageFromEvent(ev) {
  const e = /** @type {any} */ (ev);
  const items = e.clipboardData?.items || e.dataTransfer?.items || [];
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) return it.getAsFile();
  }
  const files = e.dataTransfer?.files || [];
  for (const f of files) if (f.type.startsWith('image/')) return f;
  return null;
}
