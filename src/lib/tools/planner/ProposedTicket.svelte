<script>
  // One proposed-ticket card in the plan review surface. Collapsed by default
  // (title + repo + verify badge) so a whole plan fits at a glance; expand to see
  // goal/criteria and its verifier findings inline (each with an include-in-refine
  // checkbox + the suggested fix).
  import FilterSelect from '$lib/components/FilterSelect.svelte';

  /** @type {{
   *   t:any, n:number, findings:any[], vstatus?:string,
   *   branchOpts:{value:string,label:string}[], base:string, onBase:(v:string)=>void,
   *   isSelected:(issue:string)=>boolean, toggle:(issue:string)=>void
   * }} */
  let { t, n, findings = [], vstatus = 'unverified', branchOpts = [], base = '', onBase, isSelected, toggle } = $props();

  let open = $state(false);
  /** @param {string} r */
  const repoName = (r) => (r || '').split('/').pop();
  /** @param {string} sev */
  const sevColor = (sev) => sev === 'high' ? 'text-red-400' : sev === 'medium' ? 'text-amber-400' : 'text-muted';
  let worst = $derived(findings.some((/** @type {any} */ f) => f.severity === 'high') ? 'high' : findings.some((/** @type {any} */ f) => f.severity === 'medium') ? 'medium' : findings.length ? 'low' : 'none');
  /** @type {Record<string,string>} */
  const ring = { high: 'border-red-500/40', medium: 'border-amber-500/40', low: 'border-line', none: 'border-line' };
  // Verify badge: issue (has findings) > verified (clean) > unverified.
  let badge = $derived(
    vstatus === 'issue' || findings.length ? { icon: '⚠', cls: 'text-amber-400', label: 'has issues' }
    : vstatus === 'verified' || vstatus === 'clean' ? { icon: '✓', cls: 'text-green-400', label: 'verified' }
    : { icon: '○', cls: 'text-muted', label: 'not verified yet' }
  );
</script>

<div class="border rounded-lg bg-card {ring[worst]}">
  <!-- Header (always visible, click to expand) -->
  <button type="button" class="w-full flex items-center gap-2 p-2.5 text-left" onclick={() => (open = !open)}>
    <span class="text-[10px] text-muted w-5 shrink-0 tabular-nums">{open ? '▾' : '▸'}{n}</span>
    <span class="{badge.cls} shrink-0" title={badge.label}>{badge.icon}</span>
    <span class="font-medium text-sm flex-1 min-w-0 truncate">{t.title}</span>
    {#if findings.length}<span class="text-[10px] {sevColor(worst)} shrink-0">{findings.length}⚑</span>{/if}
    <span class="font-mono text-[10px] text-muted shrink-0">{repoName(t.repo)}</span>
  </button>

  {#if open}
    <div class="px-2.5 pb-2.5 space-y-2">
      <div class="text-[11px] text-muted flex items-center gap-2 flex-wrap">
        <span>{t.role || '—'}</span>
        {#if t.dependsOn?.length}<span>· after {t.dependsOn.map((/** @type {number} */ d) => '#' + (d + 1)).join(', ')}</span>{/if}
        <span class="ml-auto flex items-center gap-1">
          <span>base</span>
          {#if branchOpts.length}
            <FilterSelect dense placeholder="base" value={base} options={branchOpts} onChange={onBase} filter={false} />
          {:else}<span class="font-mono">{base || '…'}</span>{/if}
        </span>
      </div>
      {#if t.goal}<p class="text-xs text-muted whitespace-pre-wrap">{t.goal}</p>{/if}
      {#if t.criteria}<p class="text-[11px] text-muted/80"><span class="uppercase tracking-wide">done when</span> · {t.criteria}</p>{/if}

      {#if findings.length}
        <div class="space-y-1.5 border-t border-line pt-2">
          <div class="text-[10px] uppercase tracking-wide {sevColor(worst)}">{findings.length} finding{findings.length > 1 ? 's' : ''} — check to send to the planner</div>
          {#each findings as f (f.issue)}
            <label class="flex gap-2 text-[11px] cursor-pointer hover:bg-elevated/50 rounded px-1 py-0.5">
              <input type="checkbox" class="mt-0.5 shrink-0" checked={isSelected(f.issue)} onchange={() => toggle(f.issue)} />
              <span class="min-w-0">
                <span class={sevColor(f.severity)}>● {f.severity}</span> {f.issue}
                {#if f.fix}<span class="block text-muted mt-0.5">↳ {f.fix}</span>{/if}
              </span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
