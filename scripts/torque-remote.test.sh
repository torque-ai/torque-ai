#!/usr/bin/env bash
set -uo pipefail

PASS=0
FAIL=0
ERRORS=()
TEST_ERRORS=()
TEMP_DIRS=()

RUN_EXIT=0
RUN_STDOUT=""
RUN_STDERR=""
LAST_TEST_ENV=""
RUN_ARGV_LOG=""
RUN_REMOTE_COMMANDS=""
RUN_REMOTE_STDIN_SIZE="0"

SCRIPT_UNDER_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)/torque-remote"
ORIGINAL_PATH="$PATH"

cleanup() {
  local dir
  for dir in "${TEMP_DIRS[@]}"; do
    [[ -n "$dir" && -d "$dir" ]] && rm -rf "$dir"
  done
}

trap cleanup EXIT

pass() {
  echo "  PASS: $1"
  ((PASS++))
}

fail() {
  local test_name="$1"
  shift

  echo "  FAIL: $test_name"

  local detail
  local summary=""
  for detail in "$@"; do
    echo "        $detail"
    if [[ -n "$summary" ]]; then
      summary="${summary}; "
    fi
    summary="${summary}${detail}"
  done

  ERRORS+=("${test_name}: ${summary}")
  ((FAIL++))
}

record_failure() {
  TEST_ERRORS+=("$1")
}

