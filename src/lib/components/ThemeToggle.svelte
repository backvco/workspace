<script>
  import { themeStore, setMode } from '$lib/theme.svelte.js';

  const labels = { light: '☀', dark: '🌙', system: '⊙' };
  /** @type {{ value: 'light'|'dark'|'system', icon: string, label: string }[]} */
  const opts = [
    { value: 'light', icon: '☀', label: 'Light' },
    { value: 'dark', icon: '🌙', label: 'Dark' },
    { value: 'system', icon: '⊙', label: 'System' }
  ];

  let open = $state(false);

  /** @param {'light'|'dark'|'system'} v */
  function pick(v) { setMode(v); open = false; }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') open = false; }} />

<div class="relative">
  <button
    class="grid place-items-center w-5 h-5 text-muted hover:text-content leading-none text-sm"
    title="Theme"
    aria-label="Theme"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={(e) => { e.stopPropagation(); open = !open; }}
  >{labels[themeStore.mode]}</button>

  {#if open}
    <!-- click-away backdrop -->
    <button class="fixed inset-0 z-40 cursor-default" aria-label="Close theme menu" onclick={() => (open = false)}></button>
    <div class="absolute right-0 top-7 z-50 w-32 bg-card border border-line rounded-lg shadow-xl py-1" role="menu">
      {#each opts as o (o.value)}
        <button
          role="menuitemradio"
          aria-checked={themeStore.mode === o.value}
          class="flex items-center gap-2 w-full text-left text-sm px-3 py-1.5 hover:bg-elevated {themeStore.mode === o.value ? 'text-accent' : 'text-content'}"
          onclick={() => pick(o.value)}
        >
          <span class="w-4 text-center">{o.icon}</span>
          <span class="flex-1">{o.label}</span>
          {#if themeStore.mode === o.value}<span class="text-accent">✓</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
