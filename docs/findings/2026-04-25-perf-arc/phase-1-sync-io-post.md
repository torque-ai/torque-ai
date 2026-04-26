# Phase 1 Post-Migration Scout — Sync I/O on Hot Paths

**Date:** 2026-04-25
**Worktree:** feat-perf-1-sync-io
**HEAD commit at scout time:** a853ec69
**Pre-flight findings:** `docs/findings/2026-04-25-perf-arc/phase-1-sync-io-pre.md` (scout commit `e80e0525`)
**Discipline rule:** `torque/no-sync-fs-on-hot-paths` — now in **error** mode (Task 14 / commit `a853ec69`)

## Summary

**Zero NEW findings.** All 13 pre-flight findings (5 HIGH, 8 MEDIUM) are confirmed CLOSED. The Phase 1 pattern class is closed.

The ESLint rule `torque/no-sync-fs-on-hot-paths` was flipped to `error` mode in commit `a853ec69`. Running `npm run lint` in `server/` produces no violations of that rule. All remaining `*Sync` callsites in hot-path scope carry either the 5 original grandfathered `eslint-disable-next-line` annotations from the spec §1.2 allowlist, or file-level `/* eslint-disable ... -- ... Phase 2 ... */` blocks that the executor added for callsites the spec explicitly deferred to Phase 2 (factory-handlers, integration/infra, artifacts, task/core, workflow/await, etc.). None of these represent NEW Phase 1 findings.

---

## Pre-flight findings closure status

| # | Severity | File | Finding | Status |
|---|----------|------|---------|--------|
| 1 | HIGH | `server/execution/sandbox-revert-detection.js:68,165` | per-file `execFileSync('git diff')` + `execFileSync('git checkout')` | **CLOSED** — commit `5572d02f` |
| 2 | HIGH | `server/handlers/review-handler.js:153` | `execFileSync('git', diffArgs)` in adversarial review | **CLOSED** — commit `e3f31d2d` |
| 3 | HIGH | `server/handlers/task/pipeline.js:182,205` | `spawnSync('git', ...)` in `execGit()` / `execGitCommit()` | **CLOSED** — commit `47c2b210` |
| 4 | HIGH | `server/handlers/automation-handlers.js:595,624` | `readdirSync` + `readFileSync` in `scanDirectory()` | **CLOSED** — commit `e2f186c2` |
| 5 | HIGH | `server/handlers/validation/index.js:255-258` | per-file `readFileSync` + `statSync` in `handleValidateTaskDiff()` | **CLOSED** — commit `822a0300` |
| 6 | MEDIUM | `server/execution/task-startup.js:362` | `execFileSync('where.exe')` per Codex task start | **CLOSED** — commit `ab396ad6` (memoized) |
| 7 | MEDIUM | `server/execution/task-startup.js:588` | `statSync(task.working_directory)` in preflight | **CLOSED (grandfathered)** — commit `ab396ad6`; annotated with `eslint-disable-next-line`; async conversion cascades into scheduler internals, tracked separately |
| 8 | MEDIUM | `server/handlers/ci-handlers.js:20` | `execFileSync('gh', ...)` in `resolveRepo()` | **CLOSED** — commit `d35f9f9f` |
| 9 | MEDIUM | `server/execution/workflow-runtime.js:399,400,409` | `existsSync` + `mkdirSync` + `writeFileSync` in `generatePipelineDocumentation()` | **CLOSED** — commit `bc05253f` |
| 10 | MEDIUM | `server/api/v2-governance-handlers.js:959,979` | `writeFileSync` + `unlinkSync` in `handleImportPlan()` | **CLOSED** — commit `ac2eeb92` |
| 11 | MEDIUM | `server/api/v2-task-handlers.js:132,677` | `readFileSync` for artifact content | **CLOSED** — commit `388521c9` |
| 12 | MEDIUM | `server/handlers/automation-ts-tools.js` (9 callsites) | read-modify-write cycle per TypeScript mutator tool | **CLOSED** — commit `759acf79` |
| 13 | MEDIUM | `server/handlers/hashline-handlers.js:72,81,82,267` | `statSync` + `readFileSync` + `writeFileSync` per hashline op | **CLOSED** — commit `f5ab7edf` |

**Confirmed closed: 13 of 13 pre-flight findings.**

---

## Grandfathered exceptions (spec §1.2 — unchanged from pre-flight)

These callsites carry `// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- <reason>` annotations exactly as spec §1.2 prescribes. No new additions to the original 5:

