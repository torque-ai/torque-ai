# State-Machine Rationalization Arc — Status

**Date:** 2026-05-08
**Session length:** Multi-day; this doc captures state at end-of-session before a multi-day pause.
**Parent arc:** Factory loop state-machine rationalization (7 sub-projects)
**Origin spec:** `docs/superpowers/specs/2026-05-07-factory-decision-actions-catalog-design.md` (sub-project 1; introduces the parent decomposition)

This is a session handoff. If you're picking this up after the pause, start here.

---

## What we shipped this session

Four independent arcs, each shipped to `main`:

### 1. `torque-remote` lanes (out-of-arc; predates the parent rationalization)

Cutover commit on main: see `git log --grep='torque-remote.*lane'` for the merge.

- Added parallel-lane support to `bin/torque-remote` so N concurrent invocations can run on the same remote workstation without contention.
- New per-lane workspaces at `<base>-lane-K`, atomic-mkdir lock at `<base-parent>\.torque-remote-lanes\.locks\lane-K`.
- Heartbeat-based stale-holder warning + coalesced SSH probe (ported from main during reconciliation merge).
- Default `TORQUE_REMOTE_LANE_COUNT=1`; opt into parallelism by bumping the env var.
- Spec: `docs/superpowers/specs/2026-05-07-torque-remote-lanes-design.md`
- Plan: `docs/superpowers/plans/2026-05-07-torque-remote-lanes.md`

**Status: shipped.** No follow-up needed unless the operator decides to bump `TORQUE_REMOTE_LANE_COUNT` and watches for cold-start provisioning behavior in production.

### 2. Decision-actions catalog + drift prevention (sub-project 1 of 7)

Cutover commit on main: `9a8b9132 Merge branch 'feat/decision-actions-catalog'`.

- New canonical catalog at `server/factory/decision-actions.js` (143 entries pre-sub-project-4, 141 post-sub-project-4) with five classifier kinds (`benign`, `recovery-rule`, `b-side-reject`, `terminal`, `engine`).
- Audit script at `server/factory/scripts/audit-decision-actions.js` discovers emit sites + classifier rules + benign-skip patterns, produces 4-category gap report.
- CI gate `server/tests/factory-decision-actions-catalog.test.js` — fails on drift between emit sites and catalog.
- Production guard `auto_recovery_unknown_action` emitted when classifier returns `matched_rule = null`; recursion-defense short-circuit in the engine.
- Doc autogen: `docs/factory-loop-states.md` decision-action emission map is now autogen-bounded; renderer is `server/factory/scripts/render-decision-actions-doc.js`.
- 6 new classifier rules added during gap-fix; 63 new actions added to `BENIGN_FLOW_ACTION_EXACT`.
- Spec: `docs/superpowers/specs/2026-05-07-factory-decision-actions-catalog-design.md`
- Plan: `docs/superpowers/plans/2026-05-07-factory-decision-actions-catalog.md`

**Status: shipped.** CI gate is live and armed.

### 3. Unified auto-ship helper (sub-project 4 of 7)

Cutover commit on main: `590977d2 Merge branch 'feat/unified-auto-ship'`.

- New helper module `server/factory/auto-ship.js` exporting `emitAutoShipped()` and frozen `AUTO_SHIPPED_REASONS` (`AT_PRIORITIZE`, `EMPTY_BRANCH_MERGE_FAIL`, `AT_VERIFY_FAIL`).
- Three call sites in `loop-controller.js` migrated; three old action names (`auto_shipped_at_prioritize`, `auto_shipped_empty_branch`, `auto_shipped_at_verify_fail`) collapsed into one canonical `auto_shipped` with a `reason` discriminator.
- Catalog reduced 143 → 141 entries.
- Doc table re-rendered; operator runbook note added explaining the action rename + bridging SQL queries.
- 9 unit tests covering happy path, validation throw, parametric coverage, shadowing prevention (extra cannot override core), default vs override reasoning.
- Three downstream-consumer fixes layered on top of the migration: `BENIGN_FLOW_ACTION_EXACT` (engine.js), `FACTORY_CYCLE_SUCCESS_ACTIONS` (factory-handlers.js), `isNonVerifyFailTerminalDecision` predicate (loop-controller.js).
- Spec: `docs/superpowers/specs/2026-05-08-unified-auto-ship-helper-design.md`
- Plan: `docs/superpowers/plans/2026-05-08-unified-auto-ship-helper.md`

