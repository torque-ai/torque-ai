#!/usr/bin/env bash
# Install (or refresh) the wrappers from $REPO/bin into $HOME/bin.
#
# These wrappers (torque-remote, torque-remote-guard, torque-coord-client)
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
# Safe to re-run: only copies when content differs.
# Called by scripts/worktree-cutover.sh after the merge+restart so each
# cutover lands user-bin updates atomically with the repo source. Can
# also be run standalone after `git pull`.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
USERBIN_SRC_DIR="${REPO_ROOT}/bin"
USERBIN_DST_DIR="${TORQUE_USERBIN_DIR:-${HOME}/bin}"

# Known repo wrappers that are user-bin candidates. Extending this list
# adds a new file to the install path; removing one stops the script
# from refreshing it but leaves any existing user-bin copy alone.
WRAPPERS=(
  "torque-remote"
  "torque-remote-guard"
  "torque-coord-client"
)

if [ ! -d "$USERBIN_DST_DIR" ]; then
  echo "[install-userbin] skip: $USERBIN_DST_DIR does not exist (no user-bin convention on this box)"
  exit 0
fi

installed=0
skipped=0
missing=0
for name in "${WRAPPERS[@]}"; do
  src="${USERBIN_SRC_DIR}/${name}"
  dst="${USERBIN_DST_DIR}/${name}"

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
