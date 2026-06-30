<script>
  // File explorer (navigate /docker) + Monaco editor. Edits save to disk where
  // the terminals/agents see them. Ctrl/Cmd-S or the Save button writes.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { projectStore } from '$lib/projects.svelte.js';
  import MonacoEditor from '$lib/components/MonacoEditor.svelte';

  let cwd = $state(projectStore.active?.dir || '/workspace');
  /** @type {{name:string,path:string,isDir:boolean,size:number}[]} */
  let entries = $state([]);
  let openPath = $state('');
  let openContent = $state('');
  let status = $state('');
  /** @type {any} */
  let editorRef = $state();

  /** @param {string} p */
  async function loadDir(p) {
    try { const r = await api.fsList(p); cwd = r.path; entries = r.entries; }
    catch (e) { status = String(e); }
  }
  /** @param {{path:string,isDir:boolean}} e */
  async function open(e) {
    if (e.isDir) return loadDir(e.path);
    try { const r = await api.fsRead(e.path); openPath = r.path; openContent = r.content; status = ''; }
    catch (err) { status = String(err); }
  }
  /** @param {string} content */
  async function save(content) {
    if (!openPath) return;
    status = 'saving…';
    try { await api.fsWrite(openPath, content); status = 'saved ✓'; }
    catch (e) { status = `save failed: ${e}`; }
  }

  let crumbs = $derived.by(() => {
    const parts = cwd.split('/').filter(Boolean);
    let acc = '';
    return parts.map((p) => ({ label: p, path: (acc += '/' + p) }));
  });
  let parent = $derived(cwd.replace(/\/[^/]+$/, '') || '/');

  onMount(() => loadDir(cwd));
</script>

<div class="flex h-full">
  <!-- navigator -->
  <div class="w-72 shrink-0 border-r border-line flex flex-col">
    <div class="flex items-center gap-1 px-2 h-8 border-b border-line text-xs overflow-x-auto whitespace-nowrap">
      <button class="text-muted hover:text-content" title="Up" onclick={() => loadDir(parent)}>↑</button>
      {#each crumbs as c (c.path)}
        <span class="text-muted">/</span>
        <button class="hover:text-accent" onclick={() => loadDir(c.path)}>{c.label}</button>
      {/each}
    </div>
    <div class="flex-1 overflow-auto text-sm">
      {#each entries as e (e.path)}
        <button
          class="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-elevated {openPath === e.path ? 'bg-elevated text-accent' : 'text-content'}"
          onclick={() => open(e)}
        >
          <span class="opacity-60 w-4">{e.isDir ? '📁' : '📄'}</span>
          <span class="truncate">{e.name}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- editor -->
  <div class="flex-1 flex flex-col min-w-0">
    <div class="flex items-center gap-3 px-3 h-8 border-b border-line text-xs">
      <span class="truncate text-muted flex-1">{openPath || 'no file open'}</span>
      <span class="text-muted">{status}</span>
      {#if openPath}
        <button class="bg-green-700 hover:bg-green-600 text-white rounded px-2 py-0.5"
          onclick={() => save(editorRef?.getValue())}>Save</button>
      {/if}
    </div>
    <div class="flex-1 min-h-0">
      {#if openPath}
        {#key openPath}
          <MonacoEditor value={openContent} path={openPath} onSave={save} bind:this={editorRef} />
        {/key}
      {:else}
        <div class="h-full grid place-items-center text-muted text-sm">Pick a file to edit</div>
      {/if}
    </div>
  </div>
</div>
