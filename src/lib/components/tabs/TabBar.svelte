<script>
  // One group's tab strip + tool launcher. Click to activate, X to close,
  // double-click to rename, drag to reorder / move to another group. The +
  // opens a menu of every registered tool (into THIS group).
  import { onMount } from 'svelte';
  import { tabStore, activateTab, activateGroup, closeTab, closeOthers, openTerminal, openTool, renameTab, moveTab, beginDrag, endDrag, dropOnGroup, clearNeedsInput } from '$lib/tabs/store.svelte.js';
  import { allTools } from '$lib/tabs/registry.js';
  import { projectStore } from '$lib/projects.svelte.js';

  /** @type {{ group: { id: string, tabs: any[] } }} */
  let { group } = $props();

  let moveTargets = $derived(
    [{ id: 'default', label: 'General' }, ...projectStore.list.map((p) => ({ id: p.id, label: `${p.group ? p.group + ' / ' : ''}${p.label}` }))]
      .filter((t) => t.id !== projectStore.activeId)
  );
  /** @param {string} tabId @param {string} pid */
  async function doMove(tabId, pid) { ctxMenu = null; await moveTab(tabId, pid); }

  /** @type {string | null} */
  let editingId = $state(null);
  let draft = $state('');
  let menuOpen = $state(false);
  /** @type {{ tabId: string, x: number, y: number } | null} */
  let ctxMenu = $state(null);
  let isTouch = $state(false);
  let dropId = $state(''); // tab being hovered as a drop target
  let dropEnd = $state(false);
  /** @type {any} */
  let pressTimer;
  onMount(() => { isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches; });

  /** @param {TouchEvent} e @param {string} tabId */
  function pressStart(e, tabId) { const t = e.touches[0]; pressTimer = setTimeout(() => { ctxMenu = { tabId, x: t.clientX, y: t.clientY }; }, 500); }
  function pressEnd() { clearTimeout(pressTimer); }

  /** @param {{ id: string, title: string }} tab */
  function startRename(tab) { editingId = tab.id; draft = tab.title; }
  function commitRename() { if (editingId) renameTab(editingId, draft.trim()); editingId = null; }
  /** @param {{ id: string, label?: string, singleton?: boolean }} tool */
  function launch(tool) {
    menuOpen = false;
    activateGroup(group.id); // open into THIS group
    if (tool.id === 'terminal') openTerminal();
    else openTool({ toolId: tool.id, title: tool.label || tool.id, singleton: tool.singleton });
  }
</script>

<svelte:window onclick={() => { menuOpen = false; ctxMenu = null; }} />

