# Workspace AI

Your dev environment, from any device.

A self-hosted browser workspace that keeps your terminals, editors, AI agents, and projects running — so you can pick up from your iPhone, iPad, or desktop without losing a thing.

## What it is

Workspace gives you a persistent, browser-based dev environment hosted on your own server. Close the tab, switch devices, go mobile — your sessions keep running and reconnect automatically.

- **Persistent terminals** — tmux-backed, survive browser close and reconnect from any device
- **Project groups** — organise terminals, editor, git, and tools by project directory
- **Embedded VS Code** — full editor in the browser with AI chat panel
- **Agent Manager** — kanban board for AI-powered planning and ticket-based agents
- **Works with any terminal tool** — Claude Code, Gemini CLI, Aider, or plain shell sessions
- **MCP Manager** — install and configure MCP servers per project
- **Image paste** — paste screenshots directly into the terminal
- **Private mesh friendly** — works with Tailscale, NetBird, ZeroTier, or a reverse proxy

## Requirements

The one-line installer bootstraps everything below on a bare box — you only need
`curl` and `sudo`:

- **Ubuntu/Debian or macOS** (also Amazon Linux/RHEL/Fedora/Arch/Alpine)
- Node.js 22+ and git — installed for you if missing (Node via nvm, no sudo)
- Postgres 14+ — the installer can run it in Docker
- tmux — installed for you if missing
- Claude Code (required for now) — `npm install -g @anthropic-ai/claude-code`, then `claude` to log in. The installer installs it; other agent CLIs work in terminals but the agent board targets Claude Code today.

## Quick start

