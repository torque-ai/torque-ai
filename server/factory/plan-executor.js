'use strict';
const fs = require('fs');
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
  const taskText = [
    task.task_title,
    ...task.steps.flatMap((step) => [
      step.title,
      ...step.code_blocks.map((block) => block.content),
    ]),
  ].join('\n');

  const matches = extractFilePaths(taskText);
  return matches.length > 0 ? matches : fallbackFilePaths;
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
        logger.info(`skipping already-completed task ${task.task_number}: ${task.task_title}`);
        completed_tasks.push(task.task_number);
        continue;
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
