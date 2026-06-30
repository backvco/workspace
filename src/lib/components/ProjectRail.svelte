<script>
  // Global project switcher. Selecting a project scopes the whole app to it and
  // swaps the tab set. "General" is the unscoped scratch context.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { projectStore, setActive, addProject, removeProject } from '$lib/projects.svelte.js';
  import { tabStore } from '$lib/tabs/store.svelte.js';
  import FilterSelect from '$lib/components/FilterSelect.svelte';
  import Avatar from '$lib/components/Avatar.svelte';

  /** @type {{ user?: {username:string,avatar?:string}|null, onLogout?: () => void, onSettings?: () => void }} */
  let { user = null, onLogout = () => {}, onSettings = () => {} } = $props();

  let adding = $state(false);
  let label = $state(''); let dir = $state(''); let root = $state('');
  let labelEdited = $state(false);
  /** @type {{dir:string,label:string}[]} */
  let folders = $state([]);
  /** @type {{root:string,label:string}[]} */
  let roots = $state([]);
  /** @type {Record<string, number>} */
  let tabCounts = $state({});

  async function loadTabCounts() {
    try { tabCounts = await api.tabCounts(); } catch {}
  }

  onMount(() => {
    loadTabCounts();
    api.roots().then((r) => { roots = r.roots || []; }).catch(() => {});
  });

  // Refresh counts whenever the active project's tab set changes (groups array mutates).
  $effect(() => {
    tabStore.groups; // track
    loadTabCounts();
  });

  /** @type {Record<string, any[]>} */
  let groups = $derived.by(() => {
    /** @type {Record<string, any[]>} */
    const g = {};
    for (const p of projectStore.list) (g[p.group] = g[p.group] || []).push(p);
    return g;
  });

  // True if any tab in the active project needs input.
  let activeProjectNeedsInput = $derived(tabStore.needsInput.size > 0);
  let folderOptions = $derived(folders.map((f) => ({ value: f.dir, label: f.label })));

  // Picking a root loads its addable folders (excludes already-added).
  async function pickRoot(/** @type {string} */ r) {
    root = r; dir = ''; folders = [];
    try { folders = (await api.availableFolders(r)).folders; } catch {}
  }
  // Default the project name to the folder's basename; keep it if the user edited it.
  function pickFolder() {
    if (!labelEdited) label = dir.split('/').filter(Boolean).pop() || '';
  }
  function reset() { adding = false; label = ''; dir = ''; root = ''; folders = []; labelEdited = false; }

  async function submit() {
    if (!label.trim() || !dir) return;
    // Auto-pick the single root so the user skips the root-selection step.
    await addProject({ label: label.trim(), dir });
    reset();
  }

  // When opening the add form with exactly one configured root, select it up front.
  $effect(() => {
    if (adding && !root && roots.length === 1) pickRoot(roots[0].root);
  });
</script>

