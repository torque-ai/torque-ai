# Remote Workstation Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a global `torque-remote` command that routes heavy commands (builds, tests, compilation) to the configured remote workstation via SSH, with a Claude Code guard hook that automatically intercepts direct invocations.

**Architecture:** Two global bash scripts (`torque-remote` + `torque-remote-guard`) installed to `~/bin/`. Global config files in `~/`. A guard hook in `~/.claude/settings.json`. TORQUE's `await_task` verify routes through `torque-remote` when available. Old per-project `torque-test` files cleaned up.

**Tech Stack:** Bash, jq, SSH, Node.js (TORQUE integration)

**Spec:** `docs/superpowers/specs/2026-03-19-remote-workstation-routing-design.md`

---

## File Map

| File | Action | Location | Responsibility |
|------|--------|----------|---------------|
| `~/bin/torque-remote` | Create | Global | Route commands to remote workstation |
| `~/bin/torque-remote-guard` | Create | Global | Guard hook — redirect intercepted commands |
| `~/tests/torque-remote.test.sh` | Create | Global | Shell tests for both scripts |
| `~/.torque-remote.json` | Create | Global | Default routing config |
| `~/.torque-remote.local.json` | Create | Global | Personal SSH details |
| `~/.claude/settings.json` | Modify | Global | Install guard hook |
| `server/handlers/workflow/await.js` | Modify | torque-public | Route verify through `torque-remote` |
| `server/handlers/automation-handlers.js` | Modify | torque-public | Remove `writeTestStationConfig` |
| `server/tests/test-station-routing.test.js` | Modify | torque-public | Update tests for new routing |
| `CLAUDE.md` | Modify | torque-public | Update routing docs |

---

## Task 1: Global `torque-remote` Script

