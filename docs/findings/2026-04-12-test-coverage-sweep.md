# Test Coverage Sweep
Date: 2026-04-12
Scope: server/ (focus on server/factory/, server/handlers/, server/db/, server/execution/)
Variant: test-coverage
Baseline checked: docs/findings/2026-04-05-test-coverage-sweep.md
Summary: 6 findings: 3 high, 2 medium, 1 low.

## Method

- Cross-referenced 536 `server/**/*.js` source files against 748 `server/tests/**/*.test.js` files.
- Used two passes: a permissive basename/content match for repo-wide inventory, then a stricter direct-suite pass for `server/factory/`, `server/handlers/`, `server/db/`, and `server/execution/`.
- Sampled 12 existing tests for quality, branch depth, and mock intensity.
- `scan_project` was available for TODO/size signals, but it did not emit a `missingTests` payload in this run, so file-to-test matching was done directly.

## Summary

No new `CRITICAL` gaps surfaced in core execution or security modules. The April 5 execution backlog around `queue-scheduler`, `workflow-runtime`, `db/workflow-engine`, `task-startup`, and `task-finalizer` was sampled again and not reopened. The new risk is concentrated in large handler aggregators and the factory health scoring layer: several route-exposed modules are only touched by schema or route smoke tests, and parts of the factory scorer stack still rely on synthetic fixtures instead of scorer-specific assertions.

### [HIGH] `server/handlers/validation/index.js` has no behavioral suite for its success paths
File: `server/handlers/validation/index.js`
Description: The module is 991 lines and owns local logic for validation-rule CRUD, task-output git diff inspection, hook registration/removal, pre-commit hook generation, diff preview, build checks, cost/budget handlers, and approval-gate checks. Existing tests do not cover those branches well. `server/tests/validation-handlers.test.js` has 124 tests and 170 assertions, but the suite is dominated by invalid-input checks and generic output assertions; 12 cases only assert that `text.length > 0`, and the suite never seeds a git repo or verifies generated pre-commit hook files. `server/tests/tool-output-schemas.test.js` only checks `structuredData` shape for tools like `handleGetBudgetStatus()`.
Status: NEW
Suggested fix: Add a direct `validation-index.test.js` suite that exercises happy-path and failure-path behavior for `handleSetupPrecommitHook`, `handleValidateTaskOutput`, `handlePreviewTaskDiff`, `handleRunBuildCheck`, `handleGetBudgetStatus`, and `createValidationHandlers`, using temp git repositories plus filesystem assertions.

### [HIGH] `server/handlers/integration/index.js` is route-covered but not behavior-covered
File: `server/handlers/integration/index.js`
Description: The 1008-line integration aggregator contains local logic for report export previews, integration health checks, webhook test requests, git diff/task rollback/stash flows, dependency visualization, and chunked-review submission. Coverage today is mostly smoke-only. `server/tests/integration-handlers-reports.test.js` has 27 tests and 34 assertions, but most only assert that a string was returned or that `isError` is falsy. `server/tests/tool-output-schemas.test.js` checks only response shape for `handleIntegrationHealth`, and `server/tests/rest-passthrough-coverage.test.js` verifies route registration only. No suite verifies malformed export payload handling, git rollback/stash side effects, network failure paths for webhook tests, or chunk/aggregation task creation.
Status: NEW
Suggested fix: Add a dedicated `integration-index.test.js` suite that seeds exports, stubs HTTPS calls, creates temp git repos, and verifies task creation plus DB side effects for `handleExportReportJSON`, `handleIntegrationHealth`, `handleTestIntegration`, `handleTaskChanges`, `handleRollbackFile`, `handleStashChanges`, and `handleSubmitChunkedReview`.

### [HIGH] `server/handlers/codebase-study-handlers.js` has effectively zero behavioral coverage
File: `server/handlers/codebase-study-handlers.js`
Description: The module is 726 lines of bootstrap, schedule configuration, threshold validation, result formatting, and path-resolution logic for the codebase study feature. It is only referenced by meta-tests: `server/tests/rest-passthrough-coverage.test.js` checks that the routes exist, and `server/tests/p3-async-trycatch.test.js` exempts it from inline try/catch requirements. No handler-focused test imports the module or verifies schedule create/update flows, invalid threshold combinations, profile override persistence, bootstrap preview defaults, or `structuredData` payloads.
Status: NEW
Suggested fix: Add `codebase-study-handlers.test.js` with temp working directories and scheduled-task doubles covering `handleRunCodebaseStudy`, `handleGetStudyStatus`, `handleBootstrapCodebaseStudy`, `handleConfigureStudySchedule`, and the proposal-threshold validation branches.

