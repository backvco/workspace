// Drives a self-update from the UI: POST /api/update (ff-only, or force=reset),
// then poll /api/version until the new commit is the one actually serving and
// reload so the page picks up the fresh JS bundle. Shared by the header badge
// and Settings → General so the flow lives in one place.
import { api } from './api.js';

/**
 * @param {boolean} force  force=reset --hard to origin (for a diverged checkout)
 * @param {(phase:'pulling'|'deploying'|'done'|'error', message:string) => void} onPhase
 */
export async function runSelfUpdate(force, onPhase) {
  onPhase('pulling', force ? 'Resetting to origin…' : 'Pulling…');
  let res;
  try { res = await api.selfUpdate(force); }
  catch (e) { onPhase('error', String(/** @type {any} */ (e)?.message || e)); return; }
  if (!res?.ok) { onPhase('error', res?.error || 'update failed'); return; }

  const head = res.head;
  onPhase('deploying', 'Building & restarting…');
  // The running page is still the OLD build; poll until the new commit serves,
  // then reload. The API stays up across the workspace-ui restart, so polling
  // is uninterrupted.
  const started = Date.now();
  const tick = async () => {
    /** @type {any} */ let v = null;
    try { v = await api.version(); } catch { /* API mid-restart — retry */ }
    if (v && v.deployed === head && !v.buildStale) {
      onPhase('done', 'Updated — reloading…');
      setTimeout(() => location.reload(), 1200);
      return;
    }
    if (Date.now() - started > 180_000) {
      onPhase('error', 'Deploy is taking longer than expected — check the server.');
      return;
    }
    setTimeout(tick, 4000);
  };
  setTimeout(tick, 4000);
}
