# Full Security Scan
Date: 2026-04-04
Scope: server/, dashboard/, scripts/ (full project)
Agent: security-scout
Prior scan: docs/findings/2026-04-04-security-reliability-scan.md (7 findings, skipped)

## Summary
6 findings: 1 high, 3 medium, 2 low. All NEW issues not covered by prior scan.

## Findings

### [HIGH] configure_artifact_storage accepts arbitrary storage_path without validation
- File: server/handlers/advanced/artifacts.js:390-392
- Description: `handleConfigureArtifactStorage` writes `args.storage_path` directly to the config database via `setArtifactConfig('storage_path', args.storage_path)` with no path validation, traversal check, or symlink check. When artifacts are later stored via `handleStoreArtifact`, the storage path from config is used as the base directory (line 98). An attacker (or misconfigured MCP client) can set `storage_path` to any directory on the filesystem (e.g., a system directory or another user's home), and subsequent artifact storage will write files into that directory. While `handleStoreArtifact` itself has symlink checks on the resolved `storagePath`, those checks only verify the path is not _already_ a symlink -- they don't prevent a legitimate directory from being used as the artifact root. Combined with the controlled filename (`${artifactId}${ext}`), this could write files to sensitive directories.
- Status: NEW
- Suggested fix: Validate `storage_path` in `handleConfigureArtifactStorage`: resolve to absolute, verify it is under an allowed parent (e.g., the TORQUE data directory or user home), reject if it resolves outside that boundary or is a symlink.

### [MEDIUM] Prototype property access in webhook payload substitution (both production and test paths)
- File: server/api/webhooks.js:56-58, server/handlers/inbound-webhook-handlers.js:196-204
- Description: The `substitutePayload` function in webhooks.js and the duplicated substitution logic in `handleTestInboundWebhook` use `value = value[key]` to traverse dot-notation paths from untrusted webhook payload objects (e.g., `{{payload.__proto__.constructor}}`). While JSON.parse does not create a real `__proto__` accessor, the property lookup `value[key]` can still access `Object.prototype` properties when `key` is `constructor`, `toString`, `hasOwnProperty`, etc. In the production path (webhooks.js:61), the result is stringified and truncated to 500 chars, so the impact is information disclosure (e.g., `[Function: Object]` leaked into task descriptions). In the test path (inbound-webhook-handlers.js:205), there is no truncation or control-character stripping at all.
- Status: NEW
- Suggested fix: Add a guard in the traversal loop: `if (key === '__proto__' || key === 'constructor' || key === 'prototype') return match;`. Apply the same 500-char truncation and control-char stripping to `handleTestInboundWebhook`.

### [MEDIUM] scan_project handler has no path traversal protection and follows symlinks during directory walk
- File: server/handlers/integration/infra.js:473-509
- Description: `handleScanProject` accepts `args.path` with only an existence check (`fs.existsSync`), no `isPathTraversalSafe` validation, and no check that the path is a directory (not a file or symlink). The recursive `walkDir` function (line 486) uses `fs.readdirSync` and `fs.statSync` (which follows symlinks) without `lstatSync`. A symlink inside the project directory pointing to a sensitive location would be followed, causing the scan to read and report file metadata (sizes, names, extensions, line counts, TODO contents) from outside the project. The `countLines` function (line 513) reads full file contents via `readFileSync`, so symlinked files are fully read. The `ignoreDirs` set only blocks specific names like `node_modules`; it does not filter symlinks.
- Status: NEW
- Suggested fix: (1) Validate `args.path` with `isPathTraversalSafe`. (2) Use `lstatSync` instead of `statSync` in `walkDir` to detect and skip symlinks, or check `entry.isSymbolicLink()` from the `withFileTypes` dirent and skip those entries.

### [MEDIUM] Smart routing file-size check reads files from task description without path traversal validation
- File: server/handlers/integration/routing.js:650-654
- Description: In `handleSmartSubmitTask`, the JS decomposition path (line 650) iterates over `resolvedJsFiles` (derived from `taskManager.resolveFileReferences` which parses file paths from the task description string) and reads each file via `fs.readFileSync(absPath)` without calling `isPathTraversalSafe`. While the later code path (line 844) does validate with `isPathTraversalSafe(absPath, workDir)`, the earlier JS decomposition branch at line 652 does not. An attacker who can submit tasks with crafted file paths in the description could cause the server to read arbitrary files. The file contents are not returned to the caller, but the line count is used in routing decisions and the function boundaries may be logged.
- Status: NEW
- Suggested fix: Add `isPathTraversalSafe(absPath, jsWorkDir)` check before `fs.readFileSync` at line 654, consistent with the check at line 844.

### [LOW] handleTestInboundWebhook dry-run substitution lacks sanitization present in production path
- File: server/handlers/inbound-webhook-handlers.js:193-205
- Description: The test/dry-run webhook handler (`handleTestInboundWebhook`) performs `{{payload.*}}` substitution on the task description using a duplicated implementation that lacks the 500-character truncation and control-character stripping added to the production `substitutePayload` function (webhooks.js:61). While this is a dry-run that does not create a task, the unsanitized substituted text is returned in the MCP response (line 219 in the "Resolved Task Description" block). If the test payload contains very long values or control characters, they flow into the response unfiltered. This is a code-hygiene issue -- the test handler should reuse `substitutePayload` from webhooks.js rather than duplicating the logic.
- Status: NEW
- Suggested fix: Import and use the `substitutePayload` function from `../api/webhooks.js` instead of the inline implementation. This ensures consistent sanitization.

### [LOW] Credential values are stored encrypted but listCredentials returns them without redaction
- File: server/api/v2-infrastructure-handlers.js:408-418
- Description: `handleListCredentials` calls `hostManagement.listCredentials(hostName, hostType)` and returns the full credential objects directly via `sendList`. The underlying `listCredentials` implementation decrypts credential values before returning. This means the full decrypted credential values (SSH keys, HTTP auth passwords, Windows credentials) are sent in the REST API response to any authenticated client. While TORQUE is designed for single-user/trusted-team deployments and the API requires authentication, this violates the principle of least privilege -- listing credentials should show metadata (type, label, created_at) but not the actual secret values. Retrieving the value should require an explicit "reveal" action.
- Status: NEW
- Suggested fix: Redact the `value` field from each credential in the list response, replacing it with a boolean `has_value: true` or a masked representation. Add a separate `GET /hosts/:name/credentials/:type/reveal` endpoint for explicit secret retrieval.
