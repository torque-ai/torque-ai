# Phase 1 Child Spec — Sync I/O on Hot Paths

**Status:** Draft 2026-04-25 (pending user review)

**Parent:** `docs/superpowers/specs/2026-04-25-perf-arc-umbrella-design.md` §3.1, §4.2 row 1

**Pre-flight findings:** `docs/findings/2026-04-25-perf-arc/phase-1-sync-io-pre.md` (scout commit `e80e0525`)

**Goal:** Eliminate every synchronous filesystem, git, or subprocess call from hot-path files (per umbrella §3.1 globs), ship the `torque/no-sync-fs-on-hot-paths` ESLint rule that prevents recurrence, and update the perf gate baseline to capture the latency improvement.

## 1. Scope

### 1.1 In scope (from scout)

**5 HIGH severity (NEW since 2026-04-04 scan):**

1. `server/execution/sandbox-revert-detection.js:68,165` — per-file `execFileSync('git diff')` and `execFileSync('git checkout')` in the task finalizer pipeline.
2. `server/handlers/review-handler.js:153` — `execFileSync('git', diffArgs)` in adversarial review (refactored from `adversarial-review-stage.js:74` per 2026-04-04 finding #2; still sync).
3. `server/handlers/task/pipeline.js:182,205` — `spawnSync('git', ...)` in `execGit()` and `execGitCommit()`.
4. `server/handlers/automation-handlers.js:595,624` — recursive `readdirSync` + per-file `readFileSync` in `scanDirectory()`, used by `generate_test_tasks` MCP handler.
5. `server/handlers/validation/index.js:255-258` — per-file `readFileSync` + `statSync` loop in `handleValidateTaskDiff()`.

**8 MEDIUM:**

6. `server/execution/task-startup.js:362` — sync subprocess to find `where.exe` per Codex task start on Windows. Memoize the resolved path module-level.
7. `server/execution/task-startup.js:588` — `statSync(task.working_directory)` in `runPreflightChecks()`.
8. `server/handlers/ci-handlers.js:20` — `execFileSync('gh', ...)` in `resolveRepo()` with 10s timeout.
9. `server/execution/workflow-runtime.js:399,400,409` — `existsSync` + `mkdirSync` + `writeFileSync` in `generatePipelineDocumentation()` at workflow completion.
10. `server/api/v2-governance-handlers.js:959,979` — `writeFileSync` + `unlinkSync` for plan import temp file.
11. `server/api/v2-task-handlers.js:132,677` — `readFileSync` for artifact content on every artifact fetch.
12. `server/handlers/automation-ts-tools.js` (9 callsites grouped) — read-modify-write cycle for every TypeScript mutator tool. Bulk-convert via a single async helper.
13. `server/handlers/hashline-handlers.js:72,81,82,267` — `statSync` + `readFileSync` + `writeFileSync` per hashline read/edit.

**Phase 1.5 referral (NOT this phase):**

- `server/handlers/advanced/artifacts.js` `openSync`/`closeSync`/`readSync`/`fstatSync` cluster — requires redesign with `fs.createReadStream`, not a mechanical rename. Filed as Phase 1.5 follow-up; out of Phase 1 scope.

### 1.2 Out of scope (legitimate exceptions; ESLint allowlist)

These get explicit `// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- <reason>` annotations:

- `server/execution/restart-handoff.js:15,34,40` — shutdown/startup-only path. Reason: "shutdown/startup handoff file — sync is correct ordering."
- `server/execution/startup-task-reconciler.js:124` — startup reconciler. Reason: "startup reconciler — runs once at server boot."
- `server/execution/command-builders.js:31,33,43` (sandbox writable-roots detection) — task-startup, called once per task start. Reason: "sandbox writable-roots probe — task startup, single small read each."
- `server/execution/process-lifecycle.js:117,135,201,251` — sync subprocess kill in graceful shutdown. Reason: "Windows process kill — runs in setTimeout during graceful shutdown, not request hot-path."
- `server/execution/command-builders.js:52` — `mkdirSync` in worktree sandbox setup. Reason: "best-effort sandbox dir creation."

### 1.3 Closed already (no action)

- `server/dashboard-server.js` per-request `existsSync` (2026-04-04 finding) — current code caches dir resolution at module-load time. Confirmed closed by scout.

---

## 2. Discipline rule: `torque/no-sync-fs-on-hot-paths`

### 2.1 ESLint rule shape

Custom rule lives at `server/eslint-rules/no-sync-fs-on-hot-paths.js`. Detects:

- `MemberExpression` calls of `fs.readFileSync`, `fs.writeFileSync`, `fs.statSync`, `fs.existsSync`, `fs.readdirSync`, `fs.unlinkSync`, `fs.mkdirSync`, `fs.rmSync`, `fs.lstatSync`, `fs.realpathSync`, `fs.openSync`, `fs.closeSync`, `fs.readSync`, `fs.writeSync`, `fs.fstatSync`, `fs.copyFileSync`.
- Subprocess sync calls — `execSync`, `execFileSync`, `spawnSync` from `child_process` (and the destructured equivalents — track the binding, not just the property name).
- Re-imports under different names (e.g., `const { execFileSync: efs } = require('child_process')` causes calls to `efs(...)` to be flagged too).

### 2.2 File scope (glob list in rule config)

The rule applies ONLY to files matching umbrella §3.1's hot-path globs:

```
server/handlers/**
server/execution/**
server/governance/**
server/audit/**
server/api/**
server/dashboard-server.js
server/queue-scheduler*.js
server/maintenance/orphan-cleanup.js
```

Files outside this glob list are unaffected by the rule.

### 2.3 Exception annotation

`// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- <reason>` — rule requires the reason text to be >10 chars. Generic `// fixme` or empty reasons fail the rule with a clear error.

### 2.4 Initial allowlist

Rule ships in `warn` mode initially with the 5 grandfathered exceptions from §1.2 above, all carrying their inline `// eslint-disable-next-line` comments. Phase 1 closure = allowlist contains only these 5 explicit exceptions; every other former violation is converted.

### 2.5 Enabled in CI lint

`server/eslint.config.js` adds the rule under the `plugins:` section pointing at `server/eslint-rules/index.js`. The pre-push hook's lint step fails on rule violations.

---

## 3. Migration playbook

Order tasks by impact-to-cost ratio. Highest-leverage first.

### 3.1 Task A: Create the ESLint rule with allowlist starting state

- Implement rule + tests.
- Mark rule as `warn` (not `error`) initially so existing-but-grandfathered offenders surface as warnings.
- Auto-generate the initial allowlist by running the rule against the codebase and capturing offenders.
- Land before any code conversion so subsequent tasks can verify their work via `npm run lint`.

### 3.2 Task B: Convert sandbox-revert-detection.js (HIGH #1)

- Promisify the subprocess call from the `child_process` module.
- Convert per-file git-diff loop to `Promise.all(...)` over the changed-files array — parallelizes the detection.
- Convert per-revert git-checkout to async too (these run serially but should not block).
- Add inline test that `detectSandboxReverts()` returns the same shape; existing integration tests should keep passing.

### 3.3 Task C: Convert review-handler.js (HIGH #2)

- `collectDiffOutput()` switches from sync to async subprocess call.
- Update callers in `runStage()` of the task finalizer — already supports async per the 2026-04-04 scan note.

### 3.4 Task D: Convert task/pipeline.js (HIGH #3)

- `execGit()` and `execGitCommit()` switch from sync to async subprocess.
- Callers must `await` the result.

### 3.5 Task E: Convert automation-handlers.scanDirectory (HIGH #4)

- Replace `readdirSync` + `readFileSync` walk with async `fs.promises.readdir` + bounded `Promise.all` (e.g., 8-wide parallelism using a small queue helper).
- Add a unit test seeding a temp dir tree.

### 3.6 Task F: Convert validation/index.js (HIGH #5)

- Per-file `readFileSync` + `statSync` loop becomes `Promise.all(files.map(async f => { const [content, stat] = await Promise.all([readFile, stat]); ... }))`.

### 3.7 Task G: Bulk-convert automation-ts-tools.js (MEDIUM #12)

- Add a shared helper `async readModifyWrite(filePath, transform)` that does `fs.promises.readFile` → `transform` → `fs.promises.writeFile` only when content changed.
- Refactor all 9 TypeScript mutator handlers (`add_ts_interface_members`, `add_ts_method_to_class`, `replace_ts_method_body`, `inject_class_dependency`, `add_ts_union_members`, `inject_method_calls`, `normalize_interface_formatting`, `add_ts_enum_members`, `add_import_statement`) to call the shared helper.
- Existing tests continue to pass.

### 3.8 Task H: Convert hashline-handlers.js (MEDIUM #13)

- `hashline_read` and `hashline_edit` switch their `statSync` + `readFileSync` + `writeFileSync` to async equivalents.
- Existing tests continue to pass.

### 3.9 Tasks I–K: Smaller MEDIUM conversions

- `task-startup.js:362` — module-level memo for the `where.exe` resolution result; convert call to async one-shot at module load.
- `task-startup.js:588` — `statSync` to `fs.promises.stat` in `runPreflightChecks()`. Caller already async.
- `ci-handlers.js:20` — async subprocess with 10s timeout preserved.
- `workflow-runtime.js` — `existsSync`/`mkdirSync`/`writeFileSync` to `fs.promises` equivalents.
- `v2-governance-handlers.js:959,979` — `writeFileSync` + `unlinkSync` to async.
- `v2-task-handlers.js:132,677` — artifact `readFileSync` to async.

### 3.10 Task L: Apply ESLint rule in `error` mode

- After all conversions land, flip rule from `warn` to `error` in `eslint.config.js`.
- Allowlist contains exactly the 5 explicit exceptions from §1.2.

### 3.11 Task M: Phase 1 closure verification

- Re-run `/torque-scout performance` scoped to sync I/O. Findings file at `docs/findings/2026-04-25-perf-arc/phase-1-sync-io-post.md`.
- Confirm zero NEW findings; only the 5 grandfathered exceptions appear.
- `npm run lint` exits clean.

---

## 4. Tracked-metric updates to `baseline.json`

### 4.1 Existing metrics that should move

| Metric | Current baseline | Expected after Phase 1 |
|---|---|---|
| `governance-evaluate` | 172.64ms | ~10-20ms (sync git → async, 5 git subprocesses parallelized) |
| `task-core-create` | 0.43ms | ~0.30-0.40ms (less governance pipeline blocking, marginal) |

### 4.2 Optional: add a new tracked metric

- `task-finalizer-pipeline` — measures the post-completion pipeline (validation, sandbox-revert-detection, review). This is the workflow's hot path and Phase 1's fixes target it directly. Adding the metric makes future phase regressions on this surface visible. Ship as part of Phase 1 if implementer time allows; otherwise defer to v0.1.

### 4.3 Update protocol

When Phase 1's implementation lands, the cutover commit (or a follow-on) carries `perf-baseline:` trailers per moved metric:

```
perf-baseline: governance-evaluate 172.64 to <new> (Phase 1: sync git subprocesses replaced with async)
perf-baseline: task-core-create 0.43 to <new> (Phase 1: governance no longer blocks the pipeline)
```

---

## 5. Phase closure criteria (per umbrella §3.5)

1. **All findings closed** — fresh scout returns zero NEW findings; only the 5 grandfathered exceptions remain.
2. **Discipline rule live** — `torque/no-sync-fs-on-hot-paths` shipped in `error` mode.
3. **Tracked metrics moved by the phase, captured in baseline** — `governance-evaluate` improves >10% on the median; baseline updated with `perf-baseline:` trailer.
4. **Re-scout confirms zero** — post-merge scout file at `docs/findings/2026-04-25-perf-arc/phase-1-sync-io-post.md` shows the pattern class is closed.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Async conversion changes call ordering and breaks a test that relied on sync behavior | Each conversion task includes existing-test verification + paired updates if a test was implicitly sync-dependent |
| `automation-ts-tools.js` bulk refactor introduces a regression in one of the 9 tools | Bulk task is gated on the existing test suite for those tools; if any single tool's tests fail post-refactor, that tool's handler is reverted to its original shape and re-converted as a separate task |
| `Promise.all` over large file lists causes too much concurrent fs pressure | Use a bounded-concurrency helper (8-wide) for `scanDirectory()` and any other large-loop conversions |
| Conversion accidentally drops the `windowsHide: true` option on git/cli subprocesses | Explicit checklist item in each subprocess conversion: preserve all spawn options |
| `where.exe` memoization caches a stale path if Codex CLI is reinstalled mid-process | The cache invalidates on TORQUE restart (process-lifetime singleton); restart is the documented fix |
| Phase 1 cutover triggers TORQUE restart; running factory tasks must drain | Pause factory projects via `pause_all_projects` before cutover (per umbrella §4.4); `resume_project` after restart confirmed |

---

## 7. Execution shape

- **Worktree:** `feat-perf-1-sync-io` (already created at `.worktrees/feat-perf-1-sync-io/`).
- **Branch:** `feat/perf-1-sync-io` (off main `6ce665b8`, which includes Phase 0).
- **Implementation plan:** Written via `superpowers:writing-plans` from this worktree after spec approval.
- **Execution path:** `superpowers:subagent-driven-development` per umbrella §4.1, same pattern as Phase 0.
- **Cutover:** `scripts/worktree-cutover.sh perf-1-sync-io`. Pause factory before; resume after restart confirmed.
- **Parallel with:** Phase 4 (test infra). Conflict surface is `server/eslint-rules/index.js` — second-to-cutover rebases on new main and adds its rule export.
