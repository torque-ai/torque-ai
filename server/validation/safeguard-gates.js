'use strict';

/**
 * LLM output safeguard gates — Phase 2 of the close-handler sequence.
 *
 * Handles:
 *   - File quality and size regression checks
 *   - Placeholder/stub artifact detection
 *   - Scoped rollback on safeguard failure
 *   - Auto-retry on safeguard failure (if retries remain)
 *
 * Phase 2 of the universal-DI migration: this module exposes both shapes
 * during the transition.
 *   NEW (preferred): createSafeguardGates(deps) → { handleSafeguardChecks }
 *                    register(container) wires it into the DI container
 *   OLD (deprecated): module.exports.init(deps) + module.exports.handleSafeguardChecks
 *
 * The OLD shape is preserved while task-manager.js still hand-passes deps;
 * once task-manager.js migrates (Phase 3+), the OLD shape can be deleted.
 *
 * See docs/superpowers/specs/2026-05-04-universal-di-design.md.
 */

const logger = require('../logger').child({ component: 'safeguard-gates' });
const { buildResumeContext, prependResumeContextToPrompt } = require('../utils/resume-context');

/**
 * Factory shape — preferred for new code.
 * Closes over `deps` so there is no module-level mutable state.
 */
function createSafeguardGates(deps = {}) {
  function handleSafeguardChecks(ctx) {
    if (!deps?.db) return { approved: true, reason: 'No db available' };
    const { taskId, task, proc } = ctx;
    if (ctx.status !== 'completed' || !task) return;

    // Skip safeguard checks for Codex — it runs in its own sandbox with built-in
    // approval gates. Our safeguards (file-quality, size regression) are designed
    // for local LLM output and produce false failures on Codex tasks.
    if (task.provider === 'codex') return;

    // Skip safeguard checks for diffusion apply tasks — edits are pre-computed
    // and validated by the compute stage. Safeguards produce false positives on
    // documentation-only or additive changes (e.g., XML doc comments flagged as "stubs").
    try {
      const meta = task.metadata ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata) : {};
      if (meta.diffusion_role === 'apply') return;
    } catch (_) { /* non-fatal */ }

    const workingDir = task.working_directory || process.cwd();
    const projectConfig = deps.db.getProjectConfig(task.project || deps.db.getProjectFromPath(workingDir));
    const safeguardsEnabled = !projectConfig || projectConfig.llm_safeguards_enabled !== false;
    const actuallyModifiedFiles = deps.getActualModifiedFiles(workingDir) || [];

    if (!safeguardsEnabled) return;

    if (actuallyModifiedFiles.length > 0) {
      logger.info(`[Safeguard] Checking ${actuallyModifiedFiles.length} actually modified files: ${actuallyModifiedFiles.join(', ')}`);
    }

    const expectsGeneratedEdits = /\b(implement|build|create|wire|add|write|generate|make|edit|modify|update|fix)\b/i.test(task.task_description || '');
    const safeguardResult = deps.runLLMSafeguards(taskId, workingDir, actuallyModifiedFiles, {
      outputText: proc?.output || ctx.errorOutput || '',
      checkOutputMarkers: expectsGeneratedEdits,
    });
    if (safeguardResult.passed) return;

    logger.info(`[Safeguard] Task ${taskId} failed safeguard checks`);
    const safeguardArtifactFiles = safeguardResult.details?.placeholderArtifacts?.artifacts?.map(artifact => artifact.path) || [];
    const safeguardFiles = [...new Set([...actuallyModifiedFiles, ...safeguardArtifactFiles])];

    // Use dedicated safeguard rollback config if set, fall back to build failure config
    const rollbackOnSafeguard = projectConfig && (projectConfig.rollback_on_safeguard_failure ?? projectConfig.rollback_on_build_failure);
    if (rollbackOnSafeguard && safeguardFiles.length > 0) {
      const rollback = deps.scopedRollback(taskId, workingDir, 'SafeguardRollback');
      logger.info(`[Safeguard] Scoped rollback of ${rollback.reverted.length} file(s) for task ${taskId}`);
    }

    // Auto-retry safeguard failures if retries remain
    const retryCount = (task.retry_count || 0);
    const maxRetries = (task.max_retries || 0);
    if (retryCount < maxRetries) {
      logger.info(`[Safeguard] Auto-retrying task ${taskId} (attempt ${retryCount + 1}/${maxRetries}) after safeguard failure`);
      // Only roll back if the config-driven path above did not already do so.
      // Both paths call scopedRollback — git checkout is idempotent so a second
      // call is safe, but it generates redundant log noise and git work.
      if (safeguardFiles.length > 0 && !rollbackOnSafeguard) {
        deps.scopedRollback(taskId, workingDir, 'Safeguard P87');
      }

      ctx.errorOutput = (ctx.errorOutput || '') +
        '\n\n[LLM SAFEGUARD FAILED - AUTO-RETRY]\n' +
        safeguardResult.issues.join('\n');
      const resumeContext = buildResumeContext(ctx.output || proc?.output || task.output || '', ctx.errorOutput, {
        task_description: task.task_description,
        provider: task.provider,
        started_at: task.started_at,
        completed_at: new Date().toISOString(),
      });

      deps.taskCleanupGuard?.delete(taskId);

      deps.safeUpdateTaskStatus(taskId, 'queued', {
        error_output: ctx.errorOutput,
        retry_count: retryCount + 1,
        started_at: null,
        pid: null,
        progress_percent: 0,
        resume_context: resumeContext,
        task_description: prependResumeContextToPrompt(task.task_description, resumeContext),
      });
      if (deps.dashboard) deps.dashboard.notifyTaskUpdated(taskId);
      deps.processQueue();
      ctx.earlyExit = true;
      return;
    }

    // No retries left - mark as failed
    ctx.status = 'failed';
    ctx.errorOutput = (ctx.errorOutput || '') +
      '\n\n[LLM SAFEGUARD FAILED]\n' +
      safeguardResult.issues.join('\n');
  }

  return { handleSafeguardChecks };
}

