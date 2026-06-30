// Server-persisted tab state, organized into split GROUPS (VS Code-style editor
// groups). Each group is a column with its own tab strip + active tab; groups sit
// side by side. Tabs can be reordered, dragged between groups, or dragged out to
// form a new split; an emptied group disappears. Persisted per project (synced
// across devices) as { groups, activeGroupId }; migrates the old flat
// { tabs, activeId } shape on load.
import { api } from '$lib/api.js';
import { getActiveProject } from '$lib/session.js';

/** @typedef {{ id: string, toolId: string, title: string, params: Record<string, any> }} Tab */
/** @typedef {{ id: string, tabs: Tab[], activeId: string|null }} Group */

/** @type {Group[]} */
let groups = $state([]);
/** @type {string | null} */
let activeGroupId = $state(null);
let loaded = $state(false);
let seq = 0;

// Tab IDs that have signalled they need user input (BEL in terminal output).
// Cleared when the tab is activated.
/** @type {Set<string>} */
let needsInputSet = $state(new Set());

/** @type {{ tabId: string, fromGroupId: string } | null} */
let drag = null; // dragged tab payload
let dragActive = $state(false); // reactive: true while a tab is being dragged (gates split drop zones)

/** @type {ReturnType<typeof setTimeout> | undefined} */
let saveTimer;
// The project this in-memory tab state belongs to. Bound when persist() schedules
// a save so the write always targets the RIGHT namespace even if the operator
// switches projects before the debounce fires — otherwise a pending save would
// land under whatever project happens to be active at fire time (e.g. a running
// plan's churning tab titles leaking one project's tabs into another's namespace).
let saveProject = '';
function persist() {
  saveProject = getActiveProject();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushTabs, 250);
}
// Send any pending save NOW (to the project it was bound to) and cancel the timer.
// Called on a debounce tick and synchronously before a project switch, so the
// outgoing namespace keeps its latest tabs and nothing leaks across the switch.
export function flushTabs() {
  if (!saveTimer) return;
  clearTimeout(saveTimer); saveTimer = undefined;
  const project = saveProject;
  api.putTabs({ groups: groups.map(serializeGroup), activeGroupId }, project).catch(() => {});
}
/** @param {Tab} t */
function serialize(t) { return { id: t.id, toolId: t.toolId, title: t.title, params: t.params || {} }; }
/** @param {Group} g */
function serializeGroup(g) { return { id: g.id, tabs: g.tabs.map(serialize), activeId: g.activeId }; }
/** @param {string} [p] */
function genId(p = 't') { seq += 1; return `${p}${Date.now().toString(36)}${seq.toString(36)}`; }

// Reactive view for components.
export const tabStore = {
  get groups() { return groups; },
  get activeGroupId() { return activeGroupId; },
  get loaded() { return loaded; },
  get dragActive() { return dragActive; },
  get needsInput() { return needsInputSet; },
  /** A tab is "active" (visible) when it's its own group's active tab. @param {string} id */
  isActive: (id) => { const g = groupOf(id); return !!g && g.activeId === id; }
};

/** @param {string} tabId */
function groupOf(tabId) { return groups.find((g) => g.tabs.some((t) => t.id === tabId)); }
function activeGroup() { return groups.find((g) => g.id === activeGroupId) || groups[0]; }
/** @param {string} tabId */
function findTab(tabId) { for (const g of groups) { const t = g.tabs.find((x) => x.id === tabId); if (t) return t; } return null; }

export async function initTabs() {
  flushTabs(); // push any pending save to its own namespace before we replace groups
  needsInputSet = new Set(); // clear per-tab flags from the outgoing project
  let s;
  try { s = await api.getTabs(); } catch { s = {}; }
  if (Array.isArray(s?.groups) && s.groups.length) {
    groups = s.groups.map((/** @type {any} */ g) => ({ id: g.id || genId('g'), tabs: Array.isArray(g.tabs) ? g.tabs : [], activeId: g.activeId ?? g.tabs?.[0]?.id ?? null }));
    activeGroupId = s.activeGroupId && groups.some((g) => g.id === s.activeGroupId) ? s.activeGroupId : groups[0].id;
  } else {
    // migrate old flat { tabs, activeId } (or empty)
    const tabs = Array.isArray(s?.tabs) ? s.tabs : [];
    const g = { id: genId('g'), tabs, activeId: s?.activeId ?? tabs[0]?.id ?? null };
    groups = [g];
    activeGroupId = g.id;
  }
  if (groups.every((g) => g.tabs.length === 0)) { groups = []; activeGroupId = null; }
  loaded = true;
}

