'use strict';

/**
 * File Tracking Scans Module
 *
 * Extracted from file-tracking.js — vulnerability scanning, API contract validation,
 * regression detection, config drift, XAML validation, XAML code-behind consistency,
 * and smoke tests.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TASK_TIMEOUTS } = require('../../constants');

let db;

// Lazy module-level cache of prepared statements keyed by a stable name.
const _stmtCache = new Map();
function _getStmt(key, sql) {
  const cached = _stmtCache.get(key);
  if (cached) return cached;
  const stmt = db.prepare(sql);
  _stmtCache.set(key, stmt);
  return stmt;
}

function setDb(dbInstance) {
  db = dbInstance;
  _stmtCache.clear();
}

/**
 * Check output size limits
 */

async function runVulnerabilityScan(taskId, workingDirectory) {
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
        _getStmt('insertVulnScan', `
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

/**
 * Validate API contract (OpenAPI/Swagger)
 */
async function validateApiContract(taskId, contractFile, workingDirectory) {
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

/**
 * Capture test results before task (for regression detection)
 * @param {string} taskId - Task identifier.
 * @param {string} workingDirectory - Working directory.
 * @returns {Promise<object>} Baseline capture result.
 */
async function captureTestBaseline(taskId, workingDirectory) {
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
    tests: totalMatch ? parseInt(totalMatch[1], 10) : 0,
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
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
    newFailures, now
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

        _getStmt('insertConfigBaseline', `
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

        _getStmt('insertConfigDrift', `
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
        _getStmt('insertConfigDriftDeleted', `
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

/**
 * Validate XAML semantics
 * @param {any} taskId
 * @param {any} filePath
 * @param {any} content
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
    _getStmt('insertXamlValidation', `
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
    _getStmt('insertXamlConsistency', `
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
    const spawnArgs = projectFile ? ['run', '--project', projectFile] : ['run'];
    const proc = spawn('dotnet', spawnArgs, {
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
      timeout: (timeoutSeconds + 5) * 1000,
      windowsHide: true,
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

module.exports = {
  setDb,
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
};
