# Metric module contract

Each metric module under `server/perf/metrics/` MUST export:

```js
module.exports = {
  id: 'unique-slug',
  name: 'Human readable name',
  category: 'hot-path-runtime',
  units: 'ms',
  warmup: 10,
  runs: 100,
  variants: ['raw', 'parsed'],
  run: async (ctx) => ({ value: 42, p95: null })
};
```

## Field reference

- `id` (string, required) — unique slug across all metrics. Two metrics with the same id is a register error.
- `name` (string, required) — human-readable label shown in run-perf output.
- `category` (string, required) — one of `hot-path-runtime`, `request-latency`, `db-query`, `test-infra`, `dev-iteration`.
- `units` (string, required) — one of `ms`, `count`, `bytes`. Determines how the value is interpreted.
- `warmup` (integer, required) — iterations to run before measurement (results discarded).
- `runs` (integer, required) — measurement iterations. The driver takes the trimmed median when `runs >= 10` (top/bottom 10% trimmed); else straight median.
- `variants` (string array, OPTIONAL) — when present, `run()` is called once per variant and each produces its own baseline entry keyed `${id}.${variant}`. Omit for single-value metrics.
- `run(ctx)` (function, required) — async or sync. Must return `{ value: <number> }`. May optionally return `{ value, p95 }`.

## ctx parameter

`run()` receives a `ctx` object with:

- `ctx.fixture` — shared fixture builder result (when the driver was given one).
- `ctx.iter` — current iteration index (0-based; `-1` during warmup).
- `ctx.variant` — current variant name when `variants` is set; `null` otherwise.

## Variant baselines

Each variant produces a separate entry in `baseline.json` named `${id}.${variant}`. The 10% regression gate is enforced per variant entry, not per metric.
