'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'plan-executor' });
const { parsePlanFile, extractVerifyCommand } = require('./plan-parser');

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

function createPlanExecutor({ submit, awaitTask, projectDefaults = {} }) {
  async function execute({ plan_path, project, working_directory, version_intent = 'feature' }) {
    const started = Date.now();
    const content = fs.readFileSync(plan_path, 'utf8');
    const parsed = parsePlanFile(content);
    const verify_command = extractVerifyCommand(content, projectDefaults.verify_command);

    const completed_tasks = [];
    let failed_task = null;

    for (const task of parsed.tasks) {
      if (task.completed) {
        logger.info(`skipping already-completed task ${task.task_number}: ${task.task_title}`);
        completed_tasks.push(task.task_number);
        continue;
      }

      const prompt = buildTaskPrompt(task, parsed.title);
      const { task_id } = await submit({
        task: prompt,
        project,
        working_directory,
        version_intent,
      });

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

    return {
      plan_path,
      completed_tasks,
      failed_task,
      duration_ms: Date.now() - started,
    };
  }

  return { execute };
}

module.exports = { createPlanExecutor, buildTaskPrompt, tickTaskInFile };
