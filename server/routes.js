// REST API: tab persistence, session listing/kill, and image paste -> inject.
// Mounted under whatever base the host app chooses (default '/api').
import express from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadTabs, saveTabs, normalize, removeTabFromState, appendTabToState, tabCountsAll } from './store.js';
import { listSessions, hasSession, killSession, sendText, renameSession } from './tmux.js';
import { sessionName } from './config.js';
import {
  readGlobal, addGlobal, removeGlobal,
  readProject, writeProjectServer, removeProjectServer,
  listProjects, buildDbServer, existingPassword, moveServer
} from './mcp.js';
import { list as fsList, read as fsRead, write as fsWrite, ensureWithin } from './fs.js';
import { listClipboard, clipboardFilePath, pruneClipboard } from './clipboard.js';
import { getStats } from './stats.js';
import { updateStatus, runUpdate } from './selfupdate.js';
import {
  listTargets, createTask, startTask, listAgents, stopAgent, removeTask, recordEvent,
  approveAgent, replyAgent, acceptAgent, listEvents, setLinks, adviseTickets, enhanceTicketDraft,
  planForProject, createMany, reorderTickets, openPlanPRForTask, openTicketChat, discussTicket, openPlanChat,
  applyPlanLocal, revertPlanLocal, updateTask,
  runPlan, pausePlan, resumePlan, renamePlan, archivePlan
} from './agents.js';
import { computeMetrics } from './agent-metrics.js';
import { listTemplates, addTemplate, removeTemplate } from './agent-templates.js';
import { preflightProject, scopedRepos, checkRepo } from './preflight.js';
import { createPlanner, getPlanner, listPlanners, setProposed, stopPlanner, createFromPlanner, verifyPlanner, refineFromReview, setPlanName, enrichPlanner, buildAndValidate } from './planners.js';
import { toolsCatalog, installTool, uninstallTool, scaffoldTool } from './tools.js';
import { loadProjects, addProject, removeProject, availableFolders } from './projects.js';
import {
  listRepos, status as gitStatus, headVersion, branches as gitBranches,
  checkout, createBranch, stage, stageAll, unstage, commit, push, createPR,
  currentBranch, diffRefs, showAtRef
} from './git.js';
import { listRoots } from './projects.js';
import {
  authMiddleware, getAuthEnabled, setAuthEnabled, sessionUser,
  countUsers, listUsers, getUser, gravatarUrl, createUser, deleteUser, updateUser, setUserPassword, findUser, verifyLogin,
  signToken, verifyToken, setSessionCookie, clearSessionCookie, originAllowed
} from './auth.js';
import { rateLimit } from './ratelimit.js';
import {
  getLoginPolicy, setLoginPolicy, passkeyLoginAllowed, userHasPasskey, STEPUP_TTL_MS,
  passkeyAuthed, createEnrollCode, redeemEnrollCode, peekEnrollCode, revokeEnrollCode, enrollCodeStatus,
  listCredentialsMeta, removeCredential, resetCredentials,
  registerOptions, registerVerify, loginOptions, loginVerify
} from './passkeys.js';
import {
  listBackups, backupFile, deleteBackup, createBackup, restoreBackup,
  getBackupSettings, setBackupSettings, backupsAvailable
} from './backups.js';
import { getReaperSettings, setReaperSettings, listOwnedSessions, reapIdleAgents, killOwnedSession } from './agent-reaper.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function buildRouter(cfg) {
  const r = express.Router();
  const wsId = (req) => cfg.resolveWorkspaceId(req);

  // --- CSRF defense: reject cross-site state-changing requests up front. A
  // forged browser POST from another site carries that site's Origin, which
  // won't match; same-origin calls and non-browser clients (no Origin) pass. ---
  r.use((req, res, next) => {
    if (MUTATING.has(req.method) && !originAllowed(req, cfg)) return res.status(403).json({ error: 'cross-site request blocked' });
    next();
  });

  // --- auth gate (no-op when auth is disabled) + auth/settings routes ---
  r.use(authMiddleware(cfg));
  const authj = express.json({ limit: '64kb' });
  // Rate limits on credential-handling endpoints (brute-force defense). Login &
  // passkey assertion are the unauthenticated brute targets; the admin actions are
  // looser since they already require a session.
  const loginRl = rateLimit({ name: 'login', windowMs: 60_000, max: 10 });
  const adminRl = rateLimit({ name: 'admin', windowMs: 60_000, max: 30 });

  // Current auth state for the UI's login gate. Always reachable.
  r.get('/auth/status', async (req, res) => {
    let enabled = false;
    try { enabled = await getAuthEnabled(cfg); } catch {}
    const user = enabled ? sessionUser(cfg, req) : null;
    let email = '';
    if (user) { try { email = (await getUser(cfg, user.uid))?.email || ''; } catch {} }
    let needsBootstrap = false;
    try { needsBootstrap = (await countUsers(cfg)) === 0; } catch {}
    let loginPolicy = 'password';
    try { loginPolicy = await getLoginPolicy(cfg); } catch {}
    res.json({ authEnabled: enabled, authed: !!user, user: user ? { id: user.uid, username: user.name, email, avatar: gravatarUrl(email) } : null, needsBootstrap, hasSessionKey: !!cfg.sessionKey, loginPolicy, passkeysEnabled: passkeyLoginAllowed(loginPolicy) });
  });

  // Forward-auth endpoint for the reverse proxy: lets you gate OTHER same-origin
  // services (e.g. an embedded code-server) with THIS app's session. It's behind
  // the auth gate, so authMiddleware already returns 401 when not signed in; we
  // only reach here (200) when authed - or when auth is off (then everything is
  // open anyway). Caddy: forward_auth localhost:5301 { uri /api/auth/check }. Use
  // r.all so the proxy's auth subrequest passes whatever the original method is.
  r.all('/auth/check', (_req, res) => res.sendStatus(200));

  // First-run signup: only allowed while no users exist yet.
  r.post('/auth/signup', loginRl, authj, async (req, res) => {
    try {
      if ((await countUsers(cfg)) > 0) return res.status(403).json({ error: 'signup is closed — ask an existing user to add you in Settings' });
      const out = await createUser(cfg, req.body?.username, req.body?.password);
      if (out.error) return res.status(400).json(out);
      if (!cfg.sessionKey) return res.json({ ok: true, user: out, note: 'set WORKSPACE_SESSION_KEY to enable login sessions' });
      setSessionCookie(req, res, signToken(cfg, { uid: out.id, name: out.username, amr: 'pwd' }));
      res.json({ ok: true, user: out });
    } catch (e) { (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });

  r.post('/auth/login', loginRl, authj, async (req, res) => {
    try {
      const user = await findUser(cfg, req.body?.username);
      // Always run the scrypt verify (verifyLogin uses a dummy hash when the user is
      // unknown) so response time can't reveal whether a username exists.
      const passOk = verifyLogin(req.body?.password, user);
      if (!user || !passOk) return res.status(401).json({ error: 'invalid username or password' });
      if (!cfg.sessionKey) return res.status(500).json({ error: 'server has no WORKSPACE_SESSION_KEY set' });
      // Apply the login policy. A user with no enrolled passkey always keeps plain
      // password access (so they can sign in and enroll) — this prevents lockout.
      const policy = await getLoginPolicy(cfg);
      const hasPk = await userHasPasskey(cfg, user.id);
      // New-device recovery: under passkey/2FA policies, a brand-new device has no
      // passkey, so the user can't complete the passkey step to get in and enrol it.
      // If they supply a valid one-time admin enrollment code, let the password alone
      // issue a session so they can enrol THIS device. The code isn't consumed here
      // (peek only) — register-verify redeems it, keeping it single-use end-to-end.
      const enrollWithCode = hasPk && (policy === 'passkey' || policy === 'both')
        && !!req.body?.enrollCode && await peekEnrollCode(cfg, user.id, req.body.enrollCode);
      if (hasPk && policy === 'passkey' && !enrollWithCode)
        return res.status(401).json({ error: 'This account uses passkey sign-in. Use “Sign in with a passkey”.', code: 'use_passkey' });
      if (hasPk && policy === 'both' && !enrollWithCode) {
        // Password is the 1st factor — don't issue a session yet. Hand back a short
        // signed step-up token the client must redeem with a passkey assertion.
        const stepToken = signToken(cfg, { uid: user.id, name: user.username, stp: 'pk' }, STEPUP_TTL_MS);
        return res.json({ ok: true, step: 'passkey', stepToken });
      }
      setSessionCookie(req, res, signToken(cfg, { uid: user.id, name: user.username, amr: 'pwd' }));
      // Offer enrollment when the user has no passkey yet (first passkey is always
      // allowed from a password session), or when they're recovering a new device
      // with a code. mustEnroll = the policy actively wants a passkey on this device.
      const mustEnroll = enrollWithCode || (!hasPk && (policy === 'passkey' || policy === 'both'));
      res.json({ ok: true, user: { id: user.id, username: user.username }, mustEnroll, firstPasskey: !hasPk, enrollWithCode });
    } catch (e) { (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });

  r.post('/auth/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

  // Settings (protected when auth on): user management + the auth toggle.
  r.get('/auth/users', async (_req, res) => res.json({ users: await listUsers(cfg) }));
  r.post('/auth/users', authj, async (req, res) => {
    const out = await createUser(cfg, req.body?.username, req.body?.password);
    res.status(out.error ? 400 : 200).json(out);
  });
  r.delete('/auth/users/:id', async (req, res) => {
    if ((await countUsers(cfg)) <= 1) return res.status(400).json({ error: 'cannot delete the last user' });
    res.json({ ok: await deleteUser(cfg, req.params.id) });
  });
  r.patch('/auth/users/:id', authj, async (req, res) => {
    const out = await updateUser(cfg, req.params.id, { name: req.body?.name, email: req.body?.email });
    res.status(out.error ? 400 : 200).json(out);
  });
  r.post('/auth/users/:id/password', adminRl, authj, async (req, res) => {
    const out = await setUserPassword(cfg, req.params.id, req.body?.password);
    res.status(out.error ? 400 : 200).json(out);
  });
  // A specific user's passkeys (admin master-detail view).
  r.get('/auth/users/:id/passkeys', async (req, res) => res.json({ credentials: await listCredentialsMeta(cfg, req.params.id) }));
  r.delete('/auth/users/:id/passkeys/:credId', async (req, res) => res.json(await removeCredential(cfg, req.params.id, req.params.credId)));
  r.post('/auth/enabled', authj, async (req, res) => {
    const out = await setAuthEnabled(cfg, !!req.body?.enabled);
    res.status(out.error ? 400 : 200).json(out);
  });

  // --- passkeys (WebAuthn): Face ID / Touch ID / Windows Hello ---
  // register-* are reachable only when signed in (authMiddleware guards them);
  // login-* are PUBLIC (pre-session) — see the PUBLIC set in auth.js.
  r.post('/auth/passkey/policy', authj, async (req, res) => {
    const out = await setLoginPolicy(cfg, String(req.body?.policy || ''));
    res.status(out.error ? 400 : 200).json(out);
  });
  // Admin: clear another user's passkeys (lost device). Behind the auth gate.
  r.post('/auth/passkey/reset/:id', adminRl, async (req, res) => {
    const out = await resetCredentials(cfg, req.params.id);
    res.status(out.error ? 400 : 200).json(out);
  });
  // Admin: issue a one-time enrollment code so a user who's lost their devices can
  // add a new passkey from a password session. Behind the auth gate.
  r.post('/auth/passkey/enroll-code/:id', adminRl, async (req, res) => {
    const out = await createEnrollCode(cfg, req.params.id);
    res.status(out.error ? 400 : 200).json(out);
  });
  // Admin: revoke an outstanding enrollment code right away (don't wait for the TTL).
  r.delete('/auth/passkey/enroll-code/:id', adminRl, async (req, res) => {
    res.json(await revokeEnrollCode(cfg, req.params.id));
  });
  // Admin: is there an unexpired code for this user? (status only — never the code.)
  r.get('/auth/passkey/enroll-code/:id', authj, async (req, res) => {
    res.json(await enrollCodeStatus(cfg, req.params.id));
  });
  r.get('/auth/passkey/credentials', async (req, res) => {
    const u = sessionUser(cfg, req);
    if (!u) return res.status(401).json({ error: 'sign in first' });
    res.json({ credentials: await listCredentialsMeta(cfg, u.uid) });
  });
  r.delete('/auth/passkey/credentials/:id', async (req, res) => {
    const u = sessionUser(cfg, req);
    if (!u) return res.status(401).json({ error: 'sign in first' });
    res.json(await removeCredential(cfg, u.uid, req.params.id));
  });
  r.post('/auth/passkey/register-options', authj, async (req, res) => {
    try {
      const u = sessionUser(cfg, req);
      if (!u) return res.status(401).json({ error: 'sign in first' });
      const out = await registerOptions(cfg, req, u.uid);
      res.status(out.error ? 400 : 200).json(out);
    } catch (e) { (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });
  r.post('/auth/passkey/register-verify', adminRl, authj, async (req, res) => {
    try {
      const u = sessionUser(cfg, req);
      if (!u) return res.status(401).json({ error: 'sign in first' });
      // Enrollment gate. The FIRST passkey is allowed from a password session
      // (nothing to protect yet). Once the user has a passkey, treat the account
      // as public-internet: a NEW device must be added from a passkey-authenticated
      // session (proof of possession, incl. the QR cross-device flow) OR with a
      // one-time admin enrollment code — a stolen password alone can't add one.
      if (await userHasPasskey(cfg, u.uid) && !passkeyAuthed(u.amr)) {
        const ok = await redeemEnrollCode(cfg, u.uid, req.body?.enrollCode);
        if (!ok) return res.status(403).json({
          code: 'enroll_blocked',
          error: 'To add another device, sign in with an existing passkey, or enter a one-time enrollment code from an admin.',
        });
      }
      const out = await registerVerify(cfg, req, u.uid, req.body || {});
      res.status(out.error ? 400 : 200).json(out);
    } catch (e) { (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });
  r.post('/auth/passkey/login-options', loginRl, authj, async (req, res) => {
    try {
      if (!cfg.sessionKey) return res.status(500).json({ error: 'server has no WORKSPACE_SESSION_KEY set' });
      if (!passkeyLoginAllowed(await getLoginPolicy(cfg))) return res.status(403).json({ error: 'passkey sign-in is disabled' });
      res.json(await loginOptions(cfg, req));
    } catch (e) { (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });
  r.post('/auth/passkey/login-verify', loginRl, authj, async (req, res) => {
    try {
      if (!cfg.sessionKey) return res.status(500).json({ error: 'server has no WORKSPACE_SESSION_KEY set' });
      const policy = await getLoginPolicy(cfg);
      if (!passkeyLoginAllowed(policy)) return res.status(403).json({ error: 'passkey sign-in is disabled' });
      const out = await loginVerify(cfg, req, req.body || {});
      if (out.error) return res.status(401).json(out);
      // Under 2FA, a passkey alone is NOT enough — require the step-up token issued
      // by the password step, and confirm it names the same user as the assertion.
      let amr = 'passkey';
      if (policy === 'both') {
        const tok = verifyToken(cfg, req.body?.stepToken);
        if (!tok || tok.stp !== 'pk' || tok.uid !== out.user.id)
          return res.status(401).json({ error: 'enter your password first' });
        amr = 'pwd+passkey';
      }
      setSessionCookie(req, res, signToken(cfg, { uid: out.user.id, name: out.user.username, amr }));
      res.json({ ok: true, user: out.user });
    } catch (e) { (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });

  // Read-only config the Settings tool surfaces (no secrets).
  r.get('/config', (_req, res) => res.json({
    projectRoots: cfg.projectRoots, termCwd: cfg.termCwd, dataDir: cfg.dataDir,
    agentBin: cfg.claudeBin, hasSessionKey: !!cfg.sessionKey,
    codeServerUrl: cfg.codeServerUrl
  }));
  r.get('/roots', (_req, res) => res.json({ roots: listRoots(cfg) }));

  // --- database backups (auth-gated: a backup is the entire database; adminRl
  //     rate-limits the filesystem/pg_dump work against request floods) ---
  r.get('/backups', adminRl, async (_req, res) => {
    try { res.json({ backups: listBackups(cfg), settings: await getBackupSettings(cfg), available: backupsAvailable(cfg), dir: cfg.backupDir }); }
    catch (e) { (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });
  r.post('/backups', adminRl, async (_req, res) => {
    try { res.json({ ok: true, backup: await createBackup(cfg) }); }
    catch (e) { res.status(400).json({ error: e?.message || 'backup failed' }); }
  });
  r.get('/backups/:name/download', adminRl, (req, res) => {
    const f = backupFile(cfg, req.params.name);
    if (!f) return res.status(404).json({ error: 'not found' });
    res.download(f, path.basename(f)); // filename from the validated path, not raw input
  });
  r.delete('/backups/:name', adminRl, (req, res) => res.json({ ok: deleteBackup(cfg, req.params.name) }));
  r.post('/backups/config', adminRl, authj, async (req, res) => {
    const out = await setBackupSettings(cfg, { schedule: req.body?.schedule, retention: req.body?.retention });
    res.status(out.error ? 400 : 200).json(out);
  });
  // Guarded restore: the client must echo the exact filename in `confirm`.
  r.post('/backups/restore', adminRl, authj, async (req, res) => {
    if (req.body?.confirm !== req.body?.name) return res.status(400).json({ error: 'confirmation does not match' });
    try { await restoreBackup(cfg, req.body.name); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e?.message || 'restore failed' }); }
  });

  // --- idle agent-session reaper: admin-editable GC settings + manual sweep/kill
  //     (see agent-reaper.js — sessions are agent/chat/plan-review/planner only,
  //     never the operator's manual terminal tabs) ---
  r.get('/reaper', adminRl, async (_req, res) => {
    try { res.json({ settings: await getReaperSettings(cfg), sessions: await listOwnedSessions(cfg) }); }
    catch (e) { (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });
  r.post('/reaper/config', adminRl, authj, async (req, res) => {
    res.json({ ok: true, settings: await setReaperSettings(cfg, req.body || {}) });
  });
  r.post('/reaper/sweep', adminRl, async (_req, res) => {
    try { res.json({ ok: true, ...(await reapIdleAgents(cfg)) }); }
    catch (e) { res.status(400).json({ error: e?.message || 'sweep failed' }); }
  });
  r.post('/reaper/sessions/:name/kill', adminRl, async (req, res) => {
    res.json(await killOwnedSession(cfg, req.params.name));
  });

  // --- projects: the registry the left rail manages; each scopes its own tabs ---
  r.get('/projects', async (_req, res) => res.json({ projects: await loadProjects(cfg) }));
  r.get('/projects/available', async (req, res) => res.json({ folders: await availableFolders(cfg, req.query.root) }));
  r.post('/projects', express.json({ limit: '64kb' }), async (req, res) => res.json(await addProject(cfg, req.body || {})));
  r.delete('/projects/:id', async (req, res) => res.json({ ok: await removeProject(cfg, req.params.id) }));

  // --- tabs: the server-side source of truth for the UI's tab set ---
  r.get('/tabs/counts', async (_req, res) => res.json(await tabCountsAll(cfg)));
  r.get('/tabs', async (req, res) => res.json(await loadTabs(cfg, wsId(req))));
  r.put('/tabs', express.json({ limit: '1mb' }), async (req, res) =>
    res.json(await saveTabs(cfg, wsId(req), req.body)));

  // Move a tab from the active project to another. Updates both projects' tab
  // sets and renames the tmux session so a terminal's live shell follows.
  r.post('/tabs/move', express.json({ limit: '64kb' }), async (req, res) => {
    const from = wsId(req);
    const { tabId, toProject } = req.body || {};
    if (!tabId || !toProject) return res.status(400).json({ error: 'tabId and toProject required' });
    if (toProject === from) return res.json({ ok: true });
    const src = normalize(await loadTabs(cfg, from));
    const tab = removeTabFromState(src, tabId);
    if (!tab) return res.status(404).json({ error: 'tab not found' });
    await saveTabs(cfg, from, src);
    const dst = normalize(await loadTabs(cfg, toProject));
    appendTabToState(dst, tab);
    await saveTabs(cfg, toProject, dst);
    await renameSession(sessionName(cfg, from, tabId), sessionName(cfg, toProject, tabId));
    res.json({ ok: true });
  });

  // --- live tmux sessions for this workspace ---
  r.get('/sessions', async (req, res) => {
    const prefix = `${cfg.sessionPrefix}${wsId(req)}-`;
    const all = await listSessions();
    res.json({ sessions: all.filter((s) => s.startsWith(prefix)) });
  });
  r.post('/sessions/:tabKey/kill', async (req, res) => {
    await killSession(sessionName(cfg, wsId(req), req.params.tabKey));
    res.json({ ok: true });
  });

  // --- paste: store an image, optionally type its path into a terminal ---
  r.post('/paste', express.raw({ type: () => true, limit: cfg.maxUploadBytes }),
    async (req, res) => {
      const ext = EXT[(req.headers['content-type'] || '').split(';')[0]] || 'png';
      const dir = cfg.clipboardDir(wsId(req));
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `paste-${Date.now()}.${ext}`);
      try {
        writeFileSync(file, req.body);
      } catch (e) {
        return (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' }));
      }
      let injected = false;
      const tabKey = req.query.tab;
      if (tabKey) {
        const session = sessionName(cfg, wsId(req), String(tabKey));
        if (await hasSession(session)) injected = await sendText(session, `${file} `);
      }
      res.json({ path: file, injected });
    });

  // --- clipboard explorer: list / serve / prune pasted images for a workspace ---
  r.get('/clipboard', (req, res) => res.json(listClipboard(cfg, wsId(req))));

  r.get('/clipboard/file', (req, res) => {
    // wsId from the ?ws= query (an <img src> can't send the project header), else
    // header. Constrain to safe id chars so it can't traverse out of data/workspaces.
    const raw = req.query.ws ? String(req.query.ws) : wsId(req);
    if (!/^[\w-]+$/.test(raw)) return res.status(400).json({ error: 'invalid workspace' });
    const file = clipboardFilePath(cfg, raw, String(req.query.name || ''));
    if (!file) return res.status(400).json({ error: 'invalid name' });
    res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'not found' }); });
  });

  r.delete('/clipboard', authj, (req, res) => {
    const { all, olderThanMs, name } = req.body || {};
    res.json(pruneClipboard(cfg, wsId(req), { all: !!all, olderThanMs: olderThanMs ?? null, name: name ? String(name) : null }));
  });

  // --- MCP management: global (user scope) + per-project (.mcp.json) ---
  r.get('/mcp/global', (_req, res) => res.json({ servers: readGlobal() }));
  r.get('/mcp/projects', (_req, res) => res.json({ projects: listProjects(cfg) }));
  r.get('/mcp/project', (req, res) => {
    // Confine to a project root so .mcp.json reads can't traverse out (and so the
    // sanitized path is what reaches the fs sink — clears CodeQL path-injection).
    let p;
    try { p = ensureWithin(cfg, String(req.query.path || '')); } catch { return res.status(400).json({ error: 'path outside allowed roots' }); }
    res.json({ path: p, servers: readProject(p) });
  });
  r.post('/mcp/add', express.json({ limit: '256kb' }), async (req, res) => {
    const { scope, projectPath, name, kind, config } = req.body || {};
    if (!name || !kind) return res.status(400).json({ error: 'name and kind required' });
    // For project scope, confine the target dir to a configured root up front and
    // use that sanitized path everywhere below.
    let safePath = projectPath;
    if (scope !== 'global') {
      if (!projectPath) return res.status(400).json({ error: 'projectPath required for project scope' });
      try { safePath = ensureWithin(cfg, projectPath); } catch { return res.status(400).json({ error: 'projectPath outside allowed roots' }); }
    }
    // Editing in place: blank password means "keep the current one".
    if (config && !config.password) {
      const keep = existingPassword(cfg, scope, safePath, name);
      if (keep) config.password = keep;
    }
    const server = buildDbServer(kind, config || {});
    if (!server.command && !server.url) return res.status(400).json({ error: 'incomplete server config' });
    if (scope === 'global') {
      const out = await addGlobal(cfg, name, server);
      return out.ok ? res.json({ ok: true }) : res.status(500).json({ error: out.err || 'claude mcp add failed' });
    }
    try { writeProjectServer(safePath, name, server); res.json({ ok: true, file: `${safePath}/.mcp.json` }); }
    catch (e) { (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });
  r.post('/mcp/move', express.json({ limit: '64kb' }), async (req, res) => {
    const { name, from, to } = req.body || {};
    if (!name || !from || !to) return res.status(400).json({ error: 'name, from, to required' });
    // Confine each project-scoped endpoint to a root before it reaches the fs sinks.
    const confineLoc = (loc) => loc?.scope === 'global' ? loc : { ...loc, projectPath: ensureWithin(cfg, loc?.projectPath) };
    let safeFrom, safeTo;
    try { safeFrom = confineLoc(from); safeTo = confineLoc(to); } catch { return res.status(400).json({ error: 'projectPath outside allowed roots' }); }
    const out = await moveServer(cfg, name, safeFrom, safeTo);
    return out.ok ? res.json({ ok: true }) : res.status(500).json({ error: out.error });
  });
  r.post('/mcp/remove', express.json({ limit: '64kb' }), async (req, res) => {
    const { scope, projectPath, name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    if (scope === 'global') {
      const out = await removeGlobal(cfg, name);
      return out.ok ? res.json({ ok: true }) : res.status(500).json({ error: out.err || 'remove failed' });
    }
    let safePath;
    try { safePath = ensureWithin(cfg, projectPath); } catch { return res.status(400).json({ error: 'projectPath outside allowed roots' }); }
    try { removeProjectServer(safePath, name); res.json({ ok: true }); }
    catch (e) { (console.error('server error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });

  // --- host stats for the header gauge ---
  r.get('/stats', async (_req, res) => res.json(await getStats()));

  // --- self-update: is the live checkout behind its git remote? pull + deploy ---
  r.get('/version', async (_req, res) => {
    try { res.json(await updateStatus()); }
    catch (e) { (console.error('version error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });
  r.post('/update', async (req, res) => {
    try { res.json(await runUpdate(String(req.query.force || '') === '1')); }
    catch (e) { (console.error('update error:', e?.message || e), res.status(500).json({ error: 'internal error' })); }
  });

  // --- Files: filesystem browse/read/write (guarded to roots) ---
  r.get('/fs/list', (req, res) => {
    try { res.json(fsList(cfg, String(req.query.path || cfg.termCwd))); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.get('/fs/read', (req, res) => {
    try { res.json({ path: String(req.query.path), content: fsRead(cfg, String(req.query.path)) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.post('/fs/write', express.json({ limit: '8mb' }), (req, res) => {
    try { res.json({ ok: true, path: fsWrite(cfg, req.body.path, req.body.content) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // --- Changes: git repos, working-tree status, and HEAD-vs-disk diff ---
  const gj = express.json({ limit: '256kb' });
  // Resolve the request's repo and confine it to a configured project root, so
  // git/gh can never run in a directory outside the roots (path traversal). Returns
  // the sanitized absolute path, or null after sending a 400 (caller must return).
  // Deriving it here — rather than in middleware — also threads the sanitized value
  // into git.js, which clears CodeQL's path-injection on the execFile sinks.
  const safeRepo = (req, res) => {
    try { return ensureWithin(cfg, String(req.query.repo ?? req.body?.repo ?? '')); }
    catch { res.status(400).json({ error: 'repo outside allowed roots' }); return null; }
  };
  r.get('/git/repos', (_req, res) => res.json({ repos: listRepos(cfg) }));
  r.get('/git/status', async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    res.json({ changes: await gitStatus(repo) });
  });
  r.get('/git/diff', async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    const file = String(req.query.file || '');
    let modified = '';
    try { modified = fsRead(cfg, `${repo}/${file}`); } catch { modified = ''; } // deleted/binary -> empty
    res.json({ original: await headVersion(repo, file), modified });
  });

  // Read-only branch browsing: compare the current branch against another ref
  // (no checkout), and diff a single file across the two refs.
  r.get('/git/compare', async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    const base = await currentBranch(repo);
    res.json({ base, files: await diffRefs(repo, base, String(req.query.ref || '')) });
  });
  r.get('/git/refdiff', async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    const file = String(req.query.file || '');
    res.json({
      original: await showAtRef(repo, String(req.query.base || ''), file),
      modified: await showAtRef(repo, String(req.query.ref || ''), file)
    });
  });

  // git mutations (POST). Each returns { ok } or { error, detail } so the UI can show why.
  const done = (res, out) => (out.ok ? res.json({ ok: true, out: out.out }) : res.status(400).json({ error: out.err || 'git error' }));
  r.get('/git/branches', async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    res.json(await gitBranches(repo));
  });
  r.post('/git/checkout', gj, async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    done(res, await checkout(repo, req.body.branch));
  });
  r.post('/git/branch', gj, async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    done(res, await createBranch(repo, req.body.name, req.body.from));
  });
  r.post('/git/stage', gj, async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    done(res, req.body.all ? await stageAll(repo) : await stage(repo, req.body.files || []));
  });
  r.post('/git/unstage', gj, async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    done(res, await unstage(repo, req.body.files || []));
  });
  r.post('/git/commit', gj, async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    if (!req.body.message) return res.status(400).json({ error: 'commit message required' });
    done(res, await commit(repo, req.body.message));
  });
  r.post('/git/push', gj, async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    done(res, await push(repo, req.body.branch, req.body.setUpstream));
  });
  r.post('/git/pr', gj, async (req, res) => {
    const repo = safeRepo(req, res); if (repo === null) return;
    const r2 = await createPR(repo, req.body.base || 'dev', req.body.title || '', req.body.body || '');
    return r2.ok ? res.json({ ok: true, url: r2.url }) : res.status(400).json({ error: r2.err || 'gh pr create failed' });
  });

  // --- Agent Manager: tickets + Claude Code agents (each a tmux session in a worktree) ---
  const aj = express.json({ limit: '256kb' });
  r.get('/agents/targets', (_req, res) => res.json({ targets: listTargets(cfg) }));
  r.get('/agents/metrics', async (_req, res) => res.json(await computeMetrics(cfg)));
  // ticket templates
  r.get('/agents/templates', async (_req, res) => res.json({ templates: await listTemplates(cfg) }));
  r.post('/agents/templates', aj, async (req, res) => res.json(await addTemplate(cfg, req.body || {})));
  r.delete('/agents/templates/:id', async (req, res) => res.json({ ok: await removeTemplate(cfg, req.params.id) }));
  // Claude-assisted backlog help
  r.post('/agents/advise', aj, async (req, res) => res.json(await adviseTickets(cfg, req.body?.project)));
  r.post('/agents/enhance', aj, async (req, res) => res.json(await enhanceTicketDraft(cfg, req.body || {})));
  // Plan an outcome into proposed tickets, then create them as a dependency-wired batch.
  r.post('/agents/plan', aj, async (req, res) => res.json(await planForProject(cfg, req.body || {})));
  r.post('/agents/plan-create', aj, async (req, res) => res.json(await createMany(cfg, req.body?.tickets)));
  // Plan-with-Claude: a live chat session that emits proposed tickets via plan-emit.
  // Baseline pre-flight: are the project's repos on a known-good start point
  // (app repos synced to origin/dev, sdks on the latest npmjs version)? Run before
  // starting a planner so the operator sees/clears WIP before planning.
  r.post('/planners/preflight', aj, async (req, res) => res.json(await preflightProject(cfg, req.body?.project)));
  // Streaming variant: emit the repo list up front, then one line per repo as its
  // check (git fetch + ahead/behind, maybe an npm lookup) finishes, so the UI can
  // show live per-repo progress instead of a frozen spinner.
  r.post('/planners/preflight-stream', aj, async (req, res) => {
    const { repos } = await scopedRepos(cfg, req.body?.project);
    res.setHeader('content-type', 'application/x-ndjson');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-accel-buffering', 'no'); // tell nginx not to buffer the stream
    const send = (o) => res.write(JSON.stringify(o) + '\n');
    send({ type: 'start', repos: repos.map((p) => ({ path: p, name: p.split('/').pop() })) });
    const results = [];
    await Promise.all(repos.map(async (p) => { const r = await checkRepo(p); results.push(r); send({ type: 'result', result: r }); }));
    send({ type: 'done', ok: !results.some((r) => r.status === 'block'), blocked: results.some((r) => r.status === 'block'), warned: results.some((r) => r.status === 'warn') });
    res.end();
  });
  r.get('/planners', async (_req, res) => res.json({ planners: (await listPlanners(cfg)).map(enrichPlanner) }));
  r.post('/planners', aj, async (req, res) => res.json(await createPlanner(cfg, req.body || {})));
  r.get('/planners/:id', async (req, res) => res.json(enrichPlanner(await getPlanner(cfg, req.params.id)) || { error: 'not found' }));
  r.post('/planners/:id/tickets', aj, async (req, res) => res.json({ ok: await setProposed(cfg, req.params.id, req.body?.tickets) }));
  r.post('/planners/:id/verify', aj, async (req, res) => res.json(await verifyPlanner(cfg, req.params.id, req.body?.tickets)));
  r.post('/planners/:id/plan', aj, async (req, res) => res.json(await setPlanName(cfg, req.params.id, req.body?.name)));
  r.post('/planners/:id/refine', aj, async (req, res) => res.json(await refineFromReview(cfg, req.params.id, req.body?.findings)));
  r.post('/planners/:id/create', aj, async (req, res) => res.json(await createFromPlanner(cfg, req.params.id, req.body?.tickets)));
  r.post('/planners/:id/build', aj, async (req, res) => {
    const p = await getPlanner(cfg, req.params.id);
    if (!p) return res.json({ error: 'not found' });
    if (p.building) return res.json({ building: true, note: 'already running', buildStatus: p.buildStatus });
    // Fire-and-forget: respond immediately, loop runs server-side
    buildAndValidate(cfg, req.params.id).catch((e) => console.error('[plan-build]', e));
    res.json({ building: true });
  });
  r.delete('/planners/:id', async (req, res) => res.json({ ok: await stopPlanner(cfg, req.params.id) }));
  // Rename an plan across all its tickets (from the board).
  r.post('/agents/plan/rename', aj, async (req, res) => res.json(await renamePlan(cfg, req.body?.from, req.body?.to)));
  // Archive or unarchive an plan (hidden from board by default, still queryable).
  r.post('/agents/plan/archive', aj, async (req, res) => res.json(await archivePlan(cfg, req.body?.planName, req.body?.archived !== false)));

  // --- Tool builder: catalog of MCP tools, install into a project, scaffold new ---
  r.get('/tools', async (_req, res) => res.json(await toolsCatalog(cfg)));
  r.post('/tools/install', aj, async (req, res) => res.json(await installTool(cfg, req.body || {})));
  r.post('/tools/uninstall', aj, async (req, res) => res.json(await uninstallTool(cfg, req.body || {})));
  r.post('/tools/scaffold', aj, async (req, res) => res.json(await scaffoldTool(cfg, req.body || {})));
  r.get('/agents', async (_req, res) => res.json({ tasks: await listAgents(cfg) }));
  r.post('/agents', aj, async (req, res) => res.json(await createTask(cfg, req.body || {})));
  r.post('/agents/:id/start', async (req, res) => res.json(await startTask(cfg, req.params.id)));
  r.get('/agents/:id/events', async (req, res) => res.json({ events: await listEvents(cfg, req.params.id) }));
  r.post('/agents/:id/links', aj, async (req, res) => res.json({ ok: await setLinks(cfg, req.params.id, req.body || {}) }));
  r.post('/agents/reorder', aj, async (req, res) => res.json({ ok: await reorderTickets(cfg, req.body?.ids) }));
  r.post('/agents/:id/stop', async (req, res) => { await stopAgent(cfg, req.params.id); res.json({ ok: true }); });
  r.delete('/agents/:id', async (req, res) => res.json({ ok: await removeTask(cfg, req.params.id) }));
  // operator gate actions (board -> agent)
  r.post('/agents/:id/approve', async (req, res) => res.json({ ok: await approveAgent(cfg, req.params.id) }));
  r.post('/agents/:id/reply', express.json({ limit: '64kb' }), async (req, res) =>
    res.json({ ok: await replyAgent(cfg, req.params.id, req.body.text) }));
  r.post('/agents/:id/accept', async (req, res) => res.json(await acceptAgent(cfg, req.params.id)));
  r.post('/agents/:id/plan-pr', async (req, res) => res.json(await openPlanPRForTask(cfg, req.params.id)));
  r.post('/agents/:id/plan-run', async (req, res) => res.json(await runPlan(cfg, req.params.id)));
  r.post('/agents/:id/plan-pause', async (req, res) => res.json(await pausePlan(cfg, req.params.id)));
  r.post('/agents/:id/plan-resume', async (req, res) => res.json(await resumePlan(cfg, req.params.id)));
  r.post('/agents/:id/chat', async (req, res) => res.json(await openTicketChat(cfg, req.params.id)));
  r.post('/agents/:id/discuss', async (req, res) => res.json(await discussTicket(cfg, req.params.id)));
  r.post('/agents/:id/plan-chat', async (req, res) => res.json(await openPlanChat(cfg, req.params.id)));
  r.post('/agents/:id/apply-local', async (req, res) => res.json(await applyPlanLocal(cfg, req.params.id)));
  r.post('/agents/:id/revert-local', async (req, res) => res.json(await revertPlanLocal(cfg, req.params.id)));
  r.post('/agents/:id/update', aj, async (req, res) => res.json(await updateTask(cfg, req.params.id, req.body || {})));
  // posted by Claude Code hooks running inside an agent (AGENT_TASK_ID set)
  r.post('/agents/:id/event', express.json({ limit: '64kb' }), async (req, res) =>
    res.json({ ok: await recordEvent(cfg, req.params.id, req.body.event, req.body.message) }));

  return r;
}
