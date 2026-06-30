<script>
  // htop-style popdown: a bar per CPU core + a memory bar (used vs cache vs free).
  /** @type {{ stats: { cpu:number, cores:number[], mem:{percent:number,usedGb:number,availGb:number,cachedGb:number,totalGb:number} } }} */
  let { stats } = $props();

  /** @param {number} p */
  const fill = (p) => (p >= 85 ? 'bg-red-500' : p >= 50 ? 'bg-amber-500' : 'bg-green-500');
  let cachePct = $derived(stats.mem.totalGb ? Math.round((stats.mem.cachedGb / stats.mem.totalGb) * 100) : 0);
</script>

<div class="w-64 p-3 space-y-3 text-content">
  <div>
    <div class="flex justify-between text-[11px] text-muted mb-1">
      <span>CPU — {stats.cores.length} cores</span><span class="font-mono">{stats.cpu}%</span>
    </div>
    <div class="space-y-1">
      {#each stats.cores as c, i (i)}
        <div class="flex items-center gap-2">
          <span class="w-5 text-[10px] text-muted text-right font-mono">{i}</span>
          <div class="flex-1 h-2 bg-canvas rounded overflow-hidden">
            <div class="h-full {fill(c)} transition-all duration-300" style:width="{c}%"></div>
          </div>
          <span class="w-8 text-[10px] text-muted font-mono text-right">{c}%</span>
        </div>
      {/each}
    </div>
  </div>

  <div>
    <div class="flex justify-between text-[11px] text-muted mb-1">
      <span>Memory</span><span class="font-mono">{stats.mem.usedGb} / {stats.mem.totalGb} GB</span>
    </div>
    <!-- used (colored) + cache (dim) + free (track) -->
    <div class="flex h-3 bg-canvas rounded overflow-hidden">
      <div class="h-full {fill(stats.mem.percent)}" style:width="{stats.mem.percent}%"></div>
      <div class="h-full bg-muted/30" style:width="{cachePct}%"></div>
    </div>
    <div class="flex justify-between text-[10px] text-muted mt-1 font-mono">
      <span>{stats.mem.percent}% used</span>
      <span>cache {stats.mem.cachedGb}G · free {stats.mem.availGb}G</span>
    </div>
  </div>
</div>
