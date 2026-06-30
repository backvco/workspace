// Server-side tab persistence (Postgres), one row per project (workspace id).
// Shape is { groups:[{id,tabs,activeId}], activeGroupId } (split groups). Legacy
// rows in the old flat { tabs, activeId } shape are normalized on read.
import { q } from './db.js';

const EMPTY = { groups: [], activeGroupId: null, updatedAt: 0 };

export async function loadTabs(cfg, wsId) {
  const rows = await q(cfg, 'SELECT data FROM tabs WHERE workspace_id = $1', [wsId]);
  return rows[0] ? rows[0].data : { ...EMPTY };
}

export async function saveTabs(cfg, wsId, state) {
  const clean = {
    groups: Array.isArray(state?.groups) ? state.groups : [],
    activeGroupId: state?.activeGroupId ?? null,
    updatedAt: Date.now()
  };
  await q(cfg,
    `INSERT INTO tabs (workspace_id, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [wsId, JSON.stringify(clean)]);
  return clean;
}

// Normalize either shape to { groups, activeGroupId }.
export function normalize(s) {
  if (s && Array.isArray(s.groups)) return { groups: s.groups, activeGroupId: s.activeGroupId ?? s.groups[0]?.id ?? null };
  const tabs = Array.isArray(s?.tabs) ? s.tabs : [];
  return tabs.length
    ? { groups: [{ id: 'g0', tabs, activeId: s?.activeId ?? tabs[0]?.id ?? null }], activeGroupId: 'g0' }
    : { groups: [], activeGroupId: null };
}

// Remove a tab from a normalized state; returns the tab (or null). Drops empty groups.
export function removeTabFromState(state, tabId) {
  for (const g of state.groups) {
    const i = g.tabs.findIndex((t) => t.id === tabId);
    if (i < 0) continue;
    const [t] = g.tabs.splice(i, 1);
    if (g.activeId === tabId) g.activeId = g.tabs[Math.max(0, i - 1)]?.id ?? null;
    state.groups = state.groups.filter((x) => x.tabs.length > 0);
    if (!state.groups.some((x) => x.id === state.activeGroupId)) state.activeGroupId = state.groups[0]?.id ?? null;
    return t;
  }
  return null;
}

// Count total tabs across all projects. Returns { [workspaceId]: number }.
export async function tabCountsAll(cfg) {
  const rows = await q(cfg,
    `SELECT workspace_id,
            (SELECT COALESCE(sum(jsonb_array_length(g->'tabs')), 0)
               FROM jsonb_array_elements(data->'groups') g) AS cnt
       FROM tabs`);
  const out = {};
  for (const r of rows) out[r.workspace_id] = Number(r.cnt);
  return out;
}

// Append a tab to a normalized state's active (or first) group.
export function appendTabToState(state, tab) {
  let g = state.groups.find((x) => x.id === state.activeGroupId) || state.groups[0];
  if (!g) { g = { id: `g${Date.now().toString(36)}`, tabs: [], activeId: null }; state.groups.push(g); state.activeGroupId = g.id; }
  g.tabs.push(tab);
  g.activeId = tab.id;
}
