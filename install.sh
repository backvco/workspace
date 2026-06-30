#!/usr/bin/env bash
# Workspace one-line installer. Designed to be piped from curl:
#
#   curl -fsSL https://raw.githubusercontent.com/backvco/workspace/master/install.sh | bash
#
# Clones the repo, installs dependencies (tmux/git + optional Docker Postgres),
# writes a starter .env, and tells you how to launch. Prompts read from the
# terminal even when piped, so you can just follow along.
set -euo pipefail

REPO_URL="https://github.com/backvco/workspace"
BRANCH="master"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
ask() { # ask "<prompt>" "<default>" -> echoes the answer (default if blank/non-interactive)
  local p="$1" d="${2:-}" a=""
  if [ -r /dev/tty ]; then printf '%s' "$p" > /dev/tty; read -r a < /dev/tty || a=""; fi
  echo "${a:-$d}"
}
banner() { # W.ai wordmark: large W, small ai
  printf '\033[1;34m'
  cat <<'ART'
   __        __
   \ \      / /
    \ \ /\ / /
     \ V  V /
      \_/\_/  ai
ART
  printf '\033[0m\033[2m   Workspace AI  -  installer\033[0m\n'
}

banner

# --- detect a package manager (for installing git) ---
PKG_INSTALL=""
if   command -v apt-get >/dev/null 2>&1; then PKG_INSTALL="sudo apt-get install -y"
elif command -v dnf     >/dev/null 2>&1; then PKG_INSTALL="sudo dnf install -y"
elif command -v yum     >/dev/null 2>&1; then PKG_INSTALL="sudo yum install -y"
elif command -v pacman  >/dev/null 2>&1; then PKG_INSTALL="sudo pacman -S --noconfirm"
elif command -v apk     >/dev/null 2>&1; then PKG_INSTALL="sudo apk add"
elif command -v brew    >/dev/null 2>&1; then PKG_INSTALL="brew install"
fi

# --- bootstrap the installer's own prerequisites (git + Node 22) on a bare box ---
ensure_git() {
  have git && return 0
  say "Installing git..."
  [ -n "$PKG_INSTALL" ] && $PKG_INSTALL git || { echo "Could not install git automatically - install it and re-run."; exit 1; }
}
node_ok() { have node && [ "$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')" -ge 22 ] 2>/dev/null; }
ensure_node() {
  node_ok && return 0
  say "Installing Node.js 22 (via nvm - no sudo, works the same on Linux and macOS)..."
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  set +u  # nvm.sh references unset vars; don't let `set -u` abort on sourcing it
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm install 22 && nvm alias default 22 >/dev/null
  set -u
}

have curl || { echo "curl is required to run this installer."; exit 1; }
ensure_git
ensure_node
have npm || { echo "npm is missing even after installing Node - check your Node install."; exit 1; }

# --- clone (or reuse the current checkout) ---
if [ -f package.json ] && [ -f server/index.js ]; then
  say "Using the current directory ($(pwd))."
  # Refresh to the latest version so a re-run actually picks up fixes. .env is
  # gitignored, so reset --hard never touches your config.
  if [ -d .git ]; then
    case "$(git remote get-url origin 2>/dev/null || true)" in
      *backvco/workspace*)
        say "Updating to the latest version..."
        git fetch --depth 1 origin "$BRANCH" && git reset --hard FETCH_HEAD || true ;;
    esac
  fi
else
  DIR="$(ask 'Install directory [workspace]: ' workspace)"
  if [ -d "$DIR/.git" ]; then
    # Only refresh if it's actually a Workspace clone - never reset --hard a repo
    # we don't own. This handles a stale clone (incl. force-pushed history) so the
    # install.sh you're running matches the repo's bin/ scripts.
    existing_url="$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"
    case "$existing_url" in
      *backvco/workspace*)
        say "Updating existing Workspace clone at $DIR"
        git -C "$DIR" fetch --depth 1 origin "$BRANCH" && git -C "$DIR" reset --hard FETCH_HEAD ;;
      *)
        echo "$DIR already contains a different git repo (${existing_url:-no origin}). Choose another directory."; exit 1 ;;
    esac
  elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    echo "$DIR already exists and isn't empty (and isn't a Workspace clone). Choose a new/empty directory."; exit 1
  else
    say "Cloning $REPO_URL -> $DIR"
    git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$DIR"
  fi
  cd "$DIR"
fi

# System prerequisites first - includes a C/C++ toolchain, which the API's native
# module (node-pty) needs to compile during the server npm install below.
say "Installing system prerequisites..."
./bin/install-deps || true

say "Installing npm dependencies..."
npm install
# The API is a separate package (server/package.json: express, pg, ws, node-pty)
# and runs from server/, so its deps must be installed there too.
say "Installing server dependencies..."
( cd server && npm install )

# Everything interactive (system tools, Claude Code, Postgres, .env, mesh, TLS,
# boot services) is the Node setup wizard - this bash bootstrap only had to get
# git + Node + the repo in place.
say "Launching the setup wizard..."
node bin/setup.mjs
