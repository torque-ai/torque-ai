# Smart Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract auto-decomposition from routing.js into a provider-class-aware module that never decomposes for agentic providers and locks sub-tasks to the parent's resolved provider.

**Architecture:** New `server/execution/task-decomposition.js` module with provider class constants and decomposition logic extracted from routing.js. Called after `analyzeTaskForRouting()` resolves a provider. routing.js shrinks by ~280 lines.

**Tech Stack:** Node.js, vitest, existing host-complexity.js and task-manager.js helpers.

**Spec:** `docs/superpowers/specs/2026-04-05-smart-decomposition-design.md`

---

### Task 1: Create task-decomposition.js with provider classes and shouldDecompose

**Files:**
- Create: `server/execution/task-decomposition.js`
- Test: `server/tests/task-decomposition.test.js`

- [ ] **Step 1: Write failing tests for provider classes and shouldDecompose**

Create `server/tests/task-decomposition.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');

describe('task-decomposition', () => {
  let mod;

  beforeEach(() => {
    mod = require('../execution/task-decomposition');
  });

  afterEach(() => {
    const resolved = require.resolve('../execution/task-decomposition');
    delete require.cache[resolved];
  });

  describe('PROVIDER_CLASSES', () => {
    it('classifies codex as agentic', () => {
      expect(mod.PROVIDER_CLASSES.codex).toBe('agentic');
    });

    it('classifies codex-spark as agentic', () => {
      expect(mod.PROVIDER_CLASSES['codex-spark']).toBe('agentic');
    });

    it('classifies claude-cli as agentic', () => {
      expect(mod.PROVIDER_CLASSES['claude-cli']).toBe('agentic');
    });

    it('classifies ollama as guided', () => {
      expect(mod.PROVIDER_CLASSES.ollama).toBe('guided');
    });

    it('classifies cerebras as prompt-only', () => {
      expect(mod.PROVIDER_CLASSES.cerebras).toBe('prompt-only');
    });

    it('classifies all 12 providers', () => {
      expect(Object.keys(mod.PROVIDER_CLASSES)).toHaveLength(12);
    });
  });

  describe('getProviderClass', () => {
    it('returns agentic for codex', () => {
      expect(mod.getProviderClass('codex')).toBe('agentic');
    });

    it('returns guided for ollama', () => {
      expect(mod.getProviderClass('ollama')).toBe('guided');
    });

    it('returns prompt-only for unknown providers', () => {
      expect(mod.getProviderClass('unknown-provider')).toBe('prompt-only');
    });

    it('returns prompt-only for null', () => {
      expect(mod.getProviderClass(null)).toBe('prompt-only');
    });
  });

  describe('shouldDecompose', () => {
    it('returns false for agentic providers regardless of complexity', () => {
      const result = mod.shouldDecompose(
        { task: 'complex multi-file refactor', complexity: 'complex' },
        { provider: 'codex' }
      );
      expect(result.decompose).toBe(false);
      expect(result.reason).toContain('agentic');
    });

    it('returns false for prompt-only providers', () => {
      const result = mod.shouldDecompose(
        { task: 'refactor everything', complexity: 'complex' },
        { provider: 'cerebras' }
      );
      expect(result.decompose).toBe(false);
      expect(result.reason).toContain('prompt-only');
    });

    it('returns false for guided providers on small tasks', () => {
      const result = mod.shouldDecompose(
        { task: 'fix a bug in server/utils/helper.js', complexity: 'normal' },
        { provider: 'ollama' }
      );
      expect(result.decompose).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/task-decomposition.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the task-decomposition module**

Create `server/execution/task-decomposition.js`:

```js
'use strict';

/**
 * server/execution/task-decomposition.js
 *
 * Provider-class-aware task decomposition. Decides whether to split
 * a task into sub-tasks based on the resolved provider's capabilities.
 *
 * Called AFTER analyzeTaskForRouting() resolves a provider.
 * Agentic providers never decompose. Guided providers decompose
 * only for very large files. Prompt-only providers never decompose.
 */

