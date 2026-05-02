'use strict';

/**
 * Codex reasoning_effort classifier.
 *
 * Picks an explicit `model_reasoning_effort` value for the codex CLI based on
 * what the task actually needs, instead of falling through to the user's
 * global codex config (often `xhigh`). The user's xhigh default is right for
 * deep architectural reasoning but wrong for shell-command-only tasks like
 * "Run `bash scripts/foo.sh`" — those spend the whole timeout window
 * thinking instead of executing. Observed live 2026-05-01 on bb7439e4
 * (a "Run `bash scripts/prune-merged-worktrees.sh --apply`" task that ran
 * 10m3s with zero output before the 10-min timeout fired).
 *
 * Tiers:
 *   - 'simple'  → reasoning_effort=low.  Short, mostly-imperative shell
 *     execute / one-line-lookup tasks. The model doesn't need deep reasoning;
 *     it needs to actually run the command and report.
 *   - 'normal'  → reasoning_effort=high. Factory-internal tasks (architect,
 *     plan-quality review, scout) that need strong reasoning to produce
 *     structured output but where the user's xhigh default reliably blows
 *     past the timeout. `high` keeps strong reasoning while leaving room for
 *     output emission.
 *   - 'complex' → no override (returns null). Genuine hard-reasoning work
 *     where the user's global xhigh is the right call.
 *
 * Per-task explicit override: if `task.metadata.reasoning_effort` is set to
 * one of {'low','medium','high','xhigh'}, that wins over classification.
 */

const VALID_EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh']);

const TIER_TO_EFFORT = Object.freeze({
  simple: 'low',
  normal: 'high',
  complex: null,
});

// Factory-internal task kinds that produce template-driven structured-output
// (verdict + critique JSON, deterministic rewrite scaffolding) where extra
// reasoning yields no quality benefit but eats the timeout. Source:
// d0ea3eed "fix(factory): keep replan rewrites from timing out".
const LOW_REASONING_FACTORY_KINDS = new Set([
  'plan_quality_review',
  'replan_rewrite',
  'verify_review',
]);

const LOW_REASONING_SCOUT_REASONS = new Set([
  'factory_starvation_recovery',
]);

function parseTaskMetadata(task) {
  if (!task || !task.metadata) return null;
  if (typeof task.metadata === 'object') return task.metadata;
  try { return JSON.parse(task.metadata); } catch { return null; }
}

function isFactoryInternal(metadata) {
  return Boolean(metadata && metadata.factory_internal === true);
}

function isFactoryScout(metadata) {
  return Boolean(metadata && metadata.mode === 'scout');
}

// Detects "this task is a shell command, not a coding task". Conservative
// on purpose — false negatives just mean we leave the task on its current
// reasoning effort, false positives mean we under-power a real coding task.
function isShellExecuteOnly(task) {
  const desc = String(task && task.task_description || '').trim();
  if (!desc) return false;
  // Long descriptions almost certainly carry coding context.
  if (desc.length > 1500) return false;

  const firstLine = desc.split('\n')[0].trim();

  // "Run `cmd`", "Execute `cmd`", "Invoke `cmd`" — the canonical shape that
  // bit us on bb7439e4. Single backtick block on the first line is the
  // strong signal.
  if (/^(run|execute|invoke)\s+`[^`]+`/i.test(firstLine)) {
    return true;
  }

  return false;
}

/**
 * Classify a task's reasoning_effort tier.
 *
 * @param {object} task - task row (with task_description and metadata)
 * @returns {{tier: string, reasoning_effort: string|null, reason: string}}
 */
function classifyReasoningEffort(task) {
  const metadata = parseTaskMetadata(task);

  // Per-task explicit override wins.
  const explicit = metadata && typeof metadata.reasoning_effort === 'string'
    ? metadata.reasoning_effort.trim().toLowerCase()
    : null;
  if (explicit && VALID_EFFORT_VALUES.has(explicit)) {
    return {
      tier: 'explicit',
      reasoning_effort: explicit,
      reason: 'metadata.reasoning_effort override',
    };
  }

  if (isShellExecuteOnly(task)) {
    return {
      tier: 'simple',
      reasoning_effort: TIER_TO_EFFORT.simple,
      reason: 'shell_execute_only',
    };
  }

  // Factory-internal tasks of specific structured-output kinds run faster
  // and at the same quality on `low` than on `high`. Check kind before the
  // generic factory_internal branch so the kind-specific rule wins.
  const kind = typeof metadata?.kind === 'string' ? metadata.kind : null;
  if (isFactoryInternal(metadata) && kind && LOW_REASONING_FACTORY_KINDS.has(kind)) {
    return {
      tier: 'simple',
      reasoning_effort: TIER_TO_EFFORT.simple,
      reason: `factory_internal_low_reasoning_kind:${kind}`,
    };
  }

  const scoutReason = typeof metadata?.reason === 'string' ? metadata.reason : null;
  if (isFactoryScout(metadata) && scoutReason && LOW_REASONING_SCOUT_REASONS.has(scoutReason)) {
    return {
      tier: 'simple',
      reasoning_effort: TIER_TO_EFFORT.simple,
      reason: `factory_scout_low_reasoning_reason:${scoutReason}`,
    };
  }

  if (isFactoryInternal(metadata)) {
    return {
      tier: 'normal',
      reasoning_effort: TIER_TO_EFFORT.normal,
      reason: 'factory_internal',
    };
  }

  if (isFactoryScout(metadata)) {
    return {
      tier: 'normal',
      reasoning_effort: TIER_TO_EFFORT.normal,
      reason: 'factory_scout',
    };
  }

  return {
    tier: 'complex',
    reasoning_effort: null,
    reason: 'no_override_user_default',
  };
}

module.exports = {
  classifyReasoningEffort,
  // Exposed for tests:
  _internal: { isShellExecuteOnly, parseTaskMetadata, TIER_TO_EFFORT, VALID_EFFORT_VALUES },
};