**Files:**
- Create: `~/bin/torque-remote`
- Create: `~/tests/torque-remote.test.sh`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p ~/bin ~/tests
```

- [ ] **Step 2: Create the `torque-remote` script**

Create `~/bin/torque-remote`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# torque-remote — Route commands to the configured remote workstation.
# Usage: torque-remote <command...>
#   Routes the command to the remote workstation via SSH.
#   Falls back to local execution if remote is unreachable or overloaded.
#
# Config (highest priority wins):
#   .torque-remote.json in project root (per-project override)
#   ~/.torque-remote.json (global default)
#
# Connection details:
#   .torque-remote.local.json in project root (per-project)
#   ~/.torque-remote.local.json (global)

# ---- Helpers ----

die()  { echo "[torque-remote] ERROR: $*" >&2; exit 1; }
warn() { echo "[torque-remote] WARNING: $*" >&2; }
info() { echo "[torque-remote] $*" >&2; }

json_get() {
  local file="$1" field="$2"
  jq -r "$field // empty" "$file" 2>/dev/null || true
}

# ---- Prerequisites ----

command -v jq  &>/dev/null || die "jq is required but not found in PATH"
command -v ssh &>/dev/null || die "ssh is required but not found in PATH"

# ---- Usage ----

if [[ $# -eq 0 ]]; then
  cat >&2 << 'USAGE'
Usage: torque-remote <command...>

Routes commands to the configured remote workstation via SSH.
Falls back to local execution if the remote is unreachable or overloaded.

Examples:
  torque-remote npx vitest run server/tests/foo.test.js
  torque-remote dotnet build example-project.sln
  torque-remote cargo test --release

Config: ~/.torque-remote.json + ~/.torque-remote.local.json
Override: .torque-remote.json in project root
USAGE
  exit 1
fi

# ---- Project root detection ----

find_project_root() {
  local dir="$PWD"
  while [[ "$dir" != "/" && "$dir" != "" ]]; do
    if [[ -d "$dir/.git" ]]; then
      echo "$dir"
      return
    fi
    dir="$(dirname "$dir")"
  done
  echo "$PWD"
}

PROJECT_ROOT="$(find_project_root)"
PROJECT_NAME="$(basename "$PROJECT_ROOT")"

# ---- Load config ----

TRANSPORT="local"
SYNC_BEFORE_RUN="true"
TIMEOUT_SECONDS="300"
LOAD_THRESHOLD="80"

# Global config
GLOBAL_CONFIG="$HOME/.torque-remote.json"
if [[ -f "$GLOBAL_CONFIG" ]]; then
  v=$(json_get "$GLOBAL_CONFIG" '.transport');        [[ -n "$v" ]] && TRANSPORT="$v"
  v=$(json_get "$GLOBAL_CONFIG" '.sync_before_run');  [[ -n "$v" ]] && SYNC_BEFORE_RUN="$v"
  v=$(json_get "$GLOBAL_CONFIG" '.timeout_seconds');  [[ -n "$v" ]] && TIMEOUT_SECONDS="$v"
  v=$(json_get "$GLOBAL_CONFIG" '.load_threshold');   [[ -n "$v" ]] && LOAD_THRESHOLD="$v"
fi

# Per-project override
PROJECT_CONFIG="$PROJECT_ROOT/.torque-remote.json"
if [[ -f "$PROJECT_CONFIG" ]]; then
  v=$(json_get "$PROJECT_CONFIG" '.transport');        [[ -n "$v" ]] && TRANSPORT="$v"
  v=$(json_get "$PROJECT_CONFIG" '.sync_before_run');  [[ -n "$v" ]] && SYNC_BEFORE_RUN="$v"
  v=$(json_get "$PROJECT_CONFIG" '.timeout_seconds');  [[ -n "$v" ]] && TIMEOUT_SECONDS="$v"
  v=$(json_get "$PROJECT_CONFIG" '.load_threshold');   [[ -n "$v" ]] && LOAD_THRESHOLD="$v"
fi

# No config at all
if [[ ! -f "$GLOBAL_CONFIG" && ! -f "$PROJECT_CONFIG" ]]; then
  warn "No .torque-remote.json found — running locally"
  TRANSPORT="local"
fi

# ---- Load connection details ----

SSH_HOST=""
SSH_USER=""
SSH_KEY_PATH=""
DEFAULT_PROJECT_PATH=""
REMOTE_PROJECT_PATH=""

# Global local config
GLOBAL_LOCAL="$HOME/.torque-remote.local.json"
if [[ -f "$GLOBAL_LOCAL" ]]; then
  SSH_HOST=$(json_get "$GLOBAL_LOCAL" '.host')
  SSH_USER=$(json_get "$GLOBAL_LOCAL" '.user')
  SSH_KEY_PATH=$(json_get "$GLOBAL_LOCAL" '.key_path')
  DEFAULT_PROJECT_PATH=$(json_get "$GLOBAL_LOCAL" '.default_project_path')
fi

# Per-project local override
PROJECT_LOCAL="$PROJECT_ROOT/.torque-remote.local.json"
if [[ -f "$PROJECT_LOCAL" ]]; then
  v=$(json_get "$PROJECT_LOCAL" '.host');                [[ -n "$v" ]] && SSH_HOST="$v"
  v=$(json_get "$PROJECT_LOCAL" '.user');                [[ -n "$v" ]] && SSH_USER="$v"
  v=$(json_get "$PROJECT_LOCAL" '.key_path');            [[ -n "$v" ]] && SSH_KEY_PATH="$v"
  v=$(json_get "$PROJECT_LOCAL" '.remote_project_path'); [[ -n "$v" ]] && REMOTE_PROJECT_PATH="$v"
fi

# Derive remote project path if not explicitly set
if [[ -z "$REMOTE_PROJECT_PATH" && -n "$DEFAULT_PROJECT_PATH" ]]; then
  REMOTE_PROJECT_PATH="${DEFAULT_PROJECT_PATH}\\${PROJECT_NAME}"
fi

# ---- Command to run ----

COMMAND="$*"

# ---- Execute ----

case "$TRANSPORT" in

  local)
    info "Running locally: $COMMAND"
    cd "$PROJECT_ROOT"
    set +e
    eval "$COMMAND"
    exit_code=$?
    set -e
    exit $exit_code
    ;;

  ssh)
    # Validate connection details
    [[ -z "$SSH_HOST" ]] && die "SSH transport requires 'host' in ~/.torque-remote.local.json"
    [[ -z "$SSH_USER" ]] && die "SSH transport requires 'user' in ~/.torque-remote.local.json"
    [[ -z "$REMOTE_PROJECT_PATH" ]] && die "Cannot derive remote project path. Set 'default_project_path' in ~/.torque-remote.local.json or 'remote_project_path' in project .torque-remote.local.json"

    # SSH options
    SSH_OPTS=(-o ConnectTimeout=5 -o BatchMode=yes)
    if [[ -n "$SSH_KEY_PATH" && "$SSH_KEY_PATH" != "null" ]]; then
      SSH_OPTS+=(-i "$SSH_KEY_PATH")
    fi

    # Connectivity check
    if ! ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" "echo ok" &>/dev/null; then
      warn "Remote $SSH_HOST unreachable — falling back to local"
      cd "$PROJECT_ROOT"
      set +e
      eval "$COMMAND"
      exit_code=$?
      set -e
      exit $exit_code
    fi

    # Load check (Windows: wmic, Linux: /proc/loadavg)
    load_pct=""
    load_output=$(ssh -o ConnectTimeout=2 "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" "wmic cpu get loadpercentage /value" 2>/dev/null || true)
    if [[ -n "$load_output" ]]; then
      load_pct=$(echo "$load_output" | grep -oP 'LoadPercentage=\K[0-9]+' 2>/dev/null || true)
    fi
    if [[ -z "$load_pct" ]]; then
      # Try Linux
      load_output=$(ssh -o ConnectTimeout=2 "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" "cat /proc/loadavg" 2>/dev/null || true)
      if [[ -n "$load_output" ]]; then
        load_1m=$(echo "$load_output" | awk '{print $1}')
        ncpu=$(ssh -o ConnectTimeout=2 "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" "nproc" 2>/dev/null || echo "1")
        load_pct=$(awk "BEGIN {printf \"%.0f\", ($load_1m / $ncpu) * 100}")
      fi
    fi

    if [[ -n "$load_pct" ]] && (( load_pct > LOAD_THRESHOLD )); then
      warn "Remote $SSH_HOST is overloaded (${load_pct}% CPU, threshold ${LOAD_THRESHOLD}%) — falling back to local"
      cd "$PROJECT_ROOT"
      set +e
      eval "$COMMAND"
      exit_code=$?
      set -e
      exit $exit_code
    fi

    # Sync
    if [[ "$SYNC_BEFORE_RUN" == "true" ]]; then
      local_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
      if [[ "$local_branch" == "HEAD" ]]; then
        warn "Detached HEAD — skipping remote sync, remote may have stale code"
      elif [[ ! "$local_branch" =~ ^[a-zA-Z0-9_./-]+$ ]]; then
        warn "Branch name contains unsafe characters — skipping sync"
      else
        info "Syncing $local_branch on remote..."
        ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
          "cd \"$REMOTE_PROJECT_PATH\" && git fetch origin && git checkout --force $local_branch && git reset --hard origin/$local_branch" \
          2>&1 || warn "Sync failed — remote may have stale code"
      fi
    fi

    # Execute
    info "Running on $SSH_USER@$SSH_HOST: $COMMAND"
    set +e
    timeout "$TIMEOUT_SECONDS" ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
      "cd \"$REMOTE_PROJECT_PATH\" && $COMMAND"
    exit_code=$?
    set -e

    if [[ $exit_code -eq 124 ]]; then
      echo "[torque-remote] ERROR: Command timed out after ${TIMEOUT_SECONDS}s" >&2
    fi
    exit $exit_code
    ;;

  *)
    die "Unknown transport '$TRANSPORT'. Valid: local, ssh"
    ;;
esac
```

