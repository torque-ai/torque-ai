# Fabro #18: Architect/Editor Dual-Model Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Compose a planner model + editor model on a single task. The architect proposes the change in natural language; the editor turns the proposal into concrete file edits. Lets users pair strong reasoning models with fast precision editors without hand-building the workflow each time. Inspired by Aider's architect/editor mode.

**Architecture:** A new task field `mode: "architect_editor"` activates the split. When the task starts, TORQUE first calls the `architect_provider` (default: claude-cli or anthropic) with the task description and asks for a structured plan (file paths to touch, intent per file, no code yet). The plan output is captured. Then a SECOND provider call is dispatched to `editor_provider` (default: codex) with the original task + the architect's plan injected as context, instructed to apply the plan as actual file edits. Both calls are wrapped in a single task record, with separate sub-events (`architect.completed`, `editor.completed`) emitted via the event backbone (Plan 14).

**Tech Stack:** Node.js, existing provider registry.

---

## File Structure

**New files:**
- `server/execution/architect-editor.js` — orchestrator
- `server/execution/architect-prompt.js` — architect prompt template + parser
- `server/tests/architect-editor.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `mode`, `architect_provider`, `editor_provider` per task
- `server/tool-defs/workflow-defs.js`
- `server/workflow-spec/schema.js` (if Plan 1 shipped)
- `server/execution/task-startup.js` — branch on `mode`
- `docs/workflows.md`

---

## Task 1: Architect prompt + plan parser

- [x] **Step 1: Implement prompt module**

Create `server/execution/architect-prompt.js`:

```js
'use strict';

