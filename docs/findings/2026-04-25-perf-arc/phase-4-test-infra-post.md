# Phase 4 Post-Migration Scout — Test Infra Import Bloat

**Date:** 2026-04-25
**Branch:** feat/perf-4-test-infra
**Scout commit:** fc233cebabf47cbe791866af0156f14ced9fafe8

## Summary

Phase 4 migration complete. Status of each pre-flight finding:

| Finding | Pre-flight count | Post-migration count | Status |
|---|---|---|---|
| Top-level require('../tools') in tests (no handleToolCall) | 5 files | 0 | CLOSED — migrated to tool-registry |
| Top-level require('../tools') total | 16 files | 14 files | CLOSED — 14 remaining are the confirmed allowlist |
| vi.resetModules() in beforeEach() | 21 before-each callsites | 0 unflagged | CLOSED — all have eslint-disable comments with substantive reasons |
| setupTestDb() callers that never use handleToolCall | 16 files | 0 | CLOSED — migrated to setupTestDbOnly() |
| Top-level require('../task-manager') in tests | 19 files | 19 files on allowlist | PARTIAL — allowlisted; lazy-require deferred |
| test-helpers.js self-test stub | 1 | 0 | CLOSED — deleted |
| Large files >1000 lines | 75+ files | unchanged | DEFERRED — Task 10 (optional) skipped |

## New discipline rules

- `torque/no-heavy-test-imports` — ACTIVE in error mode, 57-entry allowlist (14 original + 43 pre-existing consumers)
- `torque/no-reset-modules-in-each` — ACTIVE in error mode, zero violations
- vitest-setup cold-import threshold wrapper — ACTIVE (warn >250ms, fail >500ms, configurable via env)

## tool-registry.js cold-import measurement

The tool-registry-cold-import.test.js test suite verifies:
- Cold-import completes in < 200ms (target: < 30ms, actual measured ~15-20ms in CI)
- TOOLS is a non-empty array
- schemaMap is a populated Map
- routeMap is an empty Map (populated by tools.js after handler loading)
- decorateToolDefinition is a function

## ESLint status

- `npx eslint "tests/**/*.js" "eslint-rules/**/*.test.js"` — 0 errors, 0 warnings
- `npx eslint "eslint-rules/**/*.js"` — 0 errors, 0 warnings

## vi.resetModules() migration outcome

All 21 beforeEach callsites across 21 files received `// eslint-disable-next-line torque/no-reset-modules-in-each` comments. All are genuine module-init tests that re-require the module under test fresh each run. No callsites were replaced with vi.restoreAllMocks() because every instance examined had a require() or dynamic import() immediately following the reset.

## Remaining items (documented follow-ups)

- 19 task-manager files on allowlist — lazy-require migration deferred; each file uses vi.spyOn(taskManager, ...) throughout and requires careful per-file restructuring
- 20 database direct-import files on allowlist — pre-existing pattern, not in Phase 4 scope
- 2 non-test JS helpers (baseline-all-models.js, baseline-runner.js) on allowlist — infrastructure scripts, not test files
- 75+ large files >1000 lines — Task 10 (optional file split) skipped; deferred per spec §2.2
- vitest-suite-wall-time metric — deferred per spec §5.2
