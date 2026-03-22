'use strict';

/**
 * Workflow Engine Module
 *
 * Extracted from database.js — workflow DAG lifecycle, task dependencies,
 * condition evaluation, workflow templates, and execution history.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Self-contained: all 27 functions only use db.prepare() and call each other.
 */

const logger = require('../logger').child({ component: 'workflow-engine' });
const { safeJsonParse } = require('../utils/json');

let db;

function setDb(dbInstance) {
  db = dbInstance;
}

// ============================================
// Workflow CRUD
// ============================================

function createWorkflow(workflow) {
  const stmt = db.prepare(`
    INSERT INTO workflows (id, name, description, working_directory, status, template_id, context, priority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    workflow.id,
    workflow.name,
    workflow.description || null,
    workflow.working_directory || null,
    workflow.status || 'pending',
    workflow.template_id || null,
    workflow.context ? JSON.stringify(workflow.context) : null,
    workflow.priority || 0,
    new Date().toISOString()
  );

  return getWorkflow(workflow.id);
}

/**
 * Get a workflow by ID
 * @param {any} workflowId
 * @returns {any}
 */
function getWorkflow(workflowId) {
  const stmt = db.prepare('SELECT * FROM workflows WHERE id = ?');
  const workflow = stmt.get(workflowId);
  if (workflow) {
    workflow.context = safeJsonParse(workflow.context, null);
  }
  return workflow;
}

/**
 * Count tasks attached to a workflow.
 * @param {string} workflowId
 * @returns {number}
 */
function getWorkflowTaskCount(workflowId) {
  const row = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE workflow_id = ?').get(workflowId);
  return Number(row?.count || 0);
}

/**
 * Find the newest workflow placeholder with no tasks for a given name/status pair.
 * @param {string} name
 * @param {string} status
 * @returns {any}
 */
function findEmptyWorkflowPlaceholder(name, status = 'pending') {
  const stmt = db.prepare(`
    SELECT w.*
    FROM workflows w
    LEFT JOIN tasks t ON t.workflow_id = w.id
    WHERE w.name = ? AND w.status = ?
    GROUP BY w.id
    HAVING COUNT(t.id) = 0
    ORDER BY w.created_at DESC
    LIMIT 1
  `);
  const workflow = stmt.get(name, status);
  if (workflow) {
    workflow.context = safeJsonParse(workflow.context, null);
  }
  return workflow;
}

/**
 * Update workflow fields in-place (non-atomic).
 *
 * This function is intentionally non-transactional for simple, single-field
 * updates (e.g., setting a status after a terminal task completes).
 *
 * However, callers that need to update the workflow status AND additional fields
 * in one safe step should use transitionWorkflowStatus() instead, which performs
 * an atomic compare-and-swap (UPDATE … WHERE status = ?) to prevent races.
 *
 * Known dual-call pattern in updateWorkflowCounts:
 *   updateWorkflow(id, counts)  ← count fields
 *   updateWorkflow(id, { status, completed_at })  ← terminal transition
 *
 * These two writes are not atomic. Under high concurrency two workers could
 * both read "running" status and both call updateWorkflow to "completed".
 * This is acceptable for the current architecture where workflows are
 * single-session, but if workflow processing becomes truly concurrent,
 * both calls should be merged into a single transitionWorkflowStatus() call.
 *
 * @param {any} workflowId
 * @param {any} updates
 * @returns {any}
 */
function updateWorkflow(workflowId, updates) {
  const fields = [];
  const values = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.total_tasks !== undefined) {
    fields.push('total_tasks = ?');
    values.push(updates.total_tasks);
  }
  if (updates.completed_tasks !== undefined) {
    fields.push('completed_tasks = ?');
    values.push(updates.completed_tasks);
  }
  if (updates.failed_tasks !== undefined) {
    fields.push('failed_tasks = ?');
    values.push(updates.failed_tasks);
  }
  if (updates.skipped_tasks !== undefined) {
    fields.push('skipped_tasks = ?');
    values.push(updates.skipped_tasks);
  }
  if (updates.started_at !== undefined) {
    fields.push('started_at = ?');
    values.push(updates.started_at);
  }
  if (updates.completed_at !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completed_at);
  }
  if (updates.context !== undefined) {
    fields.push('context = ?');
    values.push(JSON.stringify(updates.context));
  }
  if (updates.priority !== undefined) {
    fields.push('priority = ?');
    values.push(updates.priority);
  }
  if (updates.economy_policy !== undefined) {
    fields.push('economy_policy = ?');
    values.push(updates.economy_policy);
  }

  if (fields.length === 0) return getWorkflow(workflowId);

  values.push(workflowId);
  const stmt = db.prepare(`UPDATE workflows SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getWorkflow(workflowId);
}

/**
 * Atomic workflow status transition to prevent race conditions
 * @param {string} workflowId - Workflow ID
 * @param {string} fromStatus - Expected current status (or array of valid statuses)
 * @param {string} toStatus - Target status
 * @param {Object} additionalUpdates - Additional fields to update
 * @returns {boolean} True if transition succeeded, false if status didn't match
 */
function transitionWorkflowStatus(workflowId, fromStatus, toStatus, additionalUpdates = {}) {
  const fields = ['status = ?'];
  const values = [toStatus];

  const ALLOWED_COLUMNS = new Set(['name', 'description', 'status', 'context', 'economy_policy', 'error_message', 'completed_at']);

  // Add additional updates
  for (const [key, value] of Object.entries(additionalUpdates)) {
    if (!ALLOWED_COLUMNS.has(key)) continue;
    if (key === 'context') {
      fields.push('context = ?');
      values.push(JSON.stringify(value));
    } else {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  values.push(workflowId);

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

  const stmt = db.prepare(`UPDATE workflows SET ${fields.join(', ')} WHERE ${whereClause}`);
  const result = stmt.run(...values);

  return result.changes > 0;
}

let _lastReconcile = 0;
const RECONCILE_DEBOUNCE_MS = 30000; // 30s

/**
 * List workflows with filters
 * @param {any} options
 * @returns {any}
 */
function listWorkflows(options = {}) {
  // Heal stale workflows before listing so status views are accurate.
  // Debounced to avoid hammering the DB on every list call.
  if (Date.now() - _lastReconcile > RECONCILE_DEBOUNCE_MS) {
    reconcileStaleWorkflows();
    _lastReconcile = Date.now();
  }

  let sql = 'SELECT * FROM workflows WHERE 1=1';
  const params = [];

  if (options.status) {
    sql += ' AND status = ?';
    params.push(options.status);
  }
  if (options.template_id) {
    sql += ' AND template_id = ?';
    params.push(options.template_id);
  }
  if (options.since) {
    sql += ' AND created_at >= ?';
    params.push(options.since);
  }

  sql += ' ORDER BY created_at DESC';

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const stmt = db.prepare(sql);
  const workflows = stmt.all(...params);

  return workflows.map(w => {
    w.context = safeJsonParse(w.context, null);
    return w;
  });
}

/**
 * Reconcile active workflows whose tasks are already terminal.
 * This can happen after manual DB updates or partial recovery paths.
 * Returns the count of workflows reconciled.
 *
 * Perf: uses a single JOIN + GROUP BY query to get per-workflow status counts
 * instead of calling getWorkflowTasks (which fetches all columns including output
 * blobs) once per workflow (N+1 pattern).
 *
 * @param {string|null} workflowId Optional workflow ID to scope reconciliation
 */
function reconcileStaleWorkflows(workflowId = null) {
  const filter = workflowId ? 'AND w.id = ?' : '';

  // Single query: for each active workflow, count tasks by terminal vs non-terminal.
  // Only includes workflows that have at least one task.
  const rows = db.prepare(`
    SELECT
      w.id,
      w.status,
      COUNT(t.id)                                                       AS total,
      SUM(CASE WHEN t.status IN ('completed','failed','cancelled','skipped') THEN 1 ELSE 0 END) AS terminal_count,
      SUM(CASE WHEN t.status = 'failed'    THEN 1 ELSE 0 END)          AS failed_count,
      SUM(CASE WHEN t.status = 'cancelled' THEN 1 ELSE 0 END)          AS cancelled_count
    FROM workflows w
    JOIN tasks t ON t.workflow_id = w.id
    WHERE w.status IN ('pending', 'running', 'paused') ${filter}
    GROUP BY w.id
  `).all(...(workflowId ? [workflowId] : []));

  let reconciled = 0;
  for (const row of rows) {
    if (row.terminal_count < row.total) {
      continue; // Some tasks still active — workflow is not done
    }

    const finalStatus = row.failed_count > 0 ? 'failed'
      : row.cancelled_count === row.total ? 'cancelled'
        : 'completed';
    updateWorkflow(row.id, {
      status: finalStatus,
      completed_at: new Date().toISOString()
    });
    updateWorkflowCounts(row.id);
    reconciled += 1;
  }

  return reconciled;
}

/**
 * Delete a workflow
 */
function deleteWorkflow(workflowId) {
  const deleteOp = db.transaction(() => {
    // Nullify task workflow_id to avoid FK violations
    db.prepare('UPDATE tasks SET workflow_id = NULL WHERE workflow_id = ?').run(workflowId);
    db.prepare('DELETE FROM task_dependencies WHERE workflow_id = ?').run(workflowId);
    const result = db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId);
    return result.changes > 0;
  });
  return deleteOp();
}

/**
 * Delete workflows older than the retention period that are in terminal states.
 * @param {number} retentionDays - Days to keep completed/failed workflows (default: 30)
 * @returns {{ deleted: number }} Number of workflows deleted
 */
function cleanupOldWorkflows(retentionDays = 30) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const cleanup = db.transaction(() => {
    const oldWorkflows = db.prepare(
      `SELECT id FROM workflows WHERE status IN ('completed', 'failed', 'cancelled') AND created_at < ?`
    ).all(cutoff);

    let deleted = 0;
    for (const wf of oldWorkflows) {
      // Nullify task workflow_id to avoid FK violations
      db.prepare('UPDATE tasks SET workflow_id = NULL WHERE workflow_id = ?').run(wf.id);
      db.prepare('DELETE FROM task_dependencies WHERE workflow_id = ?').run(wf.id);
      db.prepare('DELETE FROM workflows WHERE id = ?').run(wf.id);
      deleted++;
    }
    return deleted;
  });

  return { deleted: cleanup() };
}

// ============================================
// Dependency Graph (DAG)
// ============================================

/**
 * Detect if adding a dependency would create a cycle
 * Uses DFS with path tracking for proper cycle detection
 * @param {string} taskId - The task that would have a new dependency
 * @param {string} dependsOnTaskId - The task it would depend on
 * @param {string} workflowId - The workflow context
 * @returns {boolean} True if adding this dependency would create a cycle
 */
function wouldCreateCycle(taskId, dependsOnTaskId, workflowId) {
  // Self-dependency is always a cycle
  if (taskId === dependsOnTaskId) return true;

  // Get all existing dependencies in the workflow
  const allDeps = getWorkflowDependencies(workflowId);

  // Build adjacency list: task -> tasks it depends on
  const graph = new Map();
  for (const dep of allDeps) {
    if (!graph.has(dep.task_id)) {
      graph.set(dep.task_id, []);
    }
    graph.get(dep.task_id).push(dep.depends_on_task_id);
  }

  // Add the proposed dependency to the graph
  if (!graph.has(taskId)) {
    graph.set(taskId, []);
  }
  graph.get(taskId).push(dependsOnTaskId);

  // DFS to detect if taskId is reachable from dependsOnTaskId
  // (which would mean dependsOnTaskId -> ... -> taskId -> dependsOnTaskId = cycle)
  const visited = new Set();
  const inPath = new Set();

  function hasCycle(node) {
    if (inPath.has(node)) return true;  // Back edge = cycle
    if (visited.has(node)) return false; // Already fully explored

    visited.add(node);
    inPath.add(node);

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      if (hasCycle(neighbor)) return true;
    }

    inPath.delete(node);
    return false;
  }

  // Check for cycles starting from the task that would have the new dependency
  return hasCycle(taskId);
}