- [ ] **Step 3: Make executable**

```bash
chmod +x ~/bin/torque-remote
```

- [ ] **Step 4: Write shell tests**

Create `~/tests/torque-remote.test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
SCRIPT="$HOME/bin/torque-remote"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected '$expected', got '$actual')"; FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"; FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if ! echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected NOT to contain '$needle')"; FAIL=$((FAIL + 1))
  fi
}

# ---- Setup: fake home with config ----
FAKE_HOME="$TMPDIR/home"
mkdir -p "$FAKE_HOME/bin" "$FAKE_HOME/tests"
cp "$SCRIPT" "$FAKE_HOME/bin/torque-remote"

# ---- Test: no args prints usage ----
echo "Test: no args prints usage"
output=$(HOME="$FAKE_HOME" "$FAKE_HOME/bin/torque-remote" 2>&1 || true)
assert_contains "usage shown" "Usage:" "$output"

# ---- Test: local transport runs command ----
echo "Test: local transport"
PROJECT="$TMPDIR/local-project"
mkdir -p "$PROJECT/.git" "$PROJECT/scripts"
cat > "$FAKE_HOME/.torque-remote.json" << 'EOF'
{"version":1,"transport":"local","timeout_seconds":30}
EOF
output=$(cd "$PROJECT" && HOME="$FAKE_HOME" "$FAKE_HOME/bin/torque-remote" echo "hello-local" 2>&1)
assert_contains "local runs command" "hello-local" "$output"

# ---- Test: no config runs locally with warning ----
echo "Test: no config"
NOCONF_HOME="$TMPDIR/noconf-home"
mkdir -p "$NOCONF_HOME/bin"
cp "$SCRIPT" "$NOCONF_HOME/bin/torque-remote"
output=$(cd "$PROJECT" && HOME="$NOCONF_HOME" "$NOCONF_HOME/bin/torque-remote" echo "fallback-ok" 2>&1)
assert_contains "runs locally" "fallback-ok" "$output"
assert_contains "warns about missing config" "No .torque-remote.json" "$output"

# ---- Test: per-project config overrides global ----
echo "Test: per-project override"
cat > "$FAKE_HOME/.torque-remote.json" << 'EOF'
{"version":1,"transport":"local","timeout_seconds":30}
EOF
cat > "$PROJECT/.torque-remote.json" << 'EOF'
{"version":1,"timeout_seconds":999}
EOF
# Can't easily test timeout override in a shell test, but verify no error
output=$(cd "$PROJECT" && HOME="$FAKE_HOME" "$FAKE_HOME/bin/torque-remote" echo "override-ok" 2>&1)
assert_contains "override works" "override-ok" "$output"
rm -f "$PROJECT/.torque-remote.json"

# ---- Test: ssh transport missing local config ----
echo "Test: ssh missing local config"
cat > "$FAKE_HOME/.torque-remote.json" << 'EOF'
{"version":1,"transport":"ssh","timeout_seconds":30}
EOF
rm -f "$FAKE_HOME/.torque-remote.local.json"
output=$(cd "$PROJECT" && HOME="$FAKE_HOME" "$FAKE_HOME/bin/torque-remote" echo "test" 2>&1 || true)
assert_contains "ssh needs host" "requires" "$output"

# ---- Test: unknown transport ----
echo "Test: unknown transport"
cat > "$FAKE_HOME/.torque-remote.json" << 'EOF'
{"version":1,"transport":"docker","timeout_seconds":30}
EOF
output=$(cd "$PROJECT" && HOME="$FAKE_HOME" "$FAKE_HOME/bin/torque-remote" echo "test" 2>&1 || true)
assert_contains "unknown transport errors" "Unknown transport" "$output"

# ---- Test: project root detection ----
echo "Test: project root detection"
cat > "$FAKE_HOME/.torque-remote.json" << 'EOF'
{"version":1,"transport":"local","timeout_seconds":30}
EOF
SUBDIR="$PROJECT/src/deep/nested"
mkdir -p "$SUBDIR"
output=$(cd "$SUBDIR" && HOME="$FAKE_HOME" "$FAKE_HOME/bin/torque-remote" echo "from-subdir" 2>&1)
assert_contains "finds root from subdir" "from-subdir" "$output"

# ---- Summary ----
echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
echo "=============================="
[[ $FAIL -eq 0 ]] || exit 1
```

