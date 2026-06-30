<script>
  // One ticket card on the kanban board.
  import { st, isStale, RUNNING } from './status.js';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';
  /** @type {{
   *  task:any, showProject?:boolean, projectLabel?:string, chain?:string, selectable?:boolean, selected?:boolean,
   *  onToggle?:()=>void, onOpen?:()=>void, onStart?:()=>void, onApprove?:()=>void, onAccept?:()=>void, onRemove?:()=>void
   * }} */
  let {
    task, showProject = false, projectLabel = '', chain = '', selectable = false, selected = false,
    onToggle = () => {}, onOpen = () => {}, onStart = () => {}, onApprove = () => {}, onAccept = () => {}, onRemove = () => {}
  } = $props();
  let stale = $derived(isStale(task));
</script>

<div class="rounded-md border border-line bg-card p-2 text-xs space-y-1 {selected ? 'ring-1 ring-accent' : ''}">
  <div class="flex items-start gap-1.5">
    {#if selectable}<input type="checkbox" class="mt-0.5 accent-current" checked={selected} onclick={(e) => { e.stopPropagation(); onToggle(); }} />{/if}
    <button class="flex-1 min-w-0 text-left" onclick={onOpen}>
      {#if chain}<span class="text-[10px] text-muted font-mono mr-1">{chain}</span>{/if}
      <span class="text-content line-clamp-2">{task.title}</span>
    </button>
  </div>
  <div class="flex flex-wrap items-center gap-1 text-[10px] text-muted">
    {#if showProject && projectLabel}<span class="px-1 rounded bg-elevated text-content">{projectLabel}</span>{/if}
    {#if task.reviewing}
      <span class="flex items-center gap-1 text-blue-600 dark:text-blue-400"><span class="w-1.5 h-1.5 rounded-full bg-blue-500 dark:bg-blue-400 animate-pulse"></span>reviewing…</span>
    {:else}
      <span class="flex items-center gap-1 {st(task.status).cls}">{#if RUNNING.includes(task.status)}<span class="w-1.5 h-1.5 rounded-full {st(task.status).dot}"></span>{/if}{st(task.status).label}</span>
    {/if}
    {#if task.model}<span>· {task.model}</span>{/if}
    {#if task.role}<span>· {task.role}</span>{/if}
    {#if task.depBlocked}<span class="text-amber-600 dark:text-amber-400" title="blocked by dependencies">⛔</span>{/if}
    {#if task.autonomous}<span class="text-green-600 dark:text-green-400" title="autonomous: auto-approve + auto-accept on a clean review">🤖</span>{/if}
    {#if task.autoStart}<span title="auto-starts when its blockers finish">⏩</span>{/if}
    {#if task.autoReview && !task.autonomous}<span title="auto-review on">🔎</span>{/if}
    {#if task.review}<span title={task.review}>{task.review.startsWith('PASS') ? '✅' : '⚠️'}</span>{/if}
    {#if stale}<span class="text-red-600 dark:text-red-400" title="no update in 10m+">⚠ stuck?</span>{/if}
  </div>
  <div class="flex items-center gap-1 pt-0.5">
    {#if task.status === 'todo'}
      <button class="text-[11px] px-2 py-0.5 rounded bg-green-700 hover:bg-green-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
        disabled={task.depBlocked} onclick={onStart} title={task.depBlocked ? 'blocked by dependencies' : 'dispatch agent'}>Start</button>
    {:else if task.status === 'plan-review'}
      <button class="text-[11px] px-2 py-0.5 rounded bg-green-700 hover:bg-green-600 text-white" onclick={onApprove}>Approve</button>
    {:else if task.status === 'review'}
      <button class="text-[11px] px-2 py-0.5 rounded bg-green-700 hover:bg-green-600 text-white" onclick={onAccept}>Accept</button>
    {/if}
    <button class="text-[11px] px-2 py-0.5 rounded border border-line hover:bg-elevated" onclick={onOpen}>Open</button>
    {#if ['done', 'ended', 'error', 'todo'].includes(task.status)}
      <ConfirmButton onConfirm={onRemove} label="✕" armedLabel="✓ delete?" title="remove ticket" class="text-[11px] px-1.5 text-red-500 dark:text-red-400 opacity-60 hover:opacity-100 ml-auto rounded" />
    {/if}
  </div>
</div>
