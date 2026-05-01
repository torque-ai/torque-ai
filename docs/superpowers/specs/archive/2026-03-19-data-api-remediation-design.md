# TORQUE Data/API Remediation (Track E)

**Date:** 2026-03-19
**Scope:** 270 issues from DB, API, CLI, and functionality gap agents (server-side only — dashboard handled by Track D)
**Approach:** Critical/high first, then batch by pattern

---

## Phase 1 — Critical Data Issues (15 items)

### Database

1. **Unbounded analytics table growth** — add periodic cleanup job
2. **Unconditional config overwrites on startup** — already fixed in Round 1, verify
3. **Missing CHECK constraints** — add `CHECK(status IN (...))` to tasks table
4. **Missing ON DELETE CASCADE** — add to key foreign keys or document manual cleanup
5. **Non-atomic backup writes** — already fixed in Track C, verify
6. **Schema migrations outside transactions** — wrap `runMigrations` in transactions
7. **Missing audit trail for setConfig** — already added protected config logging in Track A

### API

8. **SQL injection via unvalidated ORDER BY** in dashboard task list — add allowlist validation
9. **Dashboard retry creates inconsistent state vs v2 retry** — unify behavior
10. **Different auth models on dashboard vs API ports** — document or unify
11. **v1 vs v2 response format divergence** — add deprecation headers to v1
12. **Unimplemented endpoint returns 200** — return 501 for placeholder endpoints

### Functionality

13. **`codex-spark` documented but not registered** — register in provider registry
14. **Documented fallback chain is fictional** — implement or correct documentation
15. **`isOptIn()` uses opt-out logic** — fix semantics

## Phase 2 — Medium Database Fixes (~25 items, batched)

- **Batch D1: Query performance** — add missing indexes, fix N+1 patterns, batch countTasks calls
- **Batch D2: Transaction boundaries** — wrap non-atomic operations, fix TOCTOU in budget check
- **Batch D3: Data growth** — add cleanup for coordination_events, health_status, task_file_writes
- **Batch D4: JSON column handling** — consistent parse/serialize, schema evolution
- **Batch D5: Date/time consistency** — standardize on UTC ISO strings everywhere

## Phase 3 — Medium API/CLI Fixes (~30 items, batched)

- **Batch A1: API consistency** — unify error codes, add deprecation headers, fix duplicate routes
- **Batch A2: Request validation** — content-type checks, depth validation in v2-dispatch
- **Batch A3: Pagination** — add pagination to unbounded list endpoints
- **Batch A4: CLI robustness** — arg parsing edge cases, flag-aware description collection

## Phase 4 — Medium Functionality Fixes (~20 items, batched)

- **Batch F1: Provider registration** — register codex-spark, fix economy mode docs
- **Batch F2: Notification reliability** — add event priority, fix subscription persistence
- **Batch F3: Multi-instance** — fix lock lease expiry, stale instance detection
- **Batch F4: Timeout enforcement** — single authoritative timeout mechanism

## Phase 5 — Low severity (~180 items → tech debt registry)

---

## Estimated Effort

| Phase | Sessions | Items |
|-------|----------|-------|
| 1 — Critical | 2-3 | 15 |
| 2 — DB medium | 2-3 | ~25 |
| 3 — API/CLI medium | 2-3 | ~30 |
| 4 — Functionality medium | 1-2 | ~20 |
| 5 — Tech debt | 1 | ~180 |
| **Total** | **~8-12** | **~270** |
