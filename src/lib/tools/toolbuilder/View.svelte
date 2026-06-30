<script>
  // Tool builder. MCP tools give agents native actions. Install one into a
  // project (writes its .mcp.json) so that project's agents can use it; or
  // scaffold a brand-new tool with Claude from the template.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import FilterSelect from '$lib/components/FilterSelect.svelte';

  /** @type {any[]} */
  let tools = $state([]);
  /** @type {{id:string,label:string}[]} */
  let projects = $state([]);
  /** @type {Record<string,string>} */
  let target = $state({});
  let status = $state('');
  let sName = $state(''); let sDesc = $state(''); let scaffolding = $state(false);

  async function load() { try { const r = await api.toolsCatalog(); tools = r.tools; projects = r.projects; } catch {} }
  onMount(load);

  let projOpts = $derived([{ value: '', label: 'project…' }, ...projects.map((p) => ({ value: p.id, label: p.label }))]);
  /** @param {string} id */
  const plabel = (id) => projects.find((p) => p.id === id)?.label || id;

  /** @param {string} toolId */
  async function install(toolId) {
    const project = target[toolId];
    if (!project) { status = 'pick a project first'; return; }
    const r = await api.toolInstall({ tool: toolId, project });
    status = r.error || `installed into ${plabel(project)}`;
    await load();
  }
  /** @param {string} toolId @param {string} project */
  async function uninstall(toolId, project) { await api.toolUninstall({ tool: toolId, project }); await load(); }

  async function scaffold() {
    if (!sName.trim() || !sDesc.trim()) { status = 'name + description required'; return; }
    scaffolding = true; status = '🛠 Claude is writing the tool…';
    try { const r = await api.toolScaffold({ name: sName.trim(), description: sDesc.trim() }); status = r.error || `created ${r.id} — install it into a project below`; if (!r.error) { sName = ''; sDesc = ''; await load(); } }
    catch (e) { status = String(e); }
    scaffolding = false;
  }
</script>

<div class="h-full overflow-auto p-4 text-sm space-y-4">
  <div>
    <h2 class="font-semibold mb-1">Tools</h2>
    <p class="text-xs text-muted">MCP tools give agents native actions. Install one into a project so its agents can use it. Authoring contract: <code>server/mcp/BUILDING-TOOLS.md</code>.</p>
  </div>

  {#each tools as t (t.id)}
    <div class="border border-line rounded p-3 space-y-2">
      <div class="flex items-center gap-2">
        <span class="font-medium">{t.label}</span>
        <span class="text-[10px] bg-elevated rounded px-1 text-muted">{t.builtin ? 'built-in' : 'custom'}</span>
        <code class="text-[10px] text-muted ml-auto">{t.name}</code>
      </div>
      <p class="text-xs text-muted">{t.description}</p>
      {#if t.installedIn.length}
        <div class="flex flex-wrap gap-1 text-[11px] items-center"><span class="text-muted">installed in:</span>
          {#each t.installedIn as pid (pid)}<span class="bg-elevated rounded px-1.5 py-0.5 flex items-center gap-1">{plabel(pid)}<button class="text-red-400" title="uninstall" onclick={() => uninstall(t.id, pid)}>✕</button></span>{/each}
        </div>
      {/if}
      <div class="flex gap-2 items-center">
        <FilterSelect dense placeholder="project…" value={target[t.id] || ''} options={projOpts} onChange={(/** @type {string} */ v) => (target = { ...target, [t.id]: v })} />
        <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-2.5 py-1" onclick={() => install(t.id)}>Install</button>
      </div>
    </div>
  {/each}

  <div class="border border-line rounded p-3 space-y-2">
    <div class="font-medium">🛠 Scaffold a new tool with Claude</div>
    <input class="w-full bg-elevated border border-line rounded px-2 py-1" placeholder="tool name (lowercase-dashes)" bind:value={sName} />
    <textarea class="w-full bg-elevated border border-line rounded px-2 py-1 h-24 resize-none" placeholder="What should it do? What API/data does it talk to? Claude writes the MCP server from the template." bind:value={sDesc}></textarea>
    <div class="flex items-center gap-2">
      <button class="bg-accent text-white rounded px-3 py-1.5 disabled:opacity-40" disabled={scaffolding} onclick={scaffold}>Scaffold with Claude</button>
      <span class="text-xs text-muted">{status}</span>
    </div>
  </div>
</div>
