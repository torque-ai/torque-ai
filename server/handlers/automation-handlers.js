/**
 * Automation handlers for TORQUE
 *
 * Implements 6 features to reduce manual orchestration overhead:
 * 1. configure_stall_detection — per-provider stall thresholds + auto-resubmit
 * 2. auto_verify_and_fix — post-task type-check + auto-submit fix tasks
 * 3. generate_test_tasks — scan for untested files, generate test task prompts
 * 4. set_project_defaults / get_project_defaults — per-project provider/model/verify config
 * 5. get_batch_summary — workflow completion summary (files, lines, tests)
 * 6. update_project_stats — count tests/features/coverage, update memory file
 *
 * Additional handlers are re-exported from sub-modules:
 * - automation-ts-tools.js — TypeScript structural tools, semantic tools, Headwaters wrappers
 * - automation-batch-orchestration.js — batch orchestration, feature gaps, commit, spec extraction
 */

const path = require('path');
const fs = require('fs');
const { TASK_TIMEOUTS } = require('../constants');
const { buildErrorFeedbackPrompt } = require('../utils/context-enrichment');
const { safeExecChain } = require('../utils/safe-exec');
const { executeValidatedCommandSync } = require('../execution/command-policy');
const { ErrorCodes, makeError } = require('./shared');
const { createRemoteTestRouter } = require('../remote/remote-test-routing');
const logger = require('../logger').child({ component: 'automation-handlers' });

/**
 * Sanitize a template variable value to prevent injection.
 * Strips shell metacharacters and limits length.
 */
