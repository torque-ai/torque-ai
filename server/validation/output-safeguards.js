/**
 * Output Safeguards Module
 *
 * Post-task validation pipeline: quality scoring, security scanning,
 * build checks, accessibility, XAML validation, etc.
 *
 * Extracted from task-manager.js (Phase 5 decomposition).
 */

const path = require('path');
const fs = require('fs');
const { CODE_EXTENSIONS, SOURCE_EXTENSIONS, UI_EXTENSIONS } = require('../constants');
const serverConfig = require('../config');
const logger = require('../logger').child({ component: 'output-safeguards' });
const piiGuard = require('../utils/pii-guard');

// ─── Legacy module-level state, written only by init() (deprecated) ────────
// Phase 2c of the universal-DI migration: this module exposes both the new
// createOutputSafeguards factory + register(container) shape and the legacy
// init({…}) shape. Legacy state is removed when task-manager.js migrates
// to consume via container.
let db = null;
let _getFileChangesForValidation = null;
let _checkFileQuality = null;
let _cleanupJunkFiles = null;
let _findPlaceholderArtifacts = null;

/** @deprecated Use createOutputSafeguards(deps) or container.get('outputSafeguards'). */
function init(deps) {
  if (deps.db) db = deps.db;
  if (deps.getFileChangesForValidation) _getFileChangesForValidation = deps.getFileChangesForValidation;
  if (deps.checkFileQuality) _checkFileQuality = deps.checkFileQuality;
  if (deps.cleanupJunkFiles) _cleanupJunkFiles = deps.cleanupJunkFiles;
  if (deps.findPlaceholderArtifacts) _findPlaceholderArtifacts = deps.findPlaceholderArtifacts;
}

// ─── Secret Sanitization ────────────────────────────────────────────────────

// Maximum input length for secret pattern matching (ReDoS protection)
const MAX_SANITIZE_LENGTH = 100000; // 100KB

