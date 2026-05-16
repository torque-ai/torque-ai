// JSDoc typedefs for the Stage interface defined in
// docs/factory-stage-interface.md. This file exports nothing at runtime —
// other modules reference these typedefs via
// `@typedef {import('./types').StageContext}`.
//
// When a future TypeScript migration ships, these become the seed for
// the real interface declarations.

/* eslint-disable no-unused-vars */

/**
 * @typedef {Object} ProjectRow
 *   Factory project row from factory_projects_with_config. Carries the
 *   merged config (preferred) plus raw config_json (fallback). Stage code
 *   reads project.config / project.path / project.brief; it never mutates.
 */

/**
 * @typedef {Object} InstanceRow
 *   A live row from factory_loop_instances. Stage code reads
 *   instance.id / instance.project_id / instance.loop_state /
 *   instance.batch_id / instance.work_item_id. Mutations go through
 *   `instanceStore.updateAndSync`.
 */

/**
 * @typedef {Object} WorkItem
 *   A row from factory_work_items. Stages read id / title / description /
 *   origin / constraints / status / reject_reason / source. Mutations go
 *   through `workItemStore.update`.
 */

/**
 * @typedef {Object} DecisionRecord
 *   A row destined for factory_decisions. Required: project_id, stage,
 *   action, reasoning, confidence. Optional: outcome, inputs, batch_id,
 *   work_item_id, instance_id.
 */

// --- Store interfaces -------------------------------------------------

/**
 * @typedef {Object} WorkItemStore
 *   Domain operations over work items. Wraps factoryIntake.
 * @property {(id: string|number) => WorkItem|null} load
 * @property {(id: string|number, fields: object) => WorkItem|null} update
 * @property {(projectId: string|number, opts?: { limit?: number }) => WorkItem[]} listOpen
 * @property {(projectId: string|number, instanceId: string|number) => Promise<{ openItems: WorkItem[], workItem: WorkItem|null }>} claimNext
 * @property {(instanceId: string|number) => void} releaseClaim
 * @property {(workItem: WorkItem, opts: { reason: string, attempt?: number, details?: object }) => WorkItem} routeToNeedsReplan
 * @property {(workItem: WorkItem) => object|null} getTerminalEscalationEvidence
 * @property {({ projectId: string|number }) => string} getCodexFallbackPolicy
 */

/**
 * @typedef {Object} InstanceStore
 *   Domain operations over loop instances. Wraps factoryLoopInstances +
 *   the in-memory selected-work-item cache.
 * @property {(id: string|number) => InstanceRow|null} load
 * @property {(id: string|number, fields: object) => InstanceRow|null} updateAndSync
 * @property {(instanceId: string|number, workItem: WorkItem|null) => void} rememberSelectedWorkItem
 * @property {(instanceId: string|number) => void} clearSelectedWorkItem
 * @property {(instance: InstanceRow, projectId: string|number, opts?: { fallbackToLoopSelection?: boolean }) => WorkItem|null} getSelectedWorkItem
 * @property {(projectId: string|number) => InstanceRow[]} listActive
 * @property {(projectId: string|number) => InstanceRow|null} getOldestActive
 */

/**
 * @typedef {Object} DecisionStore
 *   Decision-log writer + reader. Wraps factoryDecisions / decision-log.
 *   Stages call `log(...)` instead of the legacy `safeLogDecision(...)`.
 * @property {(record: DecisionRecord) => void} log
 * @property {(projectId: string|number, stage: string) => DecisionRecord|null} getLatestForStage
 * @property {(batchId: string) => DecisionRecord[]} listForBatch
 */

/**
 * @typedef {Object} BatchStore
 *   Execution-batch lookup. Wraps factoryIntake batch helpers + task-core.
 * @property {(projectId: string|number, workItemId: string|number) => string} getOrCreate
 * @property {(batchId: string) => Array<{ id: string, status: string, tags?: string[] }>} listTasks
 */

/**
 * @typedef {Object} WorktreeStore
 *   Factory worktree lookups + lifecycle markers. Wraps factoryWorktrees.
 * @property {(batchId: string) => object|null} getActiveByBatch
 * @property {(projectId: string|number) => object|null} getActiveByProject
 * @property {(record: object, opts: object) => void} markMerged
 */

// --- Context / outcome ------------------------------------------------

/**
 * @typedef {Object} StageContext
 *   The single resolved-once input every stage receives. The dispatcher
 *   builds this via `resolveStageContext()` and hands it to the stage
 *   executor matching the current loop state.
 *
 * @property {ProjectRow} project           — already-resolved project row
 * @property {InstanceRow} instance         — already-resolved loop instance
 * @property {WorkItem|null} workItem       — currently-selected work item, or null for Sense
 * @property {string|null} batchId          — current execution batch, or null pre-EXECUTE
 *
 * @property {WorkItemStore} workItemStore
 * @property {InstanceStore} instanceStore
 * @property {DecisionStore} decisionStore
 * @property {BatchStore} batchStore
 * @property {WorktreeStore} worktreeStore
 *
 * @property {import('../../logger').Logger} logger
 *   Pre-bound child logger with project_id / instance_id / stage tags.
 */

/**
 * @typedef {'continue'|'pause'|'terminate'|'idle'|'starved'} StageDisposition
 *
 *   - 'continue':   advance to nextState (or next-in-order if nextState is null)
 *   - 'pause':      hold at pausedAtStage; await external signal
 *                   (gate, file lock, deferred plan generation, …)
 *   - 'terminate':  the instance is done (success or unrecoverable failure)
 *   - 'idle':       no work to do; release the slot
 *   - 'starved':    intake is empty; route to recovery scouts
 */

/**
 * @typedef {Object} StageOutcome
 *   What a stage returns to the dispatcher. Discriminated union over
 *   `disposition`; all other fields are optional and stage-specific.
 *
 * @property {StageDisposition} disposition
 * @property {string|null} [nextState]      — explicit override; defaults to next-in-order for 'continue'
 * @property {string|null} [pausedAtStage]  — required when disposition === 'pause'
 *
 * @property {WorkItem|null} [workItem]     — updated selected work item; null clears the selection
 * @property {string|null} [batchId]        — set when this stage produced a new batch (EXECUTE → VERIFY)
 *
 * @property {string|null} [reason]         — short human-readable reason, recorded in the decision log
 * @property {object} [stageResult]         — stage-specific payload (scan summary, plan path, verify output…)
 *
 * @property {DecisionRecord[]} [extraDecisions]
 *   Additional decision-log rows the stage wants emitted. `applyOutcome`
 *   writes the primary `stage_complete` decision first, then these in
 *   order, so causal order is preserved in the log.
 */

// --- Per-stage stage_result shapes ------------------------------------

/** @typedef {{ plans_dir: string|null, scanned: number, created_count: number, shipped_count: number, skipped_count: number, reconciled_count?: number }} SenseStageResult */
/** @typedef {{ work_item_id: string|number|null, open_count: number }} PrioritizeStageResult */
/** @typedef {{ plan_path: string|null, plan_generation_task_id: string|null, status: 'materialized'|'deferred'|'failed' }} PlanStageResult */
/** @typedef {{ batch_id: string, tasks_submitted: number, mode: 'plan_file'|'non_plan_file' }} ExecuteStageResult */
/** @typedef {{ status: 'passed'|'failed'|'paused', exit_code: number|null, output_tail: string|null, fix_task_id: string|null }} VerifyStageResult */
/** @typedef {{ shipped_as_noop: boolean, feedback_id: string|null, summary: string|null }} LearnStageResult */

module.exports = {};
