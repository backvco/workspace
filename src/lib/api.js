// Thin REST client. Method names map 1:1 onto workspace-api routes.
import { apiUrl } from './config.js';
import { getActiveProject } from './session.js';

/** @param {string} path @param {RequestInit} [opts] */
async function json(path, opts = {}) {
  // Scope every request to the active project.
  const headers = { 'x-workspace-project': getActiveProject(), ...(opts.headers || {}) };
  const res = await fetch(apiUrl(path), { ...opts, headers });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// Like json() but returns the parsed body on BOTH success and error responses
// (so callers can surface `{ error }` messages, e.g. login failures) instead of
// throwing on a non-2xx status.
/** @param {string} path @param {RequestInit} [opts] */
async function jsonSafe(path, opts = {}) {
  const headers = { 'x-workspace-project': getActiveProject(), ...(opts.headers || {}) };
  try {
    const res = await fetch(apiUrl(path), { ...opts, headers });
    return await res.json();
  } catch (e) { return { error: String(/** @type {any} */ (e)?.message || e) }; }
}

export const api = {
  stats: () => json('/api/stats'),

  // --- self-update (workspace's own checkout) ---
  version: () => json('/api/version'),
  selfUpdate: () => json('/api/update', { method: 'POST' }),

  // --- clipboard explorer (pasted images, per workspace) ---
  clipboardList: () => json('/api/clipboard'),
  /** @param {string} name URL to the pasted image for the active project. */
  clipboardFileUrl: (name) => apiUrl(`/api/clipboard/file?ws=${encodeURIComponent(getActiveProject())}&name=${encodeURIComponent(name)}`),
  /** @param {{all?:boolean, olderThanMs?:number|null, name?:string}} body */
  clipboardPrune: (body) => json('/api/clipboard', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),

  // --- database backups ---
  backups: () => json('/api/backups'),
  backupCreate: () => jsonSafe('/api/backups', { method: 'POST' }),
  backupDelete: (/** @type {string} */ name) => json(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  backupDownloadUrl: (/** @type {string} */ name) => apiUrl(`/api/backups/${encodeURIComponent(name)}/download`),
  /** @param {{schedule?:string, retention?:number}} body */
  backupConfig: (body) => jsonSafe('/api/backups/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  backupRestore: (/** @type {string} */ name) => jsonSafe('/api/backups/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, confirm: name }) }),

  // --- idle agent-session reaper (GC settings + live sessions) ---
  reaper: () => json('/api/reaper'),
  /** @param {{enabled?:boolean, idleMs?:number, intervalMs?:number}} body */
  reaperConfig: (body) => jsonSafe('/api/reaper/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  reaperSweep: () => jsonSafe('/api/reaper/sweep', { method: 'POST' }),
  reaperKill: (/** @type {string} */ name) => jsonSafe(`/api/reaper/sessions/${encodeURIComponent(name)}/kill`, { method: 'POST' }),

  // --- auth + settings ---
  authStatus: () => json('/api/auth/status'),
  /** @param {string} username @param {string} password */
  /** @param {string} username @param {string} password @param {string} [enrollCode] */
  authLogin: (username, password, enrollCode) => jsonSafe('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, enrollCode }) }),
  /** @param {string} username @param {string} password */
  authSignup: (username, password) => jsonSafe('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }),
  authLogout: () => jsonSafe('/api/auth/logout', { method: 'POST' }),
  authUsers: () => json('/api/auth/users'),
  /** @param {string} username @param {string} password */
  authAddUser: (username, password) => jsonSafe('/api/auth/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }),
  /** @param {string} id */
  authRemoveUser: (id) => jsonSafe(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** @param {string} id @param {{name?:string,email?:string}} profile */
  authUpdateUser: (id, profile) => jsonSafe(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) }),
  /** @param {string} id @param {string} password */
  authSetPassword: (id, password) => jsonSafe(`/api/auth/users/${encodeURIComponent(id)}/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) }),
  /** @param {string} id */
  userPasskeys: (id) => json(`/api/auth/users/${encodeURIComponent(id)}/passkeys`),
  /** @param {string} id @param {string} credId */
  userRemovePasskey: (id, credId) => jsonSafe(`/api/auth/users/${encodeURIComponent(id)}/passkeys/${encodeURIComponent(credId)}`, { method: 'DELETE' }),
  /** @param {boolean} enabled */
  authSetEnabled: (enabled) => jsonSafe('/api/auth/enabled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }),

  // --- passkeys (WebAuthn) ---
  /** @param {string} policy */
  passkeySetPolicy: (policy) => jsonSafe('/api/auth/passkey/policy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy }) }),
  /** @param {string} id */
  passkeyResetUser: (id) => jsonSafe(`/api/auth/passkey/reset/${encodeURIComponent(id)}`, { method: 'POST' }),
  /** @param {string} id */
  passkeyEnrollCode: (id) => jsonSafe(`/api/auth/passkey/enroll-code/${encodeURIComponent(id)}`, { method: 'POST' }),
  /** @param {string} id */
  passkeyEnrollCodeStatus: (id) => jsonSafe(`/api/auth/passkey/enroll-code/${encodeURIComponent(id)}`),
  /** @param {string} id */
  passkeyRevokeEnrollCode: (id) => jsonSafe(`/api/auth/passkey/enroll-code/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  passkeyCredentials: () => json('/api/auth/passkey/credentials'),
  /** @param {string} id */
  passkeyRemove: (id) => jsonSafe(`/api/auth/passkey/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  passkeyRegisterOptions: () => jsonSafe('/api/auth/passkey/register-options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  /** @param {object} body */
  passkeyRegisterVerify: (body) => jsonSafe('/api/auth/passkey/register-verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  passkeyLoginOptions: () => jsonSafe('/api/auth/passkey/login-options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  /** @param {object} body */
  passkeyLoginVerify: (body) => jsonSafe('/api/auth/passkey/login-verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),

  serverConfig: () => json('/api/config'),
  roots: () => json('/api/roots'),

  // --- projects ---
  projects: () => json('/api/projects'),
  /** @param {string} root */
  availableFolders: (root) => json(`/api/projects/available?root=${encodeURIComponent(root)}`),
  /** @param {object} body */
  addProject: (body) => json('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {string} id */
  removeProject: (id) => json(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- Agent Manager ---
  agentTargets: () => json('/api/agents/targets'),
  agentList: () => json('/api/agents'),
  /** @param {object} body */
  agentCreate: (body) =>
    json('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {string} id */
  agentStop: (id) => json(`/api/agents/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  /** @param {string} id @param {string} event */
  /** @param {string} id @param {string} event @param {string} [message] */
  agentEvent: (id, event, message) =>
    json(`/api/agents/${encodeURIComponent(id)}/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, message }) }),
  /** @param {string} id */
  agentRemove: (id) => json(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** @param {string} id */
  agentApprove: (id) => json(`/api/agents/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  /** @param {string} id @param {string} text */
  agentReply: (id, text) =>
    json(`/api/agents/${encodeURIComponent(id)}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }),
  /** @param {string} id */
  agentAccept: (id) => json(`/api/agents/${encodeURIComponent(id)}/accept`, { method: 'POST' }),
  /** @param {string} id */
  agentPlanPR: (id) => json(`/api/agents/${encodeURIComponent(id)}/plan-pr`, { method: 'POST' }),
  /** @param {string} id */
  agentPlanRun: (id) => json(`/api/agents/${encodeURIComponent(id)}/plan-run`, { method: 'POST' }),
  /** @param {string} id */
  agentPlanPause: (id) => json(`/api/agents/${encodeURIComponent(id)}/plan-pause`, { method: 'POST' }),
  /** @param {string} id */
  agentPlanResume: (id) => json(`/api/agents/${encodeURIComponent(id)}/plan-resume`, { method: 'POST' }),
  /** @param {string} id */
  agentChat: (id) => json(`/api/agents/${encodeURIComponent(id)}/chat`, { method: 'POST' }),
  /** @param {string} id — open the ticket chat seeded to talk through the review findings */
  agentDiscuss: (id) => json(`/api/agents/${encodeURIComponent(id)}/discuss`, { method: 'POST' }),
  /** @param {string} id — open ONE chat about the whole plan (review/test the completed work) */
  agentPlanChat: (id) => json(`/api/agents/${encodeURIComponent(id)}/plan-chat`, { method: 'POST' }),
  /** @param {string} id — check out the plan's branches into the live repos to test locally */
  agentPlanApplyLocal: (id) => json(`/api/agents/${encodeURIComponent(id)}/apply-local`, { method: 'POST' }),
  /** @param {string} id — restore the plan's repos to their base branch */
  agentPlanRevertLocal: (id) => json(`/api/agents/${encodeURIComponent(id)}/revert-local`, { method: 'POST' }),
  /** @param {string} id @param {Record<string,string>} patch */
  agentUpdate: (id, patch) => json(`/api/agents/${encodeURIComponent(id)}/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  /** @param {string} id */
  agentStart: (id) => json(`/api/agents/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  /** @param {string} id */
  agentEvents: (id) => json(`/api/agents/${encodeURIComponent(id)}/events`),
  /** @param {string} id @param {{blockedBy?:string[], links?:string[], autoStart?:boolean, autoReview?:boolean, autonomous?:boolean}} body */
  agentLinks: (id, body) =>
    json(`/api/agents/${encodeURIComponent(id)}/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {string[]} ids — a column's new order */
  agentReorder: (ids) => json('/api/agents/reorder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) }),
  agentMetrics: () => json('/api/agents/metrics'),
  agentTemplates: () => json('/api/agents/templates'),
  /** @param {object} body */
  agentTemplateAdd: (body) =>
    json('/api/agents/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {string} id */
  agentTemplateRemove: (id) => json(`/api/agents/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** @param {string} [project] */
  agentAdvise: (project) =>
    json('/api/agents/advise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) }),
  /** @param {object} body */
  agentEnhance: (body) =>
    json('/api/agents/enhance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {{goal:string, project?:string, dir?:string}} body */
  agentPlan: (body) =>
    json('/api/agents/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {any[]} tickets */
  agentPlanCreate: (tickets) =>
    json('/api/agents/plan-create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tickets }) }),
  plannerList: () => json('/api/planners'),
  /** @param {string} [project] */
  plannerPreflight: (project) =>
    json('/api/planners/preflight', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) }),
  /** Stream the pre-flight check, calling onEvent for each NDJSON line
   * ({type:'start'|'result'|'done', ...}). @param {string|undefined} project @param {(e:any)=>void} onEvent */
  plannerPreflightStream: async (project, onEvent) => {
    const res = await fetch(apiUrl('/api/planners/preflight-stream'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-project': getActiveProject() },
      body: JSON.stringify({ project })
    });
    if (!res.ok || !res.body) throw new Error(`preflight-stream -> ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { onEvent(JSON.parse(line)); } catch {} }
      }
    }
  },
  /** @param {{project?:string, goal?:string, override?:boolean}} body */
  plannerCreate: (body) =>
    json('/api/planners', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {string} id */
  plannerGet: (id) => json(`/api/planners/${encodeURIComponent(id)}`),
  /** @param {string} id @param {string} name */
  plannerSetPlan: (id, name) =>
    json(`/api/planners/${encodeURIComponent(id)}/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  /** @param {string} from @param {string} to */
  agentRenamePlan: (from, to) =>
    json('/api/agents/plan/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) }),
  /** @param {string} planName @param {boolean} [archived] */
  agentArchivePlan: (planName, archived = true) =>
    json('/api/agents/plan/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planName, archived }) }),
  /** @param {string} id @param {any[]} findings */
  plannerRefine: (id, findings) =>
    json(`/api/planners/${encodeURIComponent(id)}/refine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ findings }) }),
  /** @param {string} id @param {any[]} [tickets] */
  plannerVerify: (id, tickets) =>
    json(`/api/planners/${encodeURIComponent(id)}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tickets }) }),
  /** @param {string} id @param {any[]} [tickets] @param {boolean} [override] */
  plannerCreateAll: (id, tickets, override) =>
    json(`/api/planners/${encodeURIComponent(id)}/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tickets, override }) }),
  /** @param {string} id */
  plannerBuild: (id) =>
    json(`/api/planners/${encodeURIComponent(id)}/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  /** @param {string} id */
  plannerStop: (id) => json(`/api/planners/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  toolsCatalog: () => json('/api/tools'),
  /** @param {{tool:string, project:string}} body */
  toolInstall: (body) => json('/api/tools/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {{tool:string, project:string}} body */
  toolUninstall: (body) => json('/api/tools/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {{name:string, description:string}} body */
  toolScaffold: (body) => json('/api/tools/scaffold', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  tabCounts: () => json('/api/tabs/counts'),
  getTabs: () => json('/api/tabs'),
  /** @param {object} state @param {string} [project] explicit target namespace (defaults to the active project) */
  putTabs: (state, project) =>
    json('/api/tabs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(project ? { 'x-workspace-project': project } : {}) },
      body: JSON.stringify(state)
    }),
  /** @param {string} tabId @param {string} toProject */
  tabMove: (tabId, toProject) =>
    json('/api/tabs/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tabId, toProject }) }),
  listSessions: () => json('/api/sessions'),
  /** @param {string} tabKey */
  killSession: (tabKey) => json(`/api/sessions/${encodeURIComponent(tabKey)}/kill`, { method: 'POST' }),

  // --- MCP management ---
  mcpGlobal: () => json('/api/mcp/global'),
  mcpProjects: () => json('/api/mcp/projects'),
  /** @param {string} p */
  mcpProject: (p) => json(`/api/mcp/project?path=${encodeURIComponent(p)}`),
  /** @param {object} body */
  mcpAdd: (body) =>
    json('/api/mcp/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {object} body */
  mcpRemove: (body) =>
    json('/api/mcp/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** @param {object} body */
  mcpMove: (body) =>
    json('/api/mcp/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),

  // --- Files ---
  /** @param {string} path */
  fsList: (path) => json(`/api/fs/list?path=${encodeURIComponent(path)}`),
  /** @param {string} path */
  fsRead: (path) => json(`/api/fs/read?path=${encodeURIComponent(path)}`),
  /** @param {string} path @param {string} content */
  fsWrite: (path, content) =>
    json('/api/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content }) }),

  // --- Changes (git) ---
  gitRepos: () => json('/api/git/repos'),
  /** @param {string} repo */
  gitStatus: (repo) => json(`/api/git/status?repo=${encodeURIComponent(repo)}`),
  /** @param {string} repo @param {string} file */
  gitDiff: (repo, file) => json(`/api/git/diff?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(file)}`),
  /** @param {string} repo */
  gitBranches: (repo) => json(`/api/git/branches?repo=${encodeURIComponent(repo)}`),
  /** @param {string} repo @param {string} ref */
  gitCompare: (repo, ref) => json(`/api/git/compare?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`),
  /** @param {string} repo @param {string} base @param {string} ref @param {string} file */
  gitRefDiff: (repo, base, ref, file) =>
    json(`/api/git/refdiff?repo=${encodeURIComponent(repo)}&base=${encodeURIComponent(base)}&ref=${encodeURIComponent(ref)}&file=${encodeURIComponent(file)}`),
  /** @param {string} path @param {object} body */
  gitPost: (path, body) =>
    json(`/api/git/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
};