<div class="w-52 shrink-0 h-full bg-card border-r border-line flex flex-col">
  <div class="h-9 flex items-center px-3 border-b border-line text-xs font-semibold tracking-wide text-muted">PROJECTS</div>

  <div class="flex-1 overflow-auto py-1 text-sm">
    <!-- Overview: cross-project agent dashboard -->
    <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated {projectStore.activeId === 'overview' ? 'bg-elevated text-content' : 'text-muted'}"
      onclick={() => setActive('overview')}>
      <span class="opacity-60">◎</span> Overview
    </button>
    <!-- General / scratch -->
    <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated {projectStore.activeId === 'default' ? 'bg-elevated text-content' : 'text-muted'}"
      onclick={() => setActive('default')}>
      <span class="opacity-60">~</span>
      <span class="flex-1 truncate">General</span>
      {#if projectStore.activeId === 'default' && activeProjectNeedsInput}
        <span class="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Needs input"></span>
      {/if}
      {#if tabCounts['default'] > 0}
        <span class="text-[10px] text-muted shrink-0">{tabCounts['default']}</span>
      {/if}
    </button>

    {#each Object.keys(groups) as g (g)}
      <div class="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wide text-muted">{g}</div>
      {#each groups[g] as p (p.id)}
        <div class="group flex items-center {projectStore.activeId === p.id ? 'bg-elevated' : ''}">
          <button class="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated {projectStore.activeId === p.id ? 'text-content' : 'text-muted'}"
            onclick={() => setActive(p.id)} title={p.dir}>
            <span class="opacity-60 shrink-0">{p.type === 'content' ? '✎' : '›_'}</span>
            <span class="truncate flex-1">{p.label}</span>
            {#if projectStore.activeId === p.id && activeProjectNeedsInput}
              <span class="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Needs input"></span>
            {/if}
            {#if tabCounts[p.id] > 0}
              <span class="text-[10px] text-muted shrink-0">{tabCounts[p.id]}</span>
            {/if}
          </button>
          <button class="opacity-0 group-hover:opacity-60 hover:opacity-100 text-xs text-red-500 dark:text-red-400 px-2" title="Remove project (keeps files)"
            onclick={() => removeProject(p.id)}>✕</button>
        </div>
      {/each}
    {/each}
  </div>

  <div class="border-t border-line p-2">
    {#if adding}
      <div class="space-y-1.5">
        <!-- Step 1: pick a configured root (skipped when there's only one) -->
        {#if roots.length > 1}
          <div class="flex flex-wrap gap-1">
            {#each roots as r (r.root)}
              <button class="flex-1 text-xs rounded px-2 py-1 border {root === r.root ? 'bg-elevated border-line text-content' : 'border-line text-muted hover:text-content'}"
                title={r.root} onclick={() => pickRoot(r.root)}>{r.label}</button>
            {/each}
          </div>
        {:else if roots.length === 0}
          <div class="text-xs text-muted px-1 py-1">No project roots configured. Set WORKSPACE_PROJECT_ROOTS.</div>
        {/if}
        <!-- Step 2: pick a folder (only shown once a root is chosen) -->
        {#if root}
          <FilterSelect block dense placeholder={folders.length ? 'folder…' : 'no addable folders'} bind:value={dir} options={folderOptions} onChange={pickFolder} />
        {/if}
        <!-- Step 3: name (defaults to folder basename, editable) -->
        {#if dir}
          <input class="w-full bg-elevated border border-line rounded px-2 py-1 text-sm" placeholder="project name"
            bind:value={label} oninput={() => (labelEdited = true)} />
        {/if}
        <div class="flex gap-2">
          <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!label.trim() || !dir} onclick={submit}>Add</button>
          <button class="text-xs text-muted hover:text-content px-2" onclick={reset}>Cancel</button>
        </div>
      </div>
    {:else}
      <div class="flex items-center gap-2">
        <button class="text-xs text-muted hover:text-content" onclick={() => (adding = true)}>+ Add project</button>
        <button class="ml-auto -my-2 shrink-0 leading-none flex items-center justify-center min-w-[44px] min-h-[44px] rounded text-muted hover:text-content hover:bg-line/50" title="Settings" aria-label="Settings" onclick={onSettings}>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
      </div>
    {/if}
  </div>

  <!-- footer: signed-in user / logout -->
  <div class="border-t border-line px-3 py-2 flex items-center gap-2 text-xs text-muted">
    {#if user}
      <Avatar src={user.avatar} name={user.username} size={20} />
      <span class="flex-1 truncate" title="Signed in as {user.username}">{user.username}</span>
    {:else}
      <span class="flex-1"></span>
    {/if}
    {#if user}
      <button class="hover:text-content shrink-0 flex items-center justify-center min-w-[44px] min-h-[44px] -my-2 rounded hover:bg-line/50" title="Sign out" aria-label="Sign out" onclick={onLogout}>
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      </button>
    {/if}
  </div>
</div>
