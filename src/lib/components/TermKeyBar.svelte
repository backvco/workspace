<script>
  // On-screen keys for touch. Emits a key DESCRIPTOR; the terminal encodes the
  // bytes for the current mode (e.g. application cursor keys). touchstart is used
  // (reliable on iOS) and the pressed look is state-driven, not CSS :active.
  /** @type {{ onKey?: (k: any) => void, onImage?: () => void, onPaste?: () => void }} */
  let { onKey = () => {}, onImage = () => {}, onPaste = () => {} } = $props();
  let pressed = $state('');

  const KEYS = [
    { label: 'Esc', key: 'Escape', keyCode: 27 },
    { label: 'Tab', key: 'Tab', keyCode: 9 },
    { label: '⇤', key: 'Tab', keyCode: 9, shift: true },
    { label: '↑', key: 'ArrowUp', keyCode: 38 },
    { label: '↓', key: 'ArrowDown', keyCode: 40 },
    { label: '←', key: 'ArrowLeft', keyCode: 37 },
    { label: '→', key: 'ArrowRight', keyCode: 39 },
    { label: '⏎', key: 'Enter', keyCode: 13 },
    { label: '⌃C', key: 'c', keyCode: 67, ctrl: true },
    { label: '⌃D', key: 'd', keyCode: 68, ctrl: true },
    { label: '⌃R', key: 'r', keyCode: 82, ctrl: true },
    { label: '⌃Z', key: 'z', keyCode: 90, ctrl: true },
    { label: '⌃L', key: 'l', keyCode: 76, ctrl: true }
  ];

  /** @param {any} k */
  function press(k) {
    pressed = k.label;
    if (navigator.vibrate) navigator.vibrate(8);
    onKey(k);
  }
  function release() { pressed = ''; }
</script>

<div role="toolbar" tabindex="-1" class="flex items-stretch gap-1 px-1 py-1 overflow-x-auto bg-card border-t border-line">
  <button
    class="shrink-0 min-w-9 px-2 py-2 rounded border border-line select-none touch-manipulation bg-elevated text-content grid place-items-center"
    title="Attach image"
    aria-label="Attach image"
    ontouchstart={(e) => { e.preventDefault(); if (navigator.vibrate) navigator.vibrate(8); }}
    ontouchend={(e) => { e.preventDefault(); onImage(); }}
    onclick={() => onImage()}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <circle cx="8.5" cy="8.5" r="1.5"></circle>
      <polyline points="21 15 16 10 5 21"></polyline>
    </svg>
  </button>
  <button
    class="shrink-0 min-w-9 px-2 py-2 rounded border border-line select-none touch-manipulation bg-elevated text-content grid place-items-center"
    title="Paste from clipboard"
    aria-label="Paste from clipboard"
    ontouchstart={(e) => { e.preventDefault(); if (navigator.vibrate) navigator.vibrate(8); }}
    ontouchend={(e) => { e.preventDefault(); onPaste(); }}
    onclick={() => onPaste()}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
    </svg>
  </button>
  {#each KEYS as k (k.label)}
    <button
      class="shrink-0 min-w-9 px-2 py-2 text-sm rounded border border-line font-mono select-none touch-manipulation transition-transform duration-75
             {pressed === k.label ? 'scale-90 bg-accent text-white' : 'bg-elevated text-content'}"
      ontouchstart={(e) => { e.preventDefault(); press(k); }}
      ontouchend={(e) => { e.preventDefault(); release(); }}
      ontouchcancel={release}
      onmousedown={(e) => { e.preventDefault(); press(k); }}
      onmouseup={release}
      onmouseleave={release}
    >{k.label}</button>
  {/each}
</div>
