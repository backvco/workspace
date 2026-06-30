// Plan verifier. Before a Plan-with-Claude batch becomes real tickets, a headless
// `claude -p` reads the actual repos and grades the proposed ticket plan against
// the mistakes the planner tends to make — wrong repo targeting, missing cross-repo
// publish/consume handoffs, broken dependencies, weak decomposition.
//
// Runs read-only under the dedicated verifier permission profile (broad READ so it
// can inspect anything; no writes). It reads each repo at a reusable, GC'd clean
// checkout of origin/<base> (see worktree-gc.js). Invoked with --output-format json
// so we parse a real result envelope and can report the actual failure (timeout vs
// turn cap vs api error) instead of a vague "didn't parse". Returns structured
// findings; the create gate blocks on any high-severity finding unless overridden.
import path from 'node:path';
import { listRepos } from './git.js';
import { acquireVerifyTree } from './worktree-gc.js';
import { runClaudeStream } from './claude-run.js';

const FENCE = /^```(?:json)?\s*|\s*```$/g;

// Resolve each repo to a clean origin/<base> checkout (reusable + GC'd worktree) so
// the verifier reads the ACTUAL base state, not whatever branch the live checkout
// is parked on (a parked branch caused false "not implemented" findings). Falls
// back to the live repo path if the base can't be checked out. No cleanup here —
// the trees are reused across runs and reaped by the GC (worktree-gc.js).
async function prepareBaseTrees(cfg, repoBase) {
  const pathByRepo = {};
  for (const [repo, base] of Object.entries(repoBase)) {
    const t = await acquireVerifyTree(cfg, repo, base);
    pathByRepo[repo] = { path: t.path, base };
  }
  return { pathByRepo };
}

// Turn the `claude -p --output-format json` result into a verdict. Distinguishes a
// genuine timeout / turn-cap / api error (don't retry blindly) from a transient
// flake or malformed result (worth one retry).
function interpret(cfg, r) {
  if (r.killed === 'idle') return { reason: `stalled (no output for ${Math.round((cfg.verifierIdleMs || 180000) / 1000)}s) before finishing`, retry: false };
  if (r.killed === 'cap') return { reason: `exceeded the time cap before finishing`, retry: false };
  if (r.subtype === 'error_max_turns') return { reason: `hit the ${cfg.verifierMaxTurns || 80}-turn limit`, retry: false };
  if (r.isError || (r.subtype && r.subtype !== 'success')) return { reason: `errored (${r.subtype || 'unknown'})`, retry: true };
  if (r.result == null) return { reason: `produced no output${r.err ? ` (${r.err.slice(-140).trim()})` : ''}`, retry: true };
  const parsed = parseFindings(r.result);
  if (!parsed) return { reason: 'returned a non-JSON result', retry: true };
  return { parsed };
}

/**
 * @param {any} cfg @param {any} planner @param {any[]} tickets
 * @param {(cmd:string,args:string[],opts?:any)=>Promise<{ok:boolean,out:string,err:string}>} sh
 * @returns {Promise<{severity:'none'|'low'|'medium'|'high', summary:string, findings:any[]}>}
 */