One line — clones, installs dependencies, sets up Postgres in Docker, writes `.env`,
and walks you through the prompts (works on Ubuntu and macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/backvco/workspace/master/install.sh | bash
```

<details>
<summary>Or set it up manually</summary>

```bash
git clone https://github.com/backvco/workspace
cd workspace && npm install

# Install missing system tools (tmux, git). Add --docker-postgres to also install
# Docker (if needed) and run a Postgres container with a persistent named volume:
./bin/install-deps --docker-postgres

cp .env.example .env
# Edit .env — at minimum set WORKSPACE_DATABASE_URL and WORKSPACE_PROJECT_ROOTS.
# (Required values have no defaults; the server refuses to start without them.)
# WORKSPACE_DATABASE_URL=postgres://postgres:workspace@127.0.0.1:5432/workspace

# Terminal 1 — the API on :5301 (creates the DB schema on first start)
node server/index.js

# Terminal 2 — the UI on :5300 (proxies /api + /ws to the API)
npm run dev
# Open http://localhost:5300
```

On macOS the installer uses Homebrew (install it first) and Docker Desktop (launch
it before creating the database). On first start the API prints a pass/fail check of its
dependencies (tmux, git, agent CLI, Postgres) and stops if a required one is missing.

</details>

For production, build the UI (`npm run build`) and serve it with `node build`,
and run the API with `node server/index.js`. Put a reverse proxy in front that
routes `/api` and `/ws` to the API (:5301) and everything else to the UI — the
production `node build` serves the UI only and does **not** proxy the API itself
(that's what the dev server does). See the Caddy example below.

## Configuration

```env
# Required — no defaults
WORKSPACE_DATABASE_URL=postgresql://user:password@localhost:5432/workspace
WORKSPACE_PROJECT_ROOTS=/home/user/projects   # comma-separated roots to work under

# Optional
WORKSPACE_HOST=127.0.0.1
WORKSPACE_PORT=5301
WORKSPACE_TERM_CWD=/home/user                  # defaults to the first project root
WORKSPACE_DATA_DIR=/home/user/.workspace/data  # defaults to <app>/data
WORKSPACE_CLAUDE_BIN=claude                     # the agent CLI to drive
WORKSPACE_SESSION_KEY=                          # required only if you enable auth

# Optional embedded VS Code (code-server) — the "VS Code" tab is hidden until set.
# Runtime config (no rebuild). The wizard can install + gate it behind your login;
# or run `./bin/setup-code-server` and serve it at /code. See .env.example for the
# security notes (it shares the app's auth via the proxy's forward_auth).
WORKSPACE_CODE_SERVER_URL=
```

`.env.example` documents every variable.

## Authentication

Auth is **optional and off by default** — if you reach the server over a private
mesh or trusted network, you may not need it. To require a login, set
`WORKSPACE_SESSION_KEY` in `.env`, then turn auth on in **Settings**. The first
visit offers a one-time signup for the admin account; add more users from Settings.
Keep the server bound to localhost (the default) and front it with your own mesh,
proxy, or firewall.

## Connecting from other devices

> **HTTPS is required for anything other than `localhost`.** Image paste,
> clipboard sync, and installing the app to your home screen (PWA) only work in a
> browser **secure context** — that means HTTPS, or `http://localhost` on the same
> machine. Plain `http://<server-ip>` will load but those features silently fail.
> Use a private mesh that provides TLS, or a reverse proxy that terminates HTTPS
> (both below). Keep auth on if the server is reachable by anyone you don't trust.

The installer walks you through all of this (mesh + TLS); the pieces are also
available as standalone commands:

**Private mesh** — reach the server from your devices with no public ports. The
installer can set up Tailscale or NetBird (incl. a self-hosted NetBird management
URL + setup key + device name):

```bash
./bin/setup-mesh tailscale   # or: ./bin/setup-mesh netbird
```

**Tailscale HTTPS (simplest, no domain, nothing public)** — Tailscale issues the
cert through its own infra:

```bash
tailscale serve --bg 5300    # → https://<machine>.<tailnet>.ts.net
```

**A domain, fully private — DNS-01 (recommended for a mesh).** Let's Encrypt
validates via a DNS TXT record, so **no public ports** are needed and the domain's
A record can point straight at your mesh IP. Supported providers: Cloudflare,
Route53, Google Cloud DNS, DigitalOcean.

```bash
./bin/dns-credentials cloudflare your.domain   # get a least-privilege API token
./bin/setup-tls your.domain --dns cloudflare    # Caddy w/ DNS-01, auto-renewing
```

`bin/dns-credentials` auto-creates a scoped credential when the `aws`/`gcloud` CLI
is logged in, otherwise prints the exact least-privilege steps.

**A public domain — HTTP-01 (WARNING: exposes the server).** Only if the box has a public
IP with ports 80/443 open. This puts the server on the public internet, so keep
**auth on** and firewall :443 to your mesh CIDR:

```bash
./bin/setup-tls your.domain   # Caddy + Let's Encrypt over HTTP-01
```

**Or a public domain with automatic HTTPS (Caddy + Let's Encrypt)**

If you have a real domain pointed at the server with ports 80/443 open, one command
installs Caddy and serves HTTPS with auto-provisioned, auto-renewing Let's Encrypt
certificates:

```bash
./bin/setup-tls workspace.yourdomain.com
```

This runs the **production build**, not the vite dev server: serve the UI with
`node build` and the API with `node server/index.js`, and Caddy terminates TLS and
routes `/api` + `/ws` → :5301, everything else → the UI (the split vite does in dev):

```bash
node server/index.js                  # API on :5301
npm run build && PORT=3000 node build  # UI  on :3000
```

To keep both running across reboots, install them as background services
(systemd on Linux, LaunchDaemons on macOS):

```bash
./bin/setup-service          # creates + enables workspace-api and workspace-ui
```

The installer (`install.sh`) offers both the Caddy/HTTPS step and the boot
services. Under the hood the Caddy config is a tiny Caddyfile:

```
workspace.yourdomain.com {
    @api path /api/* /ws/*
    reverse_proxy @api localhost:5301
    reverse_proxy localhost:3000
}
```

**Already running nginx (or another proxy)?** Don't use `setup-tls` — it won't
fight your proxy for ports 80/443. Print a ready-to-paste config instead and use
your existing TLS (e.g. `certbot`):

```bash
./bin/print-proxy nginx workspace.yourdomain.com   # then: sudo certbot --nginx -d ...
```

The only requirement is routing `/api` + `/ws` (with WebSocket upgrade headers) to
:5301 and everything else to the production UI on :3000.

## Uninstall

```bash
./bin/uninstall
```

Interactive and non-destructive by default — it asks before each step and never
deletes your checkout, `.env`, or project files unless you opt in. It can remove the
background services (`workspace-api`, `workspace-ui`, `workspace-code-server`), our Caddy
drop-in (leaving any other sites a shared Caddy serves, and restoring its backup), the
DNS-01 credentials, code-server, and the Docker Postgres container (with a second
confirmation before deleting its data volume).

## Security

Workspace gives an authenticated user full shell-level access to the box (that's the
point — it's like SSH for each authorized person), so **authentication is the only
security boundary**. Enable auth (Settings, or `node bin/enable-auth.mjs`) whenever the
server is reachable by anyone you don't fully trust — the wizard does this by default
for remote setups. See [SECURITY.md](SECURITY.md) for the full model, the safe
defaults (loopback binds, fail-closed auth, the code-server gate), and an operator
hardening checklist.

## Architecture

```
browser
  └─ SvelteKit UI (:5300)
       ├─ proxies /api + /ws → workspace-api (:5301)
       │    ├─ WS /ws/term/<tab>  → node-pty → tmux session
       │    ├─ /api/tabs          → Postgres (tab state)
       │    ├─ /api/sessions      → list/kill tmux sessions
       │    └─ /api/paste         → save image + type path into terminal
       └─ "VS Code" tab           → iframes an external code-server (optional,
                                     VITE_CODE_SERVER_URL)
```

Browser close kills only the WebSocket client. The tmux session (and anything running in it) keeps going.

## License

[MIT](LICENSE) — [workspaceai.dev](https://workspaceai.dev)