const PLAN_SCHEMA = {
  type: 'object',
  required: ['intent', 'files'],
  properties: {
    intent: { type: 'string', description: 'One paragraph: what the change accomplishes.' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'change'],
        properties: {
          path: { type: 'string' },
          change: { type: 'string', description: 'What changes to make to this file (no code yet).' },
          new_file: { type: 'boolean' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    tests_to_add: { type: 'array', items: { type: 'string' } },
  },
};

function buildArchitectPrompt(taskDescription, repoMap) {
  return `You are the ARCHITECT. Given the task below, produce a precise plan that the EDITOR will execute. Do NOT write code — describe what should change.

${repoMap ? `REPO MAP:\n${repoMap}\n\n---\n\n` : ''}TASK:
${taskDescription}

Respond with ONLY a JSON object matching this schema:

{
  "intent": "one paragraph describing what the change accomplishes",
  "files": [
    { "path": "exact/path/to/file.ext", "change": "what to change", "new_file": false }
  ],
  "risks": ["any risks the editor should know about"],
  "tests_to_add": ["specific test cases that should be added"]
}

Be specific. Use exact file paths. List EVERY file the editor needs to touch.`;
}

function buildEditorPrompt(taskDescription, plan) {
  return `You are the EDITOR. The ARCHITECT has produced this plan:

INTENT: ${plan.intent}

FILES TO TOUCH:
${plan.files.map(f => `- ${f.path}${f.new_file ? ' (NEW)' : ''}: ${f.change}`).join('\n')}

${plan.risks?.length ? `RISKS:\n${plan.risks.map(r => `- ${r}`).join('\n')}\n\n` : ''}${plan.tests_to_add?.length ? `TESTS TO ADD:\n${plan.tests_to_add.map(t => `- ${t}`).join('\n')}\n\n` : ''}ORIGINAL TASK:
${taskDescription}

Execute the plan. Make the actual file edits. Do not deviate from the listed files unless absolutely necessary.`;
}

module.exports = { PLAN_SCHEMA, buildArchitectPrompt, buildEditorPrompt };
```

Commit:

```
feat(architect-editor): prompt templates + plan schema
```

---

## Task 2: Orchestrator

- [x] **Step 1: Tests**

Create `server/tests/architect-editor.test.js`:

```js
'use strict';

const { describe, it, expect, vi } = require('vitest');
const { runArchitectEditor } = require('../execution/architect-editor');

describe('runArchitectEditor', () => {
  it('calls architect first, parses plan, then dispatches editor with plan injected', async () => {
    const architectCall = vi.fn().mockResolvedValue(JSON.stringify({
      intent: 'add a new logger',
      files: [{ path: 'src/logger.js', change: 'create logger module', new_file: true }],
      risks: [],
      tests_to_add: ['logger smoke test'],
    }));
    const editorCall = vi.fn().mockResolvedValue({ files_modified: ['src/logger.js'], output: 'done' });

    const result = await runArchitectEditor({
      task_description: 'Add a logger',
      architect_call: architectCall,
      editor_call: editorCall,
    });

    expect(architectCall).toHaveBeenCalledTimes(1);
    expect(editorCall).toHaveBeenCalledTimes(1);
    const editorPrompt = editorCall.mock.calls[0][0];
    expect(editorPrompt).toContain('INTENT: add a new logger');
    expect(editorPrompt).toContain('src/logger.js');
    expect(result.plan.files).toHaveLength(1);
    expect(result.editor_result.files_modified).toContain('src/logger.js');
  });

  it('falls back gracefully when architect returns malformed JSON', async () => {
    const architectCall = vi.fn().mockResolvedValue('not json');
    const editorCall = vi.fn().mockResolvedValue({ output: 'done' });

    const result = await runArchitectEditor({
      task_description: 'Do thing',
      architect_call: architectCall,
      editor_call: editorCall,
    });

    expect(result.plan_valid).toBe(false);
    // Editor still runs but with the raw architect output as advisory text
    expect(editorCall).toHaveBeenCalledTimes(1);
    const editorPrompt = editorCall.mock.calls[0][0];
    expect(editorPrompt).toContain('not json');
  });

  it('aborts and surfaces error if architect throws', async () => {
    const architectCall = vi.fn().mockRejectedValue(new Error('architect down'));
    const editorCall = vi.fn();

    await expect(runArchitectEditor({
      task_description: 'x',
      architect_call: architectCall,
      editor_call: editorCall,
    })).rejects.toThrow(/architect down/);
    expect(editorCall).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Implement**

Create `server/execution/architect-editor.js`:

```js
'use strict';

const Ajv = require('ajv');
const { PLAN_SCHEMA, buildArchitectPrompt, buildEditorPrompt } = require('./architect-prompt');
const logger = require('../logger').child({ component: 'architect-editor' });

const ajv = new Ajv({ strict: false });
const validatePlan = ajv.compile(PLAN_SCHEMA);

/**
 * Run an architect/editor split for a single task.
 *
 * @param {object} args
 * @param {string} args.task_description
 * @param {string} [args.repo_map]
 * @param {Function} args.architect_call - async (prompt) => string|object (the architect's response)
 * @param {Function} args.editor_call - async (prompt) => object ({ output, error_output, files_modified })
 * @returns {Promise<{ plan, plan_valid, editor_result, architect_raw }>}
 */
async function runArchitectEditor({ task_description, repo_map, architect_call, editor_call }) {
  const architectPrompt = buildArchitectPrompt(task_description, repo_map);
  const architectRaw = await architect_call(architectPrompt);

  let plan;
  let planValid = false;
  try {
    plan = typeof architectRaw === 'string' ? JSON.parse(architectRaw) : architectRaw;
    planValid = validatePlan(plan);
  } catch (e) {
    logger.info(`[architect-editor] Architect output not JSON: ${e.message}`);
  }

  let editorPrompt;
  if (planValid) {
    editorPrompt = buildEditorPrompt(task_description, plan);
  } else {
    // Fallback: pass raw architect output as advisory text, let editor try anyway
    editorPrompt = `ARCHITECT NOTES (raw, may be unstructured):\n${typeof architectRaw === 'string' ? architectRaw : JSON.stringify(architectRaw)}\n\n---\n\nORIGINAL TASK:\n${task_description}\n\nDo your best to execute the task using the architect notes as guidance.`;
  }

  const editorResult = await editor_call(editorPrompt);

  return {
    plan: planValid ? plan : null,
    plan_valid: planValid,
    architect_raw: architectRaw,
    editor_result: editorResult,
  };
}

module.exports = { runArchitectEditor };
```

Run tests → PASS. Commit:

```
feat(architect-editor): orchestrator with fallback for malformed plans
```

---

## Task 3: Per-task fields

- [x] **Step 1: Tool def**

In `server/tool-defs/workflow-defs.js` `create_workflow` `tasks.items.properties`:

```js
mode: {
  type: 'string',
  enum: ['agent', 'architect_editor'],
  description: 'Execution mode. Default "agent". "architect_editor" calls architect_provider for a plan, then editor_provider to execute it.',
},
architect_provider: { type: 'string', enum: ['codex', 'claude-cli', 'ollama', 'ollama-cloud', 'anthropic', 'cerebras', 'deepinfra', 'google-ai', 'groq', 'hyperbolic', 'openrouter'] },
editor_provider: { type: 'string', enum: ['codex', 'claude-cli', 'ollama', 'ollama-cloud', 'anthropic', 'cerebras', 'deepinfra', 'google-ai', 'groq', 'hyperbolic', 'openrouter'] },
```

In `buildWorkflowTaskMetadata`:

```js
if (taskLike.mode === 'architect_editor') {
  metaObj.mode = 'architect_editor';
  if (taskLike.architect_provider) metaObj.architect_provider = taskLike.architect_provider;
  if (taskLike.editor_provider) metaObj.editor_provider = taskLike.editor_provider;
}
```

- [x] **Step 2: Validation**

In `normalizeInitialWorkflowTasks`:

```js
for (const task of normalized) {
  if (task.mode === 'architect_editor') {
    if (!task.architect_provider) {
      // default to claude-cli or first available reasoning provider
      task.architect_provider = 'claude-cli';
    }
    if (!task.editor_provider) {
      task.editor_provider = 'codex';
    }
  }
}
```

- [x] **Step 3: Commit**

Stage `server/tool-defs/workflow-defs.js` and `server/handlers/workflow/index.js`. Commit: `feat(architect-editor): accept mode/architect_provider/editor_provider per task`.

---

## Task 4: Wire into task-startup

- [x] **Step 1: Branch on mode in `task-startup.js`**

Find where the provider is dispatched. Before the normal single-provider path, check for architect_editor mode:

```js
let taskMeta;
try { taskMeta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}); } catch { taskMeta = {}; }

if (taskMeta.mode === 'architect_editor') {
  return runArchitectEditorTask(task, taskMeta, taskId);
}

// ...existing single-provider dispatch path
```

- [x] **Step 2: Implement `runArchitectEditorTask`**

Add to `task-startup.js`:

```js
async function runArchitectEditorTask(task, taskMeta, taskId) {
  const { runArchitectEditor } = require('./architect-editor');
  const { emitTaskEvent } = require('../events/event-emitter');
  const { EVENT_TYPES } = require('../events/event-types');
  const providerRegistry = require('../providers/registry');

  const architectProvider = taskMeta.architect_provider || 'claude-cli';
  const editorProvider = taskMeta.editor_provider || 'codex';

  const architectInst = providerRegistry.getProviderInstance(architectProvider);
  const editorInst = providerRegistry.getProviderInstance(editorProvider);
  if (!architectInst || !editorInst) {
    throw new Error(`architect_editor mode requires both providers available: architect=${architectProvider}, editor=${editorProvider}`);
  }

  const architectCall = async (prompt) => {
    if (typeof architectInst.runPrompt === 'function') {
      return await architectInst.runPrompt({ prompt, format: 'json', max_tokens: 4000 });
    }
    throw new Error(`Architect provider ${architectProvider} does not support runPrompt`);
  };

  const editorCall = async (prompt) => {
    // Editor needs file-edit capability — dispatch through the standard provider execution path
    // by mutating the task description in place and falling back to the agent loop
    const updatedDescription = prompt;
    db.updateTask(taskId, { task_description: updatedDescription, provider: editorProvider });
    // Re-enter normal task startup path (now that metadata.mode is 'architect_editor' but we've already
    // consumed the architect step — set a sentinel so we don't loop)
    db.patchTaskMetadata(taskId, { ...taskMeta, _architect_done: true, mode: 'agent' });
    // Continue with the normal single-provider path
    return await runStandardTaskStartup(taskId);
  };

  emitTaskEvent({ task_id: taskId, type: 'tool.called', actor: 'architect-editor', payload: { phase: 'architect_start' } });
  const result = await runArchitectEditor({
    task_description: task.task_description,
    architect_call: architectCall,
    editor_call: editorCall,
  });
  emitTaskEvent({
    task_id: taskId,
    type: 'tool.called',
    actor: 'architect-editor',
    payload: { phase: 'architect_done', plan_valid: result.plan_valid, plan_files: result.plan?.files?.length || 0 },
  });

  return { queued: false, alreadyRunning: false, architect_editor: true };
}
```

(Adjust `runStandardTaskStartup` to whatever the existing single-provider entry point is named. Re-entry needs the `_architect_done` sentinel to avoid an infinite loop.)

- [x] **Step 3: Commit**

Stage `server/execution/task-startup.js`. Commit: `feat(architect-editor): branch task-startup on mode=architect_editor`.

---

## Task 5: Workflow-spec (skip if Plan 1 not shipped) + docs + smoke

- [ ] **Step 1: Schema**

Add to `server/workflow-spec/schema.js` `tasks.items.properties`:

```js
mode: { type: 'string', enum: ['agent', 'architect_editor'] },
architect_provider: { type: 'string' },
editor_provider: { type: 'string' },
```

- [ ] **Step 2: Docs**

Create `docs/architect-editor.md`:

```markdown
# Architect / Editor Mode

For tasks where reasoning quality and edit precision are best handled by different models, set `mode: architect_editor` on the task:

```yaml
- node_id: refactor
  task: |
    Refactor server/foo.js to extract the parsing logic into a separate module
    server/foo-parser.js. Update all callers.
  mode: architect_editor
  architect_provider: claude-cli   # default if omitted
  editor_provider: codex            # default if omitted
```

## How it works

1. **Architect call** — TORQUE calls `architect_provider` with the task and asks for a structured plan: which files to touch, what to change in each. The architect does NOT write code.
2. **Editor call** — TORQUE then calls `editor_provider` with the original task + architect's plan, instructed to execute the plan as concrete file edits.

Both calls are recorded as separate sub-events (`tool.called` with `phase: architect_start` / `phase: architect_done`) on the same task ID. Cost and tokens are tracked separately per provider.

## When to use

- Cross-file refactors where the architect needs to think holistically before the editor commits to text edits
- Tasks where you want a frontier model's planning quality without paying frontier prices for the actual diff generation
- Tasks where the editor model is fast but the architect model is more careful

## Fallback

If the architect's response is malformed JSON, TORQUE passes the raw architect output to the editor as advisory text and proceeds. The task does not fail solely because of architect output formatting.
```

- [ ] **Step 3: Restart, smoke**

Restart TORQUE. Submit a small task with `mode: architect_editor`, `architect_provider: claude-cli`, `editor_provider: codex`. Expect: two events captured under one task, final output reflects both phases, `cost_usd` reflects both calls.

Commit: `docs(architect-editor): dual-model split guide`.
