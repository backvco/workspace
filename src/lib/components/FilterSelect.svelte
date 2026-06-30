<script>
  // Filterable single-select combobox. A text input that
  // narrows a list as you type, with a dropdown portaled to <body> so no
  // overflow:auto ancestor clips it. Options: [{ value, label, disabled? }].
  // Drive via bind:value, or value + onChange (controlled).
  /**
   * @type {{
   *   value?: any,
   *   options?: { value:any, label:string, disabled?:boolean, disabledReason?:string }[],
   *   onChange?: ((v:any)=>void)|null,
   *   placeholder?: string, monoFont?: boolean, block?: boolean, dense?: boolean,
   *   filter?: boolean, class?: string
   * }}
   */
  let {
    value = $bindable(),
    options = [],
    onChange = null,
    placeholder = 'Select…',
    monoFont = false,
    block = false,
    dense = false,
    filter = true,
    class: cls = ''
  } = $props();

  let open = $state(false);
  let query = $state('');
  /** @type {HTMLInputElement | undefined} */
  let inputEl = $state();
  /** @type {{left:number, top?:number, bottom?:number, minWidth:number} | null} */
  let panelPos = $state(null);
  const PANEL_MAX = 224;

  function measure() {
    const el = inputEl;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const dropUp = below < Math.min(PANEL_MAX, 160) && above > below;
    panelPos = dropUp
      ? { left: r.left, bottom: window.innerHeight - r.top + 4, minWidth: r.width }
      : { left: r.left, top: r.bottom + 4, minWidth: r.width };
  }

  $effect(() => {
    if (!open) return;
    const reposition = () => measure();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  });

  /** @param {HTMLElement} node */
  function portalToBody(node) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  const selectedLabel = $derived(options.find((o) => o.value === value)?.label ?? '');
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return filter && q
      ? options.filter((o) => o.label.toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q))
      : options;
  });
  const inputSize = $derived(dense ? 'text-xs px-2 py-1' : 'text-sm px-2 py-1.5');
  const optSize = $derived(dense ? 'text-xs px-2 py-1' : 'text-sm px-3 py-1.5');

  function openList() { measure(); open = true; query = ''; if (filter) setTimeout(() => inputEl?.select(), 0); }
  /** @param {any} o */
  function pick(o) { if (o.disabled) return; value = o.value; onChange?.(o.value); open = false; query = ''; }
  function onBlur() { setTimeout(() => (open = false), 120); }
  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key === 'Escape') open = false;
    else if (e.key === 'Enter' && filter && filtered.length) { pick(filtered[0]); e.preventDefault(); }
  }
</script>

<div class="relative {block ? 'block' : 'inline-block'} {cls}">
  <input
    bind:this={inputEl}
    value={open && filter ? query : selectedLabel}
    readonly={!filter}
    oninput={(e) => { if (filter) { query = e.currentTarget.value; open = true; } }}
    onfocus={openList}
    onmousedown={() => { if (!filter) { if (!open) measure(); open = !open; } }}
    onblur={onBlur}
    onkeydown={onKey}
    {placeholder}
    class="w-full pr-7 border border-line rounded bg-card text-content placeholder:text-muted {inputSize} {monoFont ? 'font-mono' : ''} {filter ? '' : 'cursor-pointer'}" />
  <span class="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted text-[10px]">▾</span>
  {#if open && panelPos}
    <div
      use:portalToBody
      style:position="fixed"
      style:left="{panelPos.left}px"
      style:top={panelPos.top != null ? `${panelPos.top}px` : null}
      style:bottom={panelPos.bottom != null ? `${panelPos.bottom}px` : null}
      style:min-width="{panelPos.minWidth}px"
      class="z-[100] w-max max-w-2xl max-h-56 overflow-y-auto bg-card border border-line rounded-lg shadow-lg"
    >
      {#each filtered as o (o.value)}
        <button type="button" onmousedown={() => pick(o)} disabled={o.disabled}
          class="block w-full text-left {optSize} {monoFont ? 'font-mono' : ''} {o.disabled ? 'text-muted cursor-not-allowed opacity-50' : (o.value === value ? 'text-accent bg-elevated' : 'text-content hover:bg-elevated')}">
          {o.label}
        </button>
      {/each}
      {#if !filtered.length}<div class="px-3 py-1.5 text-[11px] text-muted">No matches</div>{/if}
    </div>
  {/if}
</div>