const PROVIDER_CLASSES = Object.freeze({
  'codex':        'agentic',
  'codex-spark':  'agentic',
  'claude-cli':   'agentic',
  'ollama':       'guided',
  'ollama-cloud': 'prompt-only',
  'cerebras':     'prompt-only',
  'groq':         'prompt-only',
  'deepinfra':    'prompt-only',
  'google-ai':    'prompt-only',
  'openrouter':   'prompt-only',
  'hyperbolic':   'prompt-only',
  'anthropic':    'prompt-only',
});

const GUIDED_FILE_THRESHOLD = 1500;
const GUIDED_MIN_FUNCTIONS = 3;

function getProviderClass(provider) {
  if (!provider) return 'prompt-only';
  return PROVIDER_CLASSES[provider] || 'prompt-only';
}

/**
 * Determine whether a task should be decomposed based on provider class.
 *
 * @param {object} taskInfo - { task, complexity, files, working_directory }
 * @param {object} routingResult - { provider, model, ... } from analyzeTaskForRouting
 * @returns {{ decompose: boolean, reason: string, type?: 'csharp'|'js' }}
 */
function shouldDecompose(taskInfo, routingResult) {
  const providerClass = getProviderClass(routingResult.provider);

  if (providerClass === 'agentic') {
    return { decompose: false, reason: 'agentic provider handles full complexity natively' };
  }

  if (providerClass === 'prompt-only') {
    return { decompose: false, reason: 'prompt-only provider, decomposition not applicable' };
  }

  // guided provider — check if decomposition is warranted
  const { task, complexity, files } = taskInfo;

  // C# complex pattern check
  const isCSharpTask = /\.cs\b|c#|\.net|csproj|xaml|wpf|winui|maui|blazor|asp\.net|nuget/i.test(task || '') ||
    (files && files.some(f => /\.cs$|\.csproj$|\.xaml$|\.sln$/i.test(f)));

  if (complexity === 'complex' && isCSharpTask) {
    return { decompose: true, reason: 'guided provider + complex C# task', type: 'csharp' };
  }

  // JS/TS large file check — only for specific verb patterns
  const jsDecomposePatterns = /\b(jsdoc|add docs|add documentation|add logging|add error handling|refactor|cleanup|clean up|add types|add comments|lint fix|add tests for)\b/i;

  if (jsDecomposePatterns.test(task || '')) {
    return { decompose: true, reason: 'guided provider + JS/TS decompose pattern (file check deferred)', type: 'js' };
  }

  return { decompose: false, reason: 'guided provider within capability for this task' };
}

