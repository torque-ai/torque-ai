'use strict';

/**
 * Sweep for needs_review work items stranded by historical false-positive
 * zero-diff rejections.
 *
 * Background: the zero-diff short-circuit (loop-controller.js
 * maybeShortCircuitZeroDiffExecute) used to misclassify agent self-commits
 * as zero-diff retries because it only counted the factory's
 * auto_committed_task decisions, not actual branch commits ahead of base.
 * Fixed in b29e672b by adding batchBranchHasCommitsAhead. But work items
 * marked unactionable + zero_diff_across_retries before the fix landed are
 * stranded: many were genuinely shipped (the agent committed) but the
 * factory thinks they failed. Operator triage on 2026-05-04 found that of
 * 12 stranded WIs, 4 had matching commit subjects (already shipped), 8
 * were just waiting on a fresh attempt under the fixed engine.
 *
 * This sweep runs the same shippedDetector that PRIORITIZE uses for OPEN
 * items, but applies it to needs_review items with the canonical
 * pre-fix reject_reason. High/medium-confidence matches → shipped_stale.
 * No match → needs_replan, which lets PRIORITIZE re-pick the WI under
 * the fixed engine without operator action.
 *
 * Scope is intentionally narrow: only WIs with status='needs_review' AND
 * reject_reason='zero_diff_across_retries'. Future false-positive shapes
 * would need new rejection-reason filters added here.
 */

const fs = require('fs');
const factoryIntake = require('../db/factory-intake');

const TARGETED_REJECT_REASONS = new Set([
  'zero_diff_across_retries',
]);

function isTargetedReason(reason) {
  if (typeof reason !== 'string') return false;
  return TARGETED_REJECT_REASONS.has(reason.trim());
}

function loadPlanContent(workItem) {
  const planPath = workItem?.origin?.plan_path;
  if (planPath && fs.existsSync(planPath)) {
    try { return fs.readFileSync(planPath, 'utf8'); } catch { /* fall through */ }
  }
  return workItem?.description || '';
}

/**
 * Sweep one project's needs_review backlog.
 *
 * @param {object} project — { id, path } at minimum
 * @param {object} deps — { logger, safeLogDecision }
 * @returns {object} summary { scanned, auto_shipped, auto_replanned, errors }
 */
function sweepStrandedNeedsReviewForProject(project, deps = {}) {
  const summary = { scanned: 0, auto_shipped: 0, auto_replanned: 0, errors: 0 };
  if (!project?.id) return summary;

  const { logger, safeLogDecision } = deps;
  const log = (lvl, msg, ctx) => {
    if (logger && typeof logger[lvl] === 'function') logger[lvl](msg, ctx);
  };

  let candidates = [];
  try {
    candidates = (factoryIntake.listWorkItems({
      project_id: project.id,
      status: 'needs_review',
      limit: 500,
    }) || []).filter((wi) => isTargetedReason(wi?.reject_reason));
  } catch (err) {
    log('debug', 'sweep-stranded-needs-review: listWorkItems threw', { err: err?.message });
    summary.errors += 1;
    return summary;
  }

  if (candidates.length === 0) return summary;
  summary.scanned = candidates.length;

  let detector = null;
  try {
    if (deps.detectorFactory) {
      detector = deps.detectorFactory({ repoRoot: project.path });
    } else {
      const { createShippedDetector } = require('./shipped-detector');
      detector = createShippedDetector({ repoRoot: project.path });
    }
  } catch (err) {
    log('debug', 'sweep-stranded-needs-review: detector init threw', { err: err?.message });
    summary.errors += 1;
    return summary;
  }

  for (const wi of candidates) {
    let detection = null;
    try {
      detection = detector.detectShipped({
        content: loadPlanContent(wi),
        title: wi.title,
      });
    } catch (err) {
      log('debug', 'sweep-stranded-needs-review: detectShipped threw', {
        work_item_id: wi.id, err: err?.message,
      });
      summary.errors += 1;
      continue;
    }

    if (detection?.shipped && detection.confidence !== 'low') {
      try {
        // factoryIntake.updateWorkItem auto-clears reject_reason when
        // transitioning to a success status (shipped/shipped_stale/completed).
        // Skip the reject_reason field — the decision log below captures
        // the auto-resolution context for audit.
        factoryIntake.updateWorkItem(wi.id, {
          status: 'shipped_stale',
        });
        summary.auto_shipped += 1;
        if (typeof safeLogDecision === 'function') {
          safeLogDecision({
            project_id: project.id,
            stage: 'sense',
            action: 'auto_resolved_stranded_needs_review_shipped',
            reasoning: `Stranded needs_review WI ${wi.id} (reject_reason=${wi.reject_reason}) matched existing commits with ${detection.confidence} confidence; transitioning to shipped_stale.`,
            inputs: { work_item_id: wi.id, work_item_title: wi.title || null },
            outcome: { confidence: detection.confidence, signals: detection.signals || null },
            confidence: 1,
          });
        }
      } catch (err) {
        log('warn', 'sweep-stranded-needs-review: failed to mark shipped_stale', {
          work_item_id: wi.id, err: err?.message,
        });
        summary.errors += 1;
      }
    } else {
      try {
        factoryIntake.updateWorkItem(wi.id, {
          status: 'needs_replan',
          reject_reason: `auto_replan_post_zero_diff_fix_b29e672b (no commit match: confidence=${detection?.confidence || 'none'})`,
        });
        summary.auto_replanned += 1;
        if (typeof safeLogDecision === 'function') {
          safeLogDecision({
            project_id: project.id,
            stage: 'sense',
            action: 'auto_resolved_stranded_needs_review_replan',
            reasoning: `Stranded needs_review WI ${wi.id} (reject_reason=${wi.reject_reason}) has no commit-subject match; transitioning to needs_replan so PRIORITIZE can re-pick under the fixed engine.`,
            inputs: { work_item_id: wi.id, work_item_title: wi.title || null },
            outcome: { confidence: detection?.confidence || 'none' },
            confidence: 1,
          });
        }
      } catch (err) {
        log('warn', 'sweep-stranded-needs-review: failed to mark needs_replan', {
          work_item_id: wi.id, err: err?.message,
        });
        summary.errors += 1;
      }
    }
  }

  return summary;
}

module.exports = {
  sweepStrandedNeedsReviewForProject,
  isTargetedReason,
  TARGETED_REJECT_REASONS,
};
