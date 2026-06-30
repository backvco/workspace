// Saved ticket templates (presets for the New-ticket form). Plain CRUD in pg,
// seeded with a few useful starters on first use.
import { q } from './db.js';

let seq = 0;
function genId() { seq += 1; return `tpl${Date.now().toString(36)}${seq.toString(36)}`; }

const SEED = [
  { id: 'tpl-fix-test', label: 'Fix failing test', role: 'triage', model: '', permission: 'guarded', goal: 'Investigate and fix the failing test(s). Find the root cause, make the smallest correct fix, and commit.', criteria: 'The previously failing test(s) pass and nothing else breaks.', autoReview: true },
  { id: 'tpl-add-endpoint', label: 'Add API endpoint', role: 'implementer', model: '', permission: 'guarded', goal: 'Add a new API endpoint following this project\'s existing route/controller/store/functions pattern. Emit audit logs for state changes.', criteria: 'Endpoint added, wired end-to-end, returns correctly (not 404/500), and follows CLAUDE.md.', autoReview: true },
  { id: 'tpl-write-tests', label: 'Write tests', role: 'implementer', model: '', permission: 'guarded', goal: 'Add unit tests for the specified module, covering the main paths and edge cases.', criteria: 'Tests added and passing; meaningful coverage of the target.', autoReview: false },
  { id: 'tpl-refactor', label: 'Refactor large file', role: 'implementer', model: '', permission: 'guarded', goal: 'Decompose the specified file (over the line limit) into focused modules without changing behavior.', criteria: 'No file over the project limit; behavior unchanged; checks clean.', autoReview: true },
  { id: 'tpl-docs', label: 'Update docs', role: 'writer', model: 'sonnet', permission: 'guarded', goal: 'Update the documentation to match the current behavior of the specified area.', criteria: 'Docs accurate and consistent with the code.', autoReview: false }
];

export async function listTemplates(cfg) {
  const rows = await q(cfg, 'SELECT data FROM agent_templates ORDER BY created_at DESC');
  if (rows.length === 0) {
    for (const t of SEED) await q(cfg, 'INSERT INTO agent_templates (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING', [t.id, JSON.stringify(t)]);
    return SEED;
  }
  return rows.map((r) => r.data);
}

export async function addTemplate(cfg, input) {
  if (!input || !input.label) return { error: 'label required' };
  const t = {
    id: genId(),
    label: input.label,
    goal: input.goal || '',
    role: input.role || '',
    model: input.model || '',
    permission: input.permission || 'guarded',
    criteria: input.criteria || '',
    autoReview: !!input.autoReview
  };
  await q(cfg, 'INSERT INTO agent_templates (id, data) VALUES ($1, $2::jsonb)', [t.id, JSON.stringify(t)]);
  return t;
}

export async function removeTemplate(cfg, id) {
  await q(cfg, 'DELETE FROM agent_templates WHERE id = $1', [id]);
  return true;
}
