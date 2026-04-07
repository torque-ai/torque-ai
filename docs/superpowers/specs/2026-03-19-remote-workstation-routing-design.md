# Remote Workstation Routing — Project-Agnostic Command Routing

**Date:** 2026-03-19
**Status:** Draft
**Supersedes:** `docs/superpowers/specs/2026-03-18-test-station-routing-design.md` (test-only routing)

## Problem

Heavy commands (builds, tests, compilation) consume excessive local resources. The previous session's example-project investigation found 66 .NET processes consuming 11 GB of RAM — MSBuild worker nodes that accumulate during development. Users have remote workstations (e.g., Omen with 24 GB VRAM, faster CPU) that are better suited for this work, but routing is inconsistent. The prior `torque-test.sh` solution was per-project, test-only, and required duplicating scripts into every repo.

## Solution

A global `torque-remote` command that routes any command to the configured remote workstation. One install, works across all projects. Smart fallback — runs locally when the remote is unreachable or overloaded. A global Claude Code guard hook redirects heavy commands through the script automatically.

## Design Decisions

- **General-purpose:** Routes any command, not just tests. Builds, tests, compilation, anything heavy.
- **Global install:** Single script at `~/bin/torque-remote` (see Installation section), not copied per-project.
- **Global config with per-project override:** `~/.torque-remote.json` provides defaults. Projects only need `.torque-remote.json` when they differ from the global.
- **Smart fallback:** Remote unreachable or overloaded → warn and run locally. Never block a developer because the remote is down.
- **Sensible defaults with configurable intercept list:** Common heavy commands are intercepted by default. Configurable per-project.
- **Guard redirects, script decides:** The Claude Code hook redirects commands to `torque-remote`. The script checks connectivity and load, then routes or falls back.
- **No personal data in repos:** Host addresses, usernames, key paths live in `~/.torque-remote.local.json` (home dir) or gitignored per-project `.torque-remote.local.json`. Never committed.
- **Remote shell awareness:** SSH to Windows drops into CMD. All remote commands are wrapped appropriately. No bash assumptions on the remote side.

## Installation

### Script location: `~/bin/`

Install `torque-remote` and `torque-remote-guard` to `~/bin/` (expands to `C:\Users\<user>\bin` on Windows). This directory must be on PATH.

**Setup (one-time):**
```bash
mkdir -p ~/bin
# Add to ~/.bashrc if not already there:
export PATH="$HOME/bin:$PATH"
```

Git Bash on Windows reads `~/.bashrc` on startup. Claude Code subagents inherit this PATH.

**Prerequisites:**
- `jq` — required for config parsing. Install via `scoop install jq` or download binary.
- `ssh` — required for SSH transport. Included with Windows 10+ and Git Bash.
- `timeout` — required for command timeout. Included with Git Bash / MSYS2 coreutils.

## Global Script — `torque-remote`

### Usage

```bash
torque-remote dotnet build example-project.sln    # build remotely
torque-remote npx vitest run                   # test remotely
torque-remote make -j8                         # any command
torque-remote                                  # no args → print usage and exit 1
```

Called with no arguments, the script prints usage help and exits non-zero.

### Config resolution (highest priority wins)

1. `.torque-remote.json` in project root (per-project override)
2. `~/.torque-remote.json` (global default)
3. No config → run locally with warning

**Project root detection:** Walk up from CWD looking for `.git` directory. If found, that directory is the project root. If no `.git` found after reaching filesystem root, use CWD.

### Routing decision

1. Read config, determine transport
2. If transport is `local` → execute directly
3. If transport is `ssh`:
   a. Quick connectivity check: `ssh -o ConnectTimeout=5 -o BatchMode=yes ... echo ok`
   b. If unreachable → warn and run locally
   c. Load check (see Load Check section below)
   d. If overloaded → warn and run locally
   e. Sync (if `sync_before_run` is true — see Sync Strategy section)
   f. Execute command on remote
4. Stream stdout/stderr back to caller
5. Exit with the remote command's exit code

### Remote shell handling

SSH to Windows machines drops into CMD by default. The script handles this by sending the command as a single string to SSH, which CMD interprets directly. The `&&` chaining (`cd path && git fetch && command`) works in CMD.

All interpolated values (project paths, branch names, commands) are escaped for CMD safety. Specifically:
- Project paths are wrapped in double quotes: `cd "/path/to\example-project"`
- Branch names are validated to contain only `[a-zA-Z0-9_./-]` characters before interpolation. Invalid branch names abort the sync step with an error.
- The user's command is passed as-is to SSH (it's already a shell command string).

### Sync strategy

Force-checkout instead of `git pull`. The remote is a build/test slave, not a development environment.

```
cd "<remote_project_path>" && git fetch origin && git checkout --force <branch> && git reset --hard origin/<branch>
```

**Branch detection:** `git rev-parse --abbrev-ref HEAD` on the local machine. If HEAD is detached (returns `HEAD`), sync is skipped with a warning: "Detached HEAD — skipping remote sync, remote may have stale code."

If the branch does not exist on the remote (`git checkout` fails), the script warns and skips sync rather than failing the command. The remote may have stale code but the command still runs.

