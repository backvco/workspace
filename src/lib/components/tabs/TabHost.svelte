<script>
  // Mounts every tab in ONE group once and keeps them alive. Activation just
  // toggles visibility inside TabSlot — no unmount, so background terminals stay
  // live. (Moving a tab to another group remounts it there; tmux re-attaches.)
  import TabSlot from './TabSlot.svelte';

  /** @type {{ group: { tabs: any[] } }} */
  let { group } = $props();
</script>

<div class="relative h-full w-full bg-canvas">
  {#each group.tabs as tab (tab.id)}
    <TabSlot {tab} />
  {/each}
</div>
