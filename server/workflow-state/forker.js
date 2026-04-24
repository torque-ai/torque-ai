'use strict';

const { randomUUID } = require('crypto');
const Ajv = require('ajv');

const ajv = new Ajv({ strict: false, allErrors: true });

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    return db;
  }

  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  throw new Error('workflow forker requires a database handle');
}

function normalizeRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }

  return value.trim();
}

function normalizeOptionalName(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('name must be a string');
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalStateOverrides(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isPlainObject(value)) {
    throw new Error('state_overrides must be an object');
  }

  return value;
}

function normalizeStateVersion(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 1;
}

function ensureForkSchema(dbHandle) {
  try {
    dbHandle.exec('ALTER TABLE workflows ADD COLUMN parent_workflow_id TEXT');
  } catch {
    // Column already exists.
  }

  try {
    dbHandle.exec('ALTER TABLE workflows ADD COLUMN fork_checkpoint_id TEXT');
  } catch {
    // Column already exists.
  }
}

function serializeJson(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error(`${label} must be JSON-serializable`);
    }
    return serialized;
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
}

function validateSeedState(schema, state) {
  if (!schema) {
    return;
  }

  const validate = ajv.compile(schema);
  const valid = validate(state);
  if (valid) {
    return;
  }

  const errorText = (validate.errors || [])
    .map((error) => `${error.instancePath || error.dataPath || error.schemaPath}: ${error.message}`)
    .join('; ');
  throw new Error(`Fork state failed schema validation: ${errorText}`);
}