- [ ] **Step 5: Make test executable and run**

```bash
chmod +x ~/tests/torque-remote.test.sh
bash ~/tests/torque-remote.test.sh
```
Expected: All PASS

- [ ] **Step 6: Verify PATH**

```bash
# Add to ~/.bashrc if not present
grep -q 'HOME/bin' ~/.bashrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
# Verify torque-remote is on PATH
which torque-remote
```

- [ ] **Step 7: Commit**

```bash
cd /path/to/torque
git add -f ~/bin/torque-remote ~/tests/torque-remote.test.sh
```

Note: These files are outside the repo. Commit them manually or track separately. For now, just verify the script works. The repo commit happens in later tasks.

---

## Task 2: Global `torque-remote-guard` Script

**Files:**
- Create: `~/bin/torque-remote-guard`
- Append to: `~/tests/torque-remote.test.sh`

- [ ] **Step 1: Create the guard script**

Create `~/bin/torque-remote-guard`:

```bash
#!/usr/bin/env bash

# torque-remote-guard — Claude Code PreToolUse hook for Bash tool.
# Intercepts heavy commands and redirects to torque-remote.
#
# Exit 0: allow
# Exit 2: block with redirect message

# ---- Find project root ----

find_project_root() {
  local dir="$PWD"
  while [[ "$dir" != "/" && "$dir" != "" ]]; do
    if [[ -d "$dir/.git" ]]; then
      echo "$dir"
      return
    fi
    dir="$(dirname "$dir")"
  done
  echo "$PWD"
}

PROJECT_ROOT="$(find_project_root)"

# ---- Load config ----

CONFIG=""
if [[ -f "$PROJECT_ROOT/.torque-remote.json" ]]; then
  CONFIG="$PROJECT_ROOT/.torque-remote.json"
elif [[ -f "$HOME/.torque-remote.json" ]]; then
  CONFIG="$HOME/.torque-remote.json"
fi

# No config → allow everything
if [[ -z "$CONFIG" ]]; then
  exit 0
fi

# Check jq
if ! command -v jq &>/dev/null; then
  echo "[torque-remote-guard] WARNING: jq not found, guard disabled" >&2
  exit 0
fi

# Local transport → allow everything
transport=$(jq -r '.transport // "local"' "$CONFIG" 2>/dev/null || echo "local")
if [[ "$transport" == "local" ]]; then
  exit 0
fi

# ---- Read command from stdin ----

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")

if [[ -z "$command" ]]; then
  exit 0
fi

# ---- Check first token for recursion ----

first_token=$(echo "$command" | awk '{print $1}')
if [[ "$first_token" == "torque-remote" || "$first_token" == */torque-remote ]]; then
  exit 0
fi

# ---- Load intercept patterns ----

# Read intercept_commands as newline-separated list
patterns=$(jq -r '.intercept_commands[]? // empty' "$CONFIG" 2>/dev/null || true)

if [[ -z "$patterns" ]]; then
  # Default patterns if not configured
  patterns="vitest
jest
pytest
mocha
dotnet test
dotnet build
dotnet publish
npm test
npm run build
npm run test
go test
go build
cargo build
cargo test
make
msbuild
tsc"
fi

# ---- Match patterns against command ----

# Tokenize the command
IFS=' ' read -ra tokens <<< "$command"

match_pattern() {
  local pattern="$1"
  local -a pat_tokens
  IFS=' ' read -ra pat_tokens <<< "$pattern"
  local pat_len=${#pat_tokens[@]}

  # Scan for consecutive token match
  for (( i=0; i <= ${#tokens[@]} - pat_len; i++ )); do
    local matched=true
    for (( j=0; j < pat_len; j++ )); do
      if [[ "${tokens[$((i+j))]}" != "${pat_tokens[$j]}" ]]; then
        matched=false
        break
      fi
    done
    if [[ "$matched" == "true" ]]; then
      return 0
    fi
  done
  return 1
}

while IFS= read -r pattern; do
  [[ -z "$pattern" ]] && continue
  if match_pattern "$pattern"; then
    cat >&2 << EOF
BLOCKED: "$pattern" should run on the remote workstation.

Use:  torque-remote $command

The remote workstation handles heavy builds/tests. If it's unreachable,
torque-remote will automatically fall back to local execution.
EOF
    exit 2
  fi
done <<< "$patterns"

exit 0
```

