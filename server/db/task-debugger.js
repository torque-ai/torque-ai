'use strict';

/**
 * Task Debugger Module
 *
 * Extracted from task-metadata.js — breakpoints, debug sessions,
 * captures, and debug state inspection.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const { safeJsonParse } = require('../utils/json');

let db;

function setDb(dbInstance) { db = dbInstance; }

function createBreakpoint(breakpoint) {
  const stmt = db.prepare(`
    INSERT INTO task_breakpoints (
      id, task_id, pattern, pattern_type, action, enabled, max_hits, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    breakpoint.id,
    breakpoint.task_id || null,
    breakpoint.pattern,
    breakpoint.pattern_type || 'output',
    breakpoint.action || 'pause',
    breakpoint.enabled !== false ? 1 : 0,
    breakpoint.max_hits || null,
    new Date().toISOString()
  );

  return getBreakpoint(breakpoint.id);
}

/**
 * Get a breakpoint by ID
 */
function getBreakpoint(id) {
  const stmt = db.prepare('SELECT * FROM task_breakpoints WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.enabled = Boolean(row.enabled);
  }
  return row;
}

/**
 * List breakpoints
 */
function listBreakpoints(options = {}) {
  let query = 'SELECT * FROM task_breakpoints';
  const conditions = [];
  const values = [];

  if (options.task_id) {
    conditions.push('(task_id = ? OR task_id IS NULL)');
    values.push(options.task_id);
  }

  if (options.enabled !== undefined) {
    conditions.push('enabled = ?');
    values.push(options.enabled ? 1 : 0);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC';

  const stmt = db.prepare(query);
  return stmt.all(...values).map(row => ({
    ...row,
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Update a breakpoint
 */
function updateBreakpoint(id, updates) {
  const fields = [];
  const values = [];

  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }

  // Handle hit_count increment atomically to prevent race conditions
  // Use special value 'increment' to do atomic increment
  if (updates.hit_count === 'increment') {
    fields.push('hit_count = hit_count + 1');
    // No value to push - this is an expression, not a parameter
  } else if (updates.hit_count !== undefined) {
    fields.push('hit_count = ?');
    values.push(updates.hit_count);
  }

  if (updates.pattern !== undefined) {
    fields.push('pattern = ?');
    values.push(updates.pattern);
  }

  if (fields.length === 0) return getBreakpoint(id);

  values.push(id);
  const stmt = db.prepare(`UPDATE task_breakpoints SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getBreakpoint(id);
}

/**
 * Delete a breakpoint
 */
function deleteBreakpoint(id) {
  const stmt = db.prepare('DELETE FROM task_breakpoints WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Check if output matches any breakpoints
 */
function checkBreakpoints(taskId, text, type = 'output') {
  const breakpoints = listBreakpoints({ task_id: taskId, enabled: true });

  for (const bp of breakpoints) {
    if (bp.pattern_type !== type) continue;

    // Check if max hits exceeded
    if (bp.max_hits && bp.hit_count >= bp.max_hits) continue;

    // Check pattern match
    try {
      const regex = new RegExp(bp.pattern, 'i');
      if (regex.test(text)) {
        // Increment hit count atomically to prevent race conditions
        updateBreakpoint(bp.id, { hit_count: 'increment' });
        return bp;
      }
    } catch (_e) {
      void _e;
      // Invalid regex, try exact match
      if (text.includes(bp.pattern)) {
        updateBreakpoint(bp.id, { hit_count: 'increment' });
        return bp;
      }
    }
  }

  return null;
}

/**
 * Create a debug session
 */
function createDebugSession(session) {
  const stmt = db.prepare(`
    INSERT INTO debug_sessions (
      id, task_id, status, current_breakpoint_id, paused_at_sequence, captured_state, step_mode, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    session.id,
    session.task_id,
    session.status || 'active',
    session.current_breakpoint_id || null,
    session.paused_at_sequence || null,
    session.captured_state !== undefined ? JSON.stringify(session.captured_state) : null,
    session.step_mode || null,
    new Date().toISOString()
  );

  return getDebugSession(session.id);
}

/**
 * Get a debug session by ID
 */
function getDebugSession(id) {
  const stmt = db.prepare('SELECT * FROM debug_sessions WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.captured_state = safeJsonParse(row.captured_state, null);
  }
  return row;
}

/**
 * Get debug session by task ID
 */
function getDebugSessionByTask(taskId) {
  const stmt = db.prepare('SELECT * FROM debug_sessions WHERE task_id = ? AND status IN (?, ?, ?) ORDER BY created_at DESC LIMIT 1');
  const row = stmt.get(taskId, 'active', 'paused', 'stepping');
  if (row) {
    row.captured_state = safeJsonParse(row.captured_state, null);
  }
  return row;
}

/**
 * Update a debug session
 */
function updateDebugSession(id, updates) {
  const fields = [];
  const values = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (updates.current_breakpoint_id !== undefined) {
    fields.push('current_breakpoint_id = ?');
    values.push(updates.current_breakpoint_id);
  }

  if (updates.paused_at_sequence !== undefined) {
    fields.push('paused_at_sequence = ?');
    values.push(updates.paused_at_sequence);
  }

  if (updates.captured_state !== undefined) {
    fields.push('captured_state = ?');
    values.push(JSON.stringify(updates.captured_state));
  }

  if (updates.step_mode !== undefined) {
    fields.push('step_mode = ?');
    values.push(updates.step_mode);
  }

  if (fields.length === 0) return getDebugSession(id);

  values.push(id);
  const stmt = db.prepare(`UPDATE debug_sessions SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getDebugSession(id);
}

/**
 * Atomic debug session status transition to prevent race conditions
 */
function transitionDebugSessionStatus(sessionId, fromStatus, toStatus, additionalUpdates = {}) {
  const fields = ['status = ?'];
  const values = [toStatus];

  // Add additional updates
  for (const [key, value] of Object.entries(additionalUpdates)) {
    if (key === 'captured_state') {
      fields.push('captured_state = ?');
      values.push(JSON.stringify(value));
    } else {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  values.push(sessionId);

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

  const stmt = db.prepare(`UPDATE debug_sessions SET ${fields.join(', ')} WHERE ${whereClause}`);
  const result = stmt.run(...values);

  return result.changes > 0;
}

/**
 * Record a debug capture
 */
function recordDebugCapture(capture) {
  const stmt = db.prepare(`
    INSERT INTO debug_captures (
      session_id, breakpoint_id, output_snapshot, error_snapshot,
      progress_percent, elapsed_seconds, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    capture.session_id,
    capture.breakpoint_id || null,
    capture.output_snapshot || null,
    capture.error_snapshot || null,
    capture.progress_percent || null,
    capture.elapsed_seconds || null,
    new Date().toISOString()
  );

  return result.lastInsertRowid;
}

/**
 * Get debug captures for a session
 */
function getDebugCaptures(sessionId) {
  const stmt = db.prepare('SELECT * FROM debug_captures WHERE session_id = ? ORDER BY captured_at ASC');
  return stmt.all(sessionId);
}

/**
 * Get current debug state for a task
 */
function getDebugState(taskId) {
  const session = getDebugSessionByTask(taskId);
  if (!session) return null;

  const captures = getDebugCaptures(session.id);
  const breakpoints = listBreakpoints({ task_id: taskId });

  return {
    session,
    captures,
    breakpoints
  };
}

module.exports = {
  setDb,
  createBreakpoint,
  getBreakpoint,
  listBreakpoints,
  updateBreakpoint,
  deleteBreakpoint,
  checkBreakpoints,
  createDebugSession,
  getDebugSession,
  getDebugSessionByTask,
  updateDebugSession,
  transitionDebugSessionStatus,
  recordDebugCapture,
  getDebugCaptures,
  getDebugState,
};
