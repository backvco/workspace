<script>
  // The split layout: groups laid out side by side, each its own tab strip +
  // content. A group highlights when it's the active one.
  import TabGroup from './TabGroup.svelte';
  import { tabStore, openTerminal } from '$lib/tabs/store.svelte.js';
</script>

<div class="flex h-full w-full">
  {#if tabStore.groups.length === 0}
    <div class="flex-1 flex flex-col items-center justify-center gap-3 text-muted">
      <span class="text-3xl opacity-20">›_</span>
      <p class="text-sm">No tabs open</p>
      <button class="text-xs px-3 py-1.5 rounded border border-line hover:bg-elevated hover:text-content"
        onclick={() => openTerminal()}>Open terminal</button>
    </div>
  {:else}
    {#each tabStore.groups as group, i (group.id)}
      <div class="flex-1 min-w-0 h-full {i > 0 ? 'border-l border-line' : ''} {tabStore.activeGroupId === group.id && tabStore.groups.length > 1 ? 'ring-1 ring-inset ring-accent/30' : ''}">
        <TabGroup {group} index={i} />
      </div>
    {/each}
  {/if}
</div>