/**
 * Add a task dependency
 * @param {object} dependency - Dependency definition.
 * @returns {number} Inserted dependency identifier.
 */
function addTaskDependency(dependency) {
  // Check for cycles before adding the dependency
  if (wouldCreateCycle(dependency.task_id, dependency.depends_on_task_id, dependency.workflow_id)) {
    throw new Error(`Cannot add dependency: would create a circular dependency`);
  }

  const stmt = db.prepare(`
    INSERT INTO task_dependencies (
      workflow_id, task_id, depends_on_task_id,
      condition_expr, on_fail, alternate_task_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    dependency.workflow_id,
    dependency.task_id,
    dependency.depends_on_task_id,
    dependency.condition_expr || null,
    dependency.on_fail || 'skip',
    dependency.alternate_task_id || null,
    new Date().toISOString()
  );

  return result.lastInsertRowid;
}

/**
 * Get dependencies for a task (what it depends on)
 * @param {any} taskId
 * @returns {any}
 */
function getTaskDependencies(taskId) {
  const stmt = db.prepare(`
    SELECT td.*, t.status as depends_on_status, t.exit_code as depends_on_exit_code,
           t.output as depends_on_output, t.error_output as depends_on_error_output,
           t.started_at as depends_on_started_at, t.completed_at as depends_on_completed_at
    FROM task_dependencies td
    LEFT JOIN tasks t ON td.depends_on_task_id = t.id
    WHERE td.task_id = ?
  `);
  return stmt.all(taskId);
}

/**
 * Get dependents of a task (tasks that depend on this one)
 * @param {any} taskId
 * @returns {any}
 */
function getTaskDependents(taskId) {
  const stmt = db.prepare(`
    SELECT td.*, t.status as dependent_status
    FROM task_dependencies td
    LEFT JOIN tasks t ON td.task_id = t.id
    WHERE td.depends_on_task_id = ?
  `);
  return stmt.all(taskId);
}

/**
 * Get all dependencies for a workflow
 * @param {any} workflowId
 * @returns {any}
 */
function getWorkflowDependencies(workflowId) {
  const stmt = db.prepare('SELECT * FROM task_dependencies WHERE workflow_id = ?');
  return stmt.all(workflowId);
}

/**
 * Delete a task dependency
 */
function deleteTaskDependency(dependencyId) {
  const result = db.prepare('DELETE FROM task_dependencies WHERE id = ?').run(dependencyId);
  return result.changes > 0;
}

// ============================================
// Workflow Task Queries
// ============================================

/**
 * Get tasks in a workflow
 * @param {any} workflowId
 * @returns {any}
 */
function getWorkflowTasks(workflowId) {
  const stmt = db.prepare(`
    SELECT * FROM tasks WHERE workflow_id = ?
    ORDER BY created_at ASC
  `);
  return stmt.all(workflowId).map(t => {
    if (t.tags) {
      try { t.tags = JSON.parse(t.tags); } catch { t.tags = []; }
    }
    t.context = safeJsonParse(t.context, null);
    if (t.files_modified) {
      try { t.files_modified = JSON.parse(t.files_modified); } catch { t.files_modified = []; }
    }
    return t;
  });
}

/**
 * Get blocked tasks (waiting on dependencies)
 * @param {any} workflowId
 * @returns {any}
 */
function getBlockedTasks(workflowId = null) {
  let sql = `SELECT * FROM tasks WHERE status = 'blocked'`;
  const params = [];

  if (workflowId) {
    sql += ' AND workflow_id = ?';
    params.push(workflowId);
  }

  sql += ' ORDER BY created_at ASC';

  const stmt = db.prepare(sql);
  return stmt.all(...params).map(t => {
    if (t.tags) {
      try { t.tags = JSON.parse(t.tags); } catch { t.tags = []; }
    }
    t.context = safeJsonParse(t.context, null);
    return t;
  });
}

/**
 * Check if all dependencies of a task are satisfied
 * @param {string} taskId - Task identifier.
 * @returns {object} Dependency evaluation result.
 */
function areTaskDependenciesSatisfied(taskId) {
  const deps = getTaskDependencies(taskId);
  if (deps.length === 0) return { satisfied: true, deps: [] };

  for (const dep of deps) {
    const status = dep.depends_on_status;
    // Terminal states that allow dependency evaluation
    if (!['completed', 'failed', 'cancelled', 'skipped'].includes(status)) {
      return { satisfied: false, deps, waiting_on: dep.depends_on_task_id };
    }
  }

  return { satisfied: true, deps };
}

// ============================================
// Condition Evaluation (Safe AST-based)
// ============================================

/**
 * Evaluate a condition expression against task context
 * Safe AST-based evaluation (no arbitrary code execution)
 */
const MAX_EXPRESSION_LENGTH = 10240; // 10KB max expression length

function evaluateCondition(expression, context) {
  if (!expression) return true; // No condition = always passes

  // Security: Limit expression length to prevent DoS via large expressions
  if (typeof expression !== 'string' || expression.length > MAX_EXPRESSION_LENGTH) {
    logger.warn(`Expression too large or invalid: ${typeof expression === 'string' ? expression.length : typeof expression}`);
    return false;
  }

  try {
    // Tokenize
    const tokens = tokenizeExpression(expression);
    // Parse to AST
    const ast = parseExpression(tokens);
    // Evaluate
    return evaluateAST(ast, context);
  } catch (err) {
    logger.warn(`Condition evaluation error: ${err.message}`);
    return false; // Invalid expressions fail
  }
}

/**
 * Tokenize expression string
 */
function tokenizeExpression(expr) {
  const tokens = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) {
      i++;
      continue;
    }

    // Operators
    if (expr.slice(i, i + 2) === '==') { tokens.push({ type: 'OP', value: '==' }); i += 2; continue; }
    if (expr.slice(i, i + 2) === '!=') { tokens.push({ type: 'OP', value: '!=' }); i += 2; continue; }
    if (expr.slice(i, i + 2) === '>=') { tokens.push({ type: 'OP', value: '>=' }); i += 2; continue; }
    if (expr.slice(i, i + 2) === '<=') { tokens.push({ type: 'OP', value: '<=' }); i += 2; continue; }
    if (expr[i] === '>') { tokens.push({ type: 'OP', value: '>' }); i++; continue; }
    if (expr[i] === '<') { tokens.push({ type: 'OP', value: '<' }); i++; continue; }

    // Logical operators — only match when the keyword is followed by a non-word character
    // (prevents splitting identifiers like ANDROID into AND + ROID)
    if (expr.slice(i, i + 3).toUpperCase() === 'AND' && !/\w/.test(expr[i + 3] || '')) { tokens.push({ type: 'LOGIC', value: 'AND' }); i += 3; continue; }
    if (expr.slice(i, i + 2).toUpperCase() === 'OR' && !/\w/.test(expr[i + 2] || '')) { tokens.push({ type: 'LOGIC', value: 'OR' }); i += 2; continue; }
    if (expr.slice(i, i + 3).toUpperCase() === 'NOT' && !/\w/.test(expr[i + 3] || '')) { tokens.push({ type: 'NOT', value: 'NOT' }); i += 3; continue; }

    // Parentheses
    if (expr[i] === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
    if (expr[i] === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }

    // String methods: .contains('...') or .matches('...')
    // Use a quote-aware scan to find the closing quote, so args containing ')' are handled correctly.
    if (expr.slice(i, i + 10) === '.contains(') {
      i += 10;
      if (expr[i] !== "'") throw new Error('Expected single-quoted argument in .contains()');
      i++; // skip opening quote
      let arg = '';
      while (i < expr.length) {
        if (expr[i] === "'") {
          i++; // skip closing quote
          if (expr[i] !== ')') throw new Error('Expected ) after closing quote in .contains()');
          i++; // skip closing paren
          break;
        }
        arg += expr[i++];
      }
      tokens.push({ type: 'METHOD', value: 'contains', arg });
      continue;
    }
    if (expr.slice(i, i + 9) === '.matches(') {
      i += 9;
      if (expr[i] !== "'") throw new Error('Expected single-quoted argument in .matches()');
      i++; // skip opening quote
      let arg = '';
      while (i < expr.length) {
        if (expr[i] === "'") {
          i++; // skip closing quote
          if (expr[i] !== ')') throw new Error('Expected ) after closing quote in .matches()');
          i++; // skip closing paren
          break;
        }
        arg += expr[i++];
      }
      tokens.push({ type: 'METHOD', value: 'matches', arg });
      continue;
    }

    // Numbers — support integers, decimals (3.5), and negative numbers (-1)
    if (/\d/.test(expr[i]) || (expr[i] === '-' && /\d/.test(expr[i + 1] || ''))) {
      let num = '';
      if (expr[i] === '-') num += expr[i++];
      while (i < expr.length && /\d/.test(expr[i])) {
        num += expr[i++];
      }
      if (i < expr.length && expr[i] === '.' && /\d/.test(expr[i + 1] || '')) {
        num += expr[i++]; // decimal point
        while (i < expr.length && /\d/.test(expr[i])) {
          num += expr[i++];
        }
        tokens.push({ type: 'NUMBER', value: parseFloat(num) });
      } else {
        tokens.push({ type: 'NUMBER', value: parseInt(num, 10) });
      }
      continue;
    }

    // Strings (single quoted)
    if (expr[i] === "'") {
      i++;
      let str = '';
      while (i < expr.length && expr[i] !== "'") {
        str += expr[i++];
      }
      i++; // Skip closing quote
      tokens.push({ type: 'STRING', value: str });
      continue;
    }

    // Identifiers (variable names)
    if (/[a-zA-Z_]/.test(expr[i])) {
      let id = '';
      while (i < expr.length && /[a-zA-Z_0-9]/.test(expr[i])) {
        id += expr[i++];
      }
      tokens.push({ type: 'IDENT', value: id });
      continue;
    }

    throw new Error(`Unexpected character: ${expr[i]}`);
  }

  return tokens;
}

/**
 * Parse tokens into AST (simple recursive descent)
 */
function parseExpression(tokens) {
  let pos = 0;

  function parseOr() {
    let left = parseAnd();
    while (pos < tokens.length && tokens[pos].type === 'LOGIC' && tokens[pos].value === 'OR') {
      pos++;
      const right = parseAnd();
      left = { type: 'OR', left, right };
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (pos < tokens.length && tokens[pos].type === 'LOGIC' && tokens[pos].value === 'AND') {
      pos++;
      const right = parseNot();
      left = { type: 'AND', left, right };
    }
    return left;
  }

  function parseNot() {
    if (pos < tokens.length && tokens[pos].type === 'NOT') {
      pos++;
      return { type: 'NOT', operand: parseNot() };
    }
    return parseComparison();
  }

  function parseComparison() {
    const left = parsePrimary();
    if (pos < tokens.length && tokens[pos].type === 'OP') {
      const op = tokens[pos++].value;
      const right = parsePrimary();
      return { type: 'COMPARE', op, left, right };
    }
    // Check for method call on identifier
    if (pos < tokens.length && tokens[pos].type === 'METHOD') {
      const method = tokens[pos++];
      return { type: 'METHOD_CALL', target: left, method: method.value, arg: method.arg };
    }
    return left;
  }

  function parsePrimary() {
    if (pos >= tokens.length) throw new Error('Unexpected end of expression');

    const token = tokens[pos];

    if (token.type === 'LPAREN') {
      pos++;
      const expr = parseOr();
      if (tokens[pos]?.type !== 'RPAREN') throw new Error('Missing closing parenthesis');
      pos++;
      return expr;
    }

    if (token.type === 'NUMBER') {
      pos++;
      return { type: 'LITERAL', value: token.value };
    }

    if (token.type === 'STRING') {
      pos++;
      return { type: 'LITERAL', value: token.value };
    }

    if (token.type === 'IDENT') {
      pos++;
      return { type: 'VAR', name: token.value };
    }

    throw new Error(`Unexpected token: ${JSON.stringify(token)}`);
  }

  const result = parseOr();
  if (pos < tokens.length) {
    throw new Error(`Unexpected token at end: ${JSON.stringify(tokens[pos])}`);
  }
  return result;
}

/**
 * Evaluate AST against context
 */
function evaluateAST(ast, context) {
  switch (ast.type) {
    case 'LITERAL':
      return ast.value;

    case 'VAR': {
      // Security: Handle undefined/null context variables safely
      const value = context[ast.name];
      // Return null for undefined to make comparisons more predictable
      // undefined == null is true, but undefined === null is false
      return value === undefined ? null : value;
    }

    case 'COMPARE': {
      const left = evaluateAST(ast.left, context);
      const right = evaluateAST(ast.right, context);
      // Handle null comparisons safely - null only equals null
      if (left === null || right === null) {
        // For equality, allow null == null
        if (ast.op === '==') return left === right;
        if (ast.op === '!=') return left !== right;
        // For relational comparisons, null comparisons return false
        return false;
      }
      switch (ast.op) {
        case '==': return left === right;
        case '!=': return left !== right;
        case '>': return left > right;
        case '<': return left < right;
        case '>=': return left >= right;
        case '<=': return left <= right;
        default: throw new Error(`Unknown operator: ${ast.op}`);
      }
    }

    case 'METHOD_CALL': {
      const target = evaluateAST(ast.target, context);
      if (typeof target !== 'string') return false;
      if (ast.method === 'contains') {
        return target.includes(ast.arg);
      }
      if (ast.method === 'matches') {
        try {
          // ReDoS protection: limit pattern length and detect dangerous patterns
          const pattern = ast.arg;
          if (typeof pattern !== 'string' || pattern.length > 200) {
            return false; // Pattern too long - potential ReDoS
          }
          // Detect potentially dangerous nested quantifiers like (a+)+, (a*)*
          // These can cause exponential backtracking
          if (/(\+|\*|\?|\{[^}]+\})\s*\)(\+|\*|\{[^}]+\})/.test(pattern) ||
              /\(\?[^)]*\)\+/.test(pattern)) {
            return false; // Potentially dangerous pattern
          }
          return new RegExp(pattern).test(target);
        } catch {
          return false;
        }
      }
      throw new Error(`Unknown method: ${ast.method}`);
    }

    case 'AND':
      return evaluateAST(ast.left, context) && evaluateAST(ast.right, context);

    case 'OR':
      return evaluateAST(ast.left, context) || evaluateAST(ast.right, context);

    case 'NOT':
      return !evaluateAST(ast.operand, context);

    default:
      throw new Error(`Unknown AST node type: ${ast.type}`);
  }
}

// ============================================
// Workflow Status & Counts
// ============================================

/**
 * Update workflow task counts
 * Perf: uses a single GROUP BY aggregate query instead of fetching full task rows
 * (avoids pulling output/error_output blobs from tasks just to count statuses).
 * @param {any} workflowId
 * @returns {any}
 */
function updateWorkflowCounts(workflowId) {
  // Guard: skip if workflow is already in a terminal state to prevent double-completion fires.
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { total_tasks: 0, completed_tasks: 0, failed_tasks: 0, skipped_tasks: 0 };

  // Aggregate status counts in one round-trip — no blob columns loaded.
  const statusRows = db.prepare(
    'SELECT status, COUNT(*) as cnt FROM tasks WHERE workflow_id = ? GROUP BY status'
  ).all(workflowId);

  const statusMap = {};
  let total = 0;
  for (const row of statusRows) {
    statusMap[row.status] = row.cnt;
    total += row.cnt;
  }

  const counts = {
    total_tasks: total,
    completed_tasks: statusMap['completed'] || 0,
    failed_tasks: statusMap['failed'] || 0,
    skipped_tasks: statusMap['skipped'] || 0
  };

  if (['completed', 'failed', 'cancelled'].includes(workflow.status)) {
    // Return current counts without modifying status.
    return counts;
  }

  updateWorkflow(workflowId, counts);

  // Check if workflow should complete
  const nonTerminalCount = Object.entries(statusMap)
    .filter(([s]) => !['completed', 'failed', 'cancelled', 'skipped'].includes(s))
    .reduce((sum, [, n]) => sum + n, 0);

  if (nonTerminalCount === 0 && total > 0) {
    const cancelledCount = statusMap['cancelled'] || 0;
    const failed = counts.failed_tasks > 0;
    // All-cancelled with no failures → cancelled (not completed)
    const finalStatus = failed ? 'failed' : cancelledCount === total ? 'cancelled' : 'completed';
    updateWorkflow(workflowId, {
      status: finalStatus,
      completed_at: new Date().toISOString()
    });
  }

  return counts;
}

/**
 * Get workflow status with task breakdown
 * @param {any} workflowId
 * @returns {any}
 */
function getWorkflowStatus(workflowId) {
  let workflow = getWorkflow(workflowId);
  if (!workflow) return null;
  if (['pending', 'running', 'paused'].includes(workflow.status)) {
    const reconciledCount = reconcileStaleWorkflows(workflowId);
    if (reconciledCount > 0) {
      workflow = getWorkflow(workflowId);
    }
  }

  const tasks = getWorkflowTasks(workflowId);
  const dependencies = getWorkflowDependencies(workflowId);

  // Build dependency lookup: task_id → [depends_on_node_ids]
  const depsByTaskId = {};
  for (const dep of dependencies) {
    if (!depsByTaskId[dep.task_id]) depsByTaskId[dep.task_id] = [];
    // Resolve task_id → node_id for the dependency
    const depTask = tasks.find(t => t.id === dep.depends_on_task_id);
    if (depTask) depsByTaskId[dep.task_id].push(depTask.workflow_node_id);
  }

  // Build task status map
  const taskStatuses = {};
  for (const task of tasks) {
    taskStatuses[task.id] = {
      id: task.id,
      node_id: task.workflow_node_id,
      status: task.status,
      description: task.task_description,
      exit_code: task.exit_code,
      progress: task.progress_percent,
      provider: task.provider || null,
      depends_on: depsByTaskId[task.id] || []
    };
  }

  return {
    ...workflow,
    tasks: taskStatuses,
    dependencies: dependencies.map(d => ({
      from: d.depends_on_task_id,
      to: d.task_id,
      condition: d.condition_expr,
      on_fail: d.on_fail
    })),
    summary: {
      total: tasks.length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      running: tasks.filter(t => t.status === 'running').length,
      blocked: tasks.filter(t => t.status === 'blocked').length,
      pending: tasks.filter(t => t.status === 'pending').length,
      skipped: tasks.filter(t => t.status === 'skipped').length
    }
  };
}

// ============================================
// Workflow Templates
// ============================================

/**
 * Create a workflow template
 */
function createWorkflowTemplate(template) {
  const stmt = db.prepare(`
    INSERT INTO workflow_templates (
      id, name, description, task_definitions, dependency_graph,
      default_conditions, variables, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    template.id,
    template.name,
    template.description || null,
    JSON.stringify(template.task_definitions),
    JSON.stringify(template.dependency_graph),
    template.default_conditions ? JSON.stringify(template.default_conditions) : null,
    template.variables ? JSON.stringify(template.variables) : null,
    new Date().toISOString()
  );

  return getWorkflowTemplate(template.id);
}

/**
 * Get a workflow template
 * @param {any} templateId
 * @returns {any}
 */
function getWorkflowTemplate(templateId) {
  const stmt = db.prepare('SELECT * FROM workflow_templates WHERE id = ?');
  const template = stmt.get(templateId);
  if (template) {
    template.task_definitions = safeJsonParse(template.task_definitions, []);
    template.dependency_graph = safeJsonParse(template.dependency_graph, {});
    if (template.default_conditions) template.default_conditions = safeJsonParse(template.default_conditions, {});
    if (template.variables) template.variables = safeJsonParse(template.variables, {});
  }
  return template;
}

/**
 * Get template by name
 * @param {any} name
 * @returns {any}
 */
function getWorkflowTemplateByName(name) {
  const stmt = db.prepare('SELECT * FROM workflow_templates WHERE name = ?');
  const template = stmt.get(name);
  if (template) {
    template.task_definitions = safeJsonParse(template.task_definitions, []);
    template.dependency_graph = safeJsonParse(template.dependency_graph, {});
    if (template.default_conditions) template.default_conditions = safeJsonParse(template.default_conditions, {});
    if (template.variables) template.variables = safeJsonParse(template.variables, {});
  }
  return template;
}

/**
 * List workflow templates
 * @param {any} options
 * @returns {any}
 */
function listWorkflowTemplates(options = {}) {
  let sql = 'SELECT * FROM workflow_templates';
  const params = [];

  if (options.filter) {
    const escaped = String(options.filter).replace(/[%_]/g, '\\$&');
    sql += ` WHERE name LIKE ? ESCAPE '\\'`;
    params.push(`%${escaped}%`);
  }

  sql += ' ORDER BY name ASC';

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const stmt = db.prepare(sql);
  return stmt.all(...params).map(t => {
    t.task_definitions = safeJsonParse(t.task_definitions, []);
    t.dependency_graph = safeJsonParse(t.dependency_graph, {});
    if (t.default_conditions) t.default_conditions = safeJsonParse(t.default_conditions, {});
    if (t.variables) t.variables = safeJsonParse(t.variables, {});
    return t;
  });
}

/**
 * Delete a workflow template
 */
function deleteWorkflowTemplate(templateId) {
  const result = db.prepare('DELETE FROM workflow_templates WHERE id = ?').run(templateId);
  return result.changes > 0;
}

// ============================================
// Workflow History
// ============================================

/**
 * Get workflow execution history (timeline of events)
 * @param {any} workflowId
 * @returns {any}
 */
function getWorkflowHistory(workflowId) {
  const tasks = getWorkflowTasks(workflowId);
  const events = [];

  for (const task of tasks) {
    if (task.created_at) {
      events.push({
        timestamp: task.created_at,
        type: 'task_created',
        task_id: task.id,
        node_id: task.workflow_node_id,
        details: task.task_description
      });
    }
    if (task.started_at) {
      events.push({
        timestamp: task.started_at,
        type: 'task_started',
        task_id: task.id,
        node_id: task.workflow_node_id
      });
    }
    if (task.completed_at) {
      events.push({
        timestamp: task.completed_at,
        type: task.status === 'completed' ? 'task_completed' :
              task.status === 'failed' ? 'task_failed' :
              task.status === 'skipped' ? 'task_skipped' : 'task_ended',
        task_id: task.id,
        node_id: task.workflow_node_id,
        exit_code: task.exit_code
      });
    }
  }

  // L-10: Merge workflow-level events from coordination_events table
  try {
    const safeId = String(workflowId).replace(/[%_]/g, '\\$&');
    const coordEvents = db.prepare(`
      SELECT event_type, details, created_at
      FROM coordination_events
      WHERE event_type IN ('workflow_started', 'workflow_paused', 'workflow_cancelled')
        AND details LIKE ? ESCAPE '\\'
      ORDER BY created_at ASC
    `).all(`%"workflow_id":"${safeId}"%`);

    for (const ce of coordEvents) {
      let parsed = null;
      try { parsed = JSON.parse(ce.details); } catch { /* ignore */ }
      // Only include events for this workflow
      if (parsed && parsed.workflow_id === workflowId) {
        events.push({
          timestamp: ce.created_at,
          type: ce.event_type,
          details: parsed
        });
      }
    }
  } catch {
    // coordination_events table may not exist in test environments — non-critical
  }

  // Sort by timestamp
  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return events;
}

// ============================================
// Module Exports
// ============================================

module.exports = {
  setDb,
  createWorkflow,
  getWorkflow,
  getWorkflowTaskCount,
  findEmptyWorkflowPlaceholder,
  updateWorkflow,
  transitionWorkflowStatus,
  listWorkflows,
  deleteWorkflow,
  cleanupOldWorkflows,
  wouldCreateCycle,
  addTaskDependency,
  getTaskDependencies,
  getTaskDependents,
  getWorkflowDependencies,
  deleteTaskDependency,
  getWorkflowTasks,
  getBlockedTasks,
  areTaskDependenciesSatisfied,
  evaluateCondition,
  tokenizeExpression,
  parseExpression,
  evaluateAST,
  updateWorkflowCounts,
  reconcileStaleWorkflows,
  getWorkflowStatus,
  createWorkflowTemplate,
  getWorkflowTemplate,
  getWorkflowTemplateByName,
  listWorkflowTemplates,
  deleteWorkflowTemplate,
  getWorkflowHistory
};