- [ ] **Step 2: Make executable**

```bash
chmod +x ~/bin/torque-remote-guard
```

- [ ] **Step 3: Append guard tests**

Append to `~/tests/torque-remote.test.sh`:

```bash
# ==== Guard Hook Tests ====

echo ""
echo "==== Guard Hook Tests ===="
GUARD="$HOME/bin/torque-remote-guard"

# Setup: project with ssh transport
GUARD_PROJECT="$TMPDIR/guard-project"
mkdir -p "$GUARD_PROJECT/.git"

# ---- Test: vitest is intercepted ----
echo "Test: guard intercepts vitest"
cat > "$FAKE_HOME/.torque-remote.json" << 'EOF'
{"version":1,"transport":"ssh","timeout_seconds":30}
EOF
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"npx vitest run server/tests/foo.test.js"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "vitest blocked" "BLOCKED" "$output"
assert_contains "vitest exit 2" "EXIT:2" "$output"

# ---- Test: dotnet build intercepted ----
echo "Test: guard intercepts dotnet build"
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"dotnet build example-project.sln"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "dotnet build blocked" "BLOCKED" "$output"

# ---- Test: npm test intercepted ----
echo "Test: guard intercepts npm test"
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"npm test"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "npm test blocked" "BLOCKED" "$output"

# ---- Test: torque-remote allowed (first token) ----
echo "Test: guard allows torque-remote"
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"torque-remote npx vitest run"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "torque-remote allowed" "EXIT:0" "$output"
assert_not_contains "not blocked" "BLOCKED" "$output"

# ---- Test: non-heavy command allowed ----
echo "Test: guard allows git status"
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"git status"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "git allowed" "EXIT:0" "$output"

# ---- Test: local transport allows everything ----
echo "Test: guard allows on local transport"
cat > "$FAKE_HOME/.torque-remote.json" << 'EOF'
{"version":1,"transport":"local","timeout_seconds":30}
EOF
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"npx vitest run"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "local allows vitest" "EXIT:0" "$output"

# ---- Test: no config allows everything ----
echo "Test: guard allows with no config"
rm -f "$FAKE_HOME/.torque-remote.json"
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"npx vitest run"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "no config allows" "EXIT:0" "$output"

# ---- Test: echo torque-remote && dotnet build is blocked ----
echo "Test: guard blocks tricky recursion bypass"
cat > "$FAKE_HOME/.torque-remote.json" << 'EOF'
{"version":1,"transport":"ssh","timeout_seconds":30}
EOF
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"echo torque-remote && dotnet build"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "tricky bypass blocked" "BLOCKED" "$output"

# ---- Test: cd foo && dotnet build is blocked ----
echo "Test: guard blocks chained commands"
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"cd foo && dotnet build"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "chained blocked" "BLOCKED" "$output"

# ---- Test: custom intercept_commands ----
echo "Test: guard uses custom intercept_commands"
cat > "$FAKE_HOME/.torque-remote.json" << 'EOF'
{"version":1,"transport":"ssh","intercept_commands":["mytest"]}
EOF
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"mytest --verbose"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "custom pattern blocked" "BLOCKED" "$output"
# vitest should NOT be blocked with custom list
output=$(cd "$GUARD_PROJECT" && echo '{"tool_input":{"command":"npx vitest run"}}' | \
  HOME="$FAKE_HOME" "$GUARD" 2>&1; echo "EXIT:$?")
assert_contains "vitest allowed with custom" "EXIT:0" "$output"
```

