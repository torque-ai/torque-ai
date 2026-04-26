# Phase 1 Pre-Flight Scout — Sync I/O on Hot Paths

**Date:** 2026-04-25
**Worktree:** feat-perf-1-sync-io
**Base commit:** 6ce665b8bd824d9715b4b801f4ddd72e14a2733a
**Discipline rule:** No `*Sync` filesystem/git/subprocess calls in hot-path files (per umbrella §3.1)

## Summary

23 distinct callsites across 13 files in the hot-path globs contain synchronous I/O. The highest-severity cluster is the task completion pipeline: `sandbox-revert-detection.js` runs multiple `execFileSync('git', ...)` calls per modified file on every Codex task completion, `review-handler.js` blocks on a `git diff` during adversarial review, and `task/pipeline.js` fires `spawnSync('git', ...)` for every pipeline git-add/commit. The `automation-handlers.js` `scanDirectory()` helper performs a full `readdirSync` + `readFileSync` tree walk on every `generate_test_tasks` MCP call. The `validation/index.js` handler calls `readFileSync` + `statSync` per changed file during the post-completion validation step. Three callsites are legitimately startup-only or one-shot recovery paths and carry LOW severity. Five callsites are MCP tool handlers for file manipulation operations where the sync I/O is the operation itself (automation-ts-tools, hashline-handlers) — these are MEDIUM, not HIGH, because they are invoked serially by a single caller, but they still block the event loop and should be converted.

---

## Findings

### [HIGH] sandbox-revert-detection: execFileSync per modified file on every Codex task completion
- **File:** `server/execution/sandbox-revert-detection.js:68`, `:165`
- **Pattern:** `execFileSync('git', ['diff', 'HEAD', '--', filePath], ...)` and `execFileSync('git', ['checkout', 'HEAD', '--', r.file], ...)`
- **Hot-path context:** `detectSandboxReverts()` is wired into the task-finalizer pipeline between `no_file_change_detection` and `auto_validation`. It runs for every Codex task that has a worktree. For each file in `ctx.filesModified` it fires a separate `git diff` subprocess synchronously. If reverts are detected it fires additional `git checkout HEAD` subprocesses. A task touching 10 files issues 10+ blocking git calls in sequence.
- **Was in prior scan?** Partially — `2026-04-04-runtime-performance-scan.md` identified `execFileSync('git')` in `completion-pipeline.js:293` (Phase 9 auto-release block) and `adversarial-review-stage.js:74`. The `sandbox-revert-detection.js` module did not exist at that date; this is NEW.
- **Severity rationale:** HIGH. Per-file subprocess in the task finalization hot path. Workflow batches (10–100 tasks completing in quick succession) each fire N blocking git subprocesses, causing head-of-line blocking for all other event processing.

### [HIGH] review-handler: execFileSync blocks event loop during adversarial git diff
- **File:** `server/handlers/review-handler.js:153`
- **Pattern:** `childProcess.execFileSync('git', diffArgs, { cwd: workingDirectory, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true })`
- **Hot-path context:** `collectDiffOutput()` is called from the adversarial review stage of the task finalizer pipeline. On large repos or large changesets, the git diff subprocess can take seconds.
- **Was in prior scan?** Yes — `2026-04-04-runtime-performance-scan.md` finding #2 cited `adversarial-review-stage.js:74`. The code has since been refactored into `review-handler.js` but the sync call remains. Issue is still real.
- **Severity rationale:** HIGH. Same class as the prior scan finding. Blocks event loop for the full subprocess duration; still not async-converted.

### [HIGH] task/pipeline: spawnSync git for every pipeline add/commit step
- **File:** `server/handlers/task/pipeline.js:182`, `:205`
- **Pattern:** `childProcess.spawnSync('git', gitArgs, ...)` in `execGit()`, `childProcess.spawnSync('git', ['commit', '-m', message], ...)` in `execGitCommit()`
- **Hot-path context:** `execGit()` and `execGitCommit()` are called during the task completion pipeline's auto-commit step. Every pipeline run that triggers a git-add + git-commit fires two synchronous subprocess calls.
- **Was in prior scan?** No — this pattern in `task/pipeline.js` is NEW (not in any of the four prior scans).
- **Severity rationale:** HIGH. Blocking git calls in the task completion hot path; worsens under concurrent workflow completions.

