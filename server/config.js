// Central config — the ONLY place with environment/host assumptions.
// To embed this module in another host app, override via env or by passing a
// partial config to installWorkspace(); nothing else changes.
//
// Machine-specific values have NO hardcoded defaults — they are read from the
// environment (a `.env` file in the app root, loaded below, or the real env).
// `validateConfig()` fails fast at boot if a required one is missing.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { parsePlugins } from './plugins/registry.js';

loadEnv(); // populate process.env from `.env` before we read it (real env still wins)

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Data dir defaults to <appRoot>/data (portable, not machine-specific).
const DATA_DIR = process.env.WORKSPACE_DATA_DIR || path.join(APP_ROOT, 'data');
// Project roots: REQUIRED, no default. Comma-separated absolute dirs.
const PROJECT_ROOTS = (process.env.WORKSPACE_PROJECT_ROOTS || '').split(',').map((s) => s.trim()).filter(Boolean);

export const defaultConfig = {
  // Network (standalone mode; ignored when mounted into a host app)
  host: process.env.WORKSPACE_HOST || '127.0.0.1',
  port: Number(process.env.WORKSPACE_PORT || 5301),

  // Where tab state + pasted images live, namespaced per workspace id
  dataDir: DATA_DIR,
  databaseUrl: process.env.WORKSPACE_DATABASE_URL || '',
  // Where pg_dump backups are written (chmod 600, gitignored). Defaults under data/.
  backupDir: process.env.WORKSPACE_BACKUP_DIR || path.join(DATA_DIR, 'backups'),
  workspaceDir: (wsId) => path.join(DATA_DIR, 'workspaces', wsId),
  clipboardDir: (wsId) => path.join(DATA_DIR, 'workspaces', wsId, 'clipboard'),

  // tmux session naming. Real session = `${sessionPrefix}${wsId}-${tabKey}`.
  // Prefix + wsId keep one user's sessions from colliding with another's.
  sessionPrefix: process.env.WORKSPACE_TMUX_PREFIX || 'ws_',

  // Roots scanned to offer projects / discover repos. REQUIRED via env.
  projectRoots: PROJECT_ROOTS,
  // Default working dir a fresh terminal opens in (falls back to the first root).
  termCwd: process.env.WORKSPACE_TERM_CWD || PROJECT_ROOTS[0] || '',

  // The agent CLI to drive (any CLI-based LLM, e.g. `claude`). Override via env.
  claudeBin: process.env.WORKSPACE_CLAUDE_BIN || 'claude',

  // Cross-site WebSocket hijacking defense: the terminal ws upgrade is rejected
  // unless the browser's Origin matches the request host, the public host, or an
  // entry here. Comma-separated extra hostnames allowed to connect.
  publicHost: process.env.WORKSPACE_PUBLIC_HOST || '',
  allowedOrigins: (process.env.WORKSPACE_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Optional embedded code-server (VS Code) URL. Runtime config (set in .env, no
  // rebuild). SECURITY: code-server is a SEPARATE service - this app's auth does
  // NOT protect it; secure it itself (see .env.example).
  codeServerUrl: process.env.WORKSPACE_CODE_SERVER_URL || '',

  // Optional auth. Disabled by default (set in the Settings tool); when enabled,
  // sessions are signed with WORKSPACE_SESSION_KEY (required to turn auth on).
  sessionKey: process.env.WORKSPACE_SESSION_KEY || '',
  // Per-process secret the server hands to the local agent CLIs it spawns so
  // their loopback API calls bypass auth (they have no user cookie).
  internalToken: process.env.WORKSPACE_API_TOKEN || crypto.randomBytes(24).toString('hex'),

  // Optional embedded plugins (external services embedded as tools + proxied).
  // Runtime config: WORKSPACE_PLUGINS='name|Label|http://host:port, ...'. Absent =>
  // the app behaves exactly as open-source, with no plugin surface. See
  // server/plugins/registry.js.
  plugins: parsePlugins(process.env.WORKSPACE_PLUGINS || ''),

  appRoot: APP_ROOT,
  // App bin dir (holds `agent-report`, the agent->board reporting tool). Prepended
  // to a spawned agent's PATH so it can call `agent-report` from any worktree.
  binDir: path.join(APP_ROOT, 'bin'),
  // Per-role default model (overridable per task). Routing = cost control.
  roleModels: {
    planner: 'opus', reviewer: 'opus', architect: 'opus',
    implementer: 'sonnet', '': 'sonnet', writer: 'sonnet',
    triage: 'haiku'
  },
  // Permission profiles (allow/deny policy files) a spawned agent runs under.
  // Per-agent choice; default is "guarded" (autonomy + deny catastrophic cmds).
  agentPermDir: path.join(APP_ROOT, 'server', 'perms'),
  agentPermissions: ['guarded', 'full', 'strict'],
  defaultAgentPermission: process.env.WORKSPACE_AGENT_PERMISSION || 'guarded',

  // Plan verifier (server/plan-review.js) knobs. It runs a headless `claude -p`
  // read-only review in a throwaway worktree of origin/<base>.
  verifierPermFile: path.join(APP_ROOT, 'server', 'perms', 'verifier.json'),
  verifierMaxTurns: Number(process.env.WORKSPACE_VERIFY_MAX_TURNS || 80), // headroom for multi-repo reads
  // Liveness timeouts (see claude-run.js): kill only after this long with NO output
  // (stuck), not on a fixed deadline. capMs is a generous absolute backstop.
  verifierIdleMs: Number(process.env.WORKSPACE_VERIFY_IDLE_MS || 180000), // 3 min of silence
  verifierCapMs: Number(process.env.WORKSPACE_VERIFY_CAP_MS || 1800000), // 30 min backstop
  // Reused verify worktrees (.agent-worktrees/verify-<repo>) are kept between runs
  // for speed, then garbage-collected once idle this long.
  verifyWorktreeTtlMs: Number(process.env.WORKSPACE_VERIFY_WT_TTL_MS || 7200000), // 2h idle
  worktreeGcIntervalMs: Number(process.env.WORKSPACE_WT_GC_INTERVAL_MS || 3600000), // hourly sweep

  // Idle agent-session reaper (server/agent-reaper.js). Agent/chat/planner tmux
  // sessions are only torn down on explicit accept/delete, so a finished or stalled
  // agent parks at a prompt forever holding its claude process + MCP servers. The
  // reaper kills sessions with no tmux activity for longer than this TTL. Nothing is
  // lost: each ticket has a durable claudeSessionId + Postgres state, so reopening a
  // chat just --resumes it. A session actively streaming output ("esc to interrupt")
  // is never reaped regardless of the timer.
  agentIdleReapMs: Number(process.env.WORKSPACE_AGENT_IDLE_REAP_MS || 1800000), // 30 min idle
  agentReapIntervalMs: Number(process.env.WORKSPACE_AGENT_REAP_INTERVAL_MS || 300000), // 5 min sweep

  // Auto-reviewer (server/agent-review.js) knobs. A headless `claude -p` judges a
  // finished agent's diff. Needs real headroom — a too-short timeout produced empty
  // output that silently defaulted to ISSUES and stalled autonomous accepts.
  reviewMaxTurns: Number(process.env.WORKSPACE_REVIEW_MAX_TURNS || 60),
  reviewIdleMs: Number(process.env.WORKSPACE_REVIEW_IDLE_MS || 150000), // 2.5 min of silence
  reviewCapMs: Number(process.env.WORKSPACE_REVIEW_CAP_MS || 1500000), // 25 min backstop
  // Sonnet by default: the auto-reviewer is an every-ticket autonomous gate, so
  // speed matters (opus was slow enough to time out and stall accepts), and it only
  // gates landing onto the plan branch — the final PR review is the real backstop.
  reviewModel: process.env.WORKSPACE_REVIEW_MODEL || 'sonnet',

  // Resolve which project (workspace) a request belongs to — from a header the
  // UI sets to the active project. Everything namespaces by this (tabs, sessions,
  // paste). A host app can override to fold in an authenticated user id.
  resolveWorkspaceId: (req) => (req && req.headers && req.headers['x-workspace-project']) || 'default',

  maxUploadBytes: 30 * 1024 * 1024
};

// Fail fast at boot if a required machine-specific value is missing. Called by
// the standalone host (server/index.js); embedding hosts that pass overrides can
// call it too. Throws with a clear, actionable message listing what to set.
export function validateConfig(cfg) {
  const missing = [];
  if (!cfg.databaseUrl) missing.push('WORKSPACE_DATABASE_URL (Postgres connection string)');
  if (!cfg.projectRoots || cfg.projectRoots.length === 0) missing.push('WORKSPACE_PROJECT_ROOTS (comma-separated absolute project directories)');
  if (!cfg.termCwd) missing.push('WORKSPACE_TERM_CWD (or a non-empty WORKSPACE_PROJECT_ROOTS to default from)');
  if (missing.length) {
    throw new Error(
      'Missing required configuration. Set these in your .env (see .env.example):\n  - ' +
      missing.join('\n  - ')
    );
  }
}

// Build the real tmux session name for a workspace + tab.
export function sessionName(cfg, wsId, tabKey) {
  return `${cfg.sessionPrefix}${wsId}-${tabKey}`.replace(/[^\w-]/g, '_');
}
