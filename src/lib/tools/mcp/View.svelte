<script>
  // Manage MCP servers: global (shared) and per-project (.mcp.json). Add DBs from
  // a form, edit them in place (blank password = keep current), and move a server
  // between global and a project. Secrets never round-trip through the browser.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { projectStore } from '$lib/projects.svelte.js';
  import FilterSelect from '$lib/components/FilterSelect.svelte';

  /** @type {{name:string,kind:string,summary:string,fields:any}[]} */
  let global = $state([]);
  /** @type {{path:string,name:string,hasMcp:boolean}[]} */
  let projects = $state([]);
  let projectPath = $state(projectStore.active?.dir || '');
  /** @type {{name:string,kind:string,summary:string,fields:any}[]} */
  let projectServers = $state([]);
  let status = $state('');

  // form / edit state
  let kind = $state('postgres');
  let formScope = $state('project'); // 'project' | 'global'
  /** @type {{scope:string,projectPath:string,name:string}|null} */
  let editing = $state(null);
  let f = $state({ name: '', host: '127.0.0.1', port: '', database: '', user: '', password: '' });

  async function loadGlobal() { global = (await api.mcpGlobal()).servers; }
  async function loadProjects() { projects = (await api.mcpProjects()).projects; }
  async function loadProjectServers() { projectServers = projectPath ? (await api.mcpProject(projectPath)).servers : []; }
  async function refreshAll() { await Promise.all([loadGlobal(), loadProjects(), loadProjectServers()]); }

  onMount(async () => { await Promise.all([loadGlobal(), loadProjects()]); });
  $effect(() => { projectPath; loadProjectServers(); });

  function resetForm() {
    editing = null;
    f = { name: '', host: '127.0.0.1', port: '', database: '', user: '', password: '' };
  }
  /** @param {any} s @param {string} scope @param {string} pPath */
  function startEdit(s, scope, pPath) {
    if (!s.fields) { status = `${s.name} isn't a DB server — edit it in its config file`; return; }
    editing = { scope, projectPath: pPath, name: s.name };
    kind = s.kind;
    formScope = scope;
    f = { name: s.name, host: s.fields.host || '', port: s.fields.port || '', database: s.fields.database || '', user: s.fields.user || '', password: '' };
    status = `editing ${s.name} — leave password blank to keep current`;
  }

  async function save() {
    if (!f.name) { status = 'name required'; return; }
    const scope = editing ? editing.scope : formScope;
    const pPath = scope === 'project' ? (editing ? editing.projectPath : projectPath) : undefined;
    if (scope === 'project' && !pPath) { status = 'pick a project first'; return; }
    status = editing ? 'saving…' : 'adding…';
    try {
      const r = await api.mcpAdd({ scope, name: f.name, kind, projectPath: pPath,
        config: { host: f.host, port: f.port, database: f.database, user: f.user, password: f.password } });
      if (r.error) { status = r.error; return; }
      status = scope === 'global' ? 'saved (global) — restart claude sessions to load' : `saved to ${scope === 'project' ? pPath + '/.mcp.json' : ''}`;
      resetForm();
      await refreshAll();
    } catch (e) { status = String(e); }
  }
  /** @param {string} scope @param {string} name @param {string} pPath */
  async function remove(scope, name, pPath) {
    status = 'removing…';
    await api.mcpRemove({ scope, name, projectPath: scope === 'project' ? pPath : undefined });
    status = 'removed';
    await refreshAll();
  }
  /** @param {string} scope @param {string} pPath */
  function moveOptions(scope, pPath) {
    /** @type {{value:string,label:string}[]} */
    const opts = [];
    if (scope !== 'global') opts.push({ value: 'global', label: 'Global' });
    for (const p of projects) if (p.path !== pPath) opts.push({ value: p.path, label: p.name });
    return opts;
  }
  /** @param {string} name @param {{scope:string,projectPath:string}} from @param {string} target */
  async function move(name, from, target) {
    if (!target) return;
    const to = target === 'global' ? { scope: 'global' } : { scope: 'project', projectPath: target };
    status = `moving ${name}…`;
    const r = await api.mcpMove({ name, from, to });
    status = r.error ? r.error : `moved ${name}`;
    await refreshAll();
  }
</script>

