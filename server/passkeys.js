// Optional WebAuthn / passkeys — Face ID / Touch ID / Windows Hello sign-in.
// Self-hosted: the only dependency is @simplewebauthn/server (no third party).
// The biometric match never leaves the device; we only store each credential's
// public key on the user row and verify signed assertions here.
//
//   register (authed): options -> browser prompts biometric -> verify -> store key
//   login   (public) : options -> browser prompts biometric -> verify -> session
//
// Passkeys layer on top of the existing password auth. A login *policy* (see
// below) decides how the password and passkey combine; enrollment always
// requires being signed in.
import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { q } from './db.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const STEPUP_TTL_MS = 5 * 60 * 1000; // password->passkey 2FA hand-off window

// --- login policy (how password + passkey combine) ---
//   password : password only (passkeys can be enrolled but aren't used to log in)
//   either   : password OR passkey (default)
//   passkey  : passwordless — a user WITH an enrolled passkey must use it
//   both     : 2FA — password first, then a passkey step-up
// A user with NO enrolled passkey always keeps password access under passkey/both,
// so tightening the policy can't lock anyone out before they've enrolled.
export const LOGIN_POLICIES = ['password', 'either', 'passkey', 'both'];
export async function getLoginPolicy(cfg) {
  const rows = await q(cfg, 'SELECT value FROM settings WHERE key = $1', ['auth.login.policy']);
  const v = rows[0]?.value;
  if (typeof v === 'string' && LOGIN_POLICIES.includes(v)) return v;
  // Migrate the original boolean toggle: enabled -> 'either', absent/off -> 'password'.
  const old = await q(cfg, 'SELECT value FROM settings WHERE key = $1', ['auth.passkeys.enabled']);
  return old[0]?.value === true ? 'either' : 'password';
}
export async function setLoginPolicy(cfg, policy) {
  if (!LOGIN_POLICIES.includes(policy)) return { error: 'invalid policy' };
  await q(cfg, `INSERT INTO settings (key, value) VALUES ('auth.login.policy', $1::jsonb)
                ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`, [JSON.stringify(policy)]);
  return { ok: true, policy };
}
// Is passkey login offered at all under this policy?
export const passkeyLoginAllowed = (policy) => policy === 'either' || policy === 'passkey' || policy === 'both';

export async function userHasPasskey(cfg, uid) {
  const u = await getUserById(cfg, uid);
  return (u?.credentials || []).length > 0;
}
// Did this session authenticate with a passkey? (session token's `amr` claim:
// 'pwd' | 'passkey' | 'pwd+passkey'.) Proof-of-possession of an enrolled device.
export const passkeyAuthed = (amr) => typeof amr === 'string' && amr.split('+').includes('passkey');

