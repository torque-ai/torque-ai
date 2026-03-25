# User-Scoped MCP Config Injection (Auth Roadmap Layer 1)

**Date:** 2026-03-25
**Status:** Draft
**Author:** Claude + Werem

## Problem

TORQUE MCP tools are only available in projects that have a `.mcp.json` pointing to the TORQUE SSE endpoint with an API key. Users must manually:

1. Copy `.mcp.json` into each project directory, or configure `~/.claude/.mcp.json`
2. Set the `TORQUE_API_KEY` environment variable
3. Restart Claude Code

This means opening Claude Code in a new project directory — one that has never used TORQUE — results in no TORQUE tools being available. The user has to stop, configure, and restart before they can work.

## Solution

At server startup, TORQUE auto-injects its MCP server entry into the current OS user's `~/.claude/.mcp.json`. The API key is baked directly into the URL — no environment variable needed. The injection is idempotent: it only writes when the entry is missing or the key has changed.

After this change, any Claude Code session started by the user who ran the TORQUE server will have TORQUE tools available immediately, in any project directory.

## Design

### Injection Logic

A new module `server/auth/mcp-config-injector.js` with a single public function:

```js
/**
 * Ensure the current user's ~/.claude/.mcp.json contains a torque SSE entry
 * with the current API key. Merges non-destructively — other MCP servers
 * are preserved. Only writes if the entry is missing or the key changed.
 *
 * @param {string} apiKey - The plaintext API key to bake into the URL
 * @param {object} [options]
 * @param {number} [options.ssePort=3458] - SSE port (read from serverConfig after init)
 * @param {string} [options.host='127.0.0.1'] - Server host
 * @returns {{ injected: boolean, path: string, reason: string }}
 */
function ensureGlobalMcpConfig(apiKey, options)
```

### Key Sourcing

The plaintext API key is only available at two moments:

1. **Bootstrap creation** — the `key` variable is in scope inside the `if (!keyManager.hasAnyKeys())` block in `index.js`.
2. **On disk** — the `.torque-api-key` file in the data directory, written at bootstrap time with `mode: 0o600`.

On subsequent server restarts (non-bootstrap), the key must be read back from the `.torque-api-key` file. The injector reads the file directly:

```js
const keyFilePath = path.join(dataDir, '.torque-api-key');
let apiKey;
try {
  apiKey = fs.readFileSync(keyFilePath, 'utf-8').trim();
} catch {
  // No key file — skip injection (open mode or failed bootstrap)
  return;
}
```

**Recovery for missing key file:** If the bootstrap key write failed (disk full, permission error), the key file won't exist on subsequent restarts. The injector skips silently. The user can fix this by deleting the database and restarting (triggers a fresh bootstrap). This is an accepted edge case — the key file write has been reliable since the feature shipped.

### Integration Point

Called in `server/index.js` **after `serverConfig.init({ db })`** (around line 583+), not inside the auth init block. This is critical because the SSE port may be overridden in the database config, and `serverConfig` must be initialized before we can read it.

```
db.init()
  → auth init (lines 525-563)
    → key-manager.init()
    → migrateConfigApiKey()
    → bootstrap key creation (if no keys exist)
    → write .torque-api-key file
  → DI container registration (line 569)
  → serverConfig.init({ db }) (line 583)
  → NEW: ensureGlobalMcpConfig()   ← here (reads key from file, port from serverConfig)
```

The injector reads the SSE port from `serverConfig.getInt('mcp_sse_port', 3458)` to ensure non-default ports are correctly injected.

### Read-Merge-Write Flow

```
1. Resolve config path: path.join(os.homedir(), '.claude', '.mcp.json')
2. Read existing file (or default to {"mcpServers": {}})
3. Parse JSON — if parse fails, log warning and abort (don't destroy user's file)
4. Build expected URL: `http://{host}:{ssePort}/sse?apiKey={apiKey}`
5. Compare: if mcpServers.torque exists AND mcpServers.torque.url === expected URL → skip
6. Merge: spread existing mcpServers.torque fields, then overlay type + url + description
   (preserves any user-added fields like headers or timeout)
