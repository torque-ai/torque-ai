# Plan: Unified startup reconcilers for factory loops, task orphans, and workflow DAGs

**Source:** 2026-04-19 session — post-restart drift observed on bitsy (`loop_state=EXECUTE, batch_id=null, status=running`) and SpudgetBooks (stranded EXECUTE). Had to manually call `reset_factory_loop` + `start_factory_loop` to unstick. Root cause: in-memory auto_advance chains die on restart; existing `resumeAutoAdvanceOnStartup` only covers `auto_continue=true` projects with already-coherent state. Similar gaps exist for standalone-task orphans and workflow DAGs.

**Tech Stack:** Node.js, better-sqlite3, vitest.

**Order-of-operations at boot** (critical — Task 3 depends on Task 2's clones being present):

```
DB ready
  → Task 2 (task orphan reconciler)           clones orphans → queued
  → Task 3 (workflow DAG reconciler)          re-evaluates readiness, unblocks deps
  → Task 1 (factory loop reconciler)          re-kicks auto_advance chains
  → initFactoryTicks                          5-min safety net
  → processQueue()                            scheduler picks up queued work
```

---

## Task 1: Factory startup reconciler

Create `server/factory/startup-reconciler.js` exporting `reconcileFactoryProjectsOnStartup({ logger } = {})`.

### Step 1: Module skeleton + project-row drift fix

- Create `server/factory/startup-reconciler.js`. Requires: `factory-health`, `factory-loop-instances`, `loop-controller`, `factory-tick` (for `reconcileOrphanWorktrees` if exposed), `loop-states`, `logger`.
- Define module-level idempotency guard: `let alreadyReconciled = false;`. Early-return `{ reconciled: false, reason: 'already_reconciled' }` if true. Set after first successful run.
- For each `factoryHealth.listProjects({ status: 'running' })`:
  - Capture `preSyncState = { loop_state: project.loop_state, loop_batch_id: project.loop_batch_id, loop_paused_at_stage: project.loop_paused_at_stage }` BEFORE any mutation.
  - Run `worktree-reconcile.reconcileProject({ db, project_id: project.id, project_path: project.path })` (if `worktree-reconcile` exposes a project-scoped reconciler — otherwise skip this sub-step with a TODO).
  - Call `loopController.syncLegacyProjectLoopState(project.id)` to force `factory_projects.loop_state` to match `factory_loop_instances`.
- Fetch active instances: `factoryLoopInstances.listInstances({ project_id: project.id, active_only: true }).filter(i => !i.terminated_at)`.

### Step 2: Stranded-no-instances branch (the bitsy bug)

- If `instances.length === 0`:
  - Compute `wasRunningBeforeRestart = preSyncState.loop_state !== 'IDLE' && preSyncState.loop_state !== null || (project.config?.loop?.auto_advance === true) || (project.config?.loop?.auto_continue === true)`.
  - If `wasRunningBeforeRestart`, schedule `setImmediate(() => { try { loopController.startLoopAutoAdvance(project.id); } catch (err) { logger.debug('startup reconciler start failed', { project_id: project.id, err: err.message }); } })`. Increment `actions.restarted`.
  - Otherwise, just `actions.skipped++`. Continue.

### Step 3: Per-instance classification

For each active instance `inst`:
- `state = loopController._getCurrentLoopStateForTests?.(inst) ?? inst.loop_state.toUpperCase()` (use whatever export `loop-controller` exposes; if private, inline the trivial uppercase logic).
- `paused = inst.paused_at_stage || inst.loop_paused_at_stage || null`.
- **Gate paused** (`paused.startsWith('READY_FOR_')`): `actions.skipped++`, continue.
- **VERIFY_FAIL paused**: `actions.skipped++`, continue (operator runs `retry_factory_verify`).
- **Paused at EXECUTE with empty batch**: if `paused === 'EXECUTE'` and `countRunningOrQueuedTasksForBatch(inst.batch_id) === 0`:
  - `loopController.terminateInstanceAndSync(inst.id, { abandonWorktree: true })`.
  - Schedule `setImmediate(() => loopController.startLoopAutoAdvance(project.id))`. Increment `actions.restarted`.
- **VERIFY state** (`state === 'VERIFY'`): emit `factory_verify_needs_retry` event if event-bus has a helper; otherwise just log. Increment `actions.deferred_verify`. Do NOT re-advance (blocks event loop per existing comment at loop-controller.js:6378-6384).
- **Happy path** (unpaused, non-VERIFY): `setImmediate(() => loopController.advanceLoopAsync(inst.id, { autoAdvance: true }))`. Increment `actions.advanced`.

### Step 4: Helper — countRunningOrQueuedTasksForBatch

Inside the reconciler module, add a local helper that queries `taskCore.listTasks({ tags: ['factory:batch_id=' + batch_id], limit: 200 })` and counts tasks whose status is `running` or `queued`. Returns 0 if batch_id is null. Failures return 0 (fail closed = treat batch as empty → terminate stranded instance).

### Step 5: Export + replace existing startup function

- Export `reconcileFactoryProjectsOnStartup` and a deprecation shim: `resumeAutoAdvanceOnStartup = reconcileFactoryProjectsOnStartup` so `server/index.js` can keep calling the old name for one release cycle. Mark with JSDoc.
- In `server/index.js`, find the `resumeAutoAdvanceOnStartup()` call (around line 938) and replace with `reconcileFactoryProjectsOnStartup()`. Keep the same position in the boot sequence (before `initFactoryTicks`).

### Step 6: Test file

Create `server/tests/factory-startup-reconciler.test.js` following the pattern in `server/tests/factory-loop-controller.test.js`. Cover the 9 scenarios from the research:

1. Coherent running project — one advance call, no start.
2. Stranded no instances with `auto_advance=true` — syncs to IDLE, starts fresh loop.
3. Stranded no instances without auto flags — syncs to IDLE, does NOT start (operator-managed).
4. Paused-at-EXECUTE with empty batch — terminates instance, starts fresh.
5. Paused-at-EXECUTE with live tasks — leaves alone.
6. VERIFY-state instance — no advance, deferred_verify counter increments.
7. Ready-for-gate paused — no advance, skipped counter increments.
8. Orphan factory_worktrees row — worktree reconciled BEFORE advance.
9. Idempotency — calling twice is a no-op on second call.

---

## Task 2: Task orphan reconciler with auto-resubmit

Create `server/execution/startup-task-reconciler.js` exporting `reconcileOrphanedTasksOnStartup({ db, taskCore, getMcpInstanceId, isInstanceAlive, logger })`.

### Step 1: Module + candidate query

- Create the file. Requires: `resume-context.js` (`buildResumeContext`), `logger`.
- Candidate query: `db.prepare("SELECT * FROM tasks WHERE status IN ('running','claimed')").all()`. Filter in JS: keep rows where `mcp_instance_id` is null, equals `getMcpInstanceId()` (previous-run rows of the same instance after a hard crash), or `!isInstanceAlive(mcp_instance_id)`.

### Step 2: Per-task reconcile loop

For each candidate `original`:
- Parse `metadata = JSON.parse(original.metadata || '{}')`.
- **Pointer idempotency**: if `metadata.resubmitted_as` is set, `getTask(metadata.resubmitted_as)` returns a row, and its status is not `cancelled`, skip entirely (client-side `handleRestartRecovery` or prior reconciler already adopted it).
- **Mark original cancelled**: `taskCore.updateTaskStatus(original.id, 'cancelled', { cancel_reason: 'server_restart', error_output: (original.error_output || '') + '\n[startup-reconciler] task cancelled by server restart', completed_at: new Date().toISOString() })`.
- **Eligibility gate** — clone if ANY:
  - `metadata.auto_resubmit_on_restart === true`
  - `(original.tags || '').includes('factory')` (string-contains is fine, tags store as comma-separated or JSON)
  - `original.workflow_id != null` AND `db.getWorkflow(original.workflow_id)?.status === 'running'`
- **Hard cap**: `Number(metadata.restart_resubmit_count || 0) < 3`. If exceeded, log and skip clone.
- Otherwise no clone; continue.

### Step 3: Clone with resume context

- Build resume context: `const ctx = buildResumeContext(original.output || '', original.error_output || '', { task_description: original.task_description, provider: original.provider, duration_ms: null })`.
- Generate `newId = randomUUID()`.
- Insert clone via `taskCore.createTask({ id: newId, status: 'queued', task_description: original.task_description, provider: original.original_provider || original.provider, model: original.model, working_directory: original.working_directory, timeout_minutes: original.timeout_minutes, priority: original.priority, tags: original.tags, workflow_id: original.workflow_id, workflow_node_id: original.workflow_node_id, resume_context: JSON.stringify(ctx), metadata: JSON.stringify({ ...metadata, restart_resubmit_count: Number(metadata.restart_resubmit_count || 0) + 1, resubmitted_from: original.id, reconciler: 'startup' }) })`.
- Patch original: `taskCore.patchTaskMetadata(original.id, { resubmitted_as: newId })` (if helper exists; otherwise UPDATE tasks SET metadata=...).
- If `original.workflow_id`, call `workflowEngine.rewireWorkflowTaskId({ workflow_id, old_task_id: original.id, new_task_id: newId })` if such a helper exists; otherwise UPDATE `task_dependencies` rows where `task_id=original.id` or `depends_on_task_id=original.id` to point at `newId`.

### Step 4: Idempotency safety net via partial unique index

Add a migration in `server/db/schema-migrations.js`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_resubmitted_from_active
  ON tasks(json_extract(metadata,'$.resubmitted_from'))
  WHERE status != 'cancelled' AND json_extract(metadata,'$.resubmitted_from') IS NOT NULL
```

The reconciler catches `SQLITE_CONSTRAINT` on insert and treats it as "client-side resubmit won" — logs and skips.

### Step 5: Integration at boot

- In `server/index.js`, find the existing orphan-requeue block (around lines 1137-1236) that calls `requeueOrphanedTask`. Wrap or replace it so that:
  - For tasks with no eligibility flags, fall back to the existing in-place requeue (legacy behavior, preserves current contract).
  - For eligible tasks, call `reconcileOrphanedTasksOnStartup` to clone with resume context.
- Must run BEFORE the workflow sweep (currently at lines 1246-1268) so the workflow reconciler sees queued clones.
- Must run BEFORE `taskManager.processQueue()`.

### Step 6: Tests

Create `server/tests/startup-task-reconciler.test.js`. Cover:

1. No orphans — no-op.
2. Orphan with `metadata.auto_resubmit_on_restart=true` — original cancelled, clone queued with resume_context populated, `metadata.resubmitted_from` links back.
3. Orphan without flag and no factory tag and no active workflow — cancelled but NOT cloned.
4. Factory-tagged orphan — cloned even without explicit flag.
5. Double-run idempotency — second call no-ops because `resubmitted_as` points to non-cancelled clone.
6. Resume-context propagation — clone's `resume_context` parses back to expected fields.
7. Resubmit cap — `restart_resubmit_count=3` → cancelled but not cloned.
8. Unique index guard — simulated race (two concurrent inserts) → one succeeds, one skipped.

---

## Task 3: Workflow DAG reconciler

Extend `server/execution/workflow-runtime.js` with `reconcileWorkflowsOnStartup()`. Or create `server/execution/startup-workflow-reconciler.js` that imports from workflow-runtime.

### Step 1: Core loop

- Query: `db.listWorkflows({ status: ['running', 'paused'], limit: 10000 })` (drop the previous `limit: 100` cap).
- For each `wf`:
  - Load tasks: `tasks = db.getWorkflowTasks(wf.id)`.
  - Track counts: `{ terminal, running, queued, blocked_or_pending }`.

### Step 2: Rewire superseded tasks

- For each task `t` whose `status === 'cancelled'` and `metadata.resubmitted_as` points to a non-cancelled clone (populated by Task 2):
  - Update any `task_dependencies` rows where `depends_on_task_id = t.id` to point at the clone. Use a single SQL statement: `UPDATE task_dependencies SET depends_on_task_id = ? WHERE depends_on_task_id = ? AND workflow_id = ?`.
  - Similarly for rows where `task_id = t.id` (edges pointing OUT of the superseded task).

### Step 3: Re-ready blocked/pending nodes

- For each task `t` with `status IN ('blocked', 'waiting', 'pending')`:
  - If `areTaskDependenciesSatisfied(t.id).satisfied` (existing helper): call `unblockTask(t.id)`. This flips to `queued` + emits queue event.

### Step 4: Replay terminations for unblock side-effects

- For each task `t` with terminal status (`completed`, `failed`, `cancelled`, `skipped`):
  - Call `handleWorkflowTermination(t.id)`. The existing `terminalGuards` map prevents duplicate evaluation; unblock side-effects fire for dependents.

### Step 5: Completion check

- Call `checkWorkflowCompletion(wf.id)` — existing helper. Idempotently marks `completed`, `completed_with_errors`, `failed`, or leaves `running` as appropriate.

### Step 6: Integration

- Replace the inline sweep at `server/index.js:1246-1268` with `workflowRuntime.reconcileWorkflowsOnStartup()`.
- Must run AFTER Task 2's `reconcileOrphanedTasksOnStartup` (so clones exist in `queued`).
- Must run BEFORE `taskManager.processQueue()`.

### Step 7: Tests

Create `server/tests/startup-workflow-reconciler.test.js`. Cover 5 scenarios:

1. All-complete idempotent — wf already all-terminal; reconciler transitions wf to `completed`.
2. Linear A→B→C with B orphaned + cloned — B is cancelled with `resubmitted_as=B'`; dependencies rewired; C stays blocked on B'; wf stays running.
3. Diamond A→B,C→D with B completed, C orphaned+cloned — C' queued; D stays blocked (needs both); wf running.
4. All-failed path — wf marked `failed`.
5. Fresh wf with first node orphaned — clone queued; downstream nodes stay pending with unsatisfied deps; wf running.

---

## Global verification

After all three tasks ship, simulate a full restart:

1. Create a test workflow with 3 tasks (A→B→C), start it.
2. While B is running, force-kill TORQUE (`bash stop-torque.sh --force`).
3. Restart TORQUE.
4. Expect: B's process is orphaned → task reconciler cancels B, clones B' → workflow reconciler rewires C's dep on B' → B' runs → completes → C fires.
5. Verify no manual intervention was needed.

Also test factory recovery:

1. Start bitsy factory with `auto_advance=true`.
2. While in EXECUTE, force-kill TORQUE.
3. Restart.
4. Expect: factory reconciler detects stranded state, re-kicks `startLoopAutoAdvance`, loop resumes from SENSE.
