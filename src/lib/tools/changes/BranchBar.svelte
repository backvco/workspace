<script>
  // The current (checked-out) branch is a FIXED label — browsing never changes it.
  // The picker selects a branch to BROWSE read-only (compare against current).
  // "● working tree" returns to your uncommitted changes. Switching the actual
  // branch is a separate, explicit action (the Checkout button in the banner).
  import FilterSelect from '$lib/components/FilterSelect.svelte';

  /** @type {{ current?:string, branchList?:string[], compareRef?:string, onCompare?:(v:any)=>void, onCreate?:(name:string)=>void }} */
  let { current = '', branchList = [], compareRef = '', onCompare = () => {}, onCreate = () => {} } = $props();

  let creating = $state(false);
  let newName = $state('');

  function create() {
    if (newName.trim()) { onCreate(newName.trim()); newName = ''; creating = false; }
  }

  let options = $derived([
    { value: '', label: `● working tree (${current})` },
    ...branchList.filter((b) => b !== current).map((b) => ({ value: b, label: b }))
  ]);
</script>

<div class="border-b border-line">
  <!-- row 1: current branch + new-branch -->
  <div class="flex items-center gap-2 px-2 h-8">
    <span class="text-xs text-content font-medium truncate" title="current checked-out branch">⎇ {current || '…'}</span>
    {#if creating}
      <!-- svelte-ignore a11y_autofocus -->
      <input class="bg-elevated border border-line rounded text-xs px-1 py-0.5 flex-1 min-w-0" placeholder="new branch name" bind:value={newName}
        autofocus onkeydown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') creating = false; }} />
      <button class="text-xs text-accent hover:underline shrink-0" onclick={create}>create</button>
    {:else}
      <button class="ml-auto text-xs text-muted hover:text-content shrink-0" title="Create a new branch off current" onclick={() => (creating = true)}>+ branch</button>
    {/if}
  </div>
  <!-- row 2: browse picker gets the full width -->
  <div class="px-2 pb-1.5">
    <FilterSelect block dense placeholder="browse a branch…" value={compareRef} options={options} onChange={onCompare} />
  </div>
</div>