- [ ] **Step 4: Run all tests**

```bash
bash ~/tests/torque-remote.test.sh
```
Expected: All PASS (runner + guard tests)

---

## Task 3: Global Config Files and Hook Installation

**Files:**
- Create: `~/.torque-remote.json`
- Create: `~/.torque-remote.local.json`
- Modify: `~/.claude/settings.json`

- [ ] **Step 1: Create global config**

Create `~/.torque-remote.json`:

```json
{
  "version": 1,
  "transport": "ssh",
  "sync_before_run": true,
  "timeout_seconds": 300,
  "load_threshold": 80,
  "intercept_commands": [
    "vitest", "jest", "pytest", "mocha",
    "dotnet test", "dotnet build", "dotnet publish",
    "npm test", "npm run build", "npm run test",
    "go test", "go build",
    "cargo build", "cargo test",
    "make", "msbuild", "tsc"
  ]
}
```

- [ ] **Step 2: Create global local config**

Create `~/.torque-remote.local.json` with the Omen details:

```json
{
  "host": "192.0.2.100",
  "user": "user",
  "default_project_path": "C:\\Users\\user\\Projects",
  "key_path": null
}
```

- [ ] **Step 3: Install guard hook in Claude settings**

Read `~/.claude/settings.json`. If it exists, merge the hook. If not, create it. Add:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "torque-remote-guard"
      }]
    }]
  }
}
```

Be careful to merge with existing hooks — don't overwrite.

- [ ] **Step 4: Verify end-to-end on torque-public**

```bash
cd /path/to/torque
torque-remote npx vitest run server/tests/schema-tables.test.js
```
Expected: Routes to Omen, 11 tests pass

- [ ] **Step 5: Verify end-to-end on example-project**

```bash
cd /path/to/example-project
torque-remote dotnet build example-project.sln --nologo -v:q
```
Expected: Routes to Omen, builds successfully

---

## Task 4: TORQUE Integration — `await_task` Verify Routing

**Files:**
- Modify: `server/handlers/workflow/await.js`
- Modify: `server/tests/test-station-routing.test.js`

- [ ] **Step 1: Update await_task verify to use `torque-remote`**

In `server/handlers/workflow/await.js`, find the verify execution block (around line 916). Replace the `torque-test.sh` check with a `torque-remote` on-PATH check:

```javascript
// Check if torque-remote is available on PATH
let hasTorqueRemote = false;
try {
  require('child_process').execFileSync('which', ['torque-remote'], { stdio: 'ignore' });
  hasTorqueRemote = true;
} catch {}

