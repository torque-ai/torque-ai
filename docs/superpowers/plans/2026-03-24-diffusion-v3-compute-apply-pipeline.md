# Diffusion v3: Compute→Apply Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split diffusion fan-out tasks into a compute stage (fast free providers produce structured edit JSON) and an apply stage (filesystem providers mechanically execute the edits), with close-handler validation and dynamic apply task creation between them.

**Architecture:** The planner creates compute-only tasks with file content embedded directly. When a compute task completes, a close-handler hook extracts and validates the JSON edit instructions, then dynamically creates an apply task on a filesystem-capable provider. The apply task is trivial — just execute pre-computed replacements.

**Tech Stack:** Node.js, Vitest, existing TORQUE infrastructure (task-finalizer, workflow-engine, planner)

**Spec:** `docs/superpowers/specs/2026-03-24-diffusion-v3-compute-apply-pipeline-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/diffusion/compute-output-parser.js` | **NEW** — Extract JSON from compute output, strip fences, validate schema |
| `server/diffusion/planner.js` | **MODIFY** — Add `expandComputeTaskDescription`, `expandApplyTaskDescription`, `buildComputeApplyPipeline` |
| `server/handlers/diffusion-handlers.js` | **MODIFY** — Add `compute_provider`/`apply_provider` options, pipeline selection logic |
| `server/tool-defs/diffusion-defs.js` | **MODIFY** — Add `compute_provider`/`apply_provider` to schema |
| `server/execution/task-finalizer.js` | **MODIFY** — Add compute→apply close-handler hook |
| `server/tests/diffusion-compute-output-parser.test.js` | **NEW** — Tests for JSON extraction + validation |
| `server/tests/diffusion-planner.test.js` | **MODIFY** — Tests for compute/apply task generation |
| `server/tests/diffusion-handlers.test.js` | **MODIFY** — Tests for pipeline selection |

---

## Task 1: Compute Output Parser

**Files:**
- Create: `server/diffusion/compute-output-parser.js`
- Test: `server/tests/diffusion-compute-output-parser.test.js`

- [x] **Step 1: Write failing tests**

```js
// server/tests/diffusion-compute-output-parser.test.js
import { describe, it, expect } from 'vitest';
const { parseComputeOutput, validateComputeSchema } = require('../diffusion/compute-output-parser');

describe('parseComputeOutput', () => {
  it('extracts clean JSON', () => {
    const output = JSON.stringify({
      file_edits: [{ file: 'a.cs', operations: [{ type: 'replace', old_text: 'old', new_text: 'new' }] }]
    });
    const result = parseComputeOutput(output);
    expect(result).not.toBeNull();
    expect(result.file_edits).toHaveLength(1);
  });

  it('extracts JSON wrapped in markdown fences', () => {
    const json = JSON.stringify({
      file_edits: [{ file: 'a.cs', operations: [{ type: 'replace', old_text: 'x', new_text: 'y' }] }]
    });
    const output = `Here are the edits:\n\`\`\`json\n${json}\n\`\`\`\nDone!`;
    const result = parseComputeOutput(output);
    expect(result).not.toBeNull();
    expect(result.file_edits[0].file).toBe('a.cs');
  });

  it('extracts JSON with conversational prefix/suffix', () => {
    const json = JSON.stringify({
      file_edits: [{ file: 'b.cs', operations: [{ type: 'replace', old_text: 'a', new_text: 'b' }] }]
    });
    const output = `I analyzed the files. Here is the result:\n${json}\nLet me know if you need changes.`;
    const result = parseComputeOutput(output);
    expect(result).not.toBeNull();
    expect(result.file_edits[0].file).toBe('b.cs');
  });

  it('returns null for unparseable output', () => {
    expect(parseComputeOutput('just some text, no json')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(parseComputeOutput('')).toBeNull();
    expect(parseComputeOutput(null)).toBeNull();
  });
});