function sanitizeTemplateVariable(value) {
  if (typeof value !== 'string') return String(value);
  // Cap at 10KB per variable
  if (value.length > 10240) {
    value = value.substring(0, 10240) + '... [truncated]';
  }
  // Strip shell metacharacters that could enable command injection
  // Allow normal punctuation but remove backticks, $(), and pipe chains
  value = value.replace(/`/g, "'");
  value = value.replace(/\$\(/g, '(');
  value = value.replace(/\$\{/g, '{');
  return value;
}

// Lazy-load to avoid circular deps
let _db, _taskManager;
function db() { return _db || (_db = require('../database')); }
function taskManager() { return _taskManager || (_taskManager = require('../task-manager')); }

// Lazy-initialized remote test router (created on first verify call)
let _verifyRouter = null;
function getVerifyRouter() {
  if (!_verifyRouter) {
    let agentRegistry = null;
    try {
      const indexModule = require('../index');
      agentRegistry = indexModule.getAgentRegistry();
      logger.info(`[automation-handlers] agentRegistry resolved: ${agentRegistry ? 'yes' : 'null'}`);
    } catch (err) {
      logger.warn('[automation-handlers] Failed to resolve agent registry:', err.message || err);
    }
    _verifyRouter = createRemoteTestRouter({
      agentRegistry,
      db: db(),
      logger,
    });
  }
  return _verifyRouter;
}

// ─── Feature 1: Stall Detection Configuration ───────────────────────────────

function handleConfigureStallDetection(args) {
  const provider = args.provider || 'all';
  // SECURITY: validate provider name to prevent config key injection
  if (!/^[a-zA-Z0-9_-]+$/.test(provider)) {
    return { content: [{ type: 'text', text: `Invalid provider name: ${provider}. Only alphanumeric, hyphens, and underscores allowed.` }], isError: true };
  }
  const thresholdSec = args.stall_threshold_seconds;
  const autoResubmit = args.auto_resubmit;
  const maxAttempts = args.max_resubmit_attempts;

  const changes = [];

  if (typeof thresholdSec === 'number') {
    if (provider === 'all') {
      db().setConfig('stall_threshold_codex', String(thresholdSec));
      db().setConfig('stall_threshold_ollama', String(thresholdSec));
      db().setConfig('stall_threshold_aider', String(thresholdSec));
      db().setConfig('stall_threshold_claude', String(thresholdSec));
      changes.push(`Set stall threshold to ${thresholdSec}s for all providers`);
    } else {
      db().setConfig(`stall_threshold_${provider}`, String(thresholdSec));
      changes.push(`Set stall threshold to ${thresholdSec}s for ${provider}`);
    }
  }

  if (typeof autoResubmit === 'boolean') {
    db().setConfig('stall_auto_resubmit', autoResubmit ? '1' : '0');
    changes.push(`Auto-resubmit on stall: ${autoResubmit ? 'enabled' : 'disabled'}`);
  }

  if (typeof maxAttempts === 'number') {
    db().setConfig('stall_recovery_max_attempts', String(maxAttempts));
    changes.push(`Max resubmit attempts: ${maxAttempts}`);
  }

  // Enable stall detection if setting thresholds
  if (typeof thresholdSec === 'number') {
    db().setConfig('auto_cancel_stalled', '1');
    db().setConfig('stall_recovery_enabled', '1');
    changes.push('Stall detection and recovery: enabled');
  }

  // Read back current config
  const config = {
    codex: db().getConfig('stall_threshold_codex') || 'null (excluded)',
    ollama: db().getConfig('stall_threshold_ollama') || '120',
    aider: db().getConfig('stall_threshold_aider') || '120',
    claude: db().getConfig('stall_threshold_claude') || 'null (excluded)',
    auto_resubmit: db().getConfig('stall_auto_resubmit') === '1',
    max_attempts: db().getConfig('stall_recovery_max_attempts') || '3',
    recovery_enabled: db().getConfig('stall_recovery_enabled') !== '0',
  };

  let output = '## Stall Detection Configuration\n\n';
  if (changes.length > 0) {
    output += '### Changes Applied\n\n';
    for (const change of changes) {
      output += `- ${change}\n`;
    }
    output += '\n';
  }
  output += '### Current Settings\n\n';
  output += `| Provider | Threshold (s) |\n|----------|---------------|\n`;
  output += `| codex | ${config.codex} |\n`;
  output += `| ollama | ${config.ollama} |\n`;
  output += `| aider-ollama | ${config.aider} |\n`;
  output += `| claude-cli | ${config.claude} |\n`;
  output += `\n**Auto-resubmit:** ${config.auto_resubmit ? 'Yes' : 'No'}\n`;
  output += `**Max attempts:** ${config.max_attempts}\n`;
  output += `**Recovery enabled:** ${config.recovery_enabled}\n`;

  return { content: [{ type: 'text', text: output }] };
}

// ─── Free-tier Auto-scale Configuration ──────────────────────────────────────

function handleConfigureFreeTierAutoScale(args) {
  const changes = [];

  if (typeof args.enabled === 'boolean') {
    db().setConfig('free_tier_auto_scale_enabled', args.enabled ? 'true' : 'false');
    changes.push(`Free-tier auto-scale: ${args.enabled ? 'enabled' : 'disabled'}`);
  }

  if (typeof args.queue_depth_threshold === 'number') {
    const threshold = Math.max(1, Math.floor(args.queue_depth_threshold));
    db().setConfig('free_tier_queue_depth_threshold', String(threshold));
    changes.push(`Queue depth threshold: ${threshold}`);
  }

  if (typeof args.cooldown_seconds === 'number') {
    const cooldown = Math.max(0, Math.floor(args.cooldown_seconds));
    db().setConfig('free_tier_cooldown_seconds', String(cooldown));
    changes.push(`Cooldown: ${cooldown}s`);
  }

  // Read back current config
  const config = {
    enabled: db().getConfig('free_tier_auto_scale_enabled') === 'true',
    queue_depth_threshold: parseInt(db().getConfig('free_tier_queue_depth_threshold') || '3', 10),
    cooldown_seconds: parseInt(db().getConfig('free_tier_cooldown_seconds') || '60', 10),
  };

  let output = '## Free-Tier Auto-Scale Configuration\n\n';
  if (changes.length > 0) {
    output += '### Changes Applied\n\n';
    for (const change of changes) {
      output += `- ${change}\n`;
    }
    output += '\n';
  }
  output += '### Current Settings\n\n';
  output += `| Setting | Value |\n|---------|-------|\n`;
  output += `| Enabled | ${config.enabled} |\n`;
  output += `| Queue depth threshold | ${config.queue_depth_threshold} |\n`;
  output += `| Cooldown (seconds) | ${config.cooldown_seconds} |\n`;
  output += '\nWhen enabled, tasks are proactively routed to free-tier providers (groq, cerebras, google-ai, openrouter) when more than ' +
    `${config.queue_depth_threshold} Codex tasks are queued.\n`;

  return { content: [{ type: 'text', text: output }] };
}

// ─── Feature 2: Auto Verify and Fix ─────────────────────────────────────────

async function handleAutoVerifyAndFix(args) {
  try {
  
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }
  

  const verifyCmd = args.verify_command || 'npx tsc --noEmit';
  const autoFix = args.auto_fix !== false; // default true
  const fixProvider = args.fix_provider || 'codex';
  const timeout = (args.timeout_seconds || 120) * 1000;
  const sourceTaskId = args.source_task_id; // Optional: feed errors back with original context

  let output = '## Auto Verify & Fix\n\n';
  output += `**Working directory:** ${workingDir}\n`;
  output += `**Verify command:** \`${verifyCmd}\`\n\n`;

  // Run verify command (routes to remote agent when configured, falls back to local)
  const router = getVerifyRouter();
  const verifyResult = await router.runVerifyCommand(verifyCmd, workingDir, { timeout });
  const verifyOutput = verifyResult.output + (verifyResult.error || '');
  const verifyExitCode = verifyResult.exitCode;

  if (verifyResult.remote) {
    output += `**Execution:** remote (agent)\n`;
  }
  if (verifyResult.durationMs) {
    output += `**Duration:** ${(verifyResult.durationMs / 1000).toFixed(1)}s\n\n`;
  }

  if (verifyExitCode === 0) {
    output += '### Result: PASSED\n\nNo errors found.\n';
    return { content: [{ type: 'text', text: output }] };
  }

  // Parse TypeScript errors: file(line,col): error TSxxxx: message
  const errorLines = verifyOutput.split('\n').filter(line => /error TS\d+/.test(line));
  const errorsByFile = new Map();

  for (const line of errorLines) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/);
    if (match) {
      const [, filePath, lineNum, , tsCode, message] = match;
      const normalizedPath = filePath.replace(/\\/g, '/');
      if (!errorsByFile.has(normalizedPath)) {
        errorsByFile.set(normalizedPath, []);
      }
      errorsByFile.get(normalizedPath).push({ line: lineNum, code: tsCode, message: message.trim() });
    }
  }

  output += `### Result: FAILED (${errorLines.length} error${errorLines.length !== 1 ? 's' : ''} in ${errorsByFile.size} file${errorsByFile.size !== 1 ? 's' : ''})\n\n`;

  for (const [file, errors] of errorsByFile) {
    output += `**${file}:**\n`;
    for (const err of errors) {
      output += `  - Line ${err.line}: ${err.code} — ${err.message}\n`;
    }
    output += '\n';
  }

  // Auto-fix: submit fix tasks
  const submittedTasks = [];
  if (autoFix && errorsByFile.size > 0) {
    output += '### Auto-Fix Tasks\n\n';

    // If source_task_id provided, retrieve original task context for error-feedback retry
    let sourceTask = null;
    if (sourceTaskId) {
      try { sourceTask = db().getTask(sourceTaskId); } catch (err) {
        logger.debug('[automation-handlers] non-critical error loading source task:', err.message || err);
      }
    }

    for (const [file, errors] of errorsByFile) {
      const errorDescriptions = errors.map(e => `Line ${e.line}: ${e.code} — ${e.message}`).join('\n');
      let fixTaskDesc;
      if (sourceTask) {
        // Error-feedback retry: include original context for focused fix
        fixTaskDesc = buildErrorFeedbackPrompt(
          `Fix TypeScript errors in ${file}:\n\n${errorDescriptions}\n\nApply the minimal fix for each error. Do NOT change any logic — only fix type errors. Run \`npx tsc --noEmit\` after fixing to verify.`,
          sourceTask.output,
          errorDescriptions
        );
      } else {
        fixTaskDesc = `Fix TypeScript errors in ${file}:\n\n${errorDescriptions}\n\nRead the file, understand the context around each error line, and apply the minimal fix for each error. Do NOT change any logic — only fix type errors. Run \`npx tsc --noEmit\` after fixing to verify.`;
      }

      try {
        const fixId = require('uuid').v4();
        const fixTask = db().createTask({
          id: fixId,
          task_description: fixTaskDesc,
          working_directory: workingDir,
          provider: null,  // deferred assignment
          metadata: JSON.stringify({ intended_provider: fixProvider }),
          timeout_minutes: 10,
          auto_approve: false,
          priority: 5, // higher priority for fixes
        });
        taskManager().startTask(fixTask.id);
        submittedTasks.push({ taskId: fixTask.id, file, errorCount: errors.length });
        output += `- **${file}** (${errors.length} error${errors.length !== 1 ? 's' : ''}): Task \`${fixTask.id.substring(0, 8)}\` submitted to ${fixProvider}\n`;
      } catch (err) {
        output += `- **${file}**: Failed to submit fix task — ${err.message}\n`;
      }
    }
  }

  output += `\n**Summary:** ${errorLines.length} errors, ${submittedTasks.length} fix tasks submitted\n`;

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

