// Codex fallback policy helpers. Decide whether a work item should
// proceed, park, or get rerouted when the Codex circuit breaker is
// open; and pre-flight whether a `codex_only` item could be decomposed
// into smaller free-eligible sub-items before parking.
//
// Pure decision helpers — they read from the DB and policy modules but
// never write. Sub-item creation happens elsewhere (deferred to a later
// phase of the Codex-fallback rollout).
//
// Extracted from server/factory/loop-controller.js as Phase 1b of the
// god-object refactor. Behavior preserved; no signature changes.

const EXECUTE_DEFERRED_PAUSED_AT_STAGE = 'EXECUTE_DEFERRED';

function isExecuteDeferredPauseStage(pausedAtStage) {
  return String(pausedAtStage || '').toUpperCase() === EXECUTE_DEFERRED_PAUSED_AT_STAGE;
}

/**
 * decideCodexFallbackAction — Codex Fallback Phase 1+2 helper.
 *
 * Consulted at PRIORITIZE before EXECUTE. Looks at the Codex circuit-breaker
 * state and the project's `codex_fallback_policy` to decide whether to
 * proceed, park, or route through a fallback chain.
 *
 * The circuit breaker is resolved by the caller (typically via
 * `defaultContainer.get('circuitBreaker')`).
 *
 * @param {{ db, projectId, workItemId, breaker }} opts
 * @returns {{ action: 'proceed'|'park'|'proceed_with_fallback', reason?: string }}
 */
function decideCodexFallbackAction({ db, projectId, workItemId, breaker }) {
  void workItemId; // reserved for future per-item policy decisions
  // Determine if Codex is currently unavailable.
  let codexOpen = false;
  if (breaker) {
    if (typeof breaker.isOpen === 'function') {
      try { codexOpen = breaker.isOpen('codex'); } catch (_e) { void _e; codexOpen = false; }
    } else if (typeof breaker.allowRequest === 'function') {
      try { codexOpen = !breaker.allowRequest('codex'); } catch (_e) { void _e; codexOpen = false; }
    }
  }
  if (!codexOpen) return { action: 'proceed' };

  const { getCodexFallbackPolicy } = require('../../db/factory/intake');
  let policy;
  try {
    policy = getCodexFallbackPolicy({ db, projectId });
  } catch (_e) {
    void _e;
    // Defensive: if policy lookup fails (missing project, malformed
    // config_json), default to 'auto' so we never accidentally park.
    policy = 'auto';
  }

  if (policy === 'wait_for_codex') {
    return { action: 'park', reason: 'wait_for_codex_policy' };
  }
  if (policy === 'manual') {
    return { action: 'proceed' };
  }
  // 'auto' policy — Phase 1 has no failover routing yet.
  // Phase 2 will reroute EXECUTE; for now we proceed and let it fail.
  return { action: 'proceed_with_fallback' };
}

/**
 * decomposeBeforePark — Codex Fallback Phase 3 helper.
 *
 * Before parking a `codex_only` work item, attempt to decompose it into
 * smaller sub-tasks and classify each sub-task's free eligibility. This
 * function is READ-ONLY — it never writes to the database. The return value
 * tells the caller whether decomposition would yield any free-eligible
 * sub-items; actual sub-item creation is deferred to a future phase.
 *
 * @param {{ db, projectId, workItem, projectConfig }} opts
 * @returns {{ decomposed: boolean, eligibleCount: number, subtaskCount?: number,
 *             eligibleSubitems?: string[], error?: string }}
 */
function decomposeBeforePark({ db, projectId, workItem, projectConfig }) {
  void db; void projectId; // read-only — no DB writes needed
  try {
    const { decomposeTask } = require('../../db/host/complexity');
    const { classify } = require('../../routing/eligibility-classifier');

    const description = workItem?.title || workItem?.description || '';
    const workingDirectory = workItem?.working_directory || '';

    const subtasks = decomposeTask(description, workingDirectory);
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      return { decomposed: false, eligibleCount: 0 };
    }

    // Each element from decomposeTask is a plain string (task description).
    // Build a minimal work-item + plan shape for the classifier:
    // - category: inherit from the parent item, falling back to 'simple_generation'
    //   (decomposed sub-tasks tend to be targeted file edits).
    // - plan: single task touching 1 file inferred from the sub-task string.
    const parentCategory = workItem?.category || 'simple_generation';
    let eligibleCount = 0;
    const eligibleSubitems = [];

    for (const sub of subtasks) {
      const subText = typeof sub === 'string' ? sub : String(sub);

      // Extract a file path from the description when present.
      const filePattern = /\bfile\s+(\S+\.\w+)/i;
      const fileHit = subText.match(filePattern);
      const inferredFile = fileHit ? fileHit[1] : null;

      const subItem = { category: parentCategory };
      const subPlan = {
        tasks: [{
          files_touched: inferredFile ? [inferredFile] : [],
          estimated_lines: 50, // conservative single-file estimate
        }],
      };

      const result = classify(subItem, subPlan, projectConfig || {});
      if (result.eligibility === 'free') {
        eligibleCount += 1;
        eligibleSubitems.push(subText);
      }
    }

    return {
      decomposed: true,
      subtaskCount: subtasks.length,
      eligibleCount,
      eligibleSubitems,
    };
  } catch (err) {
    return { decomposed: false, eligibleCount: 0, error: err.message };
  }
}

module.exports = {
  EXECUTE_DEFERRED_PAUSED_AT_STAGE,
  isExecuteDeferredPauseStage,
  decideCodexFallbackAction,
  decomposeBeforePark,
};