// Patterns that may indicate secrets in output (used for sanitization)
// SECURITY: Patterns are designed to avoid catastrophic backtracking:
// - Use anchored/bounded quantifiers where possible
// - Limit repetition lengths to prevent ReDoS
// - Avoid nested quantifiers like (a+)+
const SECRET_PATTERNS = [
  /api[_-]?key[=:\s]+['"]?[\w-]{20,64}/gi,        // API keys (bounded length)
  /secret[=:\s]+['"]?[\w-]{16,128}/gi,             // Secrets (bounded length)
  /password[=:\s]+['"]?[^\s'"]{8,64}/gi,           // Passwords (bounded length)
  /bearer\s+[\w\-_.]{10,500}/gi,                   // Bearer tokens (bounded, safe chars)
  /authorization[=:\s]+['"]?[\w\-_.=+/]{10,500}/gi, // Auth headers (bounded, safe chars)
  /token[=:\s]+['"]?[\w-]{20,256}/gi,              // Tokens (bounded length)
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,  // Private keys (no quantifiers on groups)
  /aws[_-]?(?:access[_-]?key|secret)[=:\s]+['"]?[\w]{16,64}/gi,  // AWS keys (bounded, no nested groups)
  /scrypt:[0-9a-f]{32}:[0-9a-f]{64}/g,    // Agent secret hashes
  /X-Torque-Key:\s*\S+/gi,                 // Auth header in logs
  /X-Torque-Secret:\s*\S+/gi,              // Agent secret header
  /Authorization:\s*Bearer\s+\S+/gi        // Bearer tokens in headers
];

/**
 * Sanitize output text by redacting potential secrets
 * SECURITY: Implements length limit to prevent ReDoS attacks
 * @param {string} text - The text to sanitize
 * @returns {string} Sanitized text with secrets redacted
 */
function sanitizeOutputForCondition(text) {
  if (typeof text !== 'string') return '';

  // SECURITY: Limit input length to prevent ReDoS attacks
  // For very long strings, truncate before pattern matching
  const truncated = text.length > MAX_SANITIZE_LENGTH
    ? text.substring(0, MAX_SANITIZE_LENGTH) + '\n[OUTPUT TRUNCATED FOR SECURITY SCANNING]'
    : text;

  let sanitized = truncated;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns to ensure consistent behavior
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

function truncateOptionalText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLength);
}

const NON_MUTATING_FACTORY_INTERNAL_KINDS = new Set([
  'architect_cycle',
  'plan_generation',
]);

function parseJsonField(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getTaskMetadata(task) {
  const value = task?.metadata !== undefined && task?.metadata !== null && task.metadata !== ''
    ? task.metadata
    : task?.task_metadata;
  return parseJsonField(value, {});
}

function getTaskTags(task) {
  const parsed = parseJsonField(task?.tags, []);
  return Array.isArray(parsed) ? parsed : [];
}

function patchTaskSafeguardMetadata(taskId, updates) {
  if (!db || typeof db.getTask !== 'function' || typeof db.patchTaskMetadata !== 'function') {
    return false;
  }

  try {
    const task = db.getTask(taskId);
    const metadata = getTaskMetadata(task);
    const priorSafeguards = metadata.output_safeguards && typeof metadata.output_safeguards === 'object'
      ? metadata.output_safeguards
      : {};

    return db.patchTaskMetadata(taskId, {
      ...metadata,
      output_safeguards: {
        ...priorSafeguards,
        ...updates,
        updated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    logSafeguardError(taskId, 'Failed to persist safeguard metadata', err);
    return false;
  }
}

function shouldSkipOutputSafeguards(task) {
  const metadata = getTaskMetadata(task);
  const tags = getTaskTags(task);
  const factoryInternal = metadata.factory_internal === true || tags.includes('factory:internal');
  if (!factoryInternal) return false;

  const kind = typeof metadata.kind === 'string' ? metadata.kind : null;
  if (kind && NON_MUTATING_FACTORY_INTERNAL_KINDS.has(kind)) return true;

  return metadata.factory_plan_review === true || tags.includes('factory:plan_review');
}

function logSafeguardError(taskId, label, err) {
  const message = err?.message || String(err);
  logger.info(`[Safeguard] ${label} for task ${taskId}: ${message}`);
  if (err?.stack) {
    logger.debug(`[Safeguard] ${label} stack for task ${taskId}: ${err.stack}`);
  }
}

function validateFileSizes(taskId, status, task, db, retryEnabled) {
  let validationScore = 100;

  if (status !== 'completed') return { validationScore };
  if (!_getFileChangesForValidation) return { validationScore };

  const fileChanges = _getFileChangesForValidation(task?.working_directory, 1);
  logger.info(`Safeguard: validating ${fileChanges.length} changed files for task ${taskId}`);

  const validationResults = db.validateTaskOutput(taskId, fileChanges);

  if (validationResults.length > 0) {
    const criticalOrErrors = validationResults.filter(r =>
      r.severity === 'critical' || r.severity === 'error'
    );

    validationScore = Math.max(0, 100 - (criticalOrErrors.length * 20) - (validationResults.length - criticalOrErrors.length) * 5);

    if (criticalOrErrors.length > 0) {
      logger.info(`[Safeguard] Task ${taskId} has ${criticalOrErrors.length} validation errors`);
      patchTaskSafeguardMetadata(taskId, {
        validation_status: 'failed',
      });

      const hasCriticalAutoFail = criticalOrErrors.some(r =>
        r.severity === 'critical' || r.auto_fail === true
      );

      if (hasCriticalAutoFail && task?.working_directory) {
        const autoRollbackOnValidation = serverConfig.getBool('auto_rollback_on_validation_failure');
        if (autoRollbackOnValidation) {
          logger.info(`[Safeguard] Auto-rollback triggered for ${taskId} due to critical validation failure`);

          for (const fc of fileChanges) {
            try {
              db.recordFileChange(taskId, fc.path, 'modified', {
                fileSizeBytes: fc.size,
                workingDirectory: task.working_directory
              });
            } catch (e) {
              logger.info(`[Safeguard] Failed to record file change: ${e.message}`);
            }
          }

          const rollback = db.performAutoRollback(taskId, task.working_directory, 'validation_failure', 1);
          if (rollback.success) {
            logger.info(`[Safeguard] Auto-rollback successful: ${rollback.files_processed} file(s) restored`);
            try {
              const currentTask = db.getTask(taskId);
              if (currentTask && currentTask.status !== 'failed' && currentTask.status !== 'cancelled') {
                db.updateTaskStatus(taskId, 'failed', { error_output: 'Critical validation failure - files auto-rolled back: ' + criticalOrErrors.map(e => e.rule_name || e.message).join(', '), completed_at: new Date().toISOString() });
              }
            } catch (e) {
              logger.info(`[Safeguard] Failed to update task status: ${e.message}`);
            }
          } else {
            logger.info(`[Safeguard] Auto-rollback had errors: ${JSON.stringify(rollback.errors)}`);
          }
        }
      }

      if (retryEnabled) {
        const retryDecision = db.shouldRetryWithCloud(taskId, task?.output || '', {
          validation_failed: true,
          provider: task?.provider
        });

        if (retryDecision.shouldRetry) {
          logger.info(`[Safeguard] Triggering adaptive retry for ${taskId} → ${retryDecision.fallbackProvider}`);
        }
      }
    }
  }

  return { validationScore };
}

async function detectTruncatedFiles(taskId, status, task, db) {
  let syntaxScore = 100;

  if (status !== 'completed' || !task?.working_directory) return { syntaxScore };

  const fileChangesForQuality = _getFileChangesForValidation
    ? _getFileChangesForValidation(task.working_directory, 1)
    : [];

  for (const fc of fileChangesForQuality) {
    const fullPath = path.join(task.working_directory, fc.path);
    try {
      if (_checkFileQuality) {
        const qr = _checkFileQuality(fullPath);
        if (!qr.valid) {
          syntaxScore = Math.max(0, syntaxScore - 15 * qr.issues.length);
          logger.info(`[Safeguard] File quality issues in ${fc.path}: ${qr.issues.join('; ')}`);
        }
      }
    } catch { /* ignore */ }

    try {
      const sr = await db.runSyntaxValidation(fullPath, task.working_directory);
      if (sr && sr.results) {
        const failures = sr.results.filter(r => !r.success);
        if (failures.length > 0) {
          syntaxScore = Math.max(0, syntaxScore - 25 * failures.length);
          logger.info(`[Safeguard] Syntax validation failures in ${fc.path}: ${failures.map(f => f.validator).join(', ')}`);
        }
      }
    } catch { /* validator not available */ }
  }

  return { syntaxScore };
}

function detectStubImplementations(taskId, status, task) {
  if (status !== 'completed' || !task?.working_directory || task?.provider !== 'ollama') return;

  try {
    _cleanupJunkFiles(task.working_directory, taskId);
  } catch (err) {
    logger.info(`[Safeguard] Junk file cleanup error for ${taskId}: ${err.message}`);
  }

  try {
    const placeholderResult = _findPlaceholderArtifacts
      ? _findPlaceholderArtifacts(task.working_directory)
      : { valid: true, issues: [] };
    if (!placeholderResult.valid) {
      const diagnostics = placeholderResult.issues.join('\n');
      patchTaskSafeguardMetadata(taskId, {
        validation_status: 'failed',
        validation_issues: diagnostics,
      });
      logger.error(`[Safeguard] Placeholder artifacts remain after task ${taskId}:\n${diagnostics}`);
    }
  } catch (err) {
    logger.info(`[Safeguard] Placeholder artifact reporting error for ${taskId}: ${err.message}`);
  }
}

// ─── Main Output Safeguards Pipeline ────────────────────────────────────────

async function runOutputSafeguards(taskId, status, task) {
  try {
    if (shouldSkipOutputSafeguards(task)) {
      logger.info(`[Safeguard] Skipping output safeguards for non-mutating factory-internal task ${taskId}`);
      return;
    }

    // Check if adaptive retry is enabled
    const retryEnabled = serverConfig.getBool('adaptive_retry_enabled');
    const qualityScoringEnabled = serverConfig.getBool('quality_scoring_enabled');
    const providerStatsEnabled = serverConfig.getBool('provider_stats_enabled');
    const buildCheckEnabled = serverConfig.getBool('build_check_enabled', true);

    let validationScore = 100;
    let syntaxScore = 100;
    let completenessScore = 100;

    // 1. Run output validation (for completed tasks)
    const { validationScore: vs } = validateFileSizes(taskId, status, task, db, retryEnabled);
    validationScore = vs;

    // 1-PII. Sanitize PII in task output and file changes
    if (status === 'completed' && task?.working_directory) {
      try {
        let piiConfig = null;
        try {
          const projectConfigCore = require('../db/project-config-core');
          const pcc = typeof projectConfigCore === 'function' ? projectConfigCore() : projectConfigCore;
          const project = pcc.getProjectFromPath(task.working_directory);
          if (project) {
            const piiJson = pcc.getProjectMetadata(project, 'pii_guard');
            if (piiJson) piiConfig = JSON.parse(piiJson);
          }
        } catch { /* no project config */ }

        if (!piiConfig || piiConfig.enabled !== false) {
          const options = {};
          if (piiConfig) {
            options.customPatterns = piiConfig.custom_patterns || [];
            if (piiConfig.builtin_categories) {
              options.builtinOverrides = {};
              for (const [cat, enabled] of Object.entries(piiConfig.builtin_categories)) {
                if (enabled === false) options.builtinOverrides[cat] = false;
              }
            }
          }

          if (task.output) {
            const result = piiGuard.scanAndReplace(task.output, options);
            if (!result.clean) {
              logger.info(`[Safeguard] PII guard sanitized ${result.findings.length} finding(s) in output for ${taskId}`);
              task.output = result.sanitized;
            }
          }

          const fileChanges = _getFileChangesForValidation ? _getFileChangesForValidation(task.working_directory, 1) : [];
          for (const fc of fileChanges) {
            try {
              const fullPath = path.join(task.working_directory, fc.path);
              if (fs.existsSync(fullPath)) {
                const content = fs.readFileSync(fullPath, 'utf8');
                const result = piiGuard.scanAndReplace(content, options);
                if (!result.clean) {
                  fs.writeFileSync(fullPath, result.sanitized, 'utf8');
                  logger.info(`[Safeguard] PII guard sanitized ${result.findings.length} finding(s) in ${fc.path}`);
                }
              }
            } catch (err) {
              logger.debug(`[Safeguard] PII scan error for ${fc.path}: ${err.message}`);
            }
          }
        }
      } catch (err) {
        logger.info(`[Safeguard] PII guard error for ${taskId}: ${err.message}`);
      }
    }

    // 1a. Wire checkFileQuality + runSyntaxValidation into syntaxScore
    const { syntaxScore: ss } = await detectTruncatedFiles(taskId, status, task, db);
    syntaxScore = ss;

    // 1b. Clean up junk files created by LLM hallucinating filenames
    detectStubImplementations(taskId, status, task);

    // 2. Check for failure patterns (for both completed and failed tasks)
    const output = task?.output || task?.error_output || '';
    if (output) {
      const matches = db.matchFailurePatterns(taskId, output, task?.provider);
      if (matches.length > 0) {
        logger.info(`[Safeguard] Task ${taskId} matched ${matches.length} failure patterns`);

        // Check if adaptive retry should be triggered
        if (retryEnabled && status === 'completed') {
          const retryDecision = db.shouldRetryWithCloud(taskId, output, {
            failure_patterns_matched: matches.length,
            provider: task?.provider
          });

          if (retryDecision.shouldRetry) {
            logger.info(`[Safeguard] Failure patterns detected, consider retry with ${retryDecision.fallbackProvider}`);
          }
        }
      }
    }

    // 3. Check approval requirements (for completed tasks)
    if (status === 'completed') {
      const approvalRequired = db.checkApprovalRequired(taskId, {
        provider: task?.provider,
        output_size: (task?.output || '').length
      });

      if (approvalRequired.required) {
        logger.info(`[Safeguard] Task ${taskId} requires approval: ${approvalRequired.reason}`);
      }
    }

    // 4. Calculate and record quality score
    if (qualityScoringEnabled && status === 'completed') {
      const taskType = db.classifyTaskType(task?.task_description || '');

      // Compute completenessScore based on file changes
      {
        const fcCheck = _getFileChangesForValidation(task?.working_directory, 1);
        if (fcCheck.length > 0) {
          completenessScore = 100;
        } else if (output.length > 0) {
          completenessScore = 30;
        } else {
          completenessScore = 0;
        }
      }

      db.recordQualityScore(taskId, task?.provider || 'unknown', taskType, {
        validation: validationScore,
        syntax: syntaxScore,
        completeness: completenessScore,
        metrics: { outputLength: output.length }
      });

      const overallScore = validationScore * 0.4 + syntaxScore * 0.3 + completenessScore * 0.3;
      logger.info(`[Safeguard] Quality score recorded for ${taskId}: ${overallScore.toFixed(1)}`);
    }

    // 5. Update provider statistics (isolated — must not be killed by other safeguard failures)
    try {
      if (providerStatsEnabled) {
        const taskType = db.classifyTaskType(task?.task_description || '');
        const durationSeconds = task?.started_at && task?.completed_at
          ? (new Date(task.completed_at) - new Date(task.started_at)) / 1000
          : null;

        const qualityScore = qualityScoringEnabled
          ? (validationScore * 0.4 + syntaxScore * 0.3 + completenessScore * 0.3)
          : null;

        db.updateProviderStats(
          task?.provider || 'unknown',
          taskType,
          status === 'completed',
          qualityScore,
          durationSeconds
        );

        logger.info(`[Safeguard] Provider stats updated: ${task?.provider || 'unknown'} / ${taskType}`);
      }
    } catch (statsErr) {
      logger.info(`[Safeguard] Provider stats recording error for ${taskId}: ${statsErr.message}`);
    }

    // 6. Run build check (if enabled and task was code-related)
    if (buildCheckEnabled && status === 'completed' && task?.working_directory) {
      const taskType = db.classifyTaskType(task?.task_description || '');
      const isCodeTask = ['feature', 'bugfix', 'refactoring', 'modification'].includes(taskType);

      if (isCodeTask) {
        logger.info(`[Safeguard] Running build check for ${taskId}...`);
        db.runBuildCheck(taskId, task.working_directory)
          .then(result => {
            if (result.checked) {
              logger.info(`[Safeguard] Build check ${result.passed ? 'PASSED' : 'FAILED'} for ${taskId}`);
            }
          })
          .catch(err => {
            logSafeguardError(taskId, 'Build check error', err);
          });
      }
    }

    // ============ Extended Safeguards ============
    // Each section isolated so failures don't cascade

    try { // Extended safeguards block

    // 7. Record cost tracking (for cloud providers)
    const costTrackingEnabled = serverConfig.getBool('cost_tracking_enabled');
    if (costTrackingEnabled && status === 'completed' && task?.provider) {
      const outputLength = (task?.output || '').length;
      const inputLength = (task?.task_description || '').length;
      const estimatedInputTokens = Math.ceil(inputLength / 4);
      const estimatedOutputTokens = Math.ceil(outputLength / 4);

      {
        db.recordCost(
          task.provider,
          taskId,
          estimatedInputTokens,
          estimatedOutputTokens,
          task.model || null
        );
        logger.info(`[Safeguard] Cost tracked for ${taskId}: ~${estimatedInputTokens}/${estimatedOutputTokens} tokens`);
      }
    }

    // 8. Run security scan (for completed code tasks)
    const securityScanEnabled = serverConfig.getBool('security_scan_enabled');
    if (securityScanEnabled && status === 'completed' && task?.working_directory) {
      const fileChanges = db.getTaskFileChanges(taskId);
      let totalIssues = 0;

      for (const change of fileChanges) {
        if (change.new_content && change.file_path) {
          const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
          if (CODE_EXTENSIONS.has(ext.toLowerCase())) {
            const issues = db.runSecurityScan(taskId, change.file_path, change.new_content);
            totalIssues += issues.length;
          }
        }
      }

      if (totalIssues > 0) {
        logger.info(`[Safeguard] Security scan found ${totalIssues} potential issues for ${taskId}`);
      }
    }

    // 9. Check timeout alerts
    const timeoutAlertsEnabled = serverConfig.getBool('timeout_alerts_enabled');
    if (timeoutAlertsEnabled && task?.timeout_minutes) {
      const alerts = db.getTimeoutAlerts(taskId);
      if (alerts.length > 0) {
        logger.info(`[Safeguard] Task ${taskId} had ${alerts.length} timeout alert(s)`);
      }
    }

    // 10. Check output size limits
    const outputLimitsEnabled = serverConfig.getBool('output_limits_enabled');
    if (outputLimitsEnabled && status === 'completed' && task?.provider) {
      const outputSize = (task?.output || '').length;
      const fileChanges = db.getTaskFileChanges(taskId).map(c => ({
        path: c.file_path,
        size: (c.new_content || '').length
      }));

      const limitCheck = db.checkOutputSizeLimits(taskId, task.provider, outputSize, fileChanges);
      if (!limitCheck.withinLimits) {
        logger.info(`[Safeguard] Output size limit exceeded for ${taskId}: ${JSON.stringify(limitCheck.violations || [])}`);
      }
    }

    // 11. Record audit trail event
    const auditEnabled = serverConfig.getBool('audit_trail_enabled');
    if (auditEnabled) {
      db.recordAuditEvent(
        'task_status_change',
        'task',
        taskId,
        status,
        task?.provider || 'system',
        null,
        { status, provider: task?.provider, working_directory: task?.working_directory }
      );
    }

    // 12. Release file locks (for completed/failed tasks)
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      const released = db.releaseAllFileLocks(taskId);
      if (released > 0) {
        logger.info(`[Safeguard] Released ${released} file lock(s) for ${taskId}`);
      }
    }

    // ============ Advanced Safeguards - Wave 4 ============

    // 13. Analyze code complexity (for completed code tasks)
    const complexityEnabled = serverConfig.getBool('complexity_analysis_enabled');
    if (complexityEnabled && status === 'completed') {
      const fileChanges = db.getTaskFileChanges(taskId);
      let highComplexityCount = 0;

      for (const change of fileChanges) {
        if (change.new_content && change.file_path) {
          const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
          if (CODE_EXTENSIONS.has(ext.toLowerCase())) {
            const metrics = db.analyzeCodeComplexity(taskId, change.file_path, change.new_content);
            if (metrics.cyclomatic_complexity > 10) {
              highComplexityCount++;
            }
          }
        }
      }

      if (highComplexityCount > 0) {
        logger.info(`[Safeguard] ${highComplexityCount} file(s) have high complexity (>10) for ${taskId}`);
      }
    }

    // 14. Check documentation coverage (for completed code tasks)
    const docCoverageEnabled = serverConfig.getBool('doc_coverage_enabled');
    if (docCoverageEnabled && status === 'completed') {
      const fileChanges = db.getTaskFileChanges(taskId);
      let lowCoverageCount = 0;

      for (const change of fileChanges) {
        if (change.new_content && change.file_path) {
          const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
          if (CODE_EXTENSIONS.has(ext.toLowerCase())) {
            const coverage = db.checkDocCoverage(taskId, change.file_path, change.new_content);
            if (coverage.coverage_percent < 50 && coverage.total_public_items > 0) {
              lowCoverageCount++;
            }
          }
        }
      }

      if (lowCoverageCount > 0) {
        logger.info(`[Safeguard] ${lowCoverageCount} file(s) have low doc coverage (<50%) for ${taskId}`);
      }
    }

    // 15. Check accessibility (for UI code)
    const a11yEnabled = serverConfig.getBool('accessibility_check_enabled');
    if (a11yEnabled && status === 'completed') {
      const fileChanges = db.getTaskFileChanges(taskId);
      let totalViolations = 0;

      for (const change of fileChanges) {
        if (change.new_content && change.file_path) {
          const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
          if (UI_EXTENSIONS.has(ext.toLowerCase())) {
            const a11y = db.checkAccessibility(taskId, change.file_path, change.new_content);
            totalViolations += a11y.violations_count;
          }
        }
      }

      if (totalViolations > 0) {
        logger.info(`[Safeguard] ${totalViolations} accessibility violation(s) found for ${taskId}`);
      }
    }

    // 16. Estimate resource usage (detect risky patterns)
    const resourceEstEnabled = serverConfig.getBool('resource_estimation_enabled');
    if (resourceEstEnabled && status === 'completed') {
      const fileChanges = db.getTaskFileChanges(taskId);

      for (const change of fileChanges) {
        if (change.new_content && change.file_path) {
          const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
          if (SOURCE_EXTENSIONS.has(ext.toLowerCase())) {
            const estimate = db.estimateResourceUsage(taskId, change.file_path, change.new_content);
            if (estimate.risk_factors?.length > 0) {
              logger.info(`[Safeguard] Resource risk factors in ${change.file_path}: ${estimate.risk_factors.join(', ')}`);
            }
          }
        }
      }
    }

    // 17. Detect configuration drift (if baselines exist)
    const driftDetectionEnabled = serverConfig.getBool('config_drift_enabled');
    if (driftDetectionEnabled && status === 'completed' && task?.working_directory) {
      const drift = db.detectConfigDrift(taskId, task.working_directory);
      if (drift.count > 0) {
        logger.info(`[Safeguard] Configuration drift detected: ${drift.count} file(s) changed for ${taskId}`);
      }
    }

    // ============ File Location Safeguards - Wave 5 ============

    // 18. Check for files created outside expected directories
    const locationCheckEnabled = serverConfig.getBool('file_location_check_enabled');
    if (locationCheckEnabled && status === 'completed' && task?.working_directory) {
      const anomalies = db.checkFileLocationAnomalies(taskId, task.working_directory);
      if (anomalies.length > 0) {
        logger.info(`[Safeguard] File location anomalies detected for ${taskId}:`);
        for (const anomaly of anomalies) {
          logger.info(`  - ${anomaly.anomaly_type}: ${anomaly.file_path}`);
        }
      }
    }

    // 19. Check for duplicate files (same name in different locations)
    const duplicateCheckEnabled = serverConfig.getBool('duplicate_file_check_enabled');
    if (duplicateCheckEnabled && status === 'completed' && task?.working_directory) {
      const duplicates = await db.checkDuplicateFiles(taskId, task.working_directory);
      if (duplicates.length > 0) {
        logger.info(`[Safeguard] Duplicate files detected for ${taskId}:`);
        for (const dup of duplicates) {
          logger.info(`  - ${dup.file_name} found in ${dup.location_count} locations`);
          if (dup.locations) {
            for (const loc of dup.locations) {
              logger.info(`      ${loc}`);
            }
          }
        }
      }
    }

    // ============ Code Verification Safeguards - Wave 6 ============

    // 20. Verify type references exist (detect hallucinated interfaces)
    const typeVerifyEnabled = serverConfig.getBool('type_verification_enabled');
    if (typeVerifyEnabled && status === 'completed' && task?.working_directory) {
      const fileChanges = db.getTaskFileChanges(taskId);
      let missingTypesTotal = 0;

      for (const change of fileChanges) {
        if (change.new_content && change.file_path) {
          const codeExtensions = ['.cs', '.ts', '.tsx'];
          const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
          if (codeExtensions.includes(ext.toLowerCase())) {
            const verification = db.verifyTypeReferences(taskId, change.file_path, change.new_content, task.working_directory);
            missingTypesTotal += verification.missing_types;
          }
        }
      }

      if (missingTypesTotal > 0) {
        logger.info(`[Safeguard] Type verification found ${missingTypesTotal} missing/hallucinated type(s) for ${taskId}`);
      }
    }

    // 21. Analyze build output for errors (after build check runs)
    const buildAnalysisEnabled = serverConfig.getBool('build_analysis_enabled');
    if (buildAnalysisEnabled && status === 'completed' && task?.working_directory) {
      const buildResults = db.prepare ? db.prepare('SELECT * FROM build_checks WHERE task_id = ? ORDER BY checked_at DESC LIMIT 1').get(taskId) : null;
      if (buildResults && buildResults.exit_code !== 0 && buildResults.error_output) {
        const analysis = db.analyzeBuildOutput(taskId, buildResults.error_output);
        if (analysis.errors_found > 0) {
          logger.info(`[Safeguard] Build error analysis for ${taskId}:`);
          logger.info(`  - ${analysis.errors_found} error(s) found`);
          if (analysis.has_namespace_conflicts) {
            logger.info(`  - Namespace conflicts detected (CS0104)`);
          }
          if (analysis.has_missing_types) {
            logger.info(`  - Missing types detected (CS0246)`);
          }

          // 22. Auto-rollback on build failure (if enabled)
          const autoRollbackEnabled = serverConfig.isOptIn('auto_rollback_on_build_failure');
          if (autoRollbackEnabled) {
            logger.info(`[Safeguard] Auto-rollback triggered for ${taskId} due to build failure`);
            const rollback = db.performAutoRollback(taskId, task.working_directory, 'build_failure', 1);
            if (rollback.success) {
              logger.info(`[Safeguard] Auto-rollback successful: ${rollback.files_processed} file(s) restored`);
            } else {
              logger.info(`[Safeguard] Auto-rollback had errors: ${JSON.stringify(rollback.errors)}`);
            }
          }
        }
      }
    }

    // ============ XAML Validation Safeguards - Wave 7 ============

    // 23. Validate XAML semantics (detect TemplateBinding misuse, etc.)
    const xamlValidationEnabled = serverConfig.getBool('xaml_validation_enabled');
    if (xamlValidationEnabled && status === 'completed' && task?.working_directory) {
      const fileChanges = db.getTaskFileChanges(taskId);
      let xamlIssuesTotal = 0;

      for (const change of fileChanges) {
        if (change.new_content && change.file_path) {
          const ext = change.file_path.substring(change.file_path.lastIndexOf('.')).toLowerCase();
          if (ext === '.xaml') {
            const validation = db.validateXamlSemantics(taskId, change.file_path, change.new_content);
            xamlIssuesTotal += validation.errors;

            // 24. Check XAML/code-behind consistency
            const xamlConsistencyEnabled = serverConfig.getBool('xaml_consistency_enabled');
            if (xamlConsistencyEnabled) {
              const codeBehindPath = change.file_path + '.cs';
              const codeBehindChange = fileChanges.find(c => c.file_path === codeBehindPath);
              if (codeBehindChange?.new_content) {
                const consistency = db.checkXamlCodeBehindConsistency(
                  taskId,
                  change.file_path,
                  change.new_content,
                  codeBehindChange.new_content
                );
                if (consistency.errors > 0) {
                  logger.info(`[Safeguard] XAML/code-behind consistency issues for ${change.file_path}: ${consistency.errors} error(s)`);
                }
              } else {
                try {
                  const fullPath = path.isAbsolute(codeBehindPath) ? codeBehindPath : path.join(task.working_directory, codeBehindPath);
                  if (fs.existsSync(fullPath)) {
                    const codeBehindContent = fs.readFileSync(fullPath, 'utf8');
                    const consistency = db.checkXamlCodeBehindConsistency(
                      taskId,
                      change.file_path,
                      change.new_content,
                      codeBehindContent
                    );
                    if (consistency.errors > 0) {
                      logger.info(`[Safeguard] XAML/code-behind consistency issues for ${change.file_path}: ${consistency.errors} error(s)`);
                    }
                  }
                } catch {
                  // Silently skip if we can't read the code-behind
                }
              }
            }
          }
        }
      }

      if (xamlIssuesTotal > 0) {
        logger.info(`[Safeguard] XAML validation found ${xamlIssuesTotal} semantic error(s) for ${taskId}`);
      }
    }

    // 25. Run app smoke test after XAML changes (if enabled)
    const smokeTestEnabled = serverConfig.isOptIn('xaml_smoke_test_enabled');
    if (smokeTestEnabled && status === 'completed' && task?.working_directory) {
      const fileChanges = db.getTaskFileChanges(taskId);
      const hasXamlChanges = fileChanges.some(c =>
        c.file_path?.toLowerCase().endsWith('.xaml') ||
        c.file_path?.toLowerCase().endsWith('.xaml.cs')
      );

      if (hasXamlChanges) {
        logger.info(`[Safeguard] Running app smoke test for ${taskId} due to XAML changes`);
        try {
          const smokeResult = db.runAppSmokeTestSync(taskId, task.working_directory, { timeoutSeconds: 10 });
          if (!smokeResult.passed) {
            logger.info(`[Safeguard] Smoke test FAILED for ${taskId} (exit code: ${smokeResult.exit_code})`);
            const errorOutput = truncateOptionalText(smokeResult.error_output, 500);
            if (errorOutput) {
              logger.info(`[Safeguard] Smoke test error: ${errorOutput}`);
            }
          } else {
            logger.info(`[Safeguard] Smoke test PASSED for ${taskId}`);
          }
        } catch (smokeErr) {
          logger.info(`[Safeguard] Smoke test execution error for ${taskId}: ${smokeErr.message}`);
        }
      }
    }

    } catch (extErr) {
      logger.info(`[Safeguard] Extended safeguards error for ${taskId}: ${extErr.message}`);
    }

  } catch (err) {
    logSafeguardError(taskId, 'Error running safeguards', err);
  }
}

// ── New factory shape (preferred) ─────────────────────────────────────────
/**
 * Build an outputSafeguards service that closes over its deps.
 * Uses the same module-state-swap pattern as the rest of the validation/
 * Phase 2 cohort: temporarily binds legacy state for each call, restores
 * after. Legacy state is deleted in Phase 5 when consumers migrate.
 *
 * Note: only `runOutputSafeguards` reads from the legacy state; the other
 * exported functions (sanitizeOutputForCondition, truncateOptionalText,
 * shouldSkipOutputSafeguards, patchTaskSafeguardMetadata) are pure and
 * the constants are static, so they are exposed directly.
 */
function createOutputSafeguards(deps = {}) {
  const local = {
    db: deps.db,
    _getFileChangesForValidation: deps.getFileChangesForValidation,
    _checkFileQuality: deps.checkFileQuality,
    _cleanupJunkFiles: deps.cleanupJunkFiles,
    _findPlaceholderArtifacts: deps.findPlaceholderArtifacts,
  };

  return {
    runOutputSafeguards(...args) {
      const prev = {
        db, _getFileChangesForValidation, _checkFileQuality,
        _cleanupJunkFiles, _findPlaceholderArtifacts,
      };
      db = local.db;
      _getFileChangesForValidation = local._getFileChangesForValidation;
      _checkFileQuality = local._checkFileQuality;
      _cleanupJunkFiles = local._cleanupJunkFiles;
      _findPlaceholderArtifacts = local._findPlaceholderArtifacts;
      try {
        return runOutputSafeguards(...args);
      } finally {
        ({
          db, _getFileChangesForValidation, _checkFileQuality,
          _cleanupJunkFiles, _findPlaceholderArtifacts,
        } = prev);
      }
    },
    // Pure functions — no deps to swap
    sanitizeOutputForCondition,
    truncateOptionalText,
    shouldSkipOutputSafeguards,
    patchTaskSafeguardMetadata,
  };
}

/**
 * Register with a DI container under the name 'outputSafeguards'.
 */
function register(container) {
  container.register(
    'outputSafeguards',
    [
      'db',
      'getFileChangesForValidation',
      'checkFileQuality',
      'cleanupJunkFiles',
      'findPlaceholderArtifacts',
    ],
    (deps) => createOutputSafeguards(deps)
  );
}

module.exports = {
  // New shape (preferred)
  createOutputSafeguards,
  register,
  // Legacy shape (kept until task-manager.js migrates)
  init,
  runOutputSafeguards,
  sanitizeOutputForCondition,
  truncateOptionalText,
  shouldSkipOutputSafeguards,
  patchTaskSafeguardMetadata,
  MAX_SANITIZE_LENGTH,
  SECRET_PATTERNS,
};
