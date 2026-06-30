<script>
  // Plan header bar: name (inline-editable), progress, and the plan-level controls.
  // The control shown depends on plan state: Open PR (all done) / Resume (paused) /
  // Pause (running — at least one ticket in flight) / Run (idle with work left).
  // Reused by the board's filter banner and each swimlane header.
  import { RUNNING, NEEDS, DONE } from './status.js';
  /** @type {{ plan:string, tasks:any[], busy?:boolean, onCtl:(kind:'run'|'pause'|'resume'|'pr')=>void, onRename?:(to:string)=>void, onChat?:()=>void, onLocal?:(kind:'apply'|'revert')=>void, onArchive?:()=>void }} */
  let { plan, tasks, busy = false, onCtl, onRename, onChat, onLocal, onArchive } = $props();
  let anyDone = $derived(tasks.some((/** @type {any} */ t) => DONE.includes(t.status)));
  let done = $derived(tasks.filter((/** @type {any} */ t) => DONE.includes(t.status)).length);
  let paused = $derived(tasks.some((/** @type {any} */ t) => t.paused));
  let allDone = $derived(tasks.length > 0 && done === tasks.length);
  // "Running" = at least one ticket has a live agent in the pipeline (working or
  // waiting on you), so it's NOT just sitting in todo/done. Drives Run vs Pause.
  let running = $derived(tasks.some((/** @type {any} */ t) => RUNNING.includes(t.status) || NEEDS.includes(t.status)));
  let pct = $derived(tasks.length ? Math.round(done / tasks.length * 100) : 0);

  let editing = $state(false);
  let draft = $state('');
  function startEdit() { if (!onRename) return; draft = plan; editing = true; }
  function commit() { const v = draft.trim(); editing = false; if (v && v !== plan) onRename?.(v); }
  /** @param {KeyboardEvent} e */
  function onKey(e) { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') editing = false; }
</script>

<div class="flex items-center gap-3 min-w-0 flex-1">
  <div class="min-w-0">
    {#if editing}
      <!-- svelte-ignore a11y_autofocus -->
      <input class="text-sm font-medium bg-canvas border border-accent rounded px-1 py-0.5 w-56 outline-none"
        value={draft} oninput={(e) => (draft = e.currentTarget.value)} onblur={commit} onkeydown={onKey} autofocus />
    {:else}
      <div class="text-sm font-medium truncate flex items-center gap-1">
        🧩 {plan}
        {#if onRename}<button class="text-[10px] text-muted hover:text-content shrink-0" title="Rename plan" onclick={startEdit}>✎</button>{/if}
        {#if paused}<span class="text-amber-600 dark:text-amber-400 text-[11px]">⏸ paused</span>{/if}
      </div>
    {/if}
    <div class="text-[11px] text-muted">{done}/{tasks.length} done</div>
  </div>
  <div class="w-28 h-1.5 rounded bg-elevated overflow-hidden shrink-0"><div class="h-full bg-green-600" style="width:{pct}%"></div></div>
  <div class="ml-auto flex items-center gap-2 shrink-0">
    {#if onChat && anyDone}<button class="text-xs border border-line text-muted rounded px-2.5 py-1 hover:bg-elevated hover:text-content" onclick={() => onChat?.()} title="Open one chat about this whole plan — it reads the integrated changes, summarizes what was built, and walks you through testing it">💬 Discuss plan</button>{/if}
    {#if onLocal && anyDone}
      <button class="text-xs border border-emerald-600/50 text-emerald-700 dark:text-emerald-300 rounded px-2.5 py-1 hover:bg-emerald-100 dark:hover:bg-emerald-600/10" onclick={() => onLocal?.('apply')} title="Check out this plan's branches into your live repos so you can run and test the integrated work">🧪 Test locally</button>
      <button class="text-xs border border-line text-muted rounded px-2.5 py-1 hover:bg-elevated hover:text-content" onclick={() => onLocal?.('revert')} title="Put the repos back on their base branch (dev) and restore any stashed local edits">↩ Restore dev</button>
    {/if}
    {#if allDone}
      {#if onArchive}<button class="text-xs border border-line text-muted rounded px-2.5 py-1 hover:bg-elevated hover:text-content" onclick={() => onArchive?.()} title="Mark plan as shipped — hides it from the board (toggle 'Show archived' to revisit)">✓ Archive</button>{/if}
      <button class="text-xs bg-indigo-700 hover:bg-indigo-600 text-white rounded px-2.5 py-1 disabled:opacity-40" disabled={busy} onclick={() => onCtl('pr')} title="Open the single plan → base PR">🚀 Open plan PR</button>
    {:else if paused}
      <button class="text-xs bg-amber-700 hover:bg-amber-600 text-white rounded px-2.5 py-1 disabled:opacity-40" disabled={busy} onclick={() => onCtl('resume')} title="Clear the hold and start every ready ticket">▶ Resume</button>
    {:else if running}
      <button class="text-xs border border-amber-500/50 text-amber-700 dark:text-amber-300 rounded px-2 py-1 hover:bg-amber-100 dark:hover:bg-amber-500/10 disabled:opacity-40" disabled={busy} onclick={() => onCtl('pause')} title="Finish the current ticket, then hold before the next until you resume. Running agents are not interrupted.">⏸ Pause</button>
    {:else}
      <button class="text-xs bg-green-800 hover:bg-green-700 text-white rounded px-2.5 py-1 disabled:opacity-40" disabled={busy} onclick={() => onCtl('run')} title="Run autonomously: auto-approve plans, auto-accept clean reviews, auto-advance; start all ready tickets now">▶ Run</button>
    {/if}
  </div>
</div>
