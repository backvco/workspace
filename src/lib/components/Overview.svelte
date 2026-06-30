<script>
  // Cross-project mission control: metrics, a Claude backlog advisor, and a board
  // (or list) of every ticket/agent everywhere. Click one to jump to its project.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { projectStore, setActive } from '$lib/projects.svelte.js';
  import { openTool, updateTab } from '$lib/tabs/store.svelte.js';
  import { st, ORDER } from '$lib/tools/agents/status.js';
  import Board from '$lib/tools/agents/Board.svelte';
  import TicketPanel from '$lib/tools/agents/TicketPanel.svelte';

  /** @type {any[]} */
  let tasks = $state([]);
  /** @type {any} */
  let metrics = $state(null);
  let mode = $state('board'); // board | list
  let showNew = $state(false);
  let advice = $state(''); let advising = $state(false); let showAdvice = $state(false);

  async function load() {
    try { tasks = (await api.agentList()).tasks; } catch {}
    try { metrics = await api.agentMetrics(); } catch {}
  }
  onMount(() => { load(); const id = setInterval(load, 4000); return () => clearInterval(id); });

  /** @param {any} t */
  function projectOf(t) {
    const ps = projectStore.list.filter((p) => (t.dir || '').startsWith(p.dir)).sort((a, b) => b.dir.length - a.dir.length);
    return ps[0] || null;
  }
  /** @param {any} t */
  const projectLabel = (t) => { const p = projectOf(t); return p ? `${p.group} / ${p.label}` : (t.ns || ''); };

  let rows = $derived([...tasks].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9)));

  /** @param {any} t */
  async function jump(t) {
    const pid = projectOf(t)?.id || t.ns || 'default';
    await setActive(pid);
    const id = openTool({ toolId: 'agents', title: 'Agents', singleton: true, params: { selectId: t.id } });
    updateTab(id, { params: { selectId: t.id } });
  }

  async function advise() {
    advising = true; showAdvice = true;
    try { advice = (await api.agentAdvise()).advice; } catch (e) { advice = String(e); }
    advising = false;
  }
  /** @param {number} ms */
  const dur = (ms) => (!ms ? '—' : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${(ms / 3600000).toFixed(1)}h`);
</script>

<div class="h-full flex flex-col text-content">
  <div class="flex items-center gap-3 px-5 h-12 border-b border-line shrink-0">
    <h2 class="font-semibold">Overview</h2>
    {#if metrics}
      <div class="flex items-center gap-3 text-xs text-muted">
        <span>{metrics.total} tickets</span>
        <span class="text-green-600 dark:text-green-400">{metrics.active} active</span>
        {#if metrics.needs}<span class="text-amber-600 dark:text-amber-400">{metrics.needs} need you</span>{/if}
        <span>{metrics.doneToday} done today</span>
        <span>avg {dur(metrics.avgMs)}</span>
      </div>
    {/if}
    <div class="ml-auto flex items-center gap-1 text-xs">
      <button class="px-2 py-1 rounded {mode === 'board' ? 'bg-elevated text-content' : 'text-muted hover:text-content'}" onclick={() => (mode = 'board')}>Board</button>
      <button class="px-2 py-1 rounded {mode === 'list' ? 'bg-elevated text-content' : 'text-muted hover:text-content'}" onclick={() => (mode = 'list')}>List</button>
      <button class="px-2 py-1 rounded text-muted hover:text-content" onclick={advise} title="Have Claude review the backlog">🧠 Advise</button>
    </div>
  </div>

  {#if showAdvice}
    <div class="border-b border-line bg-card px-5 py-3 text-sm max-h-56 overflow-auto shrink-0">
      <div class="flex items-center gap-2 mb-1"><span class="text-[11px] uppercase tracking-wide text-muted">backlog advisor</span><button class="ml-auto text-xs text-muted hover:text-content" onclick={() => (showAdvice = false)}>close</button></div>
      {#if advising}<div class="text-muted text-xs">🧠 thinking…</div>{:else}<pre class="whitespace-pre-wrap text-xs">{advice}</pre>{/if}
    </div>
  {/if}

  <div class="flex-1 min-h-0">
    {#if mode === 'board'}
      <Board tasks={rows} onChanged={load} onNew={() => (showNew = true)} onOpen={jump} showProject={true} {projectLabel} />
    {:else}
      <div class="h-full overflow-auto divide-y divide-line">
        {#each rows as t (t.id)}
          <button class="flex items-center gap-3 w-full text-left px-5 py-3 hover:bg-elevated" onclick={() => jump(t)}>
            <span class="w-2 h-2 rounded-full shrink-0 {st(t.status).dot}"></span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm">{t.title}</div>
              <div class="text-[11px] text-muted truncate"><span class="text-content">{projectLabel(t)}</span> · <span class={st(t.status).cls}>{st(t.status).label}</span>{#if t.model} · {t.model}{/if}</div>
            </div>
            {#if t.needsYou}<span class="text-xs bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 rounded px-1.5 py-0.5 shrink-0">needs you</span>{/if}
          </button>
        {:else}
          <div class="px-5 py-12 text-center text-muted text-sm">No tickets anywhere yet.</div>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if showNew}
  <TicketPanel tickets={tasks} onClose={() => (showNew = false)} onDone={load} />
{/if}