// --- admin one-time enrollment codes (lost-all-devices fallback) ---
const ENROLL_CODE_TTL_MS = 15 * 60 * 1000;
function hashCode(cfg, code) {
  return crypto.createHmac('sha256', cfg.sessionKey || 'x').update(String(code)).digest('hex');
}
// Generate (and store the hash of) a one-time code for a user; returns the plaintext
// once. A fresh code overwrites any previous unused one for that user.
export async function createEnrollCode(cfg, userId) {
  const u = await getUserById(cfg, userId);
  if (!u) return { error: 'user not found' };
  const code = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
  await q(cfg, `INSERT INTO enroll_codes (user_id, code_hash, created_at) VALUES ($1,$2, now())
                ON CONFLICT (user_id) DO UPDATE SET code_hash = $2, created_at = now()`,
    [userId, hashCode(cfg, code)]);
  return { code, expiresInMin: ENROLL_CODE_TTL_MS / 60000 };
}
// Atomically consume a user's code: true only if it matches and is unexpired.
export async function redeemEnrollCode(cfg, userId, code) {
  if (!code) return false;
  const rows = await q(cfg, 'DELETE FROM enroll_codes WHERE user_id = $1 RETURNING code_hash, created_at', [userId]);
  const row = rows[0];
  if (!row) return false;
  if (Date.now() - new Date(row.created_at).getTime() > ENROLL_CODE_TTL_MS) return false;
  const a = Buffer.from(row.code_hash);
  const b = Buffer.from(hashCode(cfg, code));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- relying-party identity (derived from WORKSPACE_PUBLIC_HOST, request fallback) ---
// rpID is a bare hostname; origin is the full https:// URL the browser sees. A
// passkey is bound to rpID, so this must stay stable across deploys.
export function rpInfo(cfg, req) {
  const fromCfg = (cfg.publicHost || '').trim();
  const host = fromCfg
    || String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  const rpID = host.split(':')[0] || 'localhost';
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').includes('https')
    || (rpID !== 'localhost' && rpID !== '127.0.0.1') ? 'https' : 'http';
  return { rpID, rpName: 'Workspace', origin: `${proto}://${host}` };
}

// --- single-use challenge store ---
async function saveChallenge(cfg, { userId = null, kind, challenge }) {
  const id = crypto.randomUUID();
  await q(cfg, 'INSERT INTO webauthn_challenges (id, user_id, kind, challenge) VALUES ($1,$2,$3,$4)',
    [id, userId, kind, challenge]);
  return id;
}
// Atomically consume a challenge: returns its row only if it exists, matches the
// kind, and is unexpired. Deleted on read so it can't be replayed.
async function takeChallenge(cfg, id, kind) {
  if (!id) return null;
  const rows = await q(cfg, 'DELETE FROM webauthn_challenges WHERE id = $1 RETURNING user_id, kind, challenge, created_at', [String(id)]);
  const row = rows[0];
  if (!row || row.kind !== kind) return null;
  if (Date.now() - new Date(row.created_at).getTime() > CHALLENGE_TTL_MS) return null;
  return row;
}

// --- credential storage (on the user's jsonb row) ---
async function getUserById(cfg, id) {
  const rows = await q(cfg, 'SELECT data FROM users WHERE id = $1', [String(id)]);
  return rows[0]?.data || null;
}
async function saveUser(cfg, user) {
  await q(cfg, 'UPDATE users SET data = $2::jsonb WHERE id = $1', [user.id, JSON.stringify(user)]);
}
export async function listCredentialsMeta(cfg, userId) {
  const u = await getUserById(cfg, userId);
  return (u?.credentials || []).map((c) => ({ id: c.id, name: c.name || 'Passkey', addedAt: c.addedAt }));
}
export async function removeCredential(cfg, userId, credId) {
  const u = await getUserById(cfg, userId);
  if (!u) return { error: 'user not found' };
  u.credentials = (u.credentials || []).filter((c) => c.id !== credId);
  await saveUser(cfg, u);
  return { ok: true };
}
// Admin action: drop ALL of a user's passkeys (lost/stolen device, re-enroll).
// The user falls back to password sign-in under any policy until they enroll again.
export async function resetCredentials(cfg, userId) {
  const u = await getUserById(cfg, userId);
  if (!u) return { error: 'user not found' };
  const removed = (u.credentials || []).length;
  u.credentials = [];
  await saveUser(cfg, u);
  return { ok: true, removed };
}
// Find which user owns a credential ID (discoverable-login lookup). Scans users —
// fine at this scale; credential IDs are unique base64url strings.
async function findUserByCredential(cfg, credId) {
  const rows = await q(cfg, `SELECT data FROM users WHERE data->'credentials' @> $1::jsonb`,
    [JSON.stringify([{ id: credId }])]);
  return rows[0]?.data || null;
}

// === registration (user is signed in) ===
export async function registerOptions(cfg, req, uid) {
  const user = await getUserById(cfg, uid);
  if (!user) return { error: 'user not found' };
  const { rpID, rpName } = rpInfo(cfg, req);
  const opts = await generateRegistrationOptions({
    rpName, rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.username,
    attestationType: 'none',
    excludeCredentials: (user.credentials || []).map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const challengeId = await saveChallenge(cfg, { userId: user.id, kind: 'register', challenge: opts.challenge });
  return { options: opts, challengeId };
}
export async function registerVerify(cfg, req, uid, body) {
  const row = await takeChallenge(cfg, body?.challengeId, 'register');
  if (!row || row.user_id !== uid) return { error: 'challenge expired — try again' };
  const { rpID, origin } = rpInfo(cfg, req);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: row.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (e) { return { error: String(e?.message || e) }; }
  if (!verification.verified || !verification.registrationInfo) return { error: 'verification failed' };
  const { credential } = verification.registrationInfo;
  const user = await getUserById(cfg, uid);
  if (!user) return { error: 'user not found' };
  user.credentials = user.credentials || [];
  if (user.credentials.some((c) => c.id === credential.id)) return { ok: true }; // already enrolled
  user.credentials.push({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter || 0,
    transports: credential.transports || body.response?.response?.transports || [],
    name: (body?.name || '').trim() || 'Passkey',
    addedAt: Date.now(),
  });
  await saveUser(cfg, user);
  return { ok: true };
}

// === authentication (no session yet — discoverable credentials) ===
export async function loginOptions(cfg, req) {
  const { rpID } = rpInfo(cfg, req);
  const opts = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  const challengeId = await saveChallenge(cfg, { kind: 'login', challenge: opts.challenge });
  return { options: opts, challengeId };
}
// Verifies the assertion and, on success, returns the owning user so the route can
// issue a session cookie. The signature proves possession; we look the user up by
// the credential ID the authenticator returned.
export async function loginVerify(cfg, req, body) {
  const row = await takeChallenge(cfg, body?.challengeId, 'login');
  if (!row) return { error: 'challenge expired — try again' };
  const credId = body?.response?.id;
  if (!credId) return { error: 'no credential' };
  const user = await findUserByCredential(cfg, credId);
  const cred = user?.credentials?.find((c) => c.id === credId);
  if (!user || !cred) return { error: 'passkey not recognised' };
  const { rpID, origin } = rpInfo(cfg, req);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: row.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
        counter: cred.counter || 0,
        transports: cred.transports,
      },
    });
  } catch (e) { return { error: String(e?.message || e) }; }
  if (!verification.verified) return { error: 'verification failed' };
  // Persist the cloned-authenticator counter so signature counters can't go backwards.
  cred.counter = verification.authenticationInfo.newCounter;
  await saveUser(cfg, user);
  return { ok: true, user: { id: user.id, username: user.username } };
}
