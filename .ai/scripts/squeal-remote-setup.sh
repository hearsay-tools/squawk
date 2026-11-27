#!/bin/sh
# Squeal `remote.setup` script for Squawk (hearsay-tools/squawk#4367).
# Runs on each remote machine after files arrive and before dependency install.
# Ensures the pinned agent-browser binary matches `.ai/scripts/test-env.inputs.json`,
# installs Google Chrome Stable when missing and root/passwordless sudo is available,
# and verifies headless Chrome launch cleanly.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
INPUTS_SCRIPT="$SCRIPT_DIR/test-env-inputs.mjs"
LAUNCH_SCRIPT="$SCRIPT_DIR/resolve-browser-launch.mjs"

log() { echo "[squeal-remote-setup] $*" >&2; }

INPUTS=$(node "$INPUTS_SCRIPT" describe "$REPO_ROOT")
BROWSER_PIN=$(printf '%s' "$INPUTS" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).agentBrowserVersion)')

browser_version() {
  "$1" --version 2>/dev/null | node "$INPUTS_SCRIPT" version-of
}

resolve_asset() {
  os=$(uname -s 2>/dev/null || echo unknown)
  arch=$(uname -m 2>/dev/null || echo unknown)
  case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) arch=unsupported ;; esac
  case "$os" in
    Darwin) printf 'agent-browser-darwin-%s' "$arch" ;;
    Linux)
      libc=linux
      (ldd --version 2>&1 || true) | grep -qi musl && libc=linux-musl
      printf 'agent-browser-%s-%s' "$libc" "$arch"
      ;;
    *) printf 'unsupported' ;;
  esac
}

ensure_pinned_agent_browser() {
  if command -v agent-browser >/dev/null 2>&1; then
    on_path=$(command -v agent-browser)
    found=$(browser_version "$on_path" || true)
    if [ "$found" = "$BROWSER_PIN" ]; then
      BROWSER_BIN=$on_path
      return 0
    fi
    log "agent-browser on PATH is ${found:-unknown}, not pinned $BROWSER_PIN; using cache"
  fi
  asset=$(resolve_asset)
  case "$asset" in
    *unsupported*) log "unsupported platform for agent-browser ($asset)"; return 1 ;;
  esac
  CACHE_ROOT=${XDG_CACHE_HOME:-"$HOME/.cache"}
  BROWSER_BIN=$(node -e '
    const path = require("node:path");
    const fs = require("node:fs");
    const dir = path.join(process.argv[1], "agent-tools", "agent-browser", process.argv[2]);
    fs.mkdirSync(dir, { recursive: true });
    process.stdout.write(path.join(dir, process.argv[3]));
  ' "$CACHE_ROOT" "$BROWSER_PIN" "$asset")
  if [ ! -x "$BROWSER_BIN" ]; then
    url="https://github.com/vercel-labs/agent-browser/releases/download/v${BROWSER_PIN}/${asset}"
    tmp="${BROWSER_BIN}.tmp.$$"
    log "downloading pinned agent-browser $BROWSER_PIN ($asset)"
    if command -v curl >/dev/null 2>&1; then
      curl -fL --retry 3 --connect-timeout 30 --max-time 300 -o "$tmp" "$url"
    elif command -v wget >/dev/null 2>&1; then
      wget -T 30 -t 3 -O "$tmp" "$url"
    else
      log "no curl or wget available to download agent-browser"
      return 1
    fi
    chmod 755 "$tmp"
    mv "$tmp" "$BROWSER_BIN"
  fi
  found=$(browser_version "$BROWSER_BIN" || true)
  if [ "$found" != "$BROWSER_PIN" ]; then
    log "downloaded agent-browser reported ${found:-unknown}, expected $BROWSER_PIN"
    return 1
  fi
}

can_elevate() {
  [ "$(id -u)" = 0 ] && return 0
  command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null
}

run_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

install_chrome_linux() {
  [ "$(uname -s 2>/dev/null || true)" = Linux ] || return 1
  command -v apt-get >/dev/null 2>&1 || return 1
  can_elevate || return 1
  log "installing google-chrome-stable via apt"
  run_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg fonts-liberation
  run_root install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | run_root gpg --dearmor --yes -o /usr/share/keyrings/google-chrome.gpg
  printf 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main\n' \
    | run_root tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
  run_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends google-chrome-stable
  run_root rm -rf /var/lib/apt/lists/*
}

probe_headless_chrome() {
  launch_args=$(node "$LAUNCH_SCRIPT" 2>/dev/null | node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
      process.stdout.write(Array.isArray(j.launchArgs) ? j.launchArgs.join(",") : "");
    } catch {}
  ' || true)
  try_probe() {
    args_csv=$1
    session="squeal-setup-probe-$$"
    if [ -n "$args_csv" ]; then
      out=$(TMPDIR=/tmp TMP=/tmp TEMP=/tmp "$BROWSER_BIN" --args "$args_csv" --session "$session" open about:blank --json 2>/dev/null || true)
      TMPDIR=/tmp TMP=/tmp TEMP=/tmp "$BROWSER_BIN" --args "$args_csv" --session "$session" close --json >/dev/null 2>&1 || true
    else
      out=$(TMPDIR=/tmp TMP=/tmp TEMP=/tmp "$BROWSER_BIN" --session "$session" open about:blank --json 2>/dev/null || true)
      TMPDIR=/tmp TMP=/tmp TEMP=/tmp "$BROWSER_BIN" --session "$session" close --json >/dev/null 2>&1 || true
    fi
    printf '%s' "$out" | node -e '
      try {
        const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
        process.exit(j && j.success === true ? 0 : 1);
      } catch { process.exit(1); }
    '
  }
  if try_probe "$launch_args"; then
    return 0
  fi
  case ",$launch_args," in
    *,--no-sandbox,*) return 1 ;;
    *)
      if [ -n "$launch_args" ]; then
        try_probe "$launch_args,--no-sandbox"
      else
        try_probe "--no-sandbox"
      fi
      ;;
  esac
}

if ! command -v google-chrome >/dev/null 2>&1; then
  if ! install_chrome_linux; then
    # Keep unit tests running remotely when this template lacks both Chrome and root/sudo;
    # per-file requires.commands in squeal.config.json routes browser specs locally.
    log "google-chrome is not installed and cannot be installed without root/sudo; browser specs will run locally (switch providerConfig.template to squawk-runner for remote browser runs)"
    exit 0
  fi
fi

ensure_pinned_agent_browser

if ! probe_headless_chrome; then
  if [ "$(uname -s 2>/dev/null || true)" = Linux ] && can_elevate; then
    log "headless Chrome probe failed; installing system deps via agent-browser install --with-deps"
    run_root "$BROWSER_BIN" install --with-deps >/dev/null 2>&1 || true
  fi
  if ! probe_headless_chrome; then
    log "google-chrome is present ($(google-chrome --version 2>/dev/null || echo unknown)) but headless launch failed"
    exit 1
  fi
fi

log "ready: $(google-chrome --version 2>/dev/null || echo google-chrome) + agent-browser $BROWSER_PIN"
