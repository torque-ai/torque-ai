# Test Coverage Sweep - 2026-04-05

**Variant:** test-coverage
**Scope:** `server/**/*.js` cross-referenced against `server/tests/**/*.test.js`
**Baseline checked:** `docs/findings/2026-04-04-test-coverage-scan.md`

## Summary

The highest-risk gaps called out on 2026-04-04 for `server/execution/task-startup.js`, `server/providers/ollama-agentic.js`, `server/mcp/tool-mapping.js`, and `server/plugins/auth/session-manager.js` are now closed. `server/tests/event-bus.test.js` also expanded enough that it no longer belongs in the thin-coverage bucket.

This sweep used a stricter match than the prior basename-only pass: a source file counts as covered if a `server/tests` file either shares its basename or contains a relative module-path literal that resolves to that source file. That removed stale false positives such as `server/db/cron-scheduling.js`, `server/api/routes-passthrough.js`, `server/providers/adapters/google-chat.js`, `server/providers/adapters/openai-chat.js`, `server/providers/adapters/ollama-chat.js`, and `server/utils/proxy-agent.js`, all of which are referenced by the central suite today.

The raw unmatched set is still 112 files, but most of that is low-signal noise for this variant: 37 files under `server/tool-defs/`, 8 scripts, 2 config files, plus plugin-local modules whose tests live outside `server/tests`. The priority list below keeps only runtime modules that still have no direct `server/tests` match/reference after this session's additions.

## Closed This Session

- `server/execution/task-startup.js`
- `server/providers/ollama-agentic.js`
- `server/mcp/tool-mapping.js`
- `server/plugins/auth/session-manager.js`
- `server/validation/build-verification.js`
- `server/handlers/provider-crud-handlers.js`
- `server/plugins/remote-agents/remote-test-routing.js`

## Remaining Priority Gaps

| Tier | File | Lines | Why it still matters |
|------|------|-------|----------------------|
| P0 | `server/transports/sse/session.js` | 845 | Core SSE session state: replay IDs, dedup, eviction, per-IP limits, task subscriptions, notification delivery, and cleanup. |
| P0 | `server/db/file-tracking-scans.js` | 831 | Security and regression scan hub: vulnerability scans, API contract validation, config drift, regression detection, and XAML validation. |
| P0 | `server/db/resource-health.js` | 600 | Health status persistence, memory-pressure checks, cleanup, and vacuum behavior remain without direct coverage. |
| P0 | `server/db/approval-workflows.js` | 537 | Approval rule CRUD, request processing, auto-approval timing, and event-bus side effects are still uncovered. |
| P0 | `server/dashboard/dashboard.js` | 514 | Browser dashboard runtime wiring still has no direct central-suite reference despite being one of the larger UI entrypoints. |
| P0 | `server/transports/streamable-http.js` | 494 | Streamable HTTP transport negotiation, JSON-RPC error shaping, session lifecycle, and event streaming still lack direct tests. |
| P0 | `server/db/host-capacity.js` | 488 | VRAM-aware host gating, slot reservation/release, and workstation mapping remain uncovered. |
| P0 | `server/db/pipeline-crud.js` | 406 | Pipeline CRUD and step-order/state transitions still have no direct `server/tests` match. |
| P1 | `server/handlers/evidence-risk-handlers.js` | 415 | Evidence-risk handler surface still lacks direct validation around parsing, normalization, and error paths. |
| P1 | `server/execution/file-context-builder.js` | 299 | Context stuffing, symbol-level fallback, and edit-target parsing still have no direct tests. |
| P1 | `server/handlers/auto-commit-batch.js` | 290 | Verify/stage/commit/push orchestration plus resource-gate and shell-policy branches remain uncovered. |
| P1 | `server/db/provider-health-history.js` | 252 | Provider health window persistence and ISO date normalization still lack a dedicated suite. |
| P1 | `server/db/plan-projects.js` | 231 | Plan-project CRUD/status/counter logic is only exercised indirectly, not directly referenced by `server/tests`. |
| P1 | `server/plugins/auth/user-manager.js` | 222 | Password hashing, username/password validation, and user CRUD are still missing direct coverage. |
| P1 | `server/api/v2-audit-handlers.js` | 210 | V2 audit endpoint request validation and error shaping still have no direct tests. |
| P1 | `server/db/ci-cache.js` | 205 | CI cache persistence semantics remain unpaired with a direct suite. |
| P1 | `server/policy-engine/task-execution-hooks.js` | 185 | Submit/pre-execute/completion policy wrapper logic still lacks direct coverage. |

## Secondary Backlog

- `server/db/provider-routing-extras.js` (152)
- `server/execution/plan-project-resolver.js` (136)
- `server/versioning/version-intent.js` (132)
- `server/versioning/auto-release.js` (126)
- `server/plugins/auth/sse-auth.js` (108)
- `server/utils/path-resolution.js` (83)
- `server/utils/sensitive-keys.js` (82)
- `server/plugins/auth/rate-limiter.js` (78)
- `server/plugins/auth/resolvers.js` (77)
- `server/execution/effective-concurrency.js` (55)
- `server/plugins/snapscope/handlers/verify.js` (49)
- `server/plugins/snapscope/handlers/watch.js` (45)
- `server/plugins/auth/role-guard.js` (32)
- `server/utils/normalize-metadata.js` (31)
- `server/check_retry.js` (23)
- `server/timer-registry.js` (17)

## Not Carried Forward From 2026-04-04

- `server/db/cron-scheduling.js` is referenced from `server/tests/handler-adv-scheduling.test.js` and `server/tests/task-operations-handlers.test.js`.
- `server/api/routes-passthrough.js` is referenced from `server/tests/rest-passthrough-coverage.test.js` and `server/tests/rest-passthrough-openapi.test.js`.
- `server/providers/adapters/google-chat.js`, `server/providers/adapters/openai-chat.js`, and `server/providers/adapters/ollama-chat.js` are covered by `server/tests/agentic-adapters.test.js`.
- `server/utils/proxy-agent.js` is covered by `server/tests/proxy-support.test.js`.

## Current Recommendation

The next coverage pass should start with the transport/runtime modules that are both large and cross-cutting: `server/transports/sse/session.js`, `server/db/file-tracking-scans.js`, `server/db/resource-health.js`, and `server/db/approval-workflows.js`. Those are the biggest remaining direct-coverage holes after the tests added in this session.
