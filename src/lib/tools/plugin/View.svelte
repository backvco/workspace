<script>
  // Embeds a configured plugin's surface via the auth-gated proxy
  // (/api/plugins/<name>/proxy/), so the plugin service is never exposed directly
  // and inherits the workspace login. This is the OSS-side seam only; the plugin
  // (compiled, private) provides the actual UI. Empty state when none configured.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  let plugins = $state(/** @type {{name:string,label:string}[]} */ ([]));
  let active = $state(/** @type {string} */ (''));
  let loading = $state(true);
  let authRequired = $state(false);

  const src = $derived(active ? api.pluginProxyUrl(active) : '');

  onMount(async () => {
    try {
      const d = await api.plugins();
      authRequired = !!d.authRequired;
      plugins = d.plugins || [];
      active = plugins[0]?.name || '';
    } catch {}
    loading = false;
  });
</script>

{#if src}
  <div class="flex h-full flex-col">
    {#if plugins.length > 1}
      <div class="flex gap-1 border-b border-edge px-2 py-1 text-sm">
        {#each plugins as p (p.name)}
          <button
            class="rounded px-2 py-0.5 {active === p.name ? 'bg-accent text-white' : 'text-muted hover:bg-hover'}"
            onclick={() => (active = p.name)}
          >{p.label}</button>
        {/each}
      </div>
    {/if}
    <iframe
      title={plugins.find((p) => p.name === active)?.label || 'Plugin'}
      {src}
      class="min-h-0 flex-1 w-full border-0 bg-canvas"
      allow="clipboard-read; clipboard-write"
    ></iframe>
  </div>
{:else}
  <div class="h-full grid place-items-center text-muted text-sm p-6 text-center">
    <div>
      {#if loading}
        <p>Loading plugins…</p>
      {:else if authRequired}
        <p>Workspace login is required to use plugins.</p>
        <p class="mt-1">A plugin can drive terminal/agent sessions, so it stays disabled until you <b>enable login</b> in <code class="mx-1">Settings</code>.</p>
      {:else}
        <p>No plugin configured.</p>
        <p class="mt-1">Set <code class="mx-1">WORKSPACE_PLUGINS</code> in <code>.env</code> (e.g. <code>agentmgr|Agent Manager|http://127.0.0.1:5330</code>) and restart the API to embed a plugin here.</p>
      {/if}
    </div>
  </div>
{/if}
