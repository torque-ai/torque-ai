'use strict';

/**
 * File Quality Module
 *
 * Extracted from file-tracking.js — syntax, diff preview, quality scoring,
 * provider stats, build checks, rate limits, output limits, audit, and task complexity.
 */

const { TASK_TIMEOUTS } = require('../constants');

let db;
let _getTaskFn;

function setDb(dbInstance) {
  db = dbInstance;
}

function setGetTask(fn) {
  _getTaskFn = fn;
}

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getRunningCount() {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?');
  return stmt.get('running').count;
}

function getRunningCountByProvider(provider) {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider = ?');
  return stmt.get('running', provider).count;
}

function getSyntaxValidators(extension) {
  const stmt = db.prepare(`
    SELECT * FROM syntax_validators WHERE enabled = 1 AND file_extensions LIKE ?
  `);
  return stmt.all(`%${extension}%`);
}

function listAllSyntaxValidators() {
  return db.prepare('SELECT * FROM syntax_validators ORDER BY name').all();
}

/**
 * Run syntax validation on a file
 * @param {any} filePath
 * @param {any} workingDirectory
 * @returns {any}
 */

async function runSyntaxValidation(filePath, workingDirectory) {
  const path = require('path');
  const { spawn } = require('child_process');

  const ext = path.extname(filePath).toLowerCase();
  const validators = getSyntaxValidators(ext);

  if (validators.length === 0) {
    return { validated: false, reason: 'No validator for extension' };
  }

  const results = [];

  for (const validator of validators) {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workingDirectory, filePath);
    const args = validator.args ? validator.args.split(' ') : [];
    args.push(fullPath);

    try {
      const result = await new Promise((resolve, _reject) => {
        const proc = spawn(validator.command, args, {
          cwd: workingDirectory,
          timeout: TASK_TIMEOUTS.HTTP_REQUEST,
          windowsHide: true
        });

        let output = '';
        let errorOutput = '';

        proc.stdout.on('data', data => output += data.toString());
        proc.stderr.on('data', data => errorOutput += data.toString());

        proc.on('close', code => {
          const successCodes = validator.success_exit_codes.split(',').map(c => parseInt(c.trim()));
          resolve({
            validator: validator.name,
            success: successCodes.includes(code),
            exitCode: code,
            output,
            errorOutput
          });
        });

        proc.on('error', err => {
          resolve({
            validator: validator.name,
            success: false,
            error: err.message
          });
        });
      });

      results.push(result);
    } catch (err) {
      results.push({ validator: validator.name, success: false, error: err.message });
    }
  }

  const allPassed = results.every(r => r.success);
  return { validated: true, passed: allPassed, results };
}

// ============================================
// Diff Preview Functions
// ============================================

/**
 * Create a diff preview for a task
 */