/** @param {string} id */
export function activateTab(id) {
  const g = groupOf(id);
  if (!g) return;
  g.activeId = id;
  activeGroupId = g.id;
  if (needsInputSet.has(id)) { needsInputSet = new Set(needsInputSet); needsInputSet.delete(id); }
  persist();
}

/** Flag a tab as needing user input (e.g. BEL received). */
export function markNeedsInput(id) {
  if (tabStore.isActive(id)) return; // already visible — no flag needed
  needsInputSet = new Set(needsInputSet);
  needsInputSet.add(id);
}

/** Clear the needs-input flag (called on tab open / explicit dismiss). */
export function clearNeedsInput(id) {
  if (!needsInputSet.has(id)) return;
  needsInputSet = new Set(needsInputSet);
  needsInputSet.delete(id);
}
/** @param {string} gid */
export function activateGroup(gid) { if (groups.some((g) => g.id === gid)) { activeGroupId = gid; persist(); } }

/**
 * Open a tool as a tab in the active group. Singleton tools / explicit ids dedupe
 * across ALL groups (activate the existing one).
 * @param {{ toolId: string, title?: string, singleton?: boolean, id?: string, params?: Record<string,any> }} opts
 */
export function openTool({ toolId, title, singleton, id, params }) {
  if (id) { const t = findTab(id); if (t) { activateTab(id); return id; } }
  if (singleton) { for (const g of groups) { const e = g.tabs.find((t) => t.toolId === toolId); if (e) { activateTab(e.id); return e.id; } } }
  let g = activeGroup();
  if (!g) { g = { id: genId('g'), tabs: [], activeId: null }; groups.push(g); activeGroupId = g.id; }
  const tabId = id || genId();
  g.tabs.push({ id: tabId, toolId, title: title || toolId, params: params || {} });
  g.activeId = tabId;
  activeGroupId = g.id;
  persist();
  return tabId;
}

/** @param {string} [title] */
export function openTerminal(title) {
  const n = groups.reduce((c, g) => c + g.tabs.filter((t) => t.toolId === 'terminal').length, 0) + 1;
  return openTool({ toolId: 'terminal', title: title || `Terminal ${n}` });
}
/** Attach a terminal tab to an existing tmux session (an agent). @param {string} id @param {string} [title] */
export function attachTerminal(id, title) { return openTool({ toolId: 'terminal', id, title: title || 'agent', params: { attached: true } }); }

/** Open a Plan-with-Claude tab (the tab creates its planner lazily). @param {string} [goal] */
export function openPlannerTab(goal) { return openTool({ toolId: 'planner', title: '🧠 Plan', params: goal ? { goal } : {} }); }

/** @param {string} id @param {string} title */
export function renameTab(id, title) {
  const t = findTab(id);
  if (!t) return;
  t.title = title || t.title;
  // A manual rename pins the name: auto-titling (autoTitleTab) leaves it alone.
  t.params = { ...t.params, namePinned: true };
  persist();
}

// Strip a leading status glyph/spinner (e.g. "✳ ") + whitespace so the tab shows
// a clean name and an animated glyph can't churn the persisted title.
/** @param {string} raw */
function cleanTitle(raw) { return String(raw || '').replace(/^[^\p{L}\p{N}]+/u, '').trim(); }

/**
 * Auto-name a terminal tab from its live pane title (e.g. Claude Code's task
 * summary, forwarded by tmux as OSC 2). No-op for tabs the user manually renamed
 * (namePinned) or attached agent tabs, and when the cleaned title is unchanged.
 * @param {string} id @param {string} raw
 */
