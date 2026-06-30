<script>
  // Segmented one-time enrollment code entry: 9 chars (A–Z, 2–9) shown as three
  // groups of three boxes — [A][B][C] - [1][2][3] - [X][Y][Z] — so a relayed code
  // is easy to read and type, especially on mobile. Binds `value` as the canonical
  // 9-char string (no dashes, uppercased); the parent decides when it's complete.
  let { value = $bindable(''), disabled = false } = $props();

  const CELLS = 9;
  /** @type {HTMLInputElement[]} */
  let inputs = $state([]);

  // Per-cell characters derived from the bound value (uppercased, alnum only).
  const chars = $derived.by(() => {
    const c = (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CELLS).split('');
    return Array.from({ length: CELLS }, (_, i) => c[i] || '');
  });

  function commit(/** @type {string[]} */ next) { value = next.join(''); }
  function clean(/** @type {string} */ s) { return s.toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  // Spread `raw` across cells starting at `i`, then focus the cell after the last.
  function fill(/** @type {number} */ i, /** @type {string} */ raw) {
    const next = chars.slice();
    let k = 0;
    for (; k < raw.length && i + k < CELLS; k++) next[i + k] = raw[k];
    commit(next);
    inputs[Math.min(i + k, CELLS - 1)]?.focus();
  }

  function onInput(/** @type {number} */ i, /** @type {Event} */ e) {
    const raw = clean(/** @type {HTMLInputElement} */ (e.currentTarget).value);
    if (!raw) { const n = chars.slice(); n[i] = ''; commit(n); return; }
    fill(i, raw);
  }
  function onKeydown(/** @type {number} */ i, /** @type {KeyboardEvent} */ e) {
    if (e.key === 'Backspace') {
      const next = chars.slice();
      if (next[i]) next[i] = '';
      else if (i > 0) { next[i - 1] = ''; inputs[i - 1]?.focus(); }
      commit(next); e.preventDefault();
    } else if (e.key === 'ArrowLeft' && i > 0) { inputs[i - 1]?.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && i < CELLS - 1) { inputs[i + 1]?.focus(); e.preventDefault(); }
  }
  function onPaste(/** @type {number} */ i, /** @type {ClipboardEvent} */ e) {
    e.preventDefault();
    fill(i, clean(e.clipboardData?.getData('text') || ''));
  }
</script>

<div class="flex w-full items-center justify-center gap-1">
  {#each Array.from({ length: CELLS }) as _, i (i)}
    {#if i === 3 || i === 6}<span class="shrink-0 text-muted select-none">-</span>{/if}
    <input
      bind:this={inputs[i]}
      class="h-11 min-w-0 flex-1 max-w-[2.5rem] rounded border border-line bg-elevated text-center text-base font-mono uppercase focus:border-green-600 focus:outline-none disabled:opacity-40"
      inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="1"
      value={chars[i]} {disabled}
      oninput={(e) => onInput(i, e)} onkeydown={(e) => onKeydown(i, e)} onpaste={(e) => onPaste(i, e)} />
  {/each}
</div>
