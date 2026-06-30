<script>
  // Right column: the selected ticket/agent. To-do tickets show a Start panel;
  // running ones show requests (approve/answer/review, with the auto-reviewer's
  // verdict) plus Console / Diff / Config / Activity.
  import { api } from '$lib/api.js';
  import { attachTerminal } from '$lib/tabs/store.svelte.js';
  import { st, parts, DONE } from './status.js';
  import AgentConsole from './AgentConsole.svelte';
  import AgentDiff from './AgentDiff.svelte';
  import AgentConfig from './AgentConfig.svelte';
  import AgentActivity from './AgentActivity.svelte';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';

  /** @type {{ task: any, allTasks?: any[], onChanged: ()=>void }} */
  let { task, allTasks = [], onChanged } = $props();

  let subtab = $state('console');
  let replyOpen = $state(false);
  let replyText = $state('');
  let starting = $state(false);

  // Live elapsed counter while the auto-reviewer runs (server stamps reviewStartedAt).
  let now = $state(Date.now());
  $effect(() => { if (!task.reviewing) return; const iv = setInterval(() => (now = Date.now()), 500); return () => clearInterval(iv); });
  let reviewElapsed = $derived(task.reviewing && task.reviewStartedAt ? Math.max(0, Math.round((now - task.reviewStartedAt) / 1000)) : 0);
  let rereviewing = $state(false);
  // Re-run the review pipeline (same as the agent calling `agent-report done`):
  // re-reviews and, in autonomous mode, auto-accepts on PASS and advances.
  async function reReview() { rereviewing = true; await api.agentEvent(task.id, 'done', 'manual re-review'); rereviewing = false; onChanged(); }

  async function start() { starting = true; const r = await api.agentStart(task.id); starting = false; if (r?.error) alert(r.error); onChanged(); }
  let chatting = $state(false);
  async function openChat() {
    chatting = true;
    const r = await api.agentChat(task.id);
    chatting = false;
    if (r?.error) { alert(r.error); return; }
    attachTerminal(r.sessionKey, '💬 ' + (r.title || task.title || 'ticket').slice(0, 18));
  }
  let discussing = $state(false);
  // Open the agent's own session seeded to explain the review findings and offer
  // resolution options to pick from — for issues you don't know the answer to.
  async function discuss() {
    discussing = true;
    const r = await api.agentDiscuss(task.id);
    discussing = false;
    if (r?.error) { alert(r.error); return; }
    attachTerminal(r.sessionKey, '🤝 ' + (r.title || task.title || 'ticket').slice(0, 18));
  }
  let planChatting = $state(false);
  // One chat about the whole plan — review/test all the completed work together.
  async function openPlanChatTab() {
    planChatting = true;
    const r = await api.agentPlanChat(task.id);
    planChatting = false;
    if (r?.error) { alert(r.error); return; }
    attachTerminal(r.sessionKey, '💬 ' + (r.title || 'plan').slice(0, 20));
  }
  async function approve() { replyOpen = false; await api.agentApprove(task.id); onChanged(); }
  async function accept() {
    replyOpen = false;
    const r = await api.agentAccept(task.id);
    if (r?.landConflict && !r.landConflict.landed) {
      const c = r.landConflict;
      alert(`Couldn't auto-merge into ${c.planBranch} (risk: ${c.risk}).\n\n${c.summary}\n\nProposed fix:\n${c.proposal || '—'}\n\nResolve the conflict manually, then accept again.`);
    } else if (r?.error) alert(r.error);
    onChanged();
  }
  // Plan Run/Pause/Resume/PR controls live on the board (filter by plan); here we
  // only surface whether this ticket's plan is currently paused.
  let planSiblings = $derived(task.plan ? allTasks.filter((/** @type {any} */ t) => t.plan === task.plan) : []);
  let planPaused = $derived(planSiblings.some((/** @type {any} */ t) => t.paused));
  async function sendReply() { if (!replyText.trim()) return; await api.agentReply(task.id, replyText.trim()); replyText = ''; replyOpen = false; onChanged(); }
  async function stop() { await api.agentStop(task.id); onChanged(); }
  async function remove() { await api.agentRemove(task.id); onChanged(); }
  function markActive() { if (task.needsYou) api.agentEvent(task.id, 'active').then(onChanged).catch(() => {}); }
  async function toggleAuto() { await api.agentLinks(task.id, { autoStart: !task.autoStart }); onChanged(); }
  async function toggleAutonomous() { await api.agentLinks(task.id, { autonomous: !task.autonomous }); onChanged(); }

  /** @param {string} id */
  const titleOf = (id) => allTasks.find((t) => t.id === id)?.title || id;
  let blockers = $derived((task.blockedBy || []).map((/** @type {string} */ id) => ({ id, title: titleOf(id), done: allTasks.find((t) => t.id === id)?.state === 'done' })));

  const TABS = [['console', 'Console'], ['diff', 'Diff'], ['config', 'Config'], ['activity', 'Activity']];
  let gated = $derived(['plan-review', 'review', 'blocked'].includes(task.status));