export async function reviewPlan(cfg, planner, tickets, sh, focus = null) {
  const dir = planner.dir;
  // Incremental re-verify: grade ONLY these 1-based ticket numbers (the ones whose
  // content changed); the rest are already verified and serve as context.
  const focusSet = Array.isArray(focus) && focus.length ? new Set(focus) : null;
  // Scope the verifier to ONLY the repos the tickets target — and capture each
  // repo's base branch so we can read it at origin/<base> (not the parked tree).
  const known = new Set(listRepos(cfg).map((r) => r.path));
  /** @type {Record<string,string>} */
  const repoBase = {};
  for (const t of tickets) {
    const r = t.repo || t.dir;
    if (r && known.has(r) && !repoBase[r]) repoBase[r] = t.baseBranch || 'dev';
  }
  // Number the tickets 1-based for human-referenceable findings. Resolve each
  // dependsOn index to "#<n> <title>" so the model never has to reconcile 0-based
  // vs 1-based itself (a recurring off-by-one: it read [3,2,1] as missing "2").
  const numbered = tickets.map((t, i) => ({
    n: i + 1, title: t.title, repo: t.repo || t.dir, role: t.role,
    goal: t.goal, criteria: t.criteria,
    steps: t.steps || '', context: t.context || '',
    dependsOn: (t.dependsOn || []).map((d) => (tickets[d] ? `#${d + 1} ${tickets[d].title}` : `#${d + 1}`))
  }));
  const permFile = cfg.verifierPermFile || path.join(cfg.agentPermDir, 'planner.json');
  const { pathByRepo } = await prepareBaseTrees(cfg, repoBase);
  const repoLines = Object.entries(pathByRepo)
    .map(([repo, v]) => `- ${repo}  →  READ IT AT: ${v.path}  (a clean checkout of origin/${v.base} — read ONLY this path; ignore any other copy of the repo)`)
    .join('\n');
  const prompt = [
    `You are a release engineer reviewing a proposed ticket plan BEFORE the tickets are created.`,
    `Project: ${dir}`,
    repoLines ? `Repos — read each ONLY at the clean base-branch checkout given (do NOT guess, do NOT read the repo's normal working copy which may be on an unrelated branch):\n${repoLines}` : '',
    `PROPOSED TICKETS (JSON, ticket numbers are 1-based; "repo" is the logical repo — read it at its clean path above; "dependsOn" lists the tickets this one depends on as "#<number> <title>"):`,
    JSON.stringify(numbered, null, 1),
    ``,
    focusSet ? `INCREMENTAL RE-VERIFY: these tickets were edited and are the ONLY ones to grade: ${[...focusSet].map((n) => `#${n}`).join(', ')}. The other tickets are already verified — read them for context (dependencies, cross-repo handoffs, file overlap) but do NOT output findings for them. You MAY output plan-wide findings (ticket 0) only if an edited ticket creates a new plan-level problem.` : '',
    ``,
    `HOW TO READ THIS (critical — most false flags come from getting this wrong):`,
    `- The checkout shows the CURRENT base code, BEFORE any ticket is implemented. Each ticket DESCRIBES changes an engineer will make. A problem that exists in base code is NOT a finding if a ticket already prescribes fixing it.`,
    `- Before flagging ANYTHING, scan every ticket's goal + criteria for whether it already addresses the issue. If a ticket already says to do the fix, it is RESOLVED — do NOT flag it. Only flag a ticket that is MISSING a required step, prescribes the WRONG change, or is too vague to implement. When you do flag, quote the specific ticket text that is deficient.`,
    `- A dependency is SATISFIED if the producer ticket appears in the consumer's dependsOn list above. Do NOT report a dep as "missing" if it is already listed. Read the resolved "#<n> <title>" entries; do not re-derive indices.`,
    `- If a ticket cites specific evidence (e.g. "CONFIRMED: src/x.js line 61 posts camelCase"), OPEN that file and verify the claim before contradicting it. Never claim something "was not read" — read it.`,
    ``,
    `Now flag genuine problems:`,
    `1. REPO TARGETING — the target repo exists and is the right one. If a ticket consumes a package another ticket produces, open the consumer's package.json and confirm it imports THAT package name (not a sibling).`,
    `2. CROSS-REPO HANDOFF — if ticket B uses a library/package that ticket A builds, A must include a release step (version bump + publish) and B must pin the new version (a plain dependsOn only orders work; the consumer would still install the old published version). Flag a MISSING release/publish step as HIGH — but if A's goal/criteria already include the publish and B already pins it, that is RESOLVED.`,
    `3. DEPENDENCIES — every output a ticket needs is produced by a ticket in its dependsOn; the graph is acyclic. Only report a dep that is genuinely absent from the dependsOn list.`,
    `4. DECOMPOSITION — each ticket is one repo, independently shippable, with concrete verifiable criteria; no two parallel (non-dependent) tickets edit the same files.`,
    `5. TICKET QUALITY — each ticket must be detailed enough for a junior developer to implement without asking questions:`,
    `   - goal names the exact files/functions/routes involved (not vague "implement the feature") and cites file:line for non-obvious facts`,
    `   - criteria are testable: each check can be verified by running a specific command or inspecting a specific output`,
    `   - steps field exists and provides numbered, file-by-file implementation steps (flag as medium if missing or too vague to follow)`,
    `   - no step requires the developer to figure out WHERE to make a change — the file and location should be named`,
    `   Spot-check up to 2 cited file paths per ticket (the most load-bearing ones) to confirm they exist and contain what the ticket claims. Flag wrong paths as HIGH; flag vague or missing steps as MEDIUM.`,
    ``,
    `severity: "high" = the ticket will fail or build the wrong thing AS WRITTEN; "medium" = likely rework or missing detail that will block a junior developer; "low" = nit. If the plan is sound, return an empty findings array — do not invent nits.`,
    `Output ONLY a JSON object, no markdown, no prose:`,
    `{"summary":"<one line>","findings":[{"ticket":<number|0 for plan-wide>,"severity":"high|medium|low","issue":"<what>","fix":"<concrete fix>"}]}`
  ].filter(Boolean).join('\n').replace(/'/g, `'\\''`);
  const maxTurns = cfg.verifierMaxTurns || 80;
  const idleMs = cfg.verifierIdleMs || 180000, capMs = cfg.verifierCapMs || 1800000;
  // stream-json + the shared liveness runner: killed only on real silence (stuck),
  // never on a fixed deadline, so a long multi-repo read isn't cut off mid-flight.
  const cmd = `cd '${dir}' && ${cfg.claudeBin || 'claude'} -p --output-format stream-json --verbose --model sonnet --max-turns ${maxTurns} --settings '${permFile}' '${prompt}' </dev/null`;
  const runOnce = async () => interpret(cfg, await runClaudeStream(cmd, { idleMs, capMs }));
  try {
    let res = await runOnce();
    if (res.reason && res.retry) res = await runOnce(); // one retry for a transient flake
    // `failed` means we DON'T actually know the plan is safe — the create gate
    // treats it like a blocker, not a soft pass.
    if (res.reason) return { severity: 'medium', failed: true, summary: `verifier ${res.reason} — re-run Verify`, findings: [] };
    let findings = Array.isArray(res.parsed.findings) ? res.parsed.findings : [];
    // Safety net: a focused run must only return findings for graded tickets (or
    // plan-wide #0), so a stray re-flag of an untouched ticket can't slip through.
    if (focusSet) findings = findings.filter((f) => !f.ticket || focusSet.has(Number(f.ticket)));
    return { severity: worst(findings), summary: String(res.parsed.summary || '').slice(0, 300), findings };
  } catch (e) {
    return { severity: 'medium', failed: true, summary: `verifier failed to run (${e}) — re-run Verify`, findings: [] };
  }
}

/** @param {any[]} findings */
function worst(findings) {
  const rank = { high: 3, medium: 2, low: 1 };
  let max = 0;
  for (const f of findings) max = Math.max(max, rank[String(f && f.severity).toLowerCase()] || 0);
  return /** @type {'none'|'low'|'medium'|'high'} */ (['none', 'low', 'medium', 'high'][max]);
}

// Pull the JSON object out of the model output (tolerates stray prose / fences).
/** @param {string} out */
function parseFindings(out) {
  const trimmed = out.trim().replace(FENCE, '');
  try { return JSON.parse(trimmed); } catch {}
  const s = trimmed.indexOf('{'), e = trimmed.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(trimmed.slice(s, e + 1)); } catch {} }
  return null;
}
