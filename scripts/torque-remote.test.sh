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
RUN_RUNNER_SH=""

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
  unset GIT_LS_REMOTE_OUTPUT GIT_LS_REMOTE_EXIT_CODE
  unset SSH_CONNECT_OUTPUT SSH_CONNECT_EXIT_CODE
  unset SSH_WMIC_OUTPUT SSH_WMIC_EXIT_CODE
  unset GIT_COMMON_DIR_OUTPUT GIT_COMMON_DIR_EXIT_CODE
  unset SSH_BRANCH_EXISTS_OUTPUT SSH_BRANCH_EXISTS_EXIT_CODE
  unset SSH_SYNC_OUTPUT SSH_SYNC_EXIT_CODE
  unset SSH_EXEC_OUTPUT SSH_EXEC_EXIT_CODE
  unset SSH_LOCK_ACQUIRE_SEQUENCE SSH_LOCK_ACQUIRE_EXIT_CODE
  unset SSH_LOCK_OWNER_OUTPUT SSH_LOCK_OWNER_READ_EXIT_CODE SSH_LOCK_OWNER_WRITE_EXIT_CODE
  unset SSH_LOCK_REAP_EXIT_CODE TORQUE_REMOTE_SYNC_LOCK_STALE_CHECK_SECS
  unset TORQUE_REMOTE_TEST_WORKTREE_SUFFIX
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

if [[ "$#" -ge 2 && "$1" == "rev-parse" && "$2" == "--git-common-dir" ]]; then
  if [[ "${GIT_COMMON_DIR_OUTPUT+x}" == "x" && -n "$GIT_COMMON_DIR_OUTPUT" ]]; then
    printf '%s\n' "$GIT_COMMON_DIR_OUTPUT"
  else
    printf '.git\n'
  fi
  exit "${GIT_COMMON_DIR_EXIT_CODE:-0}"
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

if [[ "$#" -ge 5 && "$1" == "ls-remote" && "$2" == "--exit-code" && "$3" == "--heads" ]]; then
  branch="${5:-}"
  if grep -Fxq -- "origin/$branch" <<<"${GIT_VERIFY_EXISTS:-}"; then
    printf '0123456789012345678901234567890123456789\trefs/heads/%s\n' "$branch"
    exit 0
  fi
  exit "${GIT_LS_REMOTE_EXIT_CODE:-2}"
fi

if [[ "$#" -ge 4 && "$1" == "ls-remote" && "$2" == "--heads" ]]; then
  branch="${4:-main}"
  if [[ "${GIT_LS_REMOTE_OUTPUT+x}" == "x" && -n "$GIT_LS_REMOTE_OUTPUT" ]]; then
    printf '%s\n' "$GIT_LS_REMOTE_OUTPUT"
  else
    printf '0123456789012345678901234567890123456789\trefs/heads/%s\n' "$branch"
  fi
  exit "${GIT_LS_REMOTE_EXIT_CODE:-0}"
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