export function autoTitleTab(id, raw) {
  const t = findTab(id);
  if (!t || t.params?.namePinned || t.params?.attached) return;
  const title = cleanTitle(raw);
  if (!title || title === t.title) return;
  t.title = title;
  persist();
}
/** @param {string} id @param {{ title?: string, params?: Record<string, any> }} patch */
export function updateTab(id, patch) {
  const t = findTab(id);
  if (!t) return;
  if (patch.title != null) t.title = patch.title;
  if (patch.params) t.params = { ...t.params, ...patch.params };
  persist();
}

// Remove a tab from its group (no kill); returns the tab. Drops the group if it
// empties (unless it's the only group). Caller persists.
/** @param {string} id */
function detach(id) {
  const g = groupOf(id);
  if (!g) return null;
  const idx = g.tabs.findIndex((t) => t.id === id);
  const [tab] = g.tabs.splice(idx, 1);
  if (g.activeId === id) g.activeId = g.tabs[Math.max(0, idx - 1)]?.id ?? null;
  if (g.tabs.length === 0 && groups.length > 1) {
    groups = groups.filter((x) => x.id !== g.id);
    if (activeGroupId === g.id) activeGroupId = groups[0].id;
  }
  return tab;
}

/** @param {string} id */
export function closeTab(id) {
  const t = findTab(id);
  if (!t) return;
  if (t.toolId === 'terminal' && !t.params?.attached) api.killSession(id).catch(() => {});
  detach(id);
  if (groups.length === 0 || groups.every((g) => g.tabs.length === 0)) { groups = []; activeGroupId = null; return; }
  persist();
}
/** @param {string} id — close every other tab in the SAME group */
export function closeOthers(id) {
  const g = groupOf(id);
  if (!g) return;
  for (const t of [...g.tabs]) if (t.id !== id) { if (t.toolId === 'terminal' && !t.params?.attached) api.killSession(t.id).catch(() => {}); }
  g.tabs = g.tabs.filter((t) => t.id === id);
  g.activeId = id;
  persist();
}

// Move a tab to another project (server moves the record + renames the tmux
// session); reload this project's groups afterward.
/** @param {string} id @param {string} toProject */
export async function moveTab(id, toProject) {
  try { await api.tabMove(id, toProject); } catch { return; }
  await initTabs();
}

// --- drag & drop between/within groups ---
/** @param {string} tabId @param {string} fromGroupId */
export function beginDrag(tabId, fromGroupId) { drag = { tabId, fromGroupId }; dragActive = true; }
export function endDrag() { drag = null; dragActive = false; }
export function dragging() { return drag; }

/** Drop the dragged tab into `toGroupId` immediately before `beforeTabId` (or at end if null). */
/** @param {string} toGroupId @param {string|null} beforeTabId */
export function dropOnGroup(toGroupId, beforeTabId) {
  if (!drag) return;
  const { tabId } = drag; drag = null; dragActive = false;
  const tab = detach(tabId);
  if (!tab) return;
  const g = groups.find((x) => x.id === toGroupId);
  if (!g) return; // group vanished (was the source and emptied)
  const at = beforeTabId ? g.tabs.findIndex((t) => t.id === beforeTabId) : g.tabs.length;
  g.tabs.splice(at < 0 ? g.tabs.length : at, 0, tab);
  g.activeId = tabId;
  activeGroupId = g.id;
  persist();
}

/** Drop the dragged tab as a NEW split, inserted at `groupIndex` in the row. */
/** @param {number} groupIndex */
export function dropAsSplit(groupIndex) {
  if (!drag) return;
  const { tabId, fromGroupId } = drag; drag = null; dragActive = false;
  const from = groups.find((g) => g.id === fromGroupId);
  // Don't split a single-tab group onto itself — nothing would change.
  if (from && from.tabs.length === 1 && from.tabs[0].id === tabId) return;
  const tab = detach(tabId);
  if (!tab) return;
  const ng = { id: genId('g'), tabs: [tab], activeId: tabId };
  const i = Math.max(0, Math.min(groupIndex, groups.length));
  groups.splice(i, 0, ng);
  activeGroupId = ng.id;
  persist();
}
