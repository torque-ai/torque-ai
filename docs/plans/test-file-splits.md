# Test File Splits — deferred Phase 4 Task 10

**Status:** drafted 2026-04-27, deferred to Codex when subscription cap lifts.

**Why:** the perf-arc Phase 4 doc explicitly skipped Task 10 ("Top-20 file splits"). Vitest distributes work at file granularity, so a 3917-line test file blocks one worker for its full duration regardless of `maxWorkers`. The Phase 4 closeout left ~22K lines of test code in 10 files >2000 lines.

The 2026-04-27 perf-gate session (commits ea653c5b … 2156703d) shipped four orthogonal wins (segfault retry, maxWorkers 16, `git clean -fd`, `git fetch --prune` + sequential perf restore) and measured the gate at ~323s steady state, down from a 396s baseline. Splitting these files is the next-biggest lever on wall time, but it's not mechanical, so it shouldn't ship under time pressure.

## Files in scope (current line counts)

| Lines | File |
|---:|---|
| 3917 | server/tests/agentic-execution-fixes.test.js |
| 2715 | server/tests/api-server.test.js |
| 2360 | server/tests/task-core-handlers.test.js |
| 2191 | server/tests/v2-task-handlers.test.js |
| 2175 | server/tests/dashboard-infrastructure-routes.test.js |
| 2170 | server/tests/queue-scheduler.test.js |
| 2162 | server/tests/v2-infrastructure-handlers.test.js |
| 2073 | server/tests/factory-loop-controller.test.js |
| 2066 | server/tests/policy-engine-core.test.js |
| 2044 | server/tests/process-lifecycle.test.js |

## Why this isn't mechanical

Both top-2 files (the only ones I scoped in detail this session) share a structural pattern that prevents naive describe-block splitting:

1. **One outer `describe(...)`** wraps the entire file.
2. **Heavy shared state inside that describe**: 20+ `let` declarations for spies, mock stores, request handlers.
3. **Long `beforeAll`** that spies on a dozen modules and calls `apiServer.start({ port: 4001 })` (or equivalent server-bring-up) once.
4. **Long `beforeEach`** that re-mocks defaults for every test.
5. **7-10 closure-scoped helper functions** (e.g., `createTaskRow`, `ensureTaskStore`, `buildTestProviderMap`, `mockV2Adapter`) that each test depends on.
6. **40-50 `it(...)` blocks** at the same level — no nested describes.

Splitting requires:
- Extracting items 1-5 into a sibling fixture module exporting a `setupHarness()` factory.
- Each split file imports the helpers and reconstructs its own outer describe with its own beforeEach.
- **Port conflict resolution**: `apiServer.start({ port: 4001 })` per file → port collisions under `pool: threads`. Either randomize ports per file (`getPort()` from `node-getport`), share a process-wide singleton across files (hard with vitest threads isolation), or skip the start and assert on imports/handlers without a live server.
- Per-file cold-import cost amortization — splitting one 3000-line file into three 1000-line files triples the cold-import cost for `tools`, `task-manager`, etc. The wall-time win is from worker parallelism, but the per-file overhead has to fit under the freed budget.

## Recommended split — `api-server.test.js` (concrete proposal)

`describe` map already done:
- Lines 117-2300: outer describe, v2 + legacy + general endpoints
- Lines 2301-2620: 5 nested describes (rate limiting, /readyz, /livez, /healthz with timeout, POST /api/shutdown auth)

Proposed slices:

1. **`server/tests/helpers/api-server-fixture.js`** (new, ~250 lines)
   - Helpers: `createMockResponse`, `dispatchRequest`, `parseSseEvents`
   - Factory: `setupApiServerHarness({ port })` → `{ getRequestHandler, spies: {...}, helpers: { createTaskRow, ensureTaskStore, emitTaskEvent, buildTestProviderMap, setProviderLookup, mockV2Adapter, getRecordProviderUsageCalls, ... }, mockTaskStore, mockTaskEventsStore }`. Internally registers beforeAll/afterAll/beforeEach via vitest globals when called inside a describe scope.
   - Default port is randomized per call (use `:0` to let kernel allocate, then capture from `mockServer.listen` callback) so each test file gets its own.

2. **`server/tests/api-server-v2.test.js`** (~1500 lines)
   - All `POST /api/v2/inference` cases (sync/async/stream, validation, transport selection, codex async fallback, normalized response shape)
   - All `GET /api/v2/providers/*` (descriptors, detail, capabilities, models, health, 404s)
   - `GET /api/v2/tasks/{task_id}/events`, `POST /api/v2/tasks/{task_id}/cancel`
   - ~27 it() blocks total

