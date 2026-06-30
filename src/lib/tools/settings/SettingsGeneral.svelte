<script>
  // Read-only server configuration + the running build / self-update controls.
  import { s } from './store.svelte.js';
  import { runSelfUpdate } from '$lib/selfupdate.js';

  let phase = $state(/** @type {'idle'|'pulling'|'deploying'|'done'|'error'} */ ('idle'));
  let message = $state('');
  const busy = $derived(phase === 'pulling' || phase === 'deploying');

  /** @param {boolean} [force] */
  async function update(force = false) {
    if (force && !confirm('Force update: reset this checkout to origin and discard any local commits/changes, then redeploy. Continue?')) return;
    await runSelfUpdate(force, (p, m) => { phase = p; message = m; });
  }
</script>

<section class="rounded-lg border border-line bg-card p-4 mb-4">
  <div class="font-medium mb-2">Running build</div>
  {#if s.version}
    {@const v = s.version}
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs mb-3">
      <dt class="text-muted">Branch</dt><dd>{v.branch}</dd>
      <dt class="text-muted">Deployed</dt>
      <dd>
        {#if v.deployedUrl}<a href={v.deployedUrl} target="_blank" rel="noopener noreferrer" class="hover:underline">{v.deployed}</a>
        {:else}{v.deployed || '—'}{/if}
        {#if v.buildStale}<span class="text-amber-600 dark:text-amber-400"> (HEAD {v.head} not deployed yet)</span>{/if}
      </dd>
      <dt class="text-muted">origin/{v.branch}</dt><dd>{v.remote || '—'}</dd>
      <dt class="text-muted">Status</dt>
      <dd>
        {#if v.updateAvailable}<span class="text-amber-600 dark:text-amber-400">{v.behind} commit{v.behind === 1 ? '' : 's'} behind</span>
        {:else if v.ahead > 0}<span class="text-amber-600 dark:text-amber-400">{v.ahead} unpushed commit{v.ahead === 1 ? '' : 's'} (diverged)</span>
        {:else}<span class="text-content">up to date</span>{/if}
        {#if v.dirty}<span class="text-muted"> · working tree dirty</span>{/if}
      </dd>
    </dl>

    {#if v.incoming?.length}
      <div class="max-h-40 overflow-auto rounded border border-line divide-y divide-line mb-3">
        {#each v.incoming as c (c.hash)}
          <svelte:element
            this={c.url ? 'a' : 'div'}
            href={c.url || undefined}
            target={c.url ? '_blank' : undefined}
            rel={c.url ? 'noopener noreferrer' : undefined}
            class="px-2 py-1 flex gap-2 font-mono {c.url ? 'hover:bg-bg/50' : ''}"
          >
            <span class="text-xs text-muted shrink-0">{c.hash}</span>
            <span class="text-xs text-content truncate">{c.subject}</span>
          </svelte:element>
        {/each}
      </div>
    {/if}

    {#if message}
      <p class="text-xs {phase === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'} mb-2 break-words">{message}</p>
    {/if}

    <div class="flex flex-wrap gap-2">
      {#if v.canFastForward}
        <button class="text-xs rounded px-3 py-1.5 bg-accent text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={busy} onclick={() => update(false)}>
          {busy ? (phase === 'pulling' ? 'Pulling…' : 'Deploying…') : `Update & deploy (${v.behind})`}
        </button>
      {/if}
      <!-- Escape hatch: force the checkout to match origin even when it can't
           fast-forward (diverged / origin was force-pushed). Destructive. -->
      <button class="text-xs rounded px-3 py-1.5 border border-red-500/50 text-red-600 dark:text-red-400 hover:bg-red-500/10 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={busy} onclick={() => update(true)}>
        {busy && !v.canFastForward ? (phase === 'pulling' ? 'Resetting…' : 'Deploying…') : 'Force update (reset to origin)'}
      </button>
    </div>
    <p class="text-xs text-muted mt-2">Pulls from origin (or hard-resets, for Force) then rebuilds and restarts the UI. Server-side changes still need an API restart.</p>
  {:else}
    <div class="text-xs text-muted">Version info unavailable.</div>
  {/if}
</section>

<section class="rounded-lg border border-line bg-card p-4">
  <div class="font-medium mb-2">Server configuration</div>
  <div class="text-xs text-muted mb-2">Read-only. Change these via the server's <code>.env</code> and restart the API.</div>
  {#if s.config}
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
      <dt class="text-muted">Project roots</dt><dd class="break-all">{s.config.projectRoots.join('  ·  ') || '—'}</dd>
      <dt class="text-muted">Terminal cwd</dt><dd class="break-all">{s.config.termCwd || '—'}</dd>
      <dt class="text-muted">Data dir</dt><dd class="break-all">{s.config.dataDir}</dd>
      <dt class="text-muted">Agent CLI</dt><dd class="break-all">{s.config.agentBin}</dd>
    </dl>
  {/if}
</section>
