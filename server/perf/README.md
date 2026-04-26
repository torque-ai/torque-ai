# Performance Harness

Measures hot-path latency, request latency, DB query timing, test infra cold-import, and dev-iteration speed across 13 tracked metrics. The committed `baseline.json` is the contract; pre-push gate fails if any tracked metric regresses >10%.

## Quick start

```bash
# Run all metrics, write last-run.json, compare to baseline.
npm run perf

# List registered metrics.
node perf/run-perf.js --metrics-list

# Promote last-run.json to baseline.json (requires perf-baseline: trailer in commit).
node perf/run-perf.js --update-baseline
```

## Metric set (v0)

13 metric definitions; #9 and #11 have multiple variants in baseline.json:

| ID | Category | Description |
|---|---|---|
| `queue-scheduler-tick` | hot-path-runtime | categorizeQueuedTasks against 5000-task fixture |
| `task-core-create` | hot-path-runtime | DB createTask with validation |
| `governance-evaluate` | hot-path-runtime | evaluate(task_submit) — primary Phase 1 signal |
| `handler-project-stats` | request-latency | handleProjectStats handler against 1000-task project |
| `mcp-task-info` | request-latency | handleToolCall('task_info') round-trip |
| `sse-dispatch` | request-latency | SSE notification dispatch (in-process, 100 sessions) |
| `db-factory-cost-summary` | db-query | buildProjectCostSummary against 100-task batch |
| `db-project-stats` | db-query | getProjectStats against 1000-task project |
| `db-list-tasks` | db-query | listTasks 1000 rows; variants `parsed`, `raw` |
| `db-budget-threshold` | db-query | budget threshold windowed-spend lookup |
| `cold-import` | test-infra | spawn fresh node, require module; variants `tools`, `task-manager`, `database`, `db-task-core` |
| `worktree-lifecycle` | dev-iteration | git worktree add --no-checkout + remove |
| `restart-barrier` | dev-iteration | restart barrier check (per-call, 1000x amplified) |

## Run protocol

Each metric runs `warmup` iterations (results discarded), then `runs` measurement iterations. The driver returns the trimmed-median (top/bottom 10% trimmed when runs ≥ 10) plus optional p95 for request-latency metrics. Variants run independently and produce separate baseline entries (`<id>.<variant>`).

## Baseline update protocol

When a fix legitimately changes a tracked metric:

1. From the feature worktree, run `npm run perf` and confirm timings.
2. Run `node perf/run-perf.js --update-baseline` to promote `last-run.json` to `baseline.json`.
3. Commit `baseline.json` with a `perf-baseline:` trailer per changed metric:

```
perf: ship Phase 1 sync I/O migration

perf-baseline: governance-evaluate 144 to 12 (Phase 1: async git subprocesses replace sync ones)
perf-baseline: task-core-create 0.43 to 0.18 (Phase 1: governance no longer blocks pipeline)
```

4. Push. The pre-push gate validates the trailer; missing or short rationale (<20 chars after the arrow) blocks the push.

## Bypass

`PERF_GATE_BYPASS=1 git push` allows a push despite a perf regression. Logged to `server/perf/bypass-audit.log`. Use only during incident response.

## Variance and stability

Run timings on the canonical `torque-remote` workstation are the reference baseline. Local runs work but produce a `NOTICE: ... advisory mode` banner when the host_label differs from the baseline; in advisory mode the gate does not block.

## Adding a metric

1. Create `server/perf/metrics/<slug>.js` exporting the metric module contract (see `metrics/_template.md`).
2. Register in `server/perf/metrics/all.js`.
3. Add a unit test under `server/tests/perf-metric-<slug>.test.js`.
4. Run `npm run perf` and confirm it appears in the output.
5. Capture a baseline entry for the new metric: `node perf/run-perf.js --update-baseline`, commit with a `perf-baseline:` trailer documenting the new addition.

## Phase notes (audit trail corrections)

### Phase 2 — `cold-import.tools` 718ms → 859ms (+20%)

The Phase 2 baseline-update commit's trailer attributed this regression to "new eslint rules at startup." That attribution is **incorrect**. ESLint rules are loaded only by `eslint.config.js` at `npx eslint` time; they are NOT in `tools.js`'s require chain.

Investigation (5× cold-import samples, BahumutsOmen) confirmed the regression is real (875ms median, 12ms spread — well above noise) and identified the actual cause:

**V8 parse+compile cost of ~160 lines of legitimate Phase 2 N+1-fix code**, distributed across modules transitively required by `tools.js`:

| Module | Δ cold-import | New code |
|---|---|---|
| `db/factory-health.js` | +11ms | `getLatestScoresBatch`, `getScoreHistoryBatch` |
| `db/task-metadata.js` | +4ms | `json_each` rewrites |
| `db/scheduling-automation.js` | +3.6ms | PRAGMA cache |
| `handlers/factory-handlers.js` (transitive) | +43ms | wired-up batch primitive callers |

All statement caches are lazy-init (`db/task-core.js`, `db/project-config-core.js` show 0ms delta, confirming no eager-evaluation bug). The 859ms baseline value is correct; only the attribution was wrong.

**v0.1 follow-up:** if cold-import.tools needs to come back down, the path is lazy-requiring `factory-handlers` from `tools.js` (load on first MCP tool call rather than at module require). That's a Phase 4-class lazy-load change, not a Phase 2 fix.

## Files in this directory

- `run-perf.js` — CLI entry; supports `--metrics-list`, `--update-baseline`, default run.
- `driver.js` — runs each metric (warmup, runs, trimmed median, p95, variants).
- `metrics/index.js` — registry. `register()`, `list()`, `_reset()`.
- `metrics/all.js` — single registration aggregator (require each metric module here).
- `metrics/<slug>.js` — one per metric.
- `metrics/_template.md` — contract documentation.
- `fixtures.js` — seeded in-memory fixture builder used by metrics that need a DB.
- `report.js` — `captureEnv`, `writeLastRun`, `readBaseline`, `compareToBaseline`, `updateBaseline`.
- `baseline.json` — committed v0 baseline. Source of truth for the regression gate.
- `last-run.json` — gitignored; written every run.
- `bypass-audit.log` — gitignored; appended when `PERF_GATE_BYPASS=1` is used.