**Status: shipped.** TORQUE restart deferred (see Pending Problems #1).

### 4. Forward transition naming (sub-project 5 of 7)

Cutover commit on main: see `git log --grep='forward transitions'`.

- `server/factory/loop-states.js` now exports `FORWARD_TRANSITIONS` as the canonical linear-chain map.
- `TRANSITIONS` remains as a backward-compatible alias for older imports.
- Internal helpers now read `FORWARD_TRANSITIONS`, and tests assert both the forward-map shape and alias compatibility.
- `docs/factory-loop-states.md` now marks the backward-edge ambiguity as resolved and points future non-linear edges to the transition catalog.

**Status: shipped.** No restart-sensitive behavior change; this is naming + docs/tests only.

---

## What's still to do (4 sub-projects of the parent arc)

The parent state-machine rationalization arc was decomposed into 7 sub-projects. Sub-projects 1, 4, and 5 are shipped. Four remain. Each is independently pickable; each gets its own brainstorm → spec → plan → execution cycle.

The original decomposition lives in the brainstorming context for sub-project 1 (search `docs/superpowers/specs/2026-05-07-factory-decision-actions-catalog-design.md` for "Parent arc" reference).

| # | Sub-project | Size | Dependencies | Notes |
|---|---|---|---|---|
| 2 | **`READY_FOR_<stage>` watchdog** | S | None | Operator-pain fix. Parked instances wait forever if stage occupant crashes. `stuck-loop-detector.js` may alert but doesn't auto-resolve. Add a "park older than X min → force advance with diagnostic" rule, or wire the existing detector to call `cancel_task` on the stale occupant. Open Q#2 in `docs/factory-loop-states.md`. |
| 3 | **Disambiguate `paused_at_stage = 'EXECUTE'`** | M | None | Schema disambiguation. Two distinct meanings encode as one column value: gate-pause (operator approval pending at EXECUTE) vs plan-generation deferral wait. Readers distinguish via the most recent decision log entry, which is fragile. Worth either splitting the encoding (`EXECUTE` vs `EXECUTE_DEFERRED`) or making the deferral wait a separate column. Open Q#3. |
| 6 | **`factory_projects.loop_state` mirror sweep** | S | None | Pure code-health. Project-row `loop_state` is a legacy mirror of the oldest active instance's state. Some readers still go through the project row (`getCurrentLoopState(project)`); some go through the instance directly. Sweep readers, document the mirror as backward-compat-only or remove. Open Q#6. |
| 7 | **Loop instance restart recovery** | M | Soft-depends on #2 | Behavioral. What happens to a project stuck at `READY_FOR_PLAN` if TORQUE restarts mid-park? `startup-task-reconciler.js` re-classifies tasks but the LOOP instance's `paused_at_stage` recovery on restart is less explicit. Worth confirming. Open Q#7. |

**Recommended order when picking back up:**

- **Start with #6.** It is S size, independent, and pure cleanup.
- **Tackle #2 next.** Real operator-pain fix; sets up #7 cleanly.
- **#7 after #2.** They overlap in the watchdog/restart-recovery story.
- **#3 last.** Schema change; biggest blast radius.

---

## How to move forward

### From cold start

1. Read this document.
2. Confirm `git log --oneline -5` on `main` shows the three merges from this session: `590977d2` (auto-ship), `9a8b9132` (catalog), and the lanes merge.
3. Verify CI gate is live: `cd server && npx vitest run tests/factory-decision-actions-catalog.test.js`. Expected: 5 tests pass.
4. Verify audit is clean: `node server/factory/scripts/audit-decision-actions.js`. Expected: exit 0, "All gap categories empty."
5. Pick a sub-project (see table above). Recommend #5 or #6 to start.

### Per-sub-project flow

Each remaining sub-project follows the standard arc:

1. **Brainstorm** via `superpowers:brainstorming` skill. Reference this doc + the open question in `docs/factory-loop-states.md`.
2. **Spec** lands at `docs/superpowers/specs/<date>-<topic>-design.md`.
3. **Plan** lands at `docs/superpowers/plans/<date>-<topic>.md`.
4. **Execute** via `superpowers:subagent-driven-development` (recommended for ~3+ tasks) or `superpowers:executing-plans`.
5. **Cutover** via `bash scripts/worktree-cutover.sh <feature-name>`.

### Operational notes for the next session

- **Test runs need WSL fallback** when remote is unreachable (this session hit it repeatedly):
  ```bash
  torque-remote bash -c 'cd server && npx vitest run <path> 2>&1 | tail -10'
  ```
  When the remote is down, `torque-remote` falls back to local execution. The `wsl --exec` form is faster but the guard hook routes everything through `torque-remote` first.
- **Audit script is the gatekeeper** for any new emit site:
  ```bash
  node server/factory/scripts/audit-decision-actions.js
  ```
  Add the action to `server/factory/decision-actions.js` AND wire the classifier (rule or benign-skip) in the same commit as the emit site, otherwise the CI gate breaks.
- **Doc table autogen** must be regenerated when catalog changes:
  ```bash
  node server/factory/scripts/render-decision-actions-doc.js --write
  ```
  The renderer's snapshot test (`render-decision-actions-doc.test.js`) catches stale tables on CI.

---

## Pending problems noticed during the session

These are real items the next session should know about. None are blocking, but several represent operational debt or near-future risk.

### 1. TORQUE restart deferred after sub-project 4 cutover (low priority — should self-resolve)

The auto-ship cutover script reported:
```
[error] Restart barrier response missing task_id.
        Response: {"tool":"restart_server","result":"Restart already pending (barrier: 3cc75c5e). Use await_restart to monitor."}
        Merge landed but TORQUE was NOT restarted.
```

A restart barrier from another session was already in flight. The merge IS in `main`, but the running TORQUE instance hasn't restarted on the new code. When the existing barrier drains, TORQUE will restart on the latest `main` (which includes our auto-ship work) and pick up the changes.

**Recovery if needed:**
- `mcp tool task_info { task_id: '3cc75c5e' }` to see the barrier's status.
- If it's stale: `mcp tool cancel_task { task_id: '3cc75c5e' }` to lift the gate.
- If it's done but TORQUE didn't restart: manual `restart_server` once the queue is clear.

Don't escalate to process kills (per CLAUDE.md operator policy).

### 2. Three orphan worktree dirs (low priority — WSL handle release)

After the three cutovers in this session, three worktree directories remain on disk despite the cutover script's exponential-backoff cleanup. WSL's 9P file server holds handles into the Windows filesystem after test runs; the script's 31s budget isn't long enough.

```
.worktrees/feat-torque-remote-lanes-spec/
.worktrees/feat-decision-actions-catalog/
.worktrees/feat-unified-auto-ship/
```

The branches are deleted; only the directories are stuck. Either:
- Wait for WSL to release handles (typically minutes to hours of inactivity), then `bash scripts/prune-merged-worktrees.sh --apply`.
- Or `wsl --shutdown` to force-release (operator approval required per the lanes spec — terminating WSL affects other tools).

A `.worktrees/feat-handoff-state-machine-rationalization/` will join the list after this commit cuts over.

### 3. WIP from another session sits on `main` (informational only — not ours to touch)

`git status` on `main` currently shows:
```
modified:   server/tests/starttask-helpers.test.js   (~11 lines)
modified:   server/tests/task-startup.test.js        (~1129 lines)
Untracked:
  .torque-remote.json
  server/tests/starttask-helpers-coverage.test.js
  server/tests/starttask-helpers-extended.test.js
  server/tests/starttask-helpers-unit.test.js
```

These are work-in-progress test additions from another session covering `buildProviderStartupEnv`. We've stashed and popped them across both the decision-actions and unified-auto-ship cutovers. The next cutover will need to do the same — see Pending Problem #4.

**Do not commit these or discard them** — they belong to another session.

### 4. Cutover script blocks on dirty `main` (operator process gap)

Cutovers fail when the `main` working tree has uncommitted tracked changes. Because of #3, every cutover this session needed a manual stash → cutover → pop dance. Three options for resolving:

- **Status quo:** keep stashing/popping per cutover. Manual but safe.
- **Resolve #3:** ask the other session to commit or stash their work durably. Fixes the underlying cause.
- **Cutover script enhancement:** auto-stash if dirty, auto-pop after cutover. Risky if pop conflicts with merge contents.

Status quo for now; resolution depends on reaching the other session.

### 5. CI gate covers emitters but not consumers — known meta-gap (Important)

This session caught three Critical bugs only via human code review, not the audit gate:

1. `BENIGN_FLOW_ACTION_EXACT` in `server/factory/auto-recovery/engine.js` referenced `auto_shipped_at_prioritize` after the migration killed that action name.
2. `FACTORY_CYCLE_SUCCESS_ACTIONS` in `server/handlers/factory-handlers.js` listed all three old auto-ship action names.
3. `isNonVerifyFailTerminalDecision` predicate in `server/factory/loop-controller.js` used `action.startsWith('auto_shipped_')` — the new action `auto_shipped` (no trailing underscore) doesn't match this prefix.

The audit gate (`runDecisionActionsAudit`) checks emit sites against the catalog. It does **not** check downstream code that **reads** action names. Three places (engine BENIGN list, factory-handlers SUCCESS_ACTIONS, loop-controller predicates) had hard dependencies on the old names. If a future migration renames or removes an action, similar consumers may silently break.

**Possible remediation paths (defer to future sub-project):**
- Extend the audit script to also grep for action-name string literals in `server/factory/`, `server/handlers/`, and `server/plugins/auto-recovery-core/` and warn when a literal references a name that's not in the catalog.
- Or: maintain a hand-curated `ACTION_CONSUMER_LITERALS` registry that future migrations check.
- Or: continue relying on human code review for migrations.

This is real architectural debt revealed by sub-project 4's hard cut. Not blocking, but worth surfacing.

### 6. Vitest mock hoisting doesn't work in this project's pool config (informational)

In `server/tests/auto-ship.test.js` (sub-project 4), the implementer initially tried `vi.mock('../factory/decision-log', ...)` per the standard vitest pattern. With this project's `pool: 'threads'` + CJS mode, mock hoisting doesn't intercept modules that are already in the require cache by the time the registry fires.

Workaround: use `vi.spyOn` on the cached module export. The pattern is documented in `server/tests/worker-setup.js` but is not surfaced in any contributor guide.

Action item: a one-paragraph note to whichever doc covers test conventions (likely the project README or `CLAUDE.md`'s test section) would prevent the next contributor from rediscovering this.

### 7. Doc/spec drift in `docs/superpowers/specs/2026-05-08-unified-auto-ship-helper-design.md` (resolved this session, but pattern worth noting)

The spec for sub-project 4 originally had the outcome-merge order as `{ work_item_id, ..., ...extra }` (extra wins on collision). Code review caught that this allows callers to bypass `reason` validation by stuffing `extra: { reason: 'forged' }`. The implementation was fixed (extra-before-core); the spec doc was updated to match.

Pattern worth noting: spec drift can outlive the fix because spec docs are reference material that's read independently of the code. When fixing a Critical bug discovered post-spec, also fix the spec.

### 8. Test infra friction with `torque-remote-guard` hook (operational, ongoing)

The `torque-remote-guard` hook intercepts every `vitest` invocation and routes it through `torque-remote`. When the remote is unreachable, the fallback to local works but adds overhead and noise. Multiple subagent dispatches in this session were complicated by this. The lanes work (shipped) helps when the remote is up; it doesn't help when the remote is unreachable.

**Mitigation already in place:** the operator-mandated Monitor-stall bail-out clause in subagent prompts (per CLAUDE.md) prevents 20-minute Monitor loops on hung pipelines. No further action needed unless the underlying remote-workstation reliability degrades further.

---

## Branch state at end of session

```
$ git log --oneline -8 main
590977d2 Merge branch 'feat/unified-auto-ship'      ← sub-project 4
b63d5152 Merge branch 'feat/rest-parity-audit'      ← unrelated, concurrent
c404e07b docs(factory): operator runbook note for auto-ship action rename
fbbf2e69 fix(factory): downstream consumers of old auto-ship action names
368f6d61 refactor(factory): unify auto-ship emit sites under emitAutoShipped helper
95fa654c fix(factory): outcome shadowing prevention + missing assertions
92d0ffff feat(factory): add auto-ship helper with reason enum
0ff04411 docs(plan): unified auto-ship helper implementation plan
```

```
$ git stash list
(no stashes from this session that need restoring; all popped)
```

---

## When you come back

1. Read this doc top to bottom.
2. Verify `main` is clean of our work-state (other sessions' WIP is fine, just not ours).
3. Check Pending Problem #1 — is TORQUE running the new code? `mcp tool ping` and verify the version/SHA matches `main`.
4. If picking up the parent arc, choose a sub-project from the table above. Recommended: #5 or #6 first.
5. If picking up something else entirely, this doc is the snapshot to come back to later.