// ─── Feature 3: Generate Test Tasks ──────────────────────────────────────────

function handleGenerateTestTasks(args) {
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const count = Math.min(Math.max(args.count || 5, 1), 20);
  const testPattern = args.test_pattern || '.test.ts';
  let sourceDirs = args.source_dirs;
  if (sourceDirs === undefined) {
    sourceDirs = ['src'];
  } else if (!Array.isArray(sourceDirs)) {
    sourceDirs = [sourceDirs];
  }

  if (!sourceDirs.every((dir) => typeof dir === 'string')) {
    return makeError(ErrorCodes.INVALID_PARAM, 'source_dirs must be an array of strings or a string');
  }
  const autoSubmit = args.auto_submit === true;
  const provider = args.provider || 'codex';
  const excludePatterns = args.exclude_patterns || ['main.ts', 'main.js', 'index.ts', 'Boot', 'Preload'];
  const minLines = args.min_lines || 20;

  // Scan for source files and their test counterparts
  const sourceFiles = [];
  const testFiles = new Set();

  for (const srcDir of sourceDirs) {
    const fullSrcDir = path.join(workingDir, srcDir);
    if (!fs.existsSync(fullSrcDir)) continue;
    scanDirectory(fullSrcDir, workingDir, sourceFiles, testFiles, testPattern);
  }

  // Find untested files (no matching test file)
  const untestedFiles = sourceFiles.filter(f => {
    const baseName = path.basename(f.relativePath, path.extname(f.relativePath));
    const dir = path.dirname(f.relativePath);
    const testDir = path.join(dir, '__tests__');
    const testFileName = baseName + testPattern;
    return !testFiles.has(path.join(testDir, testFileName).replace(/\\/g, '/'))
      && !testFiles.has(path.join(dir, testFileName).replace(/\\/g, '/'));
  });

  // Sort by file size (largest = most impactful to test)
  untestedFiles.sort((a, b) => b.lines - a.lines);

  // Filter out files that are too small or match exclude patterns
  const candidates = untestedFiles.filter(f =>
    f.lines >= minLines
    && !excludePatterns.some(p => f.relativePath.includes(p))
  );

  const selected = candidates.slice(0, count);

  let output = `## Test Gap Analysis\n\n`;
  output += `**Source files:** ${sourceFiles.length}\n`;
  output += `**Test files:** ${testFiles.size}\n`;
  output += `**Untested files:** ${untestedFiles.length}\n`;
  output += `**Coverage:** ${sourceFiles.length > 0 ? Math.round((1 - untestedFiles.length / sourceFiles.length) * 100) : 0}%\n\n`;

  if (selected.length === 0) {
    output += 'No suitable untested files found.\n';
    return { content: [{ type: 'text', text: output }] };
  }

  output += `### Top ${selected.length} Untested Files\n\n`;

  const generatedTasks = [];
  const submittedTasks = [];

  for (const file of selected) {
    const relativePath = file.relativePath.replace(/\\/g, '/');
    const baseName = path.basename(relativePath, path.extname(relativePath));
    const dir = path.dirname(relativePath);
    const testDir = path.join(dir, '__tests__').replace(/\\/g, '/');
    const testFileName = baseName + testPattern;
    const testPath = `${testDir}/${testFileName}`;
    const existingTestPath = findRelatedExistingTestPath(relativePath, testFiles, testPattern);
    const targetTestPath = existingTestPath || testPath;
    const testAction = existingTestPath
      ? `Extend the existing test file ${targetTestPath}`
      : `Create ${targetTestPath}`;

    // Determine file type for task description using configurable category rules
    const defaultCategories = {
      '/ui/': `${testAction} with ~6 tests for the ${baseName} UI component at ${relativePath}.\n\nFirst read ${relativePath} to understand its constructor signature and public methods.\n\nUse vitest. Mock any framework dependencies with minimal mocks — read an existing test file first to understand the mock pattern.\n\nTest:\n1. constructor creates instance without throwing\n2. has expected public methods\n3. Test any public methods that return values\n4. Test show/hide if they exist\n5. Test any state management methods\n6. Verify initial state is reasonable\n\nAdapt tests to whatever ${baseName} actually exposes.`,
      '/data/': `${testAction} to test the exports from ${relativePath}.\n\nFirst read ${relativePath} to understand what it exports.\n\nUse vitest: import { describe, it, expect } from 'vitest'.\n\nWrite ~7 tests:\n1. exports a non-empty array (or object)\n2. every entry has a unique id\n3. every entry has required fields\n4. all id values are non-empty strings\n5. validate enum values against their type definitions\n6. numeric fields are positive numbers\n7. string fields are non-empty\n\nAdapt tests to the actual exports and structure.`,
      '/systems/': `${testAction} with ~8 tests for the ${baseName} system at ${relativePath}.\n\nFirst read ${relativePath} to understand the class, its constructor, and public methods.\n\nUse vitest. Setup: beforeEach creates fresh instance.\n\nTest the key public methods — construction, state management, event emission, serialization round-trip if available.\n\nAdapt tests to whatever ${baseName} actually exposes.`,
      '/types/': `${testAction} to validate the type definitions in ${relativePath}.\n\nFirst read ${relativePath}.\n\nUse vitest. Test that exported enums have expected values, interfaces can be instantiated with valid data, and type guards work correctly if any exist.\n\nAdapt tests to actual exports.`,
    };
    const categories = args.category_templates || defaultCategories;
    const defaultTemplate = args.default_template || `${testAction} with tests for ${relativePath}.\n\nFirst read ${relativePath} to understand its exports and behavior.\n\nUse vitest. Write tests covering the main functionality.\n\nAdapt tests to actual exports.`;

    let taskDesc = defaultTemplate;
    for (const [pathPattern, template] of Object.entries(categories)) {
      if (relativePath.includes(pathPattern)) {
        taskDesc = template;
        break;
      }
    }

    generatedTasks.push({
      node_id: `test-${baseName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      file: relativePath,
      lines: file.lines,
      testPath: targetTestPath,
      task: taskDesc,
    });

    if (autoSubmit) {
      try {
        const testId = require('uuid').v4();
        const testTask = db().createTask({
          id: testId,
          task_description: taskDesc,
          working_directory: workingDir,
          provider,
          timeout_minutes: 15,
          auto_approve: false,
          priority: 0,
        });
        taskManager().startTask(testTask.id);
        submittedTasks.push({ taskId: testTask.id, file: relativePath });
        output += `| ${relativePath} | ${file.lines} | \`${testTask.id.substring(0, 8)}\` submitted |\n`;
      } catch (err) {
        output += `| ${relativePath} | ${file.lines} | Submit failed: ${err.message} |\n`;
      }
    }
  }

  if (!autoSubmit) {
    output += `| File | Lines | Test Path |\n|------|-------|-----------|\n`;
    for (const task of generatedTasks) {
      output += `| ${task.file} | ${task.lines} | ${task.testPath} |\n`;
    }
    output += '\n### Generated Task Descriptions\n\n';
    output += 'Use these with `add_workflow_task` or `submit_task`:\n\n';
    output += '```json\n';
    output += JSON.stringify(generatedTasks.map(t => ({
      node_id: t.node_id,
      task: t.task
    })), null, 2);
    output += '\n```\n';
  } else {
    output += `\n**Submitted ${submittedTasks.length} test tasks to ${provider}.**\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

function findRelatedExistingTestPath(relativePath, testFiles, testPattern) {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const dir = path.dirname(normalizedPath);
  const parentDir = path.dirname(dir);
  const baseName = path.basename(normalizedPath, path.extname(normalizedPath));
  const testFileName = `${baseName}${testPattern}`;
  const exactCandidates = new Set([
    path.join(dir, '__tests__', testFileName).replace(/\\/g, '/'),
    path.join(dir, testFileName).replace(/\\/g, '/'),
    path.join(parentDir, 'tests', testFileName).replace(/\\/g, '/'),
  ]);

  for (const testFile of testFiles) {
    const normalizedTest = testFile.replace(/\\/g, '/');
    const testBaseName = path.basename(normalizedTest);
    if (exactCandidates.has(normalizedTest)) {
      return normalizedTest;
    }
    if (testBaseName === testFileName || testBaseName.endsWith(`-${testFileName}`)) {
      return normalizedTest;
    }
  }

  return null;
}

// Helper: recursively scan directory for source and test files
function scanDirectory(dirPath, rootDir, sourceFiles, testFiles, testPattern) {
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__mocks__']);

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (!IGNORE.has(entry.name)) {
        scanDirectory(fullPath, rootDir, sourceFiles, testFiles, testPattern);
      }
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name);
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;

    if (entry.name.endsWith(testPattern) || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.spec.js')) {
      testFiles.add(relativePath);
      continue;
    }

    // Count lines
    let lines = 0;
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      lines = content.split('\n').length;
    } catch {
      lines = 0;
    }

    sourceFiles.push({ relativePath, lines });
  }
}

// ─── Feature 4: Per-Project Provider Defaults ────────────────────────────────

function handleSetProjectDefaults(args) {
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const project = db().getProjectFromPath(workingDir);
  if (!project) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Could not determine project from path: ${workingDir}`);
  }

  // Ensure custom columns exist
  db().safeAddColumn('project_config', 'default_provider TEXT');
  db().safeAddColumn('project_config', 'default_model TEXT');
  db().safeAddColumn('project_config', 'verify_command TEXT');
  db().safeAddColumn('project_config', 'auto_fix_enabled INTEGER DEFAULT 0');
  db().safeAddColumn('project_config', 'test_pattern TEXT');
  db().safeAddColumn('project_config', 'auto_verify_on_completion INTEGER');

  const changes = [];
  const configUpdate = {};

  if (args.provider) {
    const validProviders = ['codex', 'codex-spark', 'claude-cli', 'ollama', 'aider-ollama', 'hashline-ollama', 'deepinfra', 'hyperbolic', 'groq', 'cerebras', 'google-ai', 'openrouter', 'anthropic', 'ollama-cloud'];
    if (!validProviders.includes(args.provider)) {
      return makeError(ErrorCodes.INVALID_PARAM, `Invalid provider "${args.provider}". Valid: ${validProviders.join(', ')}`);
    }
    configUpdate.default_provider = args.provider;
    changes.push(`Default provider: ${args.provider}`);
  }

  if (args.model) {
    configUpdate.default_model = args.model;
    changes.push(`Default model: ${args.model}`);
  }

  if (args.verify_command) {
    configUpdate.verify_command = args.verify_command;
    changes.push(`Verify command: ${args.verify_command}`);
  }

  if (typeof args.auto_fix === 'boolean') {
    configUpdate.auto_fix_enabled = args.auto_fix ? 1 : 0;
    changes.push(`Auto-fix: ${args.auto_fix ? 'enabled' : 'disabled'}`);
  }

  if (args.test_pattern) {
    configUpdate.test_pattern = args.test_pattern;
    changes.push(`Test pattern: ${args.test_pattern}`);
  }

  if (typeof args.auto_verify_on_completion === 'boolean') {
    configUpdate.auto_verify_on_completion = args.auto_verify_on_completion ? 1 : 0;
    changes.push(`Auto-verify on completion: ${args.auto_verify_on_completion ? 'enabled' : 'disabled'}`);
  }

  // Remote agent configuration
  if (args.remote_agent_id !== undefined) {
    db().safeAddColumn('project_config', 'remote_agent_id TEXT');
    configUpdate.remote_agent_id = args.remote_agent_id || null;
    changes.push(`Remote agent ID: ${args.remote_agent_id || '(cleared)'}`);
  }
  if (args.remote_project_path !== undefined) {
    db().safeAddColumn('project_config', 'remote_project_path TEXT');
    configUpdate.remote_project_path = args.remote_project_path || null;
    changes.push(`Remote project path: ${args.remote_project_path || '(cleared)'}`);
  }
  if (typeof args.prefer_remote_tests === 'boolean') {
    db().safeAddColumn('project_config', 'prefer_remote_tests INTEGER DEFAULT 0');
    configUpdate.prefer_remote_tests = args.prefer_remote_tests ? 1 : 0;
    changes.push(`Prefer remote tests: ${args.prefer_remote_tests ? 'enabled' : 'disabled'}`);
  }

  // Test station fields
  if (args.test_station_host !== undefined) {
    db().safeAddColumn('project_config', 'test_station_host TEXT');
    configUpdate.test_station_host = args.test_station_host || null;
    changes.push(`Test station host: ${args.test_station_host || '(cleared)'}`);
  }
  if (args.test_station_user !== undefined) {
    db().safeAddColumn('project_config', 'test_station_user TEXT');
    configUpdate.test_station_user = args.test_station_user || null;
    changes.push(`Test station user: ${args.test_station_user || '(cleared)'}`);
  }
  if (args.test_station_project_path !== undefined) {
    db().safeAddColumn('project_config', 'test_station_project_path TEXT');
    configUpdate.test_station_project_path = args.test_station_project_path || null;
    changes.push(`Test station project path: ${args.test_station_project_path || '(cleared)'}`);
  }
  if (args.test_station_key_path !== undefined) {
    db().safeAddColumn('project_config', 'test_station_key_path TEXT');
    configUpdate.test_station_key_path = args.test_station_key_path || null;
    changes.push(`Test station key path: ${args.test_station_key_path || '(cleared)'}`);
  }

  // Use existing setProjectConfig API
  if (Object.keys(configUpdate).length > 0) {
    db().setProjectConfig(project, configUpdate);
  }

  // Persist step_providers via project_metadata (no schema migration needed)
  if (args.step_providers && typeof args.step_providers === 'object') {
    db().setProjectMetadata(project, 'step_providers', JSON.stringify(args.step_providers));
    changes.push(`Step providers: ${JSON.stringify(args.step_providers)}`);
  }

  // Read back
  const config = db().getProjectConfig(project) || {};

  let output = `## Project Defaults: ${project}\n\n`;
  if (changes.length > 0) {
    output += '### Changes Applied\n\n';
    for (const c of changes) {
      output += `- ${c}\n`;
    }
    output += '\n';
  }
  output += formatProjectConfig(config);

  return { content: [{ type: 'text', text: output }] };
}

