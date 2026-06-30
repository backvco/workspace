<script>
  // Clipboard explorer: the pasted images stored for the active project. Shows each
  // item's size + a total, and lets you drop everything or prune by age.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { flash } from './store.svelte.js';

  /** @type {{name:string,path:string,size:number,mtime:number,ext:string,type:string}[]} */
  let items = $state([]);
  let copied = $state(''); // name of the item whose path was just copied
  let totalBytes = $state(0);
  let loading = $state(true);
  let busy = $state(false);

  // Age-prune controls.
  let amount = $state(30);
  let unit = $state('days'); // days | months | years
  const UNIT_MS = { days: 86400000, months: 2592000000, years: 31536000000 };

  function fmtBytes(/** @type {number} */ n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  function fmtDate(/** @type {number} */ ms) {
    return new Date(ms).toLocaleString();
  }

  async function load() {
    loading = true;
    try { const r = await api.clipboardList(); items = r.items; totalBytes = r.totalBytes; }
    catch (e) { flash(String(/** @type {any} */ (e)?.message || e), true); }
    loading = false;
  }
  onMount(load);

  async function dropAll() {
    if (!items.length || !confirm(`Delete all ${items.length} clipboard item(s)?`)) return;
    busy = true;
    const r = await api.clipboardPrune({ all: true });
    busy = false;
    if (r.error) return flash(r.error, true);
    flash(`Deleted ${r.removed} item(s), freed ${fmtBytes(r.freedBytes)}.`);
    load();
  }
  async function dropOld() {
    const ms = amount * UNIT_MS[/** @type {keyof typeof UNIT_MS} */ (unit)];
    const n = items.filter((i) => i.mtime < Date.now() - ms).length;
    if (!n) return flash(`No items older than ${amount} ${unit}.`);
    if (!confirm(`Delete ${n} item(s) older than ${amount} ${unit}?`)) return;
    busy = true;
    const r = await api.clipboardPrune({ olderThanMs: ms });
    busy = false;
    if (r.error) return flash(r.error, true);
    flash(`Deleted ${r.removed} item(s), freed ${fmtBytes(r.freedBytes)}.`);
    load();
  }
  async function dropOne(/** @type {string} */ name) {
    busy = true;
    const r = await api.clipboardPrune({ name });
    busy = false;
    if (r.error) return flash(r.error, true);
    load();
  }
  async function copyPath(/** @type {{name:string,path:string}} */ it) {
    try {
      await navigator.clipboard.writeText(it.path);
      copied = it.name;
      setTimeout(() => { if (copied === it.name) copied = ''; }, 1500);
    } catch { flash('Clipboard not available — copy manually: ' + it.path, true); }
  }
</script>

<section class="rounded-lg border border-line bg-card p-4 h-full flex flex-col min-h-0">
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <div>
      <div class="font-medium">Clipboard images</div>
      <div class="text-xs text-muted mt-0.5">
        Images you've pasted into this project's terminals are saved here.
        {#if !loading}<span class="text-content">{items.length} item{items.length === 1 ? '' : 's'} · {fmtBytes(totalBytes)} total</span>{/if}
      </div>
    </div>
    <div class="flex items-center gap-2 text-xs">
      <input type="number" min="1" class="w-16 bg-elevated border border-line rounded px-2 py-1" bind:value={amount} />
      <select class="bg-elevated border border-line rounded px-2 py-1" bind:value={unit}>
        <option value="days">days</option>
        <option value="months">months</option>
        <option value="years">years</option>
      </select>
      <button class="border border-line rounded px-3 py-1 text-muted hover:text-content disabled:opacity-40"
        disabled={busy || !items.length} onclick={dropOld}>Drop older than</button>
      <button class="border border-line rounded px-3 py-1 text-red-500 hover:text-red-400 disabled:opacity-40"
        disabled={busy || !items.length} onclick={dropAll}>Drop all</button>
    </div>
  </div>

  <div class="mt-4 flex-1 min-h-0 overflow-auto">
    {#if loading}
      <div class="text-sm text-muted">Loading…</div>
    {:else if !items.length}
      <div class="text-sm text-muted">No pasted images for this project.</div>
    {:else}
      <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
        {#each items as it (it.name)}
          <div class="group relative rounded border border-line bg-elevated overflow-hidden">
            <button class="absolute top-1 right-1 z-10 opacity-0 group-hover:opacity-100 w-6 h-6 grid place-items-center rounded bg-black/60 text-white text-xs hover:bg-red-600 disabled:opacity-40"
              title="Delete this image" disabled={busy} onclick={() => dropOne(it.name)}>✕</button>
            <a href={api.clipboardFileUrl(it.name)} target="_blank" rel="noopener" title="Open full image"
              class="block aspect-square bg-black/20 grid place-items-center">
              <img src={api.clipboardFileUrl(it.name)} alt={it.name} class="max-h-full max-w-full object-contain" loading="lazy" />
            </a>
            <div class="px-2 py-1.5 text-[11px] text-muted">
              <div class="flex items-center justify-between gap-1">
                <span class="text-content">{fmtBytes(it.size)} · {it.ext}</span>
                <button class="shrink-0 grid place-items-center w-6 h-6 -mr-1 rounded hover:bg-card {copied === it.name ? 'text-green-500' : 'text-muted hover:text-content'}"
                  title={copied === it.name ? 'Copied!' : 'Copy path: ' + it.path} aria-label="Copy file path" onclick={() => copyPath(it)}>
                  {#if copied === it.name}
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  {:else}
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  {/if}
                </button>
              </div>
              <div class="truncate" title={fmtDate(it.mtime)}>{fmtDate(it.mtime)}</div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>
