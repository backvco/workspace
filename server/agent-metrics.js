// Cross-project agent metrics for the Overview dashboard. Pure aggregation over
// the agent_tasks rows (no token attribution — see the header Usage gauge for
// overall local token spend).
import { q } from './db.js';

export async function computeMetrics(cfg) {
  const rows = (await q(cfg, 'SELECT data FROM agent_tasks')).map((r) => r.data);
  /** @type {Record<string,number>} */ const byState = {};
  /** @type {Record<string,number>} */ const byProject = {};
  /** @type {Record<string,number>} */ const byModel = {};
  const dayAgo = Date.now() - 86400000;
  let todo = 0, active = 0, needs = 0, done = 0, doneToday = 0;
  /** @type {number[]} */ const durations = [];
  for (const t of rows) {
    byState[t.state] = (byState[t.state] || 0) + 1;
    byProject[t.ns || 'default'] = (byProject[t.ns || 'default'] || 0) + 1;
    if (t.model) byModel[t.model] = (byModel[t.model] || 0) + 1;
    if (t.state === 'todo') todo++;
    if (['planning', 'executing'].includes(t.state)) active++;
    if (t.needsYou) needs++;
    if (t.state === 'done') {
      done++;
      if ((t.updatedAt || 0) > dayAgo) doneToday++;
      if (t.startedAt && t.updatedAt) durations.push(t.updatedAt - t.startedAt);
    }
  }
  const avgMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  return { total: rows.length, todo, active, needs, done, doneToday, avgMs, byState, byProject, byModel };
}
