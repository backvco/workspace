// Auto-reviewer. A one-shot headless `claude -p` runs in the finished agent's
// worktree, judges the committed changes against the task + criteria, and writes
// a one-line verdict (PASS — … / ISSUES — …) onto the task. Best-effort; the
// operator still does the final Accept. Read-only permission profile.
import path from 'node:path';
import { runClaudeStream } from './claude-run.js';

/**
 * @param {any} cfg @param {any} task
 * @param {(cmd:string,args:string[],opts?:any)=>Promise<{ok:boolean,out:string,err:string}>} sh
 * @param {(cfg:any,id:string,patch:any)=>Promise<any>} setState
 */
export async function runReview(cfg, task, sh, setState) {
  await setState(cfg, task.id, { reviewing: true, reviewStartedAt: Date.now() });
  const permFile = path.join(cfg.agentPermDir, 'review.json');
  // Review the branch the agent ACTUALLY committed to (its worktree HEAD), not the
  // name we pre-created — agents sometimes re-branch. Diff against the pinned base.
  const head = await sh('git', ['-C', task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const reviewBranch = (head.out || '').trim() || task.branch;
  // Diff against the SAME ref the worktree forked from (origin/<base> when it
  // exists, else local <base>) so a stale local branch can't misattribute commits.
  const baseBranch = task.baseBranch || 'dev';
  const remote = `origin/${baseBranch}`;
  const base = (await sh('git', ['-C', task.worktree, 'rev-parse', '--verify', '--quiet', remote])).ok ? remote : baseBranch;
  const prompt = [
    `You are a senior code reviewer. Review the committed changes on the current branch (${reviewBranch}) in this repo.`,
    `It was forked from ${base}. Inspect the changes with git: "git log --oneline ${base}..HEAD" and "git diff ${base}...HEAD".`,
    `TASK: ${task.goal}`,
    task.criteria ? `ACCEPTANCE CRITERIA: ${task.criteria}` : '',
    `Judge correctness, whether it meets the criteria, and adherence to this project's CLAUDE.md.`,
    `Reply with EXACTLY ONE line: either "PASS — <short reason>" or "ISSUES — <short list>". No other text.`
  ].filter(Boolean).join('\n').replace(/'/g, `'\\''`);
  // Broad-read perms (verifier.json) so it never stalls on a denied command; run via
  // the shared liveness runner (kill only on real silence, not a fixed deadline) so a
  // slow-but-progressing review isn't cut off and silently defaulted to ISSUES.
  const reviewPerms = cfg.verifierPermFile || permFile;
  const maxTurns = cfg.reviewMaxTurns || 60;
  const idleMs = cfg.reviewIdleMs || 150000, capMs = cfg.reviewCapMs || 1500000;
  const cmd = `cd '${task.worktree}' && ${cfg.claudeBin || 'claude'} -p --output-format stream-json --verbose --model ${cfg.reviewModel || 'sonnet'} --max-turns ${maxTurns} --settings '${reviewPerms}' '${prompt}' </dev/null`;
  const runOnce = async () => interpret(await runClaudeStream(cmd, { idleMs, capMs }), idleMs, maxTurns);
  let res = await runOnce();
  if (res.retry) res = await runOnce(); // one retry for a transient flake (stall/cap excluded)
  await setState(cfg, task.id, { review: res.verdict, reviewedAt: Date.now(), reviewing: false });
  return res.verdict;
}

// Map a liveness-runner result to a verdict line. A genuine stall / cap / error
// yields a clear ISSUES reason (so the operator sees WHY, and autonomous holds)
// rather than a vague "no clear verdict"; only a transient flake asks for a retry.
function interpret(r, idleMs, maxTurns) {
  if (r.killed === 'idle') return { verdict: `ISSUES — review stalled (no output for ${Math.round(idleMs / 1000)}s); re-review or accept manually`, retry: false };
  if (r.killed === 'cap') return { verdict: `ISSUES — review exceeded the time cap; re-review or accept manually`, retry: false };
  if (r.subtype === 'error_max_turns') return { verdict: `ISSUES — review hit the ${maxTurns}-turn limit`, retry: false };
  if (r.isError || (r.subtype && r.subtype !== 'success')) return { verdict: `ISSUES — review errored (${r.subtype || 'unknown'})`, retry: true };
  if (r.result == null) return { verdict: `ISSUES — review produced no result${r.err ? ` (${r.err.slice(-120).trim()})` : ''}`, retry: true };
  const line = String(r.result).trim().split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
  if (/^(PASS|ISSUES)/i.test(line)) return { verdict: line, retry: false };
  return { verdict: `ISSUES — reviewer gave no clear verdict${line ? `: ${line.slice(0, 140)}` : ''}`, retry: !line };
}