function createDiffPreview(taskId, diffContent, filesChanged, linesAdded, linesRemoved) {
  const id = require('uuid').v4();
  const stmt = db.prepare(`
    INSERT INTO diff_previews (id, task_id, diff_content, files_changed, lines_added, lines_removed, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(id, taskId, diffContent, filesChanged, linesAdded, linesRemoved, new Date().toISOString());
  return id;
}

/**
 * Get diff preview for a task
 * @param {any} taskId
 * @returns {any}
 */

function getDiffPreview(taskId) {
  const stmt = db.prepare('SELECT * FROM diff_previews WHERE task_id = ?');
  return stmt.get(taskId);
}

/**
 * Mark diff as reviewed
 * @param {any} taskId
 * @param {any} reviewedBy
 * @returns {any}
 */

function markDiffReviewed(taskId, reviewedBy) {
  const stmt = db.prepare(`
    UPDATE diff_previews SET status = 'reviewed', reviewed_at = ?, reviewed_by = ? WHERE task_id = ?
  `);
  stmt.run(new Date().toISOString(), reviewedBy, taskId);
}

/**
 * Check if diff review is required
 * @returns {any}
 */

function isDiffReviewRequired() {
  return getConfig('diff_preview_required') === '1';
}

// ============================================
// Quality Scoring Functions
// ============================================

/**
 * Calculate and record quality score for a task
 * @param {any} taskId
 * @param {any} provider
 * @param {any} taskType
 * @param {any} scores
 * @returns {any}
 */

function recordQualityScore(taskId, provider, taskType, scores) {
  const overallScore = (
    (scores.validation || 100) * 0.4 +
    (scores.syntax || 100) * 0.3 +
    (scores.completeness || 100) * 0.3
  );

  const stmt = db.prepare(`
    INSERT INTO quality_scores (task_id, provider, task_type, overall_score, validation_score, syntax_score, completeness_score, metrics, scored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    taskId,
    provider,
    taskType || 'unknown',
    overallScore,
    scores.validation || null,
    scores.syntax || null,
    scores.completeness || null,
    JSON.stringify(scores.metrics || {}),
    new Date().toISOString()
  );

  return overallScore;
}

/**
 * Get quality scores for a task
 * @param {any} taskId
 * @returns {any}
 */

function getQualityScore(taskId) {
  const stmt = db.prepare('SELECT * FROM quality_scores WHERE task_id = ?');
  return stmt.get(taskId);
}

/**
 * Get average quality score by provider
 * @param {any} provider
 * @returns {any}
 */

function getProviderQualityStats(provider) {
  const stmt = db.prepare(`
    SELECT
      provider,
      COUNT(*) as total_tasks,
      AVG(overall_score) as avg_score,
      MIN(overall_score) as min_score,
      MAX(overall_score) as max_score
    FROM quality_scores
    WHERE provider = ?
    GROUP BY provider
  `);
  return stmt.get(provider);
}

/**
 * Get overall quality statistics since a given timestamp
 * @param {string} since - ISO timestamp to filter from
 * @returns {{ avgScore: number, totalScored: number, minScore: number, maxScore: number }}
 */

function getOverallQualityStats(since) {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total_scored,
      AVG(overall_score) as avg_score,
      MIN(overall_score) as min_score,
      MAX(overall_score) as max_score
    FROM quality_scores
    WHERE scored_at >= ?
  `);
  const result = stmt.get(since);
  return {
    avgScore: result.avg_score ? Math.round(result.avg_score * 10) / 10 : null,
    totalScored: result.total_scored || 0,
    minScore: result.min_score,
    maxScore: result.max_score,
  };
}

/**
 * Get quality statistics grouped by provider since a given timestamp
 * @param {string} since - ISO timestamp to filter from
 * @returns {Array<{ provider: string, avgScore: number, totalScored: number }>}
 */

function getQualityStatsByProvider(since) {
  const stmt = db.prepare(`
    SELECT
      provider,
      COUNT(*) as total_scored,
      AVG(overall_score) as avg_score,
      MIN(overall_score) as min_score,
      MAX(overall_score) as max_score
    FROM quality_scores
    WHERE scored_at >= ?
    GROUP BY provider
    ORDER BY avg_score DESC
  `);
  return stmt.all(since).map(row => ({
    provider: row.provider,
    avgScore: row.avg_score ? Math.round(row.avg_score * 10) / 10 : null,
    totalScored: row.total_scored,
    minScore: row.min_score,
    maxScore: row.max_score,
  }));
}

/**
 * Get validation failure rate since a given timestamp
 * @param {string} since - ISO timestamp to filter from
 * @returns {{ totalValidated: number, totalFailed: number, failureRate: number }}
 */

function getValidationFailureRate(since) {
  const totalStmt = db.prepare(`
    SELECT COUNT(DISTINCT task_id) as total
    FROM validation_results
    WHERE validated_at >= ?
  `);
  const failedStmt = db.prepare(`
    SELECT COUNT(DISTINCT task_id) as failed
    FROM validation_results
    WHERE validated_at >= ? AND severity IN ('error', 'critical')
  `);
  const total = totalStmt.get(since)?.total || 0;
  const failed = failedStmt.get(since)?.failed || 0;
  return {
    totalValidated: total,
    totalFailed: failed,
    failureRate: total > 0 ? Math.round((failed / total) * 100) : 0,
  };
}

// ============================================
// Provider Success Tracking Functions
// ============================================

/**
 * Update provider task statistics
 * @param {any} provider
 * @param {any} taskType
 * @param {any} success
 * @param {any} qualityScore
 * @param {any} durationSeconds
 * @returns {any}
 */

function updateProviderStats(provider, taskType, success, qualityScore, durationSeconds) {
  const now = new Date().toISOString();

  // Get or create stats record
  const getStmt = db.prepare('SELECT * FROM provider_task_stats WHERE provider = ? AND task_type = ?');
  const existing = getStmt.get(provider, taskType);

  if (existing) {
    const totalTasks = existing.total_tasks + 1;
    const successful = existing.successful_tasks + (success ? 1 : 0);
    const failed = existing.failed_tasks + (success ? 0 : 1);
    const avgQuality = qualityScore
      ? ((existing.avg_quality_score || 0) * existing.total_tasks + qualityScore) / totalTasks
      : existing.avg_quality_score;
    const avgDuration = durationSeconds
      ? ((existing.avg_duration_seconds || 0) * existing.total_tasks + durationSeconds) / totalTasks
      : existing.avg_duration_seconds;

    const updateStmt = db.prepare(`
      UPDATE provider_task_stats SET
        total_tasks = ?, successful_tasks = ?, failed_tasks = ?,
        avg_quality_score = ?, avg_duration_seconds = ?, last_updated = ?
      WHERE provider = ? AND task_type = ?
    `);
    updateStmt.run(totalTasks, successful, failed, avgQuality, avgDuration, now, provider, taskType);
  } else {
    const insertStmt = db.prepare(`
      INSERT INTO provider_task_stats (provider, task_type, total_tasks, successful_tasks, failed_tasks, avg_quality_score, avg_duration_seconds, last_updated)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(provider, taskType, success ? 1 : 0, success ? 0 : 1, qualityScore || null, durationSeconds || null, now);
  }
}