</script>

<div class="flex flex-col h-full min-w-0">
  <div class="flex items-center gap-2 px-4 h-11 border-b border-line shrink-0">
    <span class="w-2 h-2 rounded-full shrink-0 {task.reviewing ? 'bg-blue-400 animate-pulse' : st(task.status).dot}"></span>
    <div class="min-w-0">
      <div class="truncate text-sm font-medium">{task.title}</div>
      <div class="text-[11px] text-muted truncate">{#if task.reviewing}<span class="text-blue-600 dark:text-blue-400">🔎 reviewing…</span>{:else}<span class={st(task.status).cls}>{st(task.status).label}</span>{/if}{#if task.model} · {task.model}{/if} · {task.permission}{#if task.autoReview} · 🔎 auto-review{/if}{#if planPaused} · <span class="text-amber-600 dark:text-amber-400">⏸ plan paused</span>{/if}</div>
    </div>
    <div class="ml-auto flex items-center gap-2">
      {#if task.plan}<span class="text-[11px] text-muted truncate max-w-[10rem]" title="Plan controls (Run / Pause / Resume / Open PR) live on the board — filter by this plan">🧩 {task.plan}{#if planPaused} <span class="text-amber-600 dark:text-amber-400">⏸</span>{/if}</span>{/if}
      {#if task.branch && task.claudeSessionId}<button class="text-xs border border-line rounded px-2 py-1 hover:bg-elevated disabled:opacity-40" disabled={chatting} title="Open a full Claude chat on this ticket's session (its worktree + plan context). Continue or refine the work; it can update siblings with your OK." onclick={openChat}>{chatting ? '💬…' : '💬 Chat'}</button>{/if}
      {#if task.plan}<button class="text-xs border border-line rounded px-2 py-1 hover:bg-elevated disabled:opacity-40" disabled={planChatting} title="Open ONE chat about this whole plan — it reads the integrated changes across all tickets, summarizes what was built, and walks you through testing it" onclick={openPlanChatTab}>{planChatting ? '💬…' : '💬 Plan'}</button>{/if}
      <button class="text-xs px-1.5 py-0.5 rounded border {task.autonomous ? 'text-green-600 dark:text-green-400 border-green-600 dark:border-green-700' : 'text-muted border-line hover:text-content'}"
        title="Autonomous: auto-approve the plan and auto-accept on a clean (PASS) review" onclick={toggleAutonomous}>🤖</button>
      {#if task.status === 'todo'}<button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1 disabled:opacity-40" disabled={task.depBlocked || starting} onclick={start}>Start</button>{/if}
      {#if !DONE.includes(task.status) && task.status !== 'todo'}<button class="text-xs text-muted hover:text-content" onclick={stop}>Stop</button>{/if}
      <ConfirmButton onConfirm={remove} label="Remove" armedLabel="confirm remove" title="remove ticket" class="text-xs text-red-600 dark:text-red-400 hover:underline" />
    </div>
  </div>

  {#if blockers.length}
    <div class="px-4 py-2 border-b border-line text-[11px] text-muted shrink-0 flex items-center gap-2">
      <span>Blocked by: {#each blockers as b, i (b.id)}<span class={b.done ? 'line-through opacity-60' : 'text-amber-600 dark:text-amber-400'}>{b.title}</span>{#if i < blockers.length - 1}, {/if}{/each}</span>
      <button class="ml-auto shrink-0 px-1.5 py-0.5 rounded border border-line hover:bg-elevated {task.autoStart ? 'text-green-600 dark:text-green-400 border-green-600 dark:border-green-700' : ''}"
        title="Auto-start this ticket when all its blockers are done" onclick={toggleAuto}>⏩ auto-start {task.autoStart ? 'on' : 'off'}</button>
    </div>
  {/if}

  {#if task.status === 'todo'}
    <div class="flex-1 overflow-auto p-4 space-y-3 text-sm">
      <div><div class="text-[11px] uppercase tracking-wide text-muted mb-1">goal</div><div class="whitespace-pre-wrap">{task.goal || '—'}</div></div>
      {#if task.criteria}<div><div class="text-[11px] uppercase tracking-wide text-muted mb-1">done when</div><div class="whitespace-pre-wrap">{task.criteria}</div></div>{/if}
      {#if task.steps}<div><div class="text-[11px] uppercase tracking-wide text-muted mb-1">steps</div><div class="whitespace-pre-wrap">{task.steps}</div></div>{/if}
      {#if task.context}<div><div class="text-[11px] uppercase tracking-wide text-muted mb-1">context</div><div class="whitespace-pre-wrap text-muted">{task.context}</div></div>{/if}
      <button class="bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1.5 disabled:opacity-40" disabled={task.depBlocked || starting} onclick={start}>
        {task.depBlocked ? 'Blocked by dependencies' : starting ? 'Starting…' : 'Start — dispatch agent'}
      </button>
      <p class="text-[11px] text-muted">This ticket has no agent yet. Starting it spins up an agent in an isolated worktree and moves it to Planning.</p>
    </div>
  {:else}
    {#if gated}
      <div class="border-b border-line p-3 bg-card shrink-0 space-y-2">
        {#if task.status === 'plan-review'}
          <div class="text-[11px] uppercase tracking-wide text-amber-600 dark:text-amber-400">proposed plan — your call</div>
          <pre class="whitespace-pre-wrap text-xs bg-canvas rounded p-2 max-h-40 overflow-auto">{task.plan || '(no plan)'}</pre>
          <div class="flex gap-2">
            <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1" onclick={approve}>Approve</button>
            <button class="text-xs border border-line rounded px-3 py-1 hover:bg-elevated" onclick={() => (replyOpen = !replyOpen)}>Redirect…</button>
          </div>
        {:else if task.status === 'review'}
          <div class="text-[11px] uppercase tracking-wide text-blue-600 dark:text-blue-400">finished — review</div>
          {#if task.reviewing}
            <!-- running: animated, with elapsed; hide the stale prior verdict -->
            <div class="text-xs rounded p-2 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center gap-2">
              <span class="inline-block w-2 h-2 rounded-full bg-blue-500 dark:bg-blue-400 animate-pulse"></span>
              <span>🔎 reviewing the changes…</span>
              <span class="ml-auto tabular-nums text-blue-600/80 dark:text-blue-400/80">{reviewElapsed}s</span>
            </div>
          {:else if task.review}
            <div class="text-xs rounded p-2 {task.review.startsWith('PASS') ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'}">{task.review}</div>
          {/if}
          <div class="text-xs bg-canvas rounded p-2">{#each parts(task.summary) as p}{#if p.startsWith('http')}<a href={p} target="_blank" rel="noreferrer" class="text-accent hover:underline break-all">{p}</a>{:else}{p}{/if}{/each}</div>
          <div class="flex gap-2 flex-wrap">
            <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1 disabled:opacity-40" disabled={task.reviewing} onclick={accept}>Accept</button>
            {#if task.branch && task.claudeSessionId}<button class="text-xs border border-indigo-400/60 dark:border-indigo-500/50 text-indigo-600 dark:text-indigo-300 rounded px-3 py-1 hover:bg-indigo-100 dark:hover:bg-indigo-500/10 disabled:opacity-40" disabled={discussing} title="Talk it through with the agent that wrote this — it explains each finding and offers resolution options to pick from (incl. discuss further)" onclick={discuss}>{discussing ? '🤝…' : '🤝 Discuss'}</button>{/if}
            <button class="text-xs border border-blue-400/60 dark:border-blue-500/50 text-blue-600 dark:text-blue-300 rounded px-3 py-1 hover:bg-blue-100 dark:hover:bg-blue-500/10 disabled:opacity-40" disabled={task.reviewing || rereviewing} title="Re-run the auto-review on the latest commits (e.g. after you fixed it via Discuss) — re-reviews and, if autonomous + clean, auto-accepts and advances. Saves running agent-report done." onclick={reReview}>{rereviewing || task.reviewing ? '🔁…' : '🔁 Re-review'}</button>
            <button class="text-xs border border-line rounded px-3 py-1 hover:bg-elevated" onclick={() => (replyOpen = !replyOpen)}>Request changes…</button>
            {#if task.branch}<button class="text-xs border border-line rounded px-3 py-1 hover:bg-elevated" onclick={() => (subtab = 'diff')}>View diff</button>{/if}
          </div>
        {:else}
          <div class="text-[11px] uppercase tracking-wide text-amber-600 dark:text-amber-400">agent asks</div>
          <div class="text-xs bg-canvas rounded p-2">{task.question || '(needs a decision)'}</div>
        {/if}
        {#if replyOpen || task.status === 'blocked'}
          <div class="flex gap-2">
            <input class="flex-1 bg-elevated border border-line rounded px-2 py-1 text-sm" placeholder="your answer / redirect…" bind:value={replyText} onkeydown={(e) => { if (e.key === 'Enter') sendReply(); }} />
            <button class="text-xs bg-accent text-white rounded px-3 py-1" onclick={sendReply}>Send</button>
            {#if task.status !== 'blocked'}<button class="text-xs text-muted px-2" onclick={() => (replyOpen = false)}>Cancel</button>{/if}
          </div>
        {/if}
      </div>
    {/if}

    <div class="flex gap-1 px-2 h-8 items-center border-b border-line text-xs shrink-0">
      {#each TABS as [v, l] (v)}
        <button class="px-2 py-1 rounded {subtab === v ? 'bg-elevated text-content' : 'text-muted hover:text-content'}" onclick={() => { subtab = v; if (v === 'console') markActive(); }}>{l}</button>
      {/each}
    </div>
    <div class="flex-1 min-h-0">
      {#if subtab === 'console'}<AgentConsole {task} active={subtab === 'console'} />
      {:else if subtab === 'diff'}<AgentDiff {task} />
      {:else if subtab === 'activity'}<AgentActivity {task} />
      {:else}<AgentConfig {task} />{/if}
    </div>
  {/if}
</div>
