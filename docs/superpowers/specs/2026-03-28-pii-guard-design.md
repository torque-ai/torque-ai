# PII Guard — Design Spec

**Date:** 2026-03-28
**Status:** Approved

## Problem

AI-assisted development naturally leaks personal data into codebases — usernames in file paths, LAN IPs in examples, machine names in docs, email addresses in comments. This happens across Claude Code direct writes, TORQUE task outputs, and manual edits. The result: every file must be audited before public release.

## Solution

A three-layer PII guard that auto-fixes personal data before it reaches the repository. All layers share a single pattern engine and per-project configuration stored in TORQUE's existing `project_tuning` database.

**Behavior:** Always block. Auto-replace PII with safe placeholders silently. No warnings, no overrides — clean habits everywhere.

## Architecture

```
┌─────────────────────────────────────────────┐
│              PII Pattern Engine              │
│  (server/utils/pii-guard.js)                │
│                                             │
│  Built-in: paths, IPs, emails, hostnames    │
│  Custom: per-project via set_project_defaults│
│  Action: detect → auto-replace → return     │
├─────────────────────────────────────────────┤
│                                             │
│  Layer 1: TORQUE Output Safeguards          │
│  (post-task, before file write)             │
│                                             │
│  Layer 2: Claude Code PreToolUse Hook       │
│  (before Write/Edit tool execution)         │
│                                             │
│  Layer 3: Git Pre-Commit Hook               │
│  (scans staged files, auto-fixes, restages) │
│                                             │
└─────────────────────────────────────────────┘
```

## PII Pattern Engine

**Location:** `server/utils/pii-guard.js`

**API:**
```js
scanAndReplace(text, {
  builtinOverrides: { emails: false },  // opt out of specific categories
  customPatterns: [{ pattern: 'BahumutsOmen', replacement: 'example-host' }]
}) → { clean: bool, sanitized: string, findings: [{ category, match, line }] }
```

### Built-in Categories (all on by default)

**user_paths** — Windows, Linux, Mac user directories:
- `C:\Users\<name>\...` → `C:\Users\<user>\...`
- `/home/<name>/...` → `/home/<user>/...`
- `/Users/<name>/...` → `/Users/<user>/...`
- Preserves the path after the username segment.

**private_ips** — RFC 1918 private addresses → RFC 5737 documentation addresses:
- `192.168.x.x` → `192.0.2.x` (preserves last octet for distinguishability)
- `10.x.x.x` → `10.0.0.x` (preserves last octet)
- `172.16-31.x.x` → `172.16.0.x` (preserves last octet)

**emails** — Real email addresses → `user@example.com`:
- Skips already-safe domains: `example.com`, `test.com`
- Skips `noreply@` prefixes (preserves Co-Authored-By lines)

**hostnames** — System hostname → `example-host`:
- Auto-detected via `os.hostname()` at server startup
- No manual configuration needed

### Custom Patterns

Defined per-project via `set_project_defaults`. Each entry:
```json
{ "pattern": "Werem", "replacement": "<user>" }
```
- Literal string match by default
- Add `"regex": true` for regex mode
- Run after built-in patterns

### Pattern Regex Details

```js
// user_paths
/C:\\\\Users\\\\([^\\\\]+)/g  →  'C:\\Users\\<user>'
/\/home\/([^/]+)/g            →  '/home/<user>'
/\/Users\/([^/]+)/g           →  '/Users/<user>'

// private_ips (preserves last octet)
/192\.168\.\d+\.(\d+)/g               →  '192.0.2.$1'
/\b10\.\d+\.\d+\.(\d+)/g             →  '10.0.0.$1'
/\b172\.(1[6-9]|2\d|3[01])\.\d+\.(\d+)/g  →  '172.16.0.$2'

// emails (skip safe domains)
/[a-zA-Z0-9._%+-]+@(?!example\.com|test\.com|noreply)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  →  'user@example.com'

// hostnames (populated dynamically from os.hostname())
```

## Layer 1: TORQUE Output Safeguards

**Integration point:** `server/validation/output-safeguards.js`, in the existing post-task validation pipeline.

**When:** After a task completes, before results are written to the working directory.

**Flow:**
1. Task output text passes through `scanAndReplace()`
2. PII found → auto-replace in output before file writes proceed
3. Findings logged to TORQUE structured logger (audit trail)
4. No task failure — task result is valid, just sanitized

