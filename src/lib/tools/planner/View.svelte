<script>
  // Plan-with-Claude tab: chat (left) + a roomy review surface (right) where each
  // proposed ticket is a card with its verifier findings inline. Bound to a planner
  // via params().plannerId — created lazily on first mount, then persisted so the
  // tab (and its planning session) reopen on any device.
  import { untrack } from 'svelte';
  import { useTab } from '$lib/tabs/context.js';
  import { getActiveProject } from '$lib/session.js';
  import { api } from '$lib/api.js';
  import Terminal from '$lib/components/Terminal.svelte';
  import ProposedTicket from './ProposedTicket.svelte';

  const tab = useTab();
  const ns = getActiveProject();

  // --- Layout: resizable split + narrow (mobile) single-column toggle ---------
  /** @type {HTMLElement|undefined} */
  let container = $state();
  let containerW = $state(0);
  let leftPct = $state(44);
  try { const s = parseInt(localStorage.getItem('planner.split') || '', 10); if (s >= 20 && s <= 80) leftPct = s; } catch {}
  let narrow = $derived(containerW > 0 && containerW < 620);
  let mobileTab = $state('chat'); // which pane shows when narrow
  let dragging = $state(false);
  $effect(() => {
    if (!container) return;
    const ro = new ResizeObserver((entries) => { containerW = entries[0].contentRect.width; });
    ro.observe(container);
    return () => ro.disconnect();
  });
  /** @param {PointerEvent} e */
  function startDrag(e) { dragging = true; /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture?.(e.pointerId); e.preventDefault(); }
  /** @param {PointerEvent} e */
  function onDrag(e) {
    if (!dragging || !container) return;
    const r = container.getBoundingClientRect();
    leftPct = Math.min(80, Math.max(20, (e.clientX - r.left) / r.width * 100));
  }
  function endDrag() { if (!dragging) return; dragging = false; try { localStorage.setItem('planner.split', String(Math.round(leftPct))); } catch {} }

  /** @type {any} */
  let planner = $state(null);
  let plannerId = $state(tab.params().plannerId || '');
  let booting = $state(false);

  let autonomous = $state(false);
  /** @type {any} */
  let review = $state(null);
  let verifying = $state(false), creating = $state(false), refining = $state(false), blocked = $state(false);
  let status = $state('');
  let lastProposedSig = $state('');
  let planUpdated = $state(false);

  // Verifying is server-side state (planner.verifying), so it survives tab
  // switches / remounts; `verifying` is just optimistic local feedback until the
  // first poll confirms it. A ticking clock drives the elapsed timer + dots.
  let now = $state(Date.now());
  let isVerifying = $derived(verifying || !!planner?.verifying);
  let isBuilding = $derived(!!planner?.building);
  let buildStatus = $derived(planner?.buildStatus || '');
  let buildRound = $derived(planner?.buildRound || 0);
  let verifyStartedAt = $derived(planner?.verifyStartedAt || 0);
  let elapsed = $derived(isVerifying && verifyStartedAt ? Math.max(0, Math.round((now - verifyStartedAt) / 1000)) : 0);
  let elapsedStr = $derived(elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
  let dots = $derived('.'.repeat((Math.floor(now / 450) % 3) + 1));
  $effect(() => {
    if (!isVerifying) return;
    const iv = setInterval(() => { now = Date.now(); }, 450);
    return () => clearInterval(iv);
  });

  /** @type {Record<string, {value:string,label:string}[]>} */
  let branchOptsByRepo = $state({});
  /** @type {Record<string, string>} */
  let baseByRepo = $state({});
  // Findings are selected by default; track only the ones unchecked (by issue text).
  let deselected = $state(new Set());
  /** @param {string} issue */
  const isSelected = (issue) => !deselected.has(issue);
  /** @param {string} issue */
  function toggle(issue) { const s = new Set(deselected); s.has(issue) ? s.delete(issue) : s.add(issue); deselected = s; }

  // Pre-flight: before spawning the planner, verify every repo is on a known-good
  // baseline (app repos synced to origin/dev, sdks on the latest npmjs version). A
  // clean baseline starts the planner straight away; warnings/blocks show a panel
  // so the operator can clear WIP (or knowingly proceed) first.
  /** @type {any} */
  let preflight = $state(null); // {ok,blocked,warned} once the check finishes
  /** @type {any[]} */
  let pfRows = $state([]); // per-repo rows: pending stubs that fill in as each completes
  let checking = $state(false);
  let pfStart = $state(0);
  let pfElapsed = $derived(checking && pfStart ? Math.max(0, Math.round((now - pfStart) / 1000)) : 0);
  let pfDone = $derived(pfRows.filter((r) => r.status && r.status !== 'pending').length);
  $effect(() => {
    if (!checking) return;
    const iv = setInterval(() => { now = Date.now(); }, 450);
    return () => clearInterval(iv);
  });

  async function runPreflight() {
    if (plannerId || checking) return;
    checking = true; preflight = null; pfRows = []; pfStart = Date.now(); now = Date.now(); status = '';
    try {
      await api.plannerPreflightStream(ns, (e) => {
        if (e.type === 'start') pfRows = e.repos.map((/** @type {any} */ r) => ({ ...r, status: 'pending', messages: [] }));
        else if (e.type === 'result') pfRows = pfRows.map((r) => (r.path === e.result.path ? e.result : r));
        else if (e.type === 'done') preflight = { ok: e.ok, blocked: e.blocked, warned: e.warned };
      });
    } catch (e) {
      // A buffering proxy (or older server) can break streaming — fall back to the
      // one-shot endpoint so the check still completes.
      try {
        const r = await api.plannerPreflight(ns);
        preflight = { ok: r.ok, blocked: r.blocked, warned: r.warned }; pfRows = r.repos || [];
      } catch (e2) { status = String(e2); checking = false; return; }
    }
    checking = false;
    if (preflight && preflight.ok && !preflight.warned) await ensurePlanner(); // clean → just go
  }

  /** @param {boolean} [override] */
  async function ensurePlanner(override = false) {
    if (plannerId || booting) return;
    booting = true;
    try {
      const p = await api.plannerCreate({ project: ns, goal: tab.params().goal || '', override });
      if (p?.error === 'preflight') { preflight = { ok: p.preflight.ok, blocked: p.preflight.blocked, warned: p.preflight.warned }; pfRows = p.preflight.repos || []; status = 'baseline not ready — see below'; }
      else if (p?.error) { status = String(p.error); }
      else if (p?.id) { plannerId = p.id; tab.update({ params: { plannerId: p.id } }); }
    } catch (e) { status = String(e); }
    booting = false;
  }
  async function load() {
    if (!plannerId) return;
    try {
      const p = await api.plannerGet(plannerId);
      if (p && p.error) return;
      // Detect a fresh proposal after a Refine round — hash full content, not
      // just titles, so a revision that keeps titles but changes goal/steps/criteria
      // is still detected.
      const sig = JSON.stringify((p?.proposed || []).map((/** @type {any} */ t) => [t.title, t.goal, t.criteria, t.steps]));
      if (lastProposedSig && sig !== lastProposedSig && p?.proposed?.length) { planUpdated = true; review = null; }
      lastProposedSig = sig;
      planner = p;
      if (p?.title) tab.update({ title: '🧠 ' + p.title });
    } catch {}
  }
  // Kick off the baseline check once when there's no planner yet. untrack so the
  // effect depends ONLY on plannerId — without it, runPreflight's guard reads
  // `checking`, the effect subscribes to it, and the check restarts in a loop
  // every time `checking` flips back to false.
  $effect(() => { if (!plannerId) untrack(() => runPreflight()); });
  $effect(() => {
    if (!plannerId) return;
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  });

  let proposed = $derived(planner?.proposed || []);
  let proposedRepos = $derived([...new Set(proposed.map((/** @type {any} */ t) => t.repo).filter(Boolean))]);
  $effect(() => {
    for (const repo of proposedRepos) {
      if (branchOptsByRepo[repo]) continue;
      branchOptsByRepo[repo] = [];
      api.gitBranches(repo).then((/** @type {any} */ r) => {
        branchOptsByRepo = { ...branchOptsByRepo, [repo]: (r?.branches || []).map((/** @type {string} */ b) => ({ value: b, label: b })) };
        baseByRepo = { ...baseByRepo, [repo]: baseByRepo[repo] || r?.default || r?.current || '' };
      }).catch(() => {});
    }
  });

  // Hide the prior verdict entirely while a verify is in flight, so a stale
  // "timed out / medium" result can't linger next to the running indicator.
  let shownReview = $derived(isVerifying ? null : (review || planner?.review));
  let findingsByTicket = $derived(groupFindings(shownReview?.findings));
  /** @param {any[]} fs @returns {Record<string, any[]>} */
  function groupFindings(fs) {
    /** @type {Record<string, any[]>} */
    const m = {};
    for (const f of (fs || [])) {
      const k = String(f.ticket || 0);
      (m[k] ||= []).push(f);
    }
    return m;
  }
  let planLevel = $derived(findingsByTicket['0'] || []);
  let selectedCount = $derived((shownReview?.findings || []).filter((/** @type {any} */ f) => isSelected(f.issue)).length);
  /** @param {string} sev */
  const sevColor = (sev) => sev === 'high' ? 'text-red-400' : sev === 'medium' ? 'text-amber-400' : 'text-muted';

  const ticketPayload = () => proposed.map((/** @type {any} */ t) => ({ ...t, autonomous, baseBranch: baseByRepo[t.repo] || '' }));

  // Per-ticket verify status (server-computed by content signature) drives each
  // card's badge and persists across reloads / refine rounds.
  let verifyStatus = $derived(planner?.verifyStatus || []);

  // Editable plan name (defaults to the planner-generated title). Saved debounced;
  // not clobbered by the 3s poll while the operator is typing.
  let planName = $state('');
  let planDirty = $state(false);
  /** @type {any} */
  let planSaveT;
  $effect(() => { if (planner?.planName != null && !planDirty) planName = planner.planName; });
  /** @param {string} v */
  function onPlanInput(v) { planName = v; planDirty = true; clearTimeout(planSaveT); planSaveT = setTimeout(savePlan, 600); }
  async function savePlan() { if (!plannerId) return; try { await api.plannerSetPlan(plannerId, planName.trim()); planDirty = false; } catch {} }

  async function verify() {
    verifying = true; planUpdated = false; status = ''; review = null; // clear the prior verdict immediately
    now = Date.now();
    try {
      // Pull the freshest proposal first: the planner may have just re-proposed
      // (the 3s poll can lag a click), and verifying a stale array re-flags issues
      // the latest revision already fixed.
      await load();
      const r = await api.plannerVerify(plannerId, ticketPayload());
      if (!r?.verifying) { review = r; status = r?.summary || ''; deselected = new Set(); } // not the "already running" early-return
    } catch (e) { status = String(e); }
    verifying = false;
    load();
  }
  async function refine() {
    const sel = (shownReview?.findings || []).filter((/** @type {any} */ f) => isSelected(f.issue));
    if (!sel.length) { status = 'check at least one finding'; return; }
    refining = true; status = `sending ${sel.length} finding(s) to the planner…`;
    try { await api.plannerRefine(plannerId, sel); status = 'sent — the planner is revising in the chat; it will re-propose, then re-Verify'; }
    catch (e) { status = String(e); }
    refining = false;
  }

  async function build() {
    try {
      status = 'starting build & validate…';
      await api.plannerBuild(plannerId);
      planUpdated = false; review = null;
    } catch (e) { status = String(e); }
  }
  /** @param {boolean} [override] */
  async function createAll(override = false) {
    creating = true; status = override ? 'overriding…' : 'verifying + creating…';
    try {
      const r = await api.plannerCreateAll(plannerId, ticketPayload(), override);
      if (r.blocked) { review = r.review; blocked = true; status = 'blocked — review the findings, fix via Refine, or Override'; }
      else { review = null; blocked = false; status = `created ${r.created?.length || 0} tickets — see the board`; }
    } catch (e) { status = String(e); }
    creating = false; load();
  }
  async function endSession() { if (plannerId) { try { await api.plannerStop(plannerId); } catch {} } }
</script>

<div class="flex flex-col h-full min-h-0" bind:this={container}>
  {#if narrow}
    <!-- Single column + toggle (iPhone) -->
    <div class="flex shrink-0 border-b border-line text-xs">
      <button class="flex-1 py-1.5 {mobileTab === 'chat' ? 'bg-elevated text-content font-semibold' : 'text-muted'}" onclick={() => (mobileTab = 'chat')}>🧠 Chat</button>
      <button class="flex-1 py-1.5 {mobileTab === 'plan' ? 'bg-elevated text-content font-semibold' : 'text-muted'}" onclick={() => (mobileTab = 'plan')}>📋 Plan{#if proposed.length} ({proposed.length}){/if}</button>
    </div>
    <div class="flex-1 min-h-0">
      {#if mobileTab === 'chat'}{@render chatPane()}{:else}{@render planPane()}{/if}
    </div>
  {:else}
    <!-- Resizable two-column (desktop / iPad) -->
    <div class="flex h-full min-h-0">
      <div class="flex flex-col min-w-0" style="width:{leftPct}%">{@render chatPane()}</div>
      <button class="w-1.5 shrink-0 cursor-col-resize bg-line/40 hover:bg-accent/60 touch-none {dragging ? 'bg-accent/60' : ''}"
        aria-label="Resize panes" onpointerdown={startDrag} onpointermove={onDrag} onpointerup={endDrag} onpointercancel={endDrag}></button>
      <div class="flex flex-col flex-1 min-w-0">{@render planPane()}</div>
    </div>
  {/if}
</div>

{#snippet baselinePane()}
  <div class="p-4 text-xs overflow-auto h-full">
    {#if booting}
      <div class="text-muted">Starting planning session…</div>
    {:else if checking || pfRows.length}
      <!-- Header: live while checking, verdict once done -->
      <div class="font-semibold mb-1 flex items-center gap-2">
        {#if checking}
          <span class="inline-block w-2 h-2 rounded-full bg-accent animate-pulse"></span>
          <span>Checking repo baseline{dots}</span>
          <span class="text-muted font-normal ml-auto tabular-nums">{pfDone}/{pfRows.length || '…'} · {pfElapsed}s</span>
        {:else if preflight?.blocked}🚫 Baseline not ready
        {:else if preflight?.warned}⚠️ Baseline warnings
        {:else}✅ Baseline clean{/if}
      </div>
      <p class="text-muted mb-3 leading-relaxed">Each repo is fetched and compared to <b>origin/&lt;base&gt;</b> (agents fork from there). Anything uncommitted or unpushed isn't in the plan — it's safe, just not part of the baseline.</p>
      <div class="space-y-2">
        {#each pfRows as r (r.path)}
          {@const pending = !r.status || r.status === 'pending'}
          <div class="rounded border {r.status === 'block' ? 'border-red-500/40' : r.status === 'warn' ? 'border-amber-500/40' : pending ? 'border-line/50' : 'border-line'} p-2">
            <div class="flex items-center gap-2 {pending ? 'opacity-60' : ''}">
              <span>{pending ? '⏳' : r.status === 'block' ? '🚫' : r.status === 'warn' ? '⚠️' : '✅'}</span>
              <span class="font-mono">{r.name}</span>
              {#if pending}
                <span class="text-muted">checking{dots}</span>
              {:else}
                <span class="text-muted">→ origin/{r.base} · {r.kind}</span>
                {#if r.npm}<span class="text-muted ml-auto tabular-nums">npm {r.npm.local ?? '?'} / {r.npm.latest ?? '?'}</span>{/if}
              {/if}
            </div>
            {#each (r.messages || []) as m}<div class="text-muted mt-1 pl-6">{m}</div>{/each}
          </div>
        {/each}
      </div>
      {#if !checking && preflight}
        <div class="flex gap-2 mt-3">
          <button class="border border-line rounded px-2 py-0.5 hover:bg-elevated" onclick={runPreflight}>Re-check</button>
          {#if preflight.blocked}
            <button class="border border-red-500/50 text-red-400 rounded px-2 py-0.5 hover:bg-red-500/10" onclick={() => ensurePlanner(true)}>Override &amp; start</button>
          {:else}
            <button class="bg-green-700 hover:bg-green-600 text-white rounded px-2 py-0.5" onclick={() => ensurePlanner(false)}>Start planning</button>
          {/if}
        </div>
      {/if}
      {#if status}<div class="text-muted mt-2">{status}</div>{/if}
    {:else}
      <div class="text-muted">Checking repo baseline{dots}</div>
    {/if}
  </div>
{/snippet}

{#snippet chatPane()}
  <div class="flex flex-col h-full min-h-0 border-r border-line">
    <div class="flex items-center gap-2 px-3 h-9 border-b border-line shrink-0">
      <span class="text-xs font-semibold">🧠 Plan with Claude</span>
      <button class="ml-auto text-[11px] text-red-400 hover:underline" title="End this planning session (kills the chat)" onclick={endSession}>End session</button>
    </div>
    <div class="flex-1 min-h-0">
      {#if plannerId}
        {#key plannerId}
          <Terminal sessionKey={`plan-${plannerId}`} wsId={ns} active={tab.isActive()} />
        {/key}
      {:else}
        {@render baselinePane()}
      {/if}
    </div>
  </div>
{/snippet}

{#snippet planPane()}
  <div class="flex flex-col h-full min-h-0">
    <div class="border-b border-line shrink-0 px-3 py-2 space-y-2">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-xs font-semibold shrink-0">📋 Proposed plan</span>
        {#if proposed.length}<span class="text-[11px] text-muted shrink-0">· {proposed.length} tickets</span>{/if}
        {#if proposed.length}
          <label class="ml-auto flex items-center gap-1.5 text-[11px] text-muted min-w-0" title="Plan name — auto-generated; edit it before (or after) Create">
            <span class="shrink-0">🧩</span>
            <input class="bg-canvas border border-line rounded px-1.5 py-0.5 text-[11px] text-content w-36 focus:w-56 transition-all focus:border-accent outline-none"
              value={planName} oninput={(e) => onPlanInput(e.currentTarget.value)} placeholder="plan name" />
          </label>
        {/if}
      </div>
      {#if proposed.length}
        <div class="flex flex-wrap items-center gap-1.5">
          <label class="text-[11px] text-muted flex items-center gap-1 cursor-pointer shrink-0" title="Run the whole chain hands-off (auto-approve plans, auto-accept on clean review)"><input type="checkbox" bind:checked={autonomous} /> 🤖</label>
          <button class="text-[11px] font-medium border rounded px-2 py-1 hover:bg-elevated disabled:opacity-40 min-w-[5rem] text-center shrink-0 {isVerifying ? 'border-accent text-accent' : 'border-line'}" disabled={!proposed.length || isVerifying || creating || isBuilding} onclick={verify}>🔎 {isVerifying ? `Verify${dots}` : 'Verify'}</button>
          <button class="text-[11px] font-medium border border-indigo-500/50 text-indigo-300 rounded px-2 py-1 hover:bg-indigo-500/10 disabled:opacity-40 shrink-0" disabled={!selectedCount || refining || isVerifying || isBuilding} onclick={refine} title="Send checked findings to the planner to revise">{refining ? '♻️…' : `♻️${selectedCount ? ` (${selectedCount})` : ' Refine'}`}</button>
          <button class="text-[11px] font-medium border border-emerald-500/50 text-emerald-300 rounded px-2 py-1 hover:bg-emerald-500/10 disabled:opacity-40 shrink-0" disabled={isBuilding || isVerifying || creating} onclick={build} title="Headless loop: verify → fix → verify until all tickets are clean">{isBuilding ? `🚀 Building ${buildRound}/4${dots}` : '🚀 Build & Validate'}</button>
          <button class="text-[11px] font-medium bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1 disabled:opacity-40 shrink-0 ml-auto" disabled={!proposed.length || creating || isVerifying || isBuilding} onclick={() => createAll(false)}>{creating ? 'Creating…' : 'Create'}</button>
        </div>
      {/if}
    </div>

    <div class="flex-1 min-h-0 overflow-auto p-3 space-y-2">
      {#if isBuilding}
        <div class="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 space-y-1">
          <div class="flex items-center gap-2">
            <span class="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
            <span class="text-[11px] font-medium text-emerald-300">🚀 Build & Validate running{dots}</span>
          </div>
          {#if buildStatus}<p class="text-[11px] text-muted pl-4">{buildStatus}</p>{/if}
          <p class="text-[11px] text-muted pl-4">Verifying and fixing tickets autonomously — ticket badges will update as each round completes.</p>
        </div>
      {:else if buildStatus}
        <div class="rounded-lg border {buildStatus.startsWith('✅') ? 'border-green-500/30 bg-green-500/5' : 'border-amber-500/30 bg-amber-500/5'} p-2">
          <p class="text-[11px] {buildStatus.startsWith('✅') ? 'text-green-400' : 'text-amber-300'}">{buildStatus}</p>
          {#if !buildStatus.startsWith('✅')}<p class="text-[11px] text-muted mt-1">Review the flagged tickets above, then describe the issue in the planner chat to get revised tickets, or manually edit via Verify → Refine.</p>{/if}
        </div>
      {/if}
      {#if isVerifying}
        <div class="rounded-lg border border-accent/40 bg-accent/5 p-2 flex items-center gap-2">
          <span class="inline-block w-2 h-2 rounded-full bg-accent animate-pulse"></span>
          <span class="text-[11px] text-content">🔎 Verifying plan against the repos{dots}</span>
          <span class="text-[11px] text-muted ml-auto tabular-nums">{elapsedStr} · Sonnet · up to ~8 min for big plans</span>
        </div>
      {/if}
      {#if status && !isVerifying && !isBuilding && !buildStatus}<div class="text-[11px] text-muted">{status}</div>{/if}
      {#if planUpdated}<div class="text-[11px] text-green-400">✅ plan updated by the planner — re-run 🔎 Verify</div>{/if}

      {#if !proposed.length}
        <div class="text-xs text-muted leading-relaxed">
          <p>Discuss the feature in the chat on the left. When you agree, the planner proposes tickets — they'll appear here as cards.</p>
          <p class="mt-2">Then <b>🔎 Verify</b> audits them against the real repos, findings show up on each card, you <b>♻️ Refine</b> the ones to fix, and <b>Create</b> the batch.</p>
        </div>
      {/if}

      {#if shownReview && !isVerifying}
        <div class="rounded-lg border {shownReview.severity === 'high' ? 'border-red-500/40' : 'border-line'} bg-canvas/40 p-2 space-y-1">
          <div class="flex items-center gap-2">
            <span class="text-[11px] uppercase tracking-wide {sevColor(shownReview.severity)}">plan review · {shownReview.severity}</span>
            {#if shownReview.findings?.length}<span class="text-[11px] text-muted">· {shownReview.findings.length} findings</span>{/if}
          </div>
          {#if shownReview.summary}<p class="text-[11px] text-muted">{shownReview.summary}</p>{/if}
          {#if planLevel.length}
            {#each planLevel as f (f.issue)}
              <label class="flex gap-2 text-[11px] cursor-pointer">
                <input type="checkbox" class="mt-0.5 shrink-0" checked={isSelected(f.issue)} onchange={() => toggle(f.issue)} />
                <span><span class={sevColor(f.severity)}>● {f.severity}</span> (plan) {f.issue}{#if f.fix}<span class="block text-muted">↳ {f.fix}</span>{/if}</span>
              </label>
            {/each}
          {/if}
          {#if blocked}
            <div class="flex items-center gap-2 pt-1">
              <span class="text-[11px] text-red-400">{shownReview?.failed ? 'Verification didn’t complete.' : 'High-severity issues.'}</span>
              <button class="text-[11px] border border-red-500/50 text-red-400 rounded px-2 py-0.5 hover:bg-red-500/10 disabled:opacity-40 whitespace-nowrap" disabled={creating} onclick={() => createAll(true)}>Override &amp; create</button>
            </div>
          {/if}
        </div>
      {/if}

      {#each proposed as t, i (i)}
        <ProposedTicket
          {t} n={i + 1}
          findings={findingsByTicket[String(i + 1)] || []}
          vstatus={verifyStatus[i]?.status || 'unverified'}
          branchOpts={branchOptsByRepo[t.repo] || []}
          base={baseByRepo[t.repo] || ''}
          onBase={(/** @type {string} */ v) => (baseByRepo = { ...baseByRepo, [t.repo]: v })}
          {isSelected} {toggle} />
      {/each}
    </div>
  </div>
{/snippet}
