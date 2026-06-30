<script>
  // Arm-to-confirm button. First click arms it and starts a countdown bar; click
  // again before it runs out to confirm, otherwise it reverts. Prevents
  // accidental destructive actions (delete a ticket, etc.).
  import { onDestroy } from 'svelte';
  /** @type {{ onConfirm: ()=>void, label?: string, armedLabel?: string, title?: string, ms?: number, class?: string }} */
  let { onConfirm, label = '✕', armedLabel = 'confirm?', title = '', ms = 2500, class: cls = '' } = $props();

  let armed = $state(false);
  /** @type {any} */
  let timer;
  /** @param {MouseEvent} e */
  function click(e) {
    e.stopPropagation();
    if (armed) { clearTimeout(timer); armed = false; onConfirm(); return; }
    armed = true;
    timer = setTimeout(() => { armed = false; }, ms);
  }
  onDestroy(() => clearTimeout(timer));
</script>

<button
  class="relative overflow-hidden {cls} {armed ? 'text-red-400' : ''}"
  title={armed ? 'click again to confirm' : title}
  onclick={click}
>
  {armed ? armedLabel : label}
  {#if armed}
    <span class="absolute bottom-0 left-0 h-[2px] bg-red-500 confirm-bar" style="animation-duration: {ms}ms"></span>
  {/if}
</button>

<style>
  .confirm-bar { width: 100%; animation: shrink linear forwards; }
  @keyframes shrink { from { width: 100%; } to { width: 0%; } }
</style>
