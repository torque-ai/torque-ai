/**
 * Batch orchestration handlers for TORQUE.
 * Extracted from automation-handlers.js — Part 2 decomposition.
 *
 * Contains:
 * - generate_feature_tasks — generate 5 task descriptions for a feature workflow
 * - run_batch — full one-shot orchestration (generate + workflow + execute)
 * - detect_file_conflicts — post-workflow file conflict detection
 * - auto_commit_batch — verify + commit + push in one call
 */

const path = require('path');
const fs = require('fs');
const { TASK_TIMEOUTS } = require('../constants');
const { executeValidatedCommandSync } = require('../execution/command-policy');
const { ErrorCodes, makeError, isPathTraversalSafe } = require('./shared');
const logger = require('../logger').child({ component: 'automation-batch' });
const autoCommitBatch = require('./auto-commit-batch');

// Lazy-load to avoid circular deps
let _taskCore;
function taskCore() { return _taskCore || (_taskCore = require('../db/task-core')); }
let _configCore;
function configCore() { return _configCore || (_configCore = require('../db/config-core')); }
let _eventTracking;
function eventTracking() { return _eventTracking || (_eventTracking = require('../db/event-tracking')); }
let _fileTracking;
function fileTracking() { return _fileTracking || (_fileTracking = require('../db/file-tracking')); }
let _projectConfigCore;
function projectConfigCore() { return _projectConfigCore || (_projectConfigCore = require('../db/project-config-core')); }
let _workflowEngine;
function workflowEngine() { return _workflowEngine || (_workflowEngine = require('../db/workflow-engine')); }

