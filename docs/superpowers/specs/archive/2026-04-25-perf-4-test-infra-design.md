# Phase 4 Child Spec — Test Infra Import Bloat

**Status:** Draft 2026-04-25 (pending user review)

**Parent:** `docs/superpowers/specs/2026-04-25-perf-arc-umbrella-design.md` §3.4, §4.2 row 4

**Pre-flight findings:** `docs/findings/2026-04-25-perf-arc/phase-4-test-infra-pre.md` (scout commit `1b34e4b7`)

**Goal:** Close the remaining test-infra import-bloat residue, ship the `torque/no-heavy-test-imports` ESLint rule + cold-import threshold check that prevents recurrence (the scout found regressions since 04-04 without enforcement), and update the perf gate baseline to capture the cold-import improvement on `tools.js`.

## 1. State of the world (vs the umbrella spec's assumptions)

The umbrella spec §3.4 anticipated a large migration job: ~150 test files to migrate to `setupTestDbOnly`, top-20 file splits, mega-import elimination. **Most of this is silently done.** The scout found:

- `pool: 'forks'` → `'threads'` already happened (eliminates module-cache isolation penalty per file).
- `database.js` already lazy-loaded (7 top-level requires, was 44+).
- `task-manager.js` dashboard-server require already lazy-loaded.
- `setupTestDbOnly()` already exists in vitest-setup; **152 files already use it**.

**What still remains** (and where the leverage is):

