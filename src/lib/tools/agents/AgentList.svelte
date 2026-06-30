<script>
  // Left column: filterable list of the project's agents + New button.
  import FilterSelect from '$lib/components/FilterSelect.svelte';
  import { st, NEEDS, RUNNING, DONE, ORDER, isStale, chainNumbersByPlan } from './status.js';

  /** @type {{ tasks: any[], selectedId: string, onSelect: (id:string)=>void, onNew: ()=>void, onRefresh?: ()=>(void|Promise<void>) }} */
  let { tasks, selectedId, onSelect, onNew, onRefresh } = $props();

  let seg = $state('all'); // all | needs | running | done
  let role = $state(''); let model = $state('');
  let chainNum = $derived(chainNumbersByPlan(tasks)); // ticket # per plan, matches the board

  let refreshing = $state(false);
  async function refresh() {
    if (refreshing || !onRefresh) return;
    refreshing = true;
    const t = new Promise((r) => setTimeout(r, 600));
    try { await onRefresh(); } finally { await t; refreshing = false; }
  }

  let filtered = $derived.by(() => {
    let xs = [...tasks];
    if (seg === 'todo') xs = xs.filter((t) => t.status === 'todo');
    else if (seg === 'needs') xs = xs.filter((t) => NEEDS.includes(t.status));
    else if (seg === 'running') xs = xs.filter((t) => RUNNING.includes(t.status));
    else if (seg === 'done') xs = xs.filter((t) => DONE.includes(t.status));
    if (role) xs = xs.filter((t) => t.role === role);
    if (model) xs = xs.filter((t) => (t.model || '') === model);
    return xs.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  });
  let needCount = $derived(tasks.filter((t) => NEEDS.includes(t.status)).length);
  let roleOpts = $derived([{ value: '', label: 'all roles' }, ...[...new Set(tasks.map((t) => t.role).filter(Boolean))].map((r) => ({ value: r, label: r }))]);
  let modelOpts = $derived([{ value: '', label: 'all models' }, ...[...new Set(tasks.map((t) => t.model).filter(Boolean))].map((m) => ({ value: m, label: m }))]);
  const SEGS = [['all', 'All'], ['todo', 'Todo'], ['needs', 'Needs'], ['running', 'Active'], ['done', 'Done']];
</script>

<div class="w-72 shrink-0 h-full border-r border-line flex flex-col">
  <div class="flex items-center gap-2 px-3 h-11 border-b border-line shrink-0">
    <h2 class="font-semibold text-sm">Agents</h2>
    {#if needCount}<span class="text-xs bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 rounded px-1.5 py-0.5">{needCount}</span>{/if}
    {#if onRefresh}<button class="ml-auto text-xs border border-line text-muted rounded px-2 py-1 hover:bg-elevated hover:text-content disabled:opacity-60" disabled={refreshing} onclick={refresh} title="Reload tickets from the server"><span class="inline-block {refreshing ? 'animate-spin' : ''}">↻</span></button>{/if}
    <button class="{onRefresh ? '' : 'ml-auto'} text-xs bg-green-700 hover:bg-green-600 text-white rounded px-2.5 py-1" onclick={onNew}>+ New</button>
  </div>

  <div class="px-2 py-2 border-b border-line space-y-2 shrink-0">
    <div class="flex gap-0.5 text-[11px]">
      {#each SEGS as [v, l] (v)}
        <button class="px-1.5 py-1 rounded whitespace-nowrap shrink-0 {seg === v ? 'bg-elevated text-content' : 'text-muted hover:text-content'}" onclick={() => (seg = v)}>{l}</button>
      {/each}
    </div>
    <div class="flex gap-1">
      <FilterSelect dense placeholder="role" bind:value={role} options={roleOpts} filter={false} />
      <FilterSelect dense placeholder="model" bind:value={model} options={modelOpts} filter={false} />
    </div>
  </div>

  <div class="flex-1 overflow-auto divide-y divide-line">
    {#each filtered as t (t.id)}
      <button class="block w-full text-left px-3 py-2.5 hover:bg-elevated {selectedId === t.id ? 'bg-elevated' : ''}" onclick={() => onSelect(t.id)}>
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full shrink-0 {t.reviewing ? 'bg-blue-500 dark:bg-blue-400 animate-pulse' : st(t.status).dot}"></span>
          {#if chainNum.get(t.id)}<span class="text-[10px] text-muted font-mono shrink-0">#{chainNum.get(t.id)}</span>{/if}
          <span class="truncate flex-1 text-sm">{t.title}</span>
          {#if t.needsYou && !t.reviewing}<span class="text-[10px] text-amber-600 dark:text-amber-400">●</span>{/if}
        </div>
        <div class="text-[11px] text-muted truncate pl-4">
          {#if t.reviewing}<span class="text-blue-600 dark:text-blue-400">🔎 reviewing…</span>{:else}<span class={st(t.status).cls}>{st(t.status).label}</span>{/if}{#if t.model} · {t.model}{/if}{#if t.role} · {t.role}{/if}{#if t.depBlocked} · <span class="text-amber-600 dark:text-amber-400">⛔ deps</span>{/if}{#if isStale(t)} · <span class="text-red-600 dark:text-red-400">⚠ stuck?</span>{/if}
        </div>
      </button>
    {:else}
      <div class="px-3 py-8 text-center text-muted text-xs">No agents{seg !== 'all' ? ' in this filter' : ' yet'}.</div>
    {/each}
  </div>
</div>