### [HIGH] automation-handlers: readdirSync + readFileSync tree walk in generate_test_tasks
- **File:** `server/handlers/automation-handlers.js:595`, `:624`
- **Pattern:** `fs.readdirSync(dirPath, { withFileTypes: true })` in `scanDirectory()`, `fs.readFileSync(fullPath, 'utf8')` to count lines per source file
- **Hot-path context:** `scanDirectory()` is called recursively from `generate_test_tasks` MCP handler. It walks the entire project source tree, reading every `.ts/.js/.tsx/.jsx` source file synchronously to count lines. On a project with 500+ source files this is hundreds of blocking filesystem reads.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** HIGH. Full recursive tree walk + per-file reads on an MCP tool handler. The MCP event loop is single-threaded; this blocks all concurrent MCP tool calls for the duration of the scan.

### [HIGH] validation/index.js: readFileSync + statSync per changed file in validate_diff handler
- **File:** `server/handlers/validation/index.js:255-258`
- **Pattern:** `fs.readFileSync(absPath, 'utf-8')` and `fs.statSync(absPath)` inside a loop over changed files
- **Hot-path context:** `handleValidateTaskDiff()` MCP handler collects diff-affected files and reads each one synchronously. Called from the task finalizer pipeline's post-completion validation step.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** HIGH. Per-file blocking reads in a completion-pipeline step; same class as the baseline scan findings.

### [MEDIUM] task-startup: execFileSync to find codex CMD path on every task start
- **File:** `server/execution/task-startup.js:362`
- **Pattern:** `execFileSync('where.exe', [cmdPath], { encoding: 'utf-8', windowsHide: true })`
- **Hot-path context:** `resolveWindowsCmdToNode()` is called from `buildProviderStartupCommand()` during task startup on Windows for Codex tasks. The result is not cached — called every time a Codex task starts.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** MEDIUM. Blocking subprocess on Windows only. Calling `where.exe` per task start is avoidable via module-level memoization of the resolved path.

### [MEDIUM] task-startup: statSync to validate working_directory on every task preflight
- **File:** `server/execution/task-startup.js:588`
- **Pattern:** `fs.statSync(task.working_directory)` in `runPreflightChecks()`
- **Hot-path context:** Called on every task start before the slot is claimed. Under burst conditions (many tasks starting simultaneously), multiple threads call `statSync` concurrently from the event loop.
- **Was in prior scan?** No (prior scan noted a similar pattern in `file-baselines.js`, not `task-startup.js`). NEW.
- **Severity rationale:** MEDIUM. Single `statSync` per task is fast, but it is blocking and batching it async via `fs.promises.stat` is straightforward.

### [MEDIUM] ci-handlers: execFileSync('gh') on every CI request lacking explicit repo
- **File:** `server/handlers/ci-handlers.js:20`
- **Pattern:** `execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { timeout: 10000, ... })`
- **Hot-path context:** `resolveRepo()` is called at the top of every CI handler that does not supply an explicit `repo` argument. It blocks for up to 10 seconds waiting for the `gh` CLI subprocess.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** MEDIUM. 10-second potential block on the event loop from an MCP tool handler. Should use `execFile` (async).

### [MEDIUM] workflow-runtime: existsSync + mkdirSync + writeFileSync on pipeline doc generation
- **File:** `server/execution/workflow-runtime.js:399`, `:400`, `:409`
- **Pattern:** `fs.existsSync(torqueDir)`, `fs.mkdirSync(torqueDir, { recursive: true })`, `fs.writeFileSync(filepath, markdown, 'utf8')`
- **Hot-path context:** `generatePipelineDocumentation()` is called at workflow completion. Runs on the event loop synchronously; uses blocking mkdir+write to persist a markdown report.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** MEDIUM. File write at workflow completion; can spike latency when large markdown reports are written. Async `fs.promises` conversions are mechanical.

### [MEDIUM] api/v2-governance-handlers: writeFileSync + unlinkSync for plan import temp file
- **File:** `server/api/v2-governance-handlers.js:959`, `:979`
- **Pattern:** `fs.writeFileSync(tempFile, body.plan_content)` and `fs.unlinkSync(tempFile)` in `handleImportPlan()`
- **Hot-path context:** REST API handler for `POST /api/v2/governance/plans/import`. Writes plan content to a temp file synchronously, delegates to the tool handler, then unlinks synchronously in `finally`.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** MEDIUM. Direct API handler; blocks event loop for file write. Plan content can be large (several KB). Should use `fs.promises.writeFile` + `await`.

