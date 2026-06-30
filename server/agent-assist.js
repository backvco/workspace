// Claude-assisted ticket help (headless `claude -p`, read-only review profile).
// Two surfaces: enhance one ticket's draft, and advise on the whole backlog
// (ordering, dependencies, gaps, duplicates). Both ground themselves in the repo.
import path from 'node:path';

/** Pull the first JSON object out of model output. @param {string} out */
function parseJson(out) {
  try { const m = (out || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : { error: 'no json in output' }; }
  catch { return { error: 'could not parse', raw: (out || '').slice(0, 300) }; }
}
/** Pull the first JSON array out of model output. @param {string} out */
function parseJsonArray(out) {
  try { const m = (out || '').match(/\[[\s\S]*\]/); return m ? { tickets: JSON.parse(m[0]) } : { error: 'no json array', raw: (out || '').slice(0, 300) }; }
  catch { return { error: 'could not parse', raw: (out || '').slice(0, 300) }; }
}

/**
 * Plan an outcome into a set of ordered, per-repo tickets.
 * @param {any} cfg @param {{goal:string, dir:string, repos?:string[]}} input
 * @param {(cmd:string,args:string[],opts?:any)=>Promise<{ok:boolean,out:string,err:string}>} sh
 */
export async function planTickets(cfg, input, sh) {
  const permFile = path.join(cfg.agentPermDir, 'review.json');
  const repoList = input.repos && input.repos.length
    ? `Repositories in this project — assign each ticket to the single most relevant one:\n${input.repos.map((r) => `- ${r}`).join('\n')}`
    : '';
  const prompt = [
    `You are a tech lead planning work for the project at ${input.dir}.`,
    `Read the relevant CLAUDE.md files and code so the plan fits how this codebase actually works.`,
    repoList,
    ``,
    `OUTCOME TO DELIVER: ${input.goal}`,
    ``,
    `Break this into the SMALLEST set of independently-shippable tickets. ONE ticket = ONE repo.`,
    `Order them with dependencies (e.g. API before SDK before UI).`,
    `Return STRICT JSON ONLY: an array of objects`,
    `{"title":"short title","goal":"what to do, 1-3 sentences","criteria":"concrete done-when","role":"implementer|reviewer|planner|writer|triage","repo":"absolute repo path from the list above (or the project dir)","dependsOn":[0-based indexes of earlier tickets this needs]}`,
    `Keep it to a handful of tickets. No prose outside the JSON.`
  ].filter(Boolean).join('\n').replace(/'/g, `'\\''`);
  const cmd = `cd '${input.dir}' && ${cfg.claudeBin || 'claude'} -p --model opus --settings '${permFile}' '${prompt}'`;
  const r = await sh('bash', ['-lc', cmd], { timeout: 240000 });
  return parseJsonArray(r.out);
}

/**
 * @param {any} cfg @param {{dir:string, goal?:string, criteria?:string, role?:string}} input
 * @param {(cmd:string,args:string[],opts?:any)=>Promise<{ok:boolean,out:string,err:string}>} sh
 */
export async function enhanceTicket(cfg, input, sh) {
  const permFile = path.join(cfg.agentPermDir, 'review.json');
  const prompt = [
    `You are a tech lead refining ONE work ticket for the repo at ${input.dir}.`,
    `Skim the repo's CLAUDE.md and relevant code so the ticket fits how this codebase actually works.`,
    `Draft goal: ${input.goal || '(none given)'}`,
    input.criteria ? `Draft acceptance criteria: ${input.criteria}` : '',
    input.role ? `Intended role: ${input.role}` : '',
    `Return STRICT JSON only, no prose: {"goal":"sharper goal","criteria":"concrete, testable done-when","role":"implementer|reviewer|planner|writer|triage","note":"one-line risk or tip"}.`
  ].filter(Boolean).join('\n').replace(/'/g, `'\\''`);
  const cmd = `cd '${input.dir}' && ${cfg.claudeBin || 'claude'} -p --model opus --settings '${permFile}' '${prompt}'`;
  const r = await sh('bash', ['-lc', cmd], { timeout: 180000 });
  return parseJson(r.out);
}

/**
 * @param {any} cfg @param {any[]} tickets @param {string|undefined} dir
 * @param {(cmd:string,args:string[],opts?:any)=>Promise<{ok:boolean,out:string,err:string}>} sh
 */
export async function adviseBacklog(cfg, tickets, dir, sh) {
  if (!tickets.length) return { advice: '_No open tickets to review._' };
  const permFile = path.join(cfg.agentPermDir, 'review.json');
  const list = tickets.map((t, i) =>
    `${i + 1}. [${t.state}] (${t.id}) ${t.title} — ${t.goal || ''}${t.blockedBy?.length ? ` [blocked by: ${t.blockedBy.join(', ')}]` : ''}`).join('\n');
  const prompt = [
    `You are a delivery lead reviewing a backlog${dir ? ` for ${dir}` : ''}. Tickets (newest first):`,
    list,
    ``,
    `Find concrete problems: vague or duplicate tickets, missing prerequisites, risky ordering, missing/wrong dependencies, anything too big for one ticket.`,
    `Reply as a SHORT markdown bullet list of specific actions ("reorder X before Y", "split Z into …", "add a ticket for W", "mark A blocked by B"). No preamble.`
  ].join('\n').replace(/'/g, `'\\''`);
  const cwd = dir || cfg.termCwd;
  const cmd = `cd '${cwd}' && ${cfg.claudeBin || 'claude'} -p --model opus --settings '${permFile}' '${prompt}'`;
  const r = await sh('bash', ['-lc', cmd], { timeout: 180000 });
  return { advice: (r.out || '').trim() || '_No suggestions returned._' };
}
