<script>
  // Settings: manage optional authentication (users + the auth on/off toggle) and
  // view the server's resolved configuration (roots, data dir, agent CLI). The
  // session-signing key lives in the server's .env, never here.
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { enrollPasskey, passkeysSupported, deviceLabel } from '$lib/passkeys.js';

  let status = $state(/** @type {{authEnabled:boolean, authed:boolean, user:{id:string,username:string}|null, needsBootstrap:boolean, hasSessionKey:boolean, loginPolicy:string}|null} */ (null));
  /** @type {{id:string,name:string,addedAt:number}[]} */
  let passkeys = $state([]);
  let config = $state(/** @type {{projectRoots:string[], termCwd:string, dataDir:string, agentBin:string, hasSessionKey:boolean}|null} */ (null));
  /** @type {{id:string,username:string,createdAt:number,passkeyCount:number}[]} */
  let users = $state([]);

  let newUser = $state(''); let newPass = $state('');
  // Auth can only be enabled once a session key exists AND at least one account
  // exists — otherwise enabling would lock everyone out.
  let canEnable = $derived(!!config?.hasSessionKey && users.length > 0);
  let busy = $state(false);
  let msg = $state(''); let err = $state('');

  function flash(/** @type {string} */ m, isErr = false) { if (isErr) { err = m; msg = ''; } else { msg = m; err = ''; } }

  async function refresh() {
    try { status = await api.authStatus(); } catch {}
    try { config = await api.serverConfig(); } catch {}
    try { users = (await api.authUsers()).users; } catch {}
    if (status?.authed) { try { passkeys = (await api.passkeyCredentials()).credentials; } catch {} }
  }
  onMount(refresh);

  const POLICY_LABELS = {
    password: 'Password only',
    either: 'Password or passkey',
    passkey: 'Passkey only (passwordless)',
    both: 'Password + passkey (2FA)',
  };
  async function setPolicy(/** @type {string} */ policy) {
    busy = true;
    const r = await api.passkeySetPolicy(policy);
    busy = false;
    if (r.error) return flash(r.error, true);
    flash(`Login policy: ${POLICY_LABELS[/** @type {keyof typeof POLICY_LABELS} */ (policy)]}.`);
    refresh();
  }
  async function addPasskey() {
    // Prefill a detected label (Mac / Windows / iPhone…); the user can rename it.
    const name = (prompt('Name this passkey (e.g. which device it is):', deviceLabel()) || '').trim();
    if (name === '') return; // cancelled
    busy = true;
    const r = await enrollPasskey(name);
    busy = false;
    if (r.error) return flash(r.error, true);
    flash('Passkey added — you can now sign in with Face ID / Touch ID / Windows Hello.');
    refresh();
  }
  async function removePasskey(/** @type {string} */ id) {
    if (!confirm('Remove this passkey?')) return;
    const r = await api.passkeyRemove(id);
    if (r.error) return flash(r.error, true);
    flash('Passkey removed.');
    refresh();
  }

  async function addUser() {
    if (!newUser.trim() || !newPass) return;
    busy = true;
    const r = await api.authAddUser(newUser.trim(), newPass);
    busy = false;
    if (r.error) return flash(r.error, true);
    newUser = ''; newPass = '';
    flash('User added.');
    refresh();
  }
  async function removeUser(/** @type {string} */ id, /** @type {string} */ name) {
    if (!confirm(`Delete user "${name}"?`)) return;
    const r = await api.authRemoveUser(id);
    if (r.error) return flash(r.error, true);
    flash('User removed.');
    refresh();
  }
  async function resetUserPasskeys(/** @type {string} */ id, /** @type {string} */ name) {
    if (!confirm(`Remove all passkeys for "${name}"? They'll sign in with their password until they enroll a new device.`)) return;
    const r = await api.passkeyResetUser(id);
    if (r.error) return flash(r.error, true);
    flash(`Removed ${r.removed} passkey${r.removed === 1 ? '' : 's'} for ${name}.`);
    refresh();
  }
  async function toggleAuth() {
    const next = !(status?.authEnabled);
    busy = true;
    const r = await api.authSetEnabled(next);
    busy = false;
    if (r.error) return flash(r.error, true);
    // Enabling while not signed in: reload so the login gate engages and you sign
    // in with the account you just created (rather than silently breaking calls).
    if (next && !status?.authed) { location.reload(); return; }
    flash(next ? 'Auth enabled — others now need to sign in.' : 'Auth disabled.');
    refresh();
  }
  async function logout() {
    await api.authLogout();
    location.reload();
  }