module.exports = {
  PROVIDER_CLASSES,
  GUIDED_FILE_THRESHOLD,
  GUIDED_MIN_FUNCTIONS,
  getProviderClass,
  shouldDecompose,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/task-decomposition.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/execution/task-decomposition.js server/tests/task-decomposition.test.js
git commit -m "feat: add task-decomposition module with provider classes and shouldDecompose"
```

---

### Task 2: Add decomposeTask function with sub-task inheritance

**Files:**
- Modify: `server/execution/task-decomposition.js`
- Modify: `server/tests/task-decomposition.test.js`

- [ ] **Step 1: Write failing tests for decomposeTask**

Add to `server/tests/task-decomposition.test.js`:

```js
  describe('decomposeTask', () => {
    it('locks sub-tasks to parent provider', () => {
      const result = mod.decomposeTask(
        { task: 'refactor server/big-file.js', working_directory: '/tmp/test', files: [] },
        { provider: 'ollama', model: 'qwen3-coder:30b' },
        {
          subtasks: ['Fix function A', 'Fix function B'],
          version_intent: 'fix',
          ui_review: false,
        }
      );

      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].provider).toBe('ollama');
      expect(result.tasks[0].model).toBe('qwen3-coder:30b');
      expect(result.tasks[0].version_intent).toBe('fix');
      expect(result.tasks[0].metadata.decomposed).toBe(true);
      expect(result.tasks[0].metadata.ui_review).toBe(false);
    });

    it('includes parent reference in sub-task metadata', () => {
      const result = mod.decomposeTask(
        { task: 'refactor', working_directory: '/tmp', files: [] },
        { provider: 'ollama' },
        { subtasks: ['A'], version_intent: 'fix', parent_task_id: 'parent-123', ui_review: false }
      );

      expect(result.tasks[0].metadata.parent_task_id).toBe('parent-123');
    });

    it('returns empty tasks array when no subtasks provided', () => {
      const result = mod.decomposeTask(
        { task: 'small fix', working_directory: '/tmp', files: [] },
        { provider: 'ollama' },
        { subtasks: [], version_intent: 'fix', ui_review: false }
      );

      expect(result.tasks).toHaveLength(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/task-decomposition.test.js`
Expected: FAIL — decomposeTask not defined

- [ ] **Step 3: Implement decomposeTask**

Add to `server/execution/task-decomposition.js` before `module.exports`:

```js
/**
 * Create sub-task definitions with inherited routing context.
 *
 * @param {object} taskInfo - { task, working_directory, files }
 * @param {object} routingResult - { provider, model, ... }
 * @param {object} options - { subtasks: string[], version_intent, parent_task_id, ui_review }
 * @returns {{ tasks: object[] }}
 */
function decomposeTask(taskInfo, routingResult, options) {
  const { subtasks = [], version_intent, parent_task_id, ui_review } = options;
  const { working_directory } = taskInfo;
  const { provider, model } = routingResult;

  const tasks = subtasks.map((description, index) => ({
    task: description,
    provider,
    model: model || null,
    working_directory,
    version_intent: version_intent || null,
    priority: 0,
    metadata: {
      decomposed: true,
      parent_task_id: parent_task_id || null,
      batch_index: index,
      ui_review: ui_review || false,
    },
  }));

  return { tasks };
}
```

Add `decomposeTask` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/task-decomposition.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/execution/task-decomposition.js server/tests/task-decomposition.test.js
git commit -m "feat: add decomposeTask with provider/model/metadata inheritance"
```

---

### Task 3: Wire task-decomposition into routing.js — replace C# decomposition

**Files:**
- Modify: `server/handlers/integration/routing.js:482-629`

- [ ] **Step 1: Read the current C# decomposition block**

Read `server/handlers/integration/routing.js` lines 482-629 to understand the full block that needs replacing.

- [ ] **Step 2: Import task-decomposition at the top of routing.js**

Near the other requires at the top of `routing.js`, add:

```js
const { shouldDecompose, decomposeTask, GUIDED_FILE_THRESHOLD, GUIDED_MIN_FUNCTIONS } = require('../../execution/task-decomposition');
```

- [ ] **Step 3: Replace the C# decomposition block**

Replace lines 482-629 (the entire `if (complexity === 'complex' && !override_provider && isCSharpTask)` block) with:

```js
  // AUTO-DECOMPOSE: Provider-class-aware decomposition
  const decomp = shouldDecompose(
    { task, complexity, files, working_directory },
    routingResult
  );

  if (decomp.decompose && decomp.type === 'csharp') {
    const subtasks = hostManagement.decomposeTask(task, workingDirectory);
    if (subtasks && subtasks.length > 1) {
      const { tasks: subTaskDefs } = decomposeTask(
        { task, working_directory: workingDirectory, files },
        routingResult,
        {
          subtasks,
          version_intent,
          parent_task_id: submissionTaskId,
          ui_review: taskMetadata.ui_review || false,
        }
      );

      // Create workflow from subTaskDefs — reuse existing workflow creation logic
      const { v4: uuidv4 } = require('uuid');
      const workflowId = uuidv4();
      db.createWorkflow({ id: workflowId, name: `decomposed-${submissionTaskId.slice(0, 8)}`, status: 'pending' });

      for (let i = 0; i < subTaskDefs.length; i++) {
        const st = subTaskDefs[i];
        const nodeId = `step-${i + 1}`;
        const stId = uuidv4();
        db.createTask({
          id: stId,
          task_description: st.task,
          provider: st.provider,
          model: st.model,
          status: 'pending',
          working_directory: st.working_directory,
          priority: st.priority,
          timeout_minutes: timeout,
          metadata: JSON.stringify(st.metadata),
          version_intent: st.version_intent,
        });
        db.addWorkflowTask({
          workflow_id: workflowId,
          task_id: stId,
          node_id: nodeId,
          depends_on: i > 0 ? `step-${i}` : null,
        });
      }

      db.updateWorkflowStatus(workflowId, 'running');
      taskManager.processQueue();

      let output = `## Task Decomposed (${subTaskDefs.length} steps)\n\n`;
      output += `Provider: **${routingResult.provider}** (locked to all sub-tasks)\n`;
      output += `Workflow: \`${workflowId}\`\n\n`;
      subTaskDefs.forEach((st, i) => {
        output += `${i + 1}. ${st.task.slice(0, 80)}...\n`;
      });

      return {
        content: [{ type: 'text', text: output }],
        metadata: { workflow_id: workflowId, decomposed: true, provider: routingResult.provider },
      };
    }
  }
```

- [ ] **Step 4: Verify syntax**

Run: `node -c server/handlers/integration/routing.js`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add server/handlers/integration/routing.js
git commit -m "refactor: replace C# decomposition with provider-class-aware logic"
```

---

### Task 4: Wire task-decomposition into routing.js — replace JS/TS decomposition

**Files:**
- Modify: `server/handlers/integration/routing.js:631-759`

- [ ] **Step 1: Read the current JS/TS decomposition block**

Read `server/handlers/integration/routing.js` lines 631-759.

- [ ] **Step 2: Replace the JS/TS decomposition block**

Replace the entire `{ const jsDecomposePatterns = ...` block (lines 631-759) with:

```js
  if (decomp.decompose && decomp.type === 'js') {
    const jsFilePattern = /\b([\w./-]+\.(?:js|ts|mjs|cjs|jsx|tsx))\b/gi;
    const mentionedFiles = (task || '').match(jsFilePattern) || [];
    const allFiles = [...new Set([...(files || []), ...mentionedFiles])];
    const jsWorkDir = working_directory || process.cwd();

    let resolvedJsFiles = allFiles;
    try {
      const resolution = resolveFileReferences(task, jsWorkDir);
      if (resolution.resolved.length > 0) {
        resolvedJsFiles = resolution.resolved.map(r => r.actual);
      }
    } catch (_) { /* ignore resolution failures */ }

    for (const filePath of resolvedJsFiles) {
      try {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(jsWorkDir, filePath);
        if (!fs.existsSync(fullPath)) continue;
        const lineCount = fs.readFileSync(fullPath, 'utf8').split('\n').length;
        if (lineCount < GUIDED_FILE_THRESHOLD) continue;

        const boundaries = taskManager.extractJsFunctionBoundaries(fullPath);
        if (!boundaries || boundaries.length < GUIDED_MIN_FUNCTIONS) continue;

        // File qualifies for decomposition — batch functions
        const BATCH_LINE_LIMIT = 400;
        const batches = [];
        let currentBatch = [];
        let currentLines = 0;

        for (const fn of boundaries) {
          const fnLines = (fn.endLine || fn.startLine) - fn.startLine + 1;
          if (currentLines + fnLines > BATCH_LINE_LIMIT && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentLines = 0;
          }
          currentBatch.push(fn);
          currentLines += fnLines;
        }
        if (currentBatch.length > 0) batches.push(currentBatch);
        if (batches.length <= 1) continue;

        const subtaskDescs = batches.map((batch, idx) => {
          const names = batch.map(fn => fn.name || `line ${fn.startLine}`).join(', ');
          return `Batch ${idx + 1}/${batches.length}: ${task} — focus on functions: ${names} in ${filePath} (lines ${batch[0].startLine}-${batch[batch.length - 1].endLine || batch[batch.length - 1].startLine})`;
        });

        const { tasks: subTaskDefs } = decomposeTask(
          { task, working_directory: jsWorkDir, files: resolvedJsFiles },
          routingResult,
          {
            subtasks: subtaskDescs,
            version_intent,
            parent_task_id: submissionTaskId,
            ui_review: taskMetadata.ui_review || false,
          }
        );

        const { v4: uuidv4 } = require('uuid');
        const workflowId = uuidv4();
        db.createWorkflow({ id: workflowId, name: `js-decomp-${submissionTaskId.slice(0, 8)}`, status: 'pending' });

        for (let i = 0; i < subTaskDefs.length; i++) {
          const st = subTaskDefs[i];
          const nodeId = `batch-${i + 1}`;
          const stId = uuidv4();
          db.createTask({
            id: stId,
            task_description: st.task,
            provider: st.provider,
            model: st.model,
            status: 'pending',
            working_directory: st.working_directory,
            priority: st.priority,
            timeout_minutes: timeout,
            metadata: JSON.stringify(st.metadata),
            version_intent: st.version_intent,
          });
          db.addWorkflowTask({
            workflow_id: workflowId,
            task_id: stId,
            node_id: nodeId,
            depends_on: i > 0 ? `batch-${i}` : null,
          });
        }

        db.updateWorkflowStatus(workflowId, 'running');
        taskManager.processQueue();

        let output = `## Task Decomposed — ${filePath} (${batches.length} batches)\n\n`;
        output += `Provider: **${routingResult.provider}** (locked)\n`;
        output += `Workflow: \`${workflowId}\`\n\n`;
        subtaskDescs.forEach((desc, i) => {
          output += `${i + 1}. ${desc.slice(0, 100)}...\n`;
        });

        return {
          content: [{ type: 'text', text: output }],
          metadata: { workflow_id: workflowId, decomposed: true, provider: routingResult.provider },
        };
      } catch (_) { /* file read/parse failure — skip */ }
    }
  }
