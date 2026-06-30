// Shared state + actions for the Settings sub-tabs (General / Authentication /
// Users). Kept in one rune store so the sub-views stay thin and don't re-fetch or
// prop-drill. Mutations here are reactive in every component that imports `s`.
import { api } from '$lib/api.js';

export const s = $state({
  /** @type {{authEnabled:boolean, authed:boolean, user:{id:string,username:string}|null, needsBootstrap:boolean, hasSessionKey:boolean, loginPolicy:string}|null} */
  status: null,
  /** @type {{projectRoots:string[], termCwd:string, dataDir:string, agentBin:string, hasSessionKey:boolean}|null} */
  config: null,
  /** @type {{branch:string, head:string, remote:string, deployed:string, repoUrl:string, deployedUrl:string, ahead:number, behind:number, incoming:{hash:string,subject:string,url:string}[], dirty:boolean, updateAvailable:boolean, buildStale:boolean, canFastForward:boolean}|null} */
  version: null,
  /** @type {{id:string,username:string,name:string,email:string,avatar:string,createdAt:number,passkeyCount:number}[]} */
  users: [],
  busy: false,
  msg: '',
  err: '',
});

export function flash(/** @type {string} */ m, isErr = false) {
  if (isErr) { s.err = m; s.msg = ''; } else { s.msg = m; s.err = ''; }
}

export async function reload() {
  try { s.status = await api.authStatus(); } catch (e) { console.error('Failed to load auth status:', e); }
  try { s.config = await api.serverConfig(); } catch (e) { console.error('Failed to load server config:', e); }
  try { s.version = await api.version(); } catch (e) { console.error('Failed to load version:', e); }
  try { s.users = (await api.authUsers()).users; } catch (e) { console.error('Failed to load auth users:', e); }
}
