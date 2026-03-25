'use strict';

/**
 * File Tracking & Safeguards Module
 *
 * Extracted from database.js lines 18249-21217 — file baselines, syntax validation,
 * diff previews, quality scoring, provider stats, rollbacks, build checks, rate limiting,
 * cost tracking delegation, duplicate detection, file locks, backups, security scanning,
 * test coverage, style checks, change impact, timeout alerts, output limits, audit trail,
 * vulnerability scanning, code analysis delegation, API contracts, doc coverage delegation,
 * regression detection, config drift, resource estimation delegation, i18n delegation,
 * accessibility delegation, safeguard configs, file location safeguards, code verification
 * delegation, similar file search, complexity scoring, auto-rollback, XAML validation,
 * and smoke tests.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Uses setGetTask() to receive the getTask helper (avoids circular require).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TASK_TIMEOUTS } = require('../constants');
const codeAnalysis = require('./code-analysis');
const costTracking = require('./cost-tracking');
const fileBaselines = require('./file-baselines');
const fileQuality = require('./file-quality');
const fileTrackingScans = require('./file-tracking-scans');
const conflictLogger = require('../logger').child({ component: 'file-conflict-tracking' });

const {
  captureFileBaseline,
  getFileBaseline,
  compareFileToBaseline,
  captureDirectoryBaselines,
  createFileBackup,
  restoreFileBackup,
  getTaskBackups,
  acquireFileLock,
  releaseFileLock,
  releaseAllFileLocks,
  getActiveFileLocks,
  createRollback,
  getRollback,
  completeRollback,
  listRollbacks,
  recordAutoRollback,
  getAutoRollbackHistory,
  performAutoRollback,
  setExpectedOutputPath,
  getExpectedOutputPaths,
  recordFileChange,
  getTaskFileChanges,
  recordFileLocationAnomaly,
  getFileLocationAnomalies,
  resolveFileLocationAnomaly,
  recordDuplicateFile,
  getDuplicateFileDetections,
  resolveDuplicateFile,
  checkFileLocationAnomalies,
  checkDuplicateFiles,
  getAllFileLocationIssues,
  searchSimilarFiles,
  getSimilarFileSearchResults,
} = fileBaselines;

const {
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
  getSafeguardToolConfigs,
} = fileQuality;

let db;
let getTaskFn;

let _conflictDataDir = null;

function setDb(dbInstance) {
  db = dbInstance;
  fileBaselines.setDb(dbInstance);
  fileQuality.setDb(dbInstance);
  fileTrackingScans.setDb(dbInstance);
}

function setGetTask(fn) {
  getTaskFn = fn;
  fileBaselines.setGetTask(fn);
  fileQuality.setGetTask(fn);
}

function setDataDir(dataDir) {
  _conflictDataDir = dataDir || null;
}

// Local helpers (avoid circular require of database.js)
function _getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function _safeJsonParse(value, defaultValue = null) {
  if (value === null || value === undefined) return defaultValue;
  try { return JSON.parse(value); } catch { return defaultValue; }
}

function _getRunningCount() {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?');
  return stmt.get('running').count;
}

/**
 * Capture file baseline (size, line count, checksum)
 * @param {string} filePath - File path to capture.
 * @param {string} workingDirectory - Working directory.
 * @param {string|null} [taskId=null] - Optional task identifier.
 * @returns {object|null} Baseline details or null on failure.
 */

function recordCost(...args) { return costTracking.recordCost(...args); }
function updateBudgetSpend(...args) { return costTracking.updateBudgetSpend(...args); }
function checkBudgetBeforeSubmission(...args) { return costTracking.checkBudgetBeforeSubmission(...args); }
function getCostSummary(...args) { return costTracking.getCostSummary(...args); }
function getBudgetStatus(...args) { return costTracking.getBudgetStatus(...args); }
function isBudgetExceeded(...args) { return costTracking.isBudgetExceeded(...args); }
function setBudget(...args) { return costTracking.setBudget(...args); }

