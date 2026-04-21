#!/usr/bin/env bash
set -euo pipefail

FEATURE_NAME="${1:-}"
if [ -z "$FEATURE_NAME" ]; then
  echo "Usage: scripts/worktree-create.sh <feature-name>"
  echo "Example: scripts/worktree-create.sh pii-guard"
  exit 1
fi

SAFE_NAME=$(echo "$FEATURE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
BRANCH="feat/${SAFE_NAME}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/feat-${SAFE_NAME}"

# Refuse names whose worktree leaf would match FACTORY_LEAF_PREFIX
# ('feat-factory-') in server/factory/worktree-reconcile.js. The factory
# tick treats any .worktrees/feat-factory-* dir it doesn't own as a
# reclaimable orphan and force-deletes it every ~5 minutes — observed
# 2026-04-20 when a manual worktree named feat-factory-* vanished
# twice in a row before this guard existed.
case "$SAFE_NAME" in
  factory-*)
    echo "ERROR: feature name '${SAFE_NAME}' starts with 'factory-'." >&2
    echo "  The resulting worktree dir (.worktrees/feat-factory-*) matches" >&2
    echo "  FACTORY_LEAF_PREFIX in server/factory/worktree-reconcile.js." >&2
    echo "  The factory-tick reconciler would treat it as an orphan and" >&2
    echo "  force-delete it every ~5 minutes. Pick a different name." >&2
    exit 1
    ;;
esac

if [ -d "$WORKTREE_DIR" ]; then
  echo "ERROR: Worktree already exists at ${WORKTREE_DIR}"
  echo "To remove: git worktree remove ${WORKTREE_DIR}"
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "Branch ${BRANCH} already exists. Using it."
else
  echo "Creating branch ${BRANCH} from main..."
  git branch "$BRANCH" main
fi

echo "Creating worktree at ${WORKTREE_DIR}..."
mkdir -p "$(dirname "$WORKTREE_DIR")"
git worktree add "$WORKTREE_DIR" "$BRANCH"

if [ -f "${WORKTREE_DIR}/server/package.json" ]; then
  echo "Installing server dependencies..."
  (cd "${WORKTREE_DIR}/server" && npm install --silent)
fi

if [ -f "${WORKTREE_DIR}/dashboard/package.json" ]; then
  echo "Installing dashboard dependencies..."
  (cd "${WORKTREE_DIR}/dashboard" && npm install --silent)
fi

# Ensure worktree guard is in the pre-commit hook (must run BEFORE PII guard)
HOOK_PATH="${REPO_ROOT}/.git/hooks/pre-commit"
GUARD_SCRIPT="${REPO_ROOT}/scripts/worktree-guard.sh"
PII_SCRIPT="${REPO_ROOT}/scripts/pii-pre-commit.sh"
if [ -f "$GUARD_SCRIPT" ]; then
  if ! grep -q "worktree-guard" "$HOOK_PATH" 2>/dev/null; then
    # Create a thin wrapper that runs worktree guard first, then PII guard
    cat > "$HOOK_PATH" << HOOKEOF
#!/usr/bin/env bash

# === Worktree guard — must run FIRST (blocks direct main commits when worktrees exist) ===
bash "${GUARD_SCRIPT}" || exit 1

# === PII Guard — scans staged files for personal data ===
if [ -f "${PII_SCRIPT}" ]; then
  exec bash "${PII_SCRIPT}"
fi
HOOKEOF
    chmod +x "$HOOK_PATH"
    echo "Installed pre-commit hook (worktree guard + PII guard)."
  fi
fi

# Keep git hooks in sync with tracked sources. Copies scripts/pre-push-hook
# to .git/hooks/pre-push (via --git-common-dir so it works from worktrees).
# Idempotent — only copies when content differs.
INSTALL_HOOKS_SCRIPT="${REPO_ROOT}/scripts/install-git-hooks.sh"
if [ -x "$INSTALL_HOOKS_SCRIPT" ]; then
  bash "$INSTALL_HOOKS_SCRIPT"
fi

echo ""
echo "  Worktree ready!"
echo "  ==============="
echo "  Path:   ${WORKTREE_DIR}"
echo "  Branch: ${BRANCH}"
echo ""
echo "  Open in Claude Code:"
echo "    cd ${WORKTREE_DIR}"
echo ""
echo "  When ready to go live:"
echo "    scripts/worktree-cutover.sh ${SAFE_NAME}"
echo ""
