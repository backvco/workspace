<script>
  // Quick "how to use Workspace" tips. Opened from the header ? button. Content
  // is platform-aware for the copy gesture (⌥ on mac / Shift elsewhere), since
  // that's the #1 thing people get stuck on inside a Claude/full-screen pane.
  let { onClose } = $props();

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const selMod = isMac ? '⌥ Option' : 'Shift';
  const cmd = isMac ? '⌘' : 'Ctrl';

  /** @param {KeyboardEvent} e */
  function onKey(e) { if (e.key === 'Escape') onClose(); }

  const tips = [
    {
      title: 'Copy text',
      body: `Inside a Claude session (or any full-screen app) the mouse belongs to the app, so hold <kbd>${selMod}</kbd> and drag to select, then <kbd>${cmd}C</kbd> (or right-click → Copy). In a plain shell, just drag to select — it copies automatically.`
    },
    { title: 'Paste', body: `<kbd>${cmd}V</kbd>. You can also paste or drag an image into a terminal — it's saved and its path is inserted into the prompt.` },
    { title: 'Soft newline in Claude', body: `<kbd>Shift</kbd>+<kbd>Enter</kbd> inserts a newline instead of submitting.` },
    { title: 'Clear', body: `<kbd>${cmd}L</kbd> clears the current input line; <kbd>${cmd}K</kbd> clears the terminal screen.` },
    { title: 'Terminals persist', body: `Each terminal is a tmux session — closing the tab or browser does not kill it. Long-running work (and Claude) keeps going; re-open to reattach.` },
    { title: 'Fix terminal sizing', body: `If a terminal looks the wrong size after switching tabs, click the ⤢ resize button in the header to re-fit every terminal.` }
  ];
</script>

<svelte:window onkeydown={onKey} />

<!-- backdrop -->
<div class="fixed inset-0 z-50 bg-black/30 dark:bg-black/50 grid place-items-center p-4"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }} role="presentation">
  <div class="w-full max-w-lg max-h-[80vh] overflow-auto bg-card border border-line rounded-xl shadow-xl"
    role="dialog" aria-modal="true" aria-label="Workspace tips" tabindex="-1">
    <div class="flex items-center justify-between px-4 py-3 border-b border-line sticky top-0 bg-card">
      <h2 class="font-semibold text-content">Workspace tips</h2>
      <button class="text-muted hover:text-content text-lg leading-none" title="Close" aria-label="Close" onclick={onClose}>✕</button>
    </div>
    <ul class="p-4 space-y-3">
      {#each tips as tip}
        <li>
          <div class="text-sm font-medium text-content">{tip.title}</div>
          <div class="text-sm text-muted mt-0.5">{@html tip.body}</div>
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  /* small inline keycap styling for the tips */
  :global(.text-muted kbd) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    padding: 0 0.3rem;
    border: 1px solid var(--color-line, #30363d);
    border-radius: 0.25rem;
    background: var(--color-elevated, #161b22);
    color: var(--color-content, #e6edf3);
    white-space: nowrap;
  }
</style>
