# Security Sweep
Date: 2026-04-05
Scope: server/, dashboard/, scripts/
Variant: security
Summary: 3 findings: 2 high, 1 medium.

### [HIGH] Dashboard `/api/v2/*` requests bypass the dashboard's CSRF and request-origin checks
File: server/dashboard-server.js:709-746; server/dashboard/router.js:1003-1030; server/api/routes.js:202-205; server/api/routes.js:1030-1033; server/api/v2-infrastructure-handlers.js:328-333
Description: The dashboard server dispatches every `/api/v2/*` request directly to `dispatchV2()` before the legacy dashboard router runs. That bypasses the dashboard router's only browser-facing request protections: localhost source enforcement, localhost Origin validation, and the `X-Requested-With` gate on mutating requests. The v2 route table includes mutating control-plane endpoints such as `POST /api/v2/tasks` and `POST /api/v2/hosts/scan`, and `handleHostScan()` immediately performs `scanNetworkForOllama({ autoAdd: true })` without requiring a request body. A malicious website can therefore cause a victim browser to submit cross-site POSTs to `http://127.0.0.1:3456/api/v2/...`, triggering task submission, workflow actions, or host scans against the victim's local TORQUE instance even though the legacy dashboard routes try to block that class of request.
Status: NEW
Suggested fix: Apply the same request gating to `/api/v2/*` before calling `dispatchV2()` on the dashboard port. At minimum enforce the existing localhost Origin and mutating-request checks there; preferably move to an explicit CSRF token or same-origin session validation instead of relying on `X-Requested-With`.

### [HIGH] Enterprise bootstrap logs the raw admin API key in cleartext
File: server/plugins/auth/index.js:119-126
Description: On first enterprise-mode startup, the auth plugin creates a bootstrap admin API key and immediately logs the full secret with `logger.info(...)`. That turns a one-time bootstrap credential into a reusable secret present in console output, log files, terminal scrollback, and any downstream log aggregation. Anyone with read access to those logs gets full admin API access.
Status: NEW
Suggested fix: Never log raw credentials. Log only non-sensitive metadata such as the key ID and the path of the one-time bootstrap file, and require the operator to retrieve the secret from that file or an explicit reveal flow.

### [MEDIUM] Dashboard plan import still uses a predictable temp filename in the shared temp directory
File: server/dashboard/routes/admin.js:216-222
Description: `handleImportPlanApi()` writes attacker-controlled `plan_content` to `path.join(os.tmpdir(), \`plan-${Date.now()}.md\`)` with a plain `fs.writeFileSync()`. The filename is predictable and the write is not exclusive, so a local attacker who can pre-create a symlink or hardlink in the temp directory can redirect that write into another writable file when an operator imports a plan through the dashboard. The v2 implementation already moved to a randomized filename, so the dashboard path is now the weaker copy.
Status: NEW
Suggested fix: Use `fs.mkdtempSync()` or a `crypto.randomUUID()` filename plus exclusive creation (`flag: 'wx'`), and reject symlinks before writing or deleting the temp file.