7. Write to temp file + atomic rename (prevents corruption from concurrent starts)
8. Log: "[MCP Config] Injected TORQUE entry into {configPath}"
```

Step 6 detail — merge, not replace:
```js
data.mcpServers.torque = {
  ...(data.mcpServers.torque || {}),  // preserve user-added fields
  type: 'sse',
  url: expectedUrl,
  description: 'TORQUE - Task Orchestration System with local LLM routing',
};
```

### Safety Rules

| Rule | Rationale |
|------|-----------|
| Never overwrite the entire file | Other MCP servers must be preserved |
| Abort on JSON parse failure | Don't corrupt a file we can't understand |
| Skip if entry URL matches | Avoid unnecessary writes and file-change noise |
| Merge over existing entry, don't replace | Preserve user-added fields (headers, timeout, etc.) |
| Create `~/.claude/` directory if missing | New installs may not have it yet |
| Log but don't throw on failure | MCP config injection is best-effort — server must start regardless |
| Atomic write (temp + rename) | Prevent corruption from concurrent TORQUE starts |
| File permissions: 0o600 on Unix, icacls on Windows | Key is in the URL — restrict read access to file owner |

### File Permissions

**Unix (Linux/macOS):** `fs.writeFileSync(path, data, { mode: 0o600 })` — standard POSIX owner-only read/write.

**Windows:** `fs.chmodSync` is a no-op on Windows. After writing, call:
```js
if (process.platform === 'win32') {
  try {
    execFileSync('icacls', [configPath, '/inheritance:r', '/grant:r',
      `${process.env.USERNAME}:(F)`], { stdio: 'pipe', windowsHide: true });
  } catch { /* best-effort */ }
}
```
This matches the pattern already used in `database.js` (line 473) for the database file.

### Cleanup

- Delete `torque-public/.mcp.json` (the project-local config). It's redundant with the global config.
- `.mcp.json.example` stays as documentation for manual setup and for contributors who haven't started TORQUE yet.
- `.mcp.json` is already in `.gitignore`.
- Update CLAUDE.md setup instructions to remove the manual `.mcp.json` copy step.

### URL Format

The injected entry:

```json
{
  "torque": {
    "type": "sse",
    "url": "http://127.0.0.1:3458/sse?apiKey=torque_sk_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "description": "TORQUE - Task Orchestration System with local LLM routing"
  }
}
```

The key is the literal plaintext value, not an env var reference. This eliminates the `${TORQUE_API_KEY}` setup step entirely.

### Security: Key in URL

The API key appears as a query parameter in the SSE URL. This is the same pattern already used in the project-local `.mcp.json` (via `${TORQUE_API_KEY}` expansion) and in the existing SSE auth flow. Known tradeoffs:

- **File access:** Mitigated by 0o600 permissions (Unix) and icacls (Windows).
- **URL logging:** TORQUE's SSE endpoint logs connection events but redacts the `apiKey` query parameter. The existing `mcp-protocol.js` already handles this.
- **Long-lived credential:** The key is permanent until revoked. This is an accepted tradeoff for Layer 1 (single-user). Layer 2 (multi-user) may introduce short-lived session tokens via the SSE ticket flow documented in `server/docs/investigations/mcp-sse-auth-gap.md`.

### Key Rotation

If the API key changes (user revokes and creates a new one, or the `.torque-api-key` file is regenerated), the next server restart detects the URL mismatch and updates the global config. No manual intervention needed.

### When Injection Does NOT Run

- If the `.torque-api-key` file doesn't exist (server has no bootstrap key — open mode, or failed first-run write)
- If `os.homedir()` is unresolvable
- If `~/.claude/.mcp.json` exists but can't be parsed as JSON (corrupted — don't make it worse)

In all cases, the server starts normally. The injection is best-effort.

### External Dependency

The target path `~/.claude/.mcp.json` is Claude Code's convention for global MCP server configuration. This is not part of the MCP specification — it is an Anthropic-specific convention. If Claude Code changes this path in a future release, the injector will silently write to the old location. The injector logs the exact path on success so failures are diagnosable. If this path changes, the constant in `mcp-config-injector.js` is the single place to update.

## Implementation

### New File

| File | Purpose |
|------|---------|
| `server/auth/mcp-config-injector.js` | `ensureGlobalMcpConfig()` — read key file, read/merge/write MCP config |

### Modified Files

| File | Change |
|------|--------|
| `server/index.js` | Call `ensureGlobalMcpConfig()` after `serverConfig.init()` |

### Deleted Files

| File | Reason |
|------|--------|
| `.mcp.json` | Redundant — global config handles it |

### Tests

| Test | What it covers |
|------|----------------|
| Creates `~/.claude/.mcp.json` when absent | Fresh install path |
| Merges into existing file with other servers | Non-destructive merge |
| Skips write when entry already matches | Idempotency |
| Updates URL when key changes | Key rotation |
| Preserves file on JSON parse failure | Safety — corrupted file not destroyed |
| Handles missing `~/.claude/` directory | Directory creation |
| Skips when `.torque-api-key` file missing | Open mode / failed bootstrap |
| Uses non-default SSE port from serverConfig | Port override correctness |
| Preserves user-added fields on entry update | Merge-not-replace behavior |

Note: Atomic write (temp + rename) is an implementation detail verified by code inspection, not a unit test. The temp file pattern prevents corruption from concurrent starts but is not reliably testable in isolation.

## Future Layers

This spec is Layer 1 of a 4-layer auth roadmap (documented in memory: `project_user_auth_roadmap.md`). Layers 2-4 (multi-user auth, role-based governance, LAN auth) will build on this foundation but are not in scope here. The key architectural decision: Layer 1 writes the *current server's bootstrap key* into the *current OS user's* config. When Layer 2 introduces per-user keys, the injector will write the user's personal key instead of the server bootstrap key — same mechanism, different key source.

## Out of Scope

- Multi-user auth (Layer 2)
- Role-based task ownership (Layer 3)
- LAN/remote auth (Layer 4)
- Dashboard auth changes
- Key management UI
- SSE ticket-based auth (deferred to Layer 2; see `server/docs/investigations/mcp-sse-auth-gap.md`)
