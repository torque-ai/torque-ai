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
    SELECT * FROM security_rules WHERE enabled = 1 AND file_extensions LIKE ?
  `).all(`%${ext}%`);

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
    SELECT * FROM linter_configs WHERE enabled = 1 AND file_extensions LIKE ?
  `).all(`%${ext}%`);

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

  // Simple import/reference search
  const searchPatterns = [
    `import.*${fileName}`,
    `require.*${fileName}`,
    `from.*${fileName}`,
    `using.*${fileName}`
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

// ============================================
// Output Size Limit Functions
// ============================================

/**
 * Check output size limits
 */

async function runVulnerabilityScan(taskId, workingDirectory) {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');
  const now = new Date().toISOString();

  const results = [];

  // Detect package manager and run appropriate scan
  const packageManagers = [
    { file: 'package.json', manager: 'npm', cmd: 'npm', args: ['audit', '--json'] },
    { file: 'package-lock.json', manager: 'npm', cmd: 'npm', args: ['audit', '--json'] },
    { file: 'yarn.lock', manager: 'yarn', cmd: 'yarn', args: ['audit', '--json'] },
    { file: 'requirements.txt', manager: 'pip', cmd: 'pip-audit', args: ['--format', 'json'] },
    { file: 'Pipfile.lock', manager: 'pipenv', cmd: 'pipenv', args: ['check', '--output', 'json'] },
    { file: '*.csproj', manager: 'dotnet', cmd: 'dotnet', args: ['list', 'package', '--vulnerable', '--format', 'json'] }
  ];

  for (const pm of packageManagers) {
    const checkPath = pm.file.includes('*')
      ? fs.readdirSync(workingDirectory).some(f => f.endsWith(pm.file.replace('*', '')))
      : fs.existsSync(path.join(workingDirectory, pm.file));

    if (checkPath) {
      try {
        const result = await new Promise((resolve) => {
          const proc = spawn(pm.cmd, pm.args, { cwd: workingDirectory, timeout: TASK_TIMEOUTS.VERIFY_COMMAND, windowsHide: true });
          let output = '';
          let errorOutput = '';

          proc.stdout.on('data', data => output += data.toString());
          proc.stderr.on('data', data => errorOutput += data.toString());

          proc.on('close', code => {
            resolve({ output, errorOutput, code });
          });

          proc.on('error', err => {
            resolve({ error: err.message, code: -1 });
          });
        });

        // Parse vulnerability counts from output
        let vulnCounts = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
        try {
          const parsed = JSON.parse(result.output);
          if (pm.manager === 'npm' && parsed.metadata?.vulnerabilities) {
            vulnCounts = {
              total: parsed.metadata.vulnerabilities.total || 0,
              critical: parsed.metadata.vulnerabilities.critical || 0,
              high: parsed.metadata.vulnerabilities.high || 0,
              medium: parsed.metadata.vulnerabilities.moderate || 0,
              low: parsed.metadata.vulnerabilities.low || 0
            };
          }
        } catch (_e) {
          void _e;
          // Output wasn't valid JSON, use exit code as indicator
          vulnCounts.total = result.code > 0 ? 1 : 0;
        }

        // Store result
        db.prepare(`
          INSERT INTO vulnerability_scans (task_id, working_directory, package_manager, scan_output, vulnerabilities_found, critical_count, high_count, medium_count, low_count, scanned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(taskId, workingDirectory, pm.manager, result.output, vulnCounts.total, vulnCounts.critical, vulnCounts.high, vulnCounts.medium, vulnCounts.low, now);

        results.push({
          package_manager: pm.manager,
          vulnerabilities: vulnCounts,
          scanned: true
        });
      } catch (err) {
        results.push({ package_manager: pm.manager, error: err.message, scanned: false });
      }
    }
  }

  return results;
}

/**
 * Get vulnerability scan results
 * @param {any} taskId
 * @returns {any}
 */
function getVulnerabilityScanResults(taskId) {
  return db.prepare('SELECT * FROM vulnerability_scans WHERE task_id = ?').all(taskId);
}

// Delegated to db/code-analysis.js
function analyzeCodeComplexity(...args) { return codeAnalysis.analyzeCodeComplexity(...args); }
function getComplexityMetrics(...args) { return codeAnalysis.getComplexityMetrics(...args); }

// Delegated to db/code-analysis.js
function detectDeadCode(...args) { return codeAnalysis.detectDeadCode(...args); }
function getDeadCodeResults(...args) { return codeAnalysis.getDeadCodeResults(...args); }

/**
 * Validate API contract (OpenAPI/Swagger)
 */
async function validateApiContract(taskId, contractFile, workingDirectory) {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');
  const now = new Date().toISOString();

  const fullPath = path.join(workingDirectory, contractFile);
  if (!fs.existsSync(fullPath)) {
    return { valid: false, error: 'Contract file not found' };
  }

  // Try swagger-cli first
  const result = await new Promise((resolve) => {
    const proc = spawn('npx', ['swagger-cli', 'validate', fullPath], { cwd: workingDirectory, timeout: TASK_TIMEOUTS.TEST_RUN, windowsHide: true });
    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', data => output += data.toString());
    proc.stderr.on('data', data => errorOutput += data.toString());

    proc.on('close', code => {
      resolve({ output, errorOutput, code });
    });

    proc.on('error', err => {
      resolve({ error: err.message, code: -1 });
    });
  });

  const isValid = result.code === 0;

  // Store result
  db.prepare(`
    INSERT INTO api_contract_results (task_id, contract_file, validation_type, is_valid, breaking_changes, warnings, validated_at)
    VALUES (?, ?, 'swagger-cli', ?, ?, ?, ?)
  `).run(taskId, contractFile, isValid ? 1 : 0, null, result.errorOutput || null, now);

  return {
    valid: isValid,
    contract_file: contractFile,
    output: result.output,
    errors: result.errorOutput
  };
}

/**
 * Get API contract validation results
 */
function getApiContractResults(taskId) {
  return db.prepare('SELECT * FROM api_contract_results WHERE task_id = ?').all(taskId);
}

// Delegated to db/code-analysis.js
function checkDocCoverage(...args) { return codeAnalysis.checkDocCoverage(...args); }
function getDocCoverageResults(...args) { return codeAnalysis.getDocCoverageResults(...args); }

/**
 * Capture test results before task (for regression detection)
 * @param {string} taskId - Task identifier.
 * @param {string} workingDirectory - Working directory.
 * @returns {Promise<object>} Baseline capture result.
 */
async function captureTestBaseline(taskId, workingDirectory) {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  // Detect test framework and run tests
  let testCmd = null;
  let testArgs = [];

  if (fs.existsSync(path.join(workingDirectory, 'package.json'))) {
    testCmd = 'npm';
    testArgs = ['test', '--', '--json'];
  } else if (fs.existsSync(path.join(workingDirectory, 'pytest.ini')) || fs.existsSync(path.join(workingDirectory, 'setup.py'))) {
    testCmd = 'pytest';
    testArgs = ['--tb=no', '-q'];
  } else if (fs.readdirSync(workingDirectory).some(f => f.endsWith('.csproj'))) {
    testCmd = 'dotnet';
    testArgs = ['test', '--no-build', '-v', 'q'];
  }

  if (!testCmd) {
    return { captured: false, reason: 'No test framework detected' };
  }

  const result = await new Promise((resolve) => {
    const proc = spawn(testCmd, testArgs, { cwd: workingDirectory, timeout: TASK_TIMEOUTS.BUILD_TIMEOUT, windowsHide: true });
    let output = '';

    proc.stdout.on('data', data => output += data.toString());
    proc.stderr.on('data', data => output += data.toString());

    proc.on('close', code => {
      resolve({ output, code });
    });

    proc.on('error', err => {
      resolve({ error: err.message, code: -1 });
    });
  });

  // Parse test counts (simplified)
  const passedMatch = result.output.match(/(\d+)\s*pass/i);
  const failedMatch = result.output.match(/(\d+)\s*fail/i);
  const totalMatch = result.output.match(/(\d+)\s*test/i);

  return {
    captured: true,
    test_command: `${testCmd} ${testArgs.join(' ')}`,
    tests: totalMatch ? parseInt(totalMatch[1]) : 0,
    passed: passedMatch ? parseInt(passedMatch[1]) : 0,
    failed: failedMatch ? parseInt(failedMatch[1]) : 0,
    output: result.output
  };
}

/**
 * Detect regressions by comparing test results
 */
async function detectRegressions(taskId, workingDirectory, baselineResults) {
  const now = new Date().toISOString();

  // Run tests again
  const currentResults = await captureTestBaseline(taskId, workingDirectory);

  if (!currentResults.captured || !baselineResults.captured) {
    return { detected: false, reason: 'Could not run tests' };
  }

  const newFailures = currentResults.failed - baselineResults.failed;
  const hasRegression = newFailures > 0 || currentResults.passed < baselineResults.passed;

  // Store result
  db.prepare(`
    INSERT INTO regression_results (task_id, working_directory, test_command, tests_before, tests_after, passed_before, passed_after, failed_before, failed_after, new_failures, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId, workingDirectory, currentResults.test_command,
    baselineResults.tests, currentResults.tests,
    baselineResults.passed, currentResults.passed,
    baselineResults.failed, currentResults.failed,
    hasRegression ? currentResults.output : null, now
  );

  return {
    detected: hasRegression,
    baseline: baselineResults,
    current: currentResults,
    new_failures: newFailures
  };
}

/**
 * Get regression detection results
 * @param {any} taskId
 * @returns {any}
 */
function getRegressionResults(taskId) {
  return db.prepare('SELECT * FROM regression_results WHERE task_id = ?').all(taskId);
}

/**
 * Capture configuration file baselines
 * @param {string} workingDirectory - Root directory to scan.
 * @returns {object} Capture summary.
 */
function captureConfigBaselines(workingDirectory) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const now = new Date().toISOString();

  const configPatterns = [
    '*.config.js', '*.config.ts', '*.config.json',
    '.env*', 'appsettings*.json', 'web.config',
    'tsconfig.json', 'package.json', 'webpack.config.*',
    '.eslintrc*', '.prettierrc*', 'jest.config.*'
  ];

  const captured = [];

  for (const pattern of configPatterns) {
    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    const files = fs.readdirSync(workingDirectory).filter(f => regex.test(f));

    for (const file of files) {
      const fullPath = path.join(workingDirectory, file);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const hash = crypto.createHash('sha256').update(content).digest('hex');

        db.prepare(`
          INSERT OR REPLACE INTO config_baselines (working_directory, file_path, file_hash, content, captured_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(workingDirectory, file, hash, content, now);

        captured.push({ file, hash });
      } catch (_e) {
        void _e;
        // Skip unreadable files
      }
    }
  }

  return { captured, count: captured.length };
}

/**
 * Detect configuration drift
 */
function detectConfigDrift(taskId, workingDirectory) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const now = new Date().toISOString();

  const baselines = db.prepare('SELECT * FROM config_baselines WHERE working_directory = ?').all(workingDirectory);
  const drifts = [];

  for (const baseline of baselines) {
    const fullPath = path.join(workingDirectory, baseline.file_path);
    try {
      const currentContent = fs.readFileSync(fullPath, 'utf8');
      const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');

      if (currentHash !== baseline.file_hash) {
        const driftType = currentContent.length > baseline.content.length ? 'expanded' : 'reduced';

        db.prepare(`
          INSERT INTO config_drift_results (task_id, file_path, drift_type, old_hash, new_hash, changes_summary, detected_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(taskId, baseline.file_path, driftType, baseline.file_hash, currentHash, `Size changed from ${baseline.content.length} to ${currentContent.length}`, now);

        drifts.push({
          file: baseline.file_path,
          drift_type: driftType,
          old_hash: baseline.file_hash.substring(0, 8),
          new_hash: currentHash.substring(0, 8)
        });
      }
    } catch (e) {
      // File may have been deleted
      if (e.code === 'ENOENT') {
        db.prepare(`
          INSERT INTO config_drift_results (task_id, file_path, drift_type, old_hash, new_hash, changes_summary, detected_at)
          VALUES (?, ?, 'deleted', ?, NULL, 'File was deleted', ?)
        `).run(taskId, baseline.file_path, baseline.file_hash, now);

        drifts.push({ file: baseline.file_path, drift_type: 'deleted' });
      }
    }
  }

  return { drifts, count: drifts.length };
}

/**
 * Get config drift results
 * @param {any} taskId
 * @returns {any}
 */
function getConfigDriftResults(taskId) {
  return db.prepare('SELECT * FROM config_drift_results WHERE task_id = ?').all(taskId);
}

// Delegated to db/code-analysis.js
function estimateResourceUsage(...args) { return codeAnalysis.estimateResourceUsage(...args); }
function getResourceEstimates(...args) { return codeAnalysis.getResourceEstimates(...args); }

// Delegated to db/code-analysis.js
function checkI18n(...args) { return codeAnalysis.checkI18n(...args); }
function getI18nResults(...args) { return codeAnalysis.getI18nResults(...args); }

// Delegated to db/code-analysis.js
function checkAccessibility(...args) { return codeAnalysis.checkAccessibility(...args); }
function getAccessibilityResults(...args) { return codeAnalysis.getAccessibilityResults(...args); }

/**
 * Get safeguard tool configurations
 * @param {any} safeguardType
 * @returns {any}
 */

function verifyTypeReferences(...args) { return codeAnalysis.verifyTypeReferences(...args); }
function getTypeVerificationResults(...args) { return codeAnalysis.getTypeVerificationResults(...args); }

// Delegated to db/code-analysis.js
function analyzeBuildOutput(...args) { return codeAnalysis.analyzeBuildOutput(...args); }
function getBuildErrorAnalysis(...args) { return codeAnalysis.getBuildErrorAnalysis(...args); }

/**
 * Search for similar files before creating new ones
 * @param {any} taskId
 * @param {any} searchTerm
 * @param {any} workingDirectory
 * @param {any} searchType
 * @returns {any}
 */

function validateXamlSemantics(taskId, filePath, content) {
  const now = new Date().toISOString();
  const issues = [];

  // Split content into lines for line number tracking
  const _lines = content.split('\n');

  // Pattern 1: TemplateBinding outside ControlTemplate
  // TemplateBinding is only valid inside ControlTemplate/DataTemplate
  const templateBindingPattern = /\{TemplateBinding\s+(\w+)\}/g;
  const controlTemplatePattern = /<ControlTemplate[\s>]/;
  const isControlTemplate = controlTemplatePattern.test(content);

  if (!isControlTemplate) {
    let match;
    while ((match = templateBindingPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      issues.push({
        type: 'invalid_templatebinding',
        severity: 'error',
        line: lineNum,
        snippet: match[0],
        message: `TemplateBinding "${match[1]}" used outside ControlTemplate context - will crash at runtime`,
        fix: `Replace with {Binding ${match[1]}, RelativeSource={RelativeSource TemplatedParent}} or use a DynamicResource`
      });
    }
  }

  // Pattern 2: StaticResource references that might be missing
  const staticResourcePattern = /\{StaticResource\s+(\w+)\}/g;
  let match;
  while ((match = staticResourcePattern.exec(content)) !== null) {
    const resourceName = match[1];
    // Check if resource is defined in this file
    const resourceDefPattern = new RegExp(`x:Key="${resourceName}"`, 'i');
    if (!resourceDefPattern.test(content)) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      issues.push({
        type: 'potentially_missing_resource',
        severity: 'warning',
        line: lineNum,
        snippet: match[0],
        message: `StaticResource "${resourceName}" not defined in this file - ensure it exists in App.xaml or merged dictionaries`,
        fix: `Verify resource exists or use DynamicResource for late-bound resources`
      });
    }
  }

  // Pattern 3: Event handlers that might not exist in code-behind
  const eventPattern = /(\w+)="(\w+_\w+)"/g;
  const commonEvents = ['Click', 'Loaded', 'Unloaded', 'MouseEnter', 'MouseLeave', 'KeyDown', 'KeyUp', 'TextChanged', 'SelectionChanged'];
  while ((match = eventPattern.exec(content)) !== null) {
    const eventName = match[1];
    const handlerName = match[2];
    if (commonEvents.includes(eventName) && !handlerName.startsWith('On')) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      issues.push({
        type: 'event_handler_naming',
        severity: 'info',
        line: lineNum,
        snippet: match[0],
        message: `Event handler "${handlerName}" should be verified to exist in code-behind`,
        fix: null
      });
    }
  }

  // Pattern 4: Grid.Row/Column out of bounds (basic check)
  const gridRowPattern = /Grid\.Row="(\d+)"/g;
  const gridColPattern = /Grid\.Column="(\d+)"/g;
  const rowDefPattern = /<RowDefinition/g;
  const colDefPattern = /<ColumnDefinition/g;

  const rowDefs = (content.match(rowDefPattern) || []).length;
  const colDefs = (content.match(colDefPattern) || []).length;

  while ((match = gridRowPattern.exec(content)) !== null) {
    const rowNum = parseInt(match[1], 10);
    if (rowDefs > 0 && rowNum >= rowDefs) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      issues.push({
        type: 'grid_row_out_of_bounds',
        severity: 'warning',
        line: lineNum,
        snippet: match[0],
        message: `Grid.Row="${rowNum}" may be out of bounds (only ${rowDefs} RowDefinitions found)`,
        fix: `Verify Grid has at least ${rowNum + 1} RowDefinitions`
      });
    }
  }

  while ((match = gridColPattern.exec(content)) !== null) {
    const colNum = parseInt(match[1], 10);
    if (colDefs > 0 && colNum >= colDefs) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      issues.push({
        type: 'grid_column_out_of_bounds',
        severity: 'warning',
        line: lineNum,
        snippet: match[0],
        message: `Grid.Column="${colNum}" may be out of bounds (only ${colDefs} ColumnDefinitions found)`,
        fix: `Verify Grid has at least ${colNum + 1} ColumnDefinitions`
      });
    }
  }

  // Record issues to database
  for (const issue of issues) {
    db.prepare(`
      INSERT INTO xaml_validation_results (task_id, file_path, issue_type, severity, line_number, code_snippet, message, suggested_fix, validated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, filePath, issue.type, issue.severity, issue.line, issue.snippet, issue.message, issue.fix, now);
  }

  const errors = issues.filter(i => i.severity === 'error');
  return {
    task_id: taskId,
    file_path: filePath,
    issues_found: issues.length,
    errors: errors.length,
    warnings: issues.filter(i => i.severity === 'warning').length,
    issues,
    status: errors.length > 0 ? 'xaml_errors' : (issues.length > 0 ? 'xaml_warnings' : 'valid')
  };
}

/**
 * Get XAML validation results
 * @param {any} taskId
 * @returns {any}
 */
function getXamlValidationResults(taskId) {
  return db.prepare('SELECT * FROM xaml_validation_results WHERE task_id = ?').all(taskId);
}

/**
 * Check XAML/code-behind consistency (x:Name elements vs field references)
 */
function checkXamlCodeBehindConsistency(taskId, xamlPath, xamlContent, codeBehindContent) {
  const now = new Date().toISOString();
  const issues = [];
  const codeBehindPath = xamlPath + '.cs';

  // Extract x:Name declarations from XAML
  const xNamePattern = /x:Name="(\w+)"/g;
  const xamlNames = new Set();
  let match;
  while ((match = xNamePattern.exec(xamlContent)) !== null) {
    xamlNames.add(match[1]);
  }

  // Extract field references in code-behind (looking for this.ElementName or just ElementName)
  const fieldRefPattern = /(?:this\.)?(\w+)\.(?:Visibility|Content|Text|IsEnabled|Background|Foreground|Width|Height|Margin|Style|ItemsSource|SelectedItem|DataContext)/g;
  const codeBehindRefs = new Set();
  while ((match = fieldRefPattern.exec(codeBehindContent)) !== null) {
    // Skip common non-element names
    const name = match[1];
    if (!['this', 'base', 'sender', 'e', 'args', 'App', 'Application', 'Window', 'Page'].includes(name)) {
      codeBehindRefs.add(name);
    }
  }

  // Check for references in code-behind that don't exist in XAML
  for (const ref of codeBehindRefs) {
    if (!xamlNames.has(ref)) {
      issues.push({
        type: 'missing_xaml_element',
        element: ref,
        severity: 'error',
        message: `Code-behind references "${ref}" but no x:Name="${ref}" found in XAML`
      });
    }
  }

  // Check for x:Name in XAML that might be unused (info only)
  for (const name of xamlNames) {
    if (!codeBehindRefs.has(name)) {
      // This is just informational - element might be used via FindName or binding
      issues.push({
        type: 'potentially_unused_element',
        element: name,
        severity: 'info',
        message: `XAML element "${name}" may not be referenced in code-behind (could be intentional)`
      });
    }
  }

  // Record issues
  for (const issue of issues) {
    db.prepare(`
      INSERT INTO xaml_consistency_results (task_id, xaml_file, codebehind_file, issue_type, element_name, severity, message, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, xamlPath, codeBehindPath, issue.type, issue.element, issue.severity, issue.message, now);
  }

  const errors = issues.filter(i => i.severity === 'error');
  return {
    task_id: taskId,
    xaml_file: xamlPath,
    codebehind_file: codeBehindPath,
    xaml_elements: xamlNames.size,
    codebehind_refs: codeBehindRefs.size,
    issues_found: issues.length,
    errors: errors.length,
    issues,
    status: errors.length > 0 ? 'consistency_errors' : 'consistent'
  };
}

/**
 * Get XAML consistency results
 * @param {any} taskId
 * @returns {any}
 */
function getXamlConsistencyResults(taskId) {
  return db.prepare('SELECT * FROM xaml_consistency_results WHERE task_id = ?').all(taskId);
}

/**
 * Run app startup smoke test (async version - for future use)
 * @param {any} taskId
 * @param {any} workingDirectory
 * @param {any} options
 * @returns {any}
 */
async function runAppSmokeTest(taskId, workingDirectory, options = {}) {
  const { command = 'dotnet run', timeoutMs = 15000, projectFile = null } = options;
  const { spawn } = require('child_process');
  const now = new Date().toISOString();

  let fullCommand = command;
  if (projectFile) {
    fullCommand = `dotnet run --project "${projectFile}"`;
  }

  let exitCode = null;
  let errorOutput = null;
  let passed = false;
  let startupTimeMs = null;

  try {
    const startTime = Date.now();

    // Use spawn for better control
    const proc = spawn('dotnet', ['run'], {
      cwd: workingDirectory,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Wait for process to either exit or timeout
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Process is still running after timeout = success (app started)
        try { proc.kill('SIGTERM'); } catch { /* process may already be gone */ }
        resolve({ timedOut: true, code: 0 });
      }, timeoutMs);

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        resolve({ timedOut: false, code });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ timedOut: false, code: -1, error: err.message });
      });
    });

    startupTimeMs = Date.now() - startTime;

    if (result.timedOut) {
      // App ran for full timeout without crashing = success
      passed = true;
      exitCode = 0;
    } else {
      exitCode = result.code;
      passed = (result.code === 0);
      if (stderr) {
        errorOutput = stderr;
      }
    }
  } catch (err) {
    exitCode = -1;
    errorOutput = err.message;
    passed = false;
  }

  // Record result
  db.prepare(`
    INSERT INTO smoke_test_results (task_id, test_type, working_directory, command, exit_code, startup_time_ms, passed, error_output, tested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, 'app_startup', workingDirectory, fullCommand, exitCode, startupTimeMs, passed ? 1 : 0, errorOutput, now);

  return {
    task_id: taskId,
    test_type: 'app_startup',
    working_directory: workingDirectory,
    command: fullCommand,
    exit_code: exitCode,
    startup_time_ms: startupTimeMs,
    passed,
    error_output: errorOutput,
    status: passed ? 'passed' : 'failed'
  };
}

/**
 * Run app smoke test synchronously (simpler version)
 * SECURITY: Uses spawnSync with array arguments to prevent command injection
 * @param {any} taskId
 * @param {any} workingDirectory
 * @param {any} options
 * @returns {any}
 */
function runAppSmokeTestSync(taskId, workingDirectory, options = {}) {
  const { timeoutSeconds = 10, projectFile = null } = options;
  const { spawnSync } = require('child_process');
  const now = new Date().toISOString();

  // SECURITY: Validate projectFile path if provided
  if (projectFile) {
    // Block path traversal attempts
    if (projectFile.includes('..') || projectFile.includes('\0')) {
      return {
        task_id: taskId,
        test_type: 'app_startup',
        working_directory: workingDirectory,
        command: 'REJECTED',
        exit_code: -1,
        startup_time_ms: 0,
        passed: false,
        error_output: 'Invalid project file path',
        status: 'failed'
      };
    }
    // Must end with valid project extension
    if (!projectFile.endsWith('.csproj') && !projectFile.endsWith('.fsproj') && !projectFile.endsWith('.vbproj')) {
      return {
        task_id: taskId,
        test_type: 'app_startup',
        working_directory: workingDirectory,
        command: 'REJECTED',
        exit_code: -1,
        startup_time_ms: 0,
        passed: false,
        error_output: 'Invalid project file extension',
        status: 'failed'
      };
    }
  }

  // Build command args based on project file
  let command;
  let args;
  if (projectFile) {
    command = 'dotnet';
    args = ['run', '--project', projectFile];
  } else {
    command = 'dotnet';
    args = ['run'];
  }

  let exitCode = null;
  let errorOutput = null;
  let passed = false;
  const startTime = Date.now();
  const fullCommand = `${command} ${args.join(' ')}`; // For logging only

  try {
    // SECURITY: Use spawnSync with array args to prevent command injection
    const result = spawnSync(command, args, {
      cwd: workingDirectory,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: (timeoutSeconds + 5) * 1000
    });

    if (result.error) {
      throw result.error;
    }

    exitCode = result.status;
    errorOutput = result.stderr ? result.stderr.toString() : null;
    passed = (exitCode === 0);

    // Exit code 124 from timeout means app ran successfully for the duration
    if (exitCode === 124) {
      passed = true;
      exitCode = 0;
    }
  } catch (err) {
    exitCode = err.status || -1;
    errorOutput = err.stderr ? err.stderr.toString() : err.message;
    passed = false;
  }

  const startupTimeMs = Date.now() - startTime;

  // Record result
  db.prepare(`
    INSERT INTO smoke_test_results (task_id, test_type, working_directory, command, exit_code, startup_time_ms, passed, error_output, tested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, 'app_startup', workingDirectory, fullCommand, exitCode, startupTimeMs, passed ? 1 : 0, errorOutput, now);

  return {
    task_id: taskId,
    test_type: 'app_startup',
    working_directory: workingDirectory,
    exit_code: exitCode,
    startup_time_ms: startupTimeMs,
    passed,
    error_output: errorOutput,
    status: passed ? 'passed' : 'failed'
  };
}

/**
 * Get smoke test results
 * @param {any} taskId
 * @returns {any}
 */
function getSmokeTestResults(taskId) {
  return db.prepare('SELECT * FROM smoke_test_results WHERE task_id = ?').all(taskId);
}

// ============================================================
// File Conflict Tracking (merged from file-conflict-tracking.js)
// ============================================================

function _conflictEnsureDb() {
  if (!db) {
    throw new Error('file-conflict-tracking database has not been initialized');
  }
}

function _getSnapshotDir() {
  const root = _conflictDataDir || process.env.TORQUE_DATA_DIR || process.cwd();
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

module.exports = {
  ...fileBaselines,
  ...fileQuality,
  setDb,
  setGetTask,
  setDataDir,
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
