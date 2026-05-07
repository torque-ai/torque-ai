# Replan-Recovery Pilot — 7-Day Check (2026-05-07)

**Generated:** 2026-05-07  
**Reviewer:** Claude Code (automated pilot check)

---

## Merge Status

**Feature is ON main — merged via `feat/state-decomposition-arc`.**

The branch `feat/recover-rejected-replan` (as named in the spec) does **not** appear as a named merge commit in git history. Instead, the feature arrived on main inside the large `feat/state-decomposition-arc` merge at commit:

```
3d4e2c9  feat(di): wire commandBuilders + fileContextBuilder via internal require()s
Date:    2026-05-04 22:32:11 -0600
Files:   4,425 files, 1,102,908 insertions
```

This commit introduced all key feature files simultaneously with a large DI/state-decomposition refactor. The feature shipped **disabled by default** (`replan_recovery_enabled = '0'`).

**Schema migration note:** The implementation plan referenced schema v39, but due to other migrations added between planning and landing, the replan-recovery migration (`add_replan_recovery_columns`) landed at **v51**.

---

## Post-Merge Iteration (3 commits since 2026-05-04)

| SHA | Date | Message | Files Touched |
|-----|------|---------|---------------|
| `c2361a3` | 2026-05-05 13:58 | fix(recovery): wire discard strategy into A-side for merge_target_dirty | `recovery-strategies/discard-regenerable-merge-block{,-core}.js`, auto-recovery-core rules |
| `ee3b117` | 2026-05-05 22:30 | fix(recovery): align escalate-architect reader to architect_provider_override | `recovery-strategies/escalate-architect.js` |
| `2c54533` | 2026-05-06 08:03 | fix(recovery): single source of truth for B2 reject-reason patterns | `replan-recovery-bootstrap.js`, `rejected-recovery.js` |

All three are bugfixes shipping within 48 hours of the initial landing — consistent with early pilot iteration on a feature that went in without full test-infra verification (see status doc). No regressions to other files detected in these commits.

---

## Current Config (code defaults, pre-pilot)

From `server/db/config-core.js`:

| Key | Default |
|-----|---------|
| `replan_recovery_enabled` | `'0'` (off) |
| `replan_recovery_sweep_interval_ms` | `900000` (15 min) |
| `replan_recovery_hard_cap` | `3` |
| `replan_recovery_max_per_project_per_sweep` | `1` |
| `replan_recovery_max_global_per_sweep` | `5` |
| `replan_recovery_cooldown_ms_attempt_0` | `3600000` (1 hr) |
| `replan_recovery_cooldown_ms_attempt_1` | `86400000` (24 hr) |
| `replan_recovery_cooldown_ms_attempt_2` | `259200000` (72 hr) |
| `replan_recovery_strategy_timeout_ms` | `960000` (16 min) |
| `replan_recovery_strategy_timeout_ms_escalate` | `5000` (5 s) |

To enable on one project: set `replan_recovery_enabled = '1'` in the global config (or per-project override if that surface exists), then restart TORQUE.

---

## Operator SQL Checks

Run these queries locally against `tasks.db` (SQLite). Adjust the path as needed.

### 1. Decision counts by action (last 7 days)

```sql
SELECT action, COUNT(*) AS n
FROM factory_decisions
WHERE (action LIKE 'replan_recovery%' OR action LIKE 'recovery_inbox_%')
  AND created_at >= datetime('now', '-7 days')
GROUP BY action
ORDER BY n DESC;
```

**Expected interpretation:**
- If `replan_recovery_enabled` was never flipped to `'1'`, this returns 0 rows — the pilot hasn't started.
- After enabling: `replan_recovery_attempted` should be the highest-volume action. `replan_recovery_exhausted` is a signal that items burned through all strategies without success.
- `recovery_inbox_dismissed` counts operator triage actions (manual review decisions).
- A healthy pilot: `replan_recovery_attempted >> replan_recovery_exhausted`. If exhausted is close to attempted, strategies are not resolving items — investigate strategy failures (query 4).

---

### 2. Outcomes by strategy (last 7 days)

```sql
SELECT
  json_extract(inputs_json, '$.strategy') AS strategy,
  json_extract(outcome_json, '$.outcome') AS outcome,
  COUNT(*) AS n
FROM factory_decisions
WHERE action = 'replan_recovery_attempted'
  AND created_at >= datetime('now', '-7 days')
GROUP BY strategy, outcome
ORDER BY n DESC;
```

**Expected interpretation:**
- `outcome = 'success'` means the strategy submitted a new work item that is now live.
- `outcome = 'skipped'` means the strategy ran but decided this item wasn't eligible (e.g., not decomposable, no architect available).
- `outcome = 'failed'` indicates an exception or timeout — see query 4 for details.
- Healthy pilot: `rewrite_description` or `decompose` strategies should account for most successes. `escalate_architect` is a heavyweight fallback; high volume there may mean simpler strategies aren't matching.