next_lock_ack() {
  local sequence="${SSH_LOCK_ACQUIRE_SEQUENCE:-ACQUIRED}"
  local state_file="${TORQUE_REMOTE_TEST_LOCK_STATE:-}"
  local index=0
  local last_index
  local ack
  IFS=',' read -r -a lock_states <<< "$sequence"
  if [[ -n "$state_file" && -f "$state_file" ]]; then
    index="$(cat "$state_file")"
  fi
  last_index=$((${#lock_states[@]} - 1))
  if (( index <= last_index )); then
    ack="${lock_states[$index]}"
  else
    ack="${lock_states[$last_index]}"
  fi
  if [[ -n "$state_file" ]]; then
    printf '%s' "$((index + 1))" > "$state_file"
  fi
  printf '%s\n' "$ack"
}

if [[ "$remote_cmd" == *".torque-remote-sync.lock"* && "$remote_cmd" == *"mkdir"* && "$remote_cmd" == *"echo ACQUIRED"* ]]; then
  next_lock_ack
  exit "${SSH_LOCK_ACQUIRE_EXIT_CODE:-0}"
fi

if [[ "$remote_cmd" == *".torque-remote-sync.lock\\owner.env"* && "$remote_cmd" == *"echo host="* ]]; then
  exit "${SSH_LOCK_OWNER_WRITE_EXIT_CODE:-0}"
fi

if [[ "$remote_cmd" == *".torque-remote-sync.lock\\owner.env"* && "$remote_cmd" == *"type"* ]]; then
  if [[ "${SSH_LOCK_OWNER_OUTPUT+x}" == "x" && -n "$SSH_LOCK_OWNER_OUTPUT" ]]; then
    printf '%s\n' "$SSH_LOCK_OWNER_OUTPUT"
  else
    printf 'NO_OWNER\n'
  fi
  exit "${SSH_LOCK_OWNER_READ_EXIT_CODE:-0}"
fi

if [[ "$remote_cmd" == *".torque-remote-sync.lock"* && "$remote_cmd" == *"rmdir /s /q"* ]]; then
  exit "${SSH_LOCK_REAP_EXIT_CODE:-0}"
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

if [[ "$remote_cmd" == *"torque-remote-inline-run"* || "$remote_cmd" == *"runner.sh"* ]]; then
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
    TORQUE_REMOTE_TEST_LOCK_STATE="$tmp/lock-state" \
    TORQUE_REMOTE_SYNC_LOG="$tmp/sync.log" \
    bash "$SCRIPT_UNDER_TEST" "$@" >"$stdout_file" 2>"$stderr_file"
  )
  RUN_EXIT=$?
  RUN_STDOUT="$(slurp_file "$stdout_file")"
  RUN_STDERR="$(slurp_file "$stderr_file")"
  RUN_ARGV_LOG="$(slurp_file "$tmp/argv.log")"
  RUN_REMOTE_COMMANDS="$(slurp_file "$tmp/remote-commands.log")"
  RUN_REMOTE_STDIN_SIZE="$(file_size_bytes "$tmp/remote-stdin.bin")"
  # The new bootstrap is a tiny cmd.exe-safe `tar -xf - | bash runner.sh`
  # invocation; the actual runner body — including the `# torque-remote-inline-run`
  # marker, the COMMAND_ARGS array literal, and the user-command invocation —
  # lives inside the tar bundle delivered over SSH stdin. Extract runner.sh from
  # the captured tar so tests can grep its contents directly.
  RUN_RUNNER_SH=""
  if [[ -s "$tmp/remote-stdin.bin" ]]; then
    RUN_RUNNER_SH="$(tar -xOf "$tmp/remote-stdin.bin" runner.sh 2>/dev/null || true)"
  fi
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
  # The `# torque-remote-inline-run` marker lives in runner.sh inside the
  # bundled tar, not on the SSH command line (which is a tiny bootstrap).
  expect_contains "remote runner.sh uses inline execution marker" "$RUN_RUNNER_SH" "torque-remote-inline-run"
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
  # The argv array literal and quoted arguments live in runner.sh inside the
  # bundled tar (the SSH command line is just `tar -xf - | bash runner.sh`).
  expect_contains "runner.sh defines argv array" "$RUN_RUNNER_SH" "COMMAND_ARGS=("
  expect_contains "runner.sh preserves spaced argument" "$RUN_RUNNER_SH" "two\\ words"
  expect_contains "runner.sh preserves semicolon literal" "$RUN_RUNNER_SH" "semi\\;ignored"
  expect_contains "runner.sh executes argv array" "$RUN_RUNNER_SH" "\"\${COMMAND_ARGS[@]}\""
  expect_not_contains "runner.sh does not use eval" "$RUN_RUNNER_SH" "eval \"\$COMMAND\""
  if grep -Fxq -- "git" "$tmp/calls.log"; then
    record_failure "runner.sh generation must not execute bare git from heredoc comments"
  fi

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

test_sync_log_path_is_env_overridable() {
  local tmp

  echo "Test: TORQUE_REMOTE_SYNC_LOG redirects sync output away from the global default"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  # run_torque_remote() sets TORQUE_REMOTE_SYNC_LOG="$tmp/sync.log" already,
  # so the test-isolated path should receive output. We can't reliably assert
  # "global default file unchanged" — the global /tmp/torque-remote-sync.log is
  # multi-tenant on a dev box (parallel torque-remote calls from other sessions
  # append to it), so a strict before/after byte-count comparison flakes on
  # busy machines. Positive assertion (test path got output) is sufficient
  # proof that the env-var override is plumbed through.
  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_greater_than_zero "test-isolated sync log received output" "$(file_size_bytes "$tmp/sync.log")"

  finish_test "test_sync_log_path_is_env_overridable"
}

test_sync_lock_writes_owner_metadata_and_removes_nonempty_lock() {
  local tmp

  echo "Test: sync lock writes owner metadata and removes non-empty lock dir"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "owner metadata file is written" "$RUN_REMOTE_COMMANDS" ".torque-remote-sync.lock\\owner.env"
  expect_contains "owner host is written" "$RUN_REMOTE_COMMANDS" "echo host="
  expect_contains "owner pid is written" "$RUN_REMOTE_COMMANDS" "echo pid="
  expect_contains "non-empty lock dir is removed recursively" "$RUN_REMOTE_COMMANDS" "rmdir /s /q"

  finish_test "test_sync_lock_writes_owner_metadata_and_removes_nonempty_lock"
}

test_stale_sync_lock_is_reaped_and_retried() {
  local tmp owner_host acquire_count

  echo "Test: stale sync lock is reaped and retried"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export SSH_LOCK_ACQUIRE_SEQUENCE="HELD,ACQUIRED"
  owner_host="$(printf '%s' "${COMPUTERNAME:-$(hostname 2>/dev/null || echo unknown)}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.:-')"
  export SSH_LOCK_OWNER_OUTPUT=$'host='"$owner_host"$'\npid=99999999\nstarted_at_epoch=1'
  export TORQUE_REMOTE_SYNC_LOCK_STALE_CHECK_SECS=1

  run_torque_remote "$tmp" echo hi

  acquire_count="$(grep -F "echo ACQUIRED" "$tmp/remote-commands.log" | wc -l | tr -d '[:space:]')"
  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "stderr reports stale lock reap" "$RUN_STDERR" "Remote sync lock appears stale"
  expect_contains "stale lock is removed recursively" "$RUN_REMOTE_COMMANDS" "rmdir /s /q"
  expect_contains "owner metadata is read before reaping" "$RUN_REMOTE_COMMANDS" ".torque-remote-sync.lock\\owner.env"
  if [[ "$acquire_count" -lt 2 ]]; then
    record_failure "lock acquisition was not retried after reap (expected at least 2 attempts, got $acquire_count)"
  fi

  finish_test "test_stale_sync_lock_is_reaped_and_retried"
}

test_sync_emits_npm_install_hint_for_node_layouts() {
  local tmp

  echo "Test: sync command emits npm install hints for the standard Node.js layouts"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  # The sync command appends three `if exist <pj> if not exist node_modules`
  # checks (root, server/, dashboard/) — verify each lands in the SSH command.
  # Backslash-separated paths are bash-escaping nightmares for grep needles, so
  # match on the surrounding literal substrings instead.
  expect_file_contains "root package.json hint is wired into sync" "$tmp/calls.log" "if exist package.json if not exist node_modules"
  expect_file_contains "hint mentions ./package.json source" "$tmp/calls.log" "./package.json has no node_modules"
  expect_file_contains "server hint mentions cd server && npm install" "$tmp/calls.log" "cd server"
  expect_file_contains "server hint mentions server/package.json" "$tmp/calls.log" "server/package.json has no node_modules"
  expect_file_contains "dashboard hint mentions cd dashboard && npm install" "$tmp/calls.log" "cd dashboard"
  expect_file_contains "dashboard hint mentions dashboard/package.json" "$tmp/calls.log" "dashboard/package.json has no node_modules"

  finish_test "test_sync_emits_npm_install_hint_for_node_layouts"
}

test_worktree_dot_git_file_is_project_root() {
  local parent worktree

  echo "Test: worktree .git file is detected as project root (not parent main checkout)"
  TEST_ERRORS=()
  reset_stub_env

  # Build a nested layout that mimics a real git worktree:
  #   $parent/             ← main checkout (.git is a directory)
  #   $parent/.git/
  #   $parent/.worktrees/feat-x/  ← feature worktree (.git is a FILE)
  #   $parent/.worktrees/feat-x/.git  ← contains "gitdir: ..."
  parent="$(mktemp -d)"
  TEMP_DIRS+=("$parent")
  worktree="$parent/.worktrees/feat-x"
  mkdir -p "$parent/.git" "$worktree" "$parent/bin" "$parent/home"
  printf 'gitdir: %s\n' "$parent/.git/worktrees/feat-x" > "$worktree/.git"
  : > "$worktree/calls.log"
  : > "$worktree/argv.log"
  : > "$worktree/remote-commands.log"
  : > "$worktree/remote-stdin.bin"

  cat > "$worktree/.torque-remote.json" <<'EOF'
{
  "transport": "ssh",
  "sync_before_run": true,
  "timeout_seconds": 30
}
EOF
  cat > "$worktree/.torque-remote.local.json" <<'EOF'
{
  "host": "fakehost",
  "user": "fakeuser",
  "remote_project_path": "/fake"
}
EOF

  export GIT_VERIFY_EXISTS="origin/main"
  export GIT_REV_PARSE_OUTPUT="feat/x"

  write_stub_jq "$parent/bin/jq"
  write_stub_git "$parent/bin/git"
  write_stub_ssh "$parent/bin/ssh"
  write_stub_timeout "$parent/bin/timeout"
  write_stub_argv_dump "$parent/bin/argv-dump"
  chmod +x "$parent/bin/jq" "$parent/bin/git" "$parent/bin/ssh" "$parent/bin/timeout" "$parent/bin/argv-dump"

  local stdout_file="$worktree/stdout.log"
  local stderr_file="$worktree/stderr.log"
  : > "$stdout_file"
  : > "$stderr_file"
  (
    cd "$worktree" || exit 1
    HOME="$parent/home" \
    PATH="$parent/bin:$ORIGINAL_PATH" \
    TORQUE_REMOTE_TEST_CALLS_LOG="$worktree/calls.log" \
    TORQUE_REMOTE_TEST_ARGV_LOG="$worktree/argv.log" \
    TORQUE_REMOTE_TEST_REMOTE_COMMANDS="$worktree/remote-commands.log" \
    TORQUE_REMOTE_TEST_REMOTE_STDIN="$worktree/remote-stdin.bin" \
    TORQUE_REMOTE_SYNC_LOG="$worktree/sync.log" \
    bash "$SCRIPT_UNDER_TEST" echo hi >"$stdout_file" 2>"$stderr_file"
  )
  RUN_EXIT=$?
  RUN_STDOUT="$(slurp_file "$stdout_file")"
  RUN_STDERR="$(slurp_file "$stderr_file")"

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  # The worktree's branch is 'feat/x'. If find_project_root walks past the
  # worktree's .git file up to the parent's .git directory, the local branch
  # detection runs from the parent (which has no actual git state in this
  # stubbed test) and the script ends up on a different code path. With the
  # fix, find_project_root stops at the worktree, so local branch detection
  # runs there and `git rev-parse --abbrev-ref HEAD` is invoked.
  expect_file_contains "local branch detection runs from worktree" "$worktree/calls.log" "git [rev-parse] [--abbrev-ref] [HEAD]"

  finish_test "test_worktree_dot_git_file_is_project_root"
}

test_worktree_uses_main_repo_basename_for_project_name() {
  local parent main worktree

  echo "Test: PROJECT_NAME from a worktree resolves to the main-repo basename, not the worktree dir name"
  TEST_ERRORS=()
  reset_stub_env

  # Layout (mirrors a real TORQUE feature worktree):
  #   $parent/torque-public/                         ← main checkout (.git directory)
  #   $parent/torque-public/.worktrees/feat-x/        ← worktree (.git is a *file*)
  parent="$(mktemp -d)"
  TEMP_DIRS+=("$parent")
  main="$parent/torque-public"
  worktree="$main/.worktrees/feat-x"
  mkdir -p "$main/.git" "$worktree" "$parent/bin" "$parent/home"
  printf 'gitdir: %s\n' "$main/.git/worktrees/feat-x" > "$worktree/.git"
  : > "$worktree/calls.log"
  : > "$worktree/argv.log"
  : > "$worktree/remote-commands.log"
  : > "$worktree/remote-stdin.bin"

  cat > "$worktree/.torque-remote.json" <<'EOF'
{
  "transport": "ssh",
  "sync_before_run": true,
  "timeout_seconds": 30
}
EOF
  cat > "$worktree/.torque-remote.local.json" <<'EOF'
{
  "host": "fakehost",
  "user": "fakeuser",
  "remote_project_path": "C:\\Users\\kenten\\Projects\\torque-public",
  "remote_test_worktree_root": "C:/trt"
}
EOF

  export GIT_VERIFY_EXISTS="origin/main"
  export GIT_REV_PARSE_OUTPUT="feat/x"
  # The fix uses git rev-parse --git-common-dir to detect the main repo from
  # inside a worktree. Stub returns the absolute path to the parent .git, which
  # signals worktree mode (as opposed to bare ".git" in a main checkout).
  export GIT_COMMON_DIR_OUTPUT="$main/.git"

  write_stub_jq "$parent/bin/jq"
  write_stub_git "$parent/bin/git"
  write_stub_ssh "$parent/bin/ssh"
  write_stub_timeout "$parent/bin/timeout"
  write_stub_argv_dump "$parent/bin/argv-dump"
  chmod +x "$parent/bin/jq" "$parent/bin/git" "$parent/bin/ssh" "$parent/bin/timeout" "$parent/bin/argv-dump"

  local stdout_file="$worktree/stdout.log"
  local stderr_file="$worktree/stderr.log"
  : > "$stdout_file"
  : > "$stderr_file"
  (
    cd "$worktree" || exit 1
    HOME="$parent/home" \
    PATH="$parent/bin:$ORIGINAL_PATH" \
    TORQUE_REMOTE_TEST_CALLS_LOG="$worktree/calls.log" \
    TORQUE_REMOTE_TEST_ARGV_LOG="$worktree/argv.log" \
    TORQUE_REMOTE_TEST_REMOTE_COMMANDS="$worktree/remote-commands.log" \
    TORQUE_REMOTE_TEST_REMOTE_STDIN="$worktree/remote-stdin.bin" \
    bash "$SCRIPT_UNDER_TEST" echo hi >"$stdout_file" 2>"$stderr_file"
  )
  RUN_EXIT=$?
  RUN_STDOUT="$(slurp_file "$stdout_file")"
  RUN_STDERR="$(slurp_file "$stderr_file")"
  RUN_RUNNER_SH=""
  if [[ -s "$worktree/remote-stdin.bin" ]]; then
    RUN_RUNNER_SH="$(tar -xOf "$worktree/remote-stdin.bin" runner.sh 2>/dev/null || true)"
  fi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  # Bug shape: from the worktree, basename(PROJECT_ROOT) = 'feat-x'. Without the
  # fix, EFFECTIVE_REMOTE_PROJECT_PATH ends up as C:\trt\feat-x, which never
  # exists on the remote (a fresh feature branch was never set up there). The
  # fix derives PROJECT_NAME from the main repo so the path stays stable across
  # branches: C:\trt\torque-public.
  expect_contains "remote path uses main-repo basename" "$RUN_RUNNER_SH" 'C:\trt\torque-public'
  expect_contains "base dependency path uses effective worktree root" "$RUN_RUNNER_SH" "TORQUE_REMOTE_BASE_PROJECT_PATH='C:\trt\torque-public'"
  expect_not_contains "remote path does NOT use worktree dir name" "$RUN_RUNNER_SH" 'C:\trt\feat-x'

  finish_test "test_worktree_uses_main_repo_basename_for_project_name"
}

test_worktree_suffix_uses_sibling_path_and_lock() {
  local tmp

  echo "Test: test worktree suffix uses a sibling checkout and lock"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_TEST_WORKTREE_SUFFIX="-pre-push-gate"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "runner uses suffixed project path" "$RUN_RUNNER_SH" "/fake-pre-push-gate"
  expect_contains "base dependency path stays unsuffixed" "$RUN_RUNNER_SH" "TORQUE_REMOTE_BASE_PROJECT_PATH='/fake'"
  expect_contains "sync lock uses suffixed project path" "$RUN_REMOTE_COMMANDS" "/fake-pre-push-gate.torque-remote-sync.lock"
  expect_not_contains "sync lock does not use default project path" "$RUN_REMOTE_COMMANDS" "/fake.torque-remote-sync.lock"

  finish_test "test_worktree_suffix_uses_sibling_path_and_lock"
}

test_worktree_suffix_rejects_unsafe_chars() {
  local tmp

  echo "Test: test worktree suffix rejects unsafe characters"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export TORQUE_REMOTE_TEST_WORKTREE_SUFFIX="../bad"

  run_torque_remote "$tmp" echo hi

  expect_nonzero "exit code is non-zero" "$RUN_EXIT"
  expect_contains "stderr names unsafe suffix" "$RUN_STDERR" "TORQUE_REMOTE_TEST_WORKTREE_SUFFIX contains unsafe characters"
  expect_eq "no remote bundle shipped" "0" "$RUN_REMOTE_STDIN_SIZE"

  finish_test "test_worktree_suffix_rejects_unsafe_chars"
}

test_sync_includes_drift_detection() {
  local tmp

  echo "Test: sync command includes drift-detection guard"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  # The new drift check guards against Windows file-lock failures where
  # `git checkout --force` and `git reset --hard` exit 0 but silently
  # leave individual files at their old content. After reset, we run
  # `git diff --quiet HEAD`; any drift exits 99 so sync_status fires.
  expect_file_contains "sync command includes git diff --quiet HEAD drift check" "$tmp/calls.log" "git diff --quiet HEAD"
  expect_file_contains "drift check exits 99 on failure" "$tmp/calls.log" "exit 99"

  finish_test "test_sync_includes_drift_detection"
}

test_sync_failure_falls_back_to_local() {
  local tmp

  echo "Test: ssh sync failure falls back to local execution instead of running tests against stale remote state"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  # Drift sentinel from runner.sh's `git diff --quiet HEAD || exit 99`. Live
  # regression 2026-04-25: torque-public's remote test worktree got stuck at
  # an old commit because sync emitted exit 99 but torque-remote only warned
  # and proceeded to run tests against the stale state, producing nonsense
  # verify output that the LLM tiebreak misclassified as baseline_broken.
  export SSH_SYNC_EXIT_CODE=99

  run_torque_remote "$tmp" argv-dump "remote-stale-canary"

  expect_eq "exit code is 0 (local fallback succeeded)" "0" "$RUN_EXIT"
  expect_contains "stderr reports sync failure" "$RUN_STDERR" "Sync failed"
  expect_contains "stderr reports falling back to local" "$RUN_STDERR" "falling back to local"
  expect_contains "argv-dump captured the canary argument locally" "$RUN_ARGV_LOG" "1=remote-stale-canary"
  # The remote-run path must NOT have fired — runner.sh only ships when sync
  # passes (or in the existing fallback paths). If we reach the remote runner
  # despite a 99 sync, we'd be running tests against stale code.
  expect_eq "remote-stdin bundle is empty (no runner.sh shipped)" "0" "$RUN_REMOTE_STDIN_SIZE"

  finish_test "test_sync_failure_falls_back_to_local"
}

test_unknown_leading_flag_errors() {
  local tmp

  echo "Test: torque-remote rejects unknown leading flags with a clear error"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"

  # `--cwd <dir>` is not a torque-remote flag (only --branch is). Without
  # validation, $1 = `--cwd` slips into COMMAND_ARGS and the local fallback
  # tries to exec `--cwd` as a program — `command not found`. Detect early.
  run_torque_remote "$tmp" --cwd /some/dir echo hi

  expect_nonzero "exit code is non-zero" "$RUN_EXIT"
  expect_contains "stderr names the unknown flag" "$RUN_STDERR" "--cwd"
  expect_contains "stderr points to the supported flag set" "$RUN_STDERR" "--branch"
  expect_file_not_contains "command was not invoked locally" "$tmp/calls.log" "echo hi"
  expect_eq "no remote bundle shipped" "0" "$RUN_REMOTE_STDIN_SIZE"

  finish_test "test_unknown_leading_flag_errors"
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
  test_sync_log_path_is_env_overridable
  test_sync_lock_writes_owner_metadata_and_removes_nonempty_lock
  test_stale_sync_lock_is_reaped_and_retried
  test_sync_emits_npm_install_hint_for_node_layouts
  test_worktree_dot_git_file_is_project_root
  test_worktree_uses_main_repo_basename_for_project_name
  test_worktree_suffix_uses_sibling_path_and_lock
  test_worktree_suffix_rejects_unsafe_chars
  test_sync_includes_drift_detection
  test_sync_failure_falls_back_to_local
  test_unknown_leading_flag_errors
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
