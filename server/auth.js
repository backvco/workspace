// Optional authentication. Disabled by default (single-user / private-mesh
// deployments don't need it); toggled on from the Settings tool. When enabled:
//   - users are stored in Postgres with scrypt-hashed passwords,
//   - login issues an HMAC-signed, HttpOnly session cookie (key from .env),
//   - every API route + the terminal websocket require a valid session,
//   - local agent CLIs bypass the gate with the per-process internal token.
// No external dependencies — Node's crypto + a tiny cookie parser.
import crypto from 'node:crypto';
import { q } from './db.js';

const COOKIE = 'ws_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// --- password hashing (scrypt) ---
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}
// A fixed hash to verify against when the username is unknown, so login spends the
// same scrypt time whether or not the user exists (defeats username enumeration by
// timing). The supplied password can never match this random one.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
export function verifyLogin(pw, user) {
  return verifyPassword(pw, user?.passwordHash || DUMMY_HASH);
}

// --- signed session token (stateless; key signs + verifies) ---
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
export function signToken(cfg, payload, ttlMs = SESSION_TTL_MS) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  const sig = crypto.createHmac('sha256', cfg.sessionKey).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function verifyToken(cfg, token) {
  if (!cfg.sessionKey || !token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const want = crypto.createHmac('sha256', cfg.sessionKey).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

// Shared cross-site request defense. A script-initiated browser request carries
// an Origin header the page can't forge, so we require it to match a host we
// trust. A missing Origin means a non-browser client (e.g. a CLI tool), which
// can't be a cross-site attacker, so it's allowed.
export function originAllowed(req, cfg) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost;
  try { originHost = new URL(origin).hostname; } catch { return false; }
  if (originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1') return true;
  const allowed = new Set();
  const add = (h) => { if (h) allowed.add(String(h).split(',')[0].trim().split(':')[0]); };
  add(req.headers.host);                 // same-origin (Host preserved through the proxy)
  add(req.headers['x-forwarded-host']);  // same-origin behind a reverse proxy
  add(cfg.publicHost);
  for (const o of (cfg.allowedOrigins || [])) add(o);
  return allowed.has(originHost);
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers?.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(req, res, token) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https');
  res.cookie?.(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_TTL_MS
  });
}
export function clearSessionCookie(res) {
  res.cookie?.(COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}

// The signed-in user for a request, or null. Reads + verifies the session cookie.
// (Cookie + signature only - call userExists() to confirm the account still exists.)
export function sessionUser(cfg, req) {
  const token = parseCookies(req)[COOKIE];
  return verifyToken(cfg, token); // { uid, name, exp } | null
}

// --- users (Postgres) ---
// Does this user id still exist? Used to revoke a stateless session the moment its
// user is deleted (otherwise the signed cookie would keep working until it expires).
export async function userExists(cfg, id) {
  if (!id) return false;
  return (await q(cfg, 'SELECT 1 FROM users WHERE id = $1', [String(id)])).length > 0;
}
export async function countUsers(cfg) {
  return Number((await q(cfg, 'SELECT count(*)::int AS n FROM users'))[0]?.n || 0);
}
export async function listUsers(cfg) {
  const rows = await q(cfg, 'SELECT data FROM users ORDER BY created_at');
  return rows.map((r) => ({ id: r.data.id, username: r.data.username, name: r.data.name || '', email: r.data.email || '', createdAt: r.data.createdAt, passkeyCount: (r.data.credentials || []).length }));
}
export async function findUser(cfg, username) {
  const rows = await q(cfg, 'SELECT data FROM users WHERE lower(data->>\'username\') = lower($1)', [String(username || '')]);
  return rows[0]?.data || null;
}
export async function createUser(cfg, username, password) {
  username = String(username || '').trim();
  if (!username || !password) return { error: 'username and password required' };
  if (String(password).length < 6) return { error: 'password must be at least 6 characters' };
  if (await findUser(cfg, username)) return { error: 'username already exists' };
  const user = { id: crypto.randomUUID(), username, passwordHash: hashPassword(password), createdAt: Date.now() };
  await q(cfg, 'INSERT INTO users (id, data) VALUES ($1, $2::jsonb)', [user.id, JSON.stringify(user)]);
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}
export async function deleteUser(cfg, id) {
  await q(cfg, 'DELETE FROM users WHERE id = $1', [id]);
  return true;
}
// Editable profile fields (display name, email). Stored only — no behaviour yet.
export async function updateUser(cfg, id, { name, email } = {}) {
  const rows = await q(cfg, 'SELECT data FROM users WHERE id = $1', [String(id)]);
  const user = rows[0]?.data;
  if (!user) return { error: 'user not found' };
  if (name !== undefined) user.name = String(name).slice(0, 200);
  if (email !== undefined) user.email = String(email).slice(0, 320);
  await q(cfg, 'UPDATE users SET data = $2::jsonb WHERE id = $1', [user.id, JSON.stringify(user)]);
  return { id: user.id, username: user.username, name: user.name || '', email: user.email || '' };
}
// Admin set-password: replaces a user's password without the old one (any signed-in
// user can manage accounts in this app — same model as add/remove user).
export async function setUserPassword(cfg, id, password) {
  if (!password || String(password).length < 6) return { error: 'password must be at least 6 characters' };
  const rows = await q(cfg, 'SELECT data FROM users WHERE id = $1', [String(id)]);
  const user = rows[0]?.data;
  if (!user) return { error: 'user not found' };
  user.passwordHash = hashPassword(password);
  await q(cfg, 'UPDATE users SET data = $2::jsonb WHERE id = $1', [user.id, JSON.stringify(user)]);
  return { ok: true };
}

// --- settings (auth.enabled), cached so the ws upgrade + middleware are cheap ---
// SECURITY: auth must fail CLOSED. `known` flips true only after a successful DB
// read; until then (cold start) we treat auth as enabled (deny) so a restart can't
// briefly serve unauthenticated. On a later DB error we keep the last-known value
// instead of flipping the lock off (a DB outage must never disable auth).
let cache = { enabled: false, at: 0, known: false };
const CACHE_MS = 3000;
export async function getAuthEnabled(cfg) {
  const rows = await q(cfg, 'SELECT value FROM settings WHERE key = $1', ['auth.enabled']);
  const enabled = rows[0]?.value === true;
  cache = { enabled, at: Date.now(), known: true };
  return enabled;
}
// Sync best-effort read for hot paths (ws upgrade). Refreshes in the background.
// Fails closed (treat as enabled) until the first successful read lands.
export function authEnabledCached(cfg) {
  if (Date.now() - cache.at > CACHE_MS) getAuthEnabled(cfg).catch(() => {});
  return cache.known ? cache.enabled : true;
}
export async function setAuthEnabled(cfg, enabled) {
  if (enabled && (!cfg.sessionKey || cfg.sessionKey.length < 32))
    return { error: 'Set a strong WORKSPACE_SESSION_KEY (32+ chars, e.g. `openssl rand -hex 32`) in .env before enabling auth.' };
  // Require an account before turning auth on, so you sign in as yourself rather
  // than depending on the first-run signup (which remains only as a lockout-proof
  // fallback for auth enabled out-of-band, e.g. directly in the database).
  if (enabled && (await countUsers(cfg)) === 0) return { error: 'Create a user below before enabling auth — otherwise you could lock yourself out.' };
  await q(cfg, `INSERT INTO settings (key, value) VALUES ('auth.enabled', $1::jsonb)
                ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`, [JSON.stringify(!!enabled)]);
  cache = { enabled: !!enabled, at: Date.now(), known: true };
  return { ok: true, enabled: !!enabled };
}

// Public (always reachable) API paths — relative to the router base.
const PUBLIC = new Set(['/auth/status', '/auth/login', '/auth/logout', '/auth/signup',
  '/auth/passkey/login-options', '/auth/passkey/login-verify']);

// Express middleware enforcing auth when enabled. Attaches req.workspaceUser.
export function authMiddleware(cfg) {
  return async (req, res, next) => {
    let enabled;
    // Fail CLOSED: on a DB error keep the last-known value; if we've never read it
    // (cold start + DB down), treat auth as enabled so we never serve open by accident.
    try { enabled = await getAuthEnabled(cfg); } catch { enabled = cache.known ? cache.enabled : true; }
    if (!enabled) return next();
    // Local agent CLIs (agent-report / plan-emit / tickets MCP) present the
    // per-process internal token instead of a user cookie.
    if (cfg.internalToken && req.headers['x-workspace-token'] === cfg.internalToken) return next();
    if (PUBLIC.has(req.path)) return next();
    const user = sessionUser(cfg, req);
    if (!user) return res.status(401).json({ error: 'authentication required' });
    // Revoke immediately if the account was deleted (stateless cookie would else live
    // to its expiry). On a DB error, fail closed (treat the session as invalid).
    let ok = false;
    try { ok = await userExists(cfg, user.uid); } catch { ok = false; }
    if (!ok) { clearSessionCookie(res); return res.status(401).json({ error: 'session no longer valid' }); }
    req.workspaceUser = user;
    next();
  };
}

// Gate a websocket upgrade. Returns true if the connection may proceed. Async so it
// can confirm the session's user still exists (revokes a deleted user's cookie).
export async function wsAuthOk(cfg, req) {
  if (!authEnabledCached(cfg)) return true;
  if (cfg.internalToken && req.headers['x-workspace-token'] === cfg.internalToken) return true;
  const user = sessionUser(cfg, req);
  if (!user) return false;
  try { return await userExists(cfg, user.uid); } catch { return false; }
}