**Covers:** All providers (Ollama, Codex, DeepInfra, Claude CLI, etc.) since all flow through the same completion pipeline.

## Layer 2: Claude Code PreToolUse Hook

**Hook type:** Claude Code `PreToolUse` hook on `Write` and `Edit` tools.

**When:** Before Claude writes or edits any file directly (outside of TORQUE tasks).

**Flow:**
1. Hook receives file content (`Write`) or `new_string` (`Edit`)
2. Calls TORQUE REST API: `POST /api/pii-scan` with text + working directory
3. PII found → returns sanitized version as replacement, hook passes
4. Claude Code proceeds with cleaned content

**Installation:** Added to `~/.claude/settings.json` hooks section alongside existing `torque-remote-guard`. The hook script lives at `scripts/pii-claude-hook.sh` (or `.js`). For `Write`, it scans the full content body. For `Edit`, it scans the `new_string` parameter. If the API returns `clean: false`, the hook rewrites the tool input with the sanitized text before Claude Code executes it.

## Layer 3: Git Pre-Commit Hook

**Location:** `.git/hooks/pre-commit` (installed per-repo)

**When:** Before every `git commit`.

**Flow:**
1. Get staged files: `git diff --cached --name-only`
2. For each staged file, read content and call `POST /api/pii-scan`
3. PII found → auto-fix file on disk, re-stage with `git add`, log what changed
4. Commit proceeds with sanitized files

**Offline fallback:** If TORQUE server is unreachable, the hook falls back to a built-in regex scan using the same patterns hardcoded in the script. The guard never silently disappears.

**Binary files:** Skipped (images, fonts, etc. detected by file extension).

## REST API Endpoint

```
POST /api/pii-scan
Content-Type: application/json

Request:
{
  "text": "...",
  "working_directory": "C:\\Users\\Werem\\Projects\\torque-public"
}

Response:
{
  "clean": false,
  "sanitized": "...",
  "findings": [
    { "category": "user_paths", "match": "C:\\Users\\Werem", "line": 17 },
    { "category": "custom", "match": "BahumutsOmen", "line": 42 }
  ]
}
```

Working directory is required to look up the correct project's custom patterns from the DB.

## Configuration

Extends `set_project_defaults` with a `pii_guard` object:

```js
set_project_defaults({
  working_directory: "C:\\Users\\Werem\\Projects\\torque-public",
  pii_guard: {
    enabled: true,
    builtin_categories: {
      user_paths: true,
      private_ips: true,
      emails: true,
      hostnames: true
    },
    custom_patterns: [
      { "pattern": "Werem", "replacement": "<user>" },
      { "pattern": "Kenten", "replacement": "<user>" },
      { "pattern": "BahumutsOmen", "replacement": "example-host" },
      { "pattern": "SpudgetBooks", "replacement": "example-project" },
      { "pattern": "DLPhone", "replacement": "example-project" }
    ]
  }
})
```

- Stored in existing `project_tuning` table
- Retrieved by all three layers via `get_project_defaults`
- No new MCP tools — uses existing `set_project_defaults` / `get_project_defaults`

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `server/utils/pii-guard.js` | Create | Core pattern engine |
| `server/utils/pii-guard.test.js` | Create | Engine unit tests |
| `server/validation/output-safeguards.js` | Modify | Add PII scan to post-task pipeline |
| `server/api/routes.js` or equivalent | Modify | Add `POST /api/pii-scan` endpoint |
| `server/handlers/pii-handlers.js` | Create | Handler for REST endpoint |
| `server/db/project-tuning.js` | Modify | Support `pii_guard` in project defaults |
| `scripts/pii-pre-commit.sh` | Create | Git pre-commit hook with offline fallback |
| `scripts/pii-hook-install.sh` | Create | Installer that symlinks/copies hook |
| Claude Code hook script | Create | PreToolUse hook calling `/api/pii-scan` |

## Testing

- Engine unit tests: each built-in category, custom patterns, edge cases (already-safe text, binary-like content, empty input)
- Integration test: output-safeguards pipeline with PII in task output
- REST endpoint test: scan request/response, missing working_directory, TORQUE not running
- Pre-commit hook test: mock git staged files with PII, verify auto-fix + restage
- Negative tests: safe text passes through unchanged, noreply@ emails preserved, RFC 5737 IPs not double-replaced