/**
 * Register this service with a container. Phase 2+ consumers resolve
 * via `container.get('safeguardGates').handleSafeguardChecks`.
 *
 * Declared deps map directly to container service names; the migration
 * spec (Open Question Q-naming) standardized camelCase, no hyphens.
 *
 * `getActualModifiedFiles`, `runLLMSafeguards`, `scopedRollback`,
 * `safeUpdateTaskStatus`, `taskCleanupGuard`, `processQueue`,
 * `dashboard` — these are not yet registered as container services
 * (they live in task-manager.js or its sub-modules). Until those
 * migrate (Phase 3 — execution/), task-manager.js bridges them via
 * container.override(...) so this module can be the first migrated
 * citizen without waiting on its consumers.
 */
function register(container) {
  container.register(
    'safeguardGates',
    [
      'db',
      'dashboard',
      'getActualModifiedFiles',
      'runLLMSafeguards',
      'scopedRollback',
      'safeUpdateTaskStatus',
      'taskCleanupGuard',
      'processQueue',
    ],
    (deps) => createSafeguardGates(deps)
  );
}

// ── Legacy imperative shape (deprecated; remove when task-manager.js migrates) ──
let _legacyDeps = {};
let _legacyService = null;

/** @deprecated Use createSafeguardGates(deps) or container.get('safeguardGates'). */
function init(nextDeps = {}) {
  _legacyDeps = { ..._legacyDeps, ...nextDeps };
  _legacyService = createSafeguardGates(_legacyDeps);
}

/** @deprecated Use container.get('safeguardGates').handleSafeguardChecks. */
function handleSafeguardChecks(ctx) {
  if (!_legacyService) {
    // Fall back to a deps-less call so the no-db early return fires
    // gracefully if a consumer forgot to call init().
    return createSafeguardGates({}).handleSafeguardChecks(ctx);
  }
  return _legacyService.handleSafeguardChecks(ctx);
}

module.exports = {
  // New shape (preferred)
  createSafeguardGates,
  register,
  // Legacy shape (kept until task-manager.js is migrated; spec §3-5 path)
  init,
  handleSafeguardChecks,
};
