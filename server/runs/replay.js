'use strict';

const fs = require('fs');
const path = require('path');
const workflowHandlers = require('../handlers/workflow');
const logger = require('../logger').child({ component: 'runs-replay' });

function replayWorkflow(bundleDir) {
  try {
    if (!fs.existsSync(bundleDir)) {
      return { ok: false, error: `Bundle dir not found: ${bundleDir}` };
    }

    const manifestPath = path.join(bundleDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, error: `manifest.json missing in ${bundleDir}` };
    }

    const tasksDir = path.join(bundleDir, 'tasks');
    if (!fs.existsSync(tasksDir)) {
      return { ok: false, error: `tasks directory missing in ${bundleDir}` };
    }

    const manifest = readJsonFile(manifestPath);
    const taskById = readTaskSnapshots(tasksDir);
    const replayTasks = buildReplayTasks(taskById);
    if (replayTasks.length === 0) {
      return { ok: false, error: `No task snapshots found in ${tasksDir}` };
    }

    const sourceName = typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name.trim()
      : manifest.workflow_id;
    const result = workflowHandlers.handleCreateWorkflow({
      name: `${sourceName} (replay)`,
      description: `Replay of workflow ${manifest.workflow_id}`,
      working_directory: manifest.working_directory,
      tasks: replayTasks,
    });

    if (result?.isError) {
      return {
        ok: false,
        error: result.content?.[0]?.text || 'create_workflow failed',
      };
    }

    const workflowId = extractWorkflowId(result);
    if (!workflowId) {
      return { ok: false, error: 'create_workflow did not return a workflow id' };
    }

    return {
      ok: true,
      workflow_id: workflowId,
      source_workflow_id: manifest.workflow_id,
    };
  } catch (error) {
    logger.warn(`[runs-replay] Replay failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTaskSnapshots(tasksDir) {
  const taskById = {};
  const taskFiles = fs.readdirSync(tasksDir).filter(file => file.endsWith('.json'));

  for (const file of taskFiles) {
    const snapshot = readJsonFile(path.join(tasksDir, file));
    if (snapshot?.id) {
      taskById[snapshot.id] = snapshot;
    }
  }

  return taskById;
}

function buildReplayTasks(taskById) {
  const db = require('../database');
  const depsByTask = {};

  for (const taskId of Object.keys(taskById)) {
    try {
      depsByTask[taskId] = db.getTaskDependencies(taskId) || [];
    } catch (_error) {
      depsByTask[taskId] = [];
    }
  }

  return Object.values(taskById).map(task => {
    const dependsOn = (depsByTask[task.id] || [])
      .map(dep => taskById[dep.depends_on_task_id]?.workflow_node_id)
      .filter(Boolean);

    return {
      node_id: task.workflow_node_id,
      task_description: task.task_description,
      provider: task.provider,
      model: task.model,
      tags: normalizeReplayTags(task.tags),
      depends_on: dependsOn,
    };
  });
}

function normalizeReplayTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter(tag => typeof tag === 'string')
    .filter(tag => !tag.startsWith('tests:'));
}

function extractWorkflowId(result) {
  const text = result?.content?.[0]?.text || '';
  return text.match(/([a-f0-9-]{36})/)?.[1] || null;
}

module.exports = { replayWorkflow };
