<script>
  // Round avatar: shows a Gravatar image when `src` is set and loads, otherwise
  // falls back to the first initial of `name`. Gravatar uses d=404, so the
  // onerror fires for addresses with no avatar and we show the initial instead.
  /** @type {{ src?: string, name?: string, size?: number, klass?: string }} */
  let { src = '', name = '', size = 20, klass = '' } = $props();
  let ok = $state(true);
  $effect(() => { src; ok = true; }); // reset when the source changes
</script>

{#if src && ok}
  <img {src} alt="" class="shrink-0 rounded-full object-cover {klass}"
    style="width:{size}px;height:{size}px" onerror={() => (ok = false)} />
{:else}
  <span class="shrink-0 grid place-items-center rounded-full bg-elevated text-content uppercase font-semibold {klass}"
    style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.42)}px">{name?.[0] || '?'}</span>
{/if}