### [MEDIUM] api/v2-task-handlers: readFileSync for artifact content on every artifact fetch
- **File:** `server/api/v2-task-handlers.js:132`, `:677`
- **Pattern:** `fs.readFileSync(artifact.absolute_path, 'utf8')` and `fs.readFileSync(artifact.absolute_path)` in REST artifact download handler
- **Hot-path context:** `GET /api/v2/tasks/:id/artifacts/:artifact_id` REST endpoint. Reads full artifact content synchronously on each request.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** MEDIUM. REST hot-path; blocking read scales with artifact file size. Use `fs.promises.readFile`.

### [MEDIUM] automation-ts-tools: readFileSync + writeFileSync on every TypeScript mutation tool call
- **File:** `server/handlers/automation-ts-tools.js` — multiple callsites: `:100`+`:104`+`:160`, `:186`+`:207`+`:312`, `:339`+`:348`+`:385`, `:413`+`:417`+`:428`, `:456`+`:460`+`:500`, `:530`+`:534`+`:588`, `:615`+`:619`+`:691`, `:717`+`:721`+`:782`, `:807`+`:811`+`:848`
- **Pattern:** `fs.existsSync(filePath)` → `fs.readFileSync(filePath, 'utf8')` → `fs.writeFileSync(filePath, content, 'utf8')` for every TypeScript mutator tool (`add_ts_interface_members`, `add_ts_method_to_class`, `replace_ts_method_body`, `inject_class_dependency`, etc.)
- **Hot-path context:** MCP tool handlers. Every call to a TypeScript mutation tool does a synchronous read-modify-write cycle.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** MEDIUM. These are MCP tool handlers invoked by agents. While each call is serial (single caller), the sync I/O blocks the event loop, preventing other MCP/HTTP traffic from being serviced during file I/O. Convert to `fs.promises` for correctness.

### [MEDIUM] hashline-handlers: statSync + readFileSync + writeFileSync per hashline read/edit
- **File:** `server/handlers/hashline-handlers.js:72`, `:81`, `:82`, `:267`
- **Pattern:** `fs.statSync(filePath)`, `fs.readFileSync(filePath, 'utf8')`, `fs.writeFileSync(absoluteFilePath, newFileContent, 'utf8')`
- **Hot-path context:** MCP `hashline_read` and `hashline_edit` tool handlers. Every hashline read or edit call does synchronous stat + read + (on edit) write.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** MEDIUM. Same class as automation-ts-tools; MCP handler blocking the event loop.

### [LOW] execution/command-builders: statSync + readFileSync for git worktree detection (startup only)
- **File:** `server/execution/command-builders.js:31`, `:33`, `:43`
- **Pattern:** `fs.statSync(gitPath)`, `fs.readFileSync(gitPath, 'utf8')`, `fs.readFileSync(commondirFile, 'utf8').trim()`
- **Hot-path context:** `resolveSandboxWritableRoots()` is called from `buildProviderStartupCommand()` at task startup to detect if the working directory is a git worktree. Called once per task start. Not in a tick loop.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** LOW. Task startup path, not a recurring tick. Three small file reads are fast. Still worth converting for consistency with the discipline rule; the `mkdirSync` calls in the same function are already best-effort.

### [LOW] execution/startup-task-reconciler: existsSync in reconciler (startup/recovery path only)
- **File:** `server/execution/startup-task-reconciler.js:124`
- **Pattern:** `!fs.existsSync(workingDirectory)` in `isMissingWorkingDirectory()`
- **Hot-path context:** Called from the startup reconciler during TORQUE server startup (and on stall-recovery restarts) to check whether queued tasks' working directories still exist. Not called during normal operation ticks.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** LOW. Startup-only. Single `existsSync` per orphaned task. Legitimate exception from strict enforcement; noted for completeness.

### [LOW] execution/restart-handoff: readFileSync + writeFileSync + unlinkSync (startup/shutdown only)
- **File:** `server/execution/restart-handoff.js:15`, `:34`, `:40`
- **Pattern:** `fs.readFileSync(getRestartHandoffPath(), 'utf8').trim()`, `fs.writeFileSync(getRestartHandoffPath(), JSON.stringify(handoff), 'utf8')`, `fs.unlinkSync(getRestartHandoffPath())`
- **Hot-path context:** Restart handoff file is written at shutdown and read at startup. Not in any request or tick path.
- **Was in prior scan?** No — NEW.
- **Severity rationale:** LOW. Genuine startup/shutdown-only path. Legitimate exception; ESLint rule should explicitly allowlist this file.

---

## Coverage

