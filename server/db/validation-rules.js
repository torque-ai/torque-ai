/**
 * db/validation-rules.js — Validation rules, approval rules, failure patterns, retry rules
 * Extracted from project-config.js during decomposition
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Uses setter injection for cross-module dependencies.
 */

'use strict';

const logger = require('../logger').child({ component: 'validation-rules' });

const MAX_REGEX_INPUT_LENGTH = 50000; // 50KB
let db = null;
let _getTask = null;

function setDb(dbInstance) { db = dbInstance; }
function setGetTask(fn) { _getTask = fn; }

function getTask(...args) { return _getTask(...args); }

function _readQuantifier(pattern, startIndex) {
  const char = pattern[startIndex];
  if (!char) return null;

  if (char === '*' || char === '+' || char === '?') {
    return 1;
  }

  if (char === '{') {
    const close = pattern.indexOf('}', startIndex + 1);
    if (close === -1) return null;
    const body = pattern.slice(startIndex + 1, close);
    if (/^\s*\d+\s*(,\s*\d*\s*)?$/.test(body)) {
      return close - startIndex + 1;
    }
  }

  return null;
}

function _hasQuantifier(text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '\\') {
      i += 1;
      continue;
    }

    if (char === '[') {
      const close = text.indexOf(']', i + 1);
      if (close === -1) return false;
      i = close;
      continue;
    }

    if (char === '*' || char === '+' || char === '?') {
      return true;
    }

    if (char === '{') {
      const close = text.indexOf('}', i + 1);
      if (close !== -1) {
        const body = text.slice(i + 1, close);
        if (/^\s*\d+\s*(,\s*\d*\s*)?$/.test(body)) return true;
        i = close;
      }
    }
  }
  return false;
}

function _hasPossessiveLikeQuantifier(text) {
  for (let i = 0; i < text.length - 1; i++) {
    const char = text[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '[') {
      const close = text.indexOf(']', i + 1);
      if (close === -1) return false;
      i = close;
      continue;
    }
    if ((char === '*' || char === '+' || char === '?') && text[i + 1] === '+') {
      return true;
    }
  }
  return false;
}

function _isLikelyReDoSRiskPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 1000) return true;

  // Heuristic: quantifier inside a parenthesized group that is itself quantified.
  const groupStack = [];

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === '\\') {
      i += 1;
      continue;
    }

    if (char === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) return true;
      i = close;
      continue;
    }

    if (char === '(') {
      groupStack.push(i);
      continue;
    }

    if (char === ')' && groupStack.length) {
      const groupStart = groupStack.pop();
      const groupBody = pattern.slice(groupStart + 1, i);

      if (_hasPossessiveLikeQuantifier(groupBody)) {
        return true;
      }

      const hasInnerQuantifier = _hasQuantifier(groupBody);
      if (!hasInnerQuantifier) continue;

      const quantLen = _readQuantifier(pattern, i + 1);
      if (quantLen && quantLen > 0) {
        return true;
      }
    }
  }

  return false;
}

// ============================================================
// Validation rules
// ============================================================

/**
 * Get all validation rules
 */
function getValidationRules(enabledOnly = true) {
  const stmt = enabledOnly
    ? db.prepare('SELECT * FROM validation_rules WHERE enabled = 1 ORDER BY severity DESC')
    : db.prepare('SELECT * FROM validation_rules ORDER BY severity DESC');
  return stmt.all();
}

/**
 * Get a specific validation rule
 */
function getValidationRule(id) {
  const stmt = db.prepare('SELECT * FROM validation_rules WHERE id = ?');
  return stmt.get(id);
}

/**
 * Create or update a validation rule
 */