/**
 * Get provider statistics
 * @param {any} provider
 * @returns {any}
 */

function getProviderStats(provider = null) {
  if (provider) {
    const stmt = db.prepare('SELECT * FROM provider_task_stats WHERE provider = ? ORDER BY task_type');
    return stmt.all(provider);
  } else {
    const stmt = db.prepare('SELECT * FROM provider_task_stats ORDER BY provider, task_type');
    return stmt.all();
  }
}

/**
 * Get best provider for a task type
 * @param {any} taskType
 * @returns {any}
 */

function getBestProviderForTaskType(taskType) {
  // Composite score: 50% success rate + 30% quality + 20% speed (inverse duration)
  const stmt = db.prepare(`
    SELECT provider,
           (successful_tasks * 1.0 / total_tasks) as success_rate,
           avg_quality_score,
           avg_duration_seconds,
           total_tasks,
           failed_tasks,
           last_updated,
           (successful_tasks * 1.0 / total_tasks) * 50 +
           COALESCE(avg_quality_score, 50) / 100.0 * 30 +
           CASE WHEN avg_duration_seconds > 0 THEN (1.0 - MIN(avg_duration_seconds, 600) / 600.0) * 20 ELSE 10 END
           as composite_score
    FROM provider_task_stats
    WHERE task_type = ? AND total_tasks >= 3
    ORDER BY composite_score DESC
    LIMIT 1
  `);
  return stmt.get(taskType);
}

/**
 * Detect provider performance degradation.
 * Compares recent error rate to historical baseline.
 * Returns providers whose recent failure rate exceeds 2x their historical average.
 */

function detectProviderDegradation() {
  const stats = db.prepare(`
    SELECT provider, total_tasks, failed_tasks,
           (failed_tasks * 1.0 / total_tasks) as failure_rate,
           last_updated
    FROM provider_task_stats
    WHERE total_tasks >= 5
  `).all();

  const degraded = [];
  for (const s of stats) {
    // Check if recently updated (last 24h) with elevated failure rate
    const lastUpdate = new Date(s.last_updated);
    const hoursAgo = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60);
    if (hoursAgo < 24 && s.failure_rate > 0.3) {
      degraded.push({
        provider: s.provider,
        failure_rate: s.failure_rate,
        total_tasks: s.total_tasks,
        failed_tasks: s.failed_tasks,
      });
    }
  }
  return degraded;
}