let verifyResult;
if (hasTorqueRemote) {
  verifyResult = executeValidatedCommandSync(
    'torque-remote',
    [args.verify_command],
    {
      profile: 'safe_verify',
      source: 'await_task',
      caller: 'handleAwaitTask',
      cwd,
      timeout: TASK_TIMEOUTS.BUILD_VERIFY || 60000,
      encoding: 'utf8',
    }
  );
} else {
  // Direct execution (backward compatibility)
  verifyResult = executeValidatedCommandSync(
    process.platform === 'win32' ? 'cmd' : 'sh',
    process.platform === 'win32' ? ['/c', args.verify_command] : ['-c', args.verify_command],
    {
      profile: 'safe_verify',
      source: 'await_task',
      caller: 'handleAwaitTask',
      cwd,
      timeout: TASK_TIMEOUTS.BUILD_VERIFY || 60000,
      encoding: 'utf8',
    }
  );
}
```

Apply the same pattern in `handleAwaitWorkflow`'s verify section (around line 680). For `safeExecChain`, prefix the command: `torque-remote <verify_command>`.

Remove the `fs.existsSync(scriptPath)` check for `torque-test.sh` — that's being superseded.

- [ ] **Step 2: Update tests**

In `server/tests/test-station-routing.test.js`, update the `await verify routing` tests to check for `torque-remote` on PATH instead of `scripts/torque-test.sh` existence.

- [ ] **Step 3: Run tests**

```bash
cd /path/to/torque
npx vitest run server/tests/test-station-routing.test.js server/tests/workflow-await.test.js server/tests/await-heartbeat.test.js
```
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add server/handlers/workflow/await.js server/tests/test-station-routing.test.js
git commit -m "feat(remote): await verify routes through torque-remote when on PATH"
```

