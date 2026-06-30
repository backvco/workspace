<script>
  // Full-screen gate shown when auth is enabled and the visitor isn't signed in.
  // If no account exists yet it offers a one-time signup for the first (admin)
  // account; otherwise it's a plain login. On success it reloads the app.
  import { api } from '$lib/api.js';
  import { loginWithPasskey, enrollPasskey, passkeysSupported, deviceLabel } from '$lib/passkeys.js';
  import EnrollCodeInput from '$lib/components/EnrollCodeInput.svelte';

  /** @type {{ needsBootstrap?: boolean, loginPolicy?: string }} */
  let { needsBootstrap = false, loginPolicy = 'password' } = $props();

  let username = $state(''); let password = $state('');
  let busy = $state(false); let err = $state('');
  const signup = $derived(needsBootstrap);
  // Post-password interstitial: offer to set up a passkey on this device when the
  // user has none yet (the first passkey is always allowed from a password session).
  let offerEnroll = $state(false);
  // Enrollment-code path: on a brand-new device under a passkey/2FA policy there's no
  // passkey to complete sign-in, so the user pairs the device with a one-time admin
  // code (entered alongside their password). It's threaded through to enrollPasskey.
  let codeMode = $state(false); let enrollCode = $state(''); let pendingCode = $state('');
  const codeOk = $derived(enrollCode.replace(/[^A-Za-z0-9]/g, '').length === 9);
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
    const code = codeMode ? enrollCode : undefined;
    const r = await api.authLogin(username.trim(), password, code);
    // Enrollment-code path: password + a valid code issued a session under a
    // passkey/2FA policy — go straight to enrolling this device, passing the code on
    // to register-verify (which redeems it). A wrong/expired code falls back to the
    // normal policy response, so flag it rather than silently switching paths.
    if (codeMode) {
      busy = false;
      if (r.error) { err = r.error; return; }
      if (!r.enrollWithCode) { err = 'Enrollment code invalid or expired.'; return; }
      pendingCode = enrollCode; offerEnroll = true; return;
    }
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
    const r = await enrollPasskey(deviceLabel(), pendingCode || undefined);
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

    {#if codeMode}
      <div class="mb-3"><EnrollCodeInput bind:value={enrollCode} disabled={busy} /></div>
    {/if}

    <button class="w-full rounded bg-green-700 hover:bg-green-600 text-white text-sm py-2 disabled:opacity-40"
      disabled={busy || !username.trim() || !password || (codeMode && !codeOk)}>
      {busy ? '…' : signup ? 'Create account' : codeMode ? 'Add this device' : 'Sign in'}
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

    {#if !signup}
      {#if codeMode}
        <button type="button" class="mt-3 w-full text-center text-xs text-muted hover:text-content"
          onclick={() => { codeMode = false; enrollCode = ''; err = ''; }}>
          ← Back to normal sign-in
        </button>
      {:else}
        <div class="my-3 flex items-center gap-3 text-[10px] uppercase tracking-wide text-muted">
          <span class="h-px flex-1 bg-line"></span>new device<span class="h-px flex-1 bg-line"></span>
        </div>
        <button type="button" class="w-full rounded border border-line text-sm py-2 hover:bg-elevated"
          onclick={() => { codeMode = true; enrollCode = ''; err = ''; }}>
          Add this device with an enrollment code
        </button>
      {/if}
    {/if}
  </form>
  {/if}
</div>
