<script>
  // Review surface: the agent's committed changes on its agent/<id> branch vs the
  // branch it forked from. Reuses the git compare/refdiff endpoints + Monaco.
  import { api } from '$lib/api.js';
  import MonacoDiff from '$lib/components/MonacoDiff.svelte';
  /** @type {{ task: any }} */
  let { task } = $props();

  let base = $state('');
  /** @type {{code:string,file:string}[]} */
  let files = $state([]);
  let sel = $state('');
  let original = $state('');
  let modified = $state('');
  let status = $state('');

  async function load() {
    files = []; sel = ''; original = ''; modified = ''; status = 'loading…';
    if (!task.branch) { status = "No diff — this agent isn't running in a git worktree."; return; }
    try {
      const r = await api.gitCompare(task.dir, task.branch);
      base = r.base; files = r.files || [];
      status = files.length ? '' : `No committed changes yet on ${task.branch}.`;
      if (files.length) pick(files[0].file);
    } catch (e) { status = `diff failed: ${e}`; }
  }
  /** @param {string} f */
  async function pick(f) {
    sel = f;
    try { const r = await api.gitRefDiff(task.dir, base, task.branch, f); original = r.original; modified = r.modified; }
    catch (e) { status = String(e); }
  }
  // (re)load only when the selected agent actually changes (not on every poll)
  let loadedFor = '';
  $effect(() => { if (task.id !== loadedFor) { loadedFor = task.id; load(); } });
</script>

<div class="flex h-full">
  <div class="w-56 shrink-0 border-r border-line overflow-auto text-xs">
    {#if status}<div class="p-3 text-muted">{status}</div>{/if}
    {#each files as f (f.file)}
      <button class="flex w-full gap-1 text-left px-3 py-1.5 hover:bg-elevated {sel === f.file ? 'bg-elevated text-content' : 'text-muted'}"
        onclick={() => pick(f.file)} title={f.file}>
        <span class="opacity-60 w-3 shrink-0">{f.code}</span><span class="truncate">{f.file}</span>
      </button>
    {/each}
  </div>
  <div class="flex-1 min-w-0">
    {#if sel}{#key sel}<MonacoDiff {original} {modified} path={sel} />{/key}
    {:else}<div class="grid place-items-center h-full text-muted text-sm">{status || 'Select a file'}</div>{/if}
  </div>
</div>
