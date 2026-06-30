// Project store. The active project scopes the whole app: switching it reloads
// that project's tab set (each project persists its own tabs server-side).
import { api } from './api.js';
import { setActiveProject } from './session.js';
import { initTabs, flushTabs } from './tabs/store.svelte.js';

/** @typedef {{id:string,label:string,type:string,group:string,dir:string,defaultModel?:string,defaultPermission?:string}} Project */

/** @type {Project[]} */
let list = $state([]);
let activeId = $state('default');

export const projectStore = {
  get list() { return list; },
  get activeId() { return activeId; },
  get active() { return list.find((p) => p.id === activeId) || null; }
};

export async function loadProjects() { try { list = (await api.projects()).projects; } catch {} }

/** @param {string} id — switch the active project; reloads its tabs */
export async function setActive(id) {
  if (id === activeId) return;
  // Flush any pending tab save to the CURRENT project BEFORE we change the active
  // project, so its last edits land in its own namespace and can't leak into the
  // one we're switching to.
  flushTabs();
  activeId = id;
  setActiveProject(id);
  try { localStorage.setItem('activeProject', id); } catch {}
  // Overview is a special cross-project view with no tab set of its own.
  if (id !== 'overview') await initTabs();
}

/** @param {object} input */
export async function addProject(input) {
  const p = await api.addProject(input);
  await loadProjects();
  return p;
}
/** @param {string} id */
export async function removeProject(id) {
  await api.removeProject(id);
  await loadProjects();
  if (activeId === id) await setActive('default');
}

export async function initProjects() {
  await loadProjects();
  let saved = 'default';
  try { saved = localStorage.getItem('activeProject') || 'default'; } catch {}
  // Load the active project's tabs directly. We can't go through setActive() here:
  // it early-returns when id === activeId (both 'default' on a fresh load), which
  // would skip initTabs() and leave the app stuck on "Loading workspace...".
  activeId = saved;
  setActiveProject(saved);
  try { localStorage.setItem('activeProject', saved); } catch {}
  if (saved !== 'overview') await initTabs();
}
