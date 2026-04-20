/**
 * Batch orchestration handlers for TORQUE.
 * Extracted from automation-handlers.js - Part 2 decomposition.
 *
 * Contains:
 * - generate_feature_tasks - generate project-agnostic feature workflow tasks
 * - run_batch - generate tasks, create a workflow, and start it
 * - detect_file_conflicts - post-workflow file conflict detection
 * - auto_commit_batch - verify + commit + push in one call
 */

const path = require('path');
const { TASK_TIMEOUTS } = require('../constants');
const { executeValidatedCommandSync } = require('../execution/command-policy');
const { ErrorCodes, makeError, isPathTraversalSafe } = require('./shared');
const logger = require('../logger').child({ component: 'automation-batch' });
const autoCommitBatch = require('./auto-commit-batch');

// Lazy-load to avoid circular deps
let _taskCore;
function taskCore() { return _taskCore || (_taskCore = require('../db/task-core')); }
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

function toFeatureSlug(featureName) {
  return featureName
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function getOptionalSpec(args, key) {
  return typeof args[key] === 'string' ? args[key].trim() : '';
}

function buildFeatureContext(featureName, featureSlug, description) {
  const lines = [
    `Feature: ${featureName}`,
    `Feature slug: ${featureSlug}`,
  ];
  if (description) {
    lines.push(`Description: ${description}`);
  }
  return lines.join('\n');
}

// Feature task prompt generation

function handleGenerateFeatureTasks(args) {
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const featureName = args.feature_name;
  if (!featureName) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'feature_name is required');
  }

  const name = featureName.trim();
  const description = getOptionalSpec(args, 'feature_description');
  const kebab = toFeatureSlug(name);
  const context = buildFeatureContext(name, kebab, description);
  const typesSpec = getOptionalSpec(args, 'types_spec');
  const eventsSpec = getOptionalSpec(args, 'events_spec');
  const dataSpec = getOptionalSpec(args, 'data_spec');
  const systemSpec = getOptionalSpec(args, 'system_spec');
  const tasks = {};

  tasks.types = `Define or update the data contracts for the ${name} feature.

${context}

${typesSpec ? `Required contracts:\n${typesSpec}` : `Infer the necessary interfaces, schemas, enums, request/response shapes, or configuration contracts from the feature description and existing project conventions.`}

Acceptance criteria:
- Follow the repository's current file layout, naming, and export style.
- Use the feature slug "${kebab}" where a new path or identifier needs a stable slug.
- Avoid placeholder fields, unused abstractions, or project-specific assumptions.`;

  tasks.events = `Define or update integration events, messages, API payloads, callbacks, or command contracts for the ${name} feature.

${context}

${eventsSpec ? `Required integration surface:\n${eventsSpec}` : `Inspect the existing integration surface and add only the contracts needed for this feature. If this project does not use events or messages, update the closest equivalent integration point.`}

Acceptance criteria:
- Preserve existing public contracts unless the feature explicitly requires a compatible extension.
- Keep payloads typed or validated using the project's existing mechanism.
- Include enough context for downstream implementation and tests.`;

  tasks.data = `Add or update the persisted data, configuration, fixtures, seeds, migrations, or static resources required by the ${name} feature.

${context}

${dataSpec ? `Required data work:\n${dataSpec}` : `Inspect existing data and configuration patterns before deciding whether this step needs new files, updated fixtures, migrations, or documentation-backed defaults.`}

Acceptance criteria:
- Keep generated or seed data deterministic and reviewable.
- Validate migrations, fixture shapes, or configuration defaults with existing project tooling where applicable.
- Do not add sample data that is unrelated to the requested feature.`;

  tasks.system = `Implement the runtime behavior for the ${name} feature in the appropriate project layer.

${context}

${systemSpec ? `Required behavior:\n${systemSpec}` : `Implement the feature using the repository's established service, handler, UI, worker, or domain-module patterns. Keep the change scoped to the requested behavior.`}

Acceptance criteria:
- Reuse existing helpers and boundaries before adding new abstractions.
- Add defensive input handling and clear error paths consistent with adjacent code.
- Keep public behavior traceable to the feature description and contracts.`;

  tasks.tests = `Add or update tests for the ${name} feature.

${context}

Test the following areas:
1. Contract or schema behavior introduced by the feature.
2. Main success paths and failure paths.
3. Data, configuration, or migration behavior when applicable.
4. Integration behavior across the touched project boundaries.
5. Regression coverage for edge cases identified during implementation.

Acceptance criteria:
- Use the repository's existing test framework and fixture style.
- Keep tests deterministic and isolated from external services unless the project already provides a controlled harness.
- Cover behavior rather than implementation details where practical.`;

  let output = `## Generated Task Descriptions: ${name}\n\n`;
  output += `**Feature:** ${name}\n`;
  output += `**Feature slug:** ${kebab}\n`;
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

// Batch workflow orchestration

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
    const defaultProvider = typeof args.provider === 'string' && args.provider.trim()
      ? args.provider.trim()
      : undefined;
    const batchName = args.batch_name || `Batch - ${featureName}`;

    // Merge saved step_providers with per-call overrides (per-call wins)
    const project = projectConfigCore().getProjectFromPath(workingDir);
    const savedStepProviders = (() => {
      try { return JSON.parse(projectConfigCore().getProjectMetadata(project, 'step_providers') || '{}'); }
      catch { return {}; }
    })();
    const supportedStepProviderKeys = new Set(['types', 'events', 'data', 'system', 'tests', 'parallel']);
    const stepProviders = {};
    for (const [step, provider] of Object.entries({ ...savedStepProviders, ...(args.step_providers || {}) })) {
      if (supportedStepProviderKeys.has(step) && typeof provider === 'string' && provider.trim()) {
        stepProviders[step] = provider.trim();
      }
    }
    if (defaultProvider) {
      for (const step of supportedStepProviderKeys) {
        if (!stepProviders[step]) {
          stepProviders[step] = defaultProvider;
        }
      }
    }

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

    const kebab = toFeatureSlug(featureName);
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
  }
}

// File conflict detection

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

// Auto commit batch
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