// ============================================
// Rollback Functions
// ============================================

/**
 * Create a rollback record
 */

async function runBuildCheck(taskId, workingDirectory) {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  // Detect project type and get build command
  let buildCommand = null;
  let buildArgs = [];

  if (fs.existsSync(path.join(workingDirectory, 'package.json'))) {
    const useYarn = fs.existsSync(path.join(workingDirectory, 'yarn.lock'));
    buildCommand = useYarn ? 'yarn' : 'npm';
    buildArgs = useYarn ? ['build'] : ['run', 'build'];
  } else if (fs.existsSync(path.join(workingDirectory, '*.csproj')) || fs.existsSync(path.join(workingDirectory, '*.sln'))) {
    buildCommand = 'dotnet';
    buildArgs = ['build', '--no-restore'];
  } else if (fs.existsSync(path.join(workingDirectory, 'Cargo.toml'))) {
    buildCommand = 'cargo';
    buildArgs = ['build'];
  } else if (fs.existsSync(path.join(workingDirectory, 'go.mod'))) {
    buildCommand = 'go';
    buildArgs = ['build', './...'];
  }

  if (!buildCommand) {
    return { checked: false, reason: 'No build system detected' };
  }

  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(buildCommand, buildArgs, {
      cwd: workingDirectory,
      timeout: TASK_TIMEOUTS.BUILD_TIMEOUT, // 5 minute timeout
      windowsHide: true
    });

    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', data => output += data.toString());
    proc.stderr.on('data', data => errorOutput += data.toString());

    proc.on('close', code => {
      const durationSeconds = (Date.now() - startTime) / 1000;

      // Record build check
      const stmt = db.prepare(`
        INSERT INTO build_checks (task_id, build_command, working_directory, exit_code, output, error_output, duration_seconds, status, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        taskId,
        `${buildCommand} ${buildArgs.join(' ')}`,
        workingDirectory,
        code,
        output.slice(-10000),
        errorOutput.slice(-10000),
        durationSeconds,
        code === 0 ? 'passed' : 'failed',
        new Date().toISOString()
      );

      resolve({
        checked: true,
        passed: code === 0,
        exitCode: code,
        command: `${buildCommand} ${buildArgs.join(' ')}`,
        duration: durationSeconds,
        output: output.slice(-2000),
        errorOutput: errorOutput.slice(-2000)
      });
    });

    proc.on('error', err => {
      resolve({ checked: false, error: err.message });
    });
  });
}

/**
 * Get build check result for a task
 * @param {any} taskId
 * @returns {any}
 */

function getBuildCheck(taskId) {
  const stmt = db.prepare('SELECT * FROM build_checks WHERE task_id = ? ORDER BY checked_at DESC LIMIT 1');
  return stmt.get(taskId);
}

/**
 * Save build verification result to database
 * @param {string} taskId - Task ID
 * @param {object} result - Build result object
 * @returns {any}
 */

function saveBuildResult(taskId, result) {
  const stmt = db.prepare(`
    INSERT INTO build_checks (task_id, build_command, working_directory, exit_code, output, error_output, duration_seconds, status, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    taskId,
    result.command || '',
    result.workingDirectory || '',
    result.exitCode || 0,
    result.output || '',
    result.errorOutput || '',
    result.durationSeconds || 0,
    result.status || 'unknown',
    new Date().toISOString()
  );
}

// ============================================
// Task Type Classification
// ============================================

/**
 * Classify a task based on description
 */

function classifyTaskType(taskDescription) {
  const desc = taskDescription.toLowerCase();

  if (desc.includes('test') || desc.includes('spec')) return 'testing';
  if (desc.includes('document') || desc.includes('readme') || desc.includes('comment')) return 'documentation';
  if (desc.includes('refactor') || desc.includes('rename') || desc.includes('extract')) return 'refactoring';
  if (desc.includes('fix') || desc.includes('bug') || desc.includes('error')) return 'bugfix';
  if (desc.includes('add') || desc.includes('create') || desc.includes('implement') || desc.includes('new')) return 'feature';
  if (desc.includes('update') || desc.includes('change') || desc.includes('modify')) return 'modification';
  if (desc.includes('delete') || desc.includes('remove')) return 'deletion';
  if (desc.includes('config') || desc.includes('setting')) return 'configuration';

  return 'general';
}

// ============================================
// Rate Limiting Functions
// ============================================

/**
 * Check if request is within rate limits
 */

function checkRateLimit(provider, taskId = null) {
  const limits = db.prepare('SELECT * FROM rate_limits WHERE provider = ? AND enabled = 1').all(provider);

  for (const limit of limits) {
    if (limit.limit_type === 'concurrent') {
      // Check concurrent tasks for this provider only
      const running = getRunningCountByProvider(provider);
      if (running >= limit.max_value) {
        recordRateLimitEvent(provider, taskId, 'blocked', running, limit.max_value);
        return { allowed: false, reason: `Concurrent limit reached (${running}/${limit.max_value})` };
      }
    } else if (limit.limit_type === 'requests') {
      // Check request rate
      const now = new Date();
      const windowStart = limit.window_start ? new Date(limit.window_start) : null;

      if (!windowStart || (now - windowStart) > limit.window_seconds * 1000) {
        // Reset window
        db.prepare('UPDATE rate_limits SET current_value = 1, window_start = ? WHERE id = ?')
          .run(now.toISOString(), limit.id);
      } else if (limit.current_value >= limit.max_value) {
        const windowEnd = new Date(windowStart.getTime() + limit.window_seconds * 1000);
        const retryAfter = Math.max(1, Math.ceil((windowEnd - now) / 1000));
        recordRateLimitEvent(provider, taskId, 'blocked', limit.current_value, limit.max_value);
        return { allowed: false, reason: `Rate limit reached (${limit.current_value}/${limit.max_value} per ${limit.window_seconds}s)`, retryAfter };
      } else {
        db.prepare('UPDATE rate_limits SET current_value = current_value + 1 WHERE id = ?')
          .run(limit.id);
      }
    }
  }

  return { allowed: true };
}

/**
 * Record rate limit event
 * @param {any} provider
 * @param {any} taskId
 * @param {any} eventType
 * @param {any} currentValue
 * @param {any} maxValue
 * @returns {any}
 */

function recordRateLimitEvent(provider, taskId, eventType, currentValue, maxValue) {
  const stmt = db.prepare(`
    INSERT INTO rate_limit_events (provider, task_id, event_type, current_value, max_value, event_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(provider, taskId, eventType, currentValue, maxValue, new Date().toISOString());
}

/**
 * Get rate limits for a provider
 * @param {any} provider
 * @returns {any}
 */

function getRateLimits(provider = null) {
  if (provider) {
    return db.prepare('SELECT * FROM rate_limits WHERE provider = ?').all(provider);
  }
  return db.prepare('SELECT * FROM rate_limits').all();
}

/**
 * Set rate limit
 * @param {any} provider
 * @param {any} limitType
 * @param {any} maxValue
 * @param {any} windowSeconds
 * @param {any} enabled
 * @returns {any}
 */

function setRateLimit(provider, limitType, maxValue, windowSeconds = 60, enabled = true) {
  const id = `rl-${provider}-${limitType}`;
  const stmt = db.prepare(`
    INSERT INTO rate_limits (id, provider, limit_type, max_value, window_seconds, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      max_value = excluded.max_value,
      window_seconds = excluded.window_seconds,
      enabled = excluded.enabled
  `);
  stmt.run(id, provider, limitType, maxValue, windowSeconds, enabled ? 1 : 0, new Date().toISOString());
  return { id, provider, limit_type: limitType, max_value: maxValue, window_seconds: windowSeconds, enabled };
}

// ============================================
// Cost Tracking Functions (delegated to db/cost-tracking.js)
// ============================================

function setOutputLimit(provider, maxOutputBytes = 1048576, maxFileSizeBytes = 524288, _maxFileChanges = 20, enabled = true) {
  const id = `limit-${provider}`;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO output_limits (id, provider, task_type, max_output_bytes, max_file_size_bytes, enabled, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      max_output_bytes = excluded.max_output_bytes,
      max_file_size_bytes = excluded.max_file_size_bytes,
      enabled = excluded.enabled
  `);

  stmt.run(id, provider, maxOutputBytes, maxFileSizeBytes, enabled ? 1 : 0, now);

  return { id, provider, max_output_bytes: maxOutputBytes, max_file_size_bytes: maxFileSizeBytes, enabled };
}

// ============================================
// Duplicate Detection Functions
// ============================================

/**
 * Generate task fingerprint
 */

function checkOutputSizeLimits(taskId, provider, outputSize, fileChanges = []) {
  const limits = db.prepare(`
    SELECT * FROM output_limits WHERE enabled = 1 AND (provider = ? OR provider IS NULL)
    ORDER BY provider DESC NULLS LAST LIMIT 1
  `).get(provider);

  if (!limits) return { withinLimits: true };

  const violations = [];

  // Check total output size
  if (outputSize > limits.max_output_bytes) {
    violations.push({
      type: 'output_size',
      actual: outputSize,
      max: limits.max_output_bytes
    });
  }

  // Check individual file sizes
  for (const change of fileChanges) {
    if (change.size && change.size > limits.max_file_size_bytes) {
      violations.push({
        type: 'file_size',
        filePath: change.path,
        actual: change.size,
        max: limits.max_file_size_bytes
      });
    }
  }

  // Record violations
  for (const v of violations) {
    db.prepare(`
      INSERT INTO output_violations (task_id, violation_type, actual_size, max_allowed, file_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, v.type, v.actual, v.max, v.filePath || null, new Date().toISOString());
  }

  return {
    withinLimits: violations.length === 0,
    violations
  };
}

/**
 * Get output violations
 * @param {any} taskId
 * @returns {any}
 */

function getOutputViolations(taskId) {
  return db.prepare('SELECT * FROM output_violations WHERE task_id = ?').all(taskId);
}

// ============================================
// Audit Trail Functions
// ============================================

/**
 * Record audit event
 * @param {any} eventType
 * @param {any} entityType
 * @param {any} entityId
 * @param {any} action
 * @param {any} actor
 * @param {any} oldValue
 * @param {any} newValue
 * @param {any} metadata
 * @returns {any}
 */

function recordAuditEvent(eventType, entityType, entityId, action, actor = null, oldValue = null, newValue = null, metadata = null) {
  const stmt = db.prepare(`
    INSERT INTO audit_trail (event_type, entity_type, entity_id, action, actor, old_value, new_value, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    eventType,
    entityType,
    entityId,
    action,
    actor,
    typeof oldValue === 'object' ? JSON.stringify(oldValue) : oldValue,
    typeof newValue === 'object' ? JSON.stringify(newValue) : newValue,
    typeof metadata === 'object' ? JSON.stringify(metadata) : metadata,
    new Date().toISOString()
  );
}

/**
 * Get audit trail
 * @param {any} entityType
 * @param {any} entityId
 * @param {any} limit
 * @returns {any}
 */

function getAuditTrail(entityType = null, entityId = null, limit = 100) {
  if (entityType && entityId) {
    return db.prepare(`
      SELECT * FROM audit_trail WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(entityType, entityId, limit);
  }
  if (entityType) {
    return db.prepare(`
      SELECT * FROM audit_trail WHERE entity_type = ? ORDER BY created_at DESC LIMIT ?
    `).all(entityType, limit);
  }
  return db.prepare('SELECT * FROM audit_trail ORDER BY created_at DESC LIMIT ?').all(limit);
}

/**
 * Get audit summary
 * @param {any} days
 * @returns {any}
 */

function getAuditSummary(days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT event_type, action, COUNT(*) as count
    FROM audit_trail WHERE created_at > ?
    GROUP BY event_type, action
    ORDER BY count DESC
  `).all(since);
}

// ============================================
// Advanced Safeguards - Wave 4 Functions
// ============================================

/**
 * Run vulnerability scan on project dependencies
 * @param {any} taskId
 * @param {any} workingDirectory
 * @returns {any}
 */

function calculateTaskComplexityScore(taskId, taskDescription, _options = {}) {
  const now = new Date().toISOString();
  let score = 0;
  const factors = {};

  // Check for file creation indicators
  const createsFile = /create|new file|add file|implement.*class|implement.*service|implement.*interface/i.test(taskDescription);
  if (createsFile) {
    score += 2;
    factors.creates_file = 1;
  }

  // Check for interface implementation
  const implementsInterface = /implement.*interface|implements I[A-Z]|: I[A-Z]/i.test(taskDescription);
  if (implementsInterface) {
    score += 2;
    factors.implements_interface = 1;
  }

  // Check for XAML involvement
  const involvesXaml = /xaml|view|usercontrol|window|page|wpf|ui component/i.test(taskDescription);
  if (involvesXaml) {
    score += 3;
    factors.involves_xaml = 1;
  }

  // Estimate method count from description
  const methodMatches = taskDescription.match(/method|function|add.*\(\)|implement.*\(\)/gi);
  const methodCount = methodMatches ? methodMatches.length : 0;
  score += methodCount;
  factors.method_count = methodCount;

  // Check for large modification indicators
  const largeModification = /refactor|rewrite|restructure|major|multiple files/i.test(taskDescription);
  if (largeModification) {
    score += 2;
    factors.modifies_lines = 100; // Assumed
  }

  // Determine recommended provider
  const recommendedProvider = score > 4 ? 'claude-cli' : 'aider-ollama';

  // Record score
  db.prepare(`
    INSERT INTO task_complexity_scores (task_id, creates_file, implements_interface, method_count, involves_xaml, modifies_lines, total_score, recommended_provider, scored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    factors.creates_file || 0,
    factors.implements_interface || 0,
    factors.method_count || 0,
    factors.involves_xaml || 0,
    factors.modifies_lines || 0,
    score,
    recommendedProvider,
    now
  );

  return {
    task_id: taskId,
    total_score: score,
    factors,
    recommended_provider: recommendedProvider,
    routing_reason: score > 4
      ? `Complexity score ${score} > 4: route to cloud provider for better quality`
      : `Complexity score ${score} <= 4: suitable for local LLM`
  };
}

/**
 * Get task complexity score
 * @param {any} taskId
 * @returns {any}
 */

function getTaskComplexityScore(taskId) {
  return db.prepare('SELECT * FROM task_complexity_scores WHERE task_id = ?').get(taskId);
}

/**
 * Record an auto-rollback operation
 * @param {any} taskId
 * @param {any} triggerReason
 * @param {any} filesRolledBack
 * @param {any} options
 * @returns {any}
 */

function getSafeguardToolConfigs(safeguardType = null) {
  if (safeguardType) {
    return db.prepare('SELECT * FROM safeguard_tool_config WHERE safeguard_type = ? AND enabled = 1').all(safeguardType);
  }
  return db.prepare('SELECT * FROM safeguard_tool_config WHERE enabled = 1').all();
}

// ============================================
// File Location Safeguards (Wave 5)
// ============================================

/**
 * Set expected output path for a task
 * @param {any} taskId
 * @param {any} expectedDirectory
 * @param {any} options
 * @returns {any}
 */

module.exports = {
  setDb,
  setGetTask,
  getSyntaxValidators,
  listAllSyntaxValidators,
  runSyntaxValidation,
  createDiffPreview,
  getDiffPreview,
  markDiffReviewed,
  isDiffReviewRequired,
  recordQualityScore,
  getQualityScore,
  getProviderQualityStats,
  getOverallQualityStats,
  getQualityStatsByProvider,
  getValidationFailureRate,
  updateProviderStats,
  getProviderStats,
  getBestProviderForTaskType,
  detectProviderDegradation,
  runBuildCheck,
  getBuildCheck,
  saveBuildResult,
  classifyTaskType,
  checkRateLimit,
  recordRateLimitEvent,
  getRateLimits,
  setRateLimit,
  setOutputLimit,
  checkOutputSizeLimits,
  getOutputViolations,
  recordAuditEvent,
  getAuditTrail,
  getAuditSummary,
  calculateTaskComplexityScore,
  getTaskComplexityScore,
  getSafeguardToolConfigs
};
