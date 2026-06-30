<script>
  // Hosts one tab's tool component and provides the per-tab context. Inactive
  // tabs stay mounted (display:none) so terminals keep their websocket + state.
  import { provideTabContext } from '$lib/tabs/context.js';
  import { tabStore, updateTab } from '$lib/tabs/store.svelte.js';
  import { getTool } from '$lib/tabs/registry.js';

  let { tab } = $props();

  // `tab` identity is stable per keyed slot, so reading it at setup is intentional.
  // svelte-ignore state_referenced_locally
  provideTabContext({
    id: tab.id,
    isActive: () => tabStore.isActive(tab.id),
    params: () => tab.params || {},
    update: (/** @type {{title?:string, params?:Record<string,any>}} */ patch) => updateTab(tab.id, patch)
  });

  // svelte-ignore state_referenced_locally
  const tool = getTool(tab.toolId);
  /** @type {any} */
  let Comp = $state(null);
  $effect(() => {
    let alive = true;
    tool?.component().then((/** @type {{ default: any }} */ m) => { if (alive) Comp = m.default; });
    return () => { alive = false; };
  });

  let active = $derived(tabStore.isActive(tab.id));
</script>

<div class="h-full w-full" style:display={active ? 'block' : 'none'}>
  {#if Comp}
    <Comp />
  {:else}
    <div class="p-4 text-sm text-muted">Loading…</div>
  {/if}
</div>