function hasShellMetacharacters(value) {
  return /[;&$`|><\n\r]/.test(value);
}

function normalizeCommitPath(filePath, workingDir) {
  if (!workingDir || typeof filePath !== 'string') return null;

  const trimmed = filePath.trim().replace(/^"+|"+$/g, '');
  if (!trimmed) return null;

  const resolvedWorkingDir = path.resolve(workingDir);
  if (path.isAbsolute(trimmed)) {
    const resolvedFile = path.resolve(trimmed);
    const relativePath = path.relative(resolvedWorkingDir, resolvedFile);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null;
    }
    return relativePath.replace(/\\/g, '/');
  }

  const normalizedRelative = path.normalize(trimmed);
  if (!normalizedRelative || normalizedRelative === '.' || normalizedRelative === path.sep) {
    return null;
  }
  if (normalizedRelative === '..' || normalizedRelative.startsWith(`..${path.sep}`)) {
    return null;
  }

  return normalizedRelative.replace(/\\/g, '/');
}

function addTrackedCommitPath(target, filePath, workingDir) {
  const normalized = normalizeCommitPath(filePath, workingDir);
  if (normalized) {
    target.add(normalized);
  }
}

function collectTrackedTaskFiles(taskId, workingDir) {
  const files = new Set();
  if (!taskId || !workingDir) return files;

  try {
    const taskChanges = fileTracking().getTaskFileChanges(taskId) || [];
    for (const change of taskChanges) {
      if (!change || change.is_outside_workdir) continue;
      addTrackedCommitPath(files, change.relative_path || change.file_path, workingDir);
    }
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error reading task_file_changes:', err.message || err);
  }

  if (files.size > 0) {
    return files;
  }

  try {
    const task = taskCore().getTask(taskId);
    const modifiedFiles = Array.isArray(task?.files_modified) ? task.files_modified : [];
    for (const file of modifiedFiles) {
      const candidate = typeof file === 'string'
        ? file
        : file?.path || file?.file_path || '';
      addTrackedCommitPath(files, candidate, workingDir);
    }
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error reading files_modified fallback:', err.message || err);
  }

  return files;
}

function resolveTaskIdsForCommit(args) {
  const taskIds = new Set();

  if (typeof args.task_id === 'string' && args.task_id.trim()) {
    taskIds.add(args.task_id.trim());
  }

  if (Array.isArray(args.task_ids)) {
    for (const taskId of args.task_ids) {
      if (typeof taskId === 'string' && taskId.trim()) {
        taskIds.add(taskId.trim());
      }
    }
  }

  if (typeof args.workflow_id === 'string' && args.workflow_id.trim()) {
    try {
      const workflowTasks = workflowEngine().getWorkflowTasks(args.workflow_id) || [];
      for (const task of workflowTasks) {
        if (task?.id) {
          taskIds.add(task.id);
        }
      }
    } catch (err) {
      logger.debug('[automation-batch-orchestration] non-critical error loading workflow task ids for commit:', err.message || err);
    }
  }

  return [...taskIds];
}

function resolveTrackedCommitFiles(args, workingDir) {
  const files = new Set();
  for (const taskId of resolveTaskIdsForCommit(args)) {
    for (const file of collectTrackedTaskFiles(taskId, workingDir)) {
      files.add(file);
    }
  }
  return [...files];
}

function getFallbackCommitFiles(workingDir) {
  try {
    const diffOutput = executeValidatedCommandSync('git', ['diff', '--name-only', '--relative', 'HEAD', '--', '.'], {
      profile: 'safe_verify',
      source: 'auto_commit_batch',
      caller: 'getFallbackCommitFiles',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (!diffOutput) {
      return [];
    }

    return [...new Set(
      diffOutput
        .split(/\r?\n/)
        .map(file => normalizeCommitPath(file, workingDir))
        .filter(Boolean)
    )];
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error reading git diff fallback:', err.message || err);
    return [];
  }
}

// ─── Feature 7: Generate Feature Task Descriptions ───────────────────────────

function handleGenerateFeatureTasks(args) {
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const featureName = args.feature_name;
  if (!featureName) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'feature_name is required');
  }

  const description = args.feature_description || '';
  const kebab = featureName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  const pascal = featureName.charAt(0).toUpperCase() + featureName.slice(1);

  // Read project structure to find template files
  const typesDir = path.join(workingDir, 'src', 'types');
  const systemsDir = path.join(workingDir, 'src', 'systems');
  const dataDir = path.join(workingDir, 'src', 'data');
  const testsDir = path.join(workingDir, 'src', 'systems', '__tests__');

  // Find a reference type file, system file, data file, test file
  const refType = findLargestFile(typesDir, '.ts', ['index.ts']);
  const refSystem = findLargestFile(systemsDir, '.ts', ['EventSystem.ts', 'index.ts'], true);
  const refData = findLargestFile(dataDir, '.ts', ['index.ts']);
  const refTest = findLargestFile(testsDir, '.test.ts', []);

  // Extract user-provided specs
  const typesSpec = args.types_spec || '';
  const eventsSpec = args.events_spec || '';
  const dataSpec = args.data_spec || '';
  const systemSpec = args.system_spec || '';

  // Build the 5 task descriptions
  const tasks = {};

  // 1. Types task
  tasks.types = `Create src/types/${kebab}.ts with type definitions for the ${pascal} feature.${refType ? `\n\nFollow the exact pattern used in ${refType.relative} as a reference.` : ''}

${description ? `Feature description: ${description}\n` : ''}${typesSpec ? `\nTypes to define:\n${typesSpec}` : `\nDefine the following:\n- Status enum (string enum with relevant states)\n- Core entity interface (the main data type for this feature)\n- Definition interface (static config for creating entities)\n- SystemState interface (for serialization: arrays of entities + aggregate stats)\n\nExport all types. Use readonly where sensible. Keep the file clean — no logic, no imports from other systems.`}`;

  // 2. Events task
  tasks.events = `Edit src/systems/EventSystem.ts to add event types for the ${pascal} feature.

Add new event types to the events interface (before the closing brace).

${eventsSpec ? `Events to add:\n${eventsSpec}` : `Add 3-4 events with typed payloads for the key actions in this feature (e.g., creation, completion, milestone).`}

Use 2-space indentation matching the style of existing events. Do NOT modify any existing events.`;

  // 3. Data task
  tasks.data = `Create src/data/${kebab}s.ts with static definitions for the ${pascal} feature.${refData ? `\n\nFollow the pattern in ${refData.relative} as a reference.` : ''}\n\nImport types from ../types/${kebab}.

${dataSpec ? `Data to define:\n${dataSpec}` : `Export a definitions array with 8-12 entries covering the feature's main categories. Each entry should have an id, name, description, and category-specific fields matching the Definition interface from the types file.`}`;

  // 4. System task
  tasks.system = `Create src/systems/${pascal}System.ts implementing the ${pascal} feature.${refSystem ? `\n\nFollow the EXACT pattern of ${refSystem.relative} (constructor-based, no scene dependency, event-driven).` : ''}

Import types from ../types/${kebab}, data from ../data/${kebab}s, and EventSystem from ./EventSystem.

${systemSpec || `The system should:
- Initialize from definitions in constructor (index into Map, create entities)
- Have public methods for the core CRUD operations
- Emit events via EventSystem.instance.emit() on key state changes
- Track aggregate stats (totals, counts)
- Include toJSON(): SystemState for serialization
- Include loadState(state): void with defensive deserialization (validate types, sanitize numbers, reconstruct from definitions)
- Use private clone helpers for defensive copies in getters
- Include a private sanitizeNumber(value, fallback) helper`}`;

  // 5. Tests task
  tasks.tests = `Create src/systems/__tests__/${pascal}System.test.ts with ~16 tests using vitest.${refTest ? `\n\nFollow the pattern from ${refTest.relative}.` : ''}

Import { describe, it, expect, beforeEach, vi } from 'vitest'.

Setup: beforeEach creates a fresh ${pascal}System instance and resets EventSystem.instance with clear().

Test the following areas:
1. Initialization (correct entity count from definitions, initial state)
2. Core operations (each public method — success and failure cases)
3. Event emission (subscribe to events, verify payloads)
4. State queries (filtering, counting, aggregation)
5. Serialization round-trip (toJSON → new instance → loadState → verify stats match)
6. Edge cases (invalid IDs, duplicate operations, boundary conditions)

Use EventSystem.instance.subscribe to listen for events. Use Date.now = vi.fn(() => 1000) to control timestamps.`;

  let output = `## Generated Task Descriptions: ${pascal}System\n\n`;
  output += `**Feature:** ${featureName}\n`;
  output += `**Description:** ${description || '(none provided)'}\n\n`;

  output += '### Tasks\n\n';
  for (const [step, desc] of Object.entries(tasks)) {
    output += `#### ${step}\n\`\`\`\n${desc}\n\`\`\`\n\n`;
  }

  // Return structured data for use with create_feature_workflow
  output += '### Usage\n\n';
  output += 'Pass these directly to `create_feature_workflow`:\n';
  output += '```json\n';
  output += JSON.stringify({
    feature_name: kebab,
    working_directory: workingDir,
    types_task: tasks.types,
    events_task: tasks.events,
    data_task: tasks.data,
    system_task: tasks.system,
    tests_task: tasks.tests,
  }, null, 2).substring(0, 200) + '...\n```\n';

  return {
    content: [{ type: 'text', text: output }],
    _tasks: tasks,
  };
}

// Helper: find largest file in a directory matching extension
function findLargestFile(dirPath, ext, exclude, skipTests) {
  if (!fs.existsSync(dirPath)) return null;

  let best = null;
  let bestSize = 0;

  try {
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      if (!entry.endsWith(ext)) continue;
      if (exclude.includes(entry)) continue;
      if (skipTests && entry.includes('__tests__')) continue;
      if (entry.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.size > bestSize) {
          bestSize = stat.size;
          best = { name: entry, relative: path.relative(path.join(dirPath, '..', '..'), fullPath).replace(/\\/g, '/') };
        }
      } catch (err) {
        logger.debug('[automation-batch-orchestration] non-critical error reading feature file entry:', err.message || err);
      }
    }
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error resolving feature directories:', err.message || err);
  }

  return best;
}

