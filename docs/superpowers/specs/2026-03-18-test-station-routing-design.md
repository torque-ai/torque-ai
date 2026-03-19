# Test Station Routing — Consistent Test Execution

**Date:** 2026-03-18
**Status:** Draft

## Problem

Tests should always run on the user's designated test station, but they don't consistently. TORQUE's internal verify commands (auto-verify-retry, auto_verify_and_fix) respect the `prefer_remote_tests` config, but two major paths bypass it:

1. **`await_task` verify** — runs locally via `executeValidatedCommandSync()`, ignores remote test routing entirely.
2. **Claude Code subagents** — dispatched agents that run `npx vitest` execute locally on the Claude Code host, completely outside TORQUE's control.

Users who configure a test station expect all test execution to go there. The current system silently violates this expectation.

## Solution

Three changes that converge all test execution paths onto the configured test station:

1. **Config files** — `.torque-test.json` (shared, checked in) + `.torque-test.local.json` (personal, gitignored) define the test station per project.
2. **Test runner script** — `scripts/torque-test.sh` reads the config and routes execution. Single entry point for all test execution.
3. **Wiring** — TORQUE's `await_task` verify and `set_project_defaults` use the config files. CLAUDE.md and plans instruct agents to use the script.

## Design Decisions

- **Two config files:** Shared config (transport, command, timeout) is versioned. Personal data (host, user, key) is gitignored. No credentials in version control.
- **Test runner script per project:** Transparent, readable, works without TORQUE running. Agents can inspect it to understand routing.
- **Pluggable transport:** Config specifies `transport` field (`ssh`, `agent`, `local`). Only `ssh` and `local` implemented initially. Extensible for Docker, WSL, cloud VMs without redesign.
- **Three-layer enforcement:** CLAUDE.md rules (soft), plan-level instructions (soft), Claude Code `PreToolUse` hook (hard). The hook blocks direct test runner invocations and redirects to the test runner script.
- **`set_project_defaults` writes both DB and files:** Keeps TORQUE internal routing (DB) and script routing (files) in sync. Also installs the guard hook when a test station is configured.

## Config Files

### `.torque-test.json` — Checked into repo

