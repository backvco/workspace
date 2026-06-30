<script>
  // Agent Manager — List (master/detail) or Board (kanban), scoped to the active
  // project. Polls while visible.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { useTab } from '$lib/tabs/context.js';
  import { projectStore } from '$lib/projects.svelte.js';
  import AgentList from './AgentList.svelte';
  import AgentDetail from './AgentDetail.svelte';
  import Board from './Board.svelte';
  import TicketPanel from './TicketPanel.svelte';

  const tab = useTab();
  let scopeDir = $derived(projectStore.active?.dir || '');
  /** @type {any[]} */
  let tasks = $state([]);
  let selectedId = $state('');
  let showNew = $state(false);
  let mode = $state('board'); // board | split

  async function load() { try { tasks = (await api.agentList()).tasks; } catch {} }
  onMount(() => { try { mode = localStorage.getItem('agentsMode') || 'board'; } catch {} load(); });
  // Load immediately when the tab becomes active (so freshly-created tickets show
  // up at once instead of after the next poll), then keep polling while visible.
  $effect(() => { if (!tab.isActive()) return; load(); const id = setInterval(load, 4000); return () => clearInterval(id); });
  /** @param {string} m */
  function setMode(m) { mode = m; try { localStorage.setItem('agentsMode', m); } catch {} }

  let scoped = $derived(scopeDir ? tasks.filter((t) => (t.dir || '').startsWith(scopeDir)) : tasks);
  let selected = $derived(scoped.find((t) => t.id === selectedId) || null);
  $effect(() => { const s = tab.params?.()?.selectId; if (s) { selectedId = s; mode = 'split'; } });
  $effect(() => {
    if (selectedId && scoped.some((t) => t.id === selectedId)) return;
    if (scoped.length) selectedId = (scoped.find((t) => t.needsYou) || scoped[0]).id;
  });
</script>

<div class="flex flex-col h-full text-content text-sm">
  <div class="flex items-center gap-1 px-2 h-9 border-b border-line text-xs shrink-0">
    <button class="px-2 py-1 rounded {mode === 'split' ? 'bg-elevated text-content' : 'text-muted hover:text-content'}" onclick={() => setMode('split')}>List</button>
    <button class="px-2 py-1 rounded {mode === 'board' ? 'bg-elevated text-content' : 'text-muted hover:text-content'}" onclick={() => setMode('board')}>Board</button>
  </div>

  <div class="flex-1 min-h-0">
    {#if mode === 'board'}
      <Board tasks={scoped} onChanged={load} onNew={() => (showNew = true)} onOpen={(t) => { selectedId = t.id; setMode('split'); }} />
    {:else}
      <div class="flex h-full">
        <AgentList tasks={scoped} {selectedId} onSelect={(id) => (selectedId = id)} onNew={() => (showNew = true)} onRefresh={load} />
        <div class="flex-1 min-w-0">
          {#if selected}
            <AgentDetail task={selected} allTasks={scoped} onChanged={load} />
          {:else}
            <div class="grid place-items-center h-full text-muted text-sm">Select a ticket, or <span class="text-content mx-1">+ New</span>.</div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

{#if showNew}
  <TicketPanel tickets={scoped} onClose={() => (showNew = false)} onDone={load} />
{/if}
