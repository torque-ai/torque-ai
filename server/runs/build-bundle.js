'use strict';

const fs = require('fs');
const path = require('path');
function resolveDb() {
  try {
    const { defaultContainer } = require('../container');
    return defaultContainer.get('db');
  } catch {
    // eslint-disable-next-line global-require -- pre-boot fallback
    return require('../database');
  }
}
const { getDataDir } = require('../data-dir');
const logger = require('../logger').child({ component: 'runs' });

const BUNDLE_FORMAT_VERSION = 1;
const FALLBACK_BUNDLE_DIR_NAME = 'workflow-bundles';

/**
 * Assemble a self-contained artifact bundle for a workflow.
 * @param {string} workflowId
 * @param {{ rootDir?: string }} opts
 * @returns {string|null} absolute path to bundle dir, or null if workflow missing
 */
function buildBundle(workflowId, opts = {}) {
  const normalizedWorkflowId = normalizePathSegment(workflowId, 'workflowId');
  const workflow = resolveDb().getWorkflow(normalizedWorkflowId);
  if (!workflow) return null;

  const bundleDir = resolveBundleDir(workflow, normalizedWorkflowId, opts);
  const tasksDir = path.join(bundleDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const tasks = resolveDb().getWorkflowTasks(normalizedWorkflowId) || [];
  const manifest = buildManifest(workflow, tasks);
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const events = collectWorkflowEvents(normalizedWorkflowId, tasks);
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n'));

  for (const task of tasks) {
    const snapshot = buildTaskSnapshot(task);
    fs.writeFileSync(path.join(tasksDir, `${normalizePathSegment(task.id, 'task.id')}.json`), JSON.stringify(snapshot, null, 2));
  }

  writeRetroIfAvailable(normalizedWorkflowId, manifest, bundleDir);

  logger.info(`[runs] Bundle written: ${bundleDir} (${tasks.length} tasks, ${events.length} events)`);
  return bundleDir;
}

function resolveBundleDir(workflow, workflowId, opts = {}) {
  if (opts.rootDir) {
    return path.join(path.resolve(opts.rootDir), 'runs', workflowId);
  }

  if (typeof workflow.working_directory === 'string' && workflow.working_directory.trim()) {
    return path.join(path.resolve(workflow.working_directory.trim()), 'runs', workflowId);
  }

  // Null-working-directory workflows should not dirty the repo/server cwd.
  return path.join(path.resolve(getDataDir()), FALLBACK_BUNDLE_DIR_NAME, workflowId);
}

function buildManifest(workflow, tasks) {
  return {
    workflow_id: workflow.id,
    name: workflow.name,
    status: workflow.status,
    created_at: workflow.created_at,
    started_at: workflow.started_at,
    completed_at: workflow.completed_at,
    working_directory: workflow.working_directory,
    task_count: tasks.length,
    task_ids: tasks.map(task => task.id),
    bundle_built_at: new Date().toISOString(),
    bundle_format_version: BUNDLE_FORMAT_VERSION,
  };
}

function collectWorkflowEvents(workflowId, tasks) {
  let listEvents;
  try {
    ({ listEvents } = require('../events/event-emitter'));
  } catch (error) {
    logger.info(`[runs] event log unavailable: ${error.message}`);
    return [];
  }

  const events = [];
  try {
    events.push(...listEvents({ workflow_id: workflowId, limit: 50000 }));
  } catch (error) {
    logger.info(`[runs] workflow event list unavailable: ${error.message}`);
  }

  for (const task of tasks) {
    try {
      events.push(...listEvents({ task_id: task.id, limit: 5000 }));
    } catch (error) {
      logger.info(`[runs] task event list unavailable for ${task.id}: ${error.message}`);
    }
  }

  return dedupeEvents(events).sort(compareEvents);
}

function compareEvents(a, b) {
  const tsCompare = String(a.ts || '').localeCompare(String(b.ts || ''));
  if (tsCompare !== 0) return tsCompare;
  return Number(a.id || 0) - Number(b.id || 0);
}

function dedupeEvents(events) {
  const seen = new Set();
  const unique = [];
  for (const event of events) {
    const key = event.id == null
      ? `${event.ts || ''}:${event.task_id || ''}:${event.workflow_id || ''}:${event.type || ''}`
      : `id:${event.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  return unique;
}

function buildTaskSnapshot(task) {
  return {
    id: task.id,
    workflow_node_id: task.workflow_node_id,
    task_description: task.task_description,
    working_directory: task.working_directory,
    status: task.status,
    provider: task.provider,
    original_provider: task.original_provider,
    model: task.model,
    exit_code: task.exit_code,
    started_at: task.started_at,
    completed_at: task.completed_at,
    output: task.output,
    error_output: task.error_output,
    files_modified: parseArrayColumn(task.files_modified),
    tags: parseArrayColumn(task.tags),
    metadata: parseObjectColumn(task.metadata),
  };
}

function writeRetroIfAvailable(workflowId, manifest, bundleDir) {
  try {
    if (typeof resolveDb().getRetroByWorkflow !== 'function') return;
    const retro = resolveDb().getRetroByWorkflow(workflowId);
    if (!retro) return;

    const narrative = parseObjectColumn(retro.narrative);
    const lines = [
      `# Retro: ${manifest.name || workflowId}`,
      '',
      `Smoothness: ${retro.smoothness || retro.narrative_status || 'unknown'}`,
    ];
    if (narrative.intent) {
      lines.push('', `**Intent:** ${narrative.intent}`);
    }
    if (narrative.outcome) {
      lines.push(`**Outcome:** ${narrative.outcome}`);
    }
    fs.writeFileSync(path.join(bundleDir, 'retro.md'), lines.join('\n'));
  } catch {
    // Retros are optional and should not block bundle creation.
  }
}

function parseArrayColumn(value) {
  const parsed = parseJsonColumn(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function parseObjectColumn(value) {
  const parsed = parseJsonColumn(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function parseJsonColumn(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizePathSegment(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }

  const normalized = value.trim();
  if (normalized.includes('\0') || path.isAbsolute(normalized) || /[/\\]/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

module.exports = { buildBundle, resolveBundleDir, FALLBACK_BUNDLE_DIR_NAME };