```

- [ ] **Step 3: Verify syntax**

Run: `node -c server/handlers/integration/routing.js`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add server/handlers/integration/routing.js
git commit -m "refactor: replace JS/TS decomposition with provider-class-aware logic"
```

---

### Task 5: Register in DI container and update existing tests

**Files:**
- Modify: `server/container.js`
- Modify: `server/tests/integration-routing-handlers.test.js`
- Modify: `server/tests/integration-routing.test.js`

- [ ] **Step 1: Register task-decomposition in container.js**

Find the execution module registration block (around line 350) and add:

```js
if (!_defaultContainer.has('taskDecomposition')) {
  _defaultContainer.registerValue('taskDecomposition', require('./execution/task-decomposition'));
}
```

- [ ] **Step 2: Update routing test mocks if needed**

Read `server/tests/integration-routing-handlers.test.js` and `server/tests/integration-routing.test.js`. If they test decomposition behavior, update expectations:
- Tasks submitted with `provider: "codex"` should NOT trigger decomposition
- Tasks submitted with `provider: "ollama"` on huge files MAY trigger decomposition
- Decomposed sub-tasks should have `provider` set (not null)

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests pass (no regressions)

- [ ] **Step 4: Commit**

```bash
git add server/container.js server/tests/
git commit -m "refactor: register task-decomposition in DI, update routing tests"
```

