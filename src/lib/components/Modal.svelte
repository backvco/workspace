<script>
  // Centered modal overlay. Click the backdrop or ✕ to close; Esc also closes.
  /** @type {{ title?: string, onClose: () => void, max?: string, children: import('svelte').Snippet }} */
  let { title = '', onClose, max = 'max-w-lg', children } = $props();
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<div class="fixed inset-0 z-50 grid place-items-center bg-black/30 dark:bg-black/50 p-4" onclick={onClose} role="presentation">
  <div class="bg-card border border-line rounded-lg shadow-xl w-full {max} max-h-[90vh] overflow-auto" onclick={(e) => e.stopPropagation()} role="presentation">
    {#if title}
      <div class="flex items-center h-10 px-4 border-b border-line">
        <h3 class="font-semibold text-sm">{title}</h3>
        <button class="ml-auto text-muted hover:text-content" onclick={onClose}>✕</button>
      </div>
    {/if}
    <div class="p-4">{@render children()}</div>
  </div>
</div>
