#!/usr/bin/env bash

# Restart policy for scripts/worktree-cutover.sh.
#
# Return code convention:
#   0 = a TORQUE restart is required
#   1 = the path set is safe to merge without a restart barrier

cutover_normalize_changed_path() {
  local path="${1:-}"
  path="${path#./}"
  printf '%s\n' "$path" | tr '\\' '/'
}

cutover_changed_path_requires_restart() {
  local path
  path="$(cutover_normalize_changed_path "${1:-}")"
  [ -n "$path" ] || return 1

  case "$path" in
    *.md)
      return 1
      ;;
    docs/*)
      return 1
      ;;
    .github/*)
      return 1
      ;;
    .claude/*.md|.claude/*/*.md|.claude/*/*/*.md)
      return 1
      ;;
    agents/*.md|agents/*/*.md)
      return 1
      ;;
    skills/*.md|skills/*/*.md)
      return 1
      ;;
    AGENTS.md|CLAUDE.md|CODEX.md|GEMINI.md|README.md|CHANGELOG.md)
      return 1
      ;;
    CODE_OF_CONDUCT.md|CONTRIBUTING.md|PRIVACY.md|SECURITY.md|LICENSE|NOTICE)
      return 1
      ;;
    .gitignore|.gitattributes|.editorconfig)
      return 1
      ;;
  esac

  return 0
}

cutover_changed_paths_require_restart() {
  local path
  while IFS= read -r path || [ -n "$path" ]; do
    [ -n "$path" ] || continue
    if cutover_changed_path_requires_restart "$path"; then
      return 0
    fi
  done

  return 1
}