describe('validateComputeSchema', () => {
  it('accepts valid compute output', () => {
    const data = {
      file_edits: [{
        file: 'a.cs',
        operations: [
          { type: 'replace', old_text: 'old code', new_text: 'new code' },
          { type: 'replace', old_text: 'delete this', new_text: '' },
        ]
      }]
    };
    const result = validateComputeSchema(data);
    expect(result.valid).toBe(true);
  });

  it('rejects missing file_edits', () => {
    const result = validateComputeSchema({ something_else: true });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('file_edits'));
  });

  it('rejects operations missing old_text', () => {
    const data = {
      file_edits: [{ file: 'a.cs', operations: [{ type: 'replace', new_text: 'x' }] }]
    };
    const result = validateComputeSchema(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('old_text'));
  });

  it('rejects empty file_edits array', () => {
    const result = validateComputeSchema({ file_edits: [] });
    expect(result.valid).toBe(false);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/diffusion-compute-output-parser.test.js`
Expected: FAIL — module not found

- [x] **Step 3: Implement compute-output-parser.js**

```js
// server/diffusion/compute-output-parser.js
'use strict';

const logger = require('../logger').child({ component: 'compute-output-parser' });

function parseComputeOutput(output) {
  if (!output || typeof output !== 'string') return null;

  const trimmed = output.trim();
  if (!trimmed) return null;

  // Try 1: Direct JSON parse
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && parsed.file_edits) return parsed;
  } catch (_) { /* not clean JSON */ }

  // Try 2: Extract from markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && parsed.file_edits) return parsed;
    } catch (_) { /* fence content not valid JSON */ }
  }

  // Try 3: Find JSON object with file_edits key anywhere in output
  const jsonStart = trimmed.indexOf('{"file_edits"');
  if (jsonStart === -1) {
    // Try with whitespace after brace
    const altStart = trimmed.indexOf('{\n');
    if (altStart >= 0) {
      try {
        const candidate = trimmed.slice(altStart);
        // Find matching closing brace
        let depth = 0;
        let end = -1;
        for (let i = 0; i < candidate.length; i++) {
          if (candidate[i] === '{') depth++;
          if (candidate[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end > 0) {
          const parsed = JSON.parse(candidate.slice(0, end));
          if (parsed && parsed.file_edits) return parsed;
        }
      } catch (_) { /* not valid */ }
    }
    return null;
  }

  try {
    const candidate = trimmed.slice(jsonStart);
    let depth = 0;
    let end = -1;
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] === '{') depth++;
      if (candidate[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end > 0) {
      const parsed = JSON.parse(candidate.slice(0, end));
      if (parsed && parsed.file_edits) return parsed;
    }
  } catch (err) {
    logger.info(`[ComputeOutputParser] JSON extraction failed: ${err.message}`);
  }

  return null;
}