// ─── Feature 9: Run Batch (Full Orchestration) ──────────────────────────────

async function handleRunBatch(args) {
  try {
  
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }
  
  if (!isPathTraversalSafe(workingDir)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'working_directory contains path traversal');
  }
  if (hasShellMetacharacters(workingDir)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'working_directory contains unsupported shell metacharacters');
  }

  const featureName = args.feature_name;
  if (!featureName) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'feature_name is required');
  }
  if (typeof featureName !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'feature_name must be a string');
  }
  if (hasShellMetacharacters(featureName)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'feature_name contains unsupported shell metacharacters');
  }

  const featureDescription = args.feature_description || '';
  let rawParallelTestCount = args.parallel_test_count;
  if (rawParallelTestCount !== undefined) {
    const parsedParallelTestCount = parseInt(rawParallelTestCount, 10);
    if (Number.isNaN(parsedParallelTestCount)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'parallel_test_count must be an integer');
    }
    rawParallelTestCount = parsedParallelTestCount;
  }
  const parallelTestCount = Math.min(Math.max(rawParallelTestCount || 3, 0), 5);
  const _provider = args.provider || 'codex';
  const batchName = args.batch_name || `Batch — ${featureName}System`;

  // Merge saved step_providers with per-call overrides (per-call wins)
  const project = projectConfigCore().getProjectFromPath(workingDir);
  const savedStepProviders = (() => {
    try { return JSON.parse(projectConfigCore().getProjectMetadata(project, 'step_providers') || '{}'); }
    catch { return {}; }
  })();
  const stepProviders = { ...savedStepProviders, ...(args.step_providers || {}) };

  let output = `## Run Batch: ${featureName}\n\n`;

  // Step 1: Generate feature task descriptions
  output += '### Step 1: Generating task descriptions...\n\n';
  const featureTaskResult = handleGenerateFeatureTasks({
    working_directory: workingDir,
    feature_name: featureName,
    feature_description: featureDescription,
    types_spec: args.types_spec || '',
    events_spec: args.events_spec || '',
    data_spec: args.data_spec || '',
    system_spec: args.system_spec || '',
  });

  const tasks = featureTaskResult._tasks;
  if (!tasks) {
    return makeError(ErrorCodes.OPERATION_FAILED, output + 'Failed to generate task descriptions.');
  }
  output += `Generated 5 task descriptions.\n\n`;

  // Step 2: Generate parallel test tasks
  // Note: handleGenerateTestTasks is imported from the main automation-handlers module
  let parallelTasks = [];
  if (parallelTestCount > 0) {
    output += '### Step 2: Scanning for test gaps...\n\n';
    const automationHandlers = require('./automation-handlers');
    const testGapResult = automationHandlers.handleGenerateTestTasks({
      working_directory: workingDir,
      count: parallelTestCount,
    });

    // Extract generated tasks from the output (they're in the JSON block)
    try {
      const jsonMatch = testGapResult.content[0].text.match(/```json\n([\s\S]+?)\n```/);
      if (jsonMatch) {
        parallelTasks = JSON.parse(jsonMatch[1]);
        output += `Found ${parallelTasks.length} untested files for parallel tasks.\n\n`;
      }
    } catch (err) {
      logger.debug('[automation-batch-orchestration] non-critical error parsing feature generation response:', err.message || err);
    }
  }

  // Step 3: Create workflow
  output += '### Step 3: Creating workflow...\n\n';
  const workflowHandlers = require('./workflow');

  const kebab = featureName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  const workflowResult = workflowHandlers.handleCreateFeatureWorkflow({
    feature_name: kebab,
    working_directory: workingDir,
    workflow_name: batchName,
    types_task: tasks.types,
    events_task: tasks.events,
    data_task: tasks.data,
    system_task: tasks.system,
    tests_task: tasks.tests,
    parallel_tasks: parallelTasks.map(t => ({
      node_id: t.node_id,
      task: t.task,
    })),
    auto_run: true,
    step_providers: stepProviders,
  });

  // Extract workflow ID from result
  const workflowIdMatch = workflowResult.content[0].text.match(/\*\*ID:\*\*\s*([a-f0-9-]+)/);
  const workflowId = workflowIdMatch ? workflowIdMatch[1] : null;

  if (!workflowId) {
    output += 'Failed to create workflow.\n';
    output += workflowResult.content[0].text;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }

  output += `Workflow created and running: \`${workflowId}\`\n`;
  output += `**Total tasks:** ${5 + parallelTasks.length} (5 feature + ${parallelTasks.length} parallel tests)\n\n`;

  // Step 4: Return workflow ID for monitoring
  output += '### Next Steps\n\n';
  output += `Use \`await_workflow\` to wait for completion:\n`;
  output += '```json\n';
  output += JSON.stringify({
    workflow_id: workflowId,
    verify_command: 'npx tsc --noEmit && npx vitest run',
    auto_commit: true,
    commit_message: `feat: add ${featureName} + batch tests`,
    auto_push: false,
  }, null, 2);
  output += '\n```\n';
  output += `\nOr use \`workflow_status\` to check progress: \`workflow_status({ workflow_id: "${workflowId}" })\`\n`;

  return {
    content: [{ type: 'text', text: output }],
    _workflow_id: workflowId,
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

// ─── Feature 10: Detect File Conflicts ───────────────────────────────────────

function handleDetectFileConflicts(args) {
  const workflowId = args.workflow_id;
  if (!workflowId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required');
  }

  const workflow = workflowEngine().getWorkflow(workflowId);
  if (!workflow) {
    return makeError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow not found: ${workflowId}`);
  }

  const status = workflowEngine().getWorkflowStatus(workflowId);
  if (!status) {
    return makeError(ErrorCodes.OPERATION_FAILED, 'Could not get workflow status');
  }

  const workingDir = args.working_directory || workflow.working_directory;
  const tasks = Object.values(status.tasks || {});
  const completedTasks = tasks.filter(t => t.status === 'completed');

  let output = `## File Conflict Detection: ${status.name}\n\n`;
  output += `**Completed tasks:** ${completedTasks.length}/${tasks.length}\n\n`;

  // Get files modified by each task using git
  const taskFiles = new Map(); // taskId -> Set<filePath>
  const fileModifiers = new Map(); // filePath -> [taskNodeIds]

  for (const task of completedTasks) {
    const taskId = task.id;
    const nodeId = task.node_id || taskId.substring(0, 8);

    // Check task result for files_modified
    const fullTask = taskCore().getTask(taskId);
    if (!fullTask) continue;

    const modifiedFiles = new Set();

    // Try parsing files_modified from task
    if (fullTask.files_modified) {
      try {
        const files = JSON.parse(fullTask.files_modified);
        if (Array.isArray(files)) {
          for (const f of files) {
            const normalized = (typeof f === 'string' ? f : f.path || '').replace(/\\/g, '/');
            if (normalized) modifiedFiles.add(normalized);
          }
        }
      } catch (err) {
        logger.debug('[automation-batch-orchestration] non-critical error normalizing modified file list:', err.message || err);
      }
    }

    // Also try git diff between task's before/after SHAs
    if (fullTask.git_before_sha && fullTask.git_after_sha && workingDir) {
      try {
        // Validate SHAs are hex-only to prevent shell injection
        const shaPattern = /^[0-9a-fA-F]{6,40}$/;
        if (!shaPattern.test(fullTask.git_before_sha) || !shaPattern.test(fullTask.git_after_sha)) {
          logger.debug('[automation-batch-orchestration] skipping file diff due to invalid git SHA format:', fullTask.git_before_sha, fullTask.git_after_sha);
          continue;
        }
        const diff = executeValidatedCommandSync('git', ['diff', '--name-only', fullTask.git_before_sha, fullTask.git_after_sha], {
          profile: 'safe_verify',
          source: 'detect_file_conflicts',
          caller: 'handleDetectFileConflicts',
          cwd: workingDir,
          timeout: TASK_TIMEOUTS.GIT_STATUS,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        if (diff) {
          for (const f of diff.split('\n')) {
            modifiedFiles.add(f.replace(/\\/g, '/'));
          }
        }
      } catch (err) {
        logger.debug('[automation-batch-orchestration] non-critical error reading git diff for task:', err.message || err);
      }
    }

    taskFiles.set(nodeId, modifiedFiles);

    for (const file of modifiedFiles) {
      if (!fileModifiers.has(file)) {
        fileModifiers.set(file, []);
      }
      fileModifiers.get(file).push(nodeId);
    }
  }

  // Find conflicts (files modified by 2+ tasks)
  const conflicts = [];
  for (const [file, modifiers] of fileModifiers) {
    if (modifiers.length > 1) {
      conflicts.push({ file, tasks: modifiers });
    }
  }

  if (conflicts.length === 0) {
    output += '### Result: No Conflicts\n\n';
    output += 'No files were modified by multiple tasks.\n';

    // Show file summary
    output += '\n### Files Modified\n\n';
    output += '| Task | Files |\n|------|-------|\n';
    for (const [nodeId, files] of taskFiles) {
      output += `| ${nodeId} | ${files.size > 0 ? [...files].join(', ') : '(none tracked)'} |\n`;
    }
  } else {
    output += `### Result: ${conflicts.length} Potential Conflict${conflicts.length !== 1 ? 's' : ''}\n\n`;
    output += '| File | Modified By |\n|------|------------|\n';
    for (const conflict of conflicts) {
      output += `| ${conflict.file} | ${conflict.tasks.join(', ')} |\n`;
    }

    // Check for actual syntax errors in conflicted files
    if (workingDir) {
      output += '\n### Syntax Check\n\n';
      try {
        executeValidatedCommandSync('npx', ['tsc', '--noEmit'], {
          profile: 'safe_verify',
          source: 'detect_file_conflicts',
          caller: 'handleDetectFileConflicts',
          cwd: workingDir,
          timeout: TASK_TIMEOUTS.TEST_RUN,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
        output += 'TypeScript compilation: **PASSED** (no errors)\n';
      } catch (err) {
        const stderr = (err.stdout || '') + '\n' + (err.stderr || '');
        const errorCount = (stderr.match(/error TS/g) || []).length;
        output += `TypeScript compilation: **FAILED** (${errorCount} errors)\n\n`;

        // Show errors only for conflicted files
        for (const conflict of conflicts) {
          const fileErrors = stderr.split('\n').filter(l => l.includes(conflict.file) && /error TS/.test(l));
          if (fileErrors.length > 0) {
            output += `**${conflict.file}:**\n`;
            for (const e of fileErrors.slice(0, 5)) {
              output += `  ${e.trim()}\n`;
            }
            output += '\n';
          }
        }

        output += 'Use `auto_verify_and_fix` to auto-submit fix tasks.\n';
      }
    }
  }

  return { content: [{ type: 'text', text: output }] };
}

// ─── Feature 11: Auto Commit Batch ───────────────────────────────────────────
// Extracted to ./auto-commit-batch.js

autoCommitBatch.init({
  resolveTrackedCommitFiles,
  getFallbackCommitFiles,
});
const { handleAutoCommitBatch } = autoCommitBatch;

function createAutomationBatchOrchestration() {
  return {
    handleGenerateFeatureTasks,
    handleRunBatch,
    handleDetectFileConflicts,
    handleAutoCommitBatch,
  };
}

module.exports = {
  handleGenerateFeatureTasks,
  handleRunBatch,
  handleDetectFileConflicts,
  handleAutoCommitBatch,
  createAutomationBatchOrchestration,
};