<div class="flex items-stretch h-9 bg-card border-b border-line select-none">
  <div class="flex items-stretch overflow-x-auto min-w-0 flex-1" role="tablist" tabindex="-1"
    ondragover={(e) => { e.preventDefault(); dropEnd = true; }}
    ondragleave={() => (dropEnd = false)}
    ondrop={() => { dropOnGroup(group.id, null); dropEnd = false; dropId = ''; }}>
    {#each group.tabs as tab (tab.id)}
      <div
        role="tab" tabindex="0" draggable="true"
        class="group flex items-center gap-2 px-3 max-w-56 border-r border-line cursor-pointer text-sm whitespace-nowrap
               {tabStore.isActive(tab.id) ? 'bg-canvas text-content border-t-2 border-t-accent' : 'text-muted hover:bg-elevated border-t-2 border-t-transparent'}
               {dropId === tab.id ? 'border-l-2 border-l-accent' : ''}"
        onclick={() => { activateTab(tab.id); clearNeedsInput(tab.id); }}
        ondblclick={() => startRename(tab)}
        oncontextmenu={(e) => { e.preventDefault(); ctxMenu = { tabId: tab.id, x: e.clientX, y: e.clientY }; }}
        ondragstart={() => beginDrag(tab.id, group.id)}
        ondragend={() => { endDrag(); dropId = ''; }}
        ondragover={(e) => { e.preventDefault(); e.stopPropagation(); dropId = tab.id; }}
        ondragleave={() => { if (dropId === tab.id) dropId = ''; }}
        ondrop={(e) => { e.stopPropagation(); dropOnGroup(group.id, tab.id); dropId = ''; dropEnd = false; }}
        ontouchstart={(e) => pressStart(e, tab.id)} ontouchend={pressEnd} ontouchmove={pressEnd}
        onkeydown={(e) => e.key === 'Enter' && activateTab(tab.id)}
      >
        <span class="relative text-xs opacity-50 font-mono">
          {tab.params?.attached ? '◆' : '›_'}
          {#if tabStore.needsInput.has(tab.id)}
            <span class="absolute -top-0.5 -right-1 w-1.5 h-1.5 rounded-full bg-amber-400"></span>
          {/if}
        </span>
        {#if editingId === tab.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input class="bg-elevated text-content text-sm px-1 w-28 outline-none rounded" bind:value={draft} autofocus
            onblur={commitRename} onkeydown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') editingId = null; }} />
        {:else}
          <span class="truncate">{tab.title}</span>
        {/if}
        <button class="ml-auto text-xs hover:opacity-100 {isTouch ? 'opacity-60' : 'opacity-0 group-hover:opacity-70'}" title="Rename (or double-click)"
          onclick={(e) => { e.stopPropagation(); startRename(tab); }}>✎</button>
        <button class="text-xs hover:opacity-100 {isTouch ? 'opacity-60' : 'opacity-0 group-hover:opacity-70'}" title="Close tab"
          onclick={(e) => { e.stopPropagation(); closeTab(tab.id); }}>✕</button>
      </div>
    {/each}
    {#if dropEnd}<div class="w-6 border-l-2 border-l-accent"></div>{/if}
  </div>

  <div class="relative shrink-0 border-l border-line">
    <button class="px-3 h-full text-muted hover:text-content hover:bg-elevated text-base leading-none" title="Open a tool"
      onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen; }}>+</button>
    {#if menuOpen}
      <div class="absolute z-30 top-full right-0 min-w-44 bg-elevated border border-line rounded-md shadow-lg py-1">
        {#each allTools() as tool (tool.id)}
          <button class="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-content hover:bg-card text-left"
            onclick={(e) => { e.stopPropagation(); launch(tool); }}>
            <span class="text-xs opacity-50 w-4">{tool.id === 'terminal' ? '›_' : '▣'}</span>
            <span>{tool.label || tool.id}</span>
            {#if tool.id === 'terminal'}<span class="ml-auto text-xs text-muted">new</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if ctxMenu}
  <div class="fixed z-40 min-w-36 max-h-80 overflow-auto bg-elevated border border-line rounded-md shadow-lg py-1 text-sm"
    style:left="{ctxMenu.x}px" style:top="{ctxMenu.y}px">
    <button class="block w-full text-left px-3 py-1.5 text-content hover:bg-card"
      onclick={() => { const t = group.tabs.find((x) => x.id === ctxMenu?.tabId); if (t) startRename(t); ctxMenu = null; }}>Rename</button>
    <button class="block w-full text-left px-3 py-1.5 text-content hover:bg-card"
      onclick={() => { if (ctxMenu) closeTab(ctxMenu.tabId); ctxMenu = null; }}>Close</button>
    <button class="block w-full text-left px-3 py-1.5 text-muted hover:bg-card"
      onclick={() => { if (ctxMenu) closeOthers(ctxMenu.tabId); ctxMenu = null; }}>Close others in group</button>
    {#if moveTargets.length}
      <div class="border-t border-line my-1"></div>
      <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">Move to project</div>
      {#each moveTargets as m (m.id)}
        <button class="block w-full text-left px-3 py-1.5 text-content hover:bg-card"
          onclick={() => { if (ctxMenu) doMove(ctxMenu.tabId, m.id); }}>{m.label}</button>
      {/each}
    {/if}
  </div>
{/if}
