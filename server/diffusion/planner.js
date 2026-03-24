'use strict';

const logger = require('../logger').child({ component: 'diffusion-planner' });

const CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_BATCH_SIZE = 1;

function selectConvergenceStrategy(isolationConfidence, sharedDependencies) {
  if (!Array.isArray(sharedDependencies)) sharedDependencies = [];

  if (sharedDependencies.length > 0) return 'dag';
  if (typeof isolationConfidence !== 'number') return 'dag';
  if (isolationConfidence >= CONFIDENCE_THRESHOLD) return 'optimistic';
  return 'dag';
}

function groupManifestByPattern(manifest) {
  const groups = new Map();
  for (const entry of manifest) {
    const key = entry.pattern;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

function createBatches(entries, batchSize) {
  const size = batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;
  const batches = [];
  for (let i = 0; i < entries.length; i += size) {
    batches.push(entries.slice(i, i + size));
  }
  return batches;
}

function expandTaskDescription(pattern, files, workingDirectory) {
  const fileList = files.map(f => `- ${f}`).join('\n');

  // v2: embed full before/after exemplar content for unambiguous pattern matching
  if (pattern.exemplar_before && pattern.exemplar_after) {
    return `Apply the following transformation to the files listed below.

## Pattern
${pattern.description}

## Exemplar — BEFORE (exact file content)
\`\`\`
${pattern.exemplar_before}
\`\`\`

## Exemplar — AFTER (exact file content)
\`\`\`
${pattern.exemplar_after}
\`\`\`

## Your files to modify
${fileList}

Match the exemplar's exact calling conventions, parameter order,
import statements, and code style. Do NOT deviate from the pattern
shown in the exemplar.

Working directory: ${workingDirectory}`;
  }

  // v1 fallback: description + transformation only
  return `Apply the following transformation to the file(s) listed below.

Pattern: ${pattern.description}
Transformation: ${pattern.transformation}

Files to modify:
${fileList}

Reference: see exemplar diff for pattern "${pattern.id}" for the exact before/after.

Working directory: ${workingDirectory}`;
}

function buildWorkflowTasks(plan, options = {}) {
  const {
    batchSize = plan.recommended_batch_size || DEFAULT_BATCH_SIZE,
    workingDirectory,
    provider,
    convergence,
    depth = 0,
    verifyCommand,
  } = options;

  const strategy = convergence || selectConvergenceStrategy(
    plan.isolation_confidence,
    plan.shared_dependencies,
  );

  const patternMap = new Map();
  for (const p of plan.patterns) {
    patternMap.set(p.id, p);
  }

  const grouped = groupManifestByPattern(plan.manifest);
  const tasks = [];

  // For DAG mode, create anchor tasks for shared dependencies first
  const anchorTaskIds = [];
  if (strategy === 'dag' && Array.isArray(plan.shared_dependencies)) {
    for (const dep of plan.shared_dependencies) {
      if (!dep.file) continue;
      const anchorId = `anchor-${anchorTaskIds.length}`;
      tasks.push({
        id: anchorId,
        description: `Update shared dependency: ${dep.file}\n\nChange: ${dep.change || 'Update as needed for the transformation'}`,
        depends_on: [],
        working_directory: workingDirectory,
        provider: provider || null,
        metadata: { diffusion: true, diffusion_role: 'anchor', depth },
      });
      anchorTaskIds.push(anchorId);
    }
  }

  // Create fan-out tasks from manifest batches
  for (const [patternId, entries] of grouped) {
    const pattern = patternMap.get(patternId);
    if (!pattern) {
      logger.warn(`[DiffusionPlanner] Pattern ${patternId} not found, skipping ${entries.length} manifest entries`);
      continue;
    }

    const batches = createBatches(entries, batchSize);
    for (const batch of batches) {
      const files = batch.map(e => e.file);
      const taskId = `fanout-${tasks.length}`;
      tasks.push({
        id: taskId,
        description: expandTaskDescription(pattern, files, workingDirectory),
        depends_on: strategy === 'dag' ? [...anchorTaskIds] : [],
        working_directory: workingDirectory,
        provider: provider || null,
        metadata: {
          diffusion: true,
          diffusion_role: 'fanout',
          pattern_id: patternId,
          files,
          depth,
          auto_verify_on_completion: true,
          verify_command: verifyCommand,
        },
      });
    }
  }

  return {
    strategy,
    tasks,
    summary: plan.summary,
    exemplars: plan.patterns.reduce((acc, p) => {
      acc[p.id] = { exemplar_files: p.exemplar_files, exemplar_diff: p.exemplar_diff };
      return acc;
    }, {}),
  };
}

module.exports = {
  selectConvergenceStrategy,
  groupManifestByPattern,
  createBatches,
  expandTaskDescription,
  buildWorkflowTasks,
  CONFIDENCE_THRESHOLD,
  DEFAULT_BATCH_SIZE,
};