### Remote project path derivation

The global config has `default_project_path` (e.g., `/path/to`). The script derives the remote path: if CWD project root is `~/Projects/example-project`, the remote path is `<default_project_path>\example-project`.

Per-project `.torque-remote.local.json` can override with `remote_project_path` for non-standard locations.

### Load check

Lightweight SSH probe to check CPU usage on the remote. Since the remote may be Windows:

**Windows remote:**
```
ssh ... "wmic cpu get loadpercentage /value"
```
Returns `LoadPercentage=42`. Parse the number, compare against `load_threshold`.

**Linux/Mac remote (future):**
```
ssh ... "cat /proc/loadavg"
```
Parse first field (1-min load average), divide by CPU count for percentage.

**Detection:** The script tries the Windows command first. If it fails (not a Windows machine), tries the Linux command. Caches the OS detection for the session.

**Load threshold:** `load_threshold` is a CPU percentage (0-100). Default 80. If the probe returns a value above the threshold, the script warns and falls back to local.

**Probe failure:** If the load check command itself fails or times out (2-second SSH timeout for the probe), treat as "unknown load" and proceed with remote execution. Don't block on a failed probe.

### Timeout

`timeout ${timeout_seconds} ssh ...` using coreutils timeout (available in Git Bash / MSYS2). Exit code 124 = timeout error with message.

### SSH options

`-o ConnectTimeout=5 -o BatchMode=yes` — no password prompts, fast fail on unreachable hosts.

## Config Files

### File boundary rule

**`.json` files** (committable) contain only behavioral config: transport, timeouts, sync settings, intercept patterns.

**`.local.json` files** (gitignored or in home dir) contain only connection credentials: host, user, key_path, paths. Never behavioral config.

### `~/.torque-remote.json` — Global default (not in any repo)

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

Note: `intercept_commands` (not `blocked_commands`) — these are commands the guard redirects to `torque-remote`, not commands the system refuses to run.

### `~/.torque-remote.local.json` — Global personal details (not in any repo)

```json
{
  "host": "<workstation IP or hostname>",
  "user": "<SSH username>",
  "default_project_path": "<base path to projects on remote>",
  "key_path": null
}
```

### Per-project override: `.torque-remote.json` (in project root, safe to commit)

Only needed when a project differs from global defaults. Fields merge — only specify what's different.

```json
{
  "version": 1,
  "timeout_seconds": 600,
  "sync_before_run": false,
  "intercept_commands": ["dotnet test", "dotnet build"]
}
```

No personal data.

### Per-project `.torque-remote.local.json` (gitignored)

Only needed if a project routes to a different workstation than the global default.

```json
{
  "host": "<different workstation>",
  "user": "<different user>",
  "remote_project_path": "<explicit full path on remote>"
}
```

### Config merge order

Per-project fields override global fields. `intercept_commands` is replaced (not merged) when specified per-project. All other fields merge individually. Local files only contain connection credentials — never behavioral config.

### Version handling

If `version` is missing or unrecognized, the script warns ("Unknown config version, proceeding with best effort") but does not refuse to run. Forward-compatible by default.

## Guard Hook — Global `PreToolUse`

A single hook in `~/.claude/settings.json` that applies to all projects.

### Installation

Add to `~/.claude/settings.json`:

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

### Guard script: `~/bin/torque-remote-guard`

**Behavior:**
1. Find project root (walk up from CWD looking for `.git`)
2. Find config — check `.torque-remote.json` in project root, fall back to `~/.torque-remote.json`
3. If no config or transport is `local` → exit 0 (allow)
4. Read `intercept_commands` from config
5. Parse the Bash tool's command from stdin JSON (`tool_input.command`)
6. If command matches an intercept pattern (see Matching Algorithm) AND the first token is not `torque-remote` → exit 2 with redirect message
7. Otherwise → exit 0 (allow)

### Matching algorithm

For each pattern in `intercept_commands`:
- Split the command string into tokens
- Single-word patterns (e.g., `vitest`, `jest`, `tsc`): match if any token equals the pattern exactly (word boundary match)
- Multi-word patterns (e.g., `dotnet test`, `npm run build`): match if the pattern appears as a consecutive token sequence anywhere in the command

This avoids false positives:
- `dotnet test-utils` does NOT match `dotnet test` (tokens: `dotnet`, `test-utils`)
- `echo "dotnet build"` does NOT match (the quoted string is one token)
- `cd foo && dotnet build` DOES match (`dotnet`, `build` appear as consecutive tokens)

### Recursion guard

The guard checks if the **first token** of the command is `torque-remote`. This is more precise than substring matching — `echo torque-remote && dotnet build` would correctly be blocked because the first token is `echo`, not `torque-remote`.

### JSON parsing

The guard requires `jq` to parse stdin. If `jq` is not available, the guard exits with a warning on stderr ("torque-remote-guard: jq not found, guard disabled") and exit code 0 (allow). This is a degraded mode — `jq` should be installed as a prerequisite.

### Redirect message (stderr)

