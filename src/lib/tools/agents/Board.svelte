<script>
  // Kanban board: tickets in lifecycle columns. Two layouts: flat columns, or
  // "group by plan" SWIMLANES (shared column headers, one horizontal lane per
  // plan with its controls on the lane header). Create, dispatch (Start), act on
  // cards, batch-approve/accept, drag between columns to transition.
  import { COLUMNS, chainOrder } from './status.js';
  import { api } from '$lib/api.js';
  import { openPlannerTab, attachTerminal } from '$lib/tabs/store.svelte.js';
  import FilterSelect from '$lib/components/FilterSelect.svelte';
  import BoardCard from './BoardCard.svelte';
  import PlanBar from './PlanBar.svelte';
  import Modal from '$lib/components/Modal.svelte';

  /** @type {{
   *  tasks:any[], onChanged:()=>void, onOpen:(t:any)=>void, onNew:()=>void,
   *  showProject?:boolean, projectLabel?:(t:any)=>string
   * }} */
  let { tasks, onChanged, onOpen, onNew, showProject = false, projectLabel = () => '' } = $props();

  let selected = $state(new Set());
  let busy = $state(false);
  let refreshing = $state(false);
  // Show the spinner for at least ~600ms so a fast reload still gives clear feedback.
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const t = new Promise((r) => setTimeout(r, 600));
    try { await onChanged(); } finally { await t; refreshing = false; }
  }
  let dragId = $state('');
  /** @type {Map<string,number>} */
  const EMPTY = new Map();

  let groupByPlan = $state(false);
  let showArchived = $state(false);
  let planFilter = $state('');
  let planBusy = $state(false);
  /** @type {Record<string,boolean>} */
  let collapsed = $state({});
  try { groupByPlan = localStorage.getItem('board.swimlanes') === '1'; } catch {}
  function toggleSwimlanes() { groupByPlan = !groupByPlan; try { localStorage.setItem('board.swimlanes', groupByPlan ? '1' : '0'); } catch {} }

  // Plans where every ticket has planArchived=true are considered archived.
  let archivedPlans = $derived(new Set(
    [...new Set(tasks.map((/** @type {any} */ t) => t.plan).filter(Boolean))].filter((e) => {
      const ts = tasks.filter((/** @type {any} */ t) => t.plan === e);
      return ts.length > 0 && ts.every((/** @type {any} */ t) => t.planArchived);
    })
  ));
  let activeTasks = $derived(showArchived ? tasks : tasks.filter((/** @type {any} */ t) => !t.plan || !archivedPlans.has(t.plan)));
  let plans = $derived([...new Set(activeTasks.map((/** @type {any} */ t) => t.plan).filter(Boolean))]);
  let planOptions = $derived([{ value: '', label: 'all plans' }, ...plans.map((/** @type {string} */ e) => ({ value: e, label: e }))]);
  let visibleTasks = $derived(planFilter ? activeTasks.filter((/** @type {any} */ t) => t.plan === planFilter) : activeTasks);
  // Flat-mode plan banner (when filtered to one plan).
  let planTasks = $derived(planFilter ? visibleTasks : []);
  let planNum = $derived(chainOrder(planTasks));
  let planAnchor = $derived(planTasks[0]?.id || '');

  // Swimlanes: one lane per plan (real plans first, ungrouped last), each with its
  // own dependency numbering.
  let lanes = $derived(buildLanes(visibleTasks));
  /** @param {any[]} list */
  function buildLanes(list) {
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const t of list) { const k = t.plan || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k)?.push(t); }
    return [...groups.entries()]
      .map(([raw, ts]) => ({ raw, plan: raw || '(ungrouped)', tasks: ts, num: chainOrder(ts) }))
      .sort((a, b) => (a.raw ? 0 : 1) - (b.raw ? 0 : 1) || a.plan.localeCompare(b.plan));
  }

  /** @param {any} t @param {Map<string,number>} num — "#3 · after #1" or '' */
  function chainLabelIn(t, num) {
    const n = num.get(t.id);
    if (!n) return '';
    const after = (t.blockedBy || []).map((/** @type {string} */ b) => num.get(b)).filter(Boolean).sort((/** @type {number} */ a, /** @type {number} */ c) => a - c);
    return `#${n}` + (after.length ? ` · after ${after.map((/** @type {number} */ x) => '#' + x).join(',')}` : '');
  }
  /** @param {any[]} scope @param {{states:string[]}} col */
  function colTasksIn(scope, col) {
    // Order by chain number (#1 first — blockers before dependents) so a plan's
    // tickets read 1,2,3 down each column. Manual rank + createdAt break ties.
    const order = chainOrder(scope);
    return scope.filter((/** @type {any} */ t) => col.states.includes(t.status))
      .sort((a, b) => ((order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9)) || ((a.rank ?? 0) - (b.rank ?? 0)) || ((a.createdAt || 0) - (b.createdAt || 0)));
  }

  /** @param {'run'|'pause'|'resume'|'pr'} kind @param {string} anchorId */
  async function planCtl(kind, anchorId) {
    if (!anchorId) return;
    planBusy = true;
    const r = await (kind === 'run' ? api.agentPlanRun(anchorId) : kind === 'pause' ? api.agentPlanPause(anchorId) : kind === 'resume' ? api.agentPlanResume(anchorId) : api.agentPlanPR(anchorId));
    planBusy = false;
    if (r?.error) alert(r.error); else if (kind === 'pr' && r?.url) alert(`Plan PR opened:\n${r.url}`);
    onChanged();
  }

  /** @param {string} from @param {string} to */
  async function doRenamePlan(from, to) { if (!from || !to) return; await api.agentRenamePlan(from, to); onChanged(); }
  /** @param {string} planName @param {boolean} [archived] */
  async function doArchivePlan(planName, archived = true) { if (!planName) return; await api.agentArchivePlan(planName, archived); onChanged(); }
  // Open one chat about the whole plan (anchored on any of its tickets).
  /** @param {string} anchorId */
  async function planChat(anchorId) {
    if (!anchorId) return;
    const r = await api.agentPlanChat(anchorId);
    if (r?.error) { alert(r.error); return; }
    attachTerminal(r.sessionKey, '💬 ' + (r.title || 'plan').slice(0, 20));
  }
  // Apply the plan's branches into the live repos (to test) or restore them to base.
  // Driven through a modal (confirm -> running -> result), not a native dialog.
  /** @type {any} */
  let localModal = $state(null);
  /** @param {string} anchorId @param {'apply'|'revert'} kind */
  function planLocal(anchorId, kind) {
    if (!anchorId) return;
    if (kind === 'apply') localModal = { stage: 'confirm', kind, anchorId };
    else runPlanLocal(anchorId, 'revert');
  }
  /** @param {string} anchorId @param {'apply'|'revert'} kind */
  async function runPlanLocal(anchorId, kind) {
    localModal = { stage: 'running', kind };
    planBusy = true;
    const r = kind === 'apply' ? await api.agentPlanApplyLocal(anchorId) : await api.agentPlanRevertLocal(anchorId);
    planBusy = false;
    if (r?.error) localModal = { stage: 'result', kind, error: r.error, results: [] };
    else localModal = { stage: 'result', kind, results: r.results || [], note: r.note };
    onChanged();
  }
  /** @param {any} t */
  async function start(t) { if (t.depBlocked) return; await api.agentStart(t.id); onChanged(); }
  /** @param {any} t */
  async function approve(t) { await api.agentApprove(t.id); onChanged(); }
  /** @param {any} t */
  async function accept(t) {
    const r = await api.agentAccept(t.id);
    if (r?.landConflict && !r.landConflict.landed) {
      const c = r.landConflict;
      alert(`Couldn't auto-merge "${t.title}" into ${c.planBranch} (risk: ${c.risk}).\n\n${c.summary}\n\nResolve manually, then accept again.`);
    } else if (r?.error) alert(r.error);
    onChanged();
  }
  /** @param {any} t */
  async function remove(t) { await api.agentRemove(t.id); onChanged(); }
  /** @param {string} id */
  function toggle(id) { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); selected = s; }

  let selPlan = $derived(visibleTasks.filter((/** @type {any} */ t) => selected.has(t.id) && t.status === 'plan-review'));
  let selReview = $derived(visibleTasks.filter((/** @type {any} */ t) => selected.has(t.id) && t.status === 'review'));
  async function batchApprove() { busy = true; for (const t of selPlan) await api.agentApprove(t.id); selected = new Set(); busy = false; onChanged(); }
  async function batchAccept() { busy = true; for (const t of selReview) await api.agentAccept(t.id); selected = new Set(); busy = false; onChanged(); }

  /** @param {string} status */
  const colOf = (status) => COLUMNS.find((c) => c.states.includes(status));
  /** @param {any} t @param {{key:string}} col */
  function crossColumn(t, col) {
    if (t.status === 'todo' && col.key === 'working') { if (!t.depBlocked) start(t); }
    else if (t.status === 'plan-review' && col.key === 'working') approve(t);
    else if (t.status === 'review' && col.key === 'done') accept(t);
  }
  /** @param {string[]} ids */
  async function persistOrder(ids) { await api.agentReorder(ids); onChanged(); }
  /** @param {{key:string,states:string[]}} col @param {any[]} scope */
  function dropOnColumn(col, scope) {
    const t = tasks.find((x) => x.id === dragId); dragId = '';
    if (!t) return;
    if (colOf(t.status)?.key === col.key) {
      const ids = colTasksIn(scope, col).map((x) => x.id).filter((id) => id !== t.id);
      ids.push(t.id);
      persistOrder(ids);
    } else crossColumn(t, col);
  }
  /** @param {any} target @param {any[]} scope */
  function dropOnCard(target, scope) {
    const t = tasks.find((x) => x.id === dragId); dragId = '';
    if (!t || t.id === target.id) return;
    const src = colOf(t.status); const tgt = colOf(target.status);
    if (!tgt) return;
    if (src?.key === tgt.key) {
      const ids = colTasksIn(scope, tgt).map((x) => x.id).filter((id) => id !== t.id);
      ids.splice(Math.max(0, ids.indexOf(target.id)), 0, t.id);
      persistOrder(ids);
    } else crossColumn(t, tgt);
  }