### [MEDIUM] Factory scorer coverage is uneven and overly synthetic
File: `server/factory/scorer-registry.js`; `server/factory/scorers/test-coverage.js`; `server/factory/scorers/dependency-health.js`; `server/factory/scorers/documentation.js`; `server/factory/scorers/performance.js`
Description: The health-model tests look broader than they are. `server/tests/factory-scorers.test.js` does invoke `scoreDimension()` across all dimensions, but most dimensions only get range or smoke assertions against a fabricated `MOCK_SCAN_REPORT`. There are scorer-specific checks for `test_coverage`, `structural`, `debt_ratio`, `security`, and `build_ci`, plus dedicated suites for `api_completeness` and `user_facing`, but `dependency_health`, `documentation`, and `performance` still have no direct assertions. `test-coverage.js` and `debt-ratio.js` also never run against real `docs/findings` directories or realistic `scan_project` payloads beyond the synthetic fixture.
Status: NEW
Suggested fix: Add one focused test file per uncovered scorer or a table-driven scorer suite that uses real findings directories and realistic `scan_project` payload fragments, including missing-data and malformed-data branches.

### [MEDIUM] Route and schema conformance tests are inflating the apparent coverage of handler surfaces
File: `server/tests/tool-output-schemas.test.js`; `server/tests/rest-passthrough-coverage.test.js`; `server/tests/p3-async-trycatch.test.js`
Description: These suites are valuable, but they are counting toward handler coverage without testing handler behavior. `tool-output-schemas.test.js` verifies output shapes and often exits early when a handler returns no `structuredData`; `rest-passthrough-coverage.test.js` only checks route tables and tool-def exports; `p3-async-trycatch.test.js` only enforces wrapper shape. Together they make large handler modules look covered in naive filename or content sweeps even when the filesystem, git, DB, network, or task-creation branches remain untouched.
Status: NEW
Suggested fix: Keep these suites, but track them separately from behavioral coverage. Future sweeps should distinguish route/schema/meta coverage from success-path and side-effect coverage.

### [LOW] Small route-exposed shims remain uncovered and may drift from their canonical implementations
File: `server/handlers/budget-handlers.js`; `server/handlers/provider-scoring-handlers.js`; `server/handlers/discovery-handlers.js`; `server/handlers/model-registry-handlers.js`; `server/handlers/template-handlers.js`; `server/handlers/symbol-indexer-handlers.js`; `server/handlers/agent-discovery-handlers.js`; `server/handlers/circuit-breaker-handlers.js`
Description: These files are small, but they are live tool surfaces via `server/tools.js`. Several duplicate logic that is also exposed elsewhere. For example, `tool-output-schemas.test.js` exercises `handleGetBudgetStatus` through `handlers/validation/index.js`, not through `handlers/budget-handlers.js`; provider scoring is covered through other handler surfaces, not through `provider-scoring-handlers.js`. That leaves the standalone container error paths and success branches unverified.
Status: NEW
Suggested fix: Either collapse duplicate handler entrypoints into one canonical module or add direct happy-path and container-missing tests for each public shim.

## Sampled Test Quality

Strong suites sampled in this pass:

- `server/tests/queue-scheduler.test.js`: 78 tests, 153 assertions. Real scheduling behavior, queue TTLs, overflow logic, and event-driven processing.
- `server/tests/workflow-runtime.test.js`: 80 tests, 179 assertions. DB-backed dependency and pipeline behavior with real state transitions.
- `server/tests/db-workflow-engine.test.js`: 9 tests, 49 assertions. Good persistence and DAG coverage without mock-only shortcuts.
- `server/tests/factory-guardrails.test.js`: 21 tests, 34 assertions. Exercises both pure checks and DB-backed guardrail event flows.
- `server/tests/factory-policy.test.js`: 36 tests, 55 assertions. Good branch coverage for validation and policy helpers.

Mixed suites:

- `server/tests/task-startup.test.js`: 12 tests, 43 assertions, 58 mocks. Good branch intent, but much of the environment is synthetic, so real process/git/fs interaction risk remains.
- `server/tests/task-finalizer.test.js`: 13 tests, 50 assertions, 70 mocks. Strong terminal-state logic coverage, but provider/db integration is still largely mocked.
- `server/tests/factory-architect.test.js`: 13 tests, 42 assertions. Useful DB-backed coverage, but it does not exercise the handler-specific scheduling/bootstrap surfaces added later in `codebase-study-handlers.js`.

Weak or false-confidence suites:

- `server/tests/validation-handlers.test.js`: 124 tests, 170 assertions, but mostly invalid-input checks; success paths and side effects are largely unverified.
- `server/tests/integration-handlers-reports.test.js`: 27 tests, 34 assertions; mostly smoke tests that accept any returned string.
- `server/tests/tool-output-schemas.test.js`: 52 tests, 162 assertions; useful for output-shape contracts, not for handler behavior.
- `server/tests/task-manager-delegations.test.js`: 6 tests, 10 assertions, 72 mocks; export and wiring coverage only.
- `server/tests/rest-passthrough-coverage.test.js`: 9 tests, 22 assertions; route-table coverage only.

## Deduped / Not Repeated

- The April 5 priority gaps for `server/execution/queue-scheduler.js`, `server/execution/workflow-runtime.js`, `server/db/workflow-engine.js`, `server/execution/task-startup.js`, and `server/execution/task-finalizer.js` were sampled again and not reopened here. Their current suites are not perfect, but they are materially stronger than the uncovered handler and factory gaps above.
- This sweep intentionally does not restate the April 5 transport and db backlog (`server/transports/*`, `server/db/resource-health.js`, `server/db/approval-workflows.js`, and similar). Those findings remain in the prior sweep and were not re-audited deeply in this pass.
