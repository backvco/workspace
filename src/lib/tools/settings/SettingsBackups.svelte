<script>
  // Database backups: create / download / delete pg_dump snapshots, schedule
  // automatic ones (off / hourly / daily / weekly) with retention, and a guarded
  // restore that overwrites the live DB (type the filename to confirm).
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { flash } from './store.svelte.js';

  /** @type {{name:string,size:number,mtime:number}[]} */
  let backups = $state([]);
  let settings = $state({ schedule: 'off', retention: 7 });
  let available = $state(true);
  let dir = $state('');
  let loading = $state(true);
  let busy = $state(false);
  let restoring = $state(''); // name being restored
  let confirmText = $state('');

  const SCHEDULES = ['off', 'hourly', 'daily', 'weekly'];

  function fmtBytes(/** @type {number} */ n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  const fmtDate = (/** @type {number} */ ms) => new Date(ms).toLocaleString();

  async function load() {
    loading = true;
    try { const r = await api.backups(); backups = r.backups; settings = r.settings; available = r.available; dir = r.dir; }
    catch (e) { flash(String(/** @type {any} */ (e)?.message || e), true); }
    loading = false;
  }
  onMount(load);

  async function backupNow() {
    busy = true;
    const r = await api.backupCreate();
    busy = false;
    if (r.error) return flash(r.error, true);
    flash(`Backup created: ${r.backup.name} (${fmtBytes(r.backup.size)}).`);
    load();
  }
  async function del(/** @type {string} */ name) {
    if (!confirm(`Delete backup ${name}?`)) return;
    busy = true; await api.backupDelete(name); busy = false;
    load();
  }
  async function saveSchedule() {
    busy = true;
    const r = await api.backupConfig({ schedule: settings.schedule, retention: Number(settings.retention) });
    busy = false;
    if (r.error) return flash(r.error, true);
    settings = r;
    flash(settings.schedule === 'off' ? 'Automatic backups disabled.' : `Automatic backups: ${settings.schedule}, keep ${settings.retention}.`);
  }
  async function doRestore() {
    if (confirmText !== restoring) return;
    busy = true;
    const r = await api.backupRestore(restoring);
    busy = false;
    if (r.error) { flash(r.error, true); return; }
    flash(`Restored from ${restoring}. Reload the app to see the restored data.`);
    restoring = ''; confirmText = '';
  }
</script>

<section class="rounded-lg border border-line bg-card p-4 h-full flex flex-col min-h-0">
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <div>
      <div class="font-medium">Database backups</div>
      <div class="text-xs text-muted mt-0.5">Compressed <code>pg_dump</code> snapshots of the whole database. Stored in <code class="text-content">{dir || 'data/backups'}</code>.</div>
    </div>
    <button class="border border-line rounded px-3 py-1.5 text-sm text-content hover:bg-elevated disabled:opacity-40"
      disabled={busy || !available} onclick={backupNow}>Back up now</button>
  </div>

  {#if !available}
    <div class="mt-3 rounded border border-amber-600/40 bg-amber-600/10 text-amber-700 dark:text-amber-300 px-3 py-2 text-xs">
      No <code>pg_dump</code> found and no <code>workspace-db</code> Docker container. Install <code>postgresql-client</code> (or use the bundled Docker Postgres) to enable backups.
    </div>
  {/if}

  <!-- schedule -->
  <div class="mt-4 flex items-center gap-3 flex-wrap text-sm border-t border-line pt-4">
    <span class="text-muted">Automatic:</span>
    <select class="bg-elevated border border-line rounded px-2 py-1" bind:value={settings.schedule}>
      {#each SCHEDULES as sc}<option value={sc}>{sc}</option>{/each}
    </select>
    <span class="text-muted">keep last</span>
    <input type="number" min="1" max="365" class="w-16 bg-elevated border border-line rounded px-2 py-1" bind:value={settings.retention} />
    <button class="border border-line rounded px-3 py-1 text-muted hover:text-content disabled:opacity-40" disabled={busy} onclick={saveSchedule}>Save schedule</button>
  </div>

  <!-- list -->
  <div class="mt-4 flex-1 min-h-0 overflow-auto">
    {#if loading}
      <div class="text-sm text-muted">Loading…</div>
    {:else if !backups.length}
      <div class="text-sm text-muted">No backups yet. Click “Back up now”.</div>
    {:else}
      <table class="w-full text-sm">
        <thead><tr class="text-muted text-xs text-left border-b border-line">
          <th class="py-1.5 font-medium">Backup</th><th class="font-medium">Size</th><th class="font-medium">Created</th><th></th>
        </tr></thead>
        <tbody>
          {#each backups as b (b.name)}
            <tr class="border-b border-line/60">
              <td class="py-2 font-mono text-xs text-content">{b.name}</td>
              <td class="text-muted">{fmtBytes(b.size)}</td>
              <td class="text-muted">{fmtDate(b.mtime)}</td>
              <td class="text-right whitespace-nowrap">
                <a class="text-muted hover:text-content px-2" href={api.backupDownloadUrl(b.name)} download>Download</a>
                <button class="text-amber-600 hover:text-amber-500 px-2" disabled={busy} onclick={() => { restoring = b.name; confirmText = ''; }}>Restore</button>
                <button class="text-red-500 hover:text-red-400 px-2" disabled={busy} onclick={() => del(b.name)}>Delete</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <!-- guarded restore -->
  {#if restoring}
    <div class="mt-3 rounded border border-amber-600/50 bg-amber-600/10 px-3 py-3 text-sm">
      <div class="text-amber-700 dark:text-amber-300 font-medium">Restore overwrites the current database.</div>
      <div class="text-xs text-muted mt-1">Every change since this backup will be lost. Type <code class="text-content">{restoring}</code> to confirm.</div>
      <div class="flex items-center gap-2 mt-2">
        <input class="flex-1 bg-elevated border border-line rounded px-2 py-1 font-mono text-xs" placeholder={restoring} bind:value={confirmText} />
        <button class="border border-red-600/60 text-red-500 hover:bg-red-600/10 rounded px-3 py-1 disabled:opacity-40" disabled={busy || confirmText !== restoring} onclick={doRestore}>Restore</button>
        <button class="border border-line rounded px-3 py-1 text-muted hover:text-content" onclick={() => { restoring = ''; confirmText = ''; }}>Cancel</button>
      </div>
    </div>
  {/if}
</section>