- **16 files** still do top-level `require('../tools')` at module scope. Of these, **5 don't even call `handleToolCall`** — they only access routing metadata.
- **19 files** still do top-level `require('../task-manager')`.
- **17 files** call `setupTestDb()` but never use `handleToolCall` or `safeTool` — could migrate to `setupTestDbOnly`.
- **38 files** have `vi.resetModules()` inside `beforeEach()` — **REGRESSED from 14 at 04-04**. Without enforcement, this trend is going the wrong way.
- **75 files >1000 lines** — REGRESSED from 62. Largest is `agentic-execution-fixes.test.js` at 3638 lines (didn't exist 04-04).
- `server/tests/test-helpers.js:95` self-test stub still present (unresolved since 04-04).

The smaller leftover scope means Phase 4 is more about **shipping the discipline rule** than mass migration. The rule prevents the regressions the scout just documented.

---

## 2. Scope

### 2.1 In scope (from scout)

**HIGH:**
1. **5 metadata-only `tools.js` imports** (`auto-recovery-mcp-tools.test.js`, `mcp-tool-alignment.test.js`, `p2-orphaned-tools.test.js`, `p3-dead-routes.test.js`, `tool-annotations.test.js`) — pure dead weight, paying ~335ms cold-import for routing metadata that could come from a thin module.
2. **38 `vi.resetModules()` in `beforeEach()`** — multiplies cold-import per test case. Worst offenders: `tda-01-provider-sovereignty.test.js` (6), `mcp-platform.test.js` (5), `factory-loop-hardening.test.js` (4), `config.test.js` (4).

**MEDIUM:**
3. **17 `setupTestDb()` callers that never use `handleToolCall`/`safeTool`** — migrate to `setupTestDbOnly()`.
4. **11 files genuinely needing `handleToolCall`** — these are the legitimate allowlist for the ESLint rule. Confirm and codify.
5. **19 files top-level `require('../task-manager')`** — most could be lazy-required inside the test that needs them.

**LOW:**
6. **75 files >1000 lines** — top-20 file split is high-effort, low-immediate-payoff (since `pool: threads` largely solved the worker-distribution issue). **Deferred to v0.1**; only the top-3 worst offenders (`agentic-execution-fixes.test.js` at 3638 lines, `api-server.test.js`, `task-core-handlers.test.js`) get split in this phase if implementer time allows.
7. **`test-helpers.js:95` self-test stub** — delete the orphan `describe`/`it`.

### 2.2 Out of scope (deferred to v0.1)

- Top-20 large-file splits beyond the top-3. The benefit is real but not urgent now that pool=threads handles cross-file caching.
- `vitest-setup.js`'s remaining `require.resolve('../tools')` at module scope — confirmed by scout that it's path-resolution only, not loading. Won't move the needle vs the actual `require('../tools')` calls in the 16 files.

---

## 3. Discipline rules

Two rules ship together — they target different failure modes the scout documented.

### 3.1 Rule A: `torque/no-heavy-test-imports`

ESLint rule at `server/eslint-rules/no-heavy-test-imports.js`. In `server/tests/**`, flags top-level (Program-scope, not inside function bodies):

- `require('../tools')`
- `require('../task-manager')`
- `require('../database')` (already de-emphasized but worth the rule)
- `require('../dashboard-server')`

with an exception for files on the configured allowlist (the 11 files that genuinely need `handleToolCall`).

Exception annotation: `// eslint-disable-next-line torque/no-heavy-test-imports -- <reason>` requires reason >10 chars (same convention as Phase 1).

### 3.2 Rule B: `torque/no-reset-modules-in-each`

ESLint rule at `server/eslint-rules/no-reset-modules-in-each.js`. Flags `vi.resetModules()` calls inside `beforeEach()` (NOT `beforeAll`). The rule explicitly allows `vi.restoreAllMocks()`, `vi.clearAllMocks()`, and `db.resetForTest()` as the canonical alternatives — those don't force module reload.

Exception annotation: same `<reason>` convention. Used sparingly; the scout's 38 occurrences should mostly become `vi.restoreAllMocks()` instead.

### 3.3 Rule C: vitest setup wrapper — cold-import threshold

`server/tests/vitest-setup.js` wraps `setupTestDb()` and `setupTestDbOnly()` to time their first call. If first-call cost >250ms, log a warning naming the test file. If >500ms, fail the file with a clear error message naming the heavy module imported. This catches drift faster than waiting for a scout.

### 3.4 Initial allowlist for Rule A

The 11 files that genuinely use `handleToolCall`:

- `api-server.test.js`
- `eval-mcp-tools.test.js`
- `mcp-factory-loop-tools.test.js`
- `mcp-sse.test.js`
- `mcp-streamable-http.test.js`
- `mcp-tools-plan-file.test.js`
- `p2-workflow-subscribe.test.js`
- `restart-server-tool.test.js`
- `test-hardening.test.js`
- `tool-schema-validation.test.js`
- `tools-aggregator.test.js`

The 5 metadata-only files (NOT on allowlist; must migrate to thin import):

- `auto-recovery-mcp-tools.test.js`
- `mcp-tool-alignment.test.js`
- `p2-orphaned-tools.test.js`
- `p3-dead-routes.test.js`
- `tool-annotations.test.js`

---

## 4. Migration playbook

### 4.1 Task A: Create `server/tool-registry.js` (thin metadata module)

- Extracts the metadata exports (`TOOLS`, `routeMap`, `schemaMap`, `decorateToolDefinition`) into a dependency-free module that does NOT load any handlers.
- Existing `server/tools.js` re-exports from `tool-registry.js` so callers that already import metadata via `tools.js` continue to work; only new metadata-only callers (the 5 migrated files) import the thin module.
- Cold-import cost target for `tool-registry.js`: <30ms (no handler loading).

### 4.2 Task B: Migrate the 5 metadata-only files

- Change `require('../tools')` to `require('../tool-registry')` in each of: `auto-recovery-mcp-tools.test.js`, `mcp-tool-alignment.test.js`, `p2-orphaned-tools.test.js`, `p3-dead-routes.test.js`, `tool-annotations.test.js`.
- Run the affected tests to confirm the metadata-shape is preserved.

### 4.3 Task C: Implement and ship `torque/no-heavy-test-imports`

- Implement the rule with the 11-file allowlist baked into the config.
- Run lint; confirm only the 11 files emit diagnostics, all suppressed by the allowlist.
- Add to `eslint.config.js` in `error` mode (no warn intermediate — the migration in Task B already cleared the non-allowlist offenders).

### 4.4 Task D: Implement and ship `torque/no-reset-modules-in-each`

- Implement the rule.
- First run will flag 38 occurrences. Convert each to `vi.restoreAllMocks()` or `db.resetForTest()` as appropriate per the rule's recommended alternatives. For each conversion, run the affected test file to ensure isolation still works.
- Files with multiple occurrences (`tda-01-provider-sovereignty.test.js`, `mcp-platform.test.js`, `factory-loop-hardening.test.js`, `config.test.js`) need careful per-occurrence review — some may legitimately need `resetModules()` if testing module-init behavior; those move to `beforeAll()` or get an `// eslint-disable-next-line` with a real reason.
- Land the rule in `error` mode after migration completes.

### 4.5 Task E: Migrate 17 `setupTestDb` → `setupTestDbOnly` callers

- For each of the 17 files (list in scout findings), change `setupTestDb` to `setupTestDbOnly` in the import + `beforeEach`/`beforeAll` setup blocks.
- Run each affected file to confirm it still passes (these files don't use `handleToolCall`, so the migration is mechanical).

### 4.6 Task F: Lazy-require the 19 task-manager top-level imports

- For each of the 19 files (list in scout), move `require('../task-manager')` from module scope into the function/test that needs it (typically a `beforeEach` or a specific `it`).
- Run each affected file to confirm.

### 4.7 Task G: Vitest setup wrapper for cold-import threshold

- Modify `server/tests/vitest-setup.js` to wrap `setupTestDb` and `setupTestDbOnly` with `performance.now()` measurement.
- On first call per test file, log warning if elapsed >250ms, fail file if >500ms.
- Configure thresholds via env (`PERF_TEST_IMPORT_WARN_MS`, `PERF_TEST_IMPORT_FAIL_MS`) so CI can tune them.

### 4.8 Task H: Top-3 large-file splits (best-effort, time-permitting)

- `agentic-execution-fixes.test.js` (3638 lines) — split by `describe` block into multiple files.
- `api-server.test.js` — split into `api-server-core`, `api-server-sse`, `api-server-routes`.
- `task-core-handlers.test.js` — split similarly.
- Skip if implementer time runs out; capture as v0.1 follow-up.

### 4.9 Task I: Delete `test-helpers.js` self-test

- Delete the `describe`/`it` block at `server/tests/test-helpers.js:95`. The file is imported as a module, not run directly; the stub serves no purpose.

### 4.10 Task J: Phase 4 closure verification

- Re-run scout scoped to test infra. Findings file at `docs/findings/2026-04-25-perf-arc/phase-4-test-infra-post.md`.
- Confirm zero NEW findings; only the 11 grandfathered allowlist entries remain on Rule A.
- `npm run lint` exits clean.
- Cold-import wrapper records baseline times for Phase 4's metric updates.

---

## 5. Tracked-metric updates to `baseline.json`

### 5.1 Existing metrics that should move

| Metric | Current baseline | Expected after Phase 4 |
|---|---|---|
| `cold-import.tools` | ~700ms | unchanged for `tools.js` itself (it still loads everything for the 11 legit consumers); but a NEW measurement category proves the thin-module path |
| `cold-import.tool-registry` (NEW variant) | n/a | <30ms target |

The `tools.js` itself isn't directly improved by Phase 4 — its consumers move to the thin module. The headline win is suite wall time and test-startup latency for the 5+38 affected files.

### 5.2 New tracked metric proposed

- **`vitest-suite-wall-time`** — runs the full server vitest suite via `torque-remote`, measures wall time. With Phase 4 done + the cold-import threshold enforced, this should be more stable run-to-run.

This metric is bigger work to add (needs a fixture-stable test selection and a stable measurement env). Optional for Phase 4; defer to v0.1 if the implementer doesn't want to ship it now.

### 5.3 Update protocol

Cutover commit (or follow-on) carries `perf-baseline:` trailers per moved metric:

```
perf-baseline: cold-import.tools <old> to <new> (Phase 4: 5 metadata-only consumers migrated to tool-registry; 11 legit consumers unchanged)
```

---

## 6. Phase closure criteria (per umbrella §3.5)

1. **All findings closed** — fresh scout returns zero NEW findings outside the 11-file allowlist.
2. **Discipline rules live** — `torque/no-heavy-test-imports` AND `torque/no-reset-modules-in-each` in `error` mode; cold-import threshold wrapper active.
3. **Tracked metrics moved by the phase, captured in baseline** — `cold-import.tool-registry` added with <30ms; baseline updated with `perf-baseline:` trailer.
4. **Re-scout confirms zero** — post-merge scout file at `docs/findings/2026-04-25-perf-arc/phase-4-test-infra-post.md`.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `tool-registry.js` extraction creates a circular import with `tools.js` | The extraction is one-way: `tool-registry.js` knows nothing about handlers; `tools.js` re-exports from `tool-registry.js`. No cycle. |
| Migrating `vi.resetModules()` to `vi.restoreAllMocks()` breaks tests that depended on full module reload | Each conversion includes per-file test verification before moving on. Files that genuinely need `resetModules()` get an inline ESLint disable with reason. |
| `setupTestDbOnly` migration on the 17 files breaks a test that lazily called `handleToolCall` via a transitive helper | Verification per-file before commit. If a file actually needs `handleToolCall`, it stays on `setupTestDb` and gets added to the Rule A allowlist. |
| Cold-import threshold wrapper fails legitimate slow-import test files | Threshold is configurable via env; CI can override per-file via vitest's `globals` or per-test-file overrides. Initial threshold (250ms warn / 500ms fail) tuned to the post-Phase-4 expected range. |
| Phase 4 cutover is parallel with Phase 1's cutover; both add ESLint rules to `eslint-rules/index.js` | Whoever cuts over second rebases; the conflict surface is one line per rule export. Documented in umbrella §4.3. |

---

## 8. Execution shape

- **Worktree:** `feat-perf-4-test-infra` (already created at `.worktrees/feat-perf-4-test-infra/`).
- **Branch:** `feat/perf-4-test-infra` (off main `6ce665b8`, which includes Phase 0).
- **Implementation plan:** Written via `superpowers:writing-plans` from this worktree after spec approval.
- **Execution path:** `superpowers:subagent-driven-development` per umbrella §4.1.
- **Cutover:** `scripts/worktree-cutover.sh perf-4-test-infra`. No factory pause needed (test infra changes don't affect runtime hot paths).
- **Parallel with:** Phase 1 (sync I/O). Conflict surface: `server/eslint-rules/index.js` exports list. Rebase whoever cuts over second.