{#snippet row(/** @type {any} */ s, /** @type {string} */ scope, /** @type {string} */ pPath)}
  <div class="flex items-center gap-2 px-3 py-2">
    <span class="font-medium">{s.name}</span>
    {#if s.kind && s.kind !== 'command'}<span class="text-[10px] uppercase tracking-wide text-muted border border-line rounded px-1">{s.kind}</span>{/if}
    <span class="text-muted text-xs truncate flex-1">{s.summary}</span>
    {#if s.fields}<button class="text-xs text-accent hover:underline" onclick={() => startEdit(s, scope, pPath)}>edit</button>{/if}
    <FilterSelect dense placeholder="move →" value={''}
      options={moveOptions(scope, pPath)}
      onChange={(v) => move(s.name, { scope, projectPath: pPath }, v)} />
    <button class="text-xs text-red-400 hover:underline" onclick={() => remove(scope, s.name, pPath)}>remove</button>
  </div>
{/snippet}

<div class="h-full overflow-auto p-5 text-sm text-content space-y-6 max-w-3xl">
  <div>
    <h2 class="font-semibold mb-2">Global servers <span class="text-muted font-normal">— shared across every session</span></h2>
    <div class="border border-line rounded divide-y divide-line">
      {#each global as s (s.name)}{@render row(s, 'global', '')}{:else}<div class="px-3 py-2 text-muted">none</div>{/each}
    </div>
  </div>

  <div>
    <h2 class="font-semibold mb-2">Project servers <span class="text-muted font-normal">— in that repo's .mcp.json</span></h2>
    <div class="max-w-xs">
      <FilterSelect block placeholder="— pick a project —" bind:value={projectPath}
        options={projects.map((p) => ({ value: p.path, label: p.name + (p.hasMcp ? ' •' : '') }))} />
    </div>
    {#if projectPath}
      <div class="border border-line rounded divide-y divide-line mt-2">
        {#each projectServers as s (s.name)}{@render row(s, 'project', projectPath)}{:else}<div class="px-3 py-2 text-muted">no .mcp.json servers yet</div>{/each}
      </div>
    {/if}
  </div>

  <div class="border border-line rounded p-4 space-y-3">
    <div class="flex items-center gap-2">
      <h2 class="font-semibold">{editing ? `Edit ${editing.name}` : 'Add a database'}</h2>
      {#if editing}<span class="text-xs text-muted">({editing.scope})</span><button class="text-xs text-accent hover:underline ml-auto" onclick={resetForm}>cancel</button>{/if}
    </div>
    <div class="flex flex-wrap gap-3">
      {#if !editing}
        <label class="flex items-center gap-1">Scope
          <select class="bg-elevated border border-line rounded px-2 py-1" bind:value={formScope}>
            <option value="project">This project</option>
            <option value="global">Global</option>
          </select>
        </label>
      {/if}
      <label class="flex items-center gap-1">Type
        <select class="bg-elevated border border-line rounded px-2 py-1" bind:value={kind} disabled={!!editing}>
          <option value="postgres">Postgres</option>
          <option value="mysql">MySQL</option>
        </select>
      </label>
    </div>
    {#if !editing && formScope === 'project' && !projectPath}<p class="text-amber-400 text-xs">Pick a project above first.</p>{/if}
    <div class="grid grid-cols-2 gap-2">
      <input class="bg-elevated border border-line rounded px-2 py-1 disabled:opacity-50" placeholder="server name (e.g. appdb)" bind:value={f.name} disabled={!!editing} />
      <input class="bg-elevated border border-line rounded px-2 py-1" placeholder="database" bind:value={f.database} />
      <input class="bg-elevated border border-line rounded px-2 py-1" placeholder="host" bind:value={f.host} />
      <input class="bg-elevated border border-line rounded px-2 py-1" placeholder={kind === 'mysql' ? 'port (3306)' : 'port (5432)'} bind:value={f.port} />
      <input class="bg-elevated border border-line rounded px-2 py-1" placeholder="user" bind:value={f.user} />
      <input class="bg-elevated border border-line rounded px-2 py-1" type="password" placeholder={editing ? 'leave blank to keep' : 'password'} bind:value={f.password} />
    </div>
    <div class="flex items-center gap-3">
      <button class="bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1.5"
        disabled={!editing && formScope === 'project' && !projectPath} onclick={save}>{editing ? 'Save' : 'Add server'}</button>
      <span class="text-muted text-xs">{status}</span>
    </div>
    <p class="text-muted text-xs">Read-only by default. Project scope writes the password into the repo's
      <code>.mcp.json</code> — gitignore it or use a secret manager for shared repos.</p>
  </div>
</div>
