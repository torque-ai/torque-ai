#!/usr/bin/env bash
# Install (or refresh) the wrappers from $REPO/bin into user-bin locations.
#
# These wrappers (torque-remote, torque-remote-guard, torque-coord-client,
# torque-push, torque-push.cmd, torque-push-shim.ps1)
# are checked into the repo and also lived as manual snapshots in $HOME/bin
# until 2026-04-29, when this script was added. The user-bin copy is the
# one actually invoked at the shell prompt and via the Bash PreToolUse
# hook. Without an automated refresh, fixes landed in repo bin/ silently
# fail to take effect — the wrappers ran with stale logic for as long as
# nobody noticed. Concrete incident: 2026-04-29 testRunnerRegistry-DI
# session — user-bin was 92 lines short, missing the FS mutex and exit-98
# HEAD-swap guard added 2026-04-28; remote tests reported "11 passed"
# while running pre-fix code.
#
# Safe to re-run: only copies when content differs. On Windows, the default
# install also mirrors wrappers into $HOME/.local/bin when that directory exists,
# because PowerShell sessions commonly have that path but not $HOME/bin.
# Called by scripts/worktree-cutover.sh after the merge+restart so each
# cutover lands user-bin updates atomically with the repo source. Can
# also be run standalone after `git pull`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if REPO_ROOT="$(git -C "${SCRIPT_DIR}/.." rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
USERBIN_SRC_DIR="${REPO_ROOT}/bin"
USERBIN_DST_DIR="${TORQUE_USERBIN_DIR:-${HOME}/bin}"

# Known repo wrappers that are user-bin candidates. Extending this list
# adds a new file to the install path; removing one stops the script
# from refreshing it but leaves any existing user-bin copy alone.
WRAPPERS=(
  "torque-remote"
  "torque-remote-guard"
  "torque-coord-client"
  "torque-push"
  "torque-push.cmd"
  "torque-push-shim.ps1"
)

install_wrappers_to_dir() {
  local dst_dir="$1"
  local installed=0
  local skipped=0
  local missing=0
  local name src dst

  if [ ! -d "$dst_dir" ]; then
    echo "[install-userbin] skip: $dst_dir does not exist (no user-bin convention on this box)"
    return 0
  fi

  for name in "${WRAPPERS[@]}"; do
    src="${USERBIN_SRC_DIR}/${name}"
    dst="${dst_dir}/${name}"

    if [ ! -f "$src" ]; then
      echo "[install-userbin] warn: source missing: ${src}"
      missing=$((missing + 1))
      continue
    fi

    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
      skipped=$((skipped + 1))
      continue
    fi

    cp "$src" "$dst"
    chmod +x "$dst"
    echo "[install-userbin] installed ${name} <- ${src}"
    installed=$((installed + 1))
  done

  echo "[install-userbin] done: ${installed} installed, ${skipped} skipped, ${missing} missing"
}

install_wrappers_to_dir "$USERBIN_DST_DIR"

if [ -z "${TORQUE_USERBIN_DIR:-}" ]; then
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*)
      POWERSHELL_USERBIN_DIR="${TORQUE_POWERSHELL_USERBIN_DIR:-${HOME}/.local/bin}"
      if [ "$POWERSHELL_USERBIN_DIR" != "$USERBIN_DST_DIR" ]; then
        install_wrappers_to_dir "$POWERSHELL_USERBIN_DIR"
      fi
      ;;
  esac
fi