```json
{
  "transport": "ssh",
  "verify_command": "npx vitest run",
  "timeout_seconds": 300,
  "sync_before_run": true
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `transport` | string | `"local"` | `"ssh"`, `"agent"`, or `"local"`. Only `ssh` and `local` implemented initially. |
| `verify_command` | string | required | The test command to execute. |
| `timeout_seconds` | number | 300 | Max execution time. |
| `sync_before_run` | boolean | true | Whether to `git pull` on the remote before running tests. |

### `.torque-test.local.json` — Gitignored, personal

```json
{
  "host": "192.168.1.183",
  "user": "kenten",
  "project_path": "/c/Users/kenten/Projects/torque-public",
  "key_path": null
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | string | required (for ssh) | SSH host address. |
| `user` | string | required (for ssh) | SSH username. |
| `project_path` | string | required (for ssh) | Absolute path to the project on the remote host. |
| `key_path` | string | null | Path to SSH private key. Null uses SSH agent / default key. |

### Merging Behavior

The test runner reads `.torque-test.json` first, then merges `.torque-test.local.json` on top. If `transport` is `"ssh"` but no `.torque-test.local.json` exists, the script exits with a clear error:

```
Error: Transport is "ssh" but .torque-test.local.json not found.
Run: set_project_defaults { host: "...", user: "...", project_path: "..." }
Or create .torque-test.local.json manually.
```

If no `.torque-test.json` exists at all, the script runs the command locally (implicit `transport: "local"`).

## Test Runner Script

### `scripts/torque-test.sh`

Single entry point for all test execution. All paths — subagents, manual runs, TORQUE verify commands — go through this script.

**Usage:**
```bash
./scripts/torque-test.sh                              # runs default verify_command
./scripts/torque-test.sh "npx vitest run src/foo"      # runs specific test
```

**Behavior:**
1. Read `.torque-test.json` from the script's project root
2. Read `.torque-test.local.json` if present
3. Determine command: first argument overrides `verify_command` from config
4. Based on `transport`:
   - `"local"` — execute command directly in the project directory
   - `"ssh"` — SSH to host, optionally `git pull`, execute command in `project_path`
5. Stream stdout/stderr through to caller
6. Exit with the test command's exit code

**Arguments:** The command is passed as positional arguments (not embedded in a quoted string) to avoid shell quoting issues:

```bash
./scripts/torque-test.sh npx vitest run src/foo.test.js
# Script receives: "$@" = "npx vitest run src/foo.test.js"
# If no arguments: falls back to verify_command from config
```

**SSH execution:**
```bash
ssh_cmd="cd ${project_path}"
if [ "$sync_before_run" = "true" ]; then
  ssh_cmd="${ssh_cmd} && git pull --quiet"
fi
ssh_cmd="${ssh_cmd} && ${command}"

ssh_opts="-o ConnectTimeout=10"
if [ -n "$key_path" ]; then
  ssh_opts="${ssh_opts} -i ${key_path}"
fi

timeout "${timeout_seconds}" ssh ${ssh_opts} "${user}@${host}" "$ssh_cmd"
exit_code=$?

# timeout exits 124 on timeout
if [ $exit_code -eq 124 ]; then
  echo "Error: Test execution timed out after ${timeout_seconds}s" >&2
fi
exit $exit_code
```

**Timeout mechanism:** Uses `timeout` from coreutils (available in Git Bash / MSYS2 on Windows, native on Linux/Mac). Sends SIGTERM to the SSH process, which propagates to the remote command. The `ConnectTimeout=10` prevents hanging on unreachable hosts.

**Error handling:**
- Missing `.torque-test.json` — run locally with a warning
- Missing `.torque-test.local.json` when transport is `ssh` — error with setup instructions
- SSH connection failure — exit with error, do not fall back to local (user explicitly configured remote — silent local fallback would hide the problem)
- `git pull` failure (merge conflict, network error) — treated as test failure. The `&&` chaining prevents the test command from running on stale code. The git error message is surfaced to the caller. Users should ensure the remote has a clean working tree (or disable `sync_before_run`).
- Command timeout — `timeout` kills the SSH process (exit code 124), script reports timeout error

**Cross-platform:** Bash script. On Windows, runs in Git Bash / MSYS2 (the shell Claude Code and TORQUE subagents use).

**Known limitations (by design, not addressed at launch):**
- Branch alignment: the script does not check out a matching branch on the remote. If the local is on `feature-x` but the remote is on `main`, tests run against different code. Users should ensure the remote tracks the same branch or disable `sync_before_run` and manage sync manually.
- Concurrent execution: two simultaneous test runs on the same remote can race on `git pull`. This is rare in practice and does not need solving at launch.

## TORQUE Integration

### A. `await_task` verify command

**File:** `server/handlers/workflow/await.js` (lines ~900-928)

Currently executes verify commands locally via `executeValidatedCommandSync()`. The function signature is `executeValidatedCommandSync(binary, args, options)` — it takes a binary and args array, not a single command string.

Change to check for `scripts/torque-test.sh` and route through it:

```javascript
const scriptPath = path.join(workingDir, 'scripts', 'torque-test.sh');
if (fs.existsSync(scriptPath)) {
  // Route through test runner — pass verify command as arguments
  const binary = process.platform === 'win32' ? 'bash' : 'sh';
  const args = [scriptPath, ...verifyCommand.split(/\s+/)];
  executeValidatedCommandSync(binary, args, { cwd: workingDir, ... });
} else {
  // Backward compatibility — direct execution
  executeValidatedCommandSync(shell, [shellFlag, verifyCommand], { cwd: workingDir, ... });
}
```

No shell quoting issues — the command is passed as separate array elements, not string-concatenated.

### B. `set_project_defaults` writes config files

**File:** `server/handlers/automation-handlers.js` (lines 540-638)

When `set_project_defaults` is called with test-related fields, write/update the config files in `working_directory`:

- `verify_command` → write to `.torque-test.json` `verify_command` field
- New fields `test_station_host`, `test_station_user`, `test_station_project_path`, `test_station_key_path` → write to `.torque-test.local.json`. These are explicit SSH fields provided by the user — NOT derived from `remote_agent_id` (the agent registry stores HTTP protocol details, not SSH credentials).
- `prefer_remote_tests: true` + any `test_station_*` field → set `transport: "ssh"` in `.torque-test.json`

The existing `remote_agent_id` / `prefer_remote_tests` / `remote_project_path` fields continue to drive TORQUE's internal agent-protocol routing (auto-verify-retry). The new `test_station_*` fields drive the SSH-based test runner script. Users who want both paths to route to the same machine configure both sets of fields.

Also add `.torque-test.local.json` to `.gitignore` if not already present.

### Config file versioning

Both files include a `"version": 1` field for future migration support:

```json
{
  "version": 1,
  "transport": "ssh",
  "verify_command": "npx vitest run",
  ...
}
```

### C. Existing `remote-test-routing.js` unchanged

The auto-verify-retry pipeline reads from the DB config and routes through its own agent protocol. This continues working as-is. The DB config and file config stay in sync because `set_project_defaults` writes both.

## Enforcement — Three Layers

### Layer 1: CLAUDE.md rule (soft)

Add to each project's CLAUDE.md:

```markdown
## Test Execution
- **NEVER run test commands directly** (npx vitest, npm test, jest, etc.)
- **ALWAYS use `./scripts/torque-test.sh`** — routes tests to the configured test station
- To run a specific test: `./scripts/torque-test.sh npx vitest run path/to/test.js`
- To run all tests: `./scripts/torque-test.sh`
```

### Layer 2: Plan-level instruction (soft)

Implementation plans reference the script in every test step:

```bash
./scripts/torque-test.sh npx vitest run server/tests/foo.test.js
```

### Layer 3: Claude Code hook (hard enforcement)

A `PreToolUse` hook on the `Bash` tool that intercepts direct test runner invocations and blocks them with an error message pointing to the test runner script.

**Hook configuration** (in project `.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "scripts/torque-test-guard.sh"
          }
        ]
      }
    ]
  }
}
```

**Guard script** (`scripts/torque-test-guard.sh`):

A small script that receives the Bash tool's `command` parameter via stdin (JSON), extracts the command string, and checks if it contains a direct test runner invocation (`vitest`, `jest`, `npm test`, `npx test`, `mocha`, `pytest`, etc.) that is NOT wrapped in `torque-test.sh`.

**Detection logic:**
```bash
# Read the tool input JSON from stdin
command=$(cat | jq -r '.tool_input.command // empty')

# Check if it's a direct test command NOT going through torque-test.sh
if echo "$command" | grep -qE '(vitest|jest|npm test|npx test|mocha|pytest)' && \
   ! echo "$command" | grep -q 'torque-test'; then
  echo "BLOCKED: Direct test execution detected. Use ./scripts/torque-test.sh instead." >&2
  echo "Example: ./scripts/torque-test.sh npx vitest run path/to/test.js" >&2
  exit 2
fi

exit 0
```

**Behavior:**
- Exit 0 → allow the command
- Exit 2 → block the command with the error message
- The agent sees the error, adjusts, and re-runs via `torque-test.sh`

**When the hook activates:** Only in projects that have `.torque-test.json` with a non-local transport. If no config file exists or transport is `"local"`, the hook allows direct execution (no test station configured = no routing needed).

**`set_project_defaults` installs the hook** when test station is configured. Writes `.claude/settings.json` in the project directory with the hook config and creates `scripts/torque-test-guard.sh`.

## Files Modified/Created

| File | Action | Responsibility |
|------|--------|---------------|
| `scripts/torque-test.sh` | Create | Test runner script — reads config, routes execution |
| `scripts/torque-test-guard.sh` | Create | Hook guard — blocks direct test invocations |
| `server/handlers/automation-handlers.js` | Modify | `set_project_defaults` writes `.torque-test.json` + `.torque-test.local.json` |
| `server/handlers/workflow/await.js` | Modify | `await_task` verify routes through test runner script |
| `CLAUDE.md` | Modify | Add test execution rules |
| `.gitignore` | Modify | Add `.torque-test.local.json` |
| `.claude/settings.json` | Create (per project) | Hook config for test guard |

## Testing Strategy

### Test runner script
- Unit test: `transport: "local"` executes command directly
- Unit test: `transport: "ssh"` constructs correct SSH command with timeout
- Unit test: missing `.torque-test.local.json` with ssh transport produces clear error
- Unit test: missing `.torque-test.json` falls back to local execution with warning
- Unit test: positional arguments override `verify_command` from config
- Unit test: `sync_before_run: false` skips git pull in SSH command
- Unit test: `key_path` is included in SSH command when set
- Unit test: timeout exits with code 124 and error message

### Guard hook
- Unit test: direct `vitest` command is blocked (exit 2)
- Unit test: direct `jest` command is blocked
- Unit test: direct `npm test` command is blocked
- Unit test: `torque-test.sh vitest run` is allowed (exit 0)
- Unit test: non-test commands (git, node, etc.) are allowed
- Unit test: hook passes through when no `.torque-test.json` exists or transport is "local"

### TORQUE integration
- Unit test: `set_project_defaults` writes both config files
- Unit test: `set_project_defaults` adds `.torque-test.local.json` to `.gitignore`
- Unit test: `set_project_defaults` installs hook config when test station configured
- Unit test: `await_task` verify uses test runner script when it exists
- Unit test: `await_task` verify falls back to direct execution when script doesn't exist

### Integration
- Integration test: full flow — configure station, run test via script, verify it routes correctly
- Integration test: agent blocked by hook, adjusts to use torque-test.sh
