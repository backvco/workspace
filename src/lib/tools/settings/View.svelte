<script>
  // Settings shell: sub-tabs (General / Authentication / Users) over a shared store.
  import { onMount } from 'svelte';
  import { s, reload } from './store.svelte.js';
  import SettingsGeneral from './SettingsGeneral.svelte';
  import SettingsAuth from './SettingsAuth.svelte';
  import SettingsUsers from './SettingsUsers.svelte';
  import SettingsClipboard from './SettingsClipboard.svelte';
  import SettingsBackups from './SettingsBackups.svelte';

  const TABS = [
    { id: 'general', label: 'General' },
    { id: 'auth', label: 'Authentication' },
    { id: 'users', label: 'Users' },
    { id: 'clipboard', label: 'Clipboard' },
    { id: 'backups', label: 'Backups' },
  ];
  let active = $state('general');
  onMount(reload);
</script>

<div class="h-full flex flex-col p-5 text-sm">
  <h1 class="text-lg font-semibold mb-3">Settings</h1>

  <div class="flex gap-1 border-b border-line mb-4">
    {#each TABS as t (t.id)}
      <button class="px-3 py-1.5 text-sm -mb-px border-b-2 {active === t.id ? 'border-green-600 text-content font-medium' : 'border-transparent text-muted hover:text-content'}"
        onclick={() => (active = t.id)}>{t.label}</button>
    {/each}
  </div>

  {#if s.msg}<div class="mb-3 rounded border border-green-600/40 bg-green-600/10 text-green-700 dark:text-green-300 px-3 py-2">{s.msg}</div>{/if}
  {#if s.err}<div class="mb-3 rounded border border-red-600/40 bg-red-600/10 text-red-700 dark:text-red-300 px-3 py-2">{s.err}</div>{/if}

  <div class="flex-1 min-h-0 {active === 'users' || active === 'clipboard' || active === 'backups' ? '' : 'max-w-2xl'}">
    {#if active === 'general'}
      <SettingsGeneral />
    {:else if active === 'auth'}
      <SettingsAuth />
    {:else if active === 'users'}
      <SettingsUsers />
    {:else if active === 'clipboard'}
      <SettingsClipboard />
    {:else if active === 'backups'}
      <SettingsBackups />
    {/if}
  </div>
</div>
