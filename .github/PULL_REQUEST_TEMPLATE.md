## What

<!-- Brief description of changes -->

## Why

<!-- Motivation / issue link -->

## Testing

- [ ] `npm run test:smoke` passes
- [ ] `npm run lint` passes
- [ ] New tests added for new functionality
- [ ] Manual testing performed

## Performance review (Phase 3 discipline)

- [ ] Hot paths: no `new Set()` or `new Map()` literals inside functions called per-tick or per-request
- [ ] Invariant data (provider lists, column names, capability sets) hoisted to module scope or cached with `setDb()` invalidation
- [ ] `listTasks` callers that do not need parsed JSON: pass `raw: true`
- [ ] New PRAGMA queries: cached with null-guard + `setDb()` clear (mirror `scheduling-automation.js` pattern)
- [ ] Perf counters: if adding a new hot-path operation, add a counter key to `operations-perf-counters.js`

## Notes

<!-- Anything reviewers should know -->
