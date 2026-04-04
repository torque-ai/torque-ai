# Security & Reliability Scan
Date: 2026-04-04
Scope: server/execution/, server/api/, server/handlers/, server/db/, server/plugins/
Agent: code-scout

## Summary
7 findings: 1 critical, 2 high, 3 medium, 1 low.

## Findings

### [CRITICAL] restore_database accepts arbitrary file path without traversal guard
- File: server/handlers/integration/infra.js:206
- Description: `handleRestoreDatabase` passes `args.src_path` directly to `backupCore.restoreDatabase()` with no path traversal or allowlist check. An MCP client can supply any absolute path (e.g., a crafted SQLite file placed elsewhere on disk) and the server will open it as the live database. Combined with the integrity-check bypass via `force: true`, this is an arbitrary-file-read (the DB contents become queryable) and potential code-execution vector if the attacker controls the SQLite file content (e.g., malicious `CREATE TRIGGER`).
- Status: NEW
- Suggested fix: Restrict `src_path` to the backups directory. Resolve the path, then verify it starts with the canonical backups dir prefix before proceeding.

### [HIGH] listBackups directory parameter allows arbitrary directory listing
- File: server/handlers/integration/infra.js:221 / server/db/backup-core.js:223
- Description: `handleListDatabaseBackups(args)` passes `args.directory` directly to `backupCore.listBackups(dir)`, which calls `fs.readdirSync(dir)` and `fs.statSync()` on every `.db`/`.sqlite` file found. Any MCP caller can enumerate files in arbitrary directories on the server. While limited to `.db`/`.sqlite` extensions, this is still an information disclosure vulnerability revealing filesystem structure.
- Status: NEW
- Suggested fix: Validate that the directory parameter is within the data/backups directory, or remove the parameter entirely and always use the default.

### [HIGH] Webhook payload substitution enables prompt injection into task descriptions
- File: server/api/webhooks.js:148-151
- Description: `substitutePayload` replaces `{{payload.*}}` placeholders in the webhook's `task_description` template with raw values from the incoming webhook JSON body. These values flow directly into `smart_submit_task` as the task description. An attacker who can trigger the webhook (knowing or brute-forcing the name + HMAC secret) can inject arbitrary instructions into the LLM task prompt via payload fields. The substitution performs `String(value)` with no sanitization, escaping, or length cap on individual substituted values.
- Status: NEW
- Suggested fix: Truncate or sanitize substituted values (e.g., cap at 500 chars, strip control characters). Consider a structured metadata field for untrusted webhook data rather than string interpolation into the prompt.

### [MEDIUM] Sync endpoint accepts arbitrary repoUrl for git clone (SSRF via git protocol)
- File: server/plugins/remote-agents/agent-server.js:347-356
- Description: The `/sync` endpoint on the remote agent server passes `body.repo_url` directly to `git clone`. Git supports `file://`, `ssh://`, and other protocols that can probe internal network resources. While the agent server defaults to localhost-only binding and requires auth, if exposed on a network (`TORQUE_AGENT_HOST=0.0.0.0`), this becomes an SSRF vector. The `project` field is validated against path traversal, but `repoUrl` has no validation at all.
- Status: NEW
- Suggested fix: Validate `repoUrl` against an allowlist of protocols (https only) and optionally hostnames. Reject `file://`, `ssh://`, and other non-HTTPS schemes.

### [MEDIUM] readFileSync in file-context-builder blocks event loop during task startup
- File: server/execution/file-context-builder.js:124, 204
- Description: `buildFileContext` reads multiple files synchronously via `fs.readFileSync` in a loop (up to `maxBytes` budget, ~30KB total). `extractJsFunctionBoundaries` also uses `readFileSync`. These run during task startup on the main thread. With many resolved files or large files, this blocks the event loop and delays HTTP/SSE responses for all concurrent clients.
- Status: NEW
- Suggested fix: Convert to async fs.readFile or move to a worker thread. At minimum, cap the number of files read (currently implicitly capped by byte budget but not by count).

### [MEDIUM] killOrphanByPid SIGKILL timer holds event loop open
- File: server/execution/process-lifecycle.js:154-162
- Description: `killOrphanByPid` on non-Windows platforms schedules a `setTimeout` for SIGKILL but does not call `unref()` on the timer. Unlike `killProcessGraceful` (which attaches a `process.once('exit')` to clear the timeout), `killOrphanByPid` has no such cleanup. The timer holds the event loop open for `killDelayMs` (default 5s), preventing graceful shutdown if the orphan kill happens during server teardown.
- Status: NEW
- Suggested fix: Call `.unref()` on the setTimeout handle, consistent with the pattern used elsewhere in the file (e.g., `terminateChild` in agent-server.js).

### [LOW] Session manager never prunes expired sessions proactively
- File: server/plugins/auth/session-manager.js
- Description: Expired sessions are only removed on access (lazy eviction in `getActiveEntry`). If sessions are created but never accessed again, they remain in the Map indefinitely until the session count hits `maxSessions` and LRU eviction kicks in. With the default `maxSessions=50` and `sessionTtlMs=24h`, this is a minor memory leak — 50 stale sessions is negligible. However, in a deployment with high session churn and a larger `maxSessions`, the Map could hold many expired entries.
- Status: NEW
- Suggested fix: Add a periodic sweep (e.g., every 10 minutes) that deletes entries older than `sessionTtlMs`. Low priority given the 50-entry default cap.
