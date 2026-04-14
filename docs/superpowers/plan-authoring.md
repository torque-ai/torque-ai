# Plan Authoring Guide for TORQUE Factory

Every plan that lands on `main` runs through factory VERIFY, which executes the full test suite. Plans that add MCP tools, REST routes, or new async handlers must account for the following coverage/style gates, or VERIFY will fail on alignment regressions.

## Required checks when adding new MCP tools

1. Tool-name collision check. Before naming a new MCP tool, audit existing tool defs and handlers for collisions. If a similar tool already exists, extend it or choose a distinct name instead of shadowing the existing route.
2. Handler error convention. New handlers must return the shared helper error shape on validation or operational failure, not raw `throw new Error(...)`. Follow the existing top-level `try { ... } catch (err) { return makeError(...) }` pattern used by compliant handlers.
3. Coverage alignment tests to update. Every new MCP tool must update these files together:
   `server/tests/core-tools.test.js`
   `server/tests/tool-schema-validation.test.js`
   `server/tests/tools-aggregator.test.js`
   `server/tests/p3-async-trycatch.test.js`
   `server/tests/rest-passthrough-coverage.test.js`
4. Container wiring for tests. If a new handler resolves services from the container, register those services in test bootstrap or in the affected test setup before the handler change lands.
5. Audit existing tests that touch the same surface. Identify pre-existing tests covering the same handler, route, or subsystem and update their expectations in the same change instead of waiting for a remediation cycle.
6. Configurable pricing or thresholds, not hardcoded. Cost tables, limits, thresholds, and similar policy values must be configurable or clearly documented as estimates so tests can set deterministic expectations.

## When adding REST routes

- Domain goes in `server/tests/rest-passthrough-coverage.test.js` `EXPECTED_DOMAINS` list.
- Matching tool definition is required and is cross-checked by `server/tests/rest-passthrough-coverage.test.js`.

## When adding async handlers

- Top-level `try/catch` is required by `server/tests/p3-async-trycatch.test.js`.
- Use helper-error return, not raw `throw`, to satisfy `server/tests/p3-raw-throws.test.js`.

## When adding DB tables

- Update the expected tables list in `server/tests/schema-tables.test.js`.
- Update the expected indexes list in `server/tests/schema-migrations.test.js`.
- Update `server/tests/vitest-setup.js` so the test schema creates the new table for existing suites.
