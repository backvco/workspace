# shellcheck shell=bash
# bin/lib/service.sh - cross-platform background-service helpers (systemd on
# Linux, LaunchDaemons on macOS). Source this; don't execute it.
#
# Naming: a systemd unit "workspace-api" maps 1:1 to launchd label
# "com.workspace.api" (strip the "workspace-" prefix, prepend "com.workspace.").
# Same scheme for ui/code-server/caddy.
#
# LaunchDaemons (not LaunchAgents): root-installed under /Library/LaunchDaemons,
# they start at boot independent of any GUI login - the correct analog to a
# systemd system service for a headless/always-on Mac reached over SSH. They run
# as UserName="$1" (the installing user), not a dedicated system account, mirroring
# how workspace-api.service already runs as the installing user rather than a
# dedicated one.
#
# launchd has no journalctl equivalent, so logs go to plain files under
# ~/Library/Logs/Workspace/<x>.log that callers (doctor, uninstall) can tail.

os_is_mac() { [ "$(uname -s)" = "Darwin" ]; }

# workspace-api -> com.workspace.api
svc_label() { printf 'com.workspace.%s\n' "${1#workspace-}"; }
svc_plist_path() { printf '/Library/LaunchDaemons/%s.plist\n' "$(svc_label "$1")"; }
svc_log_dir() { printf '%s/Library/Logs/Workspace\n' "$HOME"; }

# svc_install_launchd <unit> <user> <workdir> <env_kv_lines> <pre_check_or_empty> <program> [arg ...]
# Installs + starts a macOS LaunchDaemon. <env_kv_lines> is a newline-separated
# list of KEY=VALUE pairs (must include PATH - launchd jobs get a minimal one
# otherwise). <pre_check_or_empty> is a shell snippet run before <program>
# (launchd has no ExecStartPre) - pass "" for none. Linux callers keep writing
# their own systemd unit (too much per-unit detail, e.g. env files, to
# generalize) and use `svc_restart`/`svc_remove` for the rest.
svc_install_launchd() {
  local unit="$1" user="$2" workdir="$3" env_kv="$4" pre="$5"
  shift 5
  local label plist logdir env_xml k v
  label="$(svc_label "$unit")"
  plist="$(svc_plist_path "$unit")"
  logdir="$(svc_log_dir)"
  mkdir -p "$logdir" 2>/dev/null || sudo mkdir -p "$logdir"
  sudo chown "$user" "$logdir" 2>/dev/null || true

  # ProgramArguments as a /bin/sh -c wrapper: gives us an optional pre-check
  # (launchd has no ExecStartPre) and lets us keep ARGS as one shell-quoted string.
  local cmd="$*"
  [ -n "$pre" ] && cmd="$pre && exec $cmd" || cmd="exec $cmd"

  env_xml=""
  while IFS='=' read -r k v; do
    [ -n "$k" ] || continue
    v="${v//&/&amp;}"; v="${v//</&lt;}"; v="${v//>/&gt;}"
    env_xml="${env_xml}    <key>${k}</key><string>${v}</string>
"
  done <<< "$env_kv"

  sudo tee "$plist" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>UserName</key><string>${user}</string>
  <key>WorkingDirectory</key><string>${workdir}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env_xml}  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${cmd}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logdir}/${unit#workspace-}.log</string>
  <key>StandardErrorPath</key><string>${logdir}/${unit#workspace-}.log</string>
</dict>
</plist>
PLIST
  sudo chown root:wheel "$plist"
  sudo chmod 644 "$plist"
  # bootstrap fails if already loaded - bootout first so re-running this is idempotent.
  sudo launchctl bootout "system/${label}" >/dev/null 2>&1 || true
  sudo launchctl bootstrap system "$plist"
  sudo launchctl enable "system/${label}"
  sudo launchctl kickstart -k "system/${label}"
}

# svc_restart <unit> - restart a running service, same name on both platforms.
svc_restart() {
  local unit="$1"
  if os_is_mac; then
    sudo launchctl kickstart -k "system/$(svc_label "$unit")"
  else
    sudo systemctl restart "$unit"
  fi
}

# svc_status <unit> - 0 if active/running.
svc_status() {
  local unit="$1"
  if os_is_mac; then
    sudo launchctl print "system/$(svc_label "$unit")" >/dev/null 2>&1
  else
    systemctl is-active --quiet "$unit" 2>/dev/null
  fi
}

# svc_exists <unit> - 0 if installed (plist present / unit file present).
svc_exists() {
  local unit="$1"
  if os_is_mac; then
    [ -f "$(svc_plist_path "$unit")" ]
  else
    systemctl list-unit-files 2>/dev/null | grep -q "^${unit}.service"
  fi
}

# svc_remove <unit> - stop + uninstall, both platforms.
svc_remove() {
  local unit="$1"
  if os_is_mac; then
    local label plist; label="$(svc_label "$unit")"; plist="$(svc_plist_path "$unit")"
    sudo launchctl bootout "system/${label}" >/dev/null 2>&1 || true
    sudo rm -f "$plist"
  else
    sudo systemctl disable --now "${unit}.service" 2>/dev/null
    sudo rm -f "/etc/systemd/system/${unit}.service"
  fi
}

# svc_log_hint <unit> - human-readable "where to look for logs" string.
svc_log_hint() {
  local unit="$1"
  if os_is_mac; then
    printf 'tail -f %s/%s.log' "$(svc_log_dir)" "${unit#workspace-}"
  else
    printf 'journalctl -u %s -f' "$unit"
  fi
}

# port_listening <port> - 0 if something is listening on that TCP port.
# lsof exists on both Linux and macOS, unlike `ss` (Linux-only) - this is a
# cross-platform replacement, not an os_is_mac() branch.
port_listening() {
  local port="$1"
  command -v lsof >/dev/null 2>&1 && sudo lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

# port_listener_name <port> - process name of whatever's listening, or empty.
port_listener_name() {
  local port="$1"
  command -v lsof >/dev/null 2>&1 && sudo lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1}'
}

# proc_listen_addr <process_name> - 127.0.0.1:<port> for the first LOOPBACK TCP
# listener whose command name matches (any port, not just one you already guessed).
proc_listen_addr() {
  local name="$1"
  command -v lsof >/dev/null 2>&1 || return 0
  sudo lsof -nP -iTCP -sTCP:LISTEN -c "$name" 2>/dev/null | awk 'NR>1{print $9}' | grep -m1 '^127\.0\.0\.1:[0-9]*$'
}
