<script>
  // Read-only server configuration. Change via the server's .env + restart the API.
  import { s } from './store.svelte.js';
</script>

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
