// Browser-side WebAuthn flows. Wraps @simplewebauthn/browser (which handles the
// base64url<->ArrayBuffer marshalling and navigator.credentials calls) around our
// two-step server endpoints: get options -> prompt the platform authenticator
// (Face ID / Touch ID / Windows Hello) -> post the signed result back to verify.
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api } from '$lib/api.js';

export const passkeysSupported = () => browserSupportsWebAuthn();

// A best-effort default label for a newly enrolled device, derived from the
// browser/OS (e.g. "Mac", "Windows", "iPhone", "Android"). It's only a default —
// the user can edit it (a security key or phone-via-QR won't detect cleanly).
export function deviceLabel() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav) return 'Passkey';
  const plat = /** @type {any} */ (nav).userAgentData?.platform || nav.platform || '';
  const ua = nav.userAgent || '';
  const has = (/** @type {RegExp} */ re) => re.test(plat) || re.test(ua);
  if (has(/iPhone/i)) return 'iPhone';
  if (has(/iPad/i)) return 'iPad';
  if (has(/Android/i)) return 'Android';
  if (has(/Mac/i)) return 'Mac';
  if (has(/Win/i)) return 'Windows';
  if (has(/CrOS/i)) return 'Chromebook';
  if (has(/Linux/i)) return 'Linux';
  return 'Passkey';
}

// Enroll this device for the signed-in user. Returns { ok } or { error }.
/** @param {string} name */
export async function enrollPasskey(name) {
  const opt = await api.passkeyRegisterOptions();
  if (opt.error) return { error: opt.error };
  let response;
  try {
    response = await startRegistration({ optionsJSON: opt.options });
  } catch (e) {
    return { error: friendly(e) };
  }
  return api.passkeyRegisterVerify({ challengeId: opt.challengeId, response, name });
}

// Sign in with a passkey (no username needed — discoverable credential). For the
// 2FA policy, pass the step-up token returned by the password step. Returns
// { ok, user } or { error }.
/** @param {string} [stepToken] */
export async function loginWithPasskey(stepToken) {
  const opt = await api.passkeyLoginOptions();
  if (opt.error) return { error: opt.error };
  let response;
  try {
    response = await startAuthentication({ optionsJSON: opt.options });
  } catch (e) {
    return { error: friendly(e) };
  }
  return api.passkeyLoginVerify({ challengeId: opt.challengeId, response, stepToken });
}

// startRegistration/startAuthentication throw on cancel/timeout/no-credential —
// turn those into a short message instead of a raw DOMException string.
/** @param {any} e */
function friendly(e) {
  const name = e?.name || '';
  if (name === 'NotAllowedError') return 'Cancelled or timed out.';
  if (name === 'InvalidStateError') return 'This device is already registered.';
  return String(e?.message || e);
}
