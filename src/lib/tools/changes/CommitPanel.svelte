<script>
  // Commit / push / PR controls. Commit applies to STAGED files; "stage all"
  // stages everything first. Push sets upstream so a fresh branch publishes.
  import { api } from '$lib/api.js';

  let { repo = '', branch = '', stagedCount = 0, onChanged = () => {} } = $props();

  let message = $state('');
  let status = $state('');
  let prOpen = $state(false);
  let prBase = $state('dev');
  let prTitle = $state('');
  let prBody = $state('');
  let prUrl = $state('');

  async function stageAll() {
    status = 'staging all…';
    const r = await api.gitPost('stage', { repo, all: true });
    status = r.error || 'staged all';
    onChanged();
  }
  async function commit() {
    if (!message.trim()) { status = 'enter a commit message'; return; }
    status = 'committing…';
    const r = await api.gitPost('commit', { repo, message: message.trim() });
    if (r.error) { status = r.error; return; }
    status = 'committed ✓'; message = '';
    onChanged();
  }
  async function push() {
    status = 'pushing…';
    const r = await api.gitPost('push', { repo, branch, setUpstream: true });
    status = r.error ? r.error : 'pushed ✓';
    onChanged();
  }
  async function createPr() {
    if (!prTitle.trim()) { status = 'PR needs a title'; return; }
    status = 'creating PR…';
    const r = await api.gitPost('pr', { repo, base: prBase.trim() || 'dev', title: prTitle.trim(), body: prBody });
    if (r.error) { status = r.error; return; }
    prUrl = r.url; status = 'PR created ✓'; prOpen = false;
    onChanged();
  }
</script>

<div class="border-t border-line p-2 space-y-2">
  <textarea class="w-full bg-elevated border border-line rounded px-2 py-1 text-sm resize-none h-14"
    placeholder="commit message" bind:value={message}></textarea>
  <div class="flex flex-wrap items-center gap-2">
    <button class="text-xs border border-line rounded px-2 py-1 hover:bg-elevated" onclick={stageAll}>Stage all</button>
    <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-2 py-1" onclick={commit}>Commit ({stagedCount})</button>
    <button class="text-xs border border-line rounded px-2 py-1 hover:bg-elevated" onclick={push}>Push</button>
    <button class="text-xs border border-line rounded px-2 py-1 hover:bg-elevated" onclick={() => { prOpen = !prOpen; prTitle ||= message; }}>Create PR</button>
  </div>
  {#if prOpen}
    <div class="space-y-1 border border-line rounded p-2">
      <div class="flex gap-1 text-xs items-center">
        <span class="text-muted">base</span>
        <input class="bg-elevated border border-line rounded px-1 py-0.5 w-20" bind:value={prBase} />
        <span class="text-muted ml-1">head</span><span class="text-muted">{branch}</span>
      </div>
      <input class="w-full bg-elevated border border-line rounded px-2 py-1 text-sm" placeholder="PR title" bind:value={prTitle} />
      <textarea class="w-full bg-elevated border border-line rounded px-2 py-1 text-sm resize-none h-12" placeholder="PR body (optional)" bind:value={prBody}></textarea>
      <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-2 py-1" onclick={createPr}>Submit PR</button>
    </div>
  {/if}
  <div class="text-[11px] text-muted min-h-4">
    {status}
    {#if prUrl}<a href={prUrl} target="_blank" rel="noreferrer" class="text-accent hover:underline ml-1">{prUrl}</a>{/if}
  </div>
</div>
