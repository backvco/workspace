// Shared agent/ticket status presentation, ordering, kanban columns, and stuck
// detection — used by the list, detail, and board.
/** @type {Record<string, {label:string, cls:string, dot:string}>} */
export const S = {
  todo: { label: 'to do', cls: 'text-slate-500 dark:text-slate-400', dot: 'bg-slate-400 dark:bg-slate-500' },
  planning: { label: 'planning', cls: 'text-muted', dot: 'bg-muted animate-pulse' },
  'plan-review': { label: 'review plan', cls: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500 dark:bg-amber-400 animate-pulse' },
  executing: { label: 'working', cls: 'text-green-600 dark:text-green-400', dot: 'bg-green-600 dark:bg-green-500 animate-pulse' },
  blocked: { label: 'blocked', cls: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500 dark:bg-amber-400 animate-pulse' },
  review: { label: 'review work', cls: 'text-blue-600 dark:text-blue-400', dot: 'bg-blue-500 dark:bg-blue-400 animate-pulse' },
  done: { label: 'done', cls: 'text-muted', dot: 'bg-green-600 dark:bg-green-700' },
  ended: { label: 'ended', cls: 'text-muted', dot: 'bg-muted' },
  error: { label: 'error', cls: 'text-red-600 dark:text-red-400', dot: 'bg-red-600 dark:bg-red-500' }
};
/** @param {string} s */
export const st = (s) => S[s] || S.planning;

/** @type {Record<string, number>} */
export const ORDER = { 'plan-review': 0, blocked: 1, review: 2, executing: 3, planning: 4, todo: 5, error: 6, done: 7, ended: 8 };

export const NEEDS = ['plan-review', 'blocked', 'review'];
export const RUNNING = ['planning', 'executing'];
export const DONE = ['done', 'ended', 'error'];

// Kanban columns: each maps to one or more statuses.
export const COLUMNS = [
  { key: 'todo', label: 'To do', states: ['todo'] },
  { key: 'working', label: 'Working', states: ['planning', 'executing'] },
  { key: 'needs', label: 'Needs you', states: ['plan-review', 'blocked', 'review'] },
  { key: 'done', label: 'Done', states: ['done', 'ended', 'error'] }
];

// Stuck: actively running but no update for a while, and not already waiting on
// you. A soft signal that an agent may be looping or wedged.
const STALE_MS = 10 * 60 * 1000;
/** @param {any} t @param {number} [now] */
export function isStale(t, now = Date.now()) {
  return RUNNING.includes(t.status) && !t.needsYou && t.updatedAt && now - t.updatedAt > STALE_MS;
}

/** Split a string on URLs so the UI can linkify them. @param {string} s */
export const parts = (s) => (s || '').split(/(https?:\/\/[^\s]+)/g);

// Chain numbering: blockers numbered before the tickets that depend on them, so a
// plan reads #1, #2, #3 in dependency order. Returns id -> number.
/** @param {any[]} list @returns {Map<string,number>} */
export function chainOrder(list) {
  const byId = new Map(list.map((t) => [t.id, t]));
  /** @type {Map<string,number>} */
  const num = new Map();
  let n = 0;
  /** @param {any} t @param {Set<string>} seen */
  const visit = (t, seen) => {
    if (num.has(t.id) || seen.has(t.id)) return;
    seen.add(t.id);
    for (const b of (t.blockedBy || [])) { const bt = byId.get(b); if (bt) visit(bt, seen); }
    if (!num.has(t.id)) num.set(t.id, ++n);
  };
  for (const t of [...list].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) visit(t, new Set());
  return num;
}
// Number each plan independently (so #1.. restarts per plan, matching the board),
// with no-plan tickets numbered as their own group. Returns id -> number.
/** @param {any[]} tasks @returns {Map<string,number>} */
export function chainNumbersByPlan(tasks) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const t of tasks) { const k = t.plan || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k)?.push(t); }
  /** @type {Map<string,number>} */
  const out = new Map();
  for (const [, list] of groups) for (const [id, n] of chainOrder(list)) out.set(id, n);
  return out;
}
