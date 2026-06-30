<script>
  // Idle agent-session reaper: GC settings (idle TTL + sweep interval, on/off)
  // and a live list of every agent/chat/plan-review session it tracks, with a
  // manual "sweep now" and per-session kill. Never lists the operator's manual
  // terminal tabs — only sessions the reaper itself owns (see agent-reaper.js).
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { flash } from './store.svelte.js';

  let settings = $state({ enabled: true, idleMs: 1800000, intervalMs: 300000 });
  /** @type {{name:string,kind:string,label:string,ns:string,idleSec:number,active:boolean}[]} */
  let sessions = $state([]);
  let loading = $state(true);
  let busy = $state(false);
  let killing = $state('');

  // Editable as minutes in the UI; stored/sent as ms.
  let idleMin = $state(30);
  let intervalMin = $state(5);

  function fmtIdle(/** @type {number} */ sec) {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
  }

  async function load() {
    loading = true;
    try {
      const r = await api.reaper();
      settings = r.settings;
      sessions = r.sessions;
      idleMin = Math.round(settings.idleMs / 60000);
      intervalMin = Math.round(settings.intervalMs / 60000);
    } catch (e) { flash(String(/** @type {any} */ (e)?.message || e), true); }
    loading = false;
  }
  onMount(load);

  async function save() {
    busy = true;
    const r = await api.reaperConfig({
      enabled: settings.enabled,
      idleMs: Math.max(1, idleMin) * 60000,
      intervalMs: Math.max(1, intervalMin) * 60000,
    });
    busy = false;
    if (r.error) return flash(r.error, true);
    settings = r.settings;
    flash(settings.enabled ? `Auto-cleanup: idle ${idleMin}m, checked every ${intervalMin}m.` : 'Auto-cleanup disabled.');
  }

  async function sweepNow() {
    busy = true;
    const r = await api.reaperSweep();
    busy = false;
    if (r.error) return flash(r.error, true);
    flash(r.reaped ? `Swept: closed ${r.reaped} idle session${r.reaped === 1 ? '' : 's'}.` : 'Swept: nothing idle enough to close.');
    load();
  }

  async function kill(/** @type {string} */ name) {
    killing = name;
    const r = await api.reaperKill(name);
    killing = '';
    if (r.error) return flash(r.error, true);
    sessions = sessions.filter((s) => s.name !== name);
    flash(`Closed ${name}.`);
  }
</script>

<section class="rounded-lg border border-line bg-card p-4 h-full flex flex-col min-h-0">
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <div>
      <div class="font-medium">Agent session cleanup</div>
      <div class="text-xs text-muted mt-0.5">
        Finished or stalled agent / chat / plan-review sessions hold a claude process + its MCP servers open
        indefinitely unless closed. This automatically closes ones sitting idle, and never touches your manual
        terminal tabs. A session actively streaming output is always skipped.
      </div>
    </div>
    <button class="border border-line rounded px-3 py-1.5 text-sm text-content hover:bg-elevated disabled:opacity-40"
      disabled={busy} onclick={sweepNow}>Sweep now</button>
  </div>

  <!-- settings -->
  <div class="mt-4 flex items-center gap-3 flex-wrap text-sm border-t border-line pt-4">
    <label class="flex items-center gap-2">
      <input type="checkbox" bind:checked={settings.enabled} />
      <span class="text-muted">Auto-cleanup</span>
    </label>
    <span class="text-muted">close sessions idle</span>
    <input type="number" min="1" max="1440" class="w-16 bg-elevated border border-line rounded px-2 py-1" bind:value={idleMin} disabled={!settings.enabled} />
    <span class="text-muted">min, checked every</span>
    <input type="number" min="1" max="60" class="w-16 bg-elevated border border-line rounded px-2 py-1" bind:value={intervalMin} disabled={!settings.enabled} />
    <span class="text-muted">min</span>
    <button class="border border-line rounded px-3 py-1 text-muted hover:text-content disabled:opacity-40" disabled={busy} onclick={save}>Save</button>
  </div>

  <!-- live sessions -->
  <div class="mt-4 flex-1 min-h-0 overflow-auto">
    {#if loading}
      <div class="text-sm text-muted">Loading…</div>
    {:else if !sessions.length}
      <div class="text-sm text-muted">No agent-owned sessions are currently open.</div>
    {:else}
      <table class="w-full text-sm">
        <thead><tr class="text-muted text-xs text-left border-b border-line">
          <th class="py-1.5 font-medium">Session</th><th class="font-medium">Kind</th><th class="font-medium">Idle</th><th></th>
        </tr></thead>
        <tbody>
          {#each sessions as sess (sess.name)}
            <tr class="border-b border-line/60">
              <td class="py-2 text-content">{sess.label}<div class="font-mono text-xs text-muted">{sess.name} · {sess.ns}</div></td>
              <td class="text-muted">{sess.kind}</td>
              <td class={sess.active ? 'text-green-600' : 'text-muted'}>{sess.active ? 'running' : fmtIdle(sess.idleSec)}</td>
              <td class="text-right whitespace-nowrap">
                <button class="text-red-500 hover:text-red-400 px-2 disabled:opacity-40" disabled={killing === sess.name} onclick={() => kill(sess.name)}>
                  {killing === sess.name ? 'Closing…' : 'Close'}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</section>