</script>

<div class="h-full flex flex-col">
  <div class="flex items-center gap-2 px-3 h-10 border-b border-line shrink-0">
    <button class="text-xs bg-accent text-white rounded px-2.5 py-1" onclick={() => openPlannerTab()} title="Open a Plan-with-Claude tab; discuss a feature and it proposes the tickets">🧠 Plan with Claude</button>
    <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-2.5 py-1" onclick={onNew}>+ New ticket</button>
    {#if selPlan.length}<button class="text-xs border border-line rounded px-2 py-1 hover:bg-elevated" disabled={busy} onclick={batchApprove}>Approve {selPlan.length}</button>{/if}
    {#if selReview.length}<button class="text-xs border border-line rounded px-2 py-1 hover:bg-elevated" disabled={busy} onclick={batchAccept}>Accept {selReview.length}</button>{/if}
    {#if selected.size}<button class="text-xs text-muted" onclick={() => (selected = new Set())}>clear</button>{/if}
    <div class="ml-auto flex items-center gap-2">
      <button class="text-xs border border-line text-muted rounded px-2 py-1 hover:bg-elevated hover:text-content disabled:opacity-60" disabled={refreshing} onclick={refresh} title="Reload tickets from the server"><span class="inline-block {refreshing ? 'animate-spin' : ''}">↻</span> Refresh</button>
      {#if archivedPlans.size}<button class="text-xs border rounded px-2 py-1 hover:bg-elevated {showArchived ? 'text-accent border-accent/50' : 'text-muted border-line'}" onclick={() => (showArchived = !showArchived)} title="Show or hide completed archived plans">📦 {showArchived ? 'Hide archived' : `${archivedPlans.size} archived`}</button>{/if}
      <button class="text-xs border rounded px-2 py-1 hover:bg-elevated {groupByPlan ? 'text-accent border-accent/50' : 'text-muted border-line'}" onclick={toggleSwimlanes} title="Group the board into one horizontal lane per plan">🏊 Swimlanes</button>
      {#if plans.length && !groupByPlan}<FilterSelect dense placeholder="plan" bind:value={planFilter} options={planOptions} filter={false} />{/if}
    </div>
  </div>

  {#if !groupByPlan}
    {#if planFilter && planTasks.length}
      <div class="flex items-center px-3 py-2 border-b border-line shrink-0 bg-canvas/40">
        <PlanBar plan={planFilter} tasks={planTasks} busy={planBusy} onCtl={(/** @type {any} */ k) => planCtl(k, planAnchor)} onRename={(/** @type {string} */ to) => doRenamePlan(planFilter, to)} onChat={() => planChat(planAnchor)} onLocal={(/** @type {any} */ k) => planLocal(planAnchor, k)} onArchive={() => doArchivePlan(planFilter)} />
      </div>
    {/if}
    <div class="flex-1 min-h-0 overflow-x-auto">
      <div class="flex gap-3 p-3 h-full min-w-max">
        {#each COLUMNS as col (col.key)}
          {@render column(col, visibleTasks, planFilter ? planNum : EMPTY, true)}
        {/each}
      </div>
    </div>
  {:else}
    <div class="flex-1 min-h-0 overflow-auto">
      <div class="flex gap-3 px-3 pt-2 pb-1 sticky top-0 bg-card z-10 min-w-max border-b border-line/40">
        {#each COLUMNS as col (col.key)}
          <div class="w-64 shrink-0 text-[11px] uppercase tracking-wide text-muted px-2">{col.label}</div>
        {/each}
      </div>
      {#each lanes as lane (lane.plan)}
        <div class="min-w-max border-b border-line/60">
          <div class="flex items-center gap-2 px-3 py-1.5 bg-canvas/40">
            <button class="text-[11px] text-muted w-4 shrink-0" onclick={() => (collapsed = { ...collapsed, [lane.plan]: !collapsed[lane.plan] })}>{collapsed[lane.plan] ? '▸' : '▾'}</button>
            {#if lane.raw}
              <PlanBar plan={lane.plan} tasks={lane.tasks} busy={planBusy} onCtl={(/** @type {any} */ k) => planCtl(k, lane.tasks[0]?.id)} onRename={(/** @type {string} */ to) => doRenamePlan(lane.raw, to)} onChat={() => planChat(lane.tasks[0]?.id)} onLocal={(/** @type {any} */ k) => planLocal(lane.tasks[0]?.id, k)} onArchive={() => doArchivePlan(lane.raw)} />
            {:else}
              <span class="text-sm text-muted">{lane.plan} <span class="text-[11px]">· {lane.tasks.length}</span></span>
            {/if}
          </div>
          {#if !collapsed[lane.plan]}
            <div class="flex gap-3 px-3 pb-3 min-w-max">
              {#each COLUMNS as col (col.key)}
                {@render column(col, lane.tasks, lane.num, false)}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#snippet column(/** @type {{key:string,label:string,states:string[]}} */ col, /** @type {any[]} */ scope, /** @type {Map<string,number>} */ num, /** @type {boolean} */ showHeader)}
  <div class="w-64 shrink-0 flex flex-col rounded-lg border border-line/50 bg-canvas/30"
    ondragover={(e) => e.preventDefault()} ondrop={() => dropOnColumn(col, scope)} role="list">
    {#if showHeader}
      <div class="px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted flex items-center gap-2">{col.label}<span class="text-content">{colTasksIn(scope, col).length}</span></div>
    {/if}
    <div class="flex-1 overflow-auto px-2 pb-2 pt-2 space-y-2 min-h-[3rem]">
      {#each colTasksIn(scope, col) as t (t.id)}
        <div draggable="true" class="cursor-grab active:cursor-grabbing"
          ondragstart={() => (dragId = t.id)} ondragend={() => (dragId = '')}
          ondragover={(e) => { e.preventDefault(); e.stopPropagation(); }}
          ondrop={(e) => { e.stopPropagation(); dropOnCard(t, scope); }} role="listitem">
          <BoardCard task={t} {showProject} projectLabel={projectLabel(t)} chain={chainLabelIn(t, num)}
            selectable={['plan-review', 'review'].includes(t.status)} selected={selected.has(t.id)}
            onToggle={() => toggle(t.id)} onOpen={() => onOpen(t)}
            onStart={() => start(t)} onApprove={() => approve(t)} onAccept={() => accept(t)} onRemove={() => remove(t)} />
        </div>
      {:else}
        <div class="text-[11px] text-muted px-2 py-2 text-center">—</div>
      {/each}
    </div>
  </div>
{/snippet}

{#if localModal}
  <Modal title={localModal.kind === 'apply' ? '🧪 Test plan locally' : '↩ Restore dev'} max="max-w-md" onClose={() => { if (localModal.stage !== 'running') localModal = null; }}>
    {#if localModal.stage === 'confirm'}
      <div class="text-sm space-y-3">
        <p>Check out this plan's branches in your <b>live repos</b> so you can run and test the integrated work.</p>
        <ul class="text-xs text-muted list-disc pl-4 space-y-1">
          <li>Any uncommitted edits are stashed automatically (restored on <b>Restore dev</b>).</li>
          <li><b>npm install</b> runs automatically if package.json changed.</li>
          <li>All <b>pm2 processes</b> for each repo are restarted automatically.</li>
        </ul>
        <div class="flex justify-end gap-2 pt-1">
          <button class="text-xs border border-line rounded px-3 py-1.5 hover:bg-elevated" onclick={() => (localModal = null)}>Cancel</button>
          <button class="text-xs bg-emerald-700 hover:bg-emerald-600 text-white rounded px-3 py-1.5" onclick={() => runPlanLocal(localModal.anchorId, 'apply')}>Yes, apply</button>
        </div>
      </div>
    {:else if localModal.stage === 'running'}
      <div class="text-sm space-y-2 py-2">
        <div class="flex items-center gap-2"><span class="inline-block w-2 h-2 rounded-full bg-accent animate-pulse shrink-0"></span><span>{localModal.kind === 'apply' ? 'Checking out branches, running npm install, restarting services…' : 'Restoring repos and restarting services…'}</span></div>
        <p class="text-xs text-muted">This may take a minute if npm install is needed.</p>
      </div>
    {:else}
      <div class="text-sm space-y-3">
        {#if localModal.error}
          <p class="text-red-600 dark:text-red-400">{localModal.error}</p>
        {:else}
          <div class="space-y-2">
            {#each localModal.results as x (x.repo)}
              <div class="rounded border {x.ok ? 'border-line' : 'border-red-500/40'} p-2 space-y-1">
                <div class="text-xs flex items-center gap-2">
                  <span class={x.ok ? 'text-green-500' : 'text-red-400'}>{x.ok ? '✓' : '✗'}</span>
                  <span class="font-mono font-medium">{x.repo}</span>
                  {#if x.ok}<span class="text-muted">→ {x.branch}{x.stashed ? ' · stashed' : ''}{x.stashRestored ? ' · stash restored' : ''}</span>{:else}<span class="text-red-400">{x.msg}</span>{/if}
                </div>
                {#if x.ok}
                  <div class="pl-4 space-y-0.5">
                    {#if x.pkgChanged}
                      <div class="text-[11px] {x.npmInstalled ? 'text-green-400' : 'text-red-400'}">
                        {x.npmInstalled ? '✓ npm install' : `✗ npm install failed${x.npmError ? ': ' + x.npmError : ''}`}
                      </div>
                    {:else}
                      <div class="text-[11px] text-muted">· package.json unchanged — skipped npm install</div>
                    {/if}
                    {#each (x.pm2 || []) as p (p.name)}
                      <div class="text-[11px] {p.ok ? 'text-green-400' : 'text-amber-400'}">
                        {p.ok ? `✓ pm2 restart ${p.name}` : `⚠ pm2 restart ${p.name} failed${p.msg ? ': ' + p.msg : ''}`}
                      </div>
                    {/each}
                    {#if !(x.pm2 || []).length}
                      <div class="text-[11px] text-muted">· no pm2 processes found for this repo</div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        <div class="flex justify-end pt-1"><button class="text-xs bg-elevated hover:bg-line rounded px-3 py-1.5" onclick={() => (localModal = null)}>Done</button></div>
      </div>
    {/if}
  </Modal>
{/if}
