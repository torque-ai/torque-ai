# Holistic Architecture Review - 2026-05-18

## Decision

TORQUE's overall architecture is viable: a local-first control tower around MCP/REST entry points, deliberate provider routing, SQLite-backed task/workflow state, quality gates, and factory automation. It does need architectural improvement, but the evidence points to staged boundary hardening and decomposition instead of a new platform layer.

## Evidence Snapshot Before This Branch

Commands run from the repository root or the feature worktree:

- `server/scripts/check-no-direct-db-import.js --summary` reported one source file importing `database.js`: `handlers/experience-handlers.js`.
- `server/scripts/di-migration-metrics.js --json` reported `54` container registrations, `30` wired-at-boot services, `38` imperative-init modules, and one direct DB importer.
- `server/tool-metadata.js` currently exposes `685` built-in tools; `server/tools.js` wires `53` handler modules.
- `server/db` and `server/handlers` each contain `90` JavaScript files.
- Largest non-test server files before implementation:

| Lines | File |
|------:|------|
| 6865 | `server/factory/loop-controller.js` |
| 4084 | `server/providers/execution.js` |
| 3950 | `server/factory/plan-execute.js` |
| 3842 | `server/db/schema/tables.js` |
| 2942 | `server/handlers/factory-handlers.js` |
| 2479 | `server/execution/task-startup.js` |
| 2375 | `server/index.js` |
| 2370 | `server/factory/plan-generation-cluster.js` |
| 2288 | `server/handlers/workflow/await.js` |
| 2280 | `server/providers/execute-cli.js` |

## Problem Themes

1. **Boundary regressions are still possible.** The DI migration guard had reached a zero-import target, but a new handler reintroduced a direct `database.js` fallback. This is an architectural boundary problem, not a feature bug.
2. **Progress metrics were slightly misleading.** With one direct DB importer, `check-no-direct-db-import.js --summary` rounded progress to `100%`, which weakens the ratchet signal.
3. **Architecture documentation drifted.** `docs/architecture.md` still described `671` built-in tools, `22` handler files, and `15` DB submodules. Current counts are materially different.
4. **The main structural risk is concentrated module size.** The factory loop/controller, provider execution, plan execution, schema bootstrap, and factory handlers are the biggest comprehension and change-risk hotspots.

## Plan Series

### Plan 1 - Restore DI Boundary Ratchet

Status: implemented in this branch.

Work:
- Replace the experience handler's direct `require('../database')` fallback with `resolveDatabaseFacade(...)` and `unwrapDbHandle(...)`.
- Keep `check-no-direct-db-import.js` as the ratchet for source imports.
- Make progress output avoid reporting `100%` unless there are zero source violations.

Validation:
- `npm run lint:di`
- `npx vitest run tests/check-no-direct-db-import.test.js tests/plan-exhaustion-core.test.js`

### Plan 2 - Refresh Architecture Source of Truth

Status: implemented in this branch.

Work:
- Update `docs/architecture.md` with current tool, handler, and DB module counts.
- Add this review as the evidence-backed plan record so future work starts from current metrics.

Validation:
- Source-grep confirms stale `671 built-in`, `22 files`, and `15 sub-` claims are removed from the main architecture guide.

### Plan 3 - Start Factory Runtime Decomposition With a Pure Policy Slice

Status: implemented in this branch.

Work:
- Extract the `needs_replan` timestamp, cooldown, and candidate-penalty policy from `server/factory/loop-controller.js` into `server/factory/needs-replan-policy.js`.
- Add direct unit coverage for the extracted policy so future loop-controller changes do not need to import the full controller to validate this logic.

Acceptance:
- `server/factory/loop-controller.js` no longer owns the extracted policy constants and pure helpers.
- `npx vitest run tests/factory-needs-replan-policy.test.js` passes.

## Post-Implementation Evidence

- `server/scripts/check-no-direct-db-import.js --summary`: `0` source direct database imports, `0` stale allowed entries, `0` unauthorized test imports.
- `server/scripts/di-migration-metrics.js --json`: `direct_database_importers: 0`, `di_fallback_database_importers: 0`, `imperative_init_modules: 38`.
- `server/factory/loop-controller.js`: reduced from `6865` to `6781` lines.
- `server/factory/needs-replan-policy.js`: new `97` line pure policy module with focused tests.
- `docs/architecture.md`: main architecture guide now reflects `685` built-in tools, `90` handler files, and `90` DB modules.

## Larger Follow-Up Recommendations

These are intentionally not part of this branch's implemented plan series because each is a higher-risk architectural refactor that should move through its own feature worktree and focused verification:

- Continue factory runtime decomposition: extract plan execution state transitions from `server/factory/plan-execute.js`, then split `server/handlers/factory-handlers.js` by read-only queries, lifecycle mutations, and recovery actions.
- Continue composition-root migration: convert one low-risk imperative-init module at a time to a container-registered service. Keep `server/scripts/di-migration-metrics.js --json` as the scoreboard.

Acceptance for future slices:
- Parent file size decreases by one cohesive section per slice.
- `imperative_init_modules` decreases monotonically for DI migration slices.
- `direct_database_importers`, `allowed_database_importers`, and `di_fallback_database_importers` remain `0`.
- Factory smoke and baseline factory tests pass through `scripts/test-lane.ps1 -Lane auto` when runtime behavior changes.
