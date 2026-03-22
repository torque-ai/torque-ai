// Extracted from project-config-core.js — Pipeline CRUD
'use strict';

const { safeJsonParse } = require('../utils/json');

// ============================================================
// Dependency injection (set by parent module)
// ============================================================

let db = null;
let _recordEvent = null;

function setDb(d) { db = d; }
function setRecordEvent(fn) { _recordEvent = fn; }

// ============================================================
// Pipeline CRUD
// ============================================================

/**
 * Create a new pipeline
 */
function createPipeline(pipeline) {
  const stmt = db.prepare(`
    INSERT INTO pipelines (id, name, description, status, working_directory, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    pipeline.id,
    pipeline.name,
    pipeline.description || null,
    'pending',
    pipeline.working_directory || null,
    new Date().toISOString()
  );

  if (_recordEvent) _recordEvent('pipeline_created', pipeline.id, { name: pipeline.name });
  return getPipeline(pipeline.id);
}

/**
 * Get a pipeline by ID
 */
function getPipeline(id) {
  const stmt = db.prepare('SELECT * FROM pipelines WHERE id = ?');
  const pipeline = stmt.get(id);
  if (pipeline) {
    pipeline.steps = getPipelineSteps(id);
  }
  return pipeline;
}

/**
 * Add a step to a pipeline
 * @param {object} step - Pipeline step payload.
 * @returns {Array<object>} Updated pipeline steps.
 */
function addPipelineStep(step) {
  // Get next step order
  const maxOrder = db.prepare(
    'SELECT MAX(step_order) as max FROM pipeline_steps WHERE pipeline_id = ?'
  ).get(step.pipeline_id);

  const stepOrder = step.step_order !== undefined ? step.step_order : (maxOrder.max || 0) + 1;

  const stmt = db.prepare(`
    INSERT INTO pipeline_steps (pipeline_id, step_order, name, task_template, condition, timeout_minutes, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);

  stmt.run(
    step.pipeline_id,
    stepOrder,
    step.name,
    step.task_template,
    step.condition || null,
    step.timeout_minutes || 30
  );

  return getPipelineSteps(step.pipeline_id);
}

/**
 * Get all steps for a pipeline
 */
function getPipelineSteps(pipelineId) {
  const stmt = db.prepare(
    'SELECT * FROM pipeline_steps WHERE pipeline_id = ? ORDER BY step_order ASC'
  );
  return stmt.all(pipelineId).map(step => ({
    ...step,
    output_vars: safeJsonParse(step.output_vars, null)
  }));
}

/**
 * Update pipeline status
 */
function updatePipelineStatus(id, status, additionalFields = {}) {
  const updates = ['status = ?'];
  const values = [status];

  if (status === 'running' && !additionalFields.started_at) {
    updates.push('started_at = ?');
    values.push(new Date().toISOString());
  }

  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    updates.push('completed_at = ?');
    values.push(new Date().toISOString());
  }

  const PIPELINE_STATUS_FIELDS = new Set(['started_at', 'completed_at', 'error', 'output', 'result', 'current_step']);
  for (const [key, value] of Object.entries(additionalFields)) {
    if (!PIPELINE_STATUS_FIELDS.has(key)) continue; // skip unknown keys
    updates.push(`${key} = ?`);
    values.push(value);
  }

  values.push(id);

  const stmt = db.prepare(`UPDATE pipelines SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getPipeline(id);
}

/**
 * Update pipeline step
 */
function updatePipelineStep(stepId, updates) {
  const setClauses = [];
  const values = [];

  const PIPELINE_STEP_FIELDS = new Set(['status', 'started_at', 'completed_at', 'output', 'error', 'exit_code', 'duration_ms', 'output_vars', 'task_id']);
  for (const [key, value] of Object.entries(updates)) {
    if (!PIPELINE_STEP_FIELDS.has(key)) continue; // skip unknown keys
    setClauses.push(`${key} = ?`);
    if (key === 'output_vars') {
      values.push(JSON.stringify(value));
    } else {
      values.push(value);
    }
  }

  values.push(stepId);

  const stmt = db.prepare(`UPDATE pipeline_steps SET ${setClauses.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

/**
 * Atomic pipeline step status transition to prevent race conditions
 * @param {number} stepId - Pipeline step ID
 * @param {string} fromStatus - Expected current status (or array of valid statuses)
 * @param {string} toStatus - Target status
 * @param {Object} additionalUpdates - Additional fields to update
 * @returns {boolean} True if transition succeeded, false if status didn't match
 */
function transitionPipelineStepStatus(stepId, fromStatus, toStatus, additionalUpdates = {}) {
  const fields = ['status = ?'];
  const values = [toStatus];

  // Add additional updates
  for (const [key, value] of Object.entries(additionalUpdates)) {
    if (key === 'output_vars') {
      fields.push('output_vars = ?');
      values.push(JSON.stringify(value));
    } else {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  values.push(stepId);

  // Build WHERE clause for atomic transition
  let whereClause;
  if (Array.isArray(fromStatus)) {
    const placeholders = fromStatus.map(() => '?').join(', ');
    whereClause = `id = ? AND status IN (${placeholders})`;
    values.push(...fromStatus);
  } else {
    whereClause = `id = ? AND status = ?`;
    values.push(fromStatus);
  }

  const stmt = db.prepare(`UPDATE pipeline_steps SET ${fields.join(', ')} WHERE ${whereClause}`);
  const result = stmt.run(...values);

  return result.changes > 0;
}

/**
 * List all pipelines
 * Optimized to batch-fetch steps instead of N+1 queries
 */
function listPipelines(options = {}) {
  let query = 'SELECT * FROM pipelines';
  const values = [];

  if (options.status) {
    query += ' WHERE status = ?';
    values.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }

  const stmt = db.prepare(query);
  const pipelines = stmt.all(...values);

  if (pipelines.length === 0) {
    return pipelines;
  }

  // Batch fetch all steps for all pipelines in a single query
  const pipelineIds = pipelines.map(p => p.id);
  const placeholders = pipelineIds.map(() => '?').join(', ');
  const stepsStmt = db.prepare(`
    SELECT * FROM pipeline_steps
    WHERE pipeline_id IN (${placeholders})
    ORDER BY pipeline_id, step_order ASC
  `);
  const allSteps = stepsStmt.all(...pipelineIds);

  // Group steps by pipeline_id
  const stepsByPipeline = new Map();
  for (const step of allSteps) {
    if (!stepsByPipeline.has(step.pipeline_id)) {
      stepsByPipeline.set(step.pipeline_id, []);
    }
    stepsByPipeline.get(step.pipeline_id).push({
      ...step,
      task_template: safeJsonParse(step.task_template, null)
    });
  }

  // Attach steps to each pipeline
  return pipelines.map(p => {
    p.steps = stepsByPipeline.get(p.id) || [];
    return p;
  });
}

/**
 * Get next step to run in a pipeline
 */
function getNextPipelineStep(pipelineId) {
  const stmt = db.prepare(`
    SELECT * FROM pipeline_steps
    WHERE pipeline_id = ? AND status = 'pending'
    ORDER BY step_order ASC LIMIT 1
  `);
  return stmt.get(pipelineId);
}

/**
 * Add a parallel step to a pipeline
 * @param {object} step - Pipeline step payload.
 * @returns {Array<object>} Updated pipeline steps.
 */
function addParallelPipelineStep(step) {
  const maxOrder = db.prepare(
    'SELECT MAX(step_order) as max FROM pipeline_steps WHERE pipeline_id = ?'
  ).get(step.pipeline_id);

  const stepOrder = step.step_order !== undefined ? step.step_order : (maxOrder.max || 0) + 1;

  const stmt = db.prepare(`
    INSERT INTO pipeline_steps (pipeline_id, step_order, name, task_template, condition, timeout_minutes, status, parallel_group)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  stmt.run(
    step.pipeline_id,
    stepOrder,
    step.name,
    step.task_template,
    step.condition || 'on_success',
    step.timeout_minutes || 30,
    step.parallel_group || null
  );

  return getPipelineSteps(step.pipeline_id);
}

/**
 * Get steps in a parallel group
 */
function getParallelGroupSteps(pipelineId, parallelGroup) {
  const stmt = db.prepare(`
    SELECT * FROM pipeline_steps
    WHERE pipeline_id = ? AND parallel_group = ?
    ORDER BY step_order ASC
  `);
  return stmt.all(pipelineId, parallelGroup);
}

/**
 * Check if all steps in a parallel group are completed
 */
function isParallelGroupComplete(pipelineId, parallelGroup) {
  const steps = getParallelGroupSteps(pipelineId, parallelGroup);
  return steps.every(s => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped');
}

/**
 * Get next steps to run (handles both sequential and parallel)
 */
function getNextPipelineSteps(pipelineId) {
  // Get all pending steps
  const pendingSteps = db.prepare(`
    SELECT * FROM pipeline_steps
    WHERE pipeline_id = ? AND status = 'pending'
    ORDER BY step_order ASC
  `).all(pipelineId);

  if (pendingSteps.length === 0) return [];

  const firstStep = pendingSteps[0];

  // If first pending step has a parallel group, return all steps in that group
  if (firstStep.parallel_group) {
    return pendingSteps.filter(s => s.parallel_group === firstStep.parallel_group);
  }

  // Otherwise return just the first step (sequential)
  return [firstStep];
}

/**
 * Reconcile pipeline step status with actual task status
 * Fixes pipelines that are stuck due to cancelled tasks not updating step status
 * Returns count of fixed steps and failed pipelines
 */
function reconcilePipelineStepStatus() {
  const results = { stepsFixed: 0, pipelinesFailed: 0, errors: [] };

  // Find all pipeline steps that are marked as 'running' but their task is not running
  const stuckSteps = db.prepare(`
    SELECT ps.id as step_id, ps.pipeline_id, ps.task_id, ps.status as step_status,
           ps.name as step_name, ps.step_order,
           t.status as task_status, t.error_output,
           p.name as pipeline_name, p.status as pipeline_status
    FROM pipeline_steps ps
    JOIN tasks t ON ps.task_id = t.id
    JOIN pipelines p ON ps.pipeline_id = p.id
    WHERE ps.status = 'running'
      AND t.status IN ('cancelled', 'failed', 'completed')
  `).all();

  for (const step of stuckSteps) {
    try {
      // Determine new step status based on task status
      const newStepStatus = step.task_status === 'completed' ? 'completed' : 'failed';

      // Update the step status
      db.prepare(`UPDATE pipeline_steps SET status = ? WHERE id = ?`)
        .run(newStepStatus, step.step_id);

      results.stepsFixed++;

      // If task failed/cancelled, mark the pipeline as failed
      if (newStepStatus === 'failed' && step.pipeline_status === 'running') {
        const errorMsg = `Step ${step.step_order} (${step.step_name}) ${step.task_status}: ${(step.error_output || 'No error details').slice(0, 200)}`;
        db.prepare(`UPDATE pipelines SET status = 'failed', error = ? WHERE id = ?`)
          .run(errorMsg, step.pipeline_id);
        results.pipelinesFailed++;
      }
    } catch (err) {
      results.errors.push(`Step ${step.step_id}: ${err.message}`);
    }
  }

  return results;
}

// ============================================================
// Module exports
// ============================================================

module.exports = {
  setDb,
  setRecordEvent,
  createPipeline,
  getPipeline,
  addPipelineStep,
  getPipelineSteps,
  updatePipelineStatus,
  updatePipelineStep,
  transitionPipelineStepStatus,
  listPipelines,
  getNextPipelineStep,
  addParallelPipelineStep,
  getParallelGroupSteps,
  isParallelGroupComplete,
  getNextPipelineSteps,
  reconcilePipelineStepStatus,
};
