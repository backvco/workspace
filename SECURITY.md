# Security model

Workspace is a self-hosted tool for driving a CLI coding agent and shell from your
browser. **By design, an authenticated user can do anything a shell on the box can:**
run commands in the terminal, edit files, drive git, and launch the agent. That is the
product — it is the equivalent of giving each authorized person SSH access to the
machine. It is **not** a multi-tenant sandbox.

So the security model is simple and has exactly one perimeter:

> **Authentication is the only boundary. Treat the ability to log in as the ability to
> run a shell on the server. Only let people in who you would give SSH.**

Everything below documents how that perimeter is enforced, what the safe defaults are,
and what you — the operator — are responsible for.

---

## Trust model

- **Flat privileges.** Every authenticated user has the same full access (terminals,
  files, git, agent, user management, the auth toggle). There are no roles, and tabs /
  sessions are scoped per *project*, not per *user*. "Multiple users" means "several
  people you equally trust with the box," not isolation between them.
- **Authenticated == shell.** Findings like "a user can write a file outside a project
  root" or "run a command via the agent" are intended capability, not vulnerabilities —
  the user could do the same from the terminal. We do not try to sandbox an authed user
  from the host.
- **Unauthenticated == nothing.** When auth is enabled, an unauthenticated request can
  reach only the login/status endpoints. This is the boundary that must hold.

## Authentication

- **Optional, and OFF by default.** Auth is toggled in the in-app **Settings**. It is
  meant to be turned on whenever the server is reachable by anyone you don't fully trust.
  The setup wizard **enables it by default for any remote/exposed install** (creates your
  first user and turns it on); `node bin/enable-auth.mjs` does the same outside the wizard.
- **Passwords** are hashed with scrypt (16-byte random salt) and compared in constant
  time. Login runs the scrypt verify even for unknown usernames (against a dummy hash)
  so timing can't reveal which usernames exist. There is no password recovery — you
  manage users in Settings.
- **Passkeys (WebAuthn)** — optional Face ID / Touch ID / Windows Hello, enrolled per
  user in Settings. A login policy of `password`, `either`, `passkey`, or `both` (the
  last is password→passkey step-up 2FA) is stored server-side. The credential's private
  key never leaves your device; the server stores only the public key. Two requirements,
  both enforced by the WebAuthn standard and surfaced by `./bin/doctor`:
  - **HTTPS is required** (except on `localhost`), so passkeys depend on the TLS step.
  - A passkey is **bound to the host** (`rpID` = `WORKSPACE_PUBLIC_HOST`, else the
    request host) — set your domain *before* enrolling and keep it stable, or existing
    passkeys stop validating after a hostname change.
- **Sessions** are stateless, HMAC-SHA256–signed, `HttpOnly` cookies (`SameSite=Lax`,
  `Secure` when served over HTTPS), signed with `WORKSPACE_SESSION_KEY`. They carry only
  `{uid, name, exp}` — no secret is embedded. TTL is 30 days.
- **Fails closed.** If the database is unreachable, auth keeps its last-known state and,
  before the first successful read (e.g. right after a restart), denies — a DB outage can
  never silently disable authentication.
- **Revocation.** Deleting a user invalidates their existing session on the next request
  (REST and the terminal WebSocket both re-check that the account still exists).
- **Key strength.** Enabling auth requires `WORKSPACE_SESSION_KEY` to be ≥32 chars
  (generate one with `openssl rand -hex 32`; the wizard does this for you). A weak/short
  key would let an attacker forge sessions offline, so it is refused.
- **CSRF / WebSocket.** State-changing requests are checked against an Origin allowlist;
  the cookie is `SameSite=Lax`. The terminal WebSocket upgrade verifies Origin **and** the
  session before attaching to a shell.
- **Internal token.** Local helpers (`bin/agent-report`, the tickets MCP) authenticate
  with a per-process random `x-workspace-token` (192-bit, never returned by any endpoint).
  A browser cannot set that header cross-site, so it is not externally replayable.

