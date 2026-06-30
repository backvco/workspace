<script>
  // Git panel. Default = working tree (uncommitted changes on the current branch:
  // stage/commit/push/PR). The branch picker BROWSES another branch read-only
  // (compare vs current) WITHOUT checking it out — the current branch is fixed.
  // Switching branches is the explicit Checkout button only.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { useTab } from '$lib/tabs/context.js';
  import { projectStore } from '$lib/projects.svelte.js';
  import FilterSelect from '$lib/components/FilterSelect.svelte';
  import MonacoDiff from '$lib/components/MonacoDiff.svelte';
  import BranchBar from './BranchBar.svelte';
  import CommitPanel from './CommitPanel.svelte';

  const tab = useTab();
  /** @type {{path:string,name:string}[]} */
  let repos = $state([]);
  let repo = $state('');
  let branch = $state('');
  /** @type {string[]} */
  let branchList = $state([]);
  let compareRef = $state('');   // '' = working tree; else browsing that branch
  let compareBase = $state('');
  /** @type {{code:string,file:string,staged?:boolean,unstaged?:boolean}[]} */
  let changes = $state([]);      // working-tree changes
  /** @type {{code:string,file:string}[]} */
  let compareFiles = $state([]); // files differing current..compareRef
  let sel = $state('');
  /** @type {{original:string,modified:string}} */
  let diff = $state({ original: '', modified: '' });
  let status = $state('');

  async function loadBranches() {
    if (!repo) return;
    try { const d = await api.gitBranches(repo); branch = d.current; branchList = d.branches; } catch (e) { status = String(e); }
  }
  async function loadWorking() { try { changes = (await api.gitStatus(repo)).changes; } catch (e) { status = String(e); } }
  async function loadCompare() {
    try { const d = await api.gitCompare(repo, compareRef); compareBase = d.base; compareFiles = d.files; } catch (e) { status = String(e); }
  }
  async function refresh() {
    if (!repo) { changes = []; compareFiles = []; return; }
    await loadBranches();
    if (compareRef) await loadCompare(); else await loadWorking();
  }
  /** @param {string} file */
  async function openDiff(file) {
    sel = file;
    try { diff = compareRef ? await api.gitRefDiff(repo, compareBase, compareRef, file) : await api.gitDiff(repo, file); }
    catch (e) { status = String(e); }
  }
  /** @param {string} action @param {string} file */
  async function toggle(action, file) { await api.gitPost(action, { repo, files: [file] }); await loadWorking(); }
  /** @param {string} name */
  async function createBranch(name) {
    const r = await api.gitPost('branch', { repo, name });
    status = r.error || `on ${name}`;
    compareRef = '';
    await refresh();
  }
  async function checkoutBrowsed() {
    if (!compareRef) return;
    status = `switching to ${compareRef}…`;
    const r = await api.gitPost('checkout', { repo, branch: compareRef });
    if (r.error) { status = r.error; return; } // git refuses if it would clobber local changes
    compareRef = ''; sel = '';
    await refresh();
  }

  // restore the repo this tab was viewing (persisted in tab params)
  // Scope to repos under the active project (a project dir may contain several).
  let scopeDir = $derived(projectStore.active?.dir || '');
  onMount(async () => {
    repos = (await api.gitRepos()).repos;
    const saved = tab?.params?.()?.repo;
    const inScope = scopeDir ? repos.filter((r) => r.path.startsWith(scopeDir)) : repos;
    if (saved) repo = saved;
    else if (inScope.length) repo = inScope[0].path; // default into the project
  });
  /** @param {string} p */
  const titleFor = (p) => (p ? p.split('/').pop() || 'Changes' : 'Changes');
  $effect(() => { repo; compareRef; sel = ''; refresh(); });
  $effect(() => {
    if (!tab.isActive() || !repo || compareRef) return; // only poll the live working tree
    const id = setInterval(loadWorking, 4000);
    return () => clearInterval(id);
  });

  /** @param {string} code */
  function codeColor(code) {
    if (code.includes('D')) return 'text-red-400';
    if (code.includes('A') || code === '??') return 'text-green-400';
    return 'text-amber-400';
  }
  let repoOptions = $derived(
    (scopeDir ? repos.filter((r) => r.path.startsWith(scopeDir)) : repos)
      .map((r) => ({ value: r.path, label: r.name || r.path.split('/').filter(Boolean).pop() || r.path }))
  );
  let staged = $derived(changes.filter((c) => c.staged));
  let unstaged = $derived(changes.filter((c) => c.unstaged));