- Files scanned:
  - `server/handlers/**/*.js`
  - `server/execution/**/*.js`
  - `server/governance/**/*.js` (no matches)
  - `server/audit/**/*.js` (no matches — directory has no JS files)
  - `server/api/**/*.js`
  - `server/dashboard-server.js`
  - `server/execution/queue-scheduler.js`, `server/execution/slot-pull-scheduler.js`, `server/execution/schedule-runner.js` (no sync I/O violations found)
  - `server/maintenance/orphan-cleanup.js` (no matches)
- Total `*Sync` callsites found: 23 distinct callsites (counting multi-call clusters in automation-ts-tools as one finding)
- Files containing at least one violation: 13

## Pattern class instances by category

| Pattern | Count | Files |
|---------|-------|-------|
| `fs.readFileSync` | 12 | artifacts.js, automation-handlers.js, automation-ts-tools.js, command-builders.js, hashline-handlers.js, task/core.js, task/operations.js, task/pipeline.js (indirect), validation/index.js, v2-task-handlers.js |
| `fs.writeFileSync` | 8 | automation-ts-tools.js, conflict-resolver.js, hashline-handlers.js, restart-handoff.js, task/core.js, v2-governance-handlers.js, workflow-runtime.js |
| `fs.existsSync` | 7 | automation-ts-tools.js, command-builders.js, hashline-handlers.js, routing.js, startup-task-reconciler.js, task/core.js, validation/index.js |
| `fs.statSync` | 3 | command-builders.js, hashline-handlers.js, task-startup.js |
| `fs.mkdirSync` | 3 | command-builders.js, routing.js, workflow-runtime.js |
| `execFileSync` (child_process) | 5 | ci-handlers.js, command-policy.js, process-lifecycle.js, sandbox-revert-detection.js, task-startup.js |
| `spawnSync` (child_process) | 3 | task/operations.js, task/pipeline.js, workflow/await.js |
| `fs.unlinkSync` | 2 | restart-handoff.js, v2-governance-handlers.js |
| `fs.lstatSync` | 2 | artifacts.js, task/core.js |
| `fs.realpathSync` | 2 | artifacts.js (path traversal guard) |
| `fs.readdirSync` | 1 | automation-handlers.js |
| `fs.copyFileSync` | 1 | task/core.js |
| `fs.openSync`/`closeSync`/`readSync`/`fstatSync` | 5 | artifacts.js (one cluster — file content streaming) |

## Notes for Phase 1 child spec

1. **Highest-leverage target:** `sandbox-revert-detection.js` — the per-file `execFileSync('git diff')` loop. Converting to async git calls via `execFile` (promisified) with `Promise.all` would parallelize the checks and eliminate blocking. Should be Phase 1's first task.

2. **Second target:** `task/pipeline.js` `execGit`/`execGitCommit` — these block the completion pipeline. Convert `spawnSync` to `spawn` with an async wrapper or use `execa` for structured async subprocess management.

3. **artifacts.js is NOT in scope for mechanical conversion** — the `openSync`/`closeSync`/`readSync`/`fstatSync` cluster implements a custom synchronous streaming read for binary artifacts. Converting it requires redesigning the streaming path with `fs.createReadStream`; flag as a separate task rather than a simple `*Sync` → `*` rename.

4. **automation-ts-tools.js bulk conversion** — all 9 TypeScript mutator tools follow the same `existsSync` → `readFileSync` → `writeFileSync` pattern. A single helper `async function readAndWrite(filePath, transform)` can replace all 9 handlers at once; treat as one child task.

5. **Legitimate exceptions (ESLint allowlist):**
   - `server/execution/restart-handoff.js` — shutdown/startup-only; sync is intentional
   - `server/execution/startup-task-reconciler.js:124` — startup reconciler; single `existsSync` per orphan
   - `server/execution/command-builders.js:52` — `mkdirSync` inside worktree sandbox setup; best-effort, intentional
   - `server/execution/process-lifecycle.js:117`,`:135`,`:201`,`:251` — `execFileSync('taskkill')` in Windows process kill path; runs in `setTimeout` callback during graceful shutdown, not in the request hot-path. LOW severity; ESLint allowlist candidate.

6. **Dashboard-server.js `existsSync` is already fixed** — the prior 2026-04-04 scan flagged per-request `existsSync` in `serveStatic()`. Current code (line 83) calls `existsSync` once at module load time and stores the result in `DASHBOARD_STATIC_DIR`. This finding is **closed**.

7. **command-policy.js `executeValidatedCommandSync`** — this function exists alongside the async `executeValidatedCommand`. It is called from at least one hot path (verify step); the async variant should be used instead and `executeValidatedCommandSync` deprecated.
