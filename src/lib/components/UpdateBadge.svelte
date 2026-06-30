<script>
  // Header indicator for "the live checkout is behind its git remote". Polls
  // /api/version; when origin is ahead it shows a badge + a popover listing the
  // incoming commits with an "Update & deploy" button that pulls (ff-only) and
  // kicks a redeploy, then reloads once the new build is serving.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  /** @type {any} */ let v = $state(null);
  let open = $state(false);
  let phase = $state(/** @type {'idle'|'pulling'|'deploying'|'done'|'error'} */ ('idle'));
  let message = $state('');
  let pendingHead = $state('');

  async function refresh() {
    try { v = await api.version(); } catch { /* keep last good */ }
  }

  onMount(() => {
    refresh();
    // A git fetch each poll — keep it gentle. The popover also refreshes on open.
    const id = setInterval(() => { if (!document.hidden && phase === 'idle') refresh(); }, 120_000);
    return () => clearInterval(id);
  });

  function toggle(/** @type {MouseEvent} */ e) {
    e.stopPropagation();
    open = !open;
    if (open) refresh();
  }

  async function doUpdate() {
    phase = 'pulling';
    message = '';
    let res;
    try { res = await api.selfUpdate(); }
    catch (e) { phase = 'error'; message = String(/** @type {any} */ (e)?.message || e); return; }
    if (!res?.ok) { phase = 'error'; message = res?.error || 'update failed'; return; }
    pendingHead = res.head;
    phase = 'deploying';
    message = 'Building & restarting…';
    // Poll until the new commit is the one actually serving, then reload to pick
    // up the fresh JS bundle (the running page is still the old build).
    const started = Date.now();
    const tick = async () => {
      await refresh();
      if (v && v.deployed === pendingHead && !v.buildStale) {
        phase = 'done';
        message = 'Updated — reloading…';
        setTimeout(() => location.reload(), 1200);
        return;
      }
      if (Date.now() - started > 180_000) {
        phase = 'error';
        message = 'Deploy is taking longer than expected — check the server.';
        return;
      }
      setTimeout(tick, 4000);
    };
    setTimeout(tick, 4000);
  }

  const busy = $derived(phase === 'pulling' || phase === 'deploying');
  const show = $derived(Boolean(v && (v.updateAvailable || busy)));
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && !busy) open = false; }} />

{#if show}
  <div class="relative">
    <button
      class="flex items-center gap-1.5 text-xs px-2 h-6 rounded-full border border-amber-500/40 text-amber-600 dark:text-amber-400 hover:border-amber-500 leading-none whitespace-nowrap"
      title="A workspace update is available"
      aria-label="Workspace update available"
      aria-haspopup="dialog"
      aria-expanded={open}
      onclick={toggle}
    >
      <span class="w-2 h-2 rounded-full bg-amber-500 {busy ? 'animate-pulse' : ''}"></span>
      <span class="hidden sm:inline">{busy ? 'Updating…' : `Update${v.behind ? ` ${v.behind}` : ''}`}</span>
    </button>

    {#if open}
      <button class="fixed inset-0 z-40 cursor-default" aria-label="Close" onclick={() => { if (!busy) open = false; }}></button>
      <div class="absolute right-0 top-8 z-50 w-80 max-w-[90vw] bg-card border border-line rounded-lg shadow-xl p-3 text-sm" role="dialog" aria-label="Workspace update">
        <div class="flex items-center justify-between mb-2">
          <span class="font-semibold">Workspace update</span>
          <span class="text-xs text-muted font-mono">{v.deployed} → {v.remote}</span>
        </div>

        {#if v.incoming?.length}
          <div class="max-h-40 overflow-auto rounded border border-line divide-y divide-line mb-2">
            {#each v.incoming as c (c.hash)}
              <div class="px-2 py-1 flex gap-2">
                <span class="font-mono text-xs text-muted shrink-0">{c.hash}</span>
                <span class="text-xs text-content truncate">{c.subject}</span>
              </div>
            {/each}
          </div>
          <p class="text-xs text-muted mb-2">{v.behind} commit{v.behind === 1 ? '' : 's'} on origin/{v.branch}.</p>
        {/if}

        {#if v.dirty}
          <p class="text-xs text-amber-600 dark:text-amber-400 mb-2">⚠ Local changes present in the checkout — the pull is refused if they clash.</p>
        {/if}
        {#if !v.canFastForward && phase === 'idle'}
          <p class="text-xs text-amber-600 dark:text-amber-400 mb-2">⚠ The checkout has {v.ahead} unpushed commit{v.ahead === 1 ? '' : 's'}; it can't fast-forward. Resolve in a terminal.</p>
        {/if}

        {#if message}
          <p class="text-xs {phase === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'} mb-2 break-words">{message}</p>
        {/if}

        <button
          class="w-full h-8 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={busy || !v.canFastForward}
          onclick={doUpdate}
        >{busy ? (phase === 'pulling' ? 'Pulling…' : 'Deploying…') : 'Update & deploy'}</button>
      </div>
    {/if}
  </div>
{/if}