finish_test() {
  local test_name="$1"
  if [[ ${#TEST_ERRORS[@]} -eq 0 ]]; then
    pass "$test_name"
  else
    fail "$test_name" "${TEST_ERRORS[@]}"
  fi
}

slurp_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    cat "$file"
  fi
}

file_size_bytes() {
  local file="$1"
  if [[ -f "$file" ]]; then
    wc -c < "$file" | tr -d '[:space:]'
  else
    printf '0'
  fi
}

expect_eq() {
  local desc="$1"
  local expected="$2"
  local actual="$3"

  if [[ "$expected" != "$actual" ]]; then
    record_failure "$desc (expected '$expected', got '$actual')"
  fi
}

expect_nonzero() {
  local desc="$1"
  local actual="$2"

  if [[ "$actual" -eq 0 ]]; then
    record_failure "$desc (expected non-zero exit code, got 0)"
  fi
}

expect_greater_than_zero() {
  local desc="$1"
  local actual="$2"

  if [[ "$actual" -le 0 ]]; then
    record_failure "$desc (expected value > 0, got $actual)"
  fi
}

expect_contains() {
  local desc="$1"
  local haystack="$2"
  local needle="$3"

  if ! grep -Fq -- "$needle" <<<"$haystack"; then
    record_failure "$desc (missing '$needle')"
  fi
}

expect_not_contains() {
  local desc="$1"
  local haystack="$2"
  local needle="$3"

  if grep -Fq -- "$needle" <<<"$haystack"; then
    record_failure "$desc (unexpected '$needle')"
  fi
}

expect_file_contains() {
  local desc="$1"
  local file="$2"
  local needle="$3"
  local content

  content="$(slurp_file "$file")"
  expect_contains "$desc" "$content" "$needle"
}

expect_file_not_contains() {
  local desc="$1"
  local file="$2"
  local needle="$3"
  local content

  content="$(slurp_file "$file")"
  expect_not_contains "$desc" "$content" "$needle"
}

expect_file_empty() {
  local desc="$1"
  local file="$2"
  local content

  content="$(slurp_file "$file")"
  if [[ -n "$content" ]]; then
    record_failure "$desc (expected no shim calls, got '$content')"
  fi
}

reset_stub_env() {
  unset GIT_REV_PARSE_OUTPUT GIT_REV_PARSE_EXIT_CODE GIT_DEFAULT_EXIT_CODE
  unset GIT_VERIFY_EXISTS GIT_VERIFY_DEFAULT_EXIT_CODE
  unset GIT_DIFF_BASE_OUTPUT GIT_DIFF_HEAD_OUTPUT GIT_DIFF_EXIT_CODE
  unset GIT_LS_FILES_OUTPUT GIT_LS_FILES_EXIT_CODE
  unset SSH_CONNECT_OUTPUT SSH_CONNECT_EXIT_CODE
  unset SSH_WMIC_OUTPUT SSH_WMIC_EXIT_CODE
  unset SSH_BRANCH_EXISTS_OUTPUT SSH_BRANCH_EXISTS_EXIT_CODE
  unset SSH_SYNC_OUTPUT SSH_SYNC_EXIT_CODE
  unset SSH_EXEC_OUTPUT SSH_EXEC_EXIT_CODE
}

write_stub_argv_dump() {
  local path="$1"
  cat > "$path" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail

log_file="${TORQUE_REMOTE_TEST_ARGV_LOG:?}"
index=1
{
  for arg in "$@"; do
    printf '%s=%s\n' "$index" "$arg"
    index=$((index + 1))
  done
} > "$log_file"
EOF
}

write_stub_jq() {
  local path="$1"
  cat > "$path" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail

log_file="${TORQUE_REMOTE_TEST_CALLS_LOG:?}"
{
  printf 'jq'
  for arg in "$@"; do
    printf ' [%s]' "$arg"
  done
  printf '\n'
} >> "$log_file"

if [[ "$#" -lt 3 ]]; then
  exit 1
fi

query="$2"
file="$3"
field="${query%% //*}"
field="${field#.}"

if [[ ! -f "$file" ]]; then
  exit 0
fi

value="$(sed -nE "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p" "$file" | head -n 1)"
if [[ -z "$value" ]]; then
  value="$(sed -nE "s/.*\"$field\"[[:space:]]*:[[:space:]]*(true|false|null|[0-9]+).*/\1/p" "$file" | head -n 1)"
fi

if [[ -n "$value" && "$value" != "null" ]]; then
  printf '%s\n' "$value"
fi
EOF
}

write_stub_git() {
  local path="$1"
  cat > "$path" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail

log_file="${TORQUE_REMOTE_TEST_CALLS_LOG:?}"
{
  printf 'git'
  for arg in "$@"; do
    printf ' [%s]' "$arg"
  done
  printf '\n'
} >> "$log_file"

if [[ "$#" -ge 3 && "$1" == "rev-parse" && "$2" == "--abbrev-ref" && "$3" == "HEAD" ]]; then
  if [[ "${GIT_REV_PARSE_OUTPUT+x}" == "x" && -n "$GIT_REV_PARSE_OUTPUT" ]]; then
    printf '%s\n' "$GIT_REV_PARSE_OUTPUT"
  fi
  exit "${GIT_REV_PARSE_EXIT_CODE:-0}"
fi

if [[ "$#" -ge 3 && "$1" == "rev-parse" && "$2" == "--verify" ]]; then
  ref="$3"
  if grep -Fxq -- "$ref" <<<"${GIT_VERIFY_EXISTS:-}"; then
    printf '%s\n' "$ref"
    exit 0
  fi
  exit "${GIT_VERIFY_DEFAULT_EXIT_CODE:-1}"
fi

if [[ "$#" -ge 2 && "$1" == "diff" && "$2" == "--binary" ]]; then
  if [[ "${3:-}" == "HEAD" ]]; then
    if [[ "${GIT_DIFF_HEAD_OUTPUT+x}" == "x" && -n "$GIT_DIFF_HEAD_OUTPUT" ]]; then
      printf '%s' "$GIT_DIFF_HEAD_OUTPUT"
    fi
  else
    if [[ "${GIT_DIFF_BASE_OUTPUT+x}" == "x" && -n "$GIT_DIFF_BASE_OUTPUT" ]]; then
      printf '%s' "$GIT_DIFF_BASE_OUTPUT"
    fi
  fi
  exit "${GIT_DIFF_EXIT_CODE:-0}"
fi

if [[ "$#" -ge 4 && "$1" == "ls-files" && "$2" == "--others" && "$3" == "--exclude-standard" && "$4" == "-z" ]]; then
  if [[ "${GIT_LS_FILES_OUTPUT+x}" == "x" && -n "$GIT_LS_FILES_OUTPUT" ]]; then
    printf '%s' "$GIT_LS_FILES_OUTPUT"
  fi
  exit "${GIT_LS_FILES_EXIT_CODE:-0}"
fi

exit "${GIT_DEFAULT_EXIT_CODE:-0}"
EOF
}

write_stub_ssh() {
  local path="$1"
  cat > "$path" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail

log_file="${TORQUE_REMOTE_TEST_CALLS_LOG:?}"
{
  printf 'ssh'
  for arg in "$@"; do
    printf ' [%s]' "$arg"
  done
  printf '\n'
} >> "$log_file"

print_if_set() {
  local var_name="$1"
  if [[ "${!var_name+x}" == "x" && -n "${!var_name}" ]]; then
    printf '%s' "${!var_name}"
  fi
}

remote_cmd=""
if [[ "$#" -gt 0 ]]; then
  remote_cmd="${!#}"
fi

if [[ "$remote_cmd" == "echo ok" ]]; then
  print_if_set SSH_CONNECT_OUTPUT
  exit "${SSH_CONNECT_EXIT_CODE:-0}"
fi

if [[ -n "${TORQUE_REMOTE_TEST_REMOTE_COMMANDS:-}" ]]; then
  printf '%s\n' "$remote_cmd" >> "$TORQUE_REMOTE_TEST_REMOTE_COMMANDS"
fi

if [[ "$remote_cmd" == "wmic cpu get loadpercentage /value" ]]; then
  if [[ "${SSH_WMIC_OUTPUT+x}" == "x" ]]; then
    printf '%s\n' "$SSH_WMIC_OUTPUT"
  else
    printf 'LoadPercentage=10\n'
  fi
  exit "${SSH_WMIC_EXIT_CODE:-0}"
fi

if [[ "$remote_cmd" == *"git rev-parse --verify origin/"* ]]; then
  print_if_set SSH_BRANCH_EXISTS_OUTPUT
  exit "${SSH_BRANCH_EXISTS_EXIT_CODE:-0}"
fi

if [[ "$remote_cmd" == *"git checkout --force "* && "$remote_cmd" == *"git reset --hard origin/"* ]]; then
  if [[ "${SSH_SYNC_OUTPUT+x}" == "x" ]]; then
    printf '%s\n' "$SSH_SYNC_OUTPUT"
  else
    printf 'sync-ok\n'
  fi
  exit "${SSH_SYNC_EXIT_CODE:-0}"
fi

if [[ "$remote_cmd" == *"torque-remote-inline-run"* ]]; then
  if [[ -n "${TORQUE_REMOTE_TEST_REMOTE_STDIN:-}" ]]; then
    cat > "$TORQUE_REMOTE_TEST_REMOTE_STDIN"
  else
    cat >/dev/null
  fi

  if [[ "${SSH_EXEC_OUTPUT+x}" == "x" && -n "$SSH_EXEC_OUTPUT" ]]; then
    printf '%s\n' "$SSH_EXEC_OUTPUT"
  fi

  exit "${SSH_EXEC_EXIT_CODE:-0}"
fi

if [[ "${SSH_EXEC_OUTPUT+x}" == "x" && -n "$SSH_EXEC_OUTPUT" ]]; then
  printf '%s\n' "$SSH_EXEC_OUTPUT"
fi

exit "${SSH_EXEC_EXIT_CODE:-0}"
EOF
}

write_stub_timeout() {
  local path="$1"
  cat > "$path" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail

log_file="${TORQUE_REMOTE_TEST_CALLS_LOG:?}"
{
  printf 'timeout'
  for arg in "$@"; do
    printf ' [%s]' "$arg"
  done
  printf '\n'
} >> "$log_file"

if [[ "$#" -lt 2 ]]; then
  exit 125
fi

shift
"$@"
EOF
}

make_test_env() {
  local tmp
  tmp="$(mktemp -d)"
  TEMP_DIRS+=("$tmp")

  mkdir -p "$tmp/.git" "$tmp/bin" "$tmp/home"
  : > "$tmp/calls.log"
  : > "$tmp/argv.log"
  : > "$tmp/remote-commands.log"
  : > "$tmp/remote-stdin.bin"

  cat > "$tmp/.torque-remote.json" <<'EOF'
{
  "transport": "ssh",
  "sync_before_run": true,
  "timeout_seconds": 30
}
EOF

  cat > "$tmp/.torque-remote.local.json" <<'EOF'
{
  "host": "fakehost",
  "user": "fakeuser",
  "remote_project_path": "/fake"
}
EOF

  export GIT_VERIFY_EXISTS="origin/main"

  write_stub_jq "$tmp/bin/jq"
  write_stub_git "$tmp/bin/git"
  write_stub_ssh "$tmp/bin/ssh"
  write_stub_timeout "$tmp/bin/timeout"
  write_stub_argv_dump "$tmp/bin/argv-dump"
  chmod +x "$tmp/bin/jq" "$tmp/bin/git" "$tmp/bin/ssh" "$tmp/bin/timeout" "$tmp/bin/argv-dump"

  LAST_TEST_ENV="$tmp"
}

run_torque_remote() {
  local tmp="$1"
  shift

  local stdout_file="$tmp/stdout.log"
  local stderr_file="$tmp/stderr.log"

  : > "$stdout_file"
  : > "$stderr_file"

  (
    cd "$tmp" || exit 1
    HOME="$tmp/home" \
    PATH="$tmp/bin:$ORIGINAL_PATH" \
    TORQUE_REMOTE_TEST_CALLS_LOG="$tmp/calls.log" \
    TORQUE_REMOTE_TEST_ARGV_LOG="$tmp/argv.log" \
    TORQUE_REMOTE_TEST_REMOTE_COMMANDS="$tmp/remote-commands.log" \
    TORQUE_REMOTE_TEST_REMOTE_STDIN="$tmp/remote-stdin.bin" \
    bash "$SCRIPT_UNDER_TEST" "$@" >"$stdout_file" 2>"$stderr_file"
  )
  RUN_EXIT=$?
  RUN_STDOUT="$(slurp_file "$stdout_file")"
  RUN_STDERR="$(slurp_file "$stderr_file")"
  RUN_ARGV_LOG="$(slurp_file "$tmp/argv.log")"
  RUN_REMOTE_COMMANDS="$(slurp_file "$tmp/remote-commands.log")"
  RUN_REMOTE_STDIN_SIZE="$(file_size_bytes "$tmp/remote-stdin.bin")"
}

test_default_syncs_main() {
  local tmp

  echo "Test: default syncs main"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_file_contains "local branch detection runs" "$tmp/calls.log" "git [rev-parse] [--abbrev-ref] [HEAD]"
  expect_file_contains "ssh sync checks out main" "$tmp/calls.log" "git checkout --force main"
  expect_file_contains "ssh sync resets origin/main" "$tmp/calls.log" "git reset --hard origin/main"
  expect_file_contains "remote execute uses git bash" "$tmp/calls.log" "C:\\progra~1\\Git\\bin\\bash.exe"

  finish_test "test_default_syncs_main"
}

test_branch_flag_syncs_override() {
  local tmp

  echo "Test: --branch syncs override"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_VERIFY_EXISTS=$'origin/main\norigin/wip/foo'

  run_torque_remote "$tmp" --branch wip/foo echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_file_not_contains "branch override skips local branch detection" "$tmp/calls.log" "git [rev-parse] [--abbrev-ref] [HEAD]"
  expect_file_not_contains "branch override skips local bundle diff" "$tmp/calls.log" "git [diff] [--binary]"
  expect_file_contains "ssh sync checks out override branch" "$tmp/calls.log" "git checkout --force wip/foo"
  expect_file_contains "ssh sync resets origin override branch" "$tmp/calls.log" "git reset --hard origin/wip/foo"

  finish_test "test_branch_flag_syncs_override"
}

test_branch_flag_missing_errors() {
  local tmp

  echo "Test: --branch missing branch errors"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"

  run_torque_remote "$tmp" --branch bogus-branch echo hi

  expect_nonzero "exit code is non-zero" "$RUN_EXIT"
  expect_contains "stderr mentions missing origin branch" "$RUN_STDERR" "does not exist on origin"
  expect_file_not_contains "missing branch does not attempt sync checkout" "$tmp/calls.log" "git checkout --force bogus-branch"
  expect_file_not_contains "missing branch never invokes main command" "$tmp/calls.log" "echo hi"

  finish_test "test_branch_flag_missing_errors"
}

test_invalid_branch_name_errors() {
  local tmp

  echo "Test: invalid --branch name errors"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"

  run_torque_remote "$tmp" --branch 'foo;rm -rf /' echo hi

  expect_nonzero "exit code is non-zero" "$RUN_EXIT"
  expect_contains "stderr mentions invalid branch" "$RUN_STDERR" "Invalid"
  expect_file_empty "invalid branch never executes shimmed commands" "$tmp/calls.log"

  finish_test "test_invalid_branch_name_errors"
}

test_local_state_overlays_worktree_from_fallback_base() {
  local tmp

  echo "Test: local worktree state overlays fallback base"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="feat/local-only"
  export GIT_VERIFY_EXISTS="origin/main"
  export GIT_DIFF_BASE_OUTPUT='diff --git a/file.txt b/file.txt'

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_file_contains "missing remote branch is checked first" "$tmp/calls.log" "git [rev-parse] [--verify] [origin/feat/local-only]"
  expect_file_contains "fallback base is checked" "$tmp/calls.log" "git [rev-parse] [--verify] [origin/main]"
  expect_file_contains "base diff is created" "$tmp/calls.log" "git [diff] [--binary] [origin/main..HEAD]"
  expect_file_contains "worktree diff is created" "$tmp/calls.log" "git [diff] [--binary] [HEAD]"
  expect_file_contains "untracked files are inspected" "$tmp/calls.log" "git [ls-files] [--others] [--exclude-standard] [-z]"
  expect_contains "stderr mentions fallback overlay" "$RUN_STDERR" "using main as the remote base and overlaying local worktree state"
  expect_contains "remote run uses inline execution marker" "$RUN_REMOTE_COMMANDS" "torque-remote-inline-run"
  expect_file_not_contains "no temp-script upload round-trip remains" "$tmp/calls.log" "cat > /tmp/torque-remote-exec-"

  finish_test "test_local_state_overlays_worktree_from_fallback_base"
}

test_local_fallback_preserves_quoted_arguments() {
  local tmp

  echo "Test: local fallback preserves quoted arguments"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export SSH_CONNECT_EXIT_CODE=1

  run_torque_remote "$tmp" argv-dump "two words" 'semi;ignored'

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "stderr reports fallback" "$RUN_STDERR" "falling back to local"
  expect_contains "first argument keeps spaces" "$RUN_ARGV_LOG" "1=two words"
  expect_contains "second argument keeps semicolon literal" "$RUN_ARGV_LOG" "2=semi;ignored"

  finish_test "test_local_fallback_preserves_quoted_arguments"
}

test_remote_inline_command_preserves_quoted_arguments() {
  local tmp

  echo "Test: remote inline command preserves quoted arguments"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" argv-dump "two words" 'semi;ignored'

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "remote command defines argv array" "$RUN_REMOTE_COMMANDS" "COMMAND_ARGS=("
  expect_contains "remote command preserves spaced argument" "$RUN_REMOTE_COMMANDS" "two\\ words"
  expect_contains "remote command preserves semicolon literal" "$RUN_REMOTE_COMMANDS" "semi\\;ignored"
  expect_contains "remote command executes argv array" "$RUN_REMOTE_COMMANDS" "\"\${COMMAND_ARGS[@]}\""
  expect_not_contains "remote command does not use eval" "$RUN_REMOTE_COMMANDS" "eval \"\$COMMAND\""

  finish_test "test_remote_inline_command_preserves_quoted_arguments"
}

test_config_parses_without_jq() {
  local tmp

  echo "Test: config parsing falls back without jq"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  rm -f "$tmp/bin/jq"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_file_not_contains "jq is not invoked" "$tmp/calls.log" "jq ["
  expect_file_contains "config still routes over ssh" "$tmp/calls.log" "git checkout --force main"

  finish_test "test_config_parses_without_jq"
}

test_remote_run_does_not_require_timeout_binary() {
  local tmp

  echo "Test: remote run does not require timeout binary"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  rm -f "$tmp/bin/timeout"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_file_not_contains "timeout shim is not invoked" "$tmp/calls.log" "timeout ["

  finish_test "test_remote_run_does_not_require_timeout_binary"
}

test_successful_overlay_skips_failsafe_cleanup_round_trip() {
  local tmp

  echo "Test: successful overlay skips fail-safe cleanup round-trip"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export GIT_DIFF_BASE_OUTPUT='diff --git a/file.txt b/file.txt'

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_not_contains "success path avoids fail-safe cleanup ssh" "$RUN_REMOTE_COMMANDS" "torque-remote-failsafe-cleanup"

  finish_test "test_successful_overlay_skips_failsafe_cleanup_round_trip"
}

test_remote_overlay_bundle_reaches_run_command() {
  local tmp

  echo "Test: remote overlay bundle reaches run command stdin"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export GIT_DIFF_BASE_OUTPUT='diff --git a/file.txt b/file.txt'

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_greater_than_zero "run command receives a non-empty stdin bundle" "$RUN_REMOTE_STDIN_SIZE"

  finish_test "test_remote_overlay_bundle_reaches_run_command"
}

test_timeout_style_failure_triggers_failsafe_cleanup_round_trip() {
  local tmp

  echo "Test: timeout-style failure triggers fail-safe cleanup round-trip"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export GIT_DIFF_BASE_OUTPUT='diff --git a/file.txt b/file.txt'
  export SSH_EXEC_EXIT_CODE=124

  run_torque_remote "$tmp" echo hi

  expect_nonzero "exit code is non-zero" "$RUN_EXIT"
  expect_contains "stderr reports timeout" "$RUN_STDERR" "timed out after"
  expect_contains "fail-safe cleanup command runs on timeout-style exit" "$RUN_REMOTE_COMMANDS" "torque-remote-failsafe-cleanup"

  finish_test "test_timeout_style_failure_triggers_failsafe_cleanup_round_trip"
}

main() {
  if [[ ! -f "$SCRIPT_UNDER_TEST" ]]; then
    echo "torque-remote script not found: $SCRIPT_UNDER_TEST" >&2
    exit 1
  fi

  test_default_syncs_main
  test_branch_flag_syncs_override
  test_branch_flag_missing_errors
  test_invalid_branch_name_errors
  test_local_state_overlays_worktree_from_fallback_base
  test_local_fallback_preserves_quoted_arguments
  test_remote_inline_command_preserves_quoted_arguments
  test_config_parses_without_jq
  test_remote_run_does_not_require_timeout_binary
  test_successful_overlay_skips_failsafe_cleanup_round_trip
  test_remote_overlay_bundle_reaches_run_command
  test_timeout_style_failure_triggers_failsafe_cleanup_round_trip

  echo ""
  echo "=============================="
  echo "Results: $PASS passed, $FAIL failed"
  if [[ ${#ERRORS[@]} -gt 0 ]]; then
    echo ""
    echo "Failures:"
    local err
    for err in "${ERRORS[@]}"; do
      echo "  - $err"
    done
    echo "=============================="
    exit 1
  fi
  echo "=============================="
  exit 0
}

main "$@"