---

### Task 6: Integration test — Codex Primary template prevents decomposition

**Files:**
- Modify: `server/tests/task-decomposition.test.js`

- [ ] **Step 1: Write integration test**

Add to `server/tests/task-decomposition.test.js`:

```js
  describe('integration: template + decomposition interaction', () => {
    it('codex via template → no decomposition even for complex tasks', () => {
      const result = mod.shouldDecompose(
        {
          task: 'refactor server/handlers/integration/routing.js — complex multi-function cleanup',
          complexity: 'complex',
          files: ['server/handlers/integration/routing.js'],
          working_directory: '/tmp/test',
        },
        { provider: 'codex', template: 'Codex Primary' }
      );

      expect(result.decompose).toBe(false);
      expect(result.reason).toContain('agentic');
    });

    it('ollama via template → decomposition possible for huge C# tasks', () => {
      const result = mod.shouldDecompose(
        {
          task: 'implement a full WPF dashboard with MVVM pattern in App.xaml.cs',
          complexity: 'complex',
          files: ['App.xaml.cs'],
          working_directory: '/tmp/test',
        },
        { provider: 'ollama', template: 'All Local' }
      );

      expect(result.decompose).toBe(true);
      expect(result.type).toBe('csharp');
    });

    it('cerebras via template → no decomposition (prompt-only)', () => {
      const result = mod.shouldDecompose(
        {
          task: 'refactor everything in the project',
          complexity: 'complex',
          files: [],
          working_directory: '/tmp/test',
        },
        { provider: 'cerebras', template: 'Cloud Sprint' }
      );

      expect(result.decompose).toBe(false);
      expect(result.reason).toContain('prompt-only');
    });
  });
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run server/tests/task-decomposition.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/tests/task-decomposition.test.js
git commit -m "test: add integration tests for template + decomposition interaction"
```