function validateComputeSchema(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Compute output must be a non-null object'] };
  }

  if (!Array.isArray(data.file_edits)) {
    errors.push('Missing required field: file_edits (must be an array)');
    return { valid: false, errors };
  }

  if (data.file_edits.length === 0) {
    errors.push('file_edits must not be empty');
    return { valid: false, errors };
  }

  for (let i = 0; i < data.file_edits.length; i++) {
    const edit = data.file_edits[i];
    if (!edit.file || typeof edit.file !== 'string') {
      errors.push(`file_edits[${i}]: missing or invalid file path`);
    }
    if (!Array.isArray(edit.operations) || edit.operations.length === 0) {
      errors.push(`file_edits[${i}]: missing or empty operations array`);
      continue;
    }
    for (let j = 0; j < edit.operations.length; j++) {
      const op = edit.operations[j];
      if (op.old_text === undefined || op.old_text === null) {
        errors.push(`file_edits[${i}].operations[${j}]: missing old_text`);
      }
      if (op.new_text === undefined && op.type !== 'delete') {
        errors.push(`file_edits[${i}].operations[${j}]: missing new_text`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { parseComputeOutput, validateComputeSchema };
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/diffusion-compute-output-parser.test.js`
Expected: PASS — all 9 tests green

- [x] **Step 5: Commit**

```bash
git add server/diffusion/compute-output-parser.js server/tests/diffusion-compute-output-parser.test.js
git commit -m "feat(diffusion): add compute output parser with JSON extraction and schema validation"
```

---

## Task 2: Compute and Apply Task Description Generators

**Files:**
- Modify: `server/diffusion/planner.js`
- Modify: `server/tests/diffusion-planner.test.js`

- [x] **Step 1: Write failing tests for compute/apply descriptions**

Add to `server/tests/diffusion-planner.test.js`:

```js
const {
  expandComputeTaskDescription,
  expandApplyTaskDescription,
} = require('../diffusion/planner');

describe('expandComputeTaskDescription', () => {
  it('embeds file content and exemplar in compute prompt', () => {
    const pattern = {
      id: 'p1',
      description: 'Remove SetProperty duplicate',
      transformation: 'Inherit from BindableBase',
      exemplar_before: 'class Foo : INotifyPropertyChanged { ... SetProperty ... }',
      exemplar_after: 'class Foo : BindableBase { ... }',
    };
    const fileContents = { 'a.cs': 'using System;\nclass A : INPC { SetProperty<T>... }' };
    const desc = expandComputeTaskDescription(pattern, fileContents, '/proj');
    expect(desc).toContain('class Foo : INotifyPropertyChanged');
    expect(desc).toContain('class Foo : BindableBase');
    expect(desc).toContain('class A : INPC');
    expect(desc).toContain('file_edits');
    expect(desc).toContain('Output ONLY the JSON');
  });
});

describe('expandApplyTaskDescription', () => {
  it('generates apply prompt from parsed compute output', () => {
    const computeOutput = {
      file_edits: [
        { file: 'a.cs', operations: [
          { type: 'replace', old_text: 'using System.ComponentModel;', new_text: '' },
          { type: 'replace', old_text: 'class A : INPC', new_text: 'class A : BindableBase' },
        ]}
      ]
    };
    const desc = expandApplyTaskDescription(computeOutput, '/proj');
    expect(desc).toContain('a.cs');
    expect(desc).toContain('using System.ComponentModel;');
    expect(desc).toContain('class A : BindableBase');
    expect(desc).toContain('DELETE');
    expect(desc).toContain('pre-computed');
  });

  it('uses DELETE instruction for empty new_text', () => {
    const computeOutput = {
      file_edits: [
        { file: 'b.cs', operations: [
          { type: 'replace', old_text: 'remove this line', new_text: '' },
        ]}
      ]
    };
    const desc = expandApplyTaskDescription(computeOutput, '/proj');
    expect(desc).toContain('DELETE');
    expect(desc).not.toContain('Replace with:');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/diffusion-planner.test.js`
Expected: FAIL — functions not exported

- [x] **Step 3: Add expandComputeTaskDescription to planner.js**

Add after the existing `expandTaskDescription` function:

```js
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
Working directory: ${workingDirectory}`;
}

function expandApplyTaskDescription(computeOutput, workingDirectory) {
  const sections = [];

  for (const edit of computeOutput.file_edits) {
    sections.push(`### File: ${edit.file}`);
    for (const op of edit.operations) {
      if (!op.new_text && op.new_text !== '') {
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
```

Add both to the `module.exports`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/diffusion-planner.test.js`
Expected: PASS — all tests green

- [x] **Step 5: Commit**

```bash
git add server/diffusion/planner.js server/tests/diffusion-planner.test.js
git commit -m "feat(diffusion): add compute and apply task description generators"
```

---

## Task 3: Pipeline Selection in buildWorkflowTasks

**Files:**
- Modify: `server/diffusion/planner.js`
- Modify: `server/tests/diffusion-planner.test.js`

- [x] **Step 1: Write failing test for compute→apply pipeline**

Add to `server/tests/diffusion-planner.test.js`:

```js
describe('buildWorkflowTasks with compute→apply pipeline', () => {
  const basePlan = {
    summary: 'Refactor ViewModels',
    patterns: [{
      id: 'p1', description: 'Remove SetProperty', transformation: 'Use BindableBase',
      exemplar_files: ['ex.cs'], exemplar_diff: 'diff',
      exemplar_before: 'class Before {}', exemplar_after: 'class After {}',
      file_count: 3,
    }],
    manifest: [
      { file: 'a.cs', pattern: 'p1' },
      { file: 'b.cs', pattern: 'p1' },
      { file: 'c.cs', pattern: 'p1' },
    ],
    shared_dependencies: [],
    estimated_subtasks: 3,
    isolation_confidence: 0.95,
  };

  it('creates compute tasks when compute_provider is set', () => {
    const result = buildWorkflowTasks(basePlan, {
      workingDirectory: '/proj',
      computeProvider: 'cerebras',
      applyProvider: 'ollama',
    });
    expect(result.strategy).toBe('optimistic');
    const computeTasks = result.tasks.filter(t => t.metadata.diffusion_role === 'compute');
    expect(computeTasks.length).toBeGreaterThan(0);
    expect(computeTasks[0].provider).toBe('cerebras');
    expect(computeTasks[0].metadata.apply_provider).toBe('ollama');
  });

  it('falls back to single-stage when no compute_provider', () => {
    const result = buildWorkflowTasks(basePlan, { workingDirectory: '/proj' });
    const computeTasks = result.tasks.filter(t => t.metadata.diffusion_role === 'compute');
    expect(computeTasks).toHaveLength(0);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

- [x] **Step 3: Add pipeline selection to buildWorkflowTasks**

In `buildWorkflowTasks`, add `computeProvider` and `applyProvider` to destructured options. After the existing fan-out loop, add a conditional: if `computeProvider` is set, replace the fan-out tasks with compute tasks that have `diffusion_role: 'compute'`, `provider: computeProvider`, and `metadata.apply_provider = applyProvider`. The compute task descriptions use `expandComputeTaskDescription`. The apply tasks will be created dynamically by the close-handler (not by the planner).

Read the file first, then modify the `buildWorkflowTasks` function to check for `computeProvider` and branch accordingly.

- [x] **Step 4: Run tests to verify they pass**

- [x] **Step 5: Commit**

```bash
git add server/diffusion/planner.js server/tests/diffusion-planner.test.js
git commit -m "feat(diffusion): add compute→apply pipeline selection to planner"
```

---

## Task 4: Tool Schema + Handler Updates

**Files:**
- Modify: `server/tool-defs/diffusion-defs.js`
- Modify: `server/handlers/diffusion-handlers.js`
- Modify: `server/tests/diffusion-handlers.test.js`

- [x] **Step 1: Add compute_provider and apply_provider to tool schema**

In `server/tool-defs/diffusion-defs.js`, add to `create_diffusion_plan` inputSchema properties:

```js
        compute_provider: { type: 'string', description: 'Provider for compute stage (reasoning, no filesystem). E.g., "cerebras", "groq". If set, enables compute→apply pipeline.' },
        apply_provider: { type: 'string', description: 'Provider for apply stage (filesystem access). E.g., "ollama", "codex". Default: smart routing.' },
```

- [x] **Step 2: Write failing handler test**

Add to `server/tests/diffusion-handlers.test.js`:

```js
describe('compute→apply pipeline', () => {
  it('passes compute_provider to buildWorkflowTasks', () => {
    const plan = {
      summary: 'Test',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.9,
    };
    const result = handlers.handleCreateDiffusionPlan({
      plan,
      working_directory: '/proj',
      verify_command: 'echo ok',
      compute_provider: 'cerebras',
      apply_provider: 'ollama',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Workflow ID');
  });
});
```

- [x] **Step 3: Update handleCreateDiffusionPlan**

Read `server/handlers/diffusion-handlers.js`. Add `compute_provider` and `apply_provider` to destructured args. Pass them to `buildWorkflowTasks` as `computeProvider` and `applyProvider`.

- [x] **Step 4: Run tests**

Run: `npx vitest run server/tests/diffusion-handlers.test.js`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add server/tool-defs/diffusion-defs.js server/handlers/diffusion-handlers.js server/tests/diffusion-handlers.test.js
git commit -m "feat(diffusion): add compute_provider/apply_provider to create_diffusion_plan"
```

---

## Task 5: Close-Handler Hook for Compute→Apply

**Files:**
- Modify: `server/execution/task-finalizer.js`
- Test: `server/tests/diffusion-compute-apply-hook.test.js`

- [x] **Step 1: Write tests for the close-handler hook**

```js
// server/tests/diffusion-compute-apply-hook.test.js
import { describe, it, expect } from 'vitest';
const { parseComputeOutput, validateComputeSchema } = require('../diffusion/compute-output-parser');
const { expandApplyTaskDescription } = require('../diffusion/planner');

describe('compute→apply close-handler hook (unit)', () => {
  it('full pipeline: parse output → validate → generate apply description', () => {
    const computeOutput = JSON.stringify({
      file_edits: [{
        file: 'src/Foo.cs',
        operations: [
          { type: 'replace', old_text: 'class Foo : INPC', new_text: 'class Foo : BindableBase' },
          { type: 'replace', old_text: 'private bool SetProperty<T>(...) { ... }', new_text: '' },
        ]
      }]
    });

    const parsed = parseComputeOutput(computeOutput);
    expect(parsed).not.toBeNull();

    const validation = validateComputeSchema(parsed);
    expect(validation.valid).toBe(true);

    const applyDesc = expandApplyTaskDescription(parsed, '/proj');
    expect(applyDesc).toContain('src/Foo.cs');
    expect(applyDesc).toContain('class Foo : BindableBase');
    expect(applyDesc).toContain('DELETE');
  });

  it('rejects invalid compute output gracefully', () => {
    const parsed = parseComputeOutput('not json at all');
    expect(parsed).toBeNull();
  });

  it('rejects compute output with missing operations', () => {
    const parsed = parseComputeOutput(JSON.stringify({ file_edits: [{ file: 'a.cs' }] }));
    if (parsed) {
      const validation = validateComputeSchema(parsed);
      expect(validation.valid).toBe(false);
    }
  });
});
```

- [x] **Step 2: Run tests**

Run: `npx vitest run server/tests/diffusion-compute-apply-hook.test.js`
Expected: PASS (these test the existing parser + planner functions)

- [x] **Step 3: Add the close-handler hook to task-finalizer.js**

Read `server/execution/task-finalizer.js`. Find the `handleDiffusionSignalDetection` function (added in v1). After it, add a new function:

```js
function handleComputeApplyCreation(ctx) {
  try {
    const task = deps.db.getTask(ctx.taskId);
    const meta = task?.metadata
      ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata)
      : {};

    if (meta.diffusion_role !== 'compute' || ctx.status !== 'completed') return;

    const { parseComputeOutput, validateComputeSchema } = require('../diffusion/compute-output-parser');
    const { expandApplyTaskDescription } = require('../diffusion/planner');

    const parsed = parseComputeOutput(ctx.output || '');
    if (!parsed) {
      logger.info(`[Diffusion] Compute task ${ctx.taskId} produced unparseable output — marking failed`);
      if (typeof deps.db.updateTaskStatus === 'function') {
        deps.db.updateTaskStatus(ctx.taskId, 'failed');
      }
      ctx.status = 'failed';
      return;
    }

    const validation = validateComputeSchema(parsed);
    if (!validation.valid) {
      logger.info(`[Diffusion] Compute task ${ctx.taskId} schema invalid: ${validation.errors.join('; ')}`);
      if (typeof deps.db.updateTaskStatus === 'function') {
        deps.db.updateTaskStatus(ctx.taskId, 'failed');
      }
      ctx.status = 'failed';
      return;
    }

    // Create the apply task dynamically
    const applyProvider = meta.apply_provider || 'ollama';
    const workingDir = task.working_directory;
    const applyDesc = expandApplyTaskDescription(parsed, workingDir);
    const applyId = require('uuid').v4();

    deps.db.createTask({
      id: applyId,
      status: 'queued',
      task_description: applyDesc,
      working_directory: workingDir,
      workflow_id: task.workflow_id,
      provider: applyProvider,
      metadata: JSON.stringify({
        diffusion: true,
        diffusion_role: 'apply',
        compute_task_id: ctx.taskId,
        compute_output: parsed,
        auto_verify_on_completion: true,
        verify_command: meta.verify_command || null,
      }),
    });

    logger.info(`[Diffusion] Created apply task ${applyId} from compute ${ctx.taskId} (${parsed.file_edits.length} file edits)`);

    // Start the apply task
    try {
      const taskManager = require('../task-manager');
      taskManager.startTask(applyId);
    } catch (err) {
      logger.info(`[Diffusion] Failed to auto-start apply task ${applyId}: ${err.message}`);
    }
  } catch (err) {
    logger.debug(`[Diffusion] Compute→apply hook non-critical error: ${err.message}`);
  }
}
```

Then add the `runStage` call in the pipeline — after `diffusion_signal_detection` (Phase 2.5) and before `fuzzy_repair`:

```js
    await runStage(ctx, 'compute_apply_creation', handleComputeApplyCreation, ctx.code === 0);
```

- [x] **Step 4: Verify server loads**

Run: `node -e "require('./server/execution/task-finalizer'); console.log('OK')"`

- [x] **Step 5: Commit**

```bash
git add server/execution/task-finalizer.js server/tests/diffusion-compute-apply-hook.test.js
git commit -m "feat(diffusion): add compute→apply close-handler hook for dynamic apply task creation"
```

---

## Task 6: Final Verification

- [ ] **Step 1: Run all diffusion tests**

Run: `npx vitest run server/tests/diffusion-*.test.js`
Expected: All test files pass

- [ ] **Step 2: Verify module loading**

Run: `node -e "require('./server/tools'); require('./server/execution/process-streams'); require('./server/execution/task-finalizer'); require('./server/diffusion/compute-output-parser'); console.log('All OK')"`

- [ ] **Step 3: Commit any cleanup**

```bash
git add -A && git commit -m "chore(diffusion): v3 compute→apply pipeline final verification"
```
