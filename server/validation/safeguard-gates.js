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
 * Container-resolved factory shape. Consumers call
 * `defaultContainer.get('safeguardGates').handleSafeguardChecks(ctx)`.
 * The factory resolves utility deps (runLLMSafeguards, scopedRollback)
 * via require() from validation/post-task and binds taskManager-owned
 * methods (getActualModifiedFiles, safeUpdateTaskStatus, processQueue)
 * via the registered taskManager handle.
 *
 * See docs/superpowers/specs/2026-05-04-universal-di-design.md.
 */

const logger = require('../logger').child({ component: 'safeguard-gates' });
const { buildResumeContext, prependResumeContextToPrompt } = require('../utils/resume-context');

/**
 * Factory shape — preferred for new code.
 * Closes over `deps` so there is no module-level mutable state.
 *
 * Utility deps (getActualModifiedFiles, runLLMSafeguards, scopedRollback)
 * resolve via require() from their canonical modules. taskManager-bound
 * methods (safeUpdateTaskStatus, processQueue) and the processTracker
 * cleanupGuard resolve via the container/taskManager handle. Test
 * fixtures with explicit overrides via `deps` still win.
 */
function createSafeguardGates(deps = {}) {
  deps = { ...deps };
  if (deps.runLLMSafeguards === undefined) {
    try { deps.runLLMSafeguards = require('./post-task').runLLMSafeguards; }
    catch { /* fall through */ }
  }
  if (deps.scopedRollback === undefined) {
    try { deps.scopedRollback = require('./post-task').scopedRollback; }
    catch { /* fall through */ }
  }
  const tm = deps.taskManager || null;
  const tmMethod = (name) => (tm && typeof tm[name] === 'function' ? tm[name].bind(tm) : null);
  if (deps.getActualModifiedFiles === undefined) deps.getActualModifiedFiles = tmMethod('getActualModifiedFiles');
  if (deps.safeUpdateTaskStatus === undefined) deps.safeUpdateTaskStatus = tmMethod('safeUpdateTaskStatus');
  if (deps.processQueue === undefined) deps.processQueue = tmMethod('processQueue');
  if (deps.taskCleanupGuard === undefined) {
    try {
      const { defaultContainer } = require('../container');
      const tracker = defaultContainer.peek('processTracker');
      if (tracker && tracker.cleanupGuard) deps.taskCleanupGuard = tracker.cleanupGuard;
    } catch { /* fall through */ }
  }

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
 * Legacy direct handler used by task-finalizer fallback paths.
 *
 * This must not require `defaultContainer.get('safeguardGates')`: if another
 * optional service breaks boot, finalization still needs safeguard checks to
 * degrade gracefully instead of converting successful provider output into a
 * failed task with "called before boot".
 */
function handleSafeguardChecks(ctx) {
  let containerDeps = {};
  try {
    const { defaultContainer } = require('../container');
    containerDeps = {
      db: defaultContainer.peek('db') || null,
      dashboard: defaultContainer.peek('dashboard') || null,
      taskManager: defaultContainer.peek('taskManager') || null,
    };
  } catch {
    containerDeps = {};
  }
  // Fallback: tests (and any code path that doesn't go through
  // server/index.js startup) won't have taskManager registered in
  // the container. require it directly so utility-method deps
  // (getActualModifiedFiles, safeUpdateTaskStatus, processQueue)
  // resolve. Production calls registerValue('taskManager') in
  // index.js:1117, so the peek above wins there.
  //
  // We do NOT fall back on `db` — when the container has no booted db
  // value, createSafeguardGates short-circuits with
  // {approved: true, reason: 'No db available'}, which is the
  // contract tested by safeguard-gates.test.js's "legacy direct handler
  // does not require a booted default container" case.
  if (!containerDeps.taskManager) {
    try { containerDeps.taskManager = require('../task-manager'); }
    catch { /* fall through with null taskManager */ }
  }
  return createSafeguardGates(containerDeps).handleSafeguardChecks(ctx);
}

/**
 * Register this service with a container. Consumers resolve via
 * `container.get('safeguardGates').handleSafeguardChecks`.
 *
 * Declared deps are the true container services [db, dashboard,
 * taskManager]; utility-fn deps are resolved via require() inside the
 * factory and taskManager-method deps bind from the taskManager handle.
 */
function register(container) {
  container.register(
    'safeguardGates',
    ['db', 'dashboard', 'taskManager'],
    (deps) => createSafeguardGates(deps)
  );
}

module.exports = {
  createSafeguardGates,
  handleSafeguardChecks,
  register,
};