---

### 3. Inbox items currently awaiting human review

```sql
SELECT id, project_id, title, recovery_attempts, last_recovery_at
FROM factory_work_items
WHERE status = 'needs_review'
ORDER BY recovery_attempts DESC;
```

**Expected interpretation:**
- Items here have been exhausted by all strategies (hit `hard_cap = 3` or all strategies skipped) and are waiting for the operator to manually decide.
- A growing backlog (`COUNT(*) > 10`) suggests the strategies aren't effective for your project's rejection patterns — review the rejection reasons in `inputs_json` to tune strategy eligibility or adjust `hard_cap`.
- Items with `recovery_attempts = 0` landed in `needs_review` for a non-recovery reason (e.g., manual operator reject) — that's normal.

---

### 4. Recent strategy failures — signal of bugs (last 7 days)

```sql
SELECT id, project_id, reasoning, outcome_json, created_at
FROM factory_decisions
WHERE action = 'replan_recovery_strategy_failed'
  AND created_at >= datetime('now', '-7 days')
ORDER BY created_at DESC
LIMIT 50;
```

**Expected interpretation:**
- Any rows here warrant investigation. `reasoning` contains the error message or stack trace.
- Known post-merge bug areas (already fixed in commits `c2361a3`, `ee3b117`, `2c54533`):
  - `merge_target_dirty` items routed to wrong strategy (fixed `c2361a3`)
  - `escalate-architect` reading wrong config key `architect_provider_override` (fixed `ee3b117`)
  - B2 reject-reason pattern mismatches in bootstrap (fixed `2c54533`)
- If you see failures for these exact patterns, the fix may not have reached your DB — confirm `PRAGMA user_version` is ≥ 51.

---

### 5. Operator inbox triage activity (last 7 days)

```sql
SELECT COUNT(*) AS dismissed_count
FROM factory_decisions
WHERE action = 'recovery_inbox_dismissed'
  AND created_at >= datetime('now', '-7 days');
```

**Expected interpretation:**
- Nonzero means the operator has been actively triaging the recovery inbox — good.
- Zero combined with a nonzero `needs_review` count (query 3) means items are piling up unreviewed.

---

### 6. Schema version verification

```sql
PRAGMA user_version;
```

**Expected:** `56` (the current latest migration). Anything below `51` means the `add_replan_recovery_columns` migration has NOT run — the feature will be broken even if `replan_recovery_enabled = '1'`.

---

## How to Read These Results

### Healthy pilot looks like:

| Signal | Value |
|--------|-------|
| `replan_recovery_attempted` count (query 1) | > 0 after enabling |
| Strategy failures (query 4) | 0 rows |
| `needs_review` backlog (query 3) | Small and stable |
| `dismissed_count` (query 5) | Matches or exceeds `needs_review` growth |
| `replan_recovery_exhausted` (query 1) | < 20% of `attempted` |

### Signals of a problem:

| Signal | Likely Cause | Action |
|--------|-------------|--------|
| All queries return 0 rows | Feature never enabled, or pilot project not set | Confirm `replan_recovery_enabled = '1'` and restart |
| `strategy_failed` rows present | Bug in strategy code or config | Read `reasoning`, cross-reference against commits `c2361a3` / `ee3b117` / `2c54533` |
| `needs_review` growing unboundedly | Strategies not matching rejection patterns | Lower `hard_cap`, or adjust strategy eligibility in `registry.js` |
| `exhausted` ≈ `attempted` | All strategies skipping or failing | Enable `escalate_architect` or review rejection-reason patterns |
| `PRAGMA user_version` < 51 | Migration didn't run | Run `server/scripts/migrate-rejected-to-needs-replan.js` and check startup logs |

---

## Reference Documents

| Document | Path |
|----------|------|
| Spec | `docs/superpowers/specs/archive/2026-04-30-rejected-recovery-replan-design.md` |
| Plan (part 1) | `docs/superpowers/plans/archive/2026-04-30-rejected-recovery-replan.md` |
| Plan (part 2) | `docs/superpowers/plans/archive/2026-04-30-rejected-recovery-replan-part2.md` |
| Implementation status | `docs/superpowers/plans/2026-04-30-rejected-recovery-replan-status.md` |
| Recovery decisions canonical ref | `docs/recovery-decisions.md` |

---

## Action Items for Operator

- [ ] Confirm `PRAGMA user_version` ≥ 51 in tasks.db
- [ ] If pilot not yet started: set `replan_recovery_enabled = '1'` for the target project and restart TORQUE
- [ ] Run queries 1–5 above after 24 hours of pilot operation
- [ ] If `strategy_failed` rows appear, review `reasoning` and verify fixes from `c2361a3` / `ee3b117` / `2c54533` are reflected
- [ ] After 7 days of active pilot: decide on expanding to all projects or adjusting strategy weights
