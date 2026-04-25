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

Variants render as separate baseline entries with id `${id}.${variant}`.

`ctx` provides:
- `ctx.fixture` — shared fixture builder result
- `ctx.iter` — current iteration index (0-based)
- `ctx.variant` — current variant name when `variants` is set