/**
 * Set or update output size limits for a provider
 * @param {any} provider
 * @param {any} maxOutputBytes
 * @param {any} maxFileSizeBytes
 * @param {any} maxFileChanges
 * @param {any} enabled
 * @returns {any}
 */

function generateTaskFingerprint(taskDescription, workingDirectory) {
  const crypto = require('crypto');
  const normalized = taskDescription.toLowerCase().trim().replace(/\s+/g, ' ');
  const content = `${normalized}|${workingDirectory || ''}`;
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Check for duplicate task
 */
function checkDuplicateTask(taskDescription, workingDirectory) {
  const fingerprint = generateTaskFingerprint(taskDescription, workingDirectory);
  const existing = db.prepare('SELECT * FROM task_fingerprints WHERE fingerprint = ?').get(fingerprint);

  if (existing) {
    const task = getTaskFn ? getTaskFn(existing.task_id) : null;
    if (task && ['pending', 'queued', 'running'].includes(task.status)) {
      return { isDuplicate: true, existingTaskId: existing.task_id, status: task.status };
    }
  }
  return { isDuplicate: false };
}

/**
 * Record task fingerprint
 * @param {any} taskId
 * @param {any} taskDescription
 * @param {any} workingDirectory
 * @returns {any}
 */
function recordTaskFingerprint(taskId, taskDescription, workingDirectory) {
  const fingerprint = generateTaskFingerprint(taskDescription, workingDirectory);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO task_fingerprints (fingerprint, task_id, task_description, working_directory, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(fingerprint, taskId, taskDescription, workingDirectory, new Date().toISOString());
}

// ============================================
// File Lock Functions
// ============================================

/**
 * Acquire file lock
 * @param {string} filePath - Path to the file to lock.
 * @param {string} workingDirectory - Task working directory.
 * @param {string} taskId - Task identifier requesting the lock.
 * @param {string} [lockType='exclusive'] - Lock type to acquire.
 * @param {number} [timeoutSeconds=300] - Lock expiration timeout in seconds.
 * @returns {object} Lock acquisition result.
 */

function runSecurityScan(taskId, filePath, content) {
  const path = require('path');
  const ext = path.extname(filePath).toLowerCase();

  const rules = db.prepare(`
    SELECT * FROM security_rules WHERE enabled = 1 AND file_extensions LIKE ? ESCAPE '\\'
  `).all(`%${ext.replace(/[\\%_]/g, '\\$&')}%`);

  const issues = [];

  const { isSafeRegex } = require('../utils/safe-regex');

  for (const rule of rules) {
    try {
      if (!isSafeRegex(rule.pattern)) continue; // skip potentially catastrophic patterns
      const regex = new RegExp(rule.pattern, 'gmi');
      let lineNum = 1;
      const lines = content.split('\n');

      for (const line of lines) {
        if (regex.test(line)) {
          issues.push({
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            category: rule.category,
            description: rule.description,
            lineNumber: lineNum,
            codeSnippet: line.trim().substring(0, 200)
          });
        }
        regex.lastIndex = 0;  // Reset regex
        lineNum++;
      }
    } catch (_e) { void _e; }
  }

  // Record findings
  for (const issue of issues) {
    db.prepare(`
      INSERT INTO security_scans (task_id, file_path, scan_type, severity, issue_type, description, line_number, code_snippet, scanned_at)
      VALUES (?, ?, 'static', ?, ?, ?, ?, ?, ?)
    `).run(taskId, filePath, issue.severity, issue.category, issue.description, issue.lineNumber, issue.codeSnippet, new Date().toISOString());
  }

  return issues;
}

/**
 * Get security scan results
 * @param {any} taskId
 * @returns {any}
 */
function getSecurityScanResults(taskId) {
  return db.prepare('SELECT * FROM security_scans WHERE task_id = ? ORDER BY severity DESC').all(taskId);
}

/**
 * Get security rules
 * @param {any} enabledOnly
 * @returns {any}
 */
function getSecurityRules(enabledOnly = true) {
  if (enabledOnly) {
    return db.prepare('SELECT * FROM security_rules WHERE enabled = 1 ORDER BY severity DESC').all();
  }
  return db.prepare('SELECT * FROM security_rules ORDER BY severity DESC').all();
}

// ============================================
// Test Coverage Functions
// ============================================

/**
 * Check test coverage for a file
 */
function checkTestCoverage(taskId, filePath, workingDirectory) {
  const path = require('path');
  const fs = require('fs');

  const fileName = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);

  // Common test file patterns
  const testPatterns = [
    `${fileName}.test${ext}`,
    `${fileName}.spec${ext}`,
    `${fileName}Tests${ext}`,
    `${fileName}_test${ext}`,
    `test_${fileName}${ext}`
  ];

  // Common test directories
  const testDirs = ['tests', 'test', '__tests__', 'spec', 'specs'];

  let testFilePath = null;

  // Check for test file
  for (const pattern of testPatterns) {
    // Check same directory
    const sameDirPath = path.join(workingDirectory, dir, pattern);
    if (fs.existsSync(sameDirPath)) {
      testFilePath = path.join(dir, pattern);
      break;
    }

    // Check test directories
    for (const testDir of testDirs) {
      const testDirPath = path.join(workingDirectory, testDir, pattern);
      if (fs.existsSync(testDirPath)) {
        testFilePath = path.join(testDir, pattern);
        break;
      }
    }
    if (testFilePath) break;
  }

  const hasTestFile = testFilePath !== null;

  db.prepare(`
    INSERT INTO test_coverage (task_id, file_path, has_test_file, test_file_path, checked_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, filePath, hasTestFile ? 1 : 0, testFilePath, new Date().toISOString());

  return { hasTestFile, testFilePath };
}

/**
 * Get test coverage results
 * @param {any} taskId
 * @returns {any}
 */
function getTestCoverageResults(taskId) {
  return db.prepare('SELECT * FROM test_coverage WHERE task_id = ?').all(taskId);
}

// ============================================
// Code Style Functions
// ============================================

/**
 * Run style check on a file
 * @param {any} taskId
 * @param {any} filePath
 * @param {any} workingDirectory
 * @param {any} autoFix
 * @returns {any}
 */
async function runStyleCheck(taskId, filePath, workingDirectory, autoFix = false) {
  const path = require('path');
  const { spawn } = require('child_process');

  const ext = path.extname(filePath).toLowerCase();
  const linters = db.prepare(`
    SELECT * FROM linter_configs WHERE enabled = 1 AND file_extensions LIKE ? ESCAPE '\\'
  `).all(`%${ext.replace(/[\\%_]/g, '\\$&')}%`);

  const results = [];

  for (const linter of linters) {
    const args = autoFix && linter.fix_args ? linter.fix_args.split(' ') : (linter.args || '').split(' ');
    const fullPath = path.join(workingDirectory, filePath);
    args.push(fullPath);

    try {
      const result = await new Promise((resolve) => {
        const proc = spawn(linter.command, args, { cwd: workingDirectory, timeout: TASK_TIMEOUTS.HTTP_REQUEST, windowsHide: true });
        let output = '';
        let errorOutput = '';

        proc.stdout.on('data', data => output += data.toString());
        proc.stderr.on('data', data => errorOutput += data.toString());

        proc.on('close', code => {
          resolve({
            linter: linter.name,
            passed: code === 0,
            output,
            errorOutput,
            autoFixed: autoFix && linter.fix_args
          });
        });

        proc.on('error', err => {
          resolve({ linter: linter.name, passed: false, error: err.message });
        });
      });

      results.push(result);

      // Record result
      db.prepare(`
        INSERT INTO style_checks (task_id, file_path, linter, issue_count, issues, auto_fixed, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(taskId, filePath, linter.name, result.passed ? 0 : 1, result.errorOutput || result.output, result.autoFixed ? 1 : 0, new Date().toISOString());

    } catch (err) {
      results.push({ linter: linter.name, passed: false, error: err.message });
    }
  }

  return results;
}

/**
 * Get style check results
 * @param {any} taskId
 * @returns {any}
 */
function getStyleCheckResults(taskId) {
  return db.prepare('SELECT * FROM style_checks WHERE task_id = ?').all(taskId);
}

// ============================================
// Change Impact Analysis Functions
// ============================================

/**
 * Analyze change impact
 * @param {string} taskId - Task identifier.
 * @param {string} changedFile - Path to the changed file.
 * @param {string} workingDirectory - Root directory to scan.
 * @returns {Array<object>} Detected impacts.
 */
function analyzeChangeImpact(taskId, changedFile, workingDirectory) {
  const fs = require('fs');
  const path = require('path');

  const impacts = [];
  const fileName = path.basename(changedFile, path.extname(changedFile));
  const escapedName = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Simple import/reference search
  const searchPatterns = [
    `import.*${escapedName}`,
    `require.*${escapedName}`,
    `from.*${escapedName}`,
    `using.*${escapedName}`
  ];

  const pattern = searchPatterns.join('|');

  // Search for files that reference this file
  function searchDir(dir, depth = 0) {
    if (depth > 5) return;  // Limit recursion

    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory() && !file.startsWith('.') && file !== 'node_modules' && file !== 'bin' && file !== 'obj') {
          searchDir(fullPath, depth + 1);
        } else if (stat.isFile() && file !== path.basename(changedFile)) {
          const fileExt = path.extname(file);
          if (['.cs', '.ts', '.js', '.py', '.java'].includes(fileExt)) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const regex = new RegExp(pattern, 'gi');
              if (regex.test(content)) {
                const relativePath = path.relative(workingDirectory, fullPath);
                impacts.push({
                  impactedFile: relativePath,
                  impactType: 'import',
                  confidence: 0.8
                });
              }
            } catch (_e) { void _e; }
          }
        }
      }
    } catch (_e) { void _e; }
  }

  searchDir(workingDirectory);

  // Record impacts
  for (const impact of impacts) {
    db.prepare(`
      INSERT INTO change_impacts (task_id, changed_file, impacted_file, impact_type, confidence, analyzed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, changedFile, impact.impactedFile, impact.impactType, impact.confidence, new Date().toISOString());
  }

  return impacts;
}

/**
 * Get change impact results
 * @param {any} taskId
 * @returns {any}
 */
function getChangeImpacts(taskId) {
  return db.prepare('SELECT * FROM change_impacts WHERE task_id = ?').all(taskId);
}

// ============================================
// Timeout Alert Functions
// ============================================

/**
 * Check for task timeout
 */
function checkTaskTimeout(taskId, expectedDurationSeconds = 300) {
  const task = getTaskFn ? getTaskFn(taskId) : null;
  if (!task || task.status !== 'running') return { timedOut: false };

  const startedAt = new Date(task.started_at);
  const now = new Date();
  const actualDuration = (now - startedAt) / 1000;

  if (actualDuration > expectedDurationSeconds) {
    db.prepare(`
      INSERT INTO timeout_alerts (task_id, expected_duration_seconds, actual_duration_seconds, alert_type, created_at)
      VALUES (?, ?, ?, 'warning', ?)
    `).run(taskId, expectedDurationSeconds, actualDuration, now.toISOString());

    return { timedOut: true, actualDuration, expected: expectedDurationSeconds };
  }

  return { timedOut: false, actualDuration, expected: expectedDurationSeconds };
}

/**
 * Get timeout alerts
 * @param {any} taskId
 * @returns {any}
 */
function getTimeoutAlerts(taskId = null) {
  if (taskId) {
    return db.prepare('SELECT * FROM timeout_alerts WHERE task_id = ?').all(taskId);
  }
  return db.prepare('SELECT * FROM timeout_alerts WHERE notified = 0 ORDER BY created_at DESC').all();
}

/**
 * Mark timeout alert as notified
 * @param {any} alertId
 * @returns {any}
 */
function markTimeoutAlertNotified(alertId) {
  db.prepare('UPDATE timeout_alerts SET notified = 1 WHERE id = ?').run(alertId);
}

// Delegated to db/file-tracking-scans.js
const {
  runVulnerabilityScan,
  getVulnerabilityScanResults,
  validateApiContract,
  getApiContractResults,
  captureTestBaseline,
  detectRegressions,
  getRegressionResults,
  captureConfigBaselines,
  detectConfigDrift,
  getConfigDriftResults,
  validateXamlSemantics,
  getXamlValidationResults,
  checkXamlCodeBehindConsistency,
  getXamlConsistencyResults,
  runAppSmokeTest,
  runAppSmokeTestSync,
  getSmokeTestResults,
} = fileTrackingScans;

// Delegated to db/code-analysis.js
function analyzeCodeComplexity(...args) { return codeAnalysis.analyzeCodeComplexity(...args); }
function getComplexityMetrics(...args) { return codeAnalysis.getComplexityMetrics(...args); }

// Delegated to db/code-analysis.js
function detectDeadCode(...args) { return codeAnalysis.detectDeadCode(...args); }
function getDeadCodeResults(...args) { return codeAnalysis.getDeadCodeResults(...args); }

// Delegated to db/code-analysis.js
function checkDocCoverage(...args) { return codeAnalysis.checkDocCoverage(...args); }
function getDocCoverageResults(...args) { return codeAnalysis.getDocCoverageResults(...args); }

// Delegated to db/code-analysis.js
function estimateResourceUsage(...args) { return codeAnalysis.estimateResourceUsage(...args); }
function getResourceEstimates(...args) { return codeAnalysis.getResourceEstimates(...args); }

// Delegated to db/code-analysis.js
function checkI18n(...args) { return codeAnalysis.checkI18n(...args); }
function getI18nResults(...args) { return codeAnalysis.getI18nResults(...args); }

// Delegated to db/code-analysis.js
function checkAccessibility(...args) { return codeAnalysis.checkAccessibility(...args); }
function getAccessibilityResults(...args) { return codeAnalysis.getAccessibilityResults(...args); }

function verifyTypeReferences(...args) { return codeAnalysis.verifyTypeReferences(...args); }
function getTypeVerificationResults(...args) { return codeAnalysis.getTypeVerificationResults(...args); }

// Delegated to db/code-analysis.js
function analyzeBuildOutput(...args) { return codeAnalysis.analyzeBuildOutput(...args); }
function getBuildErrorAnalysis(...args) { return codeAnalysis.getBuildErrorAnalysis(...args); }

// ============================================================
// File Conflict Tracking (merged from file-conflict-tracking.js)
// ============================================================

function _conflictEnsureDb() {
  if (!db) {
    throw new Error('file-conflict-tracking database has not been initialized');
  }
}

function _getSnapshotDir() {
  const root = _conflictDataDir || require('../data-dir').getDataDir();
  const snapshotDir = path.join(root, 'task-file-write-snapshots');
  fs.mkdirSync(snapshotDir, { recursive: true });
  return snapshotDir;
}

function _normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function _hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function _isAbsolutePath(filePath) {
  if (!filePath) return false;
  if (path.isAbsolute(filePath)) return true;
  return /^[A-Za-z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath);
}

function _getTaskRecord(taskId) {
  _conflictEnsureDb();
  return db.prepare(`
    SELECT id, workflow_id, working_directory
    FROM tasks
    WHERE id = ?
  `).get(taskId);
}

function _toTrackedFilePath(task, filePath) {
  const rawPath = String(filePath || '').trim();
  if (!rawPath) {
    throw new Error('filePath must be a non-empty string');
  }

  if (!task?.working_directory) {
    return _normalizePath(path.normalize(rawPath));
  }

  const absolutePath = _isAbsolutePath(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(task.working_directory, rawPath);
  const relativeToWorkdir = path.relative(task.working_directory, absolutePath);

  if (relativeToWorkdir && !relativeToWorkdir.startsWith('..') && !path.isAbsolute(relativeToWorkdir)) {
    return _normalizePath(relativeToWorkdir);
  }

  return _normalizePath(absolutePath);
}

function _resolveTrackedFilePath(task, trackedFilePath) {
  if (_isAbsolutePath(trackedFilePath) || !task?.working_directory) {
    return path.normalize(trackedFilePath);
  }
  return path.resolve(task.working_directory, trackedFilePath);
}

function _buildSnapshotPayload(absolutePath) {
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return { exists: false, content: '' };
  }
  return {
    exists: true,
    content: fs.readFileSync(absolutePath, 'utf8')
  };
}

function _getSnapshotPath(contentHash) {
  return path.join(_getSnapshotDir(), `${contentHash}.json`);
}

function _persistSnapshot(contentHash, payload) {
  const snapshotPath = _getSnapshotPath(contentHash);
  if (!fs.existsSync(snapshotPath)) {
    fs.writeFileSync(snapshotPath, JSON.stringify(payload), 'utf8');
  }
  return snapshotPath;
}

function readSnapshot(contentHash) {
  if (!contentHash) return null;
  const snapshotPath = _getSnapshotPath(contentHash);
  if (!fs.existsSync(snapshotPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    return {
      exists: parsed?.exists !== false,
      content: typeof parsed?.content === 'string' ? parsed.content : ''
    };
  } catch (err) {
    conflictLogger.warn(`Failed to parse snapshot ${contentHash}: ${err.message}`);
    return null;
  }
}

function recordTaskFileWrite(taskId, filePath, contentHash) {
  _conflictEnsureDb();

  if (!taskId || typeof taskId !== 'string') {
    throw new Error('taskId must be a non-empty string');
  }

  const task = _getTaskRecord(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const trackedFilePath = _toTrackedFilePath(task, filePath);
  const absolutePath = _resolveTrackedFilePath(task, trackedFilePath);
  const payload = _buildSnapshotPayload(absolutePath);
  const effectiveHash = _hashContent(payload.exists ? payload.content : '__deleted__');

  if (contentHash && contentHash !== effectiveHash) {
    conflictLogger.debug(`Content hash mismatch for ${taskId} ${trackedFilePath}; using live snapshot hash`);
  }

  _persistSnapshot(effectiveHash, payload);

  const writtenAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO task_file_writes (task_id, workflow_id, file_path, content_hash, written_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, task.workflow_id || null, trackedFilePath, effectiveHash, writtenAt);

  return {
    task_id: taskId,
    workflow_id: task.workflow_id || null,
    file_path: trackedFilePath,
    content_hash: effectiveHash,
    written_at: writtenAt,
    exists: payload.exists
  };
}

function getConflictedFiles(workflowId) {
  _conflictEnsureDb();

  if (!workflowId || typeof workflowId !== 'string') {
    throw new Error('workflowId must be a non-empty string');
  }

  const rows = db.prepare(`
    SELECT
      file_path,
      COUNT(DISTINCT task_id) AS task_count,
      GROUP_CONCAT(DISTINCT task_id) AS task_ids
    FROM task_file_writes
    WHERE workflow_id = ?
    GROUP BY file_path
    HAVING COUNT(DISTINCT task_id) > 1
    ORDER BY file_path ASC
  `).all(workflowId);

  return rows.map((row) => ({
    file_path: row.file_path,
    task_count: row.task_count,
    task_ids: String(row.task_ids || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }));
}

function getWorkflowFileWrites(workflowId, filePath) {
  _conflictEnsureDb();

  return db.prepare(`
    SELECT
      latest.row_id,
      tfw.task_id,
      tfw.workflow_id,
      tfw.file_path,
      tfw.content_hash,
      tfw.written_at
    FROM task_file_writes tfw
    INNER JOIN (
      SELECT MAX(rowid) AS row_id
      FROM task_file_writes
      WHERE workflow_id = ?
        AND file_path = ?
      GROUP BY task_id, file_path
    ) latest ON latest.row_id = tfw.rowid
    ORDER BY tfw.written_at ASC, latest.row_id ASC
  `).all(workflowId, filePath);
}

/**
 * Factory function for DI container.
 * @param {{ db: object, taskCore?: object, dataDir?: string }} deps
 */
function createFileTracking({ db: dbInstance, taskCore, dataDir }) {
  setDb(dbInstance);
  setGetTask(taskCore?.getTask || (() => null));
  setDataDir(dataDir || require('../data-dir').getDataDir());
  return {
    ...fileBaselines,
    ...fileQuality,
    ...fileTrackingScans,
    acquireFileLock,
    analyzeBuildOutput,
    analyzeChangeImpact,
    analyzeCodeComplexity,
    calculateTaskComplexityScore,
    captureConfigBaselines,
    captureDirectoryBaselines,
    captureFileBaseline,
    captureTestBaseline,
    checkAccessibility,
    checkDocCoverage,
    checkDuplicateFiles,
    checkDuplicateTask,
    checkFileLocationAnomalies,
    checkI18n,
    checkOutputSizeLimits,
    checkRateLimit,
    checkTaskTimeout,
    checkTestCoverage,
    checkXamlCodeBehindConsistency,
    classifyTaskType,
    compareFileToBaseline,
    completeRollback,
    createDiffPreview,
    createFileBackup,
    createRollback,
    detectConfigDrift,
    detectDeadCode,
    detectProviderDegradation,
    detectRegressions,
    estimateResourceUsage,
    generateTaskFingerprint,
    getAccessibilityResults,
    getActiveFileLocks,
    getAllFileLocationIssues,
    getApiContractResults,
    getAuditSummary,
    getAuditTrail,
    getAutoRollbackHistory,
    getBestProviderForTaskType,
    getBudgetStatus,
    getBuildCheck,
    getBuildErrorAnalysis,
    getChangeImpacts,
    getComplexityMetrics,
    getConfigDriftResults,
    getCostSummary,
    getDeadCodeResults,
    getDiffPreview,
    getDocCoverageResults,
    getDuplicateFileDetections,
    getExpectedOutputPaths,
    getFileBaseline,
    getFileLocationAnomalies,
    getI18nResults,
    getOutputViolations,
    getOverallQualityStats,
    getProviderQualityStats,
    getProviderStats,
    getQualityScore,
    getQualityStatsByProvider,
    getRateLimits,
    getRegressionResults,
    getResourceEstimates,
    getRollback,
    getSafeguardToolConfigs,
    getSecurityRules,
    getSecurityScanResults,
    getSimilarFileSearchResults,
    getSmokeTestResults,
    getStyleCheckResults,
    getSyntaxValidators,
    getTaskBackups,
    getTaskComplexityScore,
    getTaskFileChanges,
    getTestCoverageResults,
    getTimeoutAlerts,
    getTypeVerificationResults,
    getValidationFailureRate,
    getVulnerabilityScanResults,
    getXamlConsistencyResults,
    getXamlValidationResults,
    isBudgetExceeded,
    isDiffReviewRequired,
    listAllSyntaxValidators,
    listRollbacks,
    markDiffReviewed,
    markTimeoutAlertNotified,
    checkBudgetBeforeSubmission,
    performAutoRollback,
    recordAuditEvent,
    recordAutoRollback,
    recordCost,
    recordDuplicateFile,
    recordFileChange,
    recordFileLocationAnomaly,
    recordQualityScore,
    recordRateLimitEvent,
    recordTaskFingerprint,
    releaseAllFileLocks,
    releaseFileLock,
    resolveDuplicateFile,
    resolveFileLocationAnomaly,
    restoreFileBackup,
    runAppSmokeTest,
    runAppSmokeTestSync,
    runBuildCheck,
    runSecurityScan,
    runStyleCheck,
    runSyntaxValidation,
    runVulnerabilityScan,
    saveBuildResult,
    searchSimilarFiles,
    setBudget,
    setExpectedOutputPath,
    setOutputLimit,
    setRateLimit,
    updateBudgetSpend,
    updateProviderStats,
    validateApiContract,
    validateXamlSemantics,
    verifyTypeReferences,
    recordTaskFileWrite,
    getConflictedFiles,
    getWorkflowFileWrites,
    getTaskFileSnapshot: readSnapshot,
  };
}

module.exports = {
  ...fileBaselines,
  ...fileQuality,
  ...fileTrackingScans,
  setDb,
  setGetTask,
  setDataDir,
  createFileTracking,
  acquireFileLock,
  analyzeBuildOutput,
  analyzeChangeImpact,
  analyzeCodeComplexity,
  calculateTaskComplexityScore,
  captureConfigBaselines,
  captureDirectoryBaselines,
  captureFileBaseline,
  captureTestBaseline,
  checkAccessibility,
  checkDocCoverage,
  checkDuplicateFiles,
  checkDuplicateTask,
  checkFileLocationAnomalies,
  checkI18n,
  checkOutputSizeLimits,
  checkRateLimit,
  checkTaskTimeout,
  checkTestCoverage,
  checkXamlCodeBehindConsistency,
  classifyTaskType,
  compareFileToBaseline,
  completeRollback,
  createDiffPreview,
  createFileBackup,
  createRollback,
  detectConfigDrift,
  detectDeadCode,
  detectProviderDegradation,
  detectRegressions,
  estimateResourceUsage,
  generateTaskFingerprint,
  getAccessibilityResults,
  getActiveFileLocks,
  getAllFileLocationIssues,
  getApiContractResults,
  getAuditSummary,
  getAuditTrail,
  getAutoRollbackHistory,
  getBestProviderForTaskType,
  getBudgetStatus,
  getBuildCheck,
  getBuildErrorAnalysis,
  getChangeImpacts,
  getComplexityMetrics,
  getConfigDriftResults,
  getCostSummary,
  getDeadCodeResults,
  getDiffPreview,
  getDocCoverageResults,
  getDuplicateFileDetections,
  getExpectedOutputPaths,
  getFileBaseline,
  getFileLocationAnomalies,
  getI18nResults,
  getOutputViolations,
  getOverallQualityStats,
  getProviderQualityStats,
  getProviderStats,
  getQualityScore,
  getQualityStatsByProvider,
  getRateLimits,
  getRegressionResults,
  getResourceEstimates,
  getRollback,
  getSafeguardToolConfigs,
  getSecurityRules,
  getSecurityScanResults,
  getSimilarFileSearchResults,
  getSmokeTestResults,
  getStyleCheckResults,
  getSyntaxValidators,
  getTaskBackups,
  getTaskComplexityScore,
  getTaskFileChanges,
  getTestCoverageResults,
  getTimeoutAlerts,
  getTypeVerificationResults,
  getValidationFailureRate,
  getVulnerabilityScanResults,
  getXamlConsistencyResults,
  getXamlValidationResults,
  isBudgetExceeded,
  isDiffReviewRequired,
  listAllSyntaxValidators,
  listRollbacks,
  markDiffReviewed,
  markTimeoutAlertNotified,
  checkBudgetBeforeSubmission,
  performAutoRollback,
  recordAuditEvent,
  recordAutoRollback,
  recordCost,
  recordDuplicateFile,
  recordFileChange,
  recordFileLocationAnomaly,
  recordQualityScore,
  recordRateLimitEvent,
  recordTaskFingerprint,
  releaseAllFileLocks,
  releaseFileLock,
  resolveDuplicateFile,
  resolveFileLocationAnomaly,
  restoreFileBackup,
  runAppSmokeTest,
  runAppSmokeTestSync,
  runBuildCheck,
  runSecurityScan,
  runStyleCheck,
  runSyntaxValidation,
  runVulnerabilityScan,
  saveBuildResult,
  searchSimilarFiles,
  setBudget,
  setExpectedOutputPath,
  setOutputLimit,
  setRateLimit,
  updateBudgetSpend,
  updateProviderStats,
  validateApiContract,
  validateXamlSemantics,
  verifyTypeReferences,
  // File Conflict Tracking (from file-conflict-tracking.js)
  recordTaskFileWrite,
  getConflictedFiles,
  getWorkflowFileWrites,
  getTaskFileSnapshot: readSnapshot,
};