---

## Task 5: Cleanup — Remove Old `torque-test` Files

**Files:**
- Delete: `scripts/torque-test.sh`
- Delete: `scripts/torque-test-guard.sh`
- Delete: `.torque-test.json`
- Modify: `server/handlers/automation-handlers.js` (remove `writeTestStationConfig`)
- Modify: `CLAUDE.md`
- Modify: `.gitignore`

- [ ] **Step 1: Delete old scripts and config**

```bash
rm -f scripts/torque-test.sh scripts/torque-test-guard.sh .torque-test.json
# Remove scripts/ dir if empty
rmdir scripts/ 2>/dev/null || true
```

- [ ] **Step 2: Remove `writeTestStationConfig` from automation-handlers.js**

In `server/handlers/automation-handlers.js`, remove the `writeTestStationConfig` function and its call from `handleSetProjectDefaults`. Also remove `readJsonSafe` if it was only used by `writeTestStationConfig`. Keep the `test_station_*` DB field handling — those are still used by TORQUE's internal agent-protocol routing.

- [ ] **Step 3: Update CLAUDE.md**

Replace the "Test Execution" section with:

```markdown
## Remote Workstation

Heavy commands (builds, tests, compilation) route to the configured remote workstation automatically.

**Always use `torque-remote` for heavy commands:**
```
torque-remote dotnet build example-project.sln
torque-remote npx vitest run path/to/test
torque-remote cargo build --release
```

The guard hook intercepts direct invocations of build/test commands and redirects to `torque-remote`. If the remote is unreachable or overloaded, `torque-remote` falls back to local execution automatically.

**Configuration:** `~/.torque-remote.json` (global) + `~/.torque-remote.local.json` (personal SSH details). Per-project `.torque-remote.json` for overrides.
```

- [ ] **Step 4: Update `.gitignore`**

Replace `.torque-test.local.json` with `.torque-remote.local.json`:

```
.torque-remote.local.json
```

Remove `.torque-test.local.json` entry.

- [ ] **Step 5: Run all tests**

```bash
npx vitest run server/tests/test-station-routing.test.js server/tests/workflow-await.test.js server/tests/await-heartbeat.test.js
```
Expected: ALL PASS (tests updated for torque-remote)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(remote): replace per-project torque-test with global torque-remote"
```

---

## Dependency Graph

```
Task 1 (torque-remote script) ──┐
Task 2 (guard script) ──────────┼── Task 3 (config + hook install) ── Task 4 (TORQUE integration) ── Task 5 (cleanup)
```

- Tasks 1 and 2 are independent
- Task 3 depends on both (verifies the scripts work end-to-end)
- Task 4 depends on Task 1 (routes through `torque-remote`)
- Task 5 is last (removes old files)
