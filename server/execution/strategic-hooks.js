'use strict';

const StrategicBrain = require('../orchestrator/strategic-brain');
const taskCore = require('../db/task-core');
const database = require('../database'); // facade: getDbInstance
const serverConfig = require('../config');
const logger = require('../logger').child({ component: 'strategic-hooks' });

const { resolveOllamaModel } = require('../providers/ollama-shared');
const modelRoles = require('../db/model-roles');

function getDefaultModel() {
  try { return modelRoles.getModelForRole('ollama', 'default') || 'qwen3-coder:30b'; }
  catch { return 'qwen3-coder:30b'; }
}

const DEFAULT_PROVIDER = 'ollama';

function normalizeMetadata(rawMetadata) {
  if (!rawMetadata) return {};
  if (typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
    return { ...rawMetadata };
  }
  if (typeof rawMetadata !== 'string') return {};
  try {
    const parsed = JSON.parse(rawMetadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

function normalizeTags(rawTags) {
  if (Array.isArray(rawTags)) return rawTags;
  if (typeof rawTags !== 'string') return [];

  try {
    const parsed = JSON.parse(rawTags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return rawTags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
}

function isEnabled(key) {
  return serverConfig.isOptIn(key);
}

function getStrategicBrain() {
  return new StrategicBrain({
    provider: serverConfig.get('strategic_provider') || DEFAULT_PROVIDER,
    model: serverConfig.get('strategic_model') || resolveOllamaModel(null, null) || getDefaultModel(),
  });
}

function getTaskId(ctx) {
  return ctx?.taskId || ctx?.task?.id || null;
}

function shouldSkipTask(task) {
  return normalizeTags(task?.tags).includes('strategic');
}

function getCurrentTask(taskId, fallbackTask) {
  if (typeof taskCore.getTask === 'function') {
    return taskCore.getTask(taskId) || fallbackTask || null;
  }
  return fallbackTask || null;
}

function persistMetadata(taskId, metadata) {
  if (typeof taskCore.updateTask === 'function') {
    return taskCore.updateTask(taskId, { metadata });
  }

  const dbInstance = typeof database.getDbInstance === 'function' ? database.getDbInstance() : null;
  if (!dbInstance) return null;

  dbInstance.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), taskId);
  return typeof taskCore.getTask === 'function' ? taskCore.getTask(taskId) : null;
}

async function onTaskFailed(ctx) {
  try {
    const taskId = getTaskId(ctx);
    if (!taskId || !isEnabled('strategic_auto_diagnose')) {
      return null;
    }

    const task = getCurrentTask(taskId, ctx?.task);
    if (!task || shouldSkipTask(task)) {
      return null;
    }

    const brain = getStrategicBrain();
    const result = await brain.diagnose({
      task_description: task.task_description || '',
      error_output: ctx?.errorOutput || task.error_output || task.output || '',
      provider: ctx?.proc?.provider || task.provider || '',
      exit_code: ctx?.code ?? task.exit_code ?? null,
      retry_count: task.retry_count ?? 0,
    });

    const currentTask = getCurrentTask(taskId, task);
    const metadata = normalizeMetadata(currentTask?.metadata);
    metadata.strategic_diagnosis = result;
    persistMetadata(taskId, metadata);

    logger.info('[StrategicHooks] Stored diagnosis', {
      taskId,
      action: result?.action || null,
      confidence: result?.confidence ?? null,
    });

    if (result?.action === 'fix_task' && Number(result?.confidence) >= 0.7) {
      logger.info('[StrategicHooks] High-confidence fix suggestion recorded; auto-action disabled in v1', {
        taskId,
        action: result.action,
        confidence: result.confidence,
      });
    }

    return result;
  } catch (err) {
    logger.warn(`[StrategicHooks] onTaskFailed error for ${getTaskId(ctx) || 'unknown'}: ${err.message}`);
    return null;
  }
}

async function onTaskCompleted(ctx) {
  try {
    const taskId = getTaskId(ctx);
    if (!taskId || !isEnabled('strategic_auto_review')) {
      return null;
    }

    const task = getCurrentTask(taskId, ctx?.task);
    if (!task || shouldSkipTask(task)) {
      return null;
    }

    const brain = getStrategicBrain();
    const result = await brain.review({
      task_description: task.task_description || '',
      task_output: ctx?.output || task.output || '',
      validation_failures: [],
      file_size_delta_pct: 0,
    });

    const currentTask = getCurrentTask(taskId, task);
    const metadata = normalizeMetadata(currentTask?.metadata);
    metadata.strategic_review = result;
    persistMetadata(taskId, metadata);

    logger.info('[StrategicHooks] Stored review', {
      taskId,
      decision: result?.decision || null,
      quality_score: result?.quality_score ?? null,
    });

    return result;
  } catch (err) {
    logger.warn(`[StrategicHooks] onTaskCompleted error for ${getTaskId(ctx) || 'unknown'}: ${err.message}`);
    return null;
  }
}

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createStrategicHooks(_deps) {
  // _deps reserved for Phase 5 when database.js facade is removed
  return {
    onTaskFailed,
    onTaskCompleted,
  };
}

module.exports = {
  onTaskFailed,
  onTaskCompleted,
  createStrategicHooks,
};
