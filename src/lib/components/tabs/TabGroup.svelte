<script>
  // One split group: its tab strip + the active tab's content, plus an edge drop
  // zone (only live during a drag) for dropping a tab out into a NEW split.
  import TabBar from './TabBar.svelte';
  import TabHost from './TabHost.svelte';
  import { tabStore, activateGroup, dropAsSplit } from '$lib/tabs/store.svelte.js';

  /** @type {{ group: { id: string, tabs: any[] }, index: number }} */
  let { group, index } = $props();
  let splitOver = $state(false);
</script>

<div class="flex flex-col h-full min-w-0 flex-1" onpointerdowncapture={() => activateGroup(group.id)}>
  <TabBar {group} />
  <div class="flex-1 min-h-0 relative">
    <TabHost {group} />
    {#if tabStore.dragActive}
      <!-- right-edge zone: drop a tab here to peel it off into a new split -->
      <div class="absolute top-0 right-0 h-full w-16 z-10 transition-colors {splitOver ? 'bg-accent/20 border-l-2 border-l-accent' : ''}"
        role="presentation"
        ondragover={(e) => { e.preventDefault(); splitOver = true; }}
        ondragleave={() => (splitOver = false)}
        ondrop={() => { dropAsSplit(index + 1); splitOver = false; }}></div>
    {/if}
  </div>
</div>