```
BLOCKED: "dotnet build" should run on the remote workstation.

Use:  torque-remote dotnet build example-project.sln

The remote workstation handles heavy builds/tests. If it's unreachable,
torque-remote will automatically fall back to local execution.
```

## TORQUE Integration

### `await_task` / `await_workflow` verify

Check if `torque-remote` is on PATH using `which torque-remote` (bash) or `where torque-remote` (cmd). If found, route verify commands through it:

```javascript
const { execFileSync } = require('child_process');
let hasRemote = false;
try {
  execFileSync('which', ['torque-remote'], { stdio: 'ignore' });
  hasRemote = true;
} catch {}

if (hasRemote) {
  // Route: torque-remote <verify_command>
  executeValidatedCommandSync('torque-remote', [args.verify_command], { ... });
} else {
  // Direct execution (backward compatibility)
  executeValidatedCommandSync(shell, [shellFlag, args.verify_command], { ... });
}
```

### `set_project_defaults` cleanup

Remove the `writeTestStationConfig` function added in the prior test-station-routing implementation. The `test_station_*` DB fields remain for TORQUE's internal agent-protocol routing (auto-verify-retry). File writing is no longer needed — the global config handles routing for scripts and subagents.

## Migration from `torque-test`

| Old | New |
|-----|-----|
| `scripts/torque-test.sh` per project | `~/bin/torque-remote` global |
| `scripts/torque-test-guard.sh` per project | `~/bin/torque-remote-guard` global |
| `.torque-test.json` per project | `~/.torque-remote.json` global (or `.torque-remote.json` per project) |
| `.torque-test.local.json` per project | `~/.torque-remote.local.json` global |
| Per-project `.claude/settings.json` hook | Global `~/.claude/settings.json` hook |
| CLAUDE.md references `torque-test.sh` | CLAUDE.md references `torque-remote` |

**Cleanup:** Remove `scripts/torque-test.sh`, `scripts/torque-test-guard.sh`, `.torque-test.json`, `.torque-test.local.json` from torque-public after global install is working.

## CLAUDE.md Update

Replace test-specific rules with general remote workstation rules:

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

## Known Limitations

- **Concurrent execution:** Two simultaneous `torque-remote` invocations can race on the sync step (one force-checkouts while the other is mid-build). This is uncommon in practice and does not need solving at launch. Users running heavy parallel workloads should disable `sync_before_run` and manage sync manually.
- **Detached HEAD:** Sync is skipped when the local repo has a detached HEAD. The remote may have stale code.
- **Remote dirty state:** Force-checkout discards any local changes on the remote. The remote should not be used for development — only as a build/test slave.

## Files Created/Modified

| File | Action | Location | Responsibility |
|------|--------|----------|---------------|
| `~/bin/torque-remote` | Create | Global | Route commands to remote workstation |
| `~/bin/torque-remote-guard` | Create | Global | Guard hook — redirect intercepted commands |
| `~/.claude/settings.json` | Modify | Global | Install guard hook |
| `~/.torque-remote.json` | Create | Global | Default routing config |
| `~/.torque-remote.local.json` | Create | Global | Personal SSH details |
| `server/handlers/workflow/await.js` | Modify | torque-public | Route verify through `torque-remote` |
| `server/handlers/automation-handlers.js` | Modify | torque-public | Remove `writeTestStationConfig` |
| `CLAUDE.md` | Modify | torque-public | Update routing docs |
| `scripts/torque-test.sh` | Delete | torque-public | Superseded |
| `scripts/torque-test-guard.sh` | Delete | torque-public | Superseded |
| `.torque-test.json` | Delete | torque-public | Superseded |

## Testing Strategy

### Script tests
- `torque-remote` with local transport executes directly
- `torque-remote` with no config runs locally with warning
- `torque-remote` with no arguments prints usage and exits 1
- `torque-remote` derives remote project path from CWD + `default_project_path`
- Per-project config overrides global
- Connectivity check failure falls back to local with warning
- Load threshold exceeded falls back to local with warning
- Load check probe failure (timeout/error) proceeds with remote
- Sync uses force-checkout, not git pull
- Detached HEAD skips sync with warning
- Branch name validation rejects metacharacters
- Timeout exits with code 124
- Version mismatch warns but proceeds

### Guard tests
- Intercepted command (`dotnet build`) is redirected (exit 2)
- Command via `torque-remote` is allowed (exit 0, first-token check)
- `echo torque-remote && dotnet build` is correctly blocked (first token is `echo`)
- Non-intercepted command (`git status`) is allowed
- No config = allow everything
- Local transport = allow everything
- Custom `intercept_commands` per-project respected
- Multi-word pattern (`npm run build`) matches consecutive tokens
- Single-word pattern (`vitest`) matches exact token, not substring
- Missing jq warns and allows (degraded mode)

### TORQUE integration tests
- `await_task` verify uses `torque-remote` when on PATH
- `await_task` verify falls back to direct execution when not on PATH

### End-to-end
- Configure global workstation, run `torque-remote npx vitest run` from torque-public, verify routes to Omen
- Configure global workstation, run `torque-remote dotnet build` from example-project, verify routes to Omen
- Disconnect Omen, verify fallback to local with warning
