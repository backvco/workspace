<script>
  // Right slide-over for creating ONE ticket by hand (Plan-with-Claude lives in
  // the persistent app-level panel). Pick a target repo, optionally ✨ Enhance the
  // draft or apply a template, set dependencies/auto-review, then add to backlog
  // or start now.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { projectStore } from '$lib/projects.svelte.js';
  import FilterSelect from '$lib/components/FilterSelect.svelte';

  /** @type {{ tickets?: any[], onDone: ()=>void, onClose: ()=>void }} */
  let { tickets = [], onDone, onClose } = $props();

  let scopeDir = $derived(projectStore.active?.dir || '');
  /** @type {{dir:string,label:string,type:string}[]} */
  let targets = $state([]);
  /** @type {any[]} */
  let templates = $state([]);
  let dir = $state(projectStore.active?.dir || '');
  let goal = $state(''); let role = $state(''); let criteria = $state('');
  let model = $state(projectStore.active?.defaultModel || '');
  let permission = $state(projectStore.active?.defaultPermission || 'guarded');
  let autoReview = $state(false);
  let autoStart = $state(false);
  let autonomous = $state(false);
  let baseBranch = $state('');
  /** @type {{value:string,label:string}[]} */
  let branchOpts = $state([]);
  /** @type {string[]} */
  let blockedBy = $state([]);
  let tplPick = $state(''); let depPick = $state('');
  let status = $state(''); let enhancing = $state(false); let busy = $state(false);

  onMount(async () => {
    try { targets = (await api.agentTargets()).targets; } catch {}
    try { templates = (await api.agentTemplates()).templates; } catch {}
  });
  // Load the chosen repo's branches and preselect its default, so the agent
  // forks off a known base instead of whatever the live checkout is parked on.
  $effect(() => {
    const d = dir;
    if (!d) { branchOpts = []; return; }
    api.gitBranches(d).then((/** @type {any} */ r) => {
      const list = r?.branches || [];
      branchOpts = list.map((/** @type {string} */ b) => ({ value: b, label: b }));
      if (!baseBranch || !list.includes(baseBranch)) baseBranch = r?.default || r?.current || '';
    }).catch(() => { branchOpts = []; });
  });
  let targetOptions = $derived([
    ...(scopeDir ? [{ value: scopeDir, label: `${projectStore.active?.label || 'project'} (whole)` }] : []),
    ...targets.filter((t) => !scopeDir || (t.dir.startsWith(scopeDir) && t.dir !== scopeDir)).map((t) => ({ value: t.dir, label: t.label }))
  ]);
  let tplOptions = $derived([{ value: '', label: 'template…' }, ...templates.map((t) => ({ value: t.id, label: t.label }))]);
  let depOptions = $derived([{ value: '', label: '+ blocked by…' }, ...tickets.filter((t) => !blockedBy.includes(t.id)).map((t) => ({ value: t.id, label: t.title }))]);
  /** @param {string} id */
  const depTitle = (id) => tickets.find((t) => t.id === id)?.title || id;
  const ROLES = [{ value: '', label: '(role)' }, { value: 'implementer', label: 'implementer' }, { value: 'reviewer', label: 'reviewer' }, { value: 'planner', label: 'planner' }, { value: 'writer', label: 'writer' }, { value: 'triage', label: 'triage' }];
  const MODELS = [{ value: '', label: 'auto by role' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'Haiku' }];
  const PERMS = [{ value: 'guarded', label: '🛡 guarded' }, { value: 'full', label: '⚡ full auto' }, { value: 'strict', label: '🔒 strict' }];

  /** @param {string} id */
  function applyTemplate(id) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    goal = t.goal || goal; role = t.role || role; model = t.model || model;
    permission = t.permission || permission; criteria = t.criteria || criteria; autoReview = !!t.autoReview;
  }
  async function enhance() {
    if (!dir) { status = 'pick a target first'; return; }
    enhancing = true;
    try { const r = await api.agentEnhance({ dir, goal, criteria, role }); if (r.error) status = r.error; else { if (r.goal) goal = r.goal; if (r.criteria) criteria = r.criteria; if (r.role) role = r.role; status = r.note || 'enhanced'; } }
    catch (e) { status = String(e); }
    enhancing = false;
  }
  async function saveTemplate() {
    const label = prompt('Template name?'); if (!label) return;
    await api.agentTemplateAdd({ label, goal, role, model, permission, criteria, autoReview });
    templates = (await api.agentTemplates()).templates;
  }
  /** @param {boolean} start */
  async function create(start) {
    if (!dir) { status = 'pick a target'; return; }
    if (!goal.trim()) { status = 'describe the task'; return; }
    busy = true; status = start ? 'starting…' : 'adding…';
    try {
      const t = await api.agentCreate({ title: goal.trim().slice(0, 60), dir, baseBranch, goal: goal.trim(), model, role, permission, criteria: criteria.trim(), autoReview, autoStart, autonomous, blockedBy, start });
      if (t.error) { status = t.error; busy = false; return; }
      onDone(); onClose();
    } catch (e) { status = String(e); busy = false; }
  }