3. **`server/tests/api-server-legacy.test.js`** (~200 lines)
   - MCP-compat forwarding: `/api/tasks` (GET/DELETE), `/api/status`, `/api/providers`, `/api/providers/configure`, `/api/providers/default`, `/api/provider-scores`, `/api/ollama/hosts*`, `/api/workflows/{id}/tasks`, `/api/tools/strategic_decompose`
   - "rollback drill: v2 disabled and MCP compat still responds"
   - ~14 it() blocks

4. **`server/tests/api-server-security.test.js`** (~500 lines)
   - General: `/healthz`, OPTIONS preflight, strict-mode auth, 404, security headers, CORS origin
   - Nested describes (preserved as-is): rate limiting, /readyz, /livez, /healthz with timeout, POST /api/shutdown auth
   - ~12 it() blocks + 5 nested describes

5. **DELETE** `server/tests/api-server.test.js` after the three new files exist and pass.

Verification: `cd server && npx vitest run --reporter=dot tests/api-server-v2.test.js tests/api-server-legacy.test.js tests/api-server-security.test.js` → expect identical pass/skip counts as the original (currently 42 it blocks producing 42 passes minus 0 failures on origin/main).

## Recommended split — `agentic-execution-fixes.test.js` (concrete proposal)

`describe` map: one outer `describe('providers/execution agentic fixes', () => {` with 45 it() blocks at the same level. Categories visible from test names:

| Slice | Line range | Theme | ~it count |
|---|---|---|---|
| fallback-chains | 275-1253 | free-provider fallback, OpenRouter template/model resolution, scored fallback chains, parser-capable ordering, no-op requeue, lane-blocked failures | 13 |
| proposal-apply | 1318-1964 | read-only outputs, repo-write proposals, CRLF/LF line-ending diffs, factory-architect JSON, Codex apply forbidden | 8 |
| host-lifecycle | 2040-2476 | host slot reservation, runningProcesses tracking, no-file-change failure, write-only-error failure, max-iter partial-edit failure, partial-edit revert, snapshot persistence | 7 |
| next-task-policy | 2557-3367 | NEXT_TASK.md vs .json precedence, max_iterations, constrained metadata, fallback to .md, planning short-circuit cases | 9 |
| strict-execution | 3459-end | strict verification failures, iteration-budget failures, framework SESSION_LOG.md append, required-modified-path merging, post-strict file revert, write-allowlist propagation | 8 |

Same fixture-extraction pattern as api-server. Top-of-file `TRACKED_CACHE_PATHS` (lines 30-50) belongs in the fixture too — it lists 19 module paths the tests touch via `delete require.cache[]`.

## Other 8 files

For these, I'd repeat the pattern: scout the file's describe-map, identify natural test groupings, propose 2-4 slices each. Each file is its own task — bundling them risks a single failure cascading.

## Suggested execution path

**Phase 1 — Codex batch (when cap lifts, 2026-04-28+):** one task per file, run as a workflow with `step_providers: { fixture: "codex", split: "codex", verify: "ollama" }`. Each task description should:
- Inline the slice plan (line ranges + theme) so Codex doesn't have to re-derive.
- Require `setupHarness()` factory pattern + per-file randomized ports.
- Require running `npx vitest run --reporter=dot tests/<new files>` and reporting pass/fail before declaring done.
- Use `auto_verify_on_completion: true` so the close-handler pipeline auto-retries on test failure.

**Phase 2 — measurement:** after each file lands, push to main and record gate wall. Track which splits actually moved the needle. Some files might split for organization but show no wall-time impact (because they weren't the worker bottleneck).

**Phase 3 — backlog cleanup:** anything remaining >1500 lines after phase 1, evaluate again. The Phase 4 perf doc's discipline rule (`torque/no-heavy-test-imports`) already prevents new top-level `tools.js` imports — should consider adding a similar `torque/test-file-max-lines` rule with exceptions for files that genuinely need their size.

## Why not now (today, 2026-04-27)

- Codex cap until Apr 28 (memory: `project_free_provider_tuning_session.md`).
- Manual hand-split of 10 files = ~8h of careful work, real risk of regressing the 21K passing tests.
- The factory autopilot is actively landing codegraph commits all session — picking files that touch handlers/api routes risks merge conflicts mid-refactor.
- Today's perf-arc work already shipped a measured 18% gate-wall reduction; further wins are diminishing-returns territory.

The four perf changes already on origin/main (segfault retry, maxWorkers 16, clean -fd, fetch --prune) plus the retry-resilience hardening (commit 2156703d) put the gate at a stable steady state. File splitting is the *next* lever, not a blocker on shipping.