function saveValidationRule(rule) {
  const now = new Date().toISOString();
  const id = rule.id || require('uuid').v4();
  const stmt = db.prepare(`
    INSERT INTO validation_rules (id, name, description, rule_type, pattern, condition, severity, enabled, auto_fail, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      rule_type = excluded.rule_type,
      pattern = excluded.pattern,
      condition = excluded.condition,
      severity = excluded.severity,
      enabled = excluded.enabled,
      auto_fail = excluded.auto_fail,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    id,
    rule.name,
    rule.description || null,
    rule.rule_type || 'pattern',
    rule.pattern || null,
    rule.condition || null,
    rule.severity || 'warning',
    rule.enabled !== false ? 1 : 0,
    rule.auto_fail ? 1 : 0,
    now,
    now
  );
  return getValidationRule(id);
}

/**
 * Record a validation result for a task
 */
function recordValidationResult(taskId, ruleId, ruleName, status, severity, details, filePath, lineNumber) {
  const stmt = db.prepare(`
    INSERT INTO validation_results (task_id, rule_id, rule_name, status, severity, details, file_path, line_number, validated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(taskId, ruleId, ruleName, status, severity, details, filePath, lineNumber, new Date().toISOString());
}

/**
 * Get validation results for a task
 */
function getValidationResults(taskId) {
  const stmt = db.prepare('SELECT * FROM validation_results WHERE task_id = ? ORDER BY validated_at DESC');
  return stmt.all(taskId);
}

/**
 * Check if task has validation failures
 */
function hasValidationFailures(taskId, minSeverity = 'warning') {
  const severityOrder = { 'info': 0, 'warning': 1, 'error': 2 };
  const minLevel = severityOrder[minSeverity] ?? 1;

  const results = getValidationResults(taskId);
  return results.some(r => r.status === 'fail' && (severityOrder[r.severity] || 0) >= minLevel);
}

/**
 * Validate task output against all enabled rules
 */
function validateTaskOutput(taskId, fileChanges = []) {
  const rules = getValidationRules(true);
  const results = [];
  const _task = getTask(taskId);

  for (const rule of rules) {
    if (rule.rule_type === 'pattern' && rule.pattern) {
      if (_isLikelyReDoSRiskPattern(rule.pattern)) {
        logger.info(`[Validation] Skipping potentially unsafe regex pattern: ${rule.pattern.slice(0, 50)}...`);
        continue;
      }

      // Pattern-based validation
      for (const file of fileChanges) {
        const inputToMatch = (file.content || '').slice(0, MAX_REGEX_INPUT_LENGTH);
        try {
          const regex = new RegExp(rule.pattern, 'gmi');
          const match = inputToMatch.match(regex);
          if (match) {
            recordValidationResult(taskId, rule.id, rule.name, 'fail', rule.severity,
              `Pattern matched: ${match ? match[0].substring(0, 100) : 'unknown'}`, file.path, null);
            results.push({ rule: rule.name, status: 'fail', severity: rule.severity, file: file.path });
          }
        } catch (e) {
          logger.warn(`Invalid pattern regex in validation rule ${rule.name}: ${rule.pattern} (${e.message})`);
        }
      }
    } else if (rule.rule_type === 'size' && rule.condition) {
      // Size-based validation
      for (const file of fileChanges) {
        if (rule.condition.includes('size:0') && file.size === 0) {
          recordValidationResult(taskId, rule.id, rule.name, 'fail', rule.severity,
            'File is empty (0 bytes)', file.path, null);
          results.push({ rule: rule.name, status: 'fail', severity: rule.severity, file: file.path });
        } else if (rule.condition.includes('size:<')) {
          const threshold = parseInt(rule.condition.match(/size:<(\d+)/)?.[1] || '0', 10);
          const ext = rule.condition.match(/extension:(\.\w+)/)?.[1];
          if (file.path.endsWith(ext) && file.size < threshold) {
            recordValidationResult(taskId, rule.id, rule.name, 'fail', rule.severity,
              `File size ${file.size} bytes is below threshold ${threshold}`, file.path, null);
            results.push({ rule: rule.name, status: 'fail', severity: rule.severity, file: file.path });
          }
        }
      }
    } else if (rule.rule_type === 'delta' && rule.condition) {
      // Change delta validation
      for (const file of fileChanges) {
        if (rule.condition.includes('size_decrease_percent') && file.originalSize && file.size) {
          const decreasePercent = ((file.originalSize - file.size) / file.originalSize) * 100;
          const threshold = parseInt(rule.condition.match(/>(\d+)/)?.[1] || '50', 10);
          if (decreasePercent > threshold) {
            recordValidationResult(taskId, rule.id, rule.name, 'fail', rule.severity,
              `File size decreased by ${decreasePercent.toFixed(1)}% (threshold: ${threshold}%)`, file.path, null);
            results.push({ rule: rule.name, status: 'fail', severity: rule.severity, file: file.path });
          }
        }
      }
    }
  }

  return results;
}

// ============================================================
// Approval rules
// ============================================================

/**
 * Get all approval rules
 */
function getApprovalRules(enabledOnly = true) {
  const stmt = enabledOnly
    ? db.prepare('SELECT * FROM approval_rules WHERE enabled = 1')
    : db.prepare('SELECT * FROM approval_rules');
  return stmt.all();
}

/**
 * Get a specific approval rule
 */
function getApprovalRule(id) {
  const stmt = db.prepare('SELECT * FROM approval_rules WHERE id = ?');
  return stmt.get(id);
}

/**
 * Create or update an approval rule
 */
function saveApprovalRule(rule) {
  const now = new Date().toISOString();
  const id = rule.id || require('uuid').v4();
  const stmt = db.prepare(`
    INSERT INTO approval_rules (id, name, description, rule_type, condition, required_approvers, auto_reject, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      rule_type = excluded.rule_type,
      condition = excluded.condition,
      required_approvers = excluded.required_approvers,
      auto_reject = excluded.auto_reject,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    id,
    rule.name,
    rule.description || null,
    rule.rule_type || 'condition',
    rule.condition,
    rule.required_approvers || 1,
    rule.auto_reject ? 1 : 0,
    rule.enabled !== false ? 1 : 0,
    now,
    now
  );
  return getApprovalRule(id);
}

/**
 * Get pending approvals for a task
 */
function getPendingApprovals(taskId) {
  const stmt = db.prepare('SELECT * FROM pending_approvals WHERE task_id = ? AND status = ?');
  return stmt.all(taskId, 'pending');
}

/**
 * Approve or reject a pending approval
 */
function decideApproval(approvalId, approved, decidedBy, notes) {
  const stmt = db.prepare(`
    UPDATE pending_approvals
    SET status = ?, decided_at = ?, decided_by = ?, decision_notes = ?
    WHERE id = ?
  `);
  stmt.run(approved ? 'approved' : 'rejected', new Date().toISOString(), decidedBy, notes, approvalId);
}

/**
 * Check if task has all approvals
 */
function hasAllApprovals(taskId) {
  const pending = getPendingApprovals(taskId);
  return pending.length === 0;
}

// ============================================================
// Failure patterns
// ============================================================

/**
 * Get all failure patterns
 */
function getFailurePatterns(enabledOnly = true) {
  const stmt = enabledOnly
    ? db.prepare('SELECT * FROM failure_patterns WHERE enabled = 1 ORDER BY occurrence_count DESC')
    : db.prepare('SELECT * FROM failure_patterns ORDER BY occurrence_count DESC');
  return stmt.all();
}

/**
 * Create or update a failure pattern
 */
function saveFailurePattern(pattern) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO failure_patterns (id, name, description, pattern_type, signature, task_types, provider, occurrence_count, recommended_action, auto_learned, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      pattern_type = excluded.pattern_type,
      signature = excluded.signature,
      task_types = excluded.task_types,
      provider = excluded.provider,
      occurrence_count = excluded.occurrence_count,
      recommended_action = excluded.recommended_action,
      auto_learned = excluded.auto_learned,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    pattern.id || require('uuid').v4(),
    pattern.name,
    pattern.description || null,
    pattern.pattern_type || 'output',
    pattern.signature,
    pattern.task_types || null,
    pattern.provider || null,
    pattern.occurrence_count || 1,
    pattern.recommended_action || 'retry_with_cloud',
    pattern.auto_learned ? 1 : 0,
    pattern.enabled !== false ? 1 : 0,
    now,
    now
  );
}

/**
 * Match task output against failure patterns
 */
function matchFailurePatterns(taskId, output, provider) {
  const patterns = getFailurePatterns(true);
  const matches = [];

  for (const pattern of patterns) {
    // Filter by provider if specified
    if (pattern.provider && pattern.provider !== provider) continue;

    if (_isLikelyReDoSRiskPattern(pattern.signature)) {
      logger.info(`[Validation] Skipping potentially unsafe regex pattern: ${pattern.signature.slice(0, 50)}...`);
      continue;
    }

    const inputToMatch = (output || '').slice(0, MAX_REGEX_INPUT_LENGTH);

    try {
      const regex = new RegExp(pattern.signature, 'gmi');
      if (regex.test(inputToMatch)) {
        // Record the match
        const stmt = db.prepare(`
          INSERT INTO failure_matches (task_id, pattern_id, match_details, matched_at)
          VALUES (?, ?, ?, ?)
        `);
        stmt.run(taskId, pattern.id, `Matched pattern: ${pattern.name}`, new Date().toISOString());

        // Increment occurrence count
        const updateStmt = db.prepare(`
          UPDATE failure_patterns SET occurrence_count = occurrence_count + 1, last_seen_at = ? WHERE id = ?
        `);
        updateStmt.run(new Date().toISOString(), pattern.id);

        matches.push({
          pattern: pattern.name,
          recommended_action: pattern.recommended_action
        });
      }
    } catch (e) {
      logger.warn(`Invalid pattern regex: ${pattern.signature}`, e.message);
    }
  }

  return matches;
}

/**
 * Get failure matches for a task
 */
function getFailureMatches(taskId) {
  const stmt = db.prepare(`
    SELECT fm.*, fp.name as pattern_name, fp.recommended_action
    FROM failure_matches fm
    JOIN failure_patterns fp ON fm.pattern_id = fp.id
    WHERE fm.task_id = ?
    ORDER BY fm.matched_at DESC
  `);
  return stmt.all(taskId);
}

// ============================================================
// Retry rules
// ============================================================

/**
 * Get all retry rules
 */
function getRetryRules(enabledOnly = true) {
  const stmt = enabledOnly
    ? db.prepare('SELECT * FROM retry_rules WHERE enabled = 1')
    : db.prepare('SELECT * FROM retry_rules');
  return stmt.all();
}

/**
 * Create or update a retry rule
 */
function saveRetryRule(rule) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO retry_rules (id, name, description, trigger_type, trigger_condition, action, fallback_provider, max_retries, retry_delay_seconds, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      trigger_type = excluded.trigger_type,
      trigger_condition = excluded.trigger_condition,
      action = excluded.action,
      fallback_provider = excluded.fallback_provider,
      max_retries = excluded.max_retries,
      retry_delay_seconds = excluded.retry_delay_seconds,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    rule.id || require('uuid').v4(),
    rule.name,
    rule.description || null,
    rule.trigger_type || 'pattern',
    rule.trigger_condition,
    rule.action || 'retry_with_cloud',
    rule.fallback_provider || 'claude-cli',
    rule.max_retries || 1,
    rule.retry_delay_seconds || 0,
    rule.enabled !== false ? 1 : 0,
    now,
    now
  );
}

/**
 * Check if task should be retried with a different provider
 */
function shouldRetryWithCloud(taskId, output, context = {}) {
  const rules = getRetryRules(true);
  const task = getTask(taskId);
  if (!task) return { shouldRetry: false, reason: 'Task not found' };
  const outputToMatch = (output || '').slice(0, MAX_REGEX_INPUT_LENGTH);

  // Check retry attempts to avoid infinite loops
  const attemptsStmt = db.prepare('SELECT COUNT(*) as count FROM retry_attempts WHERE task_id = ?');
  const attempts = attemptsStmt.get(taskId);

  for (const rule of rules) {
    // Skip if max retries exceeded
    if (attempts.count >= rule.max_retries) continue;

    let shouldRetry = false;
    let reason = '';

    if (rule.trigger_type === 'pattern') {
      if (_isLikelyReDoSRiskPattern(rule.trigger_condition)) {
        logger.warn(`[Database] Skipping unsafe retry regex: ${rule.trigger_condition}`);
        continue;
      }

      try {
        const regex = new RegExp(rule.trigger_condition, 'gmi');
        if (outputToMatch && regex.test(outputToMatch)) {
          shouldRetry = true;
          reason = `Pattern matched: ${rule.trigger_condition}`;
        }
      } catch (e) {
        logger.warn(`[Database] Invalid regex in retry rule: ${rule.trigger_condition} - ${e.message}`);
      }
    } else if (rule.trigger_type === 'condition') {
      if (rule.trigger_condition.includes('output_empty') && (!output || output.trim().length === 0)) {
        shouldRetry = true;
        reason = 'Output is empty';
      } else if (rule.trigger_condition.includes('file_size') && context.fileSize !== undefined) {
        const threshold = parseInt(rule.trigger_condition.match(/<\s*(\d+)/)?.[1] || '10', 10);
        if (context.fileSize < threshold) {
          shouldRetry = true;
          reason = `File size ${context.fileSize} below threshold`;
        }
      } else if (rule.trigger_condition.includes('size_decrease_percent') && context.sizeDecreasePercent) {
        const threshold = parseInt(rule.trigger_condition.match(/>\s*(\d+)/)?.[1] || '50', 10);
        if (context.sizeDecreasePercent > threshold) {
          shouldRetry = true;
          reason = `Size decreased by ${context.sizeDecreasePercent.toFixed(1)}%`;
        }
      } else if (rule.trigger_condition.includes('validation_failed') && hasValidationFailures(taskId, 'error')) {
        shouldRetry = true;
        reason = 'Validation failed';
      }
    }

    if (shouldRetry) {
      // Record the retry attempt
      const retryStmt = db.prepare(`
        INSERT INTO retry_attempts (task_id, original_provider, retry_provider, rule_id, attempt_number, trigger_reason, outcome, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `);
      retryStmt.run(taskId, task.provider, rule.fallback_provider, rule.id, attempts.count + 1, reason, new Date().toISOString());

      return {
        shouldRetry: true,
        fallbackProvider: rule.fallback_provider,
        reason: reason,
        rule: rule.name,
        delaySeconds: rule.retry_delay_seconds
      };
    }
  }

  return { shouldRetry: false };
}

/**
 * Update retry attempt outcome
 */
function updateRetryOutcome(taskId, outcome) {
  const stmt = db.prepare(`
    UPDATE retry_attempts SET outcome = ? WHERE task_id = ? AND outcome = 'pending'
  `);
  stmt.run(outcome, taskId);
}

/**
 * Get retry attempts for a task
 */
function getRetryAttempts(taskId) {
  const stmt = db.prepare('SELECT * FROM retry_attempts WHERE task_id = ? ORDER BY attempted_at DESC');
  return stmt.all(taskId);
}

// ============================================================
// Module exports
// ============================================================

module.exports = {
  setDb,
  setGetTask,
  getValidationRules,
  getValidationRule,
  saveValidationRule,
  recordValidationResult,
  getValidationResults,
  hasValidationFailures,
  validateTaskOutput,
  getApprovalRules,
  getApprovalRule,
  saveApprovalRule,
  getPendingApprovals,
  decideApproval,
  hasAllApprovals,
  getFailurePatterns,
  saveFailurePattern,
  matchFailurePatterns,
  getFailureMatches,
  getRetryRules,
  saveRetryRule,
  shouldRetryWithCloud,
  updateRetryOutcome,
  getRetryAttempts,
};
