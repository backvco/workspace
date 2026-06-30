<script>
  // Users master-detail: left column = accounts; selecting one loads its detail
  // (display name, email, set password, and that user's passkeys / devices).
  import { api } from '$lib/api.js';
  import Modal from '$lib/components/Modal.svelte';
  import { enrollPasskey, passkeysSupported, deviceLabel } from '$lib/passkeys.js';
  import { s, flash, reload } from './store.svelte.js';

  let selectedId = $state('');
  let showAdd = $state(false);
  let selected = $derived(s.users.find((u) => u.id === selectedId) || null);
  let isSelf = $derived(!!selected && selected.id === s.status?.user?.id);

  // Detail form fields (seeded when the selection changes).
  let nameInput = $state(''); let emailInput = $state(''); let newPass = $state('');
  /** @type {{id:string,name:string,addedAt:number}[]} */
  let creds = $state([]);
  let lastSeeded = '';

  // New-user form.
  let newUser = $state(''); let newUserPass = $state('');

  // Auto-select the signed-in user (or the first) once users load.
  $effect(() => {
    if (!selectedId && s.users.length) selectUser(s.status?.user?.id || s.users[0].id);
  });
  // Re-seed the form whenever a different user is selected.
  $effect(() => {
    if (selected && selected.id !== lastSeeded) {
      lastSeeded = selected.id;
      nameInput = selected.name || ''; emailInput = selected.email || ''; newPass = '';
    }
  });

  async function selectUser(/** @type {string} */ id) {
    selectedId = id; creds = [];
    try { creds = (await api.userPasskeys(id)).credentials; } catch {}
  }
  async function refreshCreds() { if (selectedId) { try { creds = (await api.userPasskeys(selectedId)).credentials; } catch {} } }

  async function saveProfile() {
    if (!selected) return;
    s.busy = true;
    const r = await api.authUpdateUser(selected.id, { name: nameInput.trim(), email: emailInput.trim() });
    s.busy = false;
    if (r.error) return flash(r.error, true);
    flash('Profile saved.'); reload();
  }
  async function setPassword() {
    if (!selected || newPass.length < 6) return;
    s.busy = true;
    const r = await api.authSetPassword(selected.id, newPass);
    s.busy = false;
    if (r.error) return flash(r.error, true);
    newPass = ''; flash(`Password updated for ${selected.username}.`);
  }
  async function addUser() {
    if (!newUser.trim() || newUserPass.length < 6) return;
    s.busy = true;
    const r = await api.authAddUser(newUser.trim(), newUserPass);
    s.busy = false;
    if (r.error) return flash(r.error, true);
    const id = r.id; newUser = ''; newUserPass = ''; showAdd = false;
    flash('User added.'); await reload(); if (id) selectUser(id);
  }
  async function removeUser() {
    if (!selected) return;
    if (!confirm(`Delete user "${selected.username}"?`)) return;
    const r = await api.authRemoveUser(selected.id);
    if (r.error) return flash(r.error, true);
    selectedId = ''; flash('User removed.'); reload();
  }

  // --- passkeys for the selected user ---
  async function addOwnDevice() {
    const name = (prompt('Name this passkey (e.g. which device it is):', deviceLabel()) || '').trim();
    if (!name) return;
    s.busy = true;
    let r = await enrollPasskey(name);
    if (r.code === 'enroll_blocked') {
      const code = (prompt('To add another device, enter a one-time enrollment code from an admin:') || '').trim();
      if (!code) { s.busy = false; return; }
      r = await enrollPasskey(name, code);
    }
    s.busy = false;
    if (r.error) return flash(r.error, true);
    flash('Passkey added.'); reload(); refreshCreds();
  }
  async function removeCred(/** @type {string} */ credId) {
    if (!selected || !confirm('Remove this passkey?')) return;
    const r = await api.userRemovePasskey(selected.id, credId);
    if (r.error) return flash(r.error, true);
    flash('Passkey removed.'); reload(); refreshCreds();
  }
  async function resetAll() {
    if (!selected || !confirm(`Remove ALL passkeys for "${selected.username}"? They'll sign in with their password until they enrol a new device.`)) return;
    const r = await api.passkeyResetUser(selected.id);
    if (r.error) return flash(r.error, true);
    flash(`Removed ${r.removed} passkey${r.removed === 1 ? '' : 's'}.`); reload(); refreshCreds();
  }
  async function genCode() {
    if (!selected) return;
    const r = await api.passkeyEnrollCode(selected.id);
    if (r.error) return flash(r.error, true);
    // Surface the code so the admin can relay it out-of-band; it's single-use.
    flash(`Enrollment code for ${selected.username}: ${r.code} (valid ${r.expiresInMin} min, one use)`);
  }
</script>

