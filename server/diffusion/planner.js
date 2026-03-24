'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'diffusion-planner' });

function readFileContents(files, workingDirectory) {
  const contents = {};
  for (const file of files) {
    try {
      const fullPath = path.resolve(workingDirectory, file);
      contents[file] = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      contents[file] = `(error reading file: ${err.message})`;
      logger.info(`[DiffusionPlanner] Failed to read ${file}: ${err.message}`);
    }
  }
  return contents;
}

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

function expandComputeTaskDescription(pattern, fileContents, workingDirectory) {
  const fileEntries = Object.entries(fileContents)
    .map(([file, content]) => `### File: ${file}\n\`\`\`\n${content}\n\`\`\``)
    .join('\n\n');

  return `Analyze the following file(s) and produce a JSON object with exact edit instructions
to apply the transformation described below.

## Transformation
Pattern: ${pattern.description}
Transformation: ${pattern.transformation}

## Exemplar — BEFORE
\`\`\`
${pattern.exemplar_before || '(not available)'}
\`\`\`

## Exemplar — AFTER
\`\`\`
${pattern.exemplar_after || '(not available)'}
\`\`\`

## File(s) to analyze
${fileEntries}

## Output Format
Output ONLY the JSON object below, no explanation, no code fences:
{
  "file_edits": [
    {
      "file": "exact/path/to/file.cs",
      "operations": [
        { "type": "replace", "old_text": "exact text to find", "new_text": "exact replacement text" }
      ]
    }
  ]
}

Each operation's old_text must be an EXACT substring of the file content (character-for-character match).
For deletions, set new_text to an empty string "".

## SAFETY RULES — Read carefully before producing edits

1. **SKIP files where the class already extends a concrete base class** (e.g., Window, UserControl, Page, Control). C# does not support multiple inheritance. If the class declaration is "class Foo : Window" or "class Foo : SomeBaseClass", output an empty operations array for that file with a comment explaining why.

2. **Remove ALL related artifacts** when removing a method. If you remove SetProperty<T>, you MUST also:
   - Remove the OnPropertyChanged method (if it exists as a private/protected method)
   - Remove the "public event PropertyChangedEventHandler? PropertyChanged;" declaration
   - Remove "using System.ComponentModel;" ONLY if nothing else in the file uses types from that namespace (check for PropertyChangedEventHandler, INotifyPropertyChanged, PropertyChangedEventArgs references that will remain)
   - Remove "using System.Runtime.CompilerServices;" ONLY if nothing else uses [CallerMemberName] or other attributes from that namespace

3. **Check for custom logic in SetProperty** before removing it. If the SetProperty method contains logic BEYOND the standard pattern (e.g., additional PropertyChanged notifications, side effects, disposed guards, unsaved-change flags), you MUST:
   - Still remove the SetProperty method
   - BUT preserve the custom logic by adding it to the property setters that called SetProperty, or by adding an override/helper method
   - If the custom logic is too complex to preserve safely, output an empty operations array for that file with a comment

4. **Verify using statements** — after all edits, the file must still compile. Don't remove a using statement if any remaining code references types from that namespace.

Working directory: ${workingDirectory}`;
}

function expandApplyTaskDescription(computeOutput, workingDirectory) {
  const sections = [];

  for (const edit of computeOutput.file_edits) {
    sections.push(`### File: ${edit.file}`);
    for (const op of edit.operations) {
      if (op.new_text === undefined && op.new_text !== '') {
        continue;
      }
      if (op.new_text === '') {
        sections.push(`**DELETE** the following block:\n\`\`\`\n${op.old_text}\n\`\`\``);
      } else {
        sections.push(`**Replace:**\n\`\`\`\n${op.old_text}\n\`\`\`\n**With:**\n\`\`\`\n${op.new_text}\n\`\`\``);
      }
    }
  }

  return `Apply the following pre-computed edits to the specified files.
These edits were pre-computed by an analysis step. Apply them exactly
as specified — do not modify, reformat, or add anything beyond what
is listed. If a text block is not found in the file, try with
normalized whitespace (trim trailing spaces, normalize line endings)
before reporting failure.

${sections.join('\n\n')}

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
    computeProvider,
    applyProvider,
    applyProviders,
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

    const isComputePipeline = !!computeProvider;
    const batches = createBatches(entries, batchSize);
    for (const batch of batches) {
      const files = batch.map(e => e.file);
      const role = isComputePipeline ? 'compute' : 'fanout';
      const taskProvider = isComputePipeline ? computeProvider : (provider || null);
      const taskId = `${role}-${tasks.length}`;
      tasks.push({
        id: taskId,
        description: isComputePipeline
          ? expandComputeTaskDescription(
              pattern,
              readFileContents(files, workingDirectory),
              workingDirectory,
            )
          : expandTaskDescription(pattern, files, workingDirectory),
        depends_on: strategy === 'dag' ? [...anchorTaskIds] : [],
        working_directory: workingDirectory,
        provider: taskProvider,
        metadata: {
          diffusion: true,
          diffusion_role: role,
          pattern_id: patternId,
          files,
          depth,
          ...(isComputePipeline ? {
            apply_provider: applyProvider || 'ollama',
            apply_providers: applyProviders || [applyProvider || 'ollama'],
            verify_command: verifyCommand || null,
          } : {}),
          ...(verifyCommand ? { auto_verify_on_completion: true, verify_command: verifyCommand } : {}),
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
  expandComputeTaskDescription,
  expandApplyTaskDescription,
  buildWorkflowTasks,
  CONFIDENCE_THRESHOLD,
  DEFAULT_BATCH_SIZE,
};