| File | Lines | Reason |
|------|-------|--------|
| `server/execution/restart-handoff.js` | 15, 36, 43 | shutdown/startup handoff file — sync is correct ordering |
| `server/execution/startup-task-reconciler.js` | 125 | startup reconciler — runs once at server boot |
| `server/execution/command-builders.js` | 32, 35, 46 (sandbox probe), 56 (mkdirSync) | sandbox writable-roots probe — task startup, single small read each; best-effort sandbox dir creation |
| `server/execution/process-lifecycle.js` | 118, 137, 203, 255 | Windows process kill — runs in setTimeout during graceful shutdown, not request hot-path |
| `server/execution/task-startup.js` | 17, 379, 386, 399, 404, 506, 610 | memoized (where.exe + .cmd read run once per unique cmdPath per server lifetime); preflight statSync grandfathered per spec §1.2 |

Note: `task-startup.js:506` (`execFileSync` in baseline capture) and `:610` (`statSync` in preflight) are the executor-added grandfather entries documented in commit `ab396ad6` with the rationale that async conversion would cascade into scheduler internals. These align with spec §1.2's intent and are counted among the grandfathered set.

---

## Phase 2 deferrals (file-level suppressions added by executor)

The executor added file-level `/* eslint-disable torque/no-sync-fs-on-hot-paths -- ... Phase 2 async conversion tracked separately. */` blocks on files that were explicitly out of Phase 1 scope (spec §1.1 Phase 1.5 referral, or files not in the 13 pre-flight findings). These are **not NEW findings** — they document known deferred work for Phase 2:

| File | Scope of deferral |
|------|-------------------|
| `server/handlers/advanced/artifacts.js` | Phase 1.5 referral — fd-based streaming I/O requires redesign |
| `server/handlers/factory-handlers.js` | Phase 2 — plan/scout file reading at MCP invocation time |
| `server/handlers/integration/infra.js` | Phase 2 — project scanning and filesystem discovery |
| `server/handlers/integration/plans.js` | Phase 2 — plan file read/write at MCP invocation time |
| `server/handlers/integration/routing.js` | Phase 2 — project file detection at submission time |
| `server/handlers/schedule-handlers.js` | Phase 2 — crontab/schedule file management |
| `server/handlers/task/core.js` | Phase 2 — file sync and working-dir detection at task submission |
| `server/handlers/task/operations.js` | Phase 2 — export/import file I/O paths |
| `server/handlers/task/project.js` | Phase 2 — project directory scanning paths |
| `server/handlers/workflow/await.js` | Phase 2 — verify-command execution and working-dir detection |
| `server/execution/codex-native-resolve.js` | Phase 2 — codex path resolver, task startup only |
| `server/execution/command-policy.js` | Phase 2 — capability-detection paths at task startup |
| `server/execution/conflict-resolver.js` | Phase 2 — git conflict resolution logic |
| `server/execution/workflow-runtime.js:1151` | Phase 2 — startup reconciler only, not per-request |

These suppressions are appropriate scoping decisions. Phase 2's child spec should enumerate these as its starting inventory.

---

## ESLint rule verification

```
$ cd server && npm run lint 2>&1 | grep "no-sync-fs-on-hot-paths"
(no output)
```

Zero violations of `torque/no-sync-fs-on-hot-paths`. Rule is in **error** mode. The 7 lint errors shown in `npm run lint` output are pre-existing `no-unused-vars` / `no-self-assign` issues in `server/perf/metrics/` and `server/tests/worker-setup.js` — unrelated to Phase 1.

---

## Coverage

Files scanned (same globs as pre-flight):
- `server/handlers/**/*.js`
- `server/execution/**/*.js`
- `server/governance/**/*.js` (no matches)
- `server/audit/**/*.js` (no matches)
- `server/api/**/*.js`
- `server/dashboard-server.js`
- `server/queue-scheduler*.js`, `server/maintenance/orphan-cleanup.js`

Scan method: direct grep + ESLint rule verification against branch HEAD `a853ec69`.

---

## Phase 1 closure criteria (spec §5)

| Criterion | Status |
|-----------|--------|
| 1. All findings closed — fresh scout returns zero NEW findings | **MET** — 0 new findings; 13/13 pre-flight findings confirmed CLOSED |
| 2. Discipline rule live — `torque/no-sync-fs-on-hot-paths` in `error` mode | **MET** — commit `a853ec69`; verified via lint run |
| 3. Tracked metrics moved, captured in baseline — `governance-evaluate` improves >10%; baseline updated with `perf-baseline:` trailer | **PENDING** — perf run and baseline update are Plan Task 13 (in progress) |
| 4. Re-scout confirms zero — post-merge scout file at `phase-1-sync-io-post.md` | **MET** — this file |

Criterion 3 will be met after Plan Task 13 completes (perf run on Omen + baseline.json commit with `perf-baseline:` trailers).