</script>

<div class="h-full overflow-auto p-5 max-w-2xl mx-auto text-sm">
  <h1 class="text-lg font-semibold mb-4">Settings</h1>

  {#if msg}<div class="mb-3 rounded border border-green-600/40 bg-green-600/10 text-green-700 dark:text-green-300 px-3 py-2">{msg}</div>{/if}
  {#if err}<div class="mb-3 rounded border border-red-600/40 bg-red-600/10 text-red-700 dark:text-red-300 px-3 py-2">{err}</div>{/if}

  <!-- Authentication -->
  <section class="mb-6 rounded-lg border border-line bg-card p-4">
    <div class="flex items-center justify-between">
      <div>
        <div class="font-medium">Authentication</div>
        <div class="text-xs text-muted mt-0.5">
          Optional. If you reach this server over a private mesh (Tailscale, NetBird, ZeroTier) or
          trust your network, you can leave it off. Turn it on to require a login.
        </div>
      </div>
      <button
        class="shrink-0 ml-4 rounded px-3 py-1.5 text-xs font-medium border {status?.authEnabled ? 'bg-green-700 hover:bg-green-600 text-white border-transparent' : 'border-line text-muted hover:text-content'} disabled:opacity-40 disabled:cursor-not-allowed"
        disabled={busy || (!status?.authEnabled && !canEnable)}
        title={status?.authEnabled ? 'Click to disable auth' : canEnable ? 'Click to require login' : 'Set a session key and add a user first'}
        onclick={toggleAuth}>
        {status?.authEnabled ? 'Enabled' : 'Disabled'}
      </button>
    </div>

    {#if config && !config.hasSessionKey}
      <div class="mt-3 text-xs rounded border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3 py-2">
        No <code>WORKSPACE_SESSION_KEY</code> is set in the server's <code>.env</code>. Set one
        (e.g. <code>openssl rand -hex 32</code>) and restart the API before enabling auth.
      </div>
    {:else if !status?.authEnabled && users.length === 0}
      <div class="mt-3 text-xs rounded border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3 py-2">
        Add a user below before enabling auth — otherwise you'd have no account to sign in with.
      </div>
    {/if}

    {#if status?.authed}
      <div class="mt-3 flex items-center justify-between text-xs">
        <span class="text-muted">Signed in as <span class="text-content font-medium">{status.user?.username}</span></span>
        <button class="text-muted hover:text-content underline" onclick={logout}>Sign out</button>
      </div>
    {/if}
  </section>

  <!-- Users -->
  <section class="mb-6 rounded-lg border border-line bg-card p-4">
    <div class="font-medium mb-2">Users</div>
    {#if users.length === 0}
      <div class="text-xs text-muted mb-3">No users yet. Add one below — you'll need at least one before enabling auth.</div>
    {:else}
      <ul class="mb-3 divide-y divide-line">
        {#each users as u (u.id)}
          <li class="flex items-center justify-between py-1.5">
            <span>{u.username}
              {#if u.passkeyCount > 0}<span class="text-xs text-muted">· {u.passkeyCount} passkey{u.passkeyCount === 1 ? '' : 's'}</span>{/if}
            </span>
            <span class="flex items-center gap-3 text-xs">
              {#if u.passkeyCount > 0}
                <button class="text-amber-600 dark:text-amber-400 hover:underline" title="Remove all of this user's passkeys" onclick={() => resetUserPasskeys(u.id, u.username)}>Reset passkeys</button>
              {/if}
              <button class="text-red-500 hover:text-red-400" title="Delete user" onclick={() => removeUser(u.id, u.username)}>Remove</button>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="flex gap-2">
      <input class="flex-1 bg-elevated border border-line rounded px-2 py-1" placeholder="username" bind:value={newUser} autocomplete="off" />
      <input class="flex-1 bg-elevated border border-line rounded px-2 py-1" placeholder="password (min 6)" type="password" bind:value={newPass} autocomplete="new-password" />
      <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-3 disabled:opacity-40"
        disabled={busy || !newUser.trim() || newPass.length < 6} onclick={addUser}>Add</button>
    </div>
  </section>

  <!-- Passkeys (WebAuthn) -->
  {#if status?.authed}
  <section class="mb-6 rounded-lg border border-line bg-card p-4">
    <div>
      <div class="font-medium">Passkeys (Face ID / Touch ID / Windows Hello)</div>
      <div class="text-xs text-muted mt-0.5">
        Sign in with your device's biometrics instead of, or in addition to, a password.
        Self-hosted — no third-party service.
      </div>
    </div>

    <!-- Login policy -->
    <div class="mt-3 flex items-center gap-2">
      <span class="text-xs text-muted">Login requires</span>
      <select class="bg-elevated border border-line rounded px-2 py-1 text-xs"
        value={status?.loginPolicy} disabled={busy}
        onchange={(e) => setPolicy(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
        <option value="password">Password only</option>
        <option value="either">Password or passkey</option>
        <option value="passkey">Passkey only (passwordless)</option>
        <option value="both">Password + passkey (2FA)</option>
      </select>
    </div>
    {#if (status?.loginPolicy === 'passkey' || status?.loginPolicy === 'both') && passkeys.length === 0}
      <div class="mt-2 text-xs rounded border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3 py-2">
        You have no passkey enrolled. Add this device below first — until you do, this account still
        signs in with a password (so you can't get locked out).
      </div>
    {/if}

    <div class="mt-3">
      {#if passkeys.length === 0}
        <div class="text-xs text-muted mb-3">No passkeys on this account yet. Add one from each device you want to sign in from.</div>
      {:else}
        <ul class="mb-3 divide-y divide-line">
          {#each passkeys as p (p.id)}
            <li class="flex items-center justify-between py-1.5 text-xs">
              <span>{p.name} <span class="text-muted">· added {new Date(p.addedAt).toLocaleDateString()}</span></span>
              <button class="text-red-500 hover:text-red-400" onclick={() => removePasskey(p.id)}>Remove</button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if passkeysSupported()}
        <button class="text-xs bg-green-700 hover:bg-green-600 text-white rounded px-3 py-1.5 disabled:opacity-40"
          disabled={busy} onclick={addPasskey}>Add this device</button>
      {:else}
        <div class="text-xs text-amber-600 dark:text-amber-400">This browser doesn't support passkeys.</div>
      {/if}
    </div>
  </section>
  {/if}

  <!-- Server config (read-only) -->
  <section class="rounded-lg border border-line bg-card p-4">
    <div class="font-medium mb-2">Server configuration</div>
    <div class="text-xs text-muted mb-2">Read-only. Change these via the server's <code>.env</code> and restart the API.</div>
    {#if config}
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
        <dt class="text-muted">Project roots</dt><dd class="break-all">{config.projectRoots.join('  ·  ') || '—'}</dd>
        <dt class="text-muted">Terminal cwd</dt><dd class="break-all">{config.termCwd || '—'}</dd>
        <dt class="text-muted">Data dir</dt><dd class="break-all">{config.dataDir}</dd>
        <dt class="text-muted">Agent CLI</dt><dd class="break-all">{config.agentBin}</dd>
      </dl>
    {/if}
  </section>
</div>