## Network architecture

The **reverse proxy is the only thing that should be publicly reachable.** Everything
the app runs binds to loopback:

| Component | Bind | Notes |
|---|---|---|
| API | `127.0.0.1:5301` | never exposed directly |
| UI (prod build) | `127.0.0.1:3000` | `HOST=127.0.0.1` in the systemd unit |
| Postgres (Docker) | `127.0.0.1:5432` | random password; not reachable off-box |
| code-server (optional) | `127.0.0.1:8080` | only reachable through the gated `/code` route |
| Reverse proxy (Caddy) | `:443` / your port | TLS termination + optional IP allowlist |

- **TLS** is Let's Encrypt via **DNS-01** (no public ports — ideal behind a private mesh)
  or **HTTP-01** (needs public 80/443). Certs auto-renew.
- **Private mesh** (Tailscale / NetBird) is the recommended way to reach the server with
  no public ports at all; point your domain's A record at the mesh IP and use DNS-01.
- **IP allowlist** (`setup-tls --allow <cidrs>`) restricts every route to those source IPs
  (matched on the real TCP peer, not a spoofable `X-Forwarded-For`); the ACME challenge
  stays open so renewals work.

## Embedded VS Code (code-server)

Optional. When enabled it is served **same-origin** at `/code` and gated by the app's own
login via the proxy's `forward_auth` to `/api/auth/check`:

- code-server binds to `127.0.0.1` only — it is unreachable except through the proxy.
- Every request (including its WebSocket) must carry a valid app session, or the proxy
  returns 401. It shares your user/pass — there is no second password to manage.
- The gate **fails closed**: if the API is down, the proxy 502s rather than exposing the
  editor.

Because code-server is a full editor **with an integrated terminal**, it is exactly as
powerful as the rest of the app — protect it the same way (i.e. enable auth).

## Secrets

- `WORKSPACE_SESSION_KEY` and `WORKSPACE_DATABASE_URL` live in `.env` (gitignored, never
  committed). DNS-01 provider credentials live in `/etc/caddy/dns.env` and the Google key
  in `/etc/caddy/gcp-dns.json`, both `chmod 600`, outside the repo.
- No endpoint returns secrets: `/api/config` exposes only non-sensitive settings (and a
  `hasSessionKey` boolean), `/api/auth/users` never returns password hashes, and server
  errors return a generic message (details are logged server-side, not sent to clients).
- Cloud credentials are minted least-privilege (zone-scoped IAM policy / custom DNS role),
  not broad admin tokens.

## Operator responsibilities (hardening checklist)

1. **Enable auth before exposing the server.** This is the whole perimeter. The wizard
   defaults it on for remote setups; if you set things up by hand, run
   `node bin/enable-auth.mjs`.
2. **Prefer a private mesh + DNS-01** so there are no public ports. If you must use
   HTTP-01 / a public domain, keep auth on and consider the `--allow` IP allowlist.
3. **Use a strong `WORKSPACE_SESSION_KEY`** (`openssl rand -hex 32`). Rotate it if it may
   have leaked — that invalidates all existing sessions.
4. **Don't expose Postgres or the raw `:3000`/`:5301` ports.** They bind to loopback by
   default; keep it that way and let the proxy be the only front door.
5. **Only create accounts for people you'd give SSH.** Every account is full access.
6. Run `./bin/doctor` to verify ports, the cert, and that auth is on.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue:

- Open a **private security advisory** on the GitHub repository
  (Security → "Report a vulnerability"), or
- email the maintainer.

Include reproduction steps and the impact. We'll acknowledge and work on a fix before any
public disclosure. Reports that an *authenticated* user can run commands / read or write
files on the host are expected behavior (see the trust model) and not vulnerabilities — we
are interested in anything that lets an **unauthenticated** party reach the app, bypass the
login, escape the reverse proxy/allowlist, or leak a secret.
