// Headless ticket fixer. Given the current proposed tickets and verifier findings,
// spawns a claude -p agent that reads the actual source code at a clean base-branch
// checkout and rewrites only the flagged tickets. Returns the full corrected array.
// Same pattern as plan-review.js but produces output instead of grades.
import path from 'node:path';
import { listRepos } from './git.js';
import { acquireVerifyTree } from './worktree-gc.js';
import { runClaudeStream } from './claude-run.js';

const FENCE = /^```(?:json)?\s*|\s*```$/g;

async function prepareBaseTrees(cfg, repoBase) {
  const pathByRepo = {};
  for (const [repo, base] of Object.entries(repoBase)) {
    const t = await acquireVerifyTree(cfg, repo, base);
    pathByRepo[repo] = { path: t.path, base };
  }
  return { pathByRepo };
}

function parseResult(out) {
  const trimmed = out.trim().replace(FENCE, '');
  try { return JSON.parse(trimmed); } catch {}
  const s = trimmed.indexOf('{'), e = trimmed.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(trimmed.slice(s, e + 1)); } catch {} }
  return null;
}

function interpret(cfg, r) {
  if (r.killed === 'idle') return { reason: `stalled (no output for ${Math.round((cfg.fixerIdleMs || 120000) / 1000)}s)`, retry: false };
  if (r.killed === 'cap') return { reason: `exceeded time cap`, retry: false };
  if (r.subtype === 'error_max_turns') return { reason: `hit the ${cfg.fixerMaxTurns || 60}-turn limit`, retry: false };
  if (r.isError || (r.subtype && r.subtype !== 'success')) return { reason: `errored (${r.subtype || 'unknown'})`, retry: true };
  if (r.result == null) return { reason: `no output${r.err ? ` (${r.err.slice(-140).trim()})` : ''}`, retry: true };
  const parsed = parseResult(r.result);
  if (!parsed) return { reason: 'returned non-JSON result', retry: true };
  return { parsed };
}

/**
 * Fix failing tickets by reading the actual source code and rewriting them.
 * @param {any} cfg
 * @param {any} planner
 * @param {any[]} tickets - full current proposed list
 * @param {any[]} findings - high/medium findings from the verifier
 * @returns {Promise<{tickets?: any[], summary?: string, failed?: boolean, reason?: string}>}
 */
export async function fixTickets(cfg, planner, tickets, findings) {
  const dir = planner.dir;
  const known = new Set(listRepos(cfg).map((r) => r.path));
  const repoBase = {};
  for (const t of tickets) {
    const r = t.repo || t.dir;
    if (r && known.has(r) && !repoBase[r]) repoBase[r] = t.baseBranch || 'dev';
  }

  const { pathByRepo } = await prepareBaseTrees(cfg, repoBase);
  const repoLines = Object.entries(pathByRepo)
    .map(([repo, v]) => `- ${repo}  →  READ AT: ${v.path}  (clean origin/${v.base} checkout — read ONLY this path)`)
    .join('\n');

  const failingNums = new Set(findings.map((f) => f.ticket).filter((n) => n > 0));

  const numbered = tickets.map((t, i) => ({
    n: i + 1, title: t.title, repo: t.repo || t.dir, role: t.role,
    goal: t.goal, criteria: t.criteria, steps: t.steps || '', context: t.context || '',
    dependsOn: (t.dependsOn || []).map((d) => (tickets[d] ? `#${d + 1} ${tickets[d].title}` : `#${d + 1}`))
  }));

  const prompt = [
    `You are a ticket fixer. Read the actual source code and rewrite ONLY the flagged tickets to fix the verifier's findings. Leave all other tickets exactly as-is.`,
    `Project: ${dir}`,
    repoLines ? `Repos (read ONLY at the clean checkout paths below):\n${repoLines}` : '',
    ``,
    `ALL PROPOSED TICKETS (${tickets.length} total, 1-based n field):`,
    JSON.stringify(numbered, null, 1),
    ``,
    `VERIFIER FINDINGS — fix ONLY tickets: ${[...failingNums].map((n) => `#${n}`).join(', ')}`,
    JSON.stringify(findings.map((f) => ({ ticket: f.ticket, severity: f.severity, issue: f.issue, fix: f.fix })), null, 1),
    ``,
    `Instructions for each flagged ticket:`,
    `1. Read the relevant source files at the clean checkout path. Do not guess.`,
    `2. Confirm the exact file paths, function names, field names, and shapes from the real code.`,
    `3. Rewrite goal, criteria, steps, and context so they are accurate and complete:`,
    `   goal: 2-4 sentences, cite exact files/functions with file:line references`,
    `   criteria: specific testable checks a developer can verify by running a command or inspecting output`,
    `   steps: numbered, file-by-file implementation steps with exact changes at each step`,
    `   context: background context with file:line citations for patterns to follow`,
    ``,
    `Leave unflagged tickets EXACTLY unchanged — copy them verbatim from the input.`,
    ``,
    `Output ONLY a JSON object, no markdown, no prose:`,
    `{"tickets":[...all ${tickets.length} tickets in order, same n values, flagged ones rewritten...],"summary":"<one line describing what changed and why>"}`
  ].filter(Boolean).join('\n').replace(/'/g, `'\\''`);

  const permFile = path.join(cfg.agentPermDir, 'planner.json');
  const maxTurns = cfg.fixerMaxTurns || 60;
  const idleMs = cfg.fixerIdleMs || 120000;
  const capMs = cfg.fixerCapMs || 900000;
  const cmd = `cd '${dir}' && ${cfg.claudeBin || 'claude'} -p --output-format stream-json --verbose --model sonnet --max-turns ${maxTurns} --settings '${permFile}' '${prompt}' </dev/null`;

  const runOnce = async () => interpret(cfg, await runClaudeStream(cmd, { idleMs, capMs }));
  let res = await runOnce();
  if (res.reason && res.retry) res = await runOnce();
  if (res.reason) return { failed: true, reason: res.reason };

  const fixed = res.parsed;
  if (!Array.isArray(fixed?.tickets) || fixed.tickets.length !== tickets.length) {
    return { failed: true, reason: `fixer returned ${fixed?.tickets?.length ?? 0} tickets, expected ${tickets.length}` };
  }

  // Merge: apply only text fields from fixer output back onto originals.
  // This preserves all structural fields (repo, dependsOn indices, plan, branch, etc.).
  const merged = tickets.map((orig, i) => {
    const rev = fixed.tickets[i];
    if (!rev || !failingNums.has(i + 1)) return orig;
    return {
      ...orig,
      title: rev.title || orig.title,
      goal: rev.goal || orig.goal,
      criteria: rev.criteria || orig.criteria,
      steps: rev.steps !== undefined ? rev.steps : (orig.steps || ''),
      context: rev.context !== undefined ? rev.context : (orig.context || ''),
    };
  });

  return { tickets: merged, summary: String(fixed.summary || '').slice(0, 300) };
}