</script>

<div class="fixed inset-0 z-50 flex justify-end">
  <button class="flex-1 bg-black/30 dark:bg-black/50" aria-label="close" onclick={onClose}></button>
  <div class="w-[34rem] max-w-full h-full bg-card border-l border-line shadow-xl flex flex-col text-sm">
    <div class="flex items-center gap-2 px-4 h-11 border-b border-line shrink-0">
      <span class="text-sm font-semibold">New ticket</span>
      <button class="ml-auto text-muted hover:text-content" onclick={onClose}>✕</button>
    </div>
    <div class="flex-1 overflow-auto p-4 space-y-3">
      <div class="flex flex-wrap gap-2">
        <div class="min-w-48 flex-1"><FilterSelect block placeholder="target (repo / folder)…" bind:value={dir} options={targetOptions} /></div>
        {#if branchOpts.length}<span title="Branch the agent forks off and opens its PR against"><FilterSelect dense placeholder="base branch" bind:value={baseBranch} options={branchOpts} /></span>{/if}
        <FilterSelect dense placeholder="template…" bind:value={tplPick} options={tplOptions} filter={false} onChange={(/** @type {string} */ v) => { tplPick = v; applyTemplate(v); }} />
      </div>
      <div class="relative">
        <textarea class="w-full bg-elevated border border-line rounded px-2 py-1.5 resize-none h-40 pr-20" placeholder="What should this agent do? Be as detailed as you like — paste context, requirements, links." bind:value={goal}></textarea>
        <button class="absolute top-1.5 right-1.5 text-[11px] px-2 py-0.5 rounded bg-elevated border border-line hover:bg-card disabled:opacity-40" disabled={enhancing} onclick={enhance}>{enhancing ? '✨…' : '✨ Enhance'}</button>
      </div>
      <input class="w-full bg-elevated border border-line rounded px-2 py-1" placeholder="done when… (acceptance criteria)" bind:value={criteria} />
      <div class="flex flex-wrap gap-2">
        <FilterSelect dense placeholder="role" bind:value={role} options={ROLES} filter={false} />
        <FilterSelect dense placeholder="model" bind:value={model} options={MODELS} filter={false} />
        <FilterSelect dense placeholder="permissions" bind:value={permission} options={PERMS} filter={false} />
        <label class="flex items-center gap-1 text-xs text-muted"><input type="checkbox" bind:checked={autoReview} /> 🔎 auto-review</label>
        <label class="flex items-center gap-1 text-xs text-muted" title="Hands-off: auto-approve the plan and auto-accept on a clean (PASS) review"><input type="checkbox" bind:checked={autonomous} /> 🤖 autonomous</label>
      </div>
      {#if tickets.length}
        <div class="flex flex-wrap items-center gap-1">
          <FilterSelect dense placeholder="+ blocked by…" bind:value={depPick} options={depOptions} onChange={(/** @type {string} */ v) => { if (v) blockedBy = [...blockedBy, v]; depPick = ''; }} />
          {#each blockedBy as id (id)}<span class="text-[11px] bg-elevated border border-line rounded px-1.5 py-0.5 flex items-center gap-1">{depTitle(id)}<button class="text-red-600 dark:text-red-400" onclick={() => (blockedBy = blockedBy.filter((x) => x !== id))}>✕</button></span>{/each}
          {#if blockedBy.length}<label class="flex items-center gap-1 text-xs text-muted ml-1"><input type="checkbox" bind:checked={autoStart} /> ⏩ auto-start when unblocked</label>{/if}
        </div>
      {/if}
      <div class="flex items-center gap-2 pt-1">
        <button class="bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1.5 disabled:opacity-40" disabled={busy} onclick={() => create(true)}>Start now</button>
        <button class="border border-line rounded px-3 py-1.5 hover:bg-elevated disabled:opacity-40" disabled={busy} onclick={() => create(false)}>Add to backlog</button>
        <button class="text-xs text-muted hover:text-content" onclick={saveTemplate}>Save template</button>
        <span class="text-xs text-muted ml-auto">{status}</span>
      </div>
      <p class="text-[11px] text-muted">For a whole feature, use <span class="text-content">🧠 Plan with Claude</span> instead — it splits the work into per-repo tickets for you.</p>
    </div>
  </div>
</div>
