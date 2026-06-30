<script>
  // Authentication: require-login toggle, the login policy (how password + passkey
  // combine), and the current session. Per-user passkeys live in the Users tab.
  import { api } from '$lib/api.js';
  import { s, flash, reload } from './store.svelte.js';

  // Auth can only be enabled once a session key exists AND at least one account
  // exists — otherwise enabling would lock everyone out.
  let canEnable = $derived(!!s.config?.hasSessionKey && s.users.length > 0);

  const POLICY_LABELS = {
    password: 'Password only',
    either: 'Password or passkey',
    passkey: 'Passkey only (passwordless)',
    both: 'Password + passkey (2FA)',
  };

  async function toggleAuth() {
    const next = !(s.status?.authEnabled);
    s.busy = true;
    const r = await api.authSetEnabled(next);
    s.busy = false;
    if (r.error) return flash(r.error, true);
    // Enabling while not signed in: reload so the login gate engages.
    if (next && !s.status?.authed) { location.reload(); return; }
    flash(next ? 'Auth enabled — others now need to sign in.' : 'Auth disabled.');
    reload();
  }
  async function setPolicy(/** @type {string} */ policy) {
    s.busy = true;
    const r = await api.passkeySetPolicy(policy);
    s.busy = false;
    if (r.error) return flash(r.error, true);
    flash(`Login policy: ${POLICY_LABELS[/** @type {keyof typeof POLICY_LABELS} */ (policy)]}.`);
    reload();
  }
  async function logout() { await api.authLogout(); location.reload(); }
</script>

<section class="rounded-lg border border-line bg-card p-4">
  <div class="flex items-center justify-between">
    <div>
      <div class="font-medium">Require login</div>
      <div class="text-xs text-muted mt-0.5">
        Optional. If you reach this server over a private mesh (Tailscale, NetBird, ZeroTier) or
        trust your network, you can leave it off. Turn it on to require a login.
      </div>
    </div>
    <button
      class="shrink-0 ml-4 rounded px-3 py-1.5 text-xs font-medium border {s.status?.authEnabled ? 'bg-green-700 hover:bg-green-600 text-white border-transparent' : 'border-line text-muted hover:text-content'} disabled:opacity-40 disabled:cursor-not-allowed"
      disabled={s.busy || (!s.status?.authEnabled && !canEnable)}
      title={s.status?.authEnabled ? 'Click to disable auth' : canEnable ? 'Click to require login' : 'Set a session key and add a user first'}
      onclick={toggleAuth}>
      {s.status?.authEnabled ? 'Enabled' : 'Disabled'}
    </button>
  </div>

  {#if s.config && !s.config.hasSessionKey}
    <div class="mt-3 text-xs rounded border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3 py-2">
      No <code>WORKSPACE_SESSION_KEY</code> is set in the server's <code>.env</code>. Set one
      (e.g. <code>openssl rand -hex 32</code>) and restart the API before enabling auth.
    </div>
  {:else if !s.status?.authEnabled && s.users.length === 0}
    <div class="mt-3 text-xs rounded border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3 py-2">
      Add a user in the Users tab before enabling auth — otherwise you'd have no account to sign in with.
    </div>
  {/if}

  {#if s.status?.authed}
    <div class="mt-3 flex items-center justify-between text-xs">
      <span class="text-muted">Signed in as <span class="text-content font-medium">{s.status.user?.username}</span></span>
      <button class="text-muted hover:text-content underline" onclick={logout}>Sign out</button>
    </div>
  {/if}
</section>

<!-- Login policy -->
<section class="mt-4 rounded-lg border border-line bg-card p-4">
  <div class="font-medium">Passkeys (Face ID / Touch ID / Windows Hello)</div>
  <div class="text-xs text-muted mt-0.5">
    Sign in with a device's biometrics instead of, or in addition to, a password.
    Self-hosted — no third-party service. Add or remove devices per user in the Users tab.
  </div>
  <div class="mt-3 flex items-center gap-2">
    <span class="text-xs text-muted">Login requires</span>
    <select class="bg-elevated border border-line rounded px-2 py-1 text-xs"
      value={s.status?.loginPolicy} disabled={s.busy}
      onchange={(e) => setPolicy(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
      <option value="password">Password only</option>
      <option value="either">Password or passkey</option>
      <option value="passkey">Passkey only (passwordless)</option>
      <option value="both">Password + passkey (2FA)</option>
    </select>
  </div>
  {#if s.status?.loginPolicy === 'passkey' || s.status?.loginPolicy === 'both'}
    <div class="mt-2 text-xs text-muted">
      Users with no passkey keep password sign-in until they enrol one (so policy changes can't lock anyone out).
    </div>
  {/if}
</section>
