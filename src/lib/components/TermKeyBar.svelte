<script>
  // On-screen keys for touch. Emits a key DESCRIPTOR; the terminal encodes the
  // bytes for the current mode (e.g. application cursor keys). touchstart is used
  // (reliable on iOS) and the pressed look is state-driven, not CSS :active.
  /** @type {{ onKey?: (k: any) => void }} */
  let { onKey = () => {} } = $props();
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