function handleGetProjectDefaults(args) {
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const project = db().getProjectFromPath(workingDir);
  if (!project) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Could not determine project from path: ${workingDir}`);
  }

  const config = db().getProjectConfig(project);
  if (!config) {
    return { content: [{ type: 'text', text: `## Project Defaults: ${project}\n\nNo project configuration found. Use \`set_project_defaults\` to configure.` }] };
  }

  // Include step_providers from project_metadata
  const stepProvidersJson = db().getProjectMetadata(project, 'step_providers');
  let stepProviders = null;
  if (stepProvidersJson) {
    try {
      stepProviders = JSON.parse(stepProvidersJson);
    } catch (err) {
      logger.debug('[automation-handlers] invalid step_providers JSON for project defaults:', err.message || err);
      stepProviders = {};
    }
  }

  let output = `## Project Defaults: ${project}\n\n`;
  output += formatProjectConfig(config, stepProviders);

  return { content: [{ type: 'text', text: output }] };
}

function formatProjectConfig(config, stepProviders) {
  let output = '### Current Settings\n\n';
  output += `| Setting | Value |\n|---------|-------|\n`;
  output += `| Provider | ${config.default_provider || '(smart routing)'} |\n`;
  output += `| Model | ${config.default_model || '(auto)'} |\n`;
  output += `| Verify command | ${config.verify_command || '(none)'} |\n`;
  output += `| Auto-fix | ${config.auto_fix_enabled ? 'Yes' : 'No'} |\n`;
  output += `| Test pattern | ${config.test_pattern || '.test.ts'} |\n`;
  output += `| Timeout | ${config.default_timeout || 30}min |\n`;
  output += `| Max concurrent | ${config.max_concurrent || 0} (0=unlimited) |\n`;
  output += `| Build verification | ${config.build_verification_enabled ? 'Yes' : 'No'} |\n`;
  if (config.remote_agent_id) {
    output += `| Remote agent | ${config.remote_agent_id} |\n`;
    output += `| Remote path | ${config.remote_project_path || '(same as local)'} |\n`;
    output += `| Prefer remote tests | ${config.prefer_remote_tests ? 'Yes' : 'No'} |\n`;
  }
  if (stepProviders && Object.keys(stepProviders).length > 0) {
    output += `| Step providers | ${Object.entries(stepProviders).map(([k, v]) => `${k}=${v}`).join(', ')} |\n`;
  }
  return output;
}