function createForker({ db, checkpointStore, workflowState } = {}) {
  const dbHandle = resolveDbHandle(db);
  ensureForkSchema(dbHandle);

  if (!checkpointStore || typeof checkpointStore.getCheckpoint !== 'function') {
    throw new Error('workflow forker requires checkpointStore.getCheckpoint');
  }
  if (!workflowState || typeof workflowState.getMeta !== 'function' || typeof workflowState.setStateSchema !== 'function') {
    throw new Error('workflow forker requires workflowState getMeta/setStateSchema support');
  }

  const forkTransaction = dbHandle.transaction(({ checkpointId, name, stateOverrides }) => {
    const checkpoint = checkpointStore.getCheckpoint(normalizeRequiredString(checkpointId, 'checkpointId'));
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const sourceWorkflow = dbHandle.prepare(`
      SELECT *
      FROM workflows
      WHERE id = ?
    `).get(checkpoint.workflow_id);
    if (!sourceWorkflow) {
      throw new Error(`Source workflow not found: ${checkpoint.workflow_id}`);
    }

    const newWorkflowId = `wf_${randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    const workflowName = name || `${sourceWorkflow.name} (fork)`;

    dbHandle.prepare(`
      INSERT INTO workflows (
        id,
        name,
        description,
        working_directory,
        status,
        template_id,
        context,
        priority,
        created_at,
        parent_workflow_id,
        fork_checkpoint_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newWorkflowId,
      workflowName,
      sourceWorkflow.description || null,
      sourceWorkflow.working_directory || null,
      'pending',
      sourceWorkflow.template_id || null,
      sourceWorkflow.context || null,
      sourceWorkflow.priority || 0,
      createdAt,
      checkpoint.workflow_id,
      checkpoint.checkpoint_id,
    );

    const meta = workflowState.getMeta(checkpoint.workflow_id);
    const seedState = stateOverrides || checkpoint.state || {};
    validateSeedState(meta.schema, seedState);

    workflowState.setStateSchema(newWorkflowId, meta.schema, meta.reducers);
    dbHandle.prepare(`
      UPDATE workflow_state
      SET state_json = ?, version = ?, updated_at = ?
      WHERE workflow_id = ?
    `).run(
      serializeJson(seedState, 'state'),
      normalizeStateVersion(checkpoint.state_version),
      createdAt,
      newWorkflowId,
    );

    const checkpointRow = dbHandle.prepare(`
      SELECT rowid AS checkpoint_rowid
      FROM workflow_checkpoints
      WHERE checkpoint_id = ?
    `).get(checkpoint.checkpoint_id);
    if (!checkpointRow) {
      throw new Error(`Checkpoint row not found: ${checkpoint.checkpoint_id}`);
    }

    const completedStepIds = new Set(
      dbHandle.prepare(`
        SELECT DISTINCT step_id
        FROM workflow_checkpoints
        WHERE workflow_id = ?
          AND rowid <= ?
          AND step_id IS NOT NULL
      `).all(checkpoint.workflow_id, checkpointRow.checkpoint_rowid).map((row) => row.step_id),
    );

    const sourceTasks = dbHandle.prepare(`
      SELECT
        id,
        workflow_node_id,
        task_description,
        working_directory,
        timeout_minutes,
        auto_approve,
        priority,
        context,
        max_retries,
        depends_on,
        template_name,
        isolated_workspace,
        approval_status,
        tags,
        project,
        provider,
        model,
        complexity,
        review_status,
        ollama_host_id,
        original_provider,
        metadata,
        stall_timeout_seconds
      FROM tasks
      WHERE workflow_id = ?
      ORDER BY rowid ASC
    `).all(checkpoint.workflow_id);

    const taskIdMap = new Map();
    const insertTask = dbHandle.prepare(`
      INSERT INTO tasks (
        id,
        status,
        task_description,
        working_directory,
        timeout_minutes,
        auto_approve,
        priority,
        context,
        created_at,
        max_retries,
        depends_on,
        template_name,
        isolated_workspace,
        approval_status,
        tags,
        project,
        provider,
        model,
        complexity,
        review_status,
        ollama_host_id,
        original_provider,
        provider_switched_at,
        metadata,
        workflow_id,
        workflow_node_id,
        stall_timeout_seconds,
        resume_context
      )
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)
    `);

    for (const task of sourceTasks) {
      if (task.workflow_node_id && completedStepIds.has(task.workflow_node_id)) {
        continue;
      }

      const newTaskId = `task_${randomUUID().slice(0, 12)}`;
      taskIdMap.set(task.id, newTaskId);
      insertTask.run(
        newTaskId,
        task.task_description,
        task.working_directory || null,
        task.timeout_minutes ?? 480,
        task.auto_approve ? 1 : 0,
        task.priority || 0,
        task.context || null,
        createdAt,
        task.max_retries ?? 0,
        task.depends_on || null,
        task.template_name || null,
        task.isolated_workspace || null,
        task.approval_status || 'not_required',
        task.tags || '[]',
        task.project || null,
        task.provider || 'codex',
        task.model || null,
        task.complexity || 'normal',
        task.review_status || null,
        task.ollama_host_id || null,
        task.original_provider || task.provider || 'codex',
        task.metadata || null,
        newWorkflowId,
        task.workflow_node_id || null,
        task.stall_timeout_seconds ?? null,
      );
    }

    const sourceDependencies = dbHandle.prepare(`
      SELECT task_id, depends_on_task_id, condition_expr, on_fail, alternate_task_id
      FROM task_dependencies
      WHERE workflow_id = ?
      ORDER BY id ASC
    `).all(checkpoint.workflow_id);

    const insertDependency = dbHandle.prepare(`
      INSERT INTO task_dependencies (
        workflow_id,
        task_id,
        depends_on_task_id,
        condition_expr,
        on_fail,
        alternate_task_id,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const dependency of sourceDependencies) {
      const nextTaskId = taskIdMap.get(dependency.task_id);
      const nextDependsOnTaskId = taskIdMap.get(dependency.depends_on_task_id);
      if (!nextTaskId || !nextDependsOnTaskId) {
        continue;
      }

      insertDependency.run(
        newWorkflowId,
        nextTaskId,
        nextDependsOnTaskId,
        dependency.condition_expr || null,
        dependency.on_fail || 'skip',
        dependency.alternate_task_id ? (taskIdMap.get(dependency.alternate_task_id) || null) : null,
        createdAt,
      );
    }

    dbHandle.prepare(`
      UPDATE workflows
      SET total_tasks = ?, completed_tasks = 0, failed_tasks = 0, skipped_tasks = 0
      WHERE id = ?
    `).run(taskIdMap.size, newWorkflowId);

    return {
      new_workflow_id: newWorkflowId,
      resumes_from_step: checkpoint.step_id || null,
      cloned_step_count: taskIdMap.size,
    };
  });

  function fork({ checkpointId, name = null, state_overrides = null } = {}) {
    return forkTransaction({
      checkpointId,
      name: normalizeOptionalName(name),
      stateOverrides: normalizeOptionalStateOverrides(state_overrides),
    });
  }

  return { fork };
}

module.exports = { createForker };
