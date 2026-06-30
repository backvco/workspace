<script>
  // Full VS Code (code-server) embedded as a tab. Run `claude` in its integrated
  // terminal and type /ide to get native diffs, diagnostics, selection context.
  // Kept mounted by TabHost, so the editor state survives tab switches.
  //
  // The URL is RUNTIME config (server /api/config <- WORKSPACE_CODE_SERVER_URL), so
  // it can be changed in .env without a rebuild. CODE_SERVER_URL (build-time
  // VITE_CODE_SERVER_URL) is kept only as a fallback for embedded deployments.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { CODE_SERVER_URL } from '$lib/config.js';
  import { projectStore } from '$lib/projects.svelte.js';

  let url = $state(CODE_SERVER_URL);
  // Open the active project's folder (falls back to the code-server default).
  const folder = $derived(projectStore.active?.dir || '');

  onMount(async () => {
    try { const c = await api.serverConfig(); if (c?.codeServerUrl) url = c.codeServerUrl; } catch {}
  });
</script>

{#if url}
  <iframe
    title="VS Code"
    src={`${url}/?folder=${encodeURIComponent(folder)}`}
    class="h-full w-full border-0 bg-canvas"
    allow="clipboard-read; clipboard-write"
  ></iframe>
{:else}
  <div class="h-full grid place-items-center text-muted text-sm p-6 text-center">
    <div>
      <p>No code-server configured.</p>
      <p class="mt-1">Set <code class="mx-1">WORKSPACE_CODE_SERVER_URL</code> in <code>.env</code> and restart the API to embed VS Code here.</p>
      <p class="mt-1 opacity-70">code-server is a separate service - secure it itself; this app's auth does not cover it.</p>
    </div>
  </div>
{/if}
