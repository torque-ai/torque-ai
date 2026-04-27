#!/usr/bin/env bash
# Install (or refresh) the tracked git hooks into .git/hooks/.
#
# The pre-push hook lives at scripts/pre-push-hook (tracked) but git only
# executes hooks from .git/hooks/ (not tracked). This script copies any
# tracked hook whose installed copy is missing or stale.
#
# Safe to re-run: only copies when the content differs. Called by
# scripts/worktree-create.sh so every fresh worktree picks up hook updates
# without a manual step. Can also be run standalone after `git pull`.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC_DIR="${REPO_ROOT}/scripts"
# --git-common-dir points at the main checkout's .git even from inside a
# worktree (where .git is a file, not a directory). Hooks live on the
# common dir, so they apply to pushes from any worktree.
HOOKS_DST_DIR="$(git rev-parse --git-common-dir)/hooks"

# Hooks we track. Each entry is "<source-filename>:<installed-hook-name>".
HOOKS=(
  "pre-push-hook:pre-push"
  "post-commit-hook:post-commit"
)

if [ ! -d "$HOOKS_DST_DIR" ]; then
  mkdir -p "$HOOKS_DST_DIR"
fi

installed=0
skipped=0
for entry in "${HOOKS[@]}"; do
  src_name="${entry%%:*}"
  dst_name="${entry##*:}"
  src="${HOOKS_SRC_DIR}/${src_name}"
  dst="${HOOKS_DST_DIR}/${dst_name}"

  if [ ! -f "$src" ]; then
    echo "[install-git-hooks] warn: source missing: ${src}"
    continue
  fi

  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    skipped=$((skipped + 1))
    continue
  fi

  cp "$src" "$dst"
  chmod +x "$dst"
  echo "[install-git-hooks] installed ${dst_name} <- ${src_name}"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ] && [ "$skipped" -gt 0 ]; then
  echo "[install-git-hooks] all hooks up to date (${skipped} already installed)"
fi
