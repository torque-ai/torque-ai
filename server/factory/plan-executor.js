'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'plan-executor' });
const { parsePlanFile, extractVerifyCommand } = require('./plan-parser');

const FILE_PATH_RE = /(?:^|[\s"'`(])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+)(?=$|[\s"'`),:])/gm;
const EXECUTION_MODES = new Set(['live', 'suppress', 'pending_approval']);

function buildTaskPrompt(task, planTitle) {
  const lines = [`Plan: ${planTitle}`, `Task ${task.task_number}: ${task.task_title}`, ''];
  for (const step of task.steps) {
    lines.push(`### Step ${step.step_number}: ${step.title}`);
    for (const block of step.code_blocks) {
      lines.push('```' + (block.lang || ''));
      lines.push(block.content);
      lines.push('```');
    }
    lines.push('');
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
    if (idx >= 0) lines[idx] = lines[idx].replace(/-\s*\[\s*\]/, '- [x]');
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

function verifyCompletedTaskArtifacts(task, working_directory) {
  // Trust-but-verify: a [x]-marked task should have produced artifacts.
  // If every path extracted from the task's code blocks is missing from
  // the working directory, the [x] is almost certainly stale (carried
  // over from a corrupted or aborted prior run). Don't trust it.
  if (!working_directory) {
    return { trust: true, reason: 'no_working_directory' };
  }
  const paths = extractTaskFilePaths(task, []);
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
    return { trust: false, reason: 'no_artifacts_present', missing };
  }
  return { trust: true, reason: existing.length === paths.length ? 'all_artifacts_present' : 'partial_artifacts_present', missing };
}

function normalizeExecutionMode(executionMode, dryRun) {
  if (EXECUTION_MODES.has(executionMode)) {
    return executionMode;
  }
  return dryRun ? 'suppress' : 'live';
}

function createPlanExecutor({ submit, awaitTask, projectDefaults = {}, onDryRunTask = null }) {
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

    const completed_tasks = [];
    const submitted_tasks = [];
    let failed_task = null;
    let task_count = 0;

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

      const prompt = buildTaskPrompt(task, parsed.title);
      const file_paths = extractTaskFilePaths(task, planFilePaths);

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

module.exports = { createPlanExecutor, buildTaskPrompt, tickTaskInFile };
