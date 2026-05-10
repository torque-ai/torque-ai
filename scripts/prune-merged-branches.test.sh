#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT="$SCRIPT_DIR/prune-merged-branches.sh"
TMP_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

assert_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -qE "$pattern" "$file"; then
    echo "Expected $file to contain pattern: $pattern" >&2
    echo "--- $file ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_branch_exists() {
  local repo="$1"
  local branch="$2"
  if ! git -C "$repo" show-ref --quiet --verify "refs/heads/$branch"; then
    echo "Expected branch to exist: $branch" >&2
    exit 1
  fi
}

assert_branch_missing() {
  local repo="$1"
  local branch="$2"
  if git -C "$repo" show-ref --quiet --verify "refs/heads/$branch"; then
    echo "Expected branch to be pruned: $branch" >&2
    exit 1
  fi
}

commit_file() {
  local repo="$1"
  local file="$2"
  local content="$3"
  local message="$4"
  printf '%s\n' "$content" > "$repo/$file"
  git -C "$repo" add "$file"
  git -C "$repo" commit -m "$message" >/dev/null
}

make_merged_branch() {
  local repo="$1"
  local branch="$2"
  local file="$3"
  git -C "$repo" checkout -q -b "$branch" main
  commit_file "$repo" "$file" "$branch" "commit $branch"
  git -C "$repo" checkout -q main
  git -C "$repo" merge --no-ff -m "merge $branch" "$branch" >/dev/null
}

REPO="$TMP_ROOT/repo"
git init -q -b main "$REPO"
git -C "$REPO" config user.email test.invalid
git -C "$REPO" config user.name "Test User"
commit_file "$REPO" README.md base "base"

make_merged_branch "$REPO" feat/merged feat-merged.txt
make_merged_branch "$REPO" feat/active feat-active.txt
make_merged_branch "$REPO" feat-legacy feat-legacy.txt
make_merged_branch "$REPO" backup/merged backup-merged.txt
make_merged_branch "$REPO" feat/upstream-mismatch feat-upstream-mismatch.txt
git -C "$REPO" branch backup/upstream-mismatch-base main~1
git -C "$REPO" branch --set-upstream-to=backup/upstream-mismatch-base feat/upstream-mismatch >/dev/null

git -C "$REPO" checkout -q -b feat/unmerged main
commit_file "$REPO" unmerged.txt unmerged "unmerged"
git -C "$REPO" checkout -q main

git -C "$REPO" worktree add -q "$TMP_ROOT/active-worktree" feat/active

(
  cd "$REPO"
  bash "$SCRIPT" --base main > "$TMP_ROOT/dry-run.out"
)
assert_contains "$TMP_ROOT/dry-run.out" 'WOULD DELETE:[[:space:]]+feat/merged'
assert_contains "$TMP_ROOT/dry-run.out" 'WOULD DELETE:[[:space:]]+feat/upstream-mismatch'
assert_contains "$TMP_ROOT/dry-run.out" 'SKIP active worktree:[[:space:]]+feat/active'
assert_contains "$TMP_ROOT/dry-run.out" 'SKIP protected:[[:space:]]+backup/merged'
assert_contains "$TMP_ROOT/dry-run.out" 'SKIP prefix policy:[[:space:]]+feat-legacy'
assert_contains "$TMP_ROOT/dry-run.out" 'KEEP not merged:[[:space:]]+feat/unmerged'

(
  cd "$REPO"
  bash "$SCRIPT" --base main --include-legacy-prefix --apply > "$TMP_ROOT/apply.out"
)

assert_contains "$TMP_ROOT/apply.out" 'DELETED:[[:space:]]+feat/merged'
assert_contains "$TMP_ROOT/apply.out" 'DELETED verified:[[:space:]]+feat/upstream-mismatch'
assert_contains "$TMP_ROOT/apply.out" 'DELETED:[[:space:]]+feat-legacy'
assert_contains "$TMP_ROOT/apply.out" 'SKIP active worktree:[[:space:]]+feat/active'
assert_contains "$TMP_ROOT/apply.out" 'SKIP protected:[[:space:]]+backup/merged'
assert_branch_missing "$REPO" feat/merged
assert_branch_missing "$REPO" feat/upstream-mismatch
assert_branch_missing "$REPO" feat-legacy
assert_branch_exists "$REPO" feat/active
assert_branch_exists "$REPO" backup/merged
assert_branch_exists "$REPO" feat/unmerged

echo "prune-merged-branches tests passed"