// ─── Feature 5: Batch Completion Summary ─────────────────────────────────────

function handleGetBatchSummary(args) {
  const workflowId = args.workflow_id;
  if (!workflowId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required');
  }

  const workflow = db().getWorkflow(workflowId);
  if (!workflow) {
    return makeError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow not found: ${workflowId}`);
  }

  const status = db().getWorkflowStatus(workflowId);
  if (!status) {
    return makeError(ErrorCodes.OPERATION_FAILED, 'Could not get workflow status');
  }

  // Get working directory from workflow tasks
  const tasks = Object.values(status.tasks || {});
  const workingDir = args.working_directory || workflow.working_directory || (tasks[0] && tasks[0].working_directory);

  let output = `## Batch Summary: ${status.name}\n\n`;
  output += `**Status:** ${status.status}\n`;
  output += `**Tasks:** ${status.summary.completed} completed, ${status.summary.failed} failed, ${status.summary.total} total\n`;

  let durationSeconds = null;
  if (status.started_at) {
    const elapsed = (status.completed_at || Date.now()) - new Date(status.started_at).getTime();
    durationSeconds = Math.round(elapsed / 1000);
    output += `**Duration:** ${durationSeconds}s\n`;
  }

  // Get git diff stats if working directory available
  let filesAdded = 0;
  let filesModified = 0;
  let testCount = null;
  if (workingDir) {
    try {
      // Get diff from before workflow started
      const diffStat = executeValidatedCommandSync('git', ['diff', '--stat', 'HEAD~1'], {
        profile: 'safe_verify',
        source: 'get_batch_summary',
        caller: 'handleGetBatchSummary',
        cwd: workingDir,
        timeout: TASK_TIMEOUTS.GIT_DIFF,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      if (diffStat) {
        output += '\n### Git Changes\n\n```\n' + diffStat + '\n```\n';
      }

      // Count new vs modified files
      const diffNameStatus = executeValidatedCommandSync('git', ['diff', '--name-status', 'HEAD~1'], {
        profile: 'safe_verify',
        source: 'get_batch_summary',
        caller: 'handleGetBatchSummary',
        cwd: workingDir,
        timeout: TASK_TIMEOUTS.GIT_DIFF,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      if (diffNameStatus) {
        const lines = diffNameStatus.split('\n');
        filesAdded = lines.filter(l => l.startsWith('A')).length;
        filesModified = lines.filter(l => l.startsWith('M')).length;
        output += `\n**Files added:** ${filesAdded}\n`;
        output += `**Files modified:** ${filesModified}\n`;

        // Calculate total lines added/removed
        try {
          const shortstat = executeValidatedCommandSync('git', ['diff', '--shortstat', 'HEAD~1'], {
            profile: 'safe_verify',
            source: 'get_batch_summary',
            caller: 'handleGetBatchSummary',
            cwd: workingDir,
            timeout: TASK_TIMEOUTS.GIT_DIFF,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();
          if (shortstat) {
            output += `**Changes:** ${shortstat}\n`;
          }
        } catch (err) {
          logger.debug('[automation-handlers] non-critical error resolving shortstat:', err.message || err);
        }
      }
    } catch (err) {
      logger.debug('[automation-handlers] non-critical error running git shortstat command:', err.message || err);
    }

    // Run test count if vitest is available
    try {
      const testResult = safeExecChain('npx vitest run --reporter=verbose', {
        cwd: workingDir,
        timeout: TASK_TIMEOUTS.TEST_RUN,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      if (testResult.exitCode === 0) {
        const testOutput = testResult.output;
        const testMatch = testOutput.match(/(\d+)\s+passed/);
        const fileMatch = testOutput.match(/(\d+)\s+passed.*\((\d+)\)/);
        if (testMatch) {
          testCount = parseInt(testMatch[1], 10);
          output += `\n### Test Results\n\n`;
          output += `**Tests passing:** ${testMatch[1]}\n`;
          if (fileMatch && fileMatch[2]) {
            output += `**Test files:** ${fileMatch[2]}\n`;
          }
        }
      }
    } catch (err) {
      logger.debug('[automation-handlers] non-critical error reading verification defaults:', err.message || err);
    }
  }

  // Task breakdown
  output += '\n### Task Breakdown\n\n';
  output += '| Task | Status | Duration |\n|------|--------|----------|\n';

  for (const task of tasks) {
    const nodeId = task.node_id || task.id.substring(0, 8);
    const taskStatus = task.status || 'unknown';
    let duration = '-';
    if (task.started_at && task.completed_at) {
      const ms = new Date(task.completed_at).getTime() - new Date(task.started_at).getTime();
      duration = `${Math.round(ms / 1000)}s`;
    }
    output += `| ${nodeId} | ${taskStatus} | ${duration} |\n`;
  }

  const structuredData = {
    workflow_id: workflowId,
    workflow_status: status.status,
    completed_tasks: status.summary.completed,
    failed_tasks: status.summary.failed,
    total_tasks: status.summary.total,
    files_added: filesAdded,
    files_modified: filesModified,
  };
  if (durationSeconds !== null) structuredData.duration_seconds = durationSeconds;
  if (testCount !== null) structuredData.test_count = testCount;

  return {
    content: [{ type: 'text', text: output }],
    structuredData,
  };
}

// ─── Feature 14: Update Project Stats ────────────────────────────────────────

function handleUpdateProjectStats(args) {
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const memoryPath = args.memory_path;
  if (!memoryPath) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'memory_path is required (path to MEMORY.md)');
  }

  // Configurable parameters with Headwaters defaults
  const featureDir = args.feature_dir || 'src/systems';
  const featureLabel = args.feature_label || 'systems';
  const featurePattern = args.feature_pattern || '.ts';
  const sourceDir = args.source_dir || 'src';
  const testPattern = args.test_pattern || '.test.ts';
  const statsPattern = args.stats_pattern || 'Test coverage is currently \\*\\*[\\d/]+ source files \\(\\d+%\\)\\*\\*, \\d+ tests passing';
  const statsTemplate = args.stats_template || 'Test coverage is currently **{tested}/{total} source files ({percent}%)**, {tests} tests passing';

  // Resolve test command: explicit arg > project defaults > fallback
  let testCommand = args.test_command;
  if (!testCommand) {
    try {
      const defaults = db().getConfig(`project_defaults_${workingDir}`);
      if (defaults) {
        const parsed = JSON.parse(defaults);
        testCommand = parsed.verify_command;
      }
    } catch (err) {
      logger.debug('[automation-handlers] non-critical error reading feature defaults:', err.message || err);
    }
  }
  if (!testCommand) testCommand = 'npx vitest run --reporter=verbose';

  let output = `## Update Project Stats\n\n`;

  // Count tests
  let testCount = 0;
  let testFileCount = 0;
  try {
    // testCommand is intentionally a user-provided shell command (e.g. "npx vitest run")
    const testResult = safeExecChain(testCommand, {
      cwd: workingDir, timeout: TASK_TIMEOUTS.VERIFY_COMMAND, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    });
    const testOutput = testResult.exitCode === 0 ? testResult.output : `${testResult.output}\n${testResult.error || ''}`;
    // Try vitest/jest pattern, then mocha pattern
    const testMatch = testOutput.match(/(\d+)\s+(?:passed|passing)/);
    if (testMatch) testCount = parseInt(testMatch[1], 10);
    const fileMatch = testOutput.match(/(\d+)\s+passed\s*\((\d+)\)/) || testOutput.match(/Test Files\s+(\d+)\s+passed/);
    if (fileMatch) testFileCount = parseInt(fileMatch[fileMatch.length > 2 ? 2 : 1], 10);
  } catch (err) {
    const stderr = (err.stdout || '') + '\n' + (err.stderr || '');
    const testMatch = stderr.match(/(\d+)\s+(?:passed|passing)/);
    if (testMatch) testCount = parseInt(testMatch[1], 10);
    const fileMatch = stderr.match(/Test Files\s+(\d+)\s+passed/);
    if (fileMatch) testFileCount = parseInt(fileMatch[1], 10);
  }

  // Count features (configurable dir + pattern)
  let featureCount = 0;
  const featureDirFull = path.join(workingDir, featureDir);
  try {
    const files = fs.readdirSync(featureDirFull);
    featureCount = files.filter(f => f.endsWith(featurePattern) && !f.includes('__tests__') && !f.startsWith('.')).length;
    } catch (err) {
      logger.debug('[automation-handlers] non-critical error counting features:', err.message || err);
    }

  // Count source files and test coverage
  let sourceFileCount = 0;
  let testedFileCount = 0;
  const sourceFiles = [];
  const testFiles = new Set();
  const srcDir = path.join(workingDir, sourceDir);
  if (fs.existsSync(srcDir)) {
    scanDirectory(srcDir, workingDir, sourceFiles, testFiles, testPattern);
    sourceFileCount = sourceFiles.length;
    testedFileCount = testFiles.size;
  }

  const coveragePercent = sourceFileCount > 0
    ? Math.round((testedFileCount / sourceFileCount) * 100)
    : 0;

  output += `**Tests:** ${testCount} passing across ${testFileCount} test files\n`;
  output += `**${featureLabel.charAt(0).toUpperCase() + featureLabel.slice(1)}:** ${featureCount} in ${featureDir}\n`;
  output += `**Source files:** ${sourceFileCount}\n`;
  output += `**Test files:** ${testedFileCount}\n`;
  output += `**Coverage:** ${testedFileCount}/${sourceFileCount} source files (${coveragePercent}%)\n\n`;

  // Update MEMORY.md if it exists
  if (fs.existsSync(memoryPath)) {
    try {
      let memContent = fs.readFileSync(memoryPath, 'utf8');

      const coverageRegex = new RegExp(statsPattern);
      const newCoverageLine = statsTemplate
        .replace('{tested}', testedFileCount)
        .replace('{total}', sourceFileCount)
        .replace('{percent}', coveragePercent)
        .replace('{tests}', testCount);

      if (coverageRegex.test(memContent)) {
        memContent = memContent.replace(coverageRegex, newCoverageLine);
        fs.writeFileSync(memoryPath, memContent, 'utf8');
        output += `### Memory Updated\n\nUpdated coverage stats in ${memoryPath}\n`;
      } else {
        output += `### Memory Not Updated\n\nCould not find stats pattern in ${memoryPath}. Manual update needed:\n\n`;
        output += `\`${newCoverageLine}\`\n`;
      }
    } catch (err) {
      output += `Error updating memory: ${err.message}\n`;
    }
  } else {
    output += `Memory file not found: ${memoryPath}\n`;
  }

  return {
    content: [{ type: 'text', text: output }],
    _stats: { testCount, testFileCount, featureCount, sourceFileCount, testedFileCount, coveragePercent },
  };
}

// ─── Feature 7: Task Event History ───────────────────────────────────────────

function handleGetTaskEvents(args) {
  const { getTaskEvents } = require('../hooks/event-dispatch');

  const rawLimit = args.limit;
  const defaultLimit = 50;
  const parsedLimit = rawLimit === undefined ? defaultLimit : parseInt(rawLimit, 10);
  if (Number.isNaN(parsedLimit) || parsedLimit < 1) {
    return makeError(ErrorCodes.INVALID_PARAM, 'limit must be a positive integer');
  }

  const events = getTaskEvents({
    task_id: args.task_id || undefined,
    event_type: args.event_type || undefined,
    limit: parsedLimit,
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        events: events.map(e => {
          let eventData = null;
          if (e.event_data) {
            try { eventData = JSON.parse(e.event_data); } catch { eventData = e.event_data; }
          }
          return { ...e, event_data: eventData };
        }),
        count: events.length,
      }, null, 2),
    }],
  };
}

// ─── Feature 8: Task Prompt Templates ────────────────────────────────────────

// Lazy-load to avoid circular deps with integration-routing
let _handleSmartSubmitTask;
function getSmartSubmitHandler() {
  if (!_handleSmartSubmitTask) {
    _handleSmartSubmitTask = require('./integration/routing').handleSmartSubmitTask;
  }
  return _handleSmartSubmitTask;
}

function handleCreateTaskTemplate(args) {
  if (!args.name) return makeError(ErrorCodes.INVALID_PARAM, 'Template name is required');
  if (!args.task_template) return makeError(ErrorCodes.INVALID_PARAM, `task_template is required to create template '${args.name || '(unnamed)'}'`);

  const template = db().saveTemplate({
    name: args.name,
    description: args.description || null,
    task_template: args.task_template,
    default_timeout: args.default_timeout || 30,
    default_priority: args.default_priority || 0,
    auto_approve: args.auto_approve || false
  });

  const vars = (args.task_template.match(/\{\{(\w+)\}\}/g) || []).map(v => v.slice(2, -2));

  return {
    content: [{ type: 'text', text: `Template "${template.name}" created successfully.\nVariables: ${vars.length > 0 ? vars.join(', ') : 'none'}\nUsage: submit_from_template({ template_name: "${template.name}", variables: { ${vars.map(v => `${v}: "..."`).join(', ')} } })` }]
  };
}

function handleListTaskTemplates() {
  const templates = db().listTemplates();
  if (templates.length === 0) {
    return { content: [{ type: 'text', text: 'No templates found. Create one with create_task_template.' }] };
  }
  const lines = templates.map(t => {
    const vars = (t.task_template.match(/\{\{(\w+)\}\}/g) || []).map(v => v.slice(2, -2));
    return `- **${t.name}** (used ${t.usage_count}x) — ${t.description || 'No description'}\n  Variables: ${vars.join(', ') || 'none'}\n  Template: ${t.task_template.substring(0, 100)}${t.task_template.length > 100 ? '...' : ''}`;
  });
  return { content: [{ type: 'text', text: `${templates.length} template(s):\n\n${lines.join('\n\n')}` }] };
}

async function handleSubmitFromTemplate(args) {
  try {
  
  if (!args.template_name) return makeError(ErrorCodes.INVALID_PARAM, 'template_name is required to submit from a task template');

  const template = db().getTemplate(args.template_name);
  if (!template) return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Template "${args.template_name}" not found`);

  const variables = args.variables || {};
  
  const description = template.task_template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return variables[key] !== undefined ? sanitizeTemplateVariable(variables[key]) : `{{${key}}}`;
  });

  db().incrementTemplateUsage(args.template_name);

  // Delegate to smart_submit_task handler for automatic provider routing
  return getSmartSubmitHandler()({
    task: description,
    working_directory: args.working_directory,
    override_provider: args.provider,
    model: args.model,
    timeout_minutes: template.default_timeout,
    priority: template.default_priority,
    tags: args.tags
  });
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

function handleDeleteTaskTemplate(args) {
  if (!args.name) return makeError(ErrorCodes.INVALID_PARAM, 'Template name is required for delete_task_template');
  const deleted = db().deleteTemplate(args.name);
  if (!deleted) return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Template "${args.name}" not found`);
  return { content: [{ type: 'text', text: `Template "${args.name}" deleted successfully.` }] };
}

// ─── Re-export from sub-modules ──────────────────────────────────────────────

const tsTools = require('./automation-ts-tools');
const batchOrchestration = require('./automation-batch-orchestration');

function createAutomationHandlers() {
  return {
    handleConfigureStallDetection,
    handleConfigureFreeTierAutoScale,
    handleAutoVerifyAndFix,
    handleGenerateTestTasks,
    handleSetProjectDefaults,
    handleGetProjectDefaults,
    handleGetBatchSummary,
    handleUpdateProjectStats,
    handleGetTaskEvents,
    handleCreateTaskTemplate,
    handleListTaskTemplates,
    handleSubmitFromTemplate,
    handleDeleteTaskTemplate,
    ...batchOrchestration,
    ...tsTools,
  };
}

module.exports = {
  // Project/config automation (local to this file)
  handleConfigureStallDetection,
  handleConfigureFreeTierAutoScale,
  handleAutoVerifyAndFix,
  handleGenerateTestTasks,
  handleSetProjectDefaults,
  handleGetProjectDefaults,
  handleGetBatchSummary,
  handleUpdateProjectStats,
  handleGetTaskEvents,
  // Task prompt templates
  handleCreateTaskTemplate,
  handleListTaskTemplates,
  handleSubmitFromTemplate,
  handleDeleteTaskTemplate,
  // Re-exported from automation-batch-orchestration.js
  ...batchOrchestration,
  // Re-exported from automation-ts-tools.js
  ...tsTools,
  createAutomationHandlers,
};
