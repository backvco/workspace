<script>
  import '../app.css';
  import '$lib/tabs/tools.js'; // registers tools
  import { onMount } from 'svelte';

  // The whole UI lives in this layout; route pages are intentionally empty. Still
  // accept + render `children` so SvelteKit's root-layout contract is satisfied
  // (and any future page content renders) instead of warning that it's dropped.
  let { children } = $props();
  import TabGroups from '$lib/components/tabs/TabGroups.svelte';
  import { tabStore, closeTab, openTool } from '$lib/tabs/store.svelte.js';
  import { api } from '$lib/api.js';
  import StatsPanel from '$lib/components/StatsPanel.svelte';
  import HelpModal from '$lib/components/HelpModal.svelte';
  import LoginGate from '$lib/components/LoginGate.svelte';
  import ProjectRail from '$lib/components/ProjectRail.svelte';
  import Overview from '$lib/components/Overview.svelte';
  import { projectStore, initProjects } from '$lib/projects.svelte.js';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import { initTheme } from '$lib/theme.svelte.js';

  /** @type {{cpu:number, cores:number[], mem:{percent:number, usedGb:number, availGb:number, cachedGb:number, totalGb:number}} | null} */
  let stats = $state(null);
  let statsOpen = $state(false);
  let helpOpen = $state(false);

  /**
   * @typedef {{authEnabled:boolean, authed:boolean, needsBootstrap:boolean, loginPolicy?:string, user:{username:string}|null}} AuthState
   */

  // Auth gate: null until the status check resolves. When auth is enabled and the
  // visitor isn't signed in, the app is replaced by the login screen.
  let auth = $state(/** @type {AuthState|null} */ (null));
  let gated = $derived(Boolean(auth && auth.authEnabled && !auth.authed));

  async function logout() { try { await api.authLogout(); } catch {} location.reload(); }

  let railOpen = $state(true);
  function toggleRail() { railOpen = !railOpen; try { localStorage.setItem('railOpen', railOpen ? '1' : '0'); } catch (err) { console.warn('Failed to persist railOpen preference to localStorage', err); } }

  let isPwa = $state(false);
  // Intercept Cmd+W in PWA mode: close the active tab instead of the app window.
  function onKeydown(/** @type {KeyboardEvent} */ e) {
    if (!isPwa || !e.metaKey || e.key !== 'w') return;
    const g = tabStore.groups.find((x) => x.id === tabStore.activeGroupId) || tabStore.groups[0];
    const tabId = g?.activeId;
    if (!tabId) return;
    e.preventDefault();
    closeTab(tabId);
  }

  onMount(() => {
    // On narrow screens (phones) default the rail to closed so the terminal
    // gets the full width — otherwise the rail + terminal together are too narrow
    // for the agent CLI to wrap output correctly (~23 cols with rail vs ~50 without).
    const narrow = window.innerWidth < 640;
    try {
      const saved = localStorage.getItem('railOpen');
      railOpen = saved !== null ? saved !== '0' : !narrow;
    } catch { railOpen = !narrow; }
    isPwa = window.matchMedia('(display-mode: standalone)').matches || !!(/** @type {Navigator & { standalone?: boolean }} */ (navigator).standalone);
    initTheme();
    // Check auth before loading project data (API calls 401 while gated).
    api.authStatus()
      .then((a) => { auth = a; if (!(a.authEnabled && !a.authed)) initProjects(); })
      .catch(() => { auth = { authEnabled: false, authed: true, needsBootstrap: false, user: null }; initProjects(); });
    const tick = async () => { if (document.hidden) return; try { stats = await api.stats(); } catch (err) { console.warn('Failed to fetch stats', err); } };
    tick();
    const id = setInterval(tick, 5000);

    // iOS PWA keyboard fix: 100dvh doesn't shrink when the soft keyboard appears.
    // visualViewport.height correctly reflects the space above the keyboard.
    // Set --vvh so the root div tracks the real available height.
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let vpTimer;
    const vv = window.visualViewport;
    if (vv) {
      function applyVV() {
        document.documentElement.style.setProperty('--vvh', /** @type {VisualViewport} */ (vv).height + 'px');
        // Refit terminals after the keyboard animation settles.
        clearTimeout(vpTimer);
        vpTimer = setTimeout(() => window.dispatchEvent(new CustomEvent('workspace:refit')), 200);
      }
      vv.addEventListener('resize', applyVV);
      applyVV();
      return () => { clearInterval(id); vv.removeEventListener('resize', applyVV); clearTimeout(vpTimer); };
    }

    return () => clearInterval(id);
  });

  /** @param {number} p */
  const col = (p) => (p >= 90 ? 'text-red-600 dark:text-red-400' : p >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-content');
</script>

<svelte:window onclick={() => { statsOpen = false; }} onkeydown={onKeydown} />

{#if gated}
  <LoginGate needsBootstrap={auth?.needsBootstrap} loginPolicy={auth?.loginPolicy} />
{:else}
<div class="flex h-full" style="padding-top: env(safe-area-inset-top)">
  {#if railOpen}<ProjectRail user={auth?.authed ? auth.user : null} onLogout={logout} onSettings={() => openTool({ toolId: 'settings', title: 'Settings', singleton: true })} />{/if}
  <div class="flex flex-col flex-1 min-w-0">
  <header class="flex items-center h-9 px-3 bg-card border-b border-line text-sm">
    <button class="text-muted hover:text-content mr-2 text-base leading-none" title={railOpen ? 'Hide projects' : 'Show projects'} onclick={toggleRail}>☰</button>
    <span class="font-semibold tracking-tight">Workspace</span>
    <span class="ml-2 text-xs {projectStore.active || projectStore.activeId === 'overview' ? 'text-accent' : 'text-muted'}">{projectStore.activeId === 'overview' ? 'Overview' : projectStore.active ? projectStore.active.label : 'General'}</span>
    <div class="ml-auto flex items-center gap-3 sm:gap-4">
      <!-- force all mounted terminals to re-fit their tmux size -->
      <button class="text-muted hover:text-content leading-none"
        title="Resize terminals (fix tmux size)"
        aria-label="Resize terminals"
        onclick={() => window.dispatchEvent(new CustomEvent('workspace:refit'))}>
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 3 21 3 21 9"></polyline>
          <polyline points="9 21 3 21 3 15"></polyline>
          <line x1="21" y1="3" x2="14" y2="10"></line>
          <line x1="3" y1="21" x2="10" y2="14"></line>
        </svg>
      </button>

      <!-- cpu / mem -->
      {#if stats}
        <div class="relative">
          <button
            class="flex items-center gap-2 sm:gap-4 text-xs text-muted font-mono hover:text-content whitespace-nowrap"
            title="Per-core CPU + memory"
            onclick={(e) => { e.stopPropagation(); statsOpen = !statsOpen; }}
          >
            <span><span class="opacity-60">CPU</span> <span class={col(stats.cpu)}>{stats.cpu}%</span></span>
            <span><span class="opacity-60">MEM</span> <span class={col(stats.mem.percent)}>{stats.mem.percent}%</span><span class="hidden sm:inline opacity-50"> {stats.mem.usedGb}/{stats.mem.totalGb}G</span></span>
          </button>
          {#if statsOpen}
            <div class="absolute z-40 top-full right-0 mt-1 bg-elevated border border-line rounded-lg shadow-lg"
              onclick={(e) => e.stopPropagation()} role="presentation">
              <StatsPanel {stats} />
            </div>
          {/if}
        </div>
      {/if}

      <!-- help / tips -->
      <button
        class="grid place-items-center w-5 h-5 rounded-full border border-line text-muted hover:text-content hover:border-content text-xs leading-none"
        title="Tips & help"
        aria-label="Tips & help"
        onclick={(e) => { e.stopPropagation(); helpOpen = true; }}>?</button>

      <ThemeToggle />
    </div>
  </header>

  {#if helpOpen}<HelpModal onClose={() => (helpOpen = false)} />{/if}

  {#if projectStore.activeId === 'overview'}
    <main class="flex-1 min-h-0"><Overview /></main>
  {:else if tabStore.loaded}
    <main class="flex-1 min-h-0">
      <TabGroups />
    </main>
  {:else}
    <div class="flex-1 grid place-items-center text-muted text-sm">Loading workspace…</div>
  {/if}
  </div>
</div>
{/if}

<!-- Route pages are empty (the UI is this layout); render children to satisfy the
     root-layout contract and silence the missing-slot warning. -->
{@render children?.()}

