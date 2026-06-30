<script>
  // Full-screen gate shown when auth is enabled and the visitor isn't signed in.
  // If no account exists yet it offers a one-time signup for the first (admin)
  // account; otherwise it's a plain login. On success it reloads the app.
  import { api } from '$lib/api.js';
  import { loginWithPasskey, enrollPasskey, passkeysSupported, deviceLabel } from '$lib/passkeys.js';

  /** @type {{ needsBootstrap?: boolean, loginPolicy?: string }} */
  let { needsBootstrap = false, loginPolicy = 'password' } = $props();

  let username = $state(''); let password = $state('');
  let busy = $state(false); let err = $state('');
  const signup = $derived(needsBootstrap);
  // Post-password interstitial: offer to set up a passkey on this device when the
  // user has none yet (the first passkey is always allowed from a password session).
  let offerEnroll = $state(false);
  // The standalone "Sign in with a passkey" button is for password-or-passkey and
  // passwordless policies. Under 2FA ('both') the passkey isn't a separate path —
  // it runs automatically after the password step — so no standalone button.
  const showPasskey = $derived(
    !signup && passkeysSupported() && (loginPolicy === 'either' || loginPolicy === 'passkey'));

  async function passkeyLogin() {
    busy = true; err = '';
    const r = await loginWithPasskey();
    busy = false;
    if (r.error) { err = r.error; return; }
    location.reload();
  }

  async function submit(/** @type {Event} */ e) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    busy = true; err = '';
    if (signup) {
      const r = await api.authSignup(username.trim(), password);
      busy = false;
      if (r.error) { err = r.error; return; }
      location.reload(); return;
    }
    const r = await api.authLogin(username.trim(), password);
    // 2FA: password verified, now complete the passkey step before the session.
    if (r.step === 'passkey') {
      err = 'Confirm with your passkey…';
      const r2 = await loginWithPasskey(r.stepToken);
      busy = false;
      if (r2.error) { err = r2.error; return; }
      location.reload(); return;
    }
    busy = false;
    if (r.error) { err = r.error; return; }
    // First passkey nudge: logged in, but no passkey yet and the browser supports
    // it — offer to enrol this device instead of dropping straight into the app.
    if (r.firstPasskey && passkeysSupported()) { offerEnroll = true; return; }
    location.reload();
  }

  async function enrollNow() {
    busy = true; err = '';
    const r = await enrollPasskey(deviceLabel());
    busy = false;
    if (r.error) { err = r.error; return; }
    location.reload();
  }
</script>

<div class="fixed inset-0 z-50 grid place-items-center bg-canvas">
  {#if offerEnroll}
    <div class="w-80 rounded-xl border border-line bg-card p-6 shadow-lg">
      <div class="mb-1 text-lg font-semibold tracking-tight">Set up faster sign-in</div>
      <div class="mb-4 text-xs text-muted">
        Use Face ID / Touch ID / Windows Hello on this device next time instead of a password.
      </div>
      {#if err}<div class="mb-3 rounded border border-red-600/40 bg-red-600/10 text-red-700 dark:text-red-300 px-3 py-2 text-xs">{err}</div>{/if}
      <button class="w-full rounded bg-green-700 hover:bg-green-600 text-white text-sm py-2 disabled:opacity-40 mb-2"
        disabled={busy} onclick={enrollNow}>{busy ? '…' : 'Set up on this device'}</button>
      <button class="w-full rounded border border-line text-sm py-2 hover:bg-elevated disabled:opacity-40"
        disabled={busy} onclick={() => location.reload()}>Not now</button>
    </div>
  {:else}
  <form class="w-80 rounded-xl border border-line bg-card p-6 shadow-lg" onsubmit={submit}>
    <div class="mb-1 text-lg font-semibold tracking-tight">Workspace</div>
    <div class="mb-4 text-xs text-muted">
      {signup ? 'Create the first account to secure this workspace.' : 'Sign in to continue.'}
    </div>

    {#if err}<div class="mb-3 rounded border border-red-600/40 bg-red-600/10 text-red-700 dark:text-red-300 px-3 py-2 text-xs">{err}</div>{/if}

    <input class="mb-2 w-full bg-elevated border border-line rounded px-3 py-2 text-sm" placeholder="username"
      bind:value={username} autocomplete="username" />
    <input class="mb-3 w-full bg-elevated border border-line rounded px-3 py-2 text-sm" placeholder="password" type="password"
      bind:value={password} autocomplete={signup ? 'new-password' : 'current-password'} />

    <button class="w-full rounded bg-green-700 hover:bg-green-600 text-white text-sm py-2 disabled:opacity-40"
      disabled={busy || !username.trim() || !password}>
      {busy ? '…' : signup ? 'Create account' : 'Sign in'}
    </button>

    {#if showPasskey}
      <div class="my-3 flex items-center gap-3 text-[10px] uppercase tracking-wide text-muted">
        <span class="h-px flex-1 bg-line"></span>or<span class="h-px flex-1 bg-line"></span>
      </div>
      <button type="button" class="w-full rounded border border-line text-sm py-2 hover:bg-elevated disabled:opacity-40"
        disabled={busy} onclick={passkeyLogin}>
        Sign in with a passkey
      </button>
    {/if}
  </form>
  {/if}
</div>