<div class="grid grid-cols-[14rem_1fr] gap-4 h-full min-h-0">
  <!-- master list -->
  <div class="rounded-lg border border-line bg-card p-2 overflow-auto">
    <button class="w-full mb-2 text-xs bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1.5"
      onclick={() => { newUser = ''; newUserPass = ''; showAdd = true; }}>+ New user</button>
    {#if s.users.length === 0}
      <div class="text-xs text-muted p-2">No users yet.</div>
    {:else}
      <ul>
        {#each s.users as u (u.id)}
          <li>
            <button class="w-full text-left rounded px-2 py-1.5 text-sm {u.id === selectedId ? 'bg-elevated text-content' : 'text-muted hover:text-content hover:bg-elevated/50'}"
              onclick={() => selectUser(u.id)}>
              <div class="flex items-center justify-between">
                <span class="truncate">{u.name || u.username}</span>
                {#if u.passkeyCount > 0}<span class="ml-2 shrink-0 text-[10px] text-muted">🔑 {u.passkeyCount}</span>{/if}
              </div>
              {#if u.name}<div class="text-[10px] text-muted truncate">{u.username}</div>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- detail -->
  <div class="rounded-lg border border-line bg-card p-4 overflow-auto">
    {#if !selected}
      <div class="text-sm text-muted">Select a user.</div>
    {:else}
      <div class="flex items-center justify-between">
        <div class="font-medium">{selected.username}{#if isSelf}<span class="ml-2 text-xs text-muted">(you)</span>{/if}</div>
        <button class="text-xs text-red-500 hover:text-red-400" onclick={removeUser}>Delete user</button>
      </div>

      <!-- profile -->
      <div class="mt-3 grid grid-cols-[6rem_1fr] items-center gap-2 text-sm">
        <span class="text-xs text-muted">Display name</span>
        <input class="bg-elevated border border-line rounded px-2 py-1" bind:value={nameInput} placeholder="(optional)" />
        <span class="text-xs text-muted">Email</span>
        <input class="bg-elevated border border-line rounded px-2 py-1" bind:value={emailInput} placeholder="(optional)" type="email" autocomplete="off" />
      </div>
      <button class="mt-2 text-xs bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1 disabled:opacity-40"
        disabled={s.busy} onclick={saveProfile}>Save profile</button>

      <!-- password -->
      <div class="mt-4 border-t border-line pt-3">
        <div class="text-xs text-muted mb-1">Set password</div>
        <div class="flex gap-2">
          <input class="flex-1 bg-elevated border border-line rounded px-2 py-1 text-sm" type="password" placeholder="new password (min 6)" bind:value={newPass} autocomplete="new-password" />
          <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-3 disabled:opacity-40"
            disabled={s.busy || newPass.length < 6} onclick={setPassword}>Set</button>
        </div>
      </div>

      <!-- passkeys -->
      <div class="mt-4 border-t border-line pt-3">
        <div class="text-xs text-muted mb-1">Passkeys / devices</div>
        {#if creds.length === 0}
          <div class="text-xs text-muted mb-2">No passkeys enrolled.</div>
        {:else}
          <ul class="mb-2 divide-y divide-line">
            {#each creds as c (c.id)}
              <li class="flex items-center justify-between py-1.5 text-xs">
                <span>{c.name} <span class="text-muted">· added {new Date(c.addedAt).toLocaleDateString()}</span></span>
                <button class="text-red-500 hover:text-red-400" onclick={() => removeCred(c.id)}>Remove</button>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="flex flex-wrap gap-2">
          {#if isSelf && passkeysSupported()}
            <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1 disabled:opacity-40" disabled={s.busy} onclick={addOwnDevice}>Add this device</button>
          {/if}
          {#if creds.length > 0}
            <button class="text-xs border border-line rounded px-3 py-1 text-amber-600 dark:text-amber-400 hover:bg-elevated" onclick={resetAll}>Reset all passkeys</button>
          {/if}
          <button class="text-xs border border-line rounded px-3 py-1 text-muted hover:text-content hover:bg-elevated" onclick={genCode}>Generate enrollment code</button>
        </div>
        {#if !isSelf}
          <div class="mt-2 text-[11px] text-muted">A user adds their own devices on the device itself. Give them a one-time enrollment code if they've lost access to all their passkeys.</div>
        {/if}
      </div>
    {/if}
  </div>
</div>

{#if showAdd}
  <Modal title="New user" onClose={() => (showAdd = false)} max="max-w-sm">
    <form class="space-y-2" onsubmit={(e) => { e.preventDefault(); addUser(); }}>
      <input class="w-full bg-elevated border border-line rounded px-2 py-1.5 text-sm" placeholder="username" bind:value={newUser} autocomplete="off" />
      <!-- svelte-ignore a11y_autofocus -->
      <input class="w-full bg-elevated border border-line rounded px-2 py-1.5 text-sm" placeholder="password (min 6)" type="password" bind:value={newUserPass} autocomplete="new-password" />
      <div class="flex justify-end gap-2 pt-1">
        <button type="button" class="text-xs border border-line rounded px-3 py-1.5 text-muted hover:text-content" onclick={() => (showAdd = false)}>Cancel</button>
        <button type="submit" class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1.5 disabled:opacity-40"
          disabled={s.busy || !newUser.trim() || newUserPass.length < 6}>Add user</button>
      </div>
    </form>
  </Modal>
{/if}
