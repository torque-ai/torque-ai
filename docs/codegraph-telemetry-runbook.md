# Codegraph telemetry runbook

The `cg_telemetry` tool aggregates one row per `cg_*` invocation
(`cg_tool_usage` table, written from `server/plugins/codegraph/telemetry.js`)
into a per-tool health summary. This runbook turns the four percentage
signals into actionable decisions.

## Pulling the report

```sh
scripts/cg-telemetry-report.sh           # last 7 days
scripts/cg-telemetry-report.sh 24        # last 24 h
scripts/cg-telemetry-report.sh 720       # last 30 d
```

Or call the REST endpoint directly:

```sh
curl -fsS http://127.0.0.1:3457/api/v2/codegraph/telemetry?since_hours=168
```

The MCP tool path is `cg_telemetry({since_hours, tool?})` — the same payload,
filterable to one tool at a time.

## What each column means

| Column | What it counts |
|---|---|
| `calls` | Number of recorded `cg_*` invocations in the window. |
| `avg_ms` / `max_ms` | Wall-clock for the wrapped handler. SQLite-local so >100 ms suggests contention or large repos. |
| `strict_pct` | Of calls that passed a `scope` arg, the share that asked for `scope=strict`. NULL when the tool doesn't take `scope`. |
| `trunc%` | Calls that hit the result cap (`truncated:true`). Cap is per-tool — 100 nodes for graphs, configurable for search. |
| `stale%` | Calls whose response carried `staleness.stale=true` (caller worked against an out-of-date index). |
| `err%` | Calls that threw — split between `usage_error` (bad args) and `internal_error` (unexpected). |

## Thresholds and what to do

These are starting points, not laws. The right number depends on your call
volume and tolerance. Re-tune them as the planner integration matures.

### `staleness_pct` — index drift

| Reading | Action |
|---|---|
| 0 – 10 % | Healthy. Post-commit hook is keeping up. |
| 10 – 30 % | The hook fires but reindex is slower than commit cadence on at least one repo. Check `cg_index_status` per repo and look for repos with very old `indexed_sha`. Consider raising `TORQUE_CG_INDEX_CONCURRENCY`. |
| > 30 % | Hook is failing or the repo isn't being auto-tracked. Verify `.git/hooks/post-commit` exists and is executable; verify the user `cg_reindex`-ed the repo at least once (`if_tracked:true` no-ops on un-tracked repos). |

### `truncation_pct` — caps too tight

| Reading | Action |
|---|---|
| 0 – 5 % | Caps are well-sized for the planner's queries. |
| 5 – 20 % | Some heavy queries are clipping. Check the per-tool breakdown: `cg_call_graph` / `cg_impact_set` truncation usually means depth too high; `cg_search` truncation means pattern too broad or limit too low. |
| > 20 % | The caps are routinely the wrong size. Bump `max_nodes` for graph tools or default `limit` for search. Or coach the planner to narrow with `container=` + `is_exported`. |

### `strict_pct` — scope adoption

Only meaningful for `cg_find_references`, `cg_call_graph`, `cg_impact_set`.

| Reading | Action |
|---|---|
| < 30 % | Planners default to `scope=loose` (high recall, false-positive prone). If the planner is using results to author tasks rather than to brainstorm, that's a quality risk. Update the planner-prompt advert to push `scope=strict` for refactor work. |
| 30 – 70 % | Healthy mix. Loose for discovery, strict for narrow refactor scope. |
| > 70 % | Possible over-use of strict — strict drops cross-package and dynamically-dispatched calls. If `cg_resolution_diagnostics` shows a high `inherited_method_resolution_gap` count, planners are likely missing inherited callers; doc the trade-off in the planner prompt. |

### `error_pct` — handler reliability

| Reading | Action |
|---|---|
| 0 – 2 % | Acceptable baseline (mostly `usage_error` from planner mistakes). |
| 2 – 10 % | Inspect via `cg_telemetry({tool: "..."})` to see which tool. `usage_error` spikes mean the planner-prompt advert is misleading — clarify the args. `internal_error` spikes mean the underlying query has a bug or the index is corrupt. |
| > 10 % | Real degradation. Pull the `at` of the recent failures and correlate with deployment / index-state events. |

## Per-tool patterns to watch

- **`cg_search` with high `truncation_pct` (>20%)** — planners are doing
  exploratory searches with broad globs. Either raise limit or coach toward
  `kind=` / `container=` filters.
- **`cg_diff` with high `error_pct`** — usually `usage_error` from passing
  unreachable shas. Either the planner is composing shas wrong, or the
  factory isn't capturing baselineCommit cleanly.
- **`cg_resolution_diagnostics` with rising calls** — planners are hitting
  strict-scope misses and trying to figure out why. The `reasons` payload
  tells you which bucket: `import_from_external_module` is structural and
  unfixable from inside; `method_resolution_edge_case` is a real indexer bug
  to file.

## Cadence

- **Weekly** glance at the table — spot-check the top tools for outlier
  percentages. ~5 minutes if nothing changed.
- **Per-release** of the codegraph plugin — confirm `error_pct` and
  `truncation_pct` haven't regressed.
- **On-demand** when a planner integration starts shipping — the runbook is
  designed to convert a number into a single corrective action, not a
  diagnostic adventure.
