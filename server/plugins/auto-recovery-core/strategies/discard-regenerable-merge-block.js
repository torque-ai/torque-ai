'use strict';

// A-side (auto-recovery engine) strategy for the merge-target-dirty
// discard recovery. Suggested by the `learn_merge_target_dirty` rule
// when LEARN pauses a project on a dirty / mid-conflict merge target.
//
// Why we need this in addition to the B1 (work-item replan) strategy at
// server/factory/recovery-strategies/discard-regenerable-merge-block.js:
// the merge_target_dirty signal is emitted only as a project-level pause
// action in loop-controller.js — never as a work-item reject_reason. The
// B1 strategy is reachable only via reasonPattern match in replan-recovery
// over rejected work items, so it never fires for this case. Without this
// A-side wrapper, the rule's `suggested_strategies` chain has nowhere to
// route, the engine logs `auto_recovery_no_strategy`, and the project
// parks at READY_FOR_LEARN until manual operator approval.
//
// Live evidence (memory: project_factory_recovery_rule_overrides_strategy):
// DLPhone WI #762 hit merge_target_dirty on 2026-05-04 with three stale
// regenerable plan files; the discard logic would have classified them as
// allowlisted and cleaned them, but the rule's empty-strategies array
// suppressed any strategy from running and the project sat parked until
// `POST .../loop/approve {stage: "LEARN"}`.

const core = require('../../../factory/recovery-strategies/discard-regenerable-merge-block-core');

module.exports = {
  name: 'discard-regenerable-merge-block',
  // Listed under both categories so the picker accepts it whether the
  // rule labels the pause `await_self_heal` (current
  // `learn_merge_target_dirty` category) or `transient` (a future tweak
  // if we decide the label should reflect the active recovery shape).
  applicable_categories: ['await_self_heal', 'transient'],
  // One attempt per matched_rule per rearm window. The discard is
  // deterministic — if it refuses on attempt 1 (non-regenerable files
  // dirty), retrying with the same dirty state on attempt 2 will refuse
  // identically. The rule's chain falls through to `escalate` after this
  // strategy exhausts.
  max_attempts_per_project: 1,

  async run({ project, decision, services }) {
    const repoRoot = project?.path || project?.worktree_path || null;
    if (!repoRoot) {
      return {
        success: false,
        next_action: 'no_repo_root',
        outcome: {
          strategy: 'discard-regenerable-merge-block',
          reason: 'project has no repo path; cannot inspect merge target',
        },
      };
    }

    const result = await core.attemptDiscard(repoRoot, {
      logger: services.logger,
      contextLog: { project_id: project.id, batch_id: decision?.batch_id || null },
    });

    if (result.outcome === 'unavailable' || result.outcome === 'refused') {
      // Refused or git failed — return non-success so the engine logs
      // failure and pickWithBudget falls through to the next strategy
      // (escalate) on the rule's chain.
      return {
        success: false,
        next_action: 'refused',
        outcome: {
          strategy: 'discard-regenerable-merge-block',
          reason: result.reason,
          details: result.details || null,
          batch_id: decision?.batch_id || null,
        },
      };
    }

    // 'clean' or 'discarded' — both mean the merge target is now safe to
    // retry. Approve the LEARN gate so the next factory tick re-enters
    // LEARN's merge check, which will now succeed against a clean target.
    const pausedStage = (decision?.outcome?.paused_at_stage
      || decision?.stage
      || 'LEARN').toString().trim().toUpperCase();

    if (typeof services.approveGate === 'function') {
      try {
        await services.approveGate({ project_id: project.id, stage: pausedStage });
      } catch (err) {
        // approveGate may reject if the project's gate state has shifted
        // (operator approved manually, or another tick advanced it). Treat
        // as a non-fatal — the discard already cleaned the merge target,
        // and the next tick will pick up the clean state regardless.
        services.logger?.info?.(
          'discard-regenerable-merge-block: approveGate skipped after discard',
          { project_id: project.id, stage: pausedStage, err: err.message }
        );
      }
    }

    return {
      success: true,
      next_action: 'retry',
      outcome: {
        strategy: 'discard-regenerable-merge-block',
        mode: result.outcome,
        reason: result.reason,
        details: result.details || null,
        paused_stage: pausedStage,
        batch_id: decision?.batch_id || null,
      },
    };
  },
};