</script>

{#snippet fileRow(/** @type {any} */ c, /** @type {'stage'|'unstage'|null} */ act)}
  <div class="flex items-center gap-2 px-3 py-1 hover:bg-elevated {sel === c.file ? 'bg-elevated' : ''}">
    {#if act}
      <button class="text-xs text-muted hover:text-content w-4" title={act}
        onclick={() => toggle(act, c.file)}>{act === 'unstage' ? '−' : '+'}</button>
    {:else}<span class="w-4"></span>{/if}
    <button class="flex items-center gap-2 flex-1 min-w-0 text-left" onclick={() => openDiff(c.file)}>
      <span class="font-mono text-xs w-6 {codeColor(c.code)}">{c.code}</span>
      <span class="truncate {sel === c.file ? 'text-accent' : 'text-content'}">{c.file}</span>
    </button>
  </div>
{/snippet}

<div class="flex h-full">
  <div class="w-80 shrink-0 border-r border-line flex flex-col">
    <div class="px-2 h-9 flex items-center border-b border-line">
      <div class="flex-1 min-w-0">
        <FilterSelect block dense placeholder="pick a repo…" bind:value={repo} options={repoOptions}
          onChange={(/** @type {string} */ v) => { compareRef = ''; tab?.update?.({ title: titleFor(v), params: { repo: v } }); }} />
      </div>
      <button class="text-muted hover:text-content text-xs ml-1" title="Refresh" onclick={refresh}>⟳</button>
    </div>
    {#if repo}
      <BranchBar current={branch} {branchList} {compareRef} onCompare={(/** @type {string} */ r) => (compareRef = r)} onCreate={createBranch} />
    {/if}

    {#if compareRef}
      <div class="px-3 py-1.5 text-[11px] bg-elevated border-b border-line flex items-center gap-2">
        <span class="text-muted">browsing <span class="text-content">{compareRef}</span> vs {branch} · read-only</span>
        <button class="ml-auto text-accent hover:underline" onclick={checkoutBrowsed}>Checkout</button>
        <button class="text-muted hover:text-content" title="back to working tree" onclick={() => (compareRef = '')}>✕</button>
      </div>
    {/if}

    <div class="flex-1 overflow-auto text-sm">
      {#if compareRef}
        {#each compareFiles as c (c.file)}{@render fileRow(c, null)}{:else}
          <div class="px-3 py-2 text-muted">no differences vs {branch}</div>
        {/each}
      {:else}
        {#if staged.length}
          <div class="px-3 py-1 text-[11px] uppercase tracking-wide text-muted bg-card">Staged</div>
          {#each staged as c (c.file)}{@render fileRow(c, 'unstage')}{/each}
        {/if}
        <div class="px-3 py-1 text-[11px] uppercase tracking-wide text-muted bg-card">Changes</div>
        {#each unstaged as c (c.file)}{@render fileRow(c, 'stage')}{:else}
          <div class="px-3 py-2 text-muted">{repo ? 'clean' : 'pick a repo'}</div>
        {/each}
      {/if}
    </div>

    {#if repo && !compareRef}<CommitPanel {repo} {branch} stagedCount={staged.length} onChanged={refresh} />{/if}
  </div>

  <div class="flex-1 flex flex-col min-w-0">
    <div class="flex items-center gap-3 px-3 h-9 border-b border-line text-xs">
      <span class="truncate text-muted flex-1">{sel || 'select a file'}</span>
      <span class="text-muted">{status}</span>
    </div>
    <div class="flex-1 min-h-0">
      {#if sel}
        {#key sel + compareRef}<MonacoDiff original={diff.original} modified={diff.modified} path={sel} />{/key}
      {:else}
        <div class="h-full grid place-items-center text-muted text-sm">{compareRef ? `${branch} vs ${compareRef}` : 'HEAD vs working tree'}</div>
      {/if}
    </div>
  </div>
</div>
