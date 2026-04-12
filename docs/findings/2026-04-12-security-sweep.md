# Security Sweep - TORQUE
**Date:** 2026-04-12
**Scope:** server/, dashboard/, scripts/
**Scanner:** security variant (code analysis)

## Summary
5 findings: 0 critical, 2 high, 2 medium, 1 low.

## CRITICAL
None.

## HIGH
### SEC-NEW-01: `hashline_read` and `hashline_edit` allow arbitrary filesystem read/write
- **File:** server/handlers/hashline-handlers.js:92
- **Description:** `handleHashlineRead()` trusts `args.file_path` and reads any existing path with `fs.existsSync()`/`cacheFile()` and returns file contents line-by-line. `handleHashlineEdit()` uses the same unvalidated path and writes the modified buffer back with `fs.writeFileSync()` at line 217. There is no `isPathTraversalSafe()` check, no workspace-root check, and no allowlist. Because these tools are exposed through REST passthrough routes (`/api/v2/hashline/hashline-read` and `/api/v2/hashline/hashline-edit`), an authenticated caller can read or modify arbitrary files reachable by the TORQUE process, not just project files. I verified this by reading and then editing a temporary file outside the repo under `%TEMP%`.
- **Status:** NEW
- **Suggested fix:** Require every hashline path to resolve under an explicit allowed base (task/workflow `working_directory` or configured workspace roots), reject absolute paths outside that scope, and add regression tests that cover out-of-repo absolute paths.

### SEC-NEW-02: TypeScript automation tools accept absolute paths outside any allowed workspace
- **File:** server/handlers/automation-ts-tools.js:31; server/handlers/shared.js:229
- **Description:** The TypeScript automation handlers (`add_ts_interface_members`, `inject_class_dependency`, `add_ts_union_members`, `inject_method_calls`, `add_ts_enum_members`, `normalize_interface_formatting`, `add_ts_method_to_class`, `replace_ts_method_body`, `add_import_statement`) only call `isPathTraversalSafe(filePath)` with no `allowedBase`. That helper blocks `..` segments and a short dangerous-path denylist, but otherwise permits arbitrary absolute paths. The tool schemas explicitly advertise `file_path` as an absolute path, and the handlers then read/write that file directly with `fs.readFileSync()`/`fs.writeFileSync()`. I verified this by calling `handleAddTsInterfaceMembers()` against a temporary `.ts` file outside the repo and observing the edit succeed. This gives authenticated callers arbitrary file write capability across most of the host filesystem, not just the intended project workspace.
- **Status:** NEW
- **Suggested fix:** Thread an explicit allowed base into these handlers and reject any resolved path outside that root. If cross-project editing is required, gate it behind an explicit allowlist of approved roots instead of open-ended absolute paths.

## MEDIUM
### SEC-NEW-03: Validation file helpers can enumerate arbitrary directories on disk
- **File:** server/handlers/validation/file.js:69; server/db/file-baselines.js:770
- **Description:** `handleCheckDuplicateFiles()` and `handleSearchSimilarFiles()` accept caller-controlled `working_directory` values, pass them straight into recursive directory walkers, and return discovered file paths back to the caller. There is no path traversal or workspace-boundary validation on `working_directory`; the only guard is that the `task_id` exists. `checkDuplicateFiles()` recursively records duplicate locations, and `searchSimilarFiles()` recursively returns matching file paths and even opens source files for classname searches. I verified this by creating a task record and pointing `handleSearchSimilarFiles()` at a temporary directory outside the repo; it returned the out-of-scope file path successfully. This is a filesystem enumeration/info disclosure primitive for any authenticated caller.
- **Status:** NEW
- **Suggested fix:** Require `working_directory` to resolve under the task's own working directory or an approved project root, and reject scans outside that boundary.

### SEC-NEW-04: Expected-output enforcement can be bypassed with sibling-prefix paths
- **File:** server/db/file-baselines.js:737
- **Description:** When `allow_subdirs` is enabled, `checkFileLocationAnomalies()` decides whether a created file is inside an allowed output directory by testing `normalizedFile.startsWith(normalizedExpected)`. That is a prefix match, not a path-segment boundary check. An expected directory like `C:\work\out` incorrectly matches `C:\work\outside\evil.js`, so files written outside the approved output root can evade anomaly detection. I verified this with a temporary task in the test DB: expected path `...\\out`, created file `...\\outside\\evil.js`, and `checkFileLocationAnomalies()` returned zero anomalies.
- **Status:** NEW
- **Suggested fix:** Replace the `startsWith()` check with a canonical `path.relative()` boundary test (or append `path.sep` before prefix comparison) so only real descendants of the expected directory are accepted.

## LOW
### SEC-NEW-05: V2 task-event SSE reflects arbitrary origins with credentials enabled
- **File:** server/api/v2-core-handlers.js:221
- **Description:** `sendV2SseHeaders()` copies any incoming `Origin` header into `Access-Control-Allow-Origin` and also sets `Access-Control-Allow-Credentials: true` with no allowlist or localhost check. `handleV2TaskEvents()` uses those headers for the authenticated task event stream. In deployments that rely on browser session cookies for `/api/*` auth, this creates a cross-origin read surface for task events because an attacker-controlled origin can be echoed back as trusted by the browser. This is lower-severity than the April 5 dashboard CSRF issue because it affects an SSE read path rather than a mutating endpoint, but it still weakens the browser security boundary.
- **Status:** NEW
- **Suggested fix:** Apply the same localhost/origin allowlist used elsewhere in the dashboard/API stack before sending SSE CORS headers, or omit credentialed CORS entirely for this stream.
