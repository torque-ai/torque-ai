'use strict';

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`Missing VERIFY stage dependency: ${name}`);
  }
}

function createVerifyStage({
  LOOP_STATES,
  awaitTaskToStructuredResult,
  baselineRequeue,
  branchFreshness,
  buildProviderLaneTaskMetadata,
  childProcess,
  createShippedDetector,
  detectDefaultBranch,
  eventBus,
  factoryDecisions,
  factoryHealth,
  factoryIntake,
  factoryWorktrees,
  fs,
  getEffectiveProjectProvider,
  getProjectOrThrow,
  getWorkItemDecisionContext,
  getWorktreeRunner,
  guardrailRunner,
  isProjectStatusPaused,
  listTasksForFactoryBatch,
  logger,
  resolveFactoryVerifyCommand,
  routeWorkItemToNeedsReplan,
  safeLogDecision,
} = {}) {
  assertFunction(awaitTaskToStructuredResult, 'awaitTaskToStructuredResult');
  assertFunction(branchFreshness?.checkBranchFreshness, 'branchFreshness.checkBranchFreshness');
  assertFunction(buildProviderLaneTaskMetadata, 'buildProviderLaneTaskMetadata');
  assertFunction(childProcess?.execFileSync, 'childProcess.execFileSync');
  assertFunction(createShippedDetector, 'createShippedDetector');
  assertFunction(detectDefaultBranch, 'detectDefaultBranch');
  assertFunction(factoryDecisions?.listDecisions, 'factoryDecisions.listDecisions');
  assertFunction(factoryHealth?.getProject, 'factoryHealth.getProject');
  assertFunction(factoryIntake?.getWorkItem, 'factoryIntake.getWorkItem');
  assertFunction(factoryWorktrees?.getActiveWorktree, 'factoryWorktrees.getActiveWorktree');
  assertFunction(fs?.existsSync, 'fs.existsSync');
  assertFunction(getEffectiveProjectProvider, 'getEffectiveProjectProvider');
  assertFunction(getProjectOrThrow, 'getProjectOrThrow');
  assertFunction(getWorkItemDecisionContext, 'getWorkItemDecisionContext');
  assertFunction(getWorktreeRunner, 'getWorktreeRunner');
  assertFunction(guardrailRunner?.runPostBatchChecks, 'guardrailRunner.runPostBatchChecks');
  assertFunction(isProjectStatusPaused, 'isProjectStatusPaused');
  assertFunction(listTasksForFactoryBatch, 'listTasksForFactoryBatch');
  assertFunction(resolveFactoryVerifyCommand, 'resolveFactoryVerifyCommand');
  assertFunction(routeWorkItemToNeedsReplan, 'routeWorkItemToNeedsReplan');
  assertFunction(safeLogDecision, 'safeLogDecision');

  function detectWorkItemShippedOnMain(project, workItem) {
    if (!project?.path || !workItem) {
      return null;
    }

    const planContent = workItem.origin?.plan_path && fs.existsSync(workItem.origin.plan_path)
      ? fs.readFileSync(workItem.origin.plan_path, 'utf8')
      : workItem.description || '';
    const detector = createShippedDetector({ repoRoot: project.path });
    return detector.detectShipped({ content: planContent, title: workItem.title });
  }

  function resolveVerifyEmptyBranch({
    project,
    project_id,
    instance,
    workItem,
    worktreeRecord,
    verifyResult,
    batch_id,
  }) {
    const resolvedWorkItem = instance?.work_item_id
      ? factoryIntake.getWorkItem(instance.work_item_id)
      : (workItem || null);
    const detection = detectWorkItemShippedOnMain(project, resolvedWorkItem);
    const outputPreview = String(
      verifyResult?.stderr
      || verifyResult?.output
      || verifyResult?.stdout
      || ''
    ).slice(-1500);
    const sharedOutcome = {
      work_item_id: resolvedWorkItem?.id || null,
      branch: worktreeRecord.branch,
      worktree_path: worktreeRecord.worktreePath,
      output_preview: outputPreview,
      detection: detection ? {
        shipped: detection.shipped,
        confidence: detection.confidence,
        signals: detection.signals,
      } : null,
    };

    if (resolvedWorkItem && detection?.shipped && detection.confidence !== 'low') {
      factoryIntake.updateWorkItem(resolvedWorkItem.id, { status: 'shipped' });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.VERIFY,
        action: 'verify_empty_branch_auto_shipped',
        reasoning: `VERIFY found no commits ahead for ${worktreeRecord.branch}, and shipped-detector matched existing work on main (${detection.confidence} confidence). Marking shipped instead of pausing.`,
        outcome: sharedOutcome,
        confidence: 1,
        batch_id,
      });
      return {
        status: 'shipped',
        reason: 'auto_shipped_empty_branch_at_verify',
        branch: worktreeRecord.branch,
        worktree_path: worktreeRecord.worktreePath,
      };
    }

    // Phase X4: route to needs_replan instead of terminal rejection. Same
    // reasoning as the LEARN-stage empty-branch path. routeWorkItemToNeedsReplan
    // persists the routing for its side effect; the immediate return below
    // carries the outcome to the caller.
    if (resolvedWorkItem?.id) {
      routeWorkItemToNeedsReplan(resolvedWorkItem, {
        reason: 'empty_branch_after_execute',
        details: { branch: worktreeRecord.branch, stage: 'VERIFY' },
      });
    }
    safeLogDecision({
      project_id,
      stage: LOOP_STATES.VERIFY,
      action: 'verify_empty_branch_routed_to_needs_replan',
      reasoning: `VERIFY found no commits ahead for ${worktreeRecord.branch}, and shipped-detector did not match existing work on main. Per the plan-evolution model, routing to needs_replan instead of terminal rejection (Phase X4) so the next architect attempt can produce a different plan.`,
      outcome: { ...sharedOutcome, next_status: 'needs_replan' },
      confidence: 1,
      batch_id,
    });
    return {
      status: 'needs_replan',
      reason: 'empty_branch_after_execute — routed to needs_replan',
      branch: worktreeRecord.branch,
      worktree_path: worktreeRecord.worktreePath,
    };
  }

  const MAX_AUTO_VERIFY_RETRIES = 3;
  // Fix 4: separate budget for transient submission failures (no_task_id,
  // submit_threw). These are not test failures — they're auto-router or
  // provider hiccups that may recover on a subsequent attempt. Capped low
  // so a persistent provider outage doesn't spin forever.
  const MAX_SUBMISSION_FAILURES = 2;
  const FATAL_SUBMISSION_REASONS = new Set(['cwd_missing']);

  // Retry counter persistence: count tasks tagged factory:verify_retry=N that
  // share this batch_id. executeVerifyStage uses this to seed its local
  // retryAttempt so re-entries (stall recovery, VERIFY_FAIL resume, dispatcher
  // dispatch) cannot reset the counter and cycle 1..3 again forever. Tags are
  // already written on every verify-retry submission, so there's no new schema
  // cost for this counter — the tasks table is the source of truth.
  function countPriorVerifyRetryTasksForBatch(batch_id) {
    if (!batch_id) return 0;
    try {
      const taskCore = require('../../db/task-core');
      const tasks = taskCore.listTasks({
        tags: [`factory:batch_id=${batch_id}`],
        limit: 200,
      });
      return tasks.filter((t) =>
        Array.isArray(t.tags)
        && t.tags.some((tag) => typeof tag === 'string' && tag.startsWith('factory:verify_retry=')),
      ).length;
    } catch {
      return 0;
    }
  }

  function stripAnsi(text) {
    const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    return typeof text === 'string'
      ? text.replace(ansiPattern, '')
      : '';
  }

  // The factory's verify-retry prompt feeds Codex the tail of the verify output
  // so it can fix the failure. 4000 chars was too narrow for typical pip / dotnet /
  // pytest failures: a full traceback + Python context easily evicts the actual
  // error line off the top of the window, leaving the retry to guess blind.
  // 16000 gives the root cause enough room alongside the traceback without
  // blowing past reasonable prompt budgets.
  const VERIFY_FIX_PROMPT_TAIL_BUDGET = 16000;

  const VERIFY_FIX_PROMPT_PRIOR_BUDGET = 1800;

  const VERIFY_RETRY_SCOPE_PATH_RE = /[A-Za-z0-9_./\\-]+\.(?:csproj|fsproj|vbproj|targets|props|tsx|jsx|cjs|mjs|yaml|yml|json|sql|xaml|axaml|xml|resx|psm1|ps1|sln|js|ts|py|cs|sh|md)/g;

  function normalizeScopeEnvelopePath(filePath) {
    return String(filePath || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '');
  }

  function extractScopeEnvelopeFiles(text) {
    const files = new Set();
    for (const match of String(text || '').matchAll(VERIFY_RETRY_SCOPE_PATH_RE)) {
      const normalized = normalizeScopeEnvelopePath(match[0]);
      if (normalized) {
        files.add(normalized);
      }
    }
    return Array.from(files);
  }

  function computeScopeEnvelope(planText, verifyOutput) {
    return new Set([
      ...extractScopeEnvelopeFiles(planText),
      ...extractScopeEnvelopeFiles(verifyOutput),
    ]);
  }

  function getScopeEnvelopeBasenames(scopeEnvelope) {
    const suffixes = new Set();
    for (const file of scopeEnvelope || []) {
      const normalized = normalizeScopeEnvelopePath(file);
      if (!normalized) continue;
      suffixes.add(normalized);

      const withoutRoot = normalized
        .replace(/^[A-Za-z]:\//, '')
        .replace(/^\/+/, '');
      if (withoutRoot) {
        suffixes.add(withoutRoot);
      }

      const basename = withoutRoot.split('/').filter(Boolean).pop();
      if (basename) {
        suffixes.add(basename);
      }
    }
    return Array.from(suffixes);
  }

  function isOutOfScope(diffFiles, scopeEnvelope) {
    const scopeEnvelopeBasenames = getScopeEnvelopeBasenames(scopeEnvelope);
    return (Array.isArray(diffFiles) ? diffFiles : []).filter((file) => {
      const normalized = normalizeScopeEnvelopePath(file);
      return normalized && !scopeEnvelopeBasenames.some((sb) => normalized.endsWith(sb));
    });
  }

  async function getVerifyRetryDiffFiles(workingDirectory) {
    if (!workingDirectory) return [];
    return new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      const finish = (files) => {
        if (settled) return;
        settled = true;
        resolve(files);
      };

      let child;
      try {
        child = childProcess.spawn('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
          cwd: workingDirectory,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
      } catch (_e) {
        finish([]);
        return;
      }

      child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
      child.on('error', () => finish([]));
      child.on('close', (code) => {
        if (code !== 0) return finish([]);
        finish(stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0));
      });
    });
  }

  function readPlanTextForScopeEnvelope(planPath, scopedLogger = logger) {
    if (!planPath) {
      scopedLogger?.debug?.({ plan_path: null }, 'verify retry scope envelope: no plan path; plan envelope empty');
      return '';
    }

    try {
      return fs.readFileSync(planPath, 'utf8');
    } catch (err) {
      scopedLogger?.debug?.(
        { err: err && err.message, plan_path: planPath },
        'verify retry scope envelope: unable to read plan file; plan envelope empty'
      );
      return '';
    }
  }

  async function enforceVerifyRetryScopeEnvelope({
    project_id,
    batch_id,
    workItemId,
    planPath,
    verifyOutput,
    worktreePath,
    attempt,
    branch,
    getDiffFiles = getVerifyRetryDiffFiles,
    logDecisionFn = safeLogDecision,
    rejectWorkItemUnactionableFn = factoryIntake.rejectWorkItemUnactionable,
    scopedLogger = logger,
  }) {
    const planText = readPlanTextForScopeEnvelope(planPath, scopedLogger);
    const scopeEnvelope = computeScopeEnvelope(planText, verifyOutput);
    let diffFiles = [];

    try {
      diffFiles = await getDiffFiles(worktreePath);
    } catch (err) {
      scopedLogger?.debug?.(
        { err: err && err.message, worktree_path: worktreePath },
        'verify retry scope envelope: unable to inspect retry diff; treating as empty diff'
      );
      diffFiles = [];
    }

    const offScopeFiles = isOutOfScope(diffFiles, scopeEnvelope);
    if (offScopeFiles.length === 0) {
      return { ok: true, diffFiles, scopeEnvelope };
    }

    logDecisionFn({
      project_id,
      batch_id,
      stage: LOOP_STATES.VERIFY,
      action: 'retry_off_scope',
      reasoning: 'Verify retry modified files outside the plan and verify stack-trace scope envelope.',
      inputs: { attempt, branch },
      outcome: {
        off_scope_files: offScopeFiles,
        envelope: Array.from(scopeEnvelope),
      },
      confidence: 1,
    });

    if (workItemId !== null && workItemId !== undefined && typeof rejectWorkItemUnactionableFn === 'function') {
      try {
        rejectWorkItemUnactionableFn(workItemId, 'retry_off_scope');
      } catch (err) {
        scopedLogger?.warn?.(
          { err: err && err.message, work_item_id: workItemId },
          'verify retry scope envelope: failed to mark work item unactionable'
        );
      }
    }

    return {
      ok: false,
      reason: 'retry_off_scope',
      diffFiles,
      offScopeFiles,
      scopeEnvelope,
    };
  }

  function renderFilesTouched(files, file_count) {
    const arr = Array.isArray(files) ? files : [];
    if (arr.length === 0) return 'none';
    const head = arr.slice(0, 5).join(', ');
    const extra = file_count > 5 ? ` (+${file_count - 5} more)` : '';
    return `${head}${extra}`;
  }

  function renderAttempt(a, labelNumber) {
    const verifyRetryIdx = labelNumber == null ? '' : ` (verify retry #${labelNumber})`;
    const kindLabel = a.kind === 'verify_retry' ? `verify_retry${verifyRetryIdx}` : 'execute';
    const head = `- Attempt ${a.attempt} (${kindLabel}): ${a.file_count} files touched`;
    const filesPart = a.file_count > 0 ? ` — ${renderFilesTouched(a.files_touched, a.file_count)}.` : '';
    const classified = a.file_count === 0 && a.zero_diff_reason
      ? ` — classified as \`${a.zero_diff_reason}\`.`
      : '.';
    const summary = String(a.stdout_tail || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const summaryLine = summary ? `\n  Codex summary: "${summary}"` : '';
    return `${head}${filesPart}${classified}${summaryLine}`;
  }

  function renderProgression(prevOutput, currOutput) {
    try {
      const { extractFailingTestNames } = require('../verify-signature');
      const prev = extractFailingTestNames(prevOutput);
      const curr = extractFailingTestNames(currOutput);
      if (prev.length === 0 && curr.length === 0) return null;

      const prevSet = new Set(prev);
      const currSet = new Set(curr);
      const newlyPassing = prev.filter((n) => !currSet.has(n));
      const newlyFailing = curr.filter((n) => !prevSet.has(n));

      const lines = ['Verify error progression:'];
      lines.push(`- Previous run failed with: ${prev.length} failure${prev.length === 1 ? '' : 's'}${prev.length ? ` ("${prev.slice(0, 3).join('", "')}"${prev.length > 3 ? ', …' : ''})` : ''}`);
      lines.push(`- This run is failing with: ${curr.length} failure${curr.length === 1 ? '' : 's'}${curr.length ? ` ("${curr.slice(0, 3).join('", "')}"${curr.length > 3 ? ', …' : ''})` : ''}`);
      let verdict;
      if (newlyPassing.length > 0 && newlyFailing.length === 0) {
        verdict = `  → Partial progress. ${newlyPassing.length} test${newlyPassing.length === 1 ? '' : 's'} now passing. Keep current approach.`;
      } else if (newlyFailing.length > 0 && newlyPassing.length === 0) {
        verdict = `  → New failures introduced. Consider reverting part of last attempt.`;
      } else if (newlyPassing.length === 0 && newlyFailing.length === 0 && prev.length > 0) {
        verdict = `  → Same failures. Previous approach did not move the needle; try a different angle.`;
      } else if (newlyPassing.length > 0 && newlyFailing.length > 0) {
        verdict = `  → Mixed: ${newlyPassing.length} newly passing, ${newlyFailing.length} newly failing.`;
      } else {
        verdict = `  → No comparable change.`;
      }
      lines.push(verdict);
      return lines.join('\n');
    } catch {
      return null;
    }
  }

  function buildPriorAttemptsBlock(priorAttempts, verifyOutputPrev, verifyOutput) {
    const attempts = Array.isArray(priorAttempts) ? [...priorAttempts] : [];
    if (attempts.length === 0) return null;

    attempts.sort((a, b) => a.attempt - b.attempt);

    let verifyRetryIdx = 0;
    const rendered = attempts.map((a) => {
      if (a.kind === 'verify_retry') {
        verifyRetryIdx += 1;
        return renderAttempt(a, verifyRetryIdx);
      }
      return renderAttempt(a, null);
    });

    let elidedCount = 0;
    let block = `Prior attempts on this work item:\n${rendered.join('\n')}`;
    while (block.length > VERIFY_FIX_PROMPT_PRIOR_BUDGET && rendered.length > 1) {
      rendered.shift();
      elidedCount += 1;
      block = `Prior attempts on this work item:\n(${elidedCount} earlier attempt${elidedCount === 1 ? '' : 's'} elided)\n${rendered.join('\n')}`;
    }

    const progression = renderProgression(verifyOutputPrev, verifyOutput);
    if (progression) block += `\n\n${progression}`;

    return block;
  }

  function isFactoryFeatureEnabled(project_id, flagKey) {
    try {
      const project = factoryHealth.getProject(project_id);
      const raw = project && (project.config_json || project.config);
      const cfg = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      return Boolean(cfg && cfg.feature_flags && cfg.feature_flags[flagKey]);
    } catch {
      return false;
    }
  }

  async function maybeShipNoop({ project_id, batch_id, work_item_id }) {
    // Observability-only path: never let an error here propagate into the
    // EXECUTE -> VERIFY transition. If attempt-history is unreachable
    // (missing schema, closed db, etc.) treat it as "no prior row" and
    // fall through to today's behavior.
    const attemptHistory = require('../../db/factory-attempt-history');
    let latest;
    try {
      latest = attemptHistory.getLatestForBatch(batch_id);
    } catch (err) {
      logger.debug('maybeShipNoop: getLatestForBatch threw; treating as no prior row', {
        err: err && err.message, batch_id,
      });
      return { shipped_as_noop: false };
    }
    if (!latest) return { shipped_as_noop: false };

    const reason = latest.zero_diff_reason;
    const conf = latest.classifier_conf == null ? 0 : latest.classifier_conf;

    if (reason === 'already_in_place' && conf >= 0.8) {
      if (!isFactoryFeatureEnabled(project_id, 'auto_ship_noop_enabled')) {
        return { shipped_as_noop: false, reason: 'flag_off' };
      }
      const paused_reason = 'already_in_place_review_required';
      safeLogDecision({
        project_id, batch_id, stage: LOOP_STATES.EXECUTE,
        action: 'paused_at_gate',
        reasoning: 'Codex reported the change was already in place; pausing EXECUTE for operator review instead of skipping VERIFY.',
        outcome: {
          work_item_id,
          paused_stage: 'EXECUTE',
          paused_reason,
          classifier_source: latest.classifier_source,
          classifier_conf: conf,
          stdout_tail_preview: String(latest.stdout_tail || '').slice(0, 400),
        },
        confidence: 1,
      });
      return { shipped_as_noop: false, paused: true, paused_reason };
    }

    if ((reason === 'blocked' || reason === 'precondition_missing') && conf >= 0.8) {
      if (!isFactoryFeatureEnabled(project_id, 'auto_ship_noop_enabled')) {
        return { shipped_as_noop: false, reason: 'flag_off' };
      }
      const paused_reason = reason === 'blocked' ? 'blocked_by_codex' : 'precondition_missing';
      safeLogDecision({
        project_id, batch_id, stage: LOOP_STATES.EXECUTE,
        action: 'paused_at_gate',
        reasoning: `Codex reported ${reason}; pausing EXECUTE gate for operator review.`,
        outcome: {
          work_item_id,
          paused_stage: 'EXECUTE',
          paused_reason,
          classifier_conf: conf,
          stdout_tail_preview: String(latest.stdout_tail || '').slice(0, 400),
        },
        confidence: 1,
      });
      return { shipped_as_noop: false, paused: true, paused_reason };
    }

    if (!reason || reason === 'unknown' || conf < 0.8) {
      if (!isFactoryFeatureEnabled(project_id, 'auto_ship_noop_enabled')) {
        return { shipped_as_noop: false, reason: 'flag_off' };
      }
      const paused_reason = conf < 0.8
        ? 'low_confidence_zero_diff_review_required'
        : 'unknown_zero_diff_review_required';
      safeLogDecision({
        project_id, batch_id, stage: LOOP_STATES.EXECUTE,
        action: 'paused_at_gate',
        reasoning: 'Factory could not classify a zero-diff EXECUTE result confidently; pausing for operator review instead of treating the clean branch as progress.',
        outcome: {
          work_item_id,
          paused_stage: 'EXECUTE',
          paused_reason,
          zero_diff_reason: reason || null,
          classifier_source: latest.classifier_source,
          classifier_conf: conf,
          stdout_tail_preview: String(latest.stdout_tail || '').slice(0, 400),
        },
        confidence: 1,
      });
      return { shipped_as_noop: false, paused: true, paused_reason };
    }

    return { shipped_as_noop: false };
  }

  const ZERO_DIFF_SHORT_CIRCUIT_THRESHOLD = 2;

  function countConsecutiveAutoCommitSkippedClean(project_id, batch_id, { limit = 20 } = {}) {
    if (!project_id || !batch_id) return 0;
    const recent = factoryDecisions.listDecisions(project_id, {
      stage: LOOP_STATES.EXECUTE.toLowerCase(),
      limit,
    }) || [];
    let consecutiveClean = 0;
    for (const decision of recent.filter((d) => d.batch_id === batch_id)) {
      if (decision.action !== 'auto_commit_skipped_clean') {
        break;
      }
      consecutiveClean += 1;
    }
    return consecutiveClean;
  }

  /**
   * Check whether this batch has already produced at least one real commit
   * (auto_committed_task decision). Used by the zero-diff short-circuit to
   * distinguish "work item is unactionable" (no diff was ever produced) from
   * "work item already shipped its diff and subsequent retries are no-ops"
   * (multi-task plan where the first task covered the goal, or a verify-
   * retry that found nothing more to fix).
   *
   * Live evidence 2026-04-29: example-project work item #2097's first EXECUTE
   * attempt landed commit 507350f at 22:47:48 (qwen3-coder:30b wrote a
   * real C# test). Two follow-up retries at 22:51:36 and 22:51:47 no-opped
   * because the work was already done, then the zero-diff short-circuit
   * rejected the work item — even though the code had landed cleanly. The
   * factory's bookkeeping treated "retries had no diff" as failure when
   * the truth was "first attempt succeeded so well there was nothing left
   * for retries to do."
   */
  function batchHasAutoCommittedTask(project_id, batch_id, { limit = 50 } = {}) {
    if (!project_id || !batch_id) return false;
    const recent = factoryDecisions.listDecisions(project_id, {
      stage: LOOP_STATES.EXECUTE.toLowerCase(),
      limit,
    }) || [];
    return recent.some((d) => d.batch_id === batch_id && d.action === 'auto_committed_task');
  }

  /**
   * Detect when an EXECUTE batch's branch has commits ahead of its base ref.
   *
   * 2026-05-03 (bitsy WI 470 fix): Phase E's batchHasAutoCommittedTask only
   * advances the loop when the FACTORY's auto-commit logic logged an
   * auto_committed_task decision (worktree had dirty state, factory captured
   * it). It misses the case where a coding agent (claude-cli, codex) commits
   * its own work via `git commit` inside the plan task. In that path no
   * auto_committed_task decision fires — the worktree is clean BECAUSE the
   * agent already committed, not because no work was done.
   *
   * Live evidence: bitsy work item #470 ("Add type stubs and py.typed
   * marker"). Codex generated a 4-task plan; claude-cli executed each task
   * and committed inside the worktree (3f2ecf5, 2e69d25, 43a6cd3, e355132 —
   * 337 lines, py.typed marker + 4 .pyi stubs + pyproject package-data + 2
   * mypy-running tests). After 4 auto_commit_skipped_clean decisions (each
   * meaning "agent committed cleanly, factory had nothing extra to
   * auto-commit"), the short-circuit fired and marked WI 470 unactionable
   * with reason zero_diff_across_retries — even though the work had landed
   * cleanly on the feature branch. Operator manually merged feat/factory-470
   * to bitsy main as 350ccad to recover the work.
   *
   * This helper closes the gap by asking git directly: does the active
   * worktree's branch have any commits the merge target doesn't have? If
   * yes, the no-op cleans are benign — agent self-commits did the work.
   *
   * Designed to be safe-by-default: any failure (no worktree row, no base
   * branch recorded, git error, missing repo) returns false so the existing
   * unactionable path still runs. We never advance VERIFY on speculation —
   * only on positive evidence of commits ahead.
   */
  function batchBranchHasCommitsAhead(project_id, batch_id) {
    if (!project_id || !batch_id) return false;
    let row;
    try {
      row = factoryWorktrees.getActiveWorktreeByBatch(batch_id);
    } catch (error) {
      logger.debug('batchBranchHasCommitsAhead: getActiveWorktreeByBatch threw', {
        project_id, batch_id, err: error?.message,
      });
      return false;
    }
    if (!row) return false;
    const worktreePath = row.worktreePath || row.worktree_path;
    const baseBranch = row.baseBranch || row.base_branch;
    if (!worktreePath || !baseBranch) return false;
    try {
      const out = childProcess.execFileSync('git', [
        'rev-list', '--count', `${baseBranch}..HEAD`,
      ], {
        cwd: worktreePath,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const count = Number.parseInt(String(out || '').trim(), 10);
      return Number.isFinite(count) && count > 0;
    } catch (error) {
      logger.debug('batchBranchHasCommitsAhead: git rev-list threw', {
        project_id, batch_id, worktree_path: worktreePath,
        base_branch: baseBranch, err: error?.message,
      });
      return false;
    }
  }

  function maybeShortCircuitZeroDiffExecute({ project, instance, workItem, batchId }) {
    if (!project?.id || !workItem?.id || !batchId) return null;
    const zeroDiffAttempts = countConsecutiveAutoCommitSkippedClean(project.id, batchId);
    if (zeroDiffAttempts < ZERO_DIFF_SHORT_CIRCUIT_THRESHOLD) return null;

    // Phase E (2026-04-29 example-project #2097 fix): if the batch already produced a
    // real commit earlier, the no-op retries are benign — the work landed on
    // an earlier attempt and subsequent plan tasks or verify-retries had
    // nothing more to do. Don't reject; signal "EXECUTE done, advance to
    // VERIFY" so the test that was just written gets validated.
    if (batchHasAutoCommittedTask(project.id, batchId)) {
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'execute_completed_after_no_op_retries',
        reasoning: `Batch produced a real commit earlier (auto_committed_task); ${zeroDiffAttempts} subsequent no-op retries are benign. Advancing to VERIFY instead of rejecting the work item.`,
        inputs: {
          ...getWorkItemDecisionContext(workItem),
          zero_diff_attempts: zeroDiffAttempts,
        },
        outcome: {
          work_item_id: workItem.id,
          instance_id: instance?.id || null,
          zero_diff_attempts: zeroDiffAttempts,
          next_state: LOOP_STATES.VERIFY,
        },
        confidence: 1,
        batch_id: batchId,
      });
      return {
        reason: 'execute_completed_after_no_op_retries',
        work_item: workItem,
        advance_to_verify: true,
        stage_result: {
          status: 'completed',
          reason: 'execute_completed_after_no_op_retries',
          zero_diff_attempts: zeroDiffAttempts,
        },
      };
    }

    // 2026-05-03 (bitsy WI 470 fix): Phase E only catches factory-driven
    // auto_committed_task decisions. When a coding agent commits via its
    // own git tooling, no auto_committed_task fires but the branch still
    // has commits ahead of master. Ask git directly before rejecting so
    // we don't lose real work.
    if (batchBranchHasCommitsAhead(project.id, batchId)) {
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'execute_completed_with_agent_self_commits',
        reasoning: `Batch branch has commits ahead of base ref despite ${zeroDiffAttempts} consecutive auto_commit_skipped_clean — coding agent committed via its own git tooling. Advancing to VERIFY.`,
        inputs: {
          ...getWorkItemDecisionContext(workItem),
          zero_diff_attempts: zeroDiffAttempts,
        },
        outcome: {
          work_item_id: workItem.id,
          instance_id: instance?.id || null,
          zero_diff_attempts: zeroDiffAttempts,
          next_state: LOOP_STATES.VERIFY,
        },
        confidence: 1,
        batch_id: batchId,
      });
      return {
        reason: 'execute_completed_with_agent_self_commits',
        work_item: workItem,
        advance_to_verify: true,
        stage_result: {
          status: 'completed',
          reason: 'execute_completed_with_agent_self_commits',
          zero_diff_attempts: zeroDiffAttempts,
        },
      };
    }

    let updatedWorkItem = workItem;
    try {
      updatedWorkItem = factoryIntake.rejectWorkItemUnactionable(workItem.id, 'zero_diff_across_retries');
    } catch (err) {
      logger.warn('EXECUTE zero-diff short-circuit: failed to mark work item unactionable', {
        project_id: project.id,
        work_item_id: workItem.id,
        error: err.message,
      });
    }

    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'execute_zero_diff_short_circuit',
      reasoning: `Work item produced ${zeroDiffAttempts} consecutive zero-diff executes; skipping VERIFY and marking it unactionable.`,
      inputs: {
        ...getWorkItemDecisionContext(workItem),
        zero_diff_attempts: zeroDiffAttempts,
      },
      outcome: {
        work_item_id: workItem.id,
        instance_id: instance?.id || null,
        reject_reason: 'zero_diff_across_retries',
        zero_diff_attempts: zeroDiffAttempts,
        next_state: LOOP_STATES.IDLE,
      },
      confidence: 1,
      batch_id: batchId,
    });

    return {
      reason: 'zero_diff_across_retries',
      work_item: updatedWorkItem,
      stage_result: {
        status: 'unactionable',
        reason: 'zero_diff_across_retries',
        zero_diff_attempts: zeroDiffAttempts,
      },
    };
  }

  async function attemptSilentRerun({
    project_id, batch_id, instance_id,
    priorVerifyOutput, runVerify,
  }) {
    const { verifySignature } = require('../verify-signature');
    const instances = require('../../db/factory-loop-instances');

    if (!isFactoryFeatureEnabled(project_id, 'verify_silent_rerun_enabled')) {
      return { kind: 'flag_off' };
    }
    // Same defensive posture as maybeShipNoop: never let observability
    // infrastructure errors (closed db, missing column) stop the loop.
    // Any read failure is treated as "budget exhausted" so we fall
    // through to the existing fix-task retry path.
    try {
      if (instances.getVerifySilentReruns(instance_id) > 0) {
        return { kind: 'budget_exhausted' };
      }
    } catch (err) {
      logger.debug('attemptSilentRerun: getVerifySilentReruns threw; skipping silent rerun', {
        err: err && err.message, instance_id,
      });
      return { kind: 'flag_off' };
    }

    instances.bumpVerifySilentReruns(instance_id);

    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.VERIFY,
      action: 'verify_silent_rerun_started',
      reasoning: 'Classifier was ambiguous; rerunning verify silently before spending a Codex retry slot.',
      outcome: { instance_id },
      confidence: 1,
    });

    let verifyResult;
    try {
      verifyResult = await runVerify();
    } catch (err) {
      safeLogDecision({
        project_id, batch_id, stage: LOOP_STATES.VERIFY,
        action: 'verify_silent_rerun_failed',
        reasoning: `Silent rerun error: ${err.message}`,
        outcome: { instance_id, error: err.message },
        confidence: 1,
      });
      return { kind: 'rerun_failed', error: err.message };
    }

    if (verifyResult.exitCode === 0) {
      safeLogDecision({
        project_id, batch_id, stage: LOOP_STATES.VERIFY,
        action: 'verify_passed_on_silent_rerun',
        reasoning: 'Silent rerun passed; advancing without spending a Codex retry.',
        outcome: { instance_id },
        confidence: 1,
      });
      return { kind: 'passed', output: verifyResult.output };
    }

    const prevSig = verifySignature(priorVerifyOutput);
    const currSig = verifySignature(verifyResult.output);

    if (prevSig && currSig && prevSig === currSig) {
      safeLogDecision({
        project_id, batch_id, stage: LOOP_STATES.VERIFY,
        action: 'verify_rerun_same_failure',
        reasoning: 'Silent rerun produced the same failure signature; falling through to fix-task retry.',
        outcome: { instance_id, signature: currSig },
        confidence: 1,
      });
      return { kind: 'same_failure', output: verifyResult.output };
    }

    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.VERIFY,
      action: 'verify_rerun_different_failure',
      reasoning: 'Silent rerun produced a different failure signature; passing both to the fix task.',
      outcome: { instance_id, prev_sig: prevSig, curr_sig: currSig },
      confidence: 1,
    });
    return {
      kind: 'different_failure',
      output: verifyResult.output,
      combinedOutput: `${priorVerifyOutput}\n---\n${verifyResult.output}`,
    };
  }

  // Phase X8 (2026-05-02): test-stack detection for verify-fix prompt.
  // Generic verify-fix guidance is too vague for ollama (qwen3-coder:30b) on
  // dotnet projects: it tries broad refactors instead of reading the failing
  // test source to find the specific assert. This helper identifies the
  // stack from the verify command + output so buildVerifyFixPrompt can
  // append targeted, stack-aware instructions.
  function detectVerifyStack({ verifyCommand, verifyOutput }) {
    const cmd = String(verifyCommand || '').toLowerCase();
    const out = String(verifyOutput || '');

    if (
      /\bdotnet\s+test\b/.test(cmd)
      || /\bAssert\.(That|AreEqual|IsTrue|IsFalse|IsNull|NotNull|Throws)\b/.test(out)
      || /\bExpected:.*\n\s*But was:/m.test(out)
      || /\bNUnit\b|\bxUnit\b|\bMicrosoft\.NET\.Test\.Sdk\b/.test(out)
      || /\bTest\s+(?:Run|Assembly)\s+Failed\b/i.test(out)
    ) return 'dotnet';

    if (/\bpytest\b|\bpython\s+-m\s+pytest\b/.test(cmd) || /\bAssertionError\b/.test(out)) {
      return 'pytest';
    }

    if (/\bvitest\b|\bjest\b|\bnpm\s+(?:run\s+)?test\b/.test(cmd)) {
      return 'jstest';
    }

    return null;
  }

  const DOTNET_VERIFY_FIX_GUIDANCE = [
    '',
    '---',
    'Dotnet test guidance (this verify uses dotnet test):',
    '- Identify the FIRST failing test in the verify output. Look for `Failed!` summary lines and the `Expected:` / `But was:` lines just above them.',
    '- Use `read_file` to open the failing test file FIRST, not the production code. The test\'s assert tells you what behavior the production code must satisfy.',
    '- Then use `read_file` on the production file mentioned in the test\'s arrange/act block.',
    '- Make the SMALLEST change that turns the assert green — usually a one-line patch in the production code (return value, branch, missing case).',
    '- For NUnit/xUnit: an `Assert.Throws<T>` failure usually means the production code throws a different exception type — fix the throw type, do not catch & rethrow.',
    '- For `Expected: not equal to <X>` / `But was: <X>` failures: the production code is returning the SAME thing as the unwanted value — change the production code, not the test.',
    '- If the failing test references a public enum member that doesn\'t exist (e.g. `StartupFailureReason.LanSocketSendFailed`), add the missing enum member to the production enum file. Enums need members listed in source order — append new members at the end of the enum body.',
    '- If a classifier / mapper method is missing a case, the test usually looks like `Assert.That(Classify(input), Is.EqualTo(expectedReason))`. Read the existing `Classify` method, add the missing case for `input`, return `expectedReason`.',
    '- Do NOT run `dotnet test` yourself; the host will re-run verify after your edits.',
  ].join('\n');

  const PYTEST_VERIFY_FIX_GUIDANCE = [
    '',
    '---',
    'Pytest guidance (this verify uses pytest):',
    '- Find the failing test in the verify output (look for `FAILED` lines and the `AssertionError` / `assert <expr>` line).',
    '- Read the failing test source first to understand what behavior is being asserted.',
    '- Most pytest failures mean the production code returns a value that differs from the assert — patch the production code to match the assert\'s expectation, unless the test is clearly out of date.',
    '- Do NOT run `pytest` yourself; the host will re-run verify after your edits.',
  ].join('\n');

  const JSTEST_VERIFY_FIX_GUIDANCE = [
    '',
    '---',
    'JS test guidance (this verify uses vitest/jest/npm test):',
    '- Find the failing test (look for `FAIL` file lines, `expect(...).toBe(...)` mismatches with `Expected:` / `Received:`).',
    '- Read the failing test source first; the assert is the spec.',
    '- Most failures mean the production code\'s return value differs from `expect(...)`. Patch the production code unless the test is clearly out of date.',
    '- Do NOT run `vitest` / `jest` / `npm test` yourself; the host will re-run verify after your edits.',
  ].join('\n');

  function getVerifyStackGuidance(stack) {
    if (stack === 'dotnet') return DOTNET_VERIFY_FIX_GUIDANCE;
    if (stack === 'pytest') return PYTEST_VERIFY_FIX_GUIDANCE;
    if (stack === 'jstest') return JSTEST_VERIFY_FIX_GUIDANCE;
    return '';
  }

  function buildVerifyFixPrompt({
    planPath, planTitle, branch, verifyCommand, verifyOutput,
    priorAttempts, verifyOutputPrev,
  }) {
    const tail = stripAnsi(String(verifyOutput || '')).slice(-VERIFY_FIX_PROMPT_TAIL_BUDGET);
    const priorBlock = buildPriorAttemptsBlock(priorAttempts, verifyOutputPrev, verifyOutput);
    const stack = detectVerifyStack({ verifyCommand, verifyOutput });
    const stackGuidance = getVerifyStackGuidance(stack);
    const lines = [
      `Plan: ${planTitle || '(unknown)'}`,
      planPath ? `Plan path: ${planPath}` : null,
      `Factory branch: ${branch}`,
      `Verify command: ${verifyCommand}`,
      '',
      'The plan tasks for this batch were implemented, but the verify step failed. Read the error output below and make the minimum changes needed to turn the failures green. Common issues: a test that references a module the plan forgot to update, an alignment/invariant test that needs the new entry registered, a stale snapshot, a missing import, a type mismatch, or a lint rule violation.',
      '',
      priorBlock,
      priorBlock ? '' : null,
      'Constraints:',
      '- Edit only files in this worktree.',
      '- Do NOT revert the plan\'s intended changes — fix forward.',
      '- Prefer updating the failing test assertions ONLY if the plan is clearly the authoritative spec and the test is out of date. Otherwise update the production code so the test passes.',
      '- Do not run the full verify suite yourself. Targeted re-runs of the specific failing file are fine.',
      '',
      'Verify output (tail):',
      '```',
      tail,
      '```',
      '',
      'SCOPE ENVELOPE — you MUST obey these file rules:',
      '- Modify ONLY files that appear in either:',
      '    (a) the plan\'s task list (the \'plan file\' block above), OR',
      '    (b) filenames that appear in the verify error stack trace (the \'verify output tail\' above).',
      '- Do NOT create new files unless a new file is explicitly named in the plan.',
      '- If you believe no code fix is warranted (the failing test is broken, the baseline is wrong, or the diff is unrelated), exit with no changes. Do NOT add unrelated refactors, cleanup, or new features.',
      stackGuidance || null,
      '',
      'After making the edits, stop.',
    ].filter((x) => x !== null && x !== undefined);
    return lines.join('\n');
  }

  async function submitVerifyFixTask({
    project_id,
    batch_id,
    worktreeRecord,
    workItem,
    verifyCommand,
    verifyOutput,
    attempt,
    forceProvider = null,
  }) {
    const { handleSmartSubmitTask } = require('../../handlers/integration/routing');
    const { handleAwaitTask } = require('../../handlers/workflow/await');
    const taskCore = require('../../db/task-core');

    // Fix 6: short-circuit when the worktree directory does not exist on disk.
    // Without this guard, smart_submit_task fails with INTERNAL_ERROR
    // ("working_directory does not exist") which the retry loop misclassifies
    // as a generic "no_task_id" failure. By detecting cwd_missing here we
    // surface a precise reason and avoid wasting a retry attempt against a
    // path that won't reappear by retrying.
    //
    // Dark-factory recovery: before giving up, attempt to recreate the
    // worktree from the existing branch (git objects still hold the commits
    // even when the worktree dir was deleted). If the branch also vanished,
    // the work is unrecoverable — auto-reject so the loop moves on instead
    // of pausing for operator intervention.
    if (worktreeRecord?.worktreePath && !fs.existsSync(worktreeRecord.worktreePath)) {
      const projectForRecovery = factoryHealth.getProject(project_id);
      const repoPath = projectForRecovery?.path;
      const branch = worktreeRecord.branch;
      const worktreePath = worktreeRecord.worktreePath;

      // Probe whether the branch still exists locally.
      let branchExists = false;
      if (repoPath && branch) {
        try {
          const { execFileSync } = require('child_process');
          execFileSync('git', ['show-ref', '--verify', `refs/heads/${branch}`], {
            cwd: repoPath,
            stdio: 'ignore',
            windowsHide: true,
            timeout: 5000,
          });
          branchExists = true;
        } catch (_probeErr) { void _probeErr; }
      }

      // Fallback: local branch gone, but origin may still have the commits
      // (e.g. verify pushed them and a later cleanup pass deleted the local
      // branch). Recreate the local branch from origin/<branch> before we
      // give up as "worktree_lost".
      if (!branchExists && repoPath && branch) {
        try {
          const { execFileSync } = require('child_process');
          execFileSync('git', ['show-ref', '--verify', `refs/remotes/origin/${branch}`], {
            cwd: repoPath,
            stdio: 'ignore',
            windowsHide: true,
            timeout: 5000,
          });
          execFileSync('git', ['branch', branch, `origin/${branch}`], {
            cwd: repoPath,
            stdio: 'ignore',
            windowsHide: true,
            timeout: 10000,
          });
          branchExists = true;
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'verify_retry_branch_recreated_from_origin',
            reasoning: `Local branch ${branch} was missing but origin had it. Recreated local branch from origin/${branch} to preserve pushed work.`,
            outcome: { attempt, branch, worktree_path: worktreePath },
            confidence: 1,
            batch_id,
          });
        } catch (_probeErr) { void _probeErr; }
      }

      if (branchExists) {
        try {
          const { execFileSync } = require('child_process');
          const pathMod = require('path');
          fs.mkdirSync(pathMod.dirname(worktreePath), { recursive: true });
          // Prune first — a stale entry in .git/worktrees may still claim
          // ownership even though the directory is gone.
          try { execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, windowsHide: true, timeout: 10000 }); } catch (_e) { void _e; }
          // `worktree add <path> <branch>` (no -b) attaches an existing branch.
          execFileSync('git', ['worktree', 'add', worktreePath, branch], {
            cwd: repoPath,
            windowsHide: true,
            timeout: 30000,
          });
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'verify_retry_worktree_recovered',
            reasoning: `Worktree directory vanished mid-verify; recovered by re-attaching branch ${branch} at ${worktreePath}. Proceeding with retry.`,
            outcome: { attempt, branch, worktree_path: worktreePath },
            confidence: 1,
            batch_id,
          });
          // Fall through to the normal submission path — the worktree is live again.
        } catch (recoverErr) {
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'verify_retry_worktree_recovery_failed',
            reasoning: `Worktree recovery attempt failed: ${recoverErr.message}. Returning cwd_missing for operator triage.`,
            outcome: { attempt, branch, worktree_path: worktreePath, error: recoverErr.message },
            confidence: 1,
            batch_id,
          });
          return {
            submitted: false,
            reason: 'cwd_missing',
            error: `worktree directory missing and recovery failed: ${recoverErr.message}`,
          };
        }
      } else {
        // Branch also gone — the work is unrecoverable. Auto-reject so the
        // loop moves on instead of pausing for operator.
        try {
          factoryIntake.updateWorkItem(workItem.id, {
            status: 'rejected',
            reject_reason: 'worktree_and_branch_lost_during_verify',
          });
        } catch (rejectErr) {
          logger.warn('verify-recovery: updateWorkItem failed', {
            project_id, work_item_id: workItem?.id, err: rejectErr.message,
          });
        }
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'auto_rejected_worktree_lost',
          reasoning: `Both worktree directory and branch ${branch} vanished mid-verify. Work is unrecoverable — auto-rejecting item so loop advances.`,
          outcome: {
            attempt,
            branch,
            worktree_path: worktreePath,
            work_item_id: workItem?.id ?? null,
            next_state: LOOP_STATES.IDLE,
          },
          confidence: 1,
          batch_id,
        });
        return {
          submitted: false,
          reason: 'worktree_lost',
          error: `worktree directory and branch ${branch} both missing — auto-rejected`,
          auto_rejected: true,
        };
      }
    }

    const project = factoryHealth.getProject(project_id);
    const planPath = workItem?.origin?.plan_path || null;
    const planTitle = workItem?.title || workItem?.origin?.title || null;

    const attemptHistory = require('../../db/factory-attempt-history');
    const workItemIdStr = String((workItem && workItem.id) || '');
    // Defensive read — if attempt-history is unreachable, the retry
    // prompt just falls back to today's shape (no prior-attempts block).
    let priorAttempts = [];
    if (workItemIdStr) {
      try {
        priorAttempts = attemptHistory.listByWorkItem(workItemIdStr, { limit: 3 }).reverse();
      } catch (err) {
        logger.debug('submitVerifyFixTask: attempt-history read threw; omitting prior-attempts block', {
          err: err && err.message, work_item_id: workItemIdStr,
        });
      }
    }
    const latest = priorAttempts[priorAttempts.length - 1];
    const verifyOutputPrev = latest && latest.verify_output_tail ? latest.verify_output_tail : null;

    if (latest && latest.id) {
      try {
        attemptHistory.updateVerifyOutputTail(
          latest.id,
          stripAnsi(String(verifyOutput || '')).slice(-VERIFY_FIX_PROMPT_TAIL_BUDGET)
        );
      } catch (e) {
        logger.warn('attempt_history_verify_tail_update_failed', { err: e.message });
      }
    }

    const prompt = buildVerifyFixPrompt({
      planPath, planTitle,
      branch: worktreeRecord.branch,
      verifyCommand, verifyOutput,
      priorAttempts, verifyOutputPrev,
    });

    // plan_task_number tag makes factory-worktree-auto-commit listener
    // commit this task's output to the branch. Without it, <git-user>'s retry
    // edits sit uncommitted in the worktree and the re-run of remote
    // verify runs against the same failing state. Use a synthetic
    // number beyond the plan's real task range so it doesn't collide.
    const retryPlanTaskNumber = 1000 + attempt;
    const tags = [
      `factory:batch_id=${batch_id}`,
      `factory:work_item_id=${workItem?.id ?? 'unknown'}`,
      `factory:plan_task_number=${retryPlanTaskNumber}`,
      `factory:verify_retry=${attempt}`,
    ];

    safeLogDecision({
      project_id,
      stage: LOOP_STATES.VERIFY,
      action: 'verify_retry_submitted',
      reasoning: `Auto-retry #${attempt}: submitting a fix task via the auto-router with the verify error as context.`,
      inputs: {
        branch: worktreeRecord.branch,
        attempt,
        plan_path: planPath,
      },
      outcome: {
        attempt,
        branch: worktreeRecord.branch,
        max_retries: MAX_AUTO_VERIFY_RETRIES,
      },
      confidence: 1,
      batch_id,
    });

    // Phase X8 (2026-05-02): when forceProvider is set (caller chose to
    // escalate this retry off the lane), drop the project's lane policy
    // metadata so smart_submit_task honors the explicit provider. With the
    // lane policy still attached, the chain filter would block codex on an
    // ollama-locked project. The 2026-04-29 #2097 lesson (lane policy
    // protects against accidental leaks) still holds — escalation is an
    // INTENTIONAL override only, gated by attempt + stack heuristics in
    // the caller.
    const baseMetadata = forceProvider
      ? {}
      : buildProviderLaneTaskMetadata(project || {});
    let submission;
    try {
      submission = await handleSmartSubmitTask({
        task: prompt,
        project: project?.name,
        working_directory: worktreeRecord.worktreePath,
        tags,
        ...(forceProvider ? { provider: forceProvider } : {}),
        task_metadata: {
          // Inject the project's provider_lane_policy so verify auto-retries
          // stay on the project's allowed providers. Without this spread,
          // the smart-routing chain filter has nothing to enforce against
          // and leaks retries to whatever the routing-template default
          // picks. Live evidence 2026-04-29: example-project work item #2097's two
          // verify-retry attempts at 22:51:28 and 22:51:41 spawned codex.exe
          // (gpt-5.5) into the project worktree fea-c4b2f75d, even though
          // the original EXECUTE attempt at 22:46:25 ran on ollama per the
          // lane policy. The first retry happened ~3.5 min after the real
          // commit landed, so by the time codex was running, the diff was
          // already done — both retries no-opped (auto_commit_skipped_clean)
          // and tripped the zero_diff short-circuit.
          ...baseMetadata,
          plan_path: planPath,
          plan_title: planTitle,
          plan_task_title: `verify auto-retry #${attempt}${forceProvider ? ` (escalated to ${forceProvider})` : ''}`,
          factory_retry_attempt: attempt,
          factory_batch_id: batch_id,
          ...(forceProvider ? { factory_verify_retry_escalated_provider: forceProvider } : {}),
        },
      });
    } catch (err) {
      return { submitted: false, reason: 'submit_threw', error: err.message };
    }
    const task_id = submission?.task_id;
    if (!task_id) {
      return { submitted: false, reason: 'no_task_id', error: submission?.content?.[0]?.text || 'submit returned no task_id' };
    }

    const awaitResult = await awaitTaskToStructuredResult(handleAwaitTask, taskCore, {
      task_id,
      verify_command: verifyCommand,
      working_directory: worktreeRecord.worktreePath,
    });

    return { submitted: true, task_id, awaitStatus: awaitResult.status, verifyStatus: awaitResult.verify_status, error: awaitResult.error };
  }

  async function executeVerifyStage(project_id, batch_id, instance = null) {
    // First: run worktree remote verification if there's an active factory
    // worktree for this project. Failure here blocks the loop from reaching
    // LEARN so the operator can decide remediation vs. abandonment before any
    // merge to main.
    const activeBatchId = batch_id || instance?.batch_id || null;
    const worktreeRecord = activeBatchId
      ? factoryWorktrees.getActiveWorktreeByBatch(activeBatchId)
      : factoryWorktrees.getActiveWorktree(project_id);
    const worktreeRunner = worktreeRecord ? getWorktreeRunner() : null;

    // Under pending_approval mode the plan-executor submits tasks and returns
    // immediately. If we reach VERIFY before those tasks actually complete, a
    // remote verify run against the empty branch will fail. Guard: if any batch
    // task is still in a non-terminal state, pause at VERIFY without running
    // the remote tests. The operator re-advances once tasks finish.
    const batchIdForGate = (worktreeRecord && worktreeRecord.batchId) || activeBatchId;
    if (batchIdForGate) {
      const batchTasks = listTasksForFactoryBatch(batchIdForGate);
      if (batchTasks.length > 0) {
        // Match TERMINAL_TASK_STATUSES from db/task-core.js:
        // completed, failed, cancelled, skipped. Without `skipped` here a
        // workflow whose dependency chain short-circuits (every subtask marked
        // `skipped`) loops forever between paused_at_gate and auto-recovery's
        // retry — seen on example-project item #708 where 16 auto-decomposed subtasks
        // all ended in `skipped` and the gate never auto-cleared. `shipped` is
        // a work-item status (CLOSED_WORK_ITEM_STATUSES), not a task status —
        // kept in the list defensively in case a future code path reuses it.
        const nonTerminal = batchTasks.filter(
          (t) => !['completed', 'shipped', 'cancelled', 'failed', 'skipped'].includes(t.status),
        );
        if (nonTerminal.length > 0) {
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'waiting_for_batch_tasks',
            reasoning: `VERIFY waiting for ${nonTerminal.length} non-terminal batch task(s) to finish before remote verify.`,
            outcome: {
              batch_id: batchIdForGate,
              pending_count: nonTerminal.length,
              pending_statuses: nonTerminal.map((t) => t.status),
            },
            confidence: 1,
            batch_id: batchIdForGate,
          });
          return {
            status: 'waiting',
            reason: 'batch_tasks_not_terminal',
            pause_at_stage: 'VERIFY',
            pending_count: nonTerminal.length,
          };
        }
      }
    }

    if (worktreeRecord && worktreeRunner) {
      const project = factoryHealth.getProject(project_id);
      // Pull the associated work item so the retry prompt can reference the
      // plan and so VERIFY can honor work-item-specific scoped validation.
      // Best-effort: if we can't resolve it, the retry still runs with less
      // context and falls back to the project verify command.
      let workItemForRetry = null;
      try {
        if (instance && instance.work_item_id) {
          workItemForRetry = factoryIntake.getWorkItem(instance.work_item_id);
        } else if (worktreeRecord.workItemId) {
          workItemForRetry = factoryIntake.getWorkItem(worktreeRecord.workItemId);
        }
      } catch (_err) {
        workItemForRetry = null;
      }
      const resolvedVerify = resolveFactoryVerifyCommand({
        project,
        workItem: workItemForRetry,
      });
      const verifyCommand = resolvedVerify.command;

      let projectConfig = {};
      try {
        projectConfig = project?.config_json ? JSON.parse(project.config_json) : {};
      } catch (_err) {
        projectConfig = {};
      }
      const thresholdValue = Number(projectConfig.stale_branch_commit_threshold);
      const staleBranchCommitThreshold = Number.isFinite(thresholdValue) ? thresholdValue : 0;
      const baseRef = worktreeRecord.base_branch
        || worktreeRecord.baseBranch
        || detectDefaultBranch(worktreeRecord.worktreePath || project?.path || process.cwd())
        || 'main';
      const branchStaleRejectReason = 'branch_stale_vs_base';
      const freshness = await branchFreshness.checkBranchFreshness({
        worktreePath: worktreeRecord.worktreePath,
        branch: worktreeRecord.branch,
        baseRef,
        threshold: staleBranchCommitThreshold,
      });

      if (freshness.stale) {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'branch_stale_detected',
          reasoning: `Branch ${worktreeRecord.branch} is stale versus ${baseRef}; attempting automatic rebase before VERIFY.`,
          outcome: {
            commits_behind: freshness.commitsBehind,
            stale_files: freshness.staleFiles,
            threshold: staleBranchCommitThreshold,
          },
          confidence: 1,
          batch_id,
        });

        const rebaseResult = await branchFreshness.attemptRebase(
          worktreeRecord.worktreePath,
          worktreeRecord.branch,
          baseRef,
        );
        if (rebaseResult.ok) {
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'branch_auto_rebased',
            reasoning: `Automatically rebased ${worktreeRecord.branch} onto ${baseRef}; proceeding to VERIFY.`,
            outcome: {
              branch: worktreeRecord.branch,
              baseRef,
            },
            confidence: 1,
            batch_id,
          });
        } else {
          if (workItemForRetry && workItemForRetry.id) {
            factoryIntake.rejectWorkItemUnactionable(workItemForRetry.id, branchStaleRejectReason);
          }
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'branch_stale_rebase_conflict',
            reasoning: `Automatic rebase of ${worktreeRecord.branch} onto ${baseRef} failed; marking the work item unactionable so the factory can advance.`,
            outcome: {
              commits_behind: freshness.commitsBehind,
              stale_files: freshness.staleFiles,
              error: rebaseResult.error,
              work_item_id: workItemForRetry?.id || instance?.work_item_id || null,
            },
            confidence: 1,
            batch_id,
          });
          return {
            status: 'unactionable',
            reason: branchStaleRejectReason,
            branch: worktreeRecord.branch,
            worktree_path: worktreeRecord.worktreePath,
          };
        }
      }

      // Auto-retry: if verify fails, submit a fix task via the auto-router with
      // the error output as context, then re-run verify. Bounded at
      // MAX_AUTO_VERIFY_RETRIES. If still failing after that, auto-reject
      // the work item so the loop can advance to the next item.
      const verifyReview = require('../verify-review');
      let review = null;
      // Reset the cascade counter when EXECUTE transitions into VERIFY for a
      // fresh batch. Persisting the counter across stages lets consecutive
      // missing_dep cycles within ONE verify stage add up, without leaking
      // into the next batch.
      try {
        const freshProject = factoryHealth.getProject(project_id);
        const freshCfg = freshProject?.config_json ? JSON.parse(freshProject.config_json) : {};
        if (freshCfg.dep_resolve_cycle_count) {
          freshCfg.dep_resolve_cycle_count = 0;
          factoryHealth.updateProject(project_id, { config_json: JSON.stringify(freshCfg) });
        }
      } catch (_e) { void _e; }
      let res = null;
      let postFailureFreshnessChecked = false;
      // Seed the retry counter from prior verify-retry tasks for this batch.
      // Without this, any re-entry to executeVerifyStage (stall-recovery,
      // VERIFY_FAIL resume, dispatcher re-entry) resets retryAttempt to 0 and
      // the loop cycles retry=1..3 again instead of emitting
      // auto_rejected_verify_fail. The retry tags persisted on task rows are
      // the cross-call source of truth.
      let retryAttempt = countPriorVerifyRetryTasksForBatch(batch_id);
      let submissionFailures = 0;
      try {
        while (true) {
          // Project-row pause gate, re-checked on every iteration. An operator's
          // pause_project must interrupt an in-flight verify-retry loop — not
          // wait for the current retry to finish before the next iteration can
          // submit another Codex task.
          if (isProjectStatusPaused(project_id)) {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_aborted_project_paused',
              reasoning: 'Project was paused mid-verify; aborting retry loop instead of submitting another fix task.',
              outcome: { retry_attempts: retryAttempt },
              confidence: 1,
              batch_id,
            });
            return {
              status: 'paused',
              reason: 'project_paused_mid_verify',
              pause_at_stage: 'VERIFY',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              retry_attempts: retryAttempt,
            };
          }
          res = await worktreeRunner.verify({
            worktreePath: worktreeRecord.worktreePath,
            branch: worktreeRecord.branch,
            verifyCommand,
            baseBranch: baseRef,
          });
          if (res.passed) {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'worktree_verify_passed',
              reasoning: `Worktree remote verify passed for branch ${worktreeRecord.branch}${retryAttempt > 0 ? ` (after ${retryAttempt} retry attempt${retryAttempt === 1 ? '' : 's'})` : ''}.`,
              outcome: {
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                duration_ms: res.durationMs,
                verify_command: verifyCommand,
                verify_command_source: resolvedVerify.source,
                retry_attempt: retryAttempt,
              },
              confidence: 1,
              batch_id,
            });
            break;
          }

          if (!postFailureFreshnessChecked) {
            postFailureFreshnessChecked = true;
            const postFailureFreshness = await branchFreshness.checkBranchFreshness({
              worktreePath: worktreeRecord.worktreePath,
              branch: worktreeRecord.branch,
              baseRef,
              threshold: staleBranchCommitThreshold,
            });

            if (postFailureFreshness.stale) {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'branch_stale_detected_post_verify',
                reasoning: `Branch ${worktreeRecord.branch} became stale versus ${baseRef} during VERIFY; attempting automatic rebase before classifying the failure.`,
                outcome: {
                  commits_behind: postFailureFreshness.commitsBehind,
                  stale_files: postFailureFreshness.staleFiles,
                  threshold: staleBranchCommitThreshold,
                },
                confidence: 1,
                batch_id,
              });

              const postFailureRebase = await branchFreshness.attemptRebase(
                worktreeRecord.worktreePath,
                worktreeRecord.branch,
                baseRef,
              );
              if (postFailureRebase.ok) {
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'branch_auto_rebased_post_verify',
                  reasoning: `Automatically rebased ${worktreeRecord.branch} onto ${baseRef} after VERIFY drift; re-running verify before classifier triage.`,
                  outcome: {
                    branch: worktreeRecord.branch,
                    baseRef,
                  },
                  confidence: 1,
                  batch_id,
                });
                review = null;
                continue;
              }

              if (workItemForRetry && workItemForRetry.id) {
                factoryIntake.rejectWorkItemUnactionable(workItemForRetry.id, branchStaleRejectReason);
              }
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'branch_stale_rebase_conflict_post_verify',
                reasoning: `Automatic rebase of ${worktreeRecord.branch} onto ${baseRef} failed after VERIFY drift; marking the work item unactionable so the factory can advance.`,
                outcome: {
                  commits_behind: postFailureFreshness.commitsBehind,
                  stale_files: postFailureFreshness.staleFiles,
                  error: postFailureRebase.error,
                  work_item_id: workItemForRetry?.id || instance?.work_item_id || null,
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'unactionable',
                reason: branchStaleRejectReason,
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
              };
            }
          }

          // Verify-review classifier: on the FIRST failure only, classify the
          // failure as task_caused, baseline_broken, environment_failure, or
          // ambiguous. Baseline_broken / environment_failure short-circuit the
          // retry loop. Task_caused enters the repair path. Ambiguous failures
          // get one silent rerun, then pause for operator triage instead of
          // letting a retry task repair unrelated full-suite failures.
          if (res?.reason === 'empty_branch') {
            return resolveVerifyEmptyBranch({
              project,
              project_id,
              instance,
              workItem: workItemForRetry,
              worktreeRecord,
              verifyResult: res,
              batch_id,
            });
          }

          if (retryAttempt === 0 && !review) {
            try {
              const wi = instance?.work_item_id
                ? factoryIntake.getWorkItem(instance.work_item_id)
                : null;
              review = await verifyReview.reviewVerifyFailure({
                verifyOutput: res,
                workingDirectory: worktreeRecord.worktreePath || project?.path || process.cwd(),
                worktreeBranch: worktreeRecord.branch,
                mergeBase: baseRef,
                workItem: wi,
                project: project || { id: project_id, path: null },
                batch_id,
              });
            } catch (err) {
              logger.warn('verify-review classifier failed; falling through to existing retry path', {
                project_id, err: err.message,
              });
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'verify_reviewer_fail_open',
                reasoning: `Classifier threw: ${err.message}. Retrying as before.`,
                outcome: { work_item_id: instance?.work_item_id || null },
                confidence: 1,
                batch_id,
              });
              review = null;
            }

            if (review?.classification === 'zero_diff_cascade') {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'verify_retry_suppressed_zero_diff',
                reasoning: 'Verify-retry suppressed: modifiedFiles empty AND prior auto_commit_skipped_clean in batch.',
                outcome: {
                  reject_reason: 'zero_diff_across_retries',
                  work_item_id: instance?.work_item_id,
                },
                confidence: 1,
                batch_id,
              });
              if (instance?.work_item_id) {
                try {
                  factoryIntake.rejectWorkItemUnactionable(instance.work_item_id, 'zero_diff_across_retries');
                } catch (err) {
                  logger.warn('verify zero-diff cascade: failed to mark work item unactionable', {
                    project_id,
                    work_item_id: instance.work_item_id,
                    err: err.message,
                  });
                }
              }
              return {
                status: 'unactionable',
                reason: 'zero_diff_across_retries',
                pause_at_stage: null,
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
              };
            }

            // missing_dep branch: submit a Codex resolver task, await, re-verify.
            // Cap cascade at 3 per batch. On resolver failure, escalate once; on
            // escalation pause, treat as baseline_broken and pause the project.
            if (review && review.classification === 'missing_dep') {
              const depResolver = require('../dep-resolver/index');
              const escalationHelper = require('../dep-resolver/escalation');
              const registry = require('../dep-resolver/registry');
              const adapter = registry.getAdapter(review.manager);
              if (!adapter) {
                // Manager disappeared between classify and resolve; fall through
                // as ambiguous so the normal retry path can try.
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'dep_resolver_no_adapter',
                  reasoning: `Missing dep detected (manager=${review.manager}) but no adapter is registered; falling through to retry.`,
                  outcome: { work_item_id: instance?.work_item_id || null, manager: review.manager },
                  confidence: 1,
                  batch_id,
                });
              } else {
              const gatedTrust = project.trust_level === 'supervised' || project.trust_level === 'guided';
              if (gatedTrust) {
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'dep_resolver_pending_approval',
                  reasoning: `Missing dep ${review.package_name} (${review.manager}) detected. Trust level ${project.trust_level} requires operator approval before installing.`,
                  outcome: {
                    work_item_id: instance?.work_item_id || null,
                    manager: review.manager,
                    package: review.package_name,
                    proposed_action: 'dep_resolve',
                  },
                  confidence: 1,
                  batch_id,
                });
                return {
                  status: 'paused',
                  reason: 'dep_resolver_pending_approval',
                  next_state: LOOP_STATES.PAUSED,
                  paused_at_stage: LOOP_STATES.VERIFY,
                };
              }
                // Check cascade cap + kill switch.
                const currentProject = factoryHealth.getProject(project_id);
                const cfg = currentProject?.config_json ? JSON.parse(currentProject.config_json) : {};
                const enabled = cfg?.dep_resolver?.enabled !== false; // default on
                const cap = Number.isFinite(cfg?.dep_resolver?.cascade_cap) ? cfg.dep_resolver.cascade_cap : 3;
                const count = Number.isFinite(cfg?.dep_resolve_cycle_count) ? cfg.dep_resolve_cycle_count : 0;

                if (!enabled) {
                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_disabled',
                    reasoning: 'Missing dep detected but dep_resolver.enabled=false; falling through to existing retry.',
                    outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name },
                    confidence: 1,
                    batch_id,
                  });
                } else if (count >= cap) {
                  // Cascade exhausted — pause as baseline_broken.
                  factoryIntake.updateWorkItem(instance.work_item_id, {
                    status: 'rejected',
                    reject_reason: `dep_cascade_exhausted: ${count} resolutions attempted, next missing dep is ${review.package_name}`,
                  });
                  cfg.baseline_broken_since = new Date().toISOString();
                  cfg.baseline_broken_reason = 'dep_cascade_exhausted';
                  cfg.baseline_broken_evidence = { last_package: review.package_name, cycle_count: count };
                  cfg.baseline_broken_probe_attempts = 0;
                  cfg.baseline_broken_tick_count = 0;
                  factoryHealth.updateProject(project_id, { status: 'paused', config_json: JSON.stringify(cfg) });
                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_cascade_exhausted',
                    reasoning: `Reached ${count} dep resolutions this batch; pausing project.`,
                    outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, cycle_count: count },
                    confidence: 1,
                    batch_id,
                  });
                  return { status: 'rejected', reason: 'dep_cascade_exhausted' };
                } else {
                  // Run the resolver.
                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_detected',
                    reasoning: `Missing dep detected: ${review.package_name} (manager=${review.manager})`,
                    outcome: { work_item_id: instance?.work_item_id || null, manager: review.manager, package: review.package_name, module: review.module_name },
                    confidence: 1,
                    batch_id,
                  });

                  let resolveResult = await depResolver.resolve({
                    classification: review,
                    project,
                    worktree: worktreeRecord,
                    workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                    instance,
                    adapter,
                    options: {},
                  });

                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: resolveResult.outcome === 'resolved' ? 'dep_resolver_task_completed' : 'dep_resolver_validation_failed',
                    reasoning: `Resolver outcome: ${resolveResult.outcome} (${resolveResult.reason || 'ok'})`,
                    outcome: { work_item_id: instance?.work_item_id || null, ...resolveResult },
                    confidence: 1,
                    batch_id,
                  });

                  // On resolver failure, escalate once.
                  if (resolveResult.outcome !== 'resolved') {
                    const escalationResult = await escalationHelper.escalate({
                      project,
                      workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                      originalError: review.error_output || '',
                      resolverError: resolveResult.resolverError || resolveResult.reason || '',
                      resolverPrompt: adapter.buildResolverPrompt({
                        package_name: review.package_name,
                        project,
                        worktree: worktreeRecord,
                        workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                        error_output: review.error_output || '',
                      }),
                      manifestExcerpt: '',
                    });
                    safeLogDecision({
                      project_id,
                      stage: LOOP_STATES.VERIFY,
                      action: 'dep_resolver_escalated',
                      reasoning: `Escalation verdict: ${escalationResult.action} (${escalationResult.reason})`,
                      outcome: { work_item_id: instance?.work_item_id || null, ...escalationResult },
                      confidence: 1,
                      batch_id,
                    });
                    if (escalationResult.action === 'retry') {
                      resolveResult = await depResolver.resolve({
                        classification: review,
                        project,
                        worktree: worktreeRecord,
                        workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                        instance,
                        adapter,
                        options: { revisedPrompt: escalationResult.revisedPrompt },
                      });
                      safeLogDecision({
                        project_id,
                        stage: LOOP_STATES.VERIFY,
                        action: 'dep_resolver_escalation_retry',
                        reasoning: `Retry resolver outcome: ${resolveResult.outcome} (${resolveResult.reason || 'ok'})`,
                        outcome: { work_item_id: instance?.work_item_id || null, ...resolveResult },
                        confidence: 1,
                        batch_id,
                      });
                    }
                    // If still not resolved (either escalation pause or retry failed), pause project.
                    if (resolveResult.outcome !== 'resolved') {
                      factoryIntake.updateWorkItem(instance.work_item_id, {
                        status: 'rejected',
                        reject_reason: `dep_resolver_unresolvable: ${escalationResult.reason || resolveResult.reason || 'unknown'}`,
                      });
                      cfg.baseline_broken_since = new Date().toISOString();
                      cfg.baseline_broken_reason = 'dep_resolver_unresolvable';
                      cfg.baseline_broken_evidence = { package: review.package_name, escalation_reason: escalationResult.reason, resolver_reason: resolveResult.reason };
                      cfg.baseline_broken_probe_attempts = 0;
                      cfg.baseline_broken_tick_count = 0;
                      factoryHealth.updateProject(project_id, { status: 'paused', config_json: JSON.stringify(cfg) });
                      safeLogDecision({
                        project_id,
                        stage: LOOP_STATES.VERIFY,
                        action: 'dep_resolver_escalation_pause',
                        reasoning: `Pausing project: ${escalationResult.reason || resolveResult.reason}`,
                        outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, escalation: escalationResult, resolver: resolveResult },
                        confidence: 1,
                        batch_id,
                      });
                      return { status: 'rejected', reason: 'dep_resolver_unresolvable' };
                    }
                  }

                  // Success path: bump counter, mark for re-verify. Continue
                  // the outer verify while-loop.
                  cfg.dep_resolve_cycle_count = count + 1;
                  if (!Array.isArray(cfg.dep_resolve_history)) cfg.dep_resolve_history = [];
                  cfg.dep_resolve_history.push({
                    ts: new Date().toISOString(),
                    batch_id,
                    package: review.package_name,
                    manager: review.manager,
                    outcome: 'resolved',
                    task_id: resolveResult.taskId || null,
                  });
                  // Cap history at 20 entries
                  if (cfg.dep_resolve_history.length > 20) cfg.dep_resolve_history = cfg.dep_resolve_history.slice(-20);
                  factoryHealth.updateProject(project_id, { config_json: JSON.stringify(cfg) });

                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_reverify_passed',
                    reasoning: `Dep ${review.package_name} resolved; re-running verify (cycle ${count + 1}/${cap}).`,
                    outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, cycle_count: count + 1 },
                    confidence: 1,
                    batch_id,
                  });

                  // Clear `review` so the next loop iteration re-enters the
                  // classifier on the fresh verify output.
                  review = null;
                  continue;
                }
              }
            }

            if (review && (review.classification === 'baseline_broken'
                           || review.classification === 'baseline_likely'
                           || review.classification === 'environment_failure')) {
              let blockedWorkItem = null;
              if (instance?.work_item_id) {
                try {
                  blockedWorkItem = factoryIntake.getWorkItem(instance.work_item_id);
                  factoryIntake.updateWorkItem(instance.work_item_id, {
                    status: 'rejected',
                    reject_reason: review.suggestedRejectReason,
                  });
                } catch (_e) { void _e; }
              }

              try {
                const currentProject = factoryHealth.getProject(project_id);
                const cfg = currentProject?.config_json ? JSON.parse(currentProject.config_json) : {};
                cfg.baseline_broken_since = new Date().toISOString();
                cfg.baseline_broken_reason = review.suggestedRejectReason;
                cfg.baseline_broken_evidence = {
                  ...baselineRequeue.captureBlockedWorkItemEvidence(blockedWorkItem),
                  failing_tests: review.failingTests,
                  exit_code: res.exitCode,
                  verify_command: verifyCommand,
                  verify_command_source: resolvedVerify.source,
                  environment_signals: review.environmentSignals,
                  llm_critique: review.llmCritique,
                  // baseline_likely was reached without an LLM verdict —
                  // record the deterministic shape that justified it so the
                  // baseline-probe phase has the same evidence the operator
                  // would have used.
                  classification: review.classification,
                  shared_infra_touched: review.sharedInfraTouched || false,
                };
                cfg.baseline_broken_probe_attempts = 0;
                cfg.baseline_broken_tick_count = 0;
                factoryHealth.updateProject(project_id, {
                  status: 'paused',
                  config_json: JSON.stringify(cfg),
                });
              } catch (_e) { void _e; }

              try {
                if (review.classification === 'baseline_broken'
                    || review.classification === 'baseline_likely') {
                  eventBus.emitFactoryProjectBaselineBroken({
                    project_id,
                    reason: review.suggestedRejectReason,
                    failing_tests: review.failingTests,
                    evidence: {
                      exit_code: res.exitCode,
                      llm_critique: review.llmCritique,
                      classification: review.classification,
                    },
                  });
                } else {
                  eventBus.emitFactoryProjectEnvironmentFailure({
                    project_id,
                    signals: review.environmentSignals,
                    exit_code: res.exitCode,
                  });
                }
              } catch (_e) { void _e; }

              const action = review.classification === 'baseline_broken'
                ? 'verify_reviewed_baseline_broken'
                : review.classification === 'baseline_likely'
                  ? 'verify_reviewed_baseline_likely'
                  : 'verify_reviewed_environment_failure';
              const reasoning = review.classification === 'baseline_broken'
                ? `Baseline broken — ${review.failingTests.length} failing test(s) unrelated to this diff. ${review.llmCritique || ''}`
                : review.classification === 'baseline_likely'
                  ? `Baseline likely broken — LLM verdict unavailable (${review.llmStatus || 'null'}); ${review.failingTests.length} failing test(s) do not touch any modified file and no shared infrastructure was modified. Pausing for baseline-probe to confirm against main.`
                  : `Environment failure — signals: ${review.environmentSignals.join(', ')}.`;
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action,
                reasoning,
                outcome: {
                  work_item_id: instance?.work_item_id || null,
                  classification: review.classification,
                  confidence: review.confidence,
                  modifiedFiles: review.modifiedFiles,
                  failingTests: review.failingTests,
                  intersection: review.intersection,
                  environmentSignals: review.environmentSignals,
                  llmVerdict: review.llmVerdict,
                  llmCritique: review.llmCritique || null,
                  llmStatus: review.llmStatus || null,
                  llmTaskId: review.llmTaskId || null,
                  sharedInfraTouched: review.sharedInfraTouched || false,
                  sharedInfraFiles: review.sharedInfraFiles || [],
                },
                confidence: 1,
                batch_id,
              });

              return { status: 'rejected', reason: review.classification };
            }

            if (review && review.classification === 'reviewer_timeout') {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'verify_reviewer_timeout_paused',
                reasoning: `Verify reviewer timed out (task=${review.llmTaskId || 'unknown'}); pausing for controlled recovery instead of reusing the generic ambiguous retry loop.`,
                outcome: {
                  work_item_id: instance?.work_item_id || null,
                  classification: review.classification,
                  confidence: review.confidence,
                  modifiedFiles: review.modifiedFiles,
                  failingTests: review.failingTests,
                  intersection: review.intersection,
                  llmStatus: review.llmStatus || null,
                  task_id: review.llmTaskId || null,
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'failed',
                reason: 'verify_reviewer_timeout_requires_recovery',
                pause_at_stage: 'VERIFY_FAIL',
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                verify_output: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
              };
            }

            if (review && review.classification === 'ambiguous') {
              let verifyOutput = res.output;
              const silentResult = await attemptSilentRerun({
                project_id,
                batch_id,
                instance_id: instance && instance.id,
                priorVerifyOutput: verifyOutput,
                runVerify: async () => {
                  const execResult = await worktreeRunner.verify({
                    worktreePath: worktreeRecord.worktreePath,
                    branch: worktreeRecord.branch,
                    verifyCommand,
                    baseBranch: baseRef,
                  });
                  return {
                    exitCode: typeof execResult.exitCode === 'number' ? execResult.exitCode : (execResult.passed ? 0 : 1),
                    output: execResult.output,
                  };
                },
              });

              if (silentResult.kind === 'passed') {
                return { status: 'passed' };
              }
              if (silentResult.kind === 'different_failure') {
                verifyOutput = silentResult.combinedOutput;
                res.output = verifyOutput;
              }
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'verify_reviewed_ambiguous_paused',
                reasoning: review.sharedInfraTouched
                  ? `Classifier says ambiguous (confidence=${review.confidence}); shared infrastructure was touched (${(review.sharedInfraFiles || []).join(', ')}) so deterministic baseline upgrade is suppressed; pausing for engine strategy escalation.`
                  : `Classifier says ambiguous (confidence=${review.confidence}); pausing instead of auto-retrying an unscoped failure.`,
                outcome: {
                  work_item_id: instance?.work_item_id || null,
                  classification: review.classification,
                  confidence: review.confidence,
                  modifiedFiles: review.modifiedFiles,
                  failingTests: review.failingTests,
                  intersection: review.intersection,
                  silent_rerun: silentResult.kind,
                  llmVerdict: review.llmVerdict || null,
                  llmCritique: review.llmCritique || null,
                  llmStatus: review.llmStatus || null,
                  llmTaskId: review.llmTaskId || null,
                  sharedInfraTouched: review.sharedInfraTouched || false,
                  sharedInfraFiles: review.sharedInfraFiles || [],
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'failed',
                reason: 'verify_ambiguous_requires_operator',
                pause_at_stage: 'VERIFY_FAIL',
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                verify_output: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
              };
            }

            // build_failure is treated like task_caused: route to the auto-retry
            // path so MAX_AUTO_VERIFY_RETRIES bounds it. After retries exhaust,
            // the work item gets auto-rejected as unactionable rather than
            // sitting in human-pause limbo (the f9cf2275 failure mode).
            const reviewedAction = review && review.classification === 'task_caused'
              ? 'verify_reviewed_task_caused'
              : review && review.classification === 'build_failure'
                ? 'verify_reviewed_build_failure'
                : 'verify_reviewed_retrying';
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: reviewedAction,
              reasoning: review
                ? `Classifier says ${review.classification} (confidence=${review.confidence}); retry path will fire.`
                : 'Classifier unavailable; retrying as before.',
              outcome: review ? {
                work_item_id: instance?.work_item_id || null,
                classification: review.classification,
                confidence: review.confidence,
                modifiedFiles: review.modifiedFiles,
                failingTests: review.failingTests,
                intersection: review.intersection,
                // Surface build_failure detector signals (e.g.
                // ['csharp_compile_error', 'dotnet_error_count_8']) when present
                // so triage can identify the language/tool that emitted them.
                buildSignals: review.buildSignals || null,
                llmVerdict: review.llmVerdict || null,
                llmCritique: review.llmCritique || null,
                llmStatus: review.llmStatus || null,
                llmTaskId: review.llmTaskId || null,
              } : { work_item_id: instance?.work_item_id || null, classifier: 'unavailable' },
              confidence: 1,
              batch_id,
            });
          }

          if (retryAttempt >= MAX_AUTO_VERIFY_RETRIES) {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'worktree_verify_failed',
              reasoning: `Worktree remote verify FAILED for branch ${worktreeRecord.branch} after ${retryAttempt} auto-retry attempt${retryAttempt === 1 ? '' : 's'}; auto-rejecting the work item and advancing.`,
              outcome: {
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                duration_ms: res.durationMs,
                verify_command: verifyCommand,
                output_preview: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
              },
              confidence: 1,
              batch_id,
            });
            // Before auto-rejecting: check if the work was already done on
            // main (manual fix in a different session). If so, ship it.
            try {
              const project = getProjectOrThrow(project_id);
              const wi = instance.work_item_id
                ? factoryIntake.getWorkItem(instance.work_item_id)
                : null;
              if (wi) {
                const detector = createShippedDetector({ repoRoot: project.path });
                const detection = detector.detectShipped({
                  content: wi.description || wi.title || '',
                  title: wi.title,
                });
                if (detection.shipped && detection.confidence !== 'low') {
                  factoryIntake.updateWorkItem(wi.id, { status: 'shipped' });
                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'auto_shipped_at_verify_fail',
                    reasoning: `Verify failed but shipped-detector found matching commits on main (${detection.confidence} confidence). Marking shipped instead of auto-rejecting.`,
                    inputs: { work_item_id: wi.id },
                    outcome: { confidence: detection.confidence, signals: detection.signals },
                    confidence: 1,
                    batch_id,
                  });
                  return { status: 'passed', reason: 'auto_shipped_at_verify_fail' };
                }
              }
            } catch (_e) { void _e; }

            // Auto-reject: mark the work item as rejected and let the loop
            // advance past this item instead of stalling at VERIFY_FAIL.
            if (instance && instance.work_item_id) {
              try {
                factoryIntake.updateWorkItem(instance.work_item_id, {
                  status: 'rejected',
                  reject_reason: `verify_failed_after_${retryAttempt}_retries`,
                });
              } catch (_e) { void _e; }
            }
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'auto_rejected_verify_fail',
              reasoning: `Auto-rejected work item after ${retryAttempt} verify retries. Advancing to LEARN to process next item.`,
              outcome: {
                work_item_id: instance?.work_item_id || null,
                instance_id: instance?.id || null,
                retry_attempts: retryAttempt,
              },
              confidence: 1,
              batch_id,
            });
            return { status: 'passed', reason: 'auto_rejected_after_max_retries' };
          }
          retryAttempt += 1;
          // Phase X8 (2026-05-02): escalate verify retries to codex when an
          // ollama-locked project has a dotnet test verify and the first
          // ollama attempt didn't converge. qwen3-coder:30b can write code
          // but reliably struggles to read NUnit/xUnit failures and patch
          // the right one-line in production code. Live evidence: DLPhone
          // items 2096, 876, 2082 each got past the build gate but never
          // turned dotnet tests green across 3 ollama retries. Escalating
          // attempts >= 2 to codex preserves cost on the first try while
          // giving the harder retries a model that can actually reason
          // about test failures.
          const retryProject = factoryHealth.getProject(project_id);
          const laneProvider = getEffectiveProjectProvider(retryProject);
          const verifyStack = detectVerifyStack({
            verifyCommand,
            verifyOutput: res.output,
          });
          const shouldEscalate = (
            retryAttempt >= 2
            && laneProvider === 'ollama'
            && verifyStack === 'dotnet'
          );
          const forceProvider = shouldEscalate ? 'codex' : null;
          if (shouldEscalate) {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_retry_escalated_to_codex',
              reasoning: `Verify retry #${retryAttempt} escalated from ollama to codex: dotnet test failures rarely converge on local model after a first attempt. Lane policy is preserved for EXECUTE; only this retry submission is escalated.`,
              inputs: {
                attempt: retryAttempt,
                lane_provider: laneProvider,
                verify_stack: verifyStack,
                branch: worktreeRecord.branch,
              },
              outcome: { forced_provider: forceProvider },
              confidence: 1,
              batch_id,
            });
          }
          const retryResult = await submitVerifyFixTask({
            project_id,
            batch_id,
            worktreeRecord,
            workItem: workItemForRetry,
            verifyCommand,
            verifyOutput: res.output,
            attempt: retryAttempt,
            forceProvider,
          });

          // Fix 4: classify the retry result.
          // (a) submission did not happen — distinguish fatal vs transient.
          if (retryResult.submitted === false) {
            // Dark-factory recovery: submitVerifyFixTask already auto-rejected
            // the item (worktree + branch both lost). Advance the loop past
            // VERIFY so the factory picks the next item.
            if (retryResult.auto_rejected) {
              return {
                status: 'passed',
                reason: retryResult.reason || 'auto_rejected_during_verify',
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                retry_attempts: retryAttempt,
              };
            }
            if (FATAL_SUBMISSION_REASONS.has(retryResult.reason)) {
              // Fatal: cwd missing, etc. Pause immediately — retrying won't help.
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'worktree_verify_failed',
                reasoning: `Worktree verify FAILED: retry submission cannot proceed (${retryResult.reason}). Pausing at VERIFY_FAIL.`,
                outcome: {
                  branch: worktreeRecord.branch,
                  worktree_path: worktreeRecord.worktreePath,
                  duration_ms: res.durationMs,
                  verify_command: verifyCommand,
                  output_preview: String(res.output || '').slice(-1500),
                  retry_attempts: retryAttempt,
                  submission_reason: retryResult.reason,
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'failed',
                reason: `verify_retry_${retryResult.reason}`,
                pause_at_stage: 'VERIFY_FAIL',
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                verify_output: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
              };
            }
            // Transient submission failure (no task_id, submit_threw, etc.).
            // Don't consume a retry attempt — the test never ran. Re-attempt
            // the submission, capped at MAX_SUBMISSION_FAILURES so a persistent
            // provider outage doesn't loop forever.
            submissionFailures += 1;
            retryAttempt -= 1;
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_retry_submission_failed',
              reasoning: `Auto-retry submission failed (${retryResult.reason || 'unknown'}); not consuming a retry attempt (${submissionFailures}/${MAX_SUBMISSION_FAILURES}).`,
              outcome: {
                attempt: retryAttempt + 1,
                submission_failures: submissionFailures,
                max_submission_failures: MAX_SUBMISSION_FAILURES,
                reason: retryResult.reason || null,
                error: retryResult.error || null,
                branch: worktreeRecord.branch,
              },
              confidence: 1,
              batch_id,
            });
            if (submissionFailures >= MAX_SUBMISSION_FAILURES) {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'worktree_verify_failed',
                reasoning: `Worktree verify FAILED: ${submissionFailures} consecutive retry-submission errors; pausing at VERIFY_FAIL for operator triage.`,
                outcome: {
                  branch: worktreeRecord.branch,
                  worktree_path: worktreeRecord.worktreePath,
                  duration_ms: res.durationMs,
                  verify_command: verifyCommand,
                  output_preview: String(res.output || '').slice(-1500),
                  retry_attempts: retryAttempt,
                  submission_failures: submissionFailures,
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'failed',
                reason: 'worktree_verify_failed_submission_failures',
                pause_at_stage: 'VERIFY_FAIL',
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                verify_output: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
                submission_failures: submissionFailures,
              };
            }
            continue;
          }

          // (b) submission OK but task did not complete — preserve existing
          // pause behavior (provider crashed, await timed out, etc.).
          if (retryResult.awaitStatus !== 'completed') {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_retry_task_failed',
              reasoning: `Auto-retry #${retryAttempt} task did not complete successfully; abandoning retry loop and pausing at VERIFY_FAIL.`,
              outcome: {
                attempt: retryAttempt,
                submitted: retryResult.submitted,
                reason: retryResult.reason || retryResult.awaitStatus || null,
                error: retryResult.error || null,
                branch: worktreeRecord.branch,
              },
              confidence: 1,
              batch_id,
            });
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'worktree_verify_failed',
              reasoning: `Worktree remote verify FAILED and auto-retry #${retryAttempt} did not produce a completed task; pausing loop at VERIFY_FAIL.`,
              outcome: {
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                duration_ms: res.durationMs,
                verify_command: verifyCommand,
                output_preview: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
              },
              confidence: 1,
              batch_id,
            });
            return {
              status: 'failed',
              reason: 'worktree_verify_failed_retry_task_error',
              pause_at_stage: 'VERIFY_FAIL',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              verify_output: String(res.output || '').slice(-1500),
              retry_attempts: retryAttempt,
            };
          }
          // (c) submission OK + task completed — reset transient counter and re-verify.
          submissionFailures = 0;
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'verify_retry_task_completed',
            reasoning: `Auto-retry #${retryAttempt} task completed; re-running remote verify.`,
            outcome: {
              attempt: retryAttempt,
              task_id: retryResult.task_id,
              branch: worktreeRecord.branch,
            },
            confidence: 1,
            batch_id,
          });
          const scopeEnvelopeResult = await enforceVerifyRetryScopeEnvelope({
            project_id,
            batch_id,
            workItemId: instance?.work_item_id || workItemForRetry?.id || worktreeRecord.workItemId || null,
            planPath: workItemForRetry?.origin?.plan_path || null,
            verifyOutput: res.output,
            worktreePath: worktreeRecord.worktreePath,
            attempt: retryAttempt,
            branch: worktreeRecord.branch,
          });
          if (!scopeEnvelopeResult.ok) {
            return {
              status: 'failed',
              reason: 'retry_off_scope',
              pause_at_stage: 'VERIFY_FAIL',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              off_scope_files: scopeEnvelopeResult.offScopeFiles,
              scope_envelope: Array.from(scopeEnvelopeResult.scopeEnvelope || []),
            };
          }
        }
      } catch (err) {
        logger.warn('worktree verify threw; treating as verify failure', {
          project_id,
          branch: worktreeRecord.branch,
          err: err.message,
        });
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'worktree_verify_errored',
          reasoning: `Worktree verify threw: ${err.message}`,
          outcome: { branch: worktreeRecord.branch, error: err.message },
          confidence: 0.5,
          batch_id,
        });
        return {
          status: 'failed',
          reason: 'worktree_verify_errored',
          pause_at_stage: 'VERIFY_FAIL',
          error: err.message,
        };
      }
    }

    if (!batch_id) {
      logger.info('VERIFY stage: no batch_id, skipping guardrail checks', { project_id });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.VERIFY,
        action: 'skipped_verification',
        reasoning: 'VERIFY stage skipped because no batch_id is attached.',
        outcome: {
          status: 'skipped',
          reason: 'no_batch_id',
        },
        confidence: 1,
        batch_id: null,
      });
      return { status: 'skipped', reason: 'no_batch_id' };
    }
    try {
      const result = guardrailRunner.runPostBatchChecks(project_id, batch_id, []);
      logger.info('VERIFY stage: guardrail checks complete', { project_id, batch_id, result });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.VERIFY,
        action: 'verified_batch',
        reasoning: 'VERIFY stage completed post-batch guardrail checks.',
        outcome: {
          batch_id,
          status: result?.status || null,
          passed: result?.passed ?? null,
        },
        confidence: 1,
        batch_id,
      });
      return result;
    } catch (err) {
      logger.warn(`VERIFY stage guardrail check failed: ${err.message}`, { project_id });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.VERIFY,
        action: 'verify_failed',
        reasoning: err.message,
        outcome: {
          batch_id,
          status: 'error',
          error: err.message,
        },
        confidence: 1,
        batch_id,
      });
      return { status: 'error', error: err.message };
    }
  }

  let executeVerifyStageForTests = null;

  function setExecuteVerifyStageForTests(fn) {
    executeVerifyStageForTests = typeof fn === 'function' ? fn : null;
  }

  async function runExecuteVerifyStage(project_id, batch_id, instance = null) {
    if (executeVerifyStageForTests) {
      return executeVerifyStageForTests(project_id, batch_id, instance);
    }
    return executeVerifyStage(project_id, batch_id, instance);
  }

  return {
    VERIFY_FIX_PROMPT_PRIOR_BUDGET,
    VERIFY_FIX_PROMPT_TAIL_BUDGET,
    attemptSilentRerun,
    batchBranchHasCommitsAhead,
    batchHasAutoCommittedTask,
    buildPriorAttemptsBlock,
    buildVerifyFixPrompt,
    computeScopeEnvelope,
    countConsecutiveAutoCommitSkippedClean,
    countPriorVerifyRetryTasksForBatch,
    detectVerifyStack,
    enforceVerifyRetryScopeEnvelope,
    executeVerifyStage,
    extractScopeEnvelopeFiles,
    getVerifyRetryDiffFiles,
    getVerifyStackGuidance,
    isFactoryFeatureEnabled,
    isOutOfScope,
    maybeShipNoop,
    maybeShortCircuitZeroDiffExecute,
    renderProgression,
    resolveFactoryVerifyCommand,
    runExecuteVerifyStage,
    setExecuteVerifyStageForTests,
  };
}

module.exports = {
  createVerifyStage,
};
