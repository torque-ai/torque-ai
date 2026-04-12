# 2026-04-12 Performance Sweep

Scope: `server/`, `dashboard/`, `scripts/`
Variant: `performance`

Reviewed prior findings under `docs/findings/`, especially `2026-04-05-performance-sweep.md`, `2026-04-04-full-performance-scan.md`, and `2026-04-04-runtime-performance-scan.md`. Previously documented issues, test-only code, and startup-only sync I/O are intentionally not repeated here. `scripts/` was scanned, but no net-new runtime findings survived deduplication.

## 1. High: Dashboard v2 request pre-parser buffers JSON bodies without the v2 size and depth guards

- Evidence: `server/dashboard-server.js:724-741` attaches raw `data` and `end` listeners, stores every chunk in memory, and calls `JSON.parse` directly into `req.body`.
- Contrast: `server/api/v2-dispatch.js:33-75` documents and enforces a 10 MB cap plus `validateJsonDepth`, but the dashboard-side pre-parser bypasses both safeguards before dispatching the same `/api/v2/*` handlers.
- Hot path: every mutating dashboard control-plane request on port 3456 (`POST`, `PUT`, `PATCH` to `/api/v2/*`) goes through this branch before `dispatchV2(...)`.
- Impact: user-controlled request bodies can grow without a cap and force full-buffer parse work on the main event loop, turning large payloads into avoidable memory pressure and parse latency on the dashboard server.

## 2. High: Factory project overview routes execute duplicate health queries per project

- Evidence: `server/handlers/factory-handlers.js:52-59` and `server/handlers/factory-handlers.js:204-228` iterate every project and call both `factoryHealth.getLatestScores(p.id)` and `factoryHealth.getBalanceScore(p.id)`.
- Amplifier: `server/db/factory-health.js:133-140` computes `getBalanceScore()` by calling `getLatestScores()` again, so each project row pays two separate latest-snapshot queries before any summary shaping happens.
- Additional path: `server/handlers/factory-handlers.js:75-89` adds one query per dimension for trends and another per dimension for findings when `project_health` is asked for richer output.
- Impact: `factory_status`, `list_factory_projects`, and detailed health views scale as N+1 query fans instead of a single batched read, which gets progressively more expensive as factory project count and dimension count grow.

## 3. High: Factory cost metrics recompute the same summary three times and then query cost data one task at a time

- Evidence: `server/handlers/factory-handlers.js:544-552` serves one response by calling `getCostPerCycle`, `getCostPerHealthPoint`, and `getProviderEfficiency` separately.
- Internals: each helper independently calls `buildProjectCostSummary(project_id)` (`server/factory/cost-metrics.js:16-35`), which reloads cycles and relevant tasks and then runs `getTaskCostData(db, task.id)` inside a `.map(...)` over every task (`server/factory/cost-metrics.js:71-118`).
- Query pattern: `getTaskCostData()` first probes token usage rows and then may fall back to a `cost_tracking` aggregate per task (`server/factory/cost-metrics.js:164-217`), producing an N+1 cost lookup pattern on top of the repeated full-summary rebuilds.
- Impact: one `factory_cost_metrics` request can traverse the same batch and task set three times and issue extra cost lookups per task, making the endpoint cost grow quickly with batch history size.

## 4. High: Post-batch feedback loads full score history per dimension because its “latest 2” query is oldest-first

- Evidence: `server/db/factory-health.js:123-130` returns history ordered `scanned_at ASC LIMIT ?`, so `factoryHealth.getScoreHistory(project_id, dimension, 2)` yields the oldest two rows, not the newest two.
- Caller behavior: `server/factory/feedback.js:258-270` tries that 2-row read first, then usually falls back to `factoryHealth.getScoreHistory(project_id, dimension)` and slices the last two rows from up to 100 loaded entries.
- Hot path: `server/factory/feedback.js:15-31` runs this through `buildHealthDelta(...)` during every `analyzeBatch()` call.
- Impact: once a dimension has more than two snapshots, feedback analysis typically performs two queries per dimension and over-reads historical rows just to recover the latest pair, wasting DB work on every completed batch.

## 5. Medium: Guardrail batch analysis scans recent project events in memory because `batch_id` was never indexed or queryable

- Evidence: `server/factory/feedback.js:221-224` asks `guardrailDb.getEvents(project_id, { limit: 100 })` for the latest project events and then filters `event.batch_id` in JavaScript.
- DB API: `server/db/factory-guardrails.js:39-64` supports only `project_id`, `category`, and `status` filters, so batch-specific lookups always read broader project history first.
- Schema gap: migration 16 creates `factory_guardrail_events.batch_id` but only indexes `(project_id, created_at)` and `(project_id, category)` at `server/db/migrations.js:322-339`; there is no `batch_id` or `(project_id, batch_id, created_at)` index.
- Impact: post-batch analysis pays avoidable row reads for unrelated guardrail events, and on busier projects the 100-row cutoff can miss older matching events for the requested batch altogether.
