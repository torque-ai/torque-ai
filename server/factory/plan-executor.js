'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'plan-executor' });
const { parsePlanFile, extractVerifyCommand } = require('./plan-parser');
const { findHeavyLocalValidationCommand } = require('../utils/heavy-validation-guard');

const FILE_PATH_RE = /(?:^|[\s"'`(])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+)(?=$|[\s"'`),:])/gm;
const EXECUTION_MODES = new Set(['live', 'suppress', 'pending_approval']);
const LIVE_REUSABLE_STATUSES = new Set(['pending', 'queued', 'running']);
const APPROVAL_REUSABLE_STATUSES = new Set(['pending_approval', 'pending', 'queued', 'running']);

// Phase O (2026-04-30): ollama-specific edit guidance for large files.
// qwen3-coder:30b's `edit_file` tool requires an exact `old_text` match,
// which is unreliable on files over a few hundred lines (whitespace,
// indentation, hidden trailing-comma drift). DLPhone work item #2159 ran
// end-to-end through the Phase A-N pipeline and committed a real diff in
// other cases, but on a 400-line .cs file it tried `edit_file` with a
// reconstructed function signature, hit "old_text not found", and exited
// with no_progress after 9 tool calls. The CLAUDE.md "Ollama Task
// Authoring" section already documents the right pattern (search_files
// → read_file with line ranges → replace_lines), but the architect's
// plan-tasks didn't surface it to the worker. Phase O appends the
// guidance directly to the prompt when the project pins `expected_provider:
// ollama` so the worker receives it on every task.
const OLLAMA_EDIT_GUIDANCE = [
  '',
  '---',
  'Editing guidance for large files (>~300 lines):',
  '- Prefer this pattern: `search_files` → `read_file` with `start_line`/`end_line` to read only the relevant 30-50 lines → `replace_lines` (NOT `edit_file`) to edit by line number.',
  '- `edit_file` requires an EXACT `old_text` match including whitespace and indentation; on long files this fails frequently. `replace_lines` is more robust because it works on line numbers from your previous `read_file` call.',
  '- If `edit_file` fails once with "old_text not found", do NOT retry the same `old_text` — switch to `replace_lines` using line numbers from the prior `read_file`.',
  '- For new files (no existing content), `write_file` is correct and `edit_file`/`replace_lines` do not apply.',
].join('\n');

function buildTaskPrompt(task, planTitle, opts = {}) {
  const lines = [`Plan: ${planTitle}`, `Task ${task.task_number}: ${task.task_title}`, ''];
  for (const step of task.steps) {
    lines.push(`### Step ${step.step_number}: ${step.title}`);
    if (Array.isArray(step.notes) && step.notes.length > 0) {
      lines.push(...step.notes);
    }
    for (const block of step.code_blocks) {
      lines.push('```' + (block.lang || ''));
      lines.push(block.content);
      lines.push('```');
    }
    lines.push('');
  }
  // Phase O: append ollama-specific edit guidance when the worker is ollama.
  const providerHint = typeof opts.providerHint === 'string'
    ? opts.providerHint.trim().toLowerCase()
    : '';
  if (providerHint === 'ollama') {
    lines.push(OLLAMA_EDIT_GUIDANCE);
  }
  lines.push('After making the edits, stop. Do not run verify — the host will verify.');
  return lines.join('\n');
}

function tickTaskInFile(filePath, taskNumber) {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parsePlanFile(content);
  const task = parsed.tasks.find(t => t.task_number === taskNumber);
  if (!task) return;

  const lines = content.split('\n');
  for (const step of task.steps) {
    const idx = lines.findIndex(l => l === step.raw_checkbox_line);
    if (idx >= 0) lines[idx] = lines[idx].replace(/\[\s*\]/, '[x]');
  }
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n'));
  fs.renameSync(tmp, filePath);
}

function extractFilePaths(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const matches = [];
  const seen = new Set();
  for (const match of text.matchAll(FILE_PATH_RE)) {
    const candidate = match[1]?.replace(/\\/g, '/').replace(/[.,;:]+$/g, '');
    if (!candidate || seen.has(candidate) || candidate.includes('://')) {
      continue;
    }
    seen.add(candidate);
    matches.push(candidate);
  }
  return matches;
}

function extractTaskFilePaths(task, fallbackFilePaths = []) {
  // Prefer raw_markdown when the parser captured it — that includes the
  // prose between the step checkbox and the code block, where plans
  // typically name their target files ("Create `server/foo/bar.js`:").
  const taskText = task.raw_markdown || [
    task.task_title,
    ...task.steps.flatMap((step) => [
      step.title,
      ...step.code_blocks.map((block) => block.content),
    ]),
  ].join('\n');

  const matches = extractFilePaths(taskText);
  return matches.length > 0 ? matches : fallbackFilePaths;
}

// Phase U (2026-05-01): extract paths that immediately follow an
// edit/create verb inside backticks. Unlike extractTaskFilePaths (which
// requires a slash and so misses bare filenames like `pyproject.toml`),
// this captures the actual edit/create target regardless of whether it
// has a slash, AND ignores backticked references that aren't immediately
// preceded by an action verb.
//
// Bug it fixes: bitsy plan 735 task 2 says "Edit `pyproject.toml`. ...
// matching the lowest Python version used by `.github/workflows/python-ci.yml`".
// extractTaskFilePaths returned ONLY .github/workflows/python-ci.yml
// (the reference) because pyproject.toml has no slash. The completion
// verifier then concluded "all extracted paths missing → [x] is stale"
// and re-ran task 2 every tick (3+ recurrences observed live).
const TARGET_VERBS = '(?:edit|create|modify|update|add|wire|extend|fix|refactor|rename|replace|configure|introduce|generate|implement|set up|write|patch)';
const EDIT_TARGET_RE = new RegExp(`\\b${TARGET_VERBS}\\b(?:\\s+(?:the|a|an|new))?\\s+\`([^\`\\n]+)\``, 'gi');

// Phase V (2026-05-01): negation guard. Plans rewritten by the architect for
// "this work item is already satisfied" (a "duplicate plan rewrite") often
// say things like "do not create `X`" or "instead of editing `Y`, use `Z`".
// Phase U's verb-anchored extractor matched `create` and `editing` as if they
// were positive instructions, treating `X` and `Y` as edit targets — then
// mistrusting the (correctly-marked) [x] when the file didn't exist.
//
// Live evidence: bitsy plan 721 task 1 says
//   "Treat this request as already satisfied by the canonical
//    dependency-health implementation; do not create
//    `scripts/check_dependency_health.py` from this duplicate plan."
// Phase U fired one false-positive resubmit on this plan before Phase V.
const NEGATION_RE = /\b(?:do(?:es)?\s+not|don't|doesn't|never|instead\s+of|rather\s+than|without|skip(?:ping)?|avoid(?:ing)?)\b/i;
const NEGATION_LOOKBACK = 30; // chars to scan before each verb match

function extractEditTargetPaths(task) {
  // Prefer raw_markdown for the same reason extractTaskFilePaths does.
  const taskText = task.raw_markdown || [
    task.task_title,
    ...task.steps.flatMap((step) => [step.title, ...step.code_blocks.map((b) => b.content)]),
  ].join('\n');
  const seen = new Set();
  const targets = [];
  for (const match of taskText.matchAll(EDIT_TARGET_RE)) {
    // Capture must look like a filename/path: contains a slash OR a dot
    // (extension). Excludes things like `[tool.ruff]`, `target-version`,
    // bare module names. The dot rule still admits `pyproject.toml`,
    // `README.md`, `package.json`.
    const candidate = match[1].trim().replace(/\\/g, '/').replace(/[.,;:]+$/g, '');
    if (!candidate || seen.has(candidate)) continue;
    if (candidate.startsWith('[') || candidate.includes(' ')) continue; // [tool.ruff], "target version"
    if (!candidate.includes('/') && !candidate.includes('.')) continue; // bare module/identifier
    // Phase V: skip matches preceded by a negation within ~30 chars,
    // but don't let the lookback cross a sentence boundary. Without the
    // sentence-boundary stop, "Avoid X. Edit Y" would exclude Y because
    // "Avoid" is within 30 chars of "Edit".
    const lookbackStart = Math.max(0, match.index - NEGATION_LOOKBACK);
    let lookback = taskText.slice(lookbackStart, match.index);
    const lastSentenceEnd = Math.max(
      lookback.lastIndexOf('. '),
      lookback.lastIndexOf('.\n'),
      lookback.lastIndexOf('\n\n'),
    );
    if (lastSentenceEnd >= 0) lookback = lookback.slice(lastSentenceEnd + 1);
    if (NEGATION_RE.test(lookback)) continue;
    seen.add(candidate);
    targets.push(candidate);
  }
  return targets;
}

function verifyCompletedTaskArtifacts(task, working_directory) {
  // Trust-but-verify: a [x]-marked task should have produced artifacts.
  // If every TARGET path (not every cited path) is missing from the
  // working directory, the [x] is almost certainly stale (carried over
  // from a corrupted or aborted prior run). Don't trust it.
  //
  // Phase U: prefer "Edit `X`" / "Create `X`" extraction over the raw
  // slash-path extractor. The raw extractor mistakes references for
  // targets — bitsy plan 735 task 2 case (see extractEditTargetPaths
  // comment). Fall back to the raw extractor when no verb-anchored
  // targets are detectable.
  if (!working_directory) {
    return { trust: true, reason: 'no_working_directory' };
  }
  let paths = extractEditTargetPaths(task);
  let extractor = 'edit_target';
  if (paths.length === 0) {
    paths = extractTaskFilePaths(task, []);
    extractor = 'slash_path_fallback';
  }
  if (paths.length === 0) {
    return { trust: true, reason: 'no_extractable_paths' };
  }
  const existing = [];
  const missing = [];
  for (const p of paths) {
    const absolute = path.isAbsolute(p) ? p : path.join(working_directory, p);
    if (fs.existsSync(absolute)) {
      existing.push(p);
    } else {
      missing.push(p);
    }
  }
  if (existing.length === 0) {
    return { trust: false, reason: 'no_artifacts_present', missing, extractor };
  }
  return {
    trust: true,
    reason: existing.length === paths.length ? 'all_artifacts_present' : 'partial_artifacts_present',
    missing,
    extractor,
  };
}

// Phase N (2026-04-30): pre-submission existence guard for plan tasks.
//
// Plans authored from scout/architect outputs sometimes reference files
// that don't exist in the factory worktree (e.g. scout cited an untracked
// file from main, or the architect imagined a path). When ollama gets such
// a plan, it tries `read_file` on the missing path, gets ERROR, retries the
// directory listing, can't find the file, and exits in 4-5 seconds with
// `no_progress` after 7 tool iterations. The auto-recovery loop then
// resubmits the same broken plan — observed live with DLPhone work item
// 2117 (11+ identical failures over an hour) before the work item was
// manually rejected.
//
// The guard runs only for "edit-style" tasks (modify/replace/update
// language) — "create" tasks legitimately reference files that don't
// exist yet. Returns { ok: true } when the task can proceed; otherwise
// { ok: false, reason, missing, intent }.
const EDIT_VERBS_RE = /\b(edit|modify|update|replace|repair|fix|refactor|rename|extend|change)\b/i;
const CREATE_VERBS_RE = /\b(create|add|new|introduce|generate)\b\s+(?:a\s+|an\s+)?\b(?:file|module|class|component|test)/i;
const CREATE_PHRASE_RE = /\b(?:create|new)\b[^.]{0,40}\b(?:if (?:it )?(?:does not |doesn't )exist|when missing|otherwise)\b/i;

function verifyTaskTargetsForSubmission(task, working_directory, prompt) {
  if (!working_directory) {
    return { ok: true, reason: 'no_working_directory' };
  }
  const paths = extractTaskFilePaths(task, []);
  if (paths.length === 0) {
    return { ok: true, reason: 'no_extractable_paths' };
  }

  // Detect intent from prompt and task title. "Create" wins over "edit"
  // when both appear — a task that says "Create X (or edit if it exists)"
  // is intentionally tolerant of missing files.
  const text = `${task.task_title || ''}\n${prompt || ''}`;
  const isCreate = CREATE_VERBS_RE.test(text) || CREATE_PHRASE_RE.test(text);
  const isEdit = !isCreate && EDIT_VERBS_RE.test(text);

  // Without a clear edit/modify verb, don't gate. Many plans are
  // ambiguous ("Add X to module Y") and could be either; conservative
  // default is to let the task run.
  if (!isEdit) {
    return { ok: true, reason: 'intent_not_edit', intent: isCreate ? 'create' : 'ambiguous' };
  }

  const missing = [];
  for (const p of paths) {
    const absolute = path.isAbsolute(p) ? p : path.join(working_directory, p);
    if (!fs.existsSync(absolute)) {
      missing.push(p);
    }
  }

  // All referenced files exist — task can proceed.
  if (missing.length === 0) {
    return { ok: true, reason: 'all_targets_present', intent: 'edit' };
  }

  // ALL files missing under edit intent → blocked. The plan's premise
  // ("Edit X, Y, Z") is wrong; submitting would just thrash on
  // read_file(404) until ollama gives up with no_progress.
  if (missing.length === paths.length) {
    return {
      ok: false,
      reason: 'all_edit_targets_missing',
      missing,
      intent: 'edit',
    };
  }

  // Partial-miss under edit intent: some files exist, some don't. Often
  // legitimate (touching one existing file plus creating one new helper).
  // Don't block, but flag for observability.
  return {
    ok: true,
    reason: 'partial_edit_targets_missing',
    missing,
    intent: 'edit',
  };
}

function normalizeExecutionMode(executionMode, dryRun) {
  if (EXECUTION_MODES.has(executionMode)) {
    return executionMode;
  }
  return dryRun ? 'suppress' : 'live';
}

function isReusableTaskActiveForMode(status, mode) {
  if (mode === 'live') {
    return LIVE_REUSABLE_STATUSES.has(status);
  }
  if (mode === 'pending_approval') {
    return APPROVAL_REUSABLE_STATUSES.has(status);
  }
  return false;
}

function createPlanExecutor({ submit, awaitTask, findReusableTask = null, projectDefaults = {}, onDryRunTask = null }) {
  async function execute({
    plan_path,
    project,
    working_directory,
    version_intent = 'feature',
    dry_run = false,
    execution_mode = null,
  }) {
    const started = Date.now();
    const content = fs.readFileSync(plan_path, 'utf8');
    const parsed = parsePlanFile(content);
    const verify_command = extractVerifyCommand(content, projectDefaults.verify_command);
    const planFilePaths = extractFilePaths(content);
    const mode = normalizeExecutionMode(execution_mode, dry_run);

    // Phase O (2026-04-30): derive provider hint from the project's lane
    // policy so buildTaskPrompt can append ollama-specific edit guidance
    // when the worker lane is ollama. Pulls from
    // projectDefaults.provider_lane_policy.expected_provider — the same
    // field Phase K's lane swap and Phase G's codegraph-skip already
    // consult.
    const providerHint = (
      projectDefaults?.provider_lane_policy?.expected_provider
      || projectDefaults?.expected_provider
      || ''
    );

    const completed_tasks = [];
    const submitted_tasks = [];
    let failed_task = null;
    let task_count = 0;
    let violation = null;

    for (const task of parsed.tasks) {
      if (task.completed) {
        const verification = verifyCompletedTaskArtifacts(task, working_directory);
        if (!verification.trust) {
          logger.warn(`task ${task.task_number} is marked [x] but its artifacts are missing — treating as incomplete (likely stale from prior corrupted run)`, {
            plan_path,
            task_number: task.task_number,
            missing_paths: verification.missing,
          });
          // Fall through to submission path — don't skip.
        } else {
          logger.info(`skipping already-completed task ${task.task_number}: ${task.task_title}`);
          completed_tasks.push(task.task_number);
          continue;
        }
      }

      const prompt = buildTaskPrompt(task, parsed.title, { providerHint });
      const file_paths = extractTaskFilePaths(task, planFilePaths);

      // Pre-submission guards are evaluated lazily right before submit().
      // Running them here would also fire when we end up reusing an
      // already-running or already-completed task — that task was vetted
      // when it was first submitted, so re-checking the prompt blocks
      // reuse purely because the materialization view of the worktree no
      // longer matches what the prompt says. Concrete failure: the
      // factory-plan-executor-dry-run "reuses an already-running task"
      // test sets up a tmpdir with no `src/app.js` and a plan that says
      // "Update src/app.js" — the existence guard would fail the task
      // before the reuse short-circuit runs. Defer to the submit branch.
      let livePreSubmitChecked = false;
      const runLivePreSubmitGuards = () => {
        if (livePreSubmitChecked || mode !== 'live') return null;
        livePreSubmitChecked = true;

        const detectedCommand = findHeavyLocalValidationCommand(prompt);
        if (detectedCommand) {
          logger.warn(`task ${task.task_number} blocked at materialization — heavy local validation present`, {
            plan_path,
            task_number: task.task_number,
            detected_command: detectedCommand,
          });
          return {
            rule: 'task_avoids_local_heavy_validation',
            task_number: task.task_number,
            detected_command: detectedCommand,
          };
        }

        // Phase N (2026-04-30): existence guard for edit-style tasks. If
        // the plan says "Edit X, Y, Z" but ALL of X/Y/Z are missing in the
        // factory worktree, ollama will exhaust 7 no-progress iterations
        // on read_file(404) and exit in 4 seconds. Auto-recovery then
        // resubmits the same broken plan, looping. Block at submission
        // so the work item bubbles up as needs-replan instead of thrashing.
        const targetCheck = verifyTaskTargetsForSubmission(task, working_directory, prompt);
        if (!targetCheck.ok) {
          logger.warn(`task ${task.task_number} blocked at materialization — edit targets missing in worktree`, {
            plan_path,
            task_number: task.task_number,
            missing: targetCheck.missing,
            intent: targetCheck.intent,
          });
          return {
            rule: 'task_targets_missing_files',
            task_number: task.task_number,
            intent: targetCheck.intent,
            missing: targetCheck.missing,
          };
        }

        return null;
      };

      if (mode === 'suppress') {
        task_count += 1;
        if (typeof onDryRunTask === 'function') {
          await onDryRunTask({
            plan_path,
            plan_title: parsed.title,
            task,
            prompt,
            file_paths,
            execution_mode: mode,
            simulated: true,
          });
        }
        continue;
      }

      const reusableTask = typeof findReusableTask === 'function'
        ? await findReusableTask({
            plan_path,
            plan_title: parsed.title,
            task,
            project,
            working_directory,
            version_intent,
            execution_mode: mode,
            file_paths,
          })
        : null;

      if (reusableTask?.task_id && reusableTask.status === 'completed') {
        const verification = verifyCompletedTaskArtifacts(task, working_directory);
        if (verification.trust) {
          logger.info(`reusing completed task ${reusableTask.task_id} for already-landed plan task ${task.task_number}`);
          tickTaskInFile(plan_path, task.task_number);
          completed_tasks.push(task.task_number);
          continue;
        }

        logger.warn(`completed task ${reusableTask.task_id} for plan task ${task.task_number} has missing artifacts — resubmitting`, {
          plan_path,
          task_number: task.task_number,
          missing_paths: verification.missing,
        });
      }

      if (reusableTask?.task_id && isReusableTaskActiveForMode(reusableTask.status, mode)) {
        logger.info(`reusing active task ${reusableTask.task_id} for plan task ${task.task_number}`);
        if (mode === 'pending_approval') {
          task_count += 1;
          submitted_tasks.push({ task_number: task.task_number, task_id: reusableTask.task_id });
          if (typeof onDryRunTask === 'function') {
            await onDryRunTask({
              plan_path,
              plan_title: parsed.title,
              task,
              prompt,
              file_paths,
              execution_mode: mode,
              simulated: false,
              initial_status: reusableTask.status,
              submitted_task_id: reusableTask.task_id,
              reused_task: true,
            });
          }
          continue;
        }

        const reusedResult = await awaitTask({
          task_id: reusableTask.task_id,
          verify_command,
          commit_message: task.commit_message || `feat: plan task ${task.task_number}`,
          working_directory,
        });

        if (reusedResult.status !== 'completed' || (reusedResult.verify_status && reusedResult.verify_status !== 'passed')) {
          failed_task = task.task_number;
          logger.warn(`reused task ${task.task_number} failed: ${reusedResult.error || reusedResult.verify_status}`);
          break;
        }
        tickTaskInFile(plan_path, task.task_number);
        completed_tasks.push(task.task_number);
        continue;
      }

      // Live-mode pre-submit guards. They were previously evaluated
      // unconditionally at the top of the loop body, which fired even
      // on the reuse short-circuit branches above. We only need them
      // when we're about to submit a brand-new task; the reuse paths
      // already short-circuited with `continue`.
      const guardViolation = runLivePreSubmitGuards();
      if (guardViolation) {
        failed_task = task.task_number;
        violation = guardViolation;
        break;
      }

      const submission = await submit({
        task: prompt,
        project,
        working_directory,
        version_intent,
        plan_path,
        plan_title: parsed.title,
        plan_task_number: task.task_number,
        plan_task_title: task.task_title,
        file_paths,
        task_metadata: {
          plan_path,
          plan_title: parsed.title,
          plan_task_number: task.task_number,
          plan_task_title: task.task_title,
          file_paths,
        },
        initial_status: mode === 'pending_approval' ? 'pending_approval' : undefined,
      });
      const task_id = submission?.task_id;

      if (mode === 'pending_approval') {
        task_count += 1;
        submitted_tasks.push({ task_number: task.task_number, task_id });
        if (typeof onDryRunTask === 'function') {
          await onDryRunTask({
            plan_path,
            plan_title: parsed.title,
            task,
            prompt,
            file_paths,
            execution_mode: mode,
            simulated: false,
            initial_status: 'pending_approval',
            submitted_task_id: task_id,
          });
        }
        continue;
      }

      const result = await awaitTask({
        task_id,
        verify_command,
        commit_message: task.commit_message || `feat: plan task ${task.task_number}`,
        working_directory,
      });

      if (result.status !== 'completed' || (result.verify_status && result.verify_status !== 'passed')) {
        failed_task = task.task_number;
        logger.warn(`task ${task.task_number} failed: ${result.error || result.verify_status}`);
        break;
      }
      tickTaskInFile(plan_path, task.task_number);
      completed_tasks.push(task.task_number);
    }

    const result = {
      plan_path,
      completed_tasks,
      failed_task,
      duration_ms: Date.now() - started,
    };

    if (violation) {
      result.violation = violation;
    }

    // Fix 1: live mode that produced no completion AND no failure means the
    // plan executor silently no-oped — either the plan parsed to zero tasks
    // or every task fell through without producing an outcome. Surface this
    // as a hard signal so the loop can pause at EXECUTE rather than advance
    // to VERIFY (which would false-pass on an empty diff and then collapse
    // at LEARN's "no commits ahead" merge refusal).
    if (mode === 'live' && completed_tasks.length === 0 && failed_task == null) {
      result.no_tasks_executed = true;
      result.no_tasks_reason = parsed.tasks.length === 0
        ? 'plan_parsed_zero_tasks'
        : 'all_tasks_skipped_or_unprocessed';
      result.parsed_task_count = parsed.tasks.length;
    }

    if (mode !== 'live') {
      result.dry_run = true;
      result.task_count = task_count;
      result.simulated = mode === 'suppress';
      result.execution_mode = mode;
      if (submitted_tasks.length > 0) {
        result.submitted_tasks = submitted_tasks;
      }
    }

    return result;
  }

  return { execute };
}

module.exports = {
  createPlanExecutor,
  buildTaskPrompt,
  tickTaskInFile,
  verifyTaskTargetsForSubmission,
  verifyCompletedTaskArtifacts,
  extractEditTargetPaths,
};
