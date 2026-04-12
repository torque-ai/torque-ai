# Software Factory Phase 10: Plan Executor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Teach the factory's `EXECUTE` stage to run a pre-written plan file end-to-end: parse `## Task N` sections + `- [ ]` step checkboxes, submit each task to TORQUE (Codex by default), wait for completion, tick the checkbox on success, and stop on first failure. Skips the architect (`PLAN`) stage when the intake item already carries a `plan_path`.

**Architecture:** `plan-executor.js` does three things:
1. **Parse** the markdown into a task tree: `{ task_number, task_title, steps: [{checkbox_line, body, code_blocks, commit_message?}] }`.
2. **Submit** one TORQUE task per plan-task (not per step — steps within a task share the test+impl+commit TDD triad and should ship atomically). The task prompt is the full task body with all step code blocks inlined. `verify_command` is read from the plan's `**Tech Stack:**` or project defaults.
3. **Tick** — on successful completion, rewrite the plan file in place to flip every `- [ ]` in that task to `- [x]`. Work item status moves `executing → verifying → shipped`.

Failure behavior: stop at first task that fails verify or times out, mark the work item `status='in_progress'` with `reject_reason=<task_n>`, leave checkboxes as-is so resumption re-picks the same task.

**Tech Stack:** Node.js, fs (atomic replace), `smart_submit_task` + `await_task` MCP tools, existing TORQUE provider layer. Builds on Phase 6 (factory loop) + Phase 9 (plan-file-intake).

---

## File Structure

**New files:**
- `server/factory/plan-executor.js`
- `server/factory/plan-parser.js`
- `server/tests/plan-parser.test.js`
- `server/tests/plan-executor.test.js`

**Modified files:**
- `server/factory/loop-controller.js` — branch `PLAN` stage: if `origin.plan_path` exists, skip architect and go directly to `EXECUTE` using plan-executor
- `server/handlers/mcp-tools.js` — `execute_plan_file`, `get_plan_execution_status`

---

## Task 1: Plan parser

- [ ] **Step 1: Tests**

Create `server/tests/plan-parser.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { parsePlanFile, extractVerifyCommand } = require('../factory/plan-parser');

const SAMPLE = `# Feature X Plan

**Goal:** Add feature X.
**Tech Stack:** Node.js, better-sqlite3.

## Task 1: Schema + store

- [ ] **Step 1: Tests**

\`\`\`js
// test code
expect(true).toBe(true);
\`\`\`

- [ ] **Step 2: Commit**

\`\`\`bash
git commit -m "feat(x): schema + store"
\`\`\`

## Task 2: API surface

- [ ] **Step 1: Register MCP tool**

\`\`\`js
// mcp tool def
\`\`\`

- [ ] **Step 2: Commit**

\`\`\`bash
git commit -m "feat(x): MCP surface"
\`\`\`
`;

describe('parsePlanFile', () => {
  it('returns one task per "## Task N:" heading', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0].task_number).toBe(1);
    expect(parsed.tasks[0].task_title).toBe('Schema + store');
    expect(parsed.tasks[1].task_number).toBe(2);
    expect(parsed.tasks[1].task_title).toBe('API surface');
  });

  it('groups steps under each task', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.tasks[0].steps).toHaveLength(2);
    expect(parsed.tasks[0].steps[0].title).toMatch(/Tests/);
    expect(parsed.tasks[0].steps[1].title).toMatch(/Commit/);
  });

  it('captures code blocks per step', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.tasks[0].steps[0].code_blocks).toHaveLength(1);
    expect(parsed.tasks[0].steps[0].code_blocks[0].lang).toBe('js');
    expect(parsed.tasks[0].steps[0].code_blocks[0].content).toContain('expect(true)');
  });

  it('extracts the commit message from a bash commit step', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.tasks[0].commit_message).toBe('feat(x): schema + store');
  });

  it('detects checkbox state for each step', () => {
    const done = SAMPLE.replace('- [ ] **Step 1: Tests**', '- [x] **Step 1: Tests**');
    const parsed = parsePlanFile(done);
    expect(parsed.tasks[0].steps[0].done).toBe(true);
    expect(parsed.tasks[0].steps[1].done).toBe(false);
    expect(parsed.tasks[0].completed).toBe(false); // not all steps done
  });

  it('marks a task completed when all its steps are ticked', () => {
    const all = SAMPLE
      .replace('- [ ] **Step 1: Tests**', '- [x] **Step 1: Tests**')
      .replace('- [ ] **Step 2: Commit**\n\n```bash\ngit commit -m "feat(x): schema + store"\n```', '- [x] **Step 2: Commit**\n\n```bash\ngit commit -m "feat(x): schema + store"\n```');
    const parsed = parsePlanFile(all);
    expect(parsed.tasks[0].completed).toBe(true);
  });

  it('extractVerifyCommand reads Tech Stack hints + project_defaults override', () => {
    expect(extractVerifyCommand(SAMPLE, null)).toMatch(/vitest|tsc|npm test/i);
    expect(extractVerifyCommand(SAMPLE, 'npm run check')).toBe('npm run check');
  });

  it('returns header metadata (title, goal, tech_stack)', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.title).toBe('Feature X Plan');
    expect(parsed.goal).toContain('Add feature X');
    expect(parsed.tech_stack).toContain('better-sqlite3');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/factory/plan-parser.js`:

```js
'use strict';

function parsePlanFile(content) {
  const lines = content.split('\n');
  const title = (lines.find(l => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').trim();
  const goal = (content.match(/\*\*Goal:\*\*\s*([^\n]+)/) || [])[1]?.trim() || null;
  const tech_stack = (content.match(/\*\*Tech Stack:\*\*\s*([^\n]+)/) || [])[1]?.trim() || null;

  const taskHeaderRe = /^##\s+Task\s+(\d+)\s*[:.]\s*(.+?)\s*$/;
  const stepRe = /^\s*-\s*\[([ xX])\]\s*\*\*Step\s+(\d+)\s*[:.]\s*([^*]+?)\s*\*\*/;

  const tasks = [];
  let currentTask = null;
  let currentStep = null;
  let inCode = false;
  let codeLang = null;
  let codeBuf = [];

  function closeStep() {
    if (currentStep) {
      if (codeBuf.length) currentStep.code_blocks.push({ lang: codeLang, content: codeBuf.join('\n') });
      codeBuf = []; codeLang = null; inCode = false;
      currentStep = null;
    }
  }
  function closeTask() {
    closeStep();
    if (currentTask) {
      currentTask.completed = currentTask.steps.length > 0 && currentTask.steps.every(s => s.done);
      const commitStep = currentTask.steps.find(s => /commit/i.test(s.title));
      if (commitStep) {
        for (const block of commitStep.code_blocks) {
          const m = block.content.match(/git commit -m ["'`](.+?)["'`]/);
          if (m) { currentTask.commit_message = m[1]; break; }
        }
      }
      tasks.push(currentTask);
      currentTask = null;
    }
  }

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (!inCode) { inCode = true; codeLang = line.replace(/^```/, '').trim() || null; codeBuf = []; }
      else {
        if (currentStep) currentStep.code_blocks.push({ lang: codeLang, content: codeBuf.join('\n') });
        inCode = false; codeBuf = []; codeLang = null;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const th = line.match(taskHeaderRe);
    if (th) {
      closeTask();
      currentTask = { task_number: Number(th[1]), task_title: th[2], steps: [], commit_message: null, completed: false };
      continue;
    }
    const sh = line.match(stepRe);
    if (sh && currentTask) {
      closeStep();
      currentStep = {
        step_number: Number(sh[2]),
        title: sh[3].trim(),
        done: sh[1].toLowerCase() === 'x',
        code_blocks: [],
        raw_checkbox_line: line,
      };
      currentTask.steps.push(currentStep);
      continue;
    }
  }
  closeTask();

  return { title, goal, tech_stack, tasks };
}

function extractVerifyCommand(planContent, projectDefault) {
  if (projectDefault) return projectDefault;
  const tech = (planContent.match(/\*\*Tech Stack:\*\*\s*([^\n]+)/) || [])[1] || '';
  if (/vitest/i.test(tech)) return 'npx vitest run';
  if (/tsc|typescript/i.test(tech)) return 'npx tsc --noEmit && npx vitest run';
  if (/jest/i.test(tech)) return 'npx jest';
  return 'npm test';
}

module.exports = { parsePlanFile, extractVerifyCommand };
```

- [ ] **Step 3: Commit**

```bash
git add server/factory/plan-parser.js server/tests/plan-parser.test.js
git commit -m "feat(factory): plan-parser — extract tasks/steps/code/commit from plan markdown"
```

---

## Task 2: Executor

- [ ] **Step 1: Tests**

Create `server/tests/plan-executor.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach, vi } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createPlanExecutor } = require('../factory/plan-executor');

const PLAN = `# X

**Tech Stack:** Node.js, vitest.

## Task 1: first

- [ ] **Step 1: test**

\`\`\`js
expect(1).toBe(1);
\`\`\`

- [ ] **Step 2: commit**

\`\`\`bash
git commit -m "feat: first"
\`\`\`

## Task 2: second

- [ ] **Step 1: more**

\`\`\`js
// impl
\`\`\`

- [ ] **Step 2: commit**

\`\`\`bash
git commit -m "feat: second"
\`\`\`
`;

describe('plan-executor', () => {
  let dir, planPath, submitMock, awaitMock, exec;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-exec-'));
    planPath = path.join(dir, 'plan.md');
    fs.writeFileSync(planPath, PLAN);
    submitMock = vi.fn(async ({ task }) => ({ task_id: `t_${submitMock.mock.calls.length}` }));
    awaitMock = vi.fn(async () => ({ status: 'completed', verify_status: 'passed' }));
    exec = createPlanExecutor({ submit: submitMock, awaitTask: awaitMock });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('submits one torque task per plan-task, in order', async () => {
    await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(submitMock.mock.calls[0][0].task).toContain('Task 1');
    expect(submitMock.mock.calls[1][0].task).toContain('Task 2');
  });

  it('passes verify_command + commit_message to await', async () => {
    await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(awaitMock.mock.calls[0][0].verify_command).toContain('vitest');
    expect(awaitMock.mock.calls[0][0].commit_message).toBe('feat: first');
  });

  it('ticks checkboxes in the plan file after a task succeeds', async () => {
    await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    const updated = fs.readFileSync(planPath, 'utf8');
    expect(updated).not.toContain('- [ ] **Step 1: test**');
    expect(updated).toContain('- [x] **Step 1: test**');
    expect(updated).toContain('- [x] **Step 2: commit**');
  });

  it('stops at first failed task and leaves later checkboxes untouched', async () => {
    awaitMock = vi.fn()
      .mockResolvedValueOnce({ status: 'completed', verify_status: 'passed' })
      .mockResolvedValueOnce({ status: 'failed', error: 'verify red' });
    exec = createPlanExecutor({ submit: submitMock, awaitTask: awaitMock });
    const result = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(result.failed_task).toBe(2);
    const updated = fs.readFileSync(planPath, 'utf8');
    // Task 1 ticked
    expect(updated).toContain('## Task 1: first\n\n- [x]');
    // Task 2 still pending
    expect(updated).toContain('## Task 2: second\n\n- [ ]');
  });

  it('skips already-ticked tasks on resume', async () => {
    // Pre-tick Task 1
    const pre = PLAN.replace(/- \[ \] \*\*Step (1|2): (test|commit)\*\*/g, '- [x] **Step $1: $2**');
    fs.writeFileSync(planPath, pre);
    await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(submitMock).toHaveBeenCalledTimes(1); // only Task 2 submitted
    expect(submitMock.mock.calls[0][0].task).toContain('Task 2');
  });

  it('returns a summary with completed_tasks + failed_task + duration_ms', async () => {
    const r = await exec.execute({ plan_path: planPath, project: 'p', working_directory: dir });
    expect(r.completed_tasks).toEqual([1, 2]);
    expect(r.failed_task).toBeNull();
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/factory/plan-executor.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'plan-executor' });
const { parsePlanFile, extractVerifyCommand } = require('./plan-parser');

function buildTaskPrompt(task, planTitle) {
  const lines = [`Plan: ${planTitle}`, `Task ${task.task_number}: ${task.task_title}`, ''];
  for (const step of task.steps) {
    lines.push(`### Step ${step.step_number}: ${step.title}`);
    for (const block of step.code_blocks) {
      lines.push('```' + (block.lang || ''));
      lines.push(block.content);
      lines.push('```');
    }
    lines.push('');
  }
  lines.push('After making the edits, stop. Do not run verify — the host will verify.');
  return lines.join('\n');
}

function tickTaskInFile(filePath, taskNumber) {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parsePlanFile(content);
  const task = parsed.tasks.find(t => t.task_number === taskNumber);
  if (!task) return;

  const lines = content.split('\n');
  for (const step of task.steps) {
    const idx = lines.findIndex(l => l === step.raw_checkbox_line);
    if (idx >= 0) lines[idx] = lines[idx].replace(/-\s*\[\s*\]/, '- [x]');
  }
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n'));
  fs.renameSync(tmp, filePath);
}

function createPlanExecutor({ submit, awaitTask, projectDefaults = {} }) {
  async function execute({ plan_path, project, working_directory, version_intent = 'feature' }) {
    const started = Date.now();
    const content = fs.readFileSync(plan_path, 'utf8');
    const parsed = parsePlanFile(content);
    const verify_command = extractVerifyCommand(content, projectDefaults.verify_command);

    const completed_tasks = [];
    let failed_task = null;

    for (const task of parsed.tasks) {
      if (task.completed) {
        logger.info(`skipping already-completed task ${task.task_number}: ${task.task_title}`);
        completed_tasks.push(task.task_number);
        continue;
      }

      const prompt = buildTaskPrompt(task, parsed.title);
      const { task_id } = await submit({
        task: prompt,
        project,
        working_directory,
        version_intent,
      });

      const result = await awaitTask({
        task_id,
        verify_command,
        commit_message: task.commit_message || `feat: plan task ${task.task_number}`,
        working_directory,
      });

      if (result.status !== 'completed' || (result.verify_status && result.verify_status !== 'passed')) {
        failed_task = task.task_number;
        logger.warn(`task ${task.task_number} failed: ${result.error || result.verify_status}`);
        break;
      }
      tickTaskInFile(plan_path, task.task_number);
      completed_tasks.push(task.task_number);
    }

    return {
      plan_path,
      completed_tasks,
      failed_task,
      duration_ms: Date.now() - started,
    };
  }

  return { execute };
}

module.exports = { createPlanExecutor, buildTaskPrompt, tickTaskInFile };
```

- [ ] **Step 3: Commit**

```bash
git add server/factory/plan-executor.js server/tests/plan-executor.test.js
git commit -m "feat(factory): plan-executor — per-task submit/await/tick + stop-on-fail"
```

---

## Task 3: Loop integration + MCP

- [ ] **Step 1: Branch the PLAN stage**

In `server/factory/loop-controller.js`, when entering `PLAN`:

```js
const workItem = factoryIntake.getWorkItem(project.current_work_item_id);
if (workItem?.origin?.plan_path && fs.existsSync(workItem.origin.plan_path)) {
  // Plan already exists — skip architect, jump straight to EXECUTE
  factoryIntake.updateWorkItem(workItem.id, { status: 'executing' });
  return { next_state: 'EXECUTE', reason: 'pre-written plan detected' };
}
// else fall through to existing architect-runner path
```

In the `EXECUTE` handler, when `workItem.origin.plan_path` is present:

```js
const { createPlanExecutor } = require('./plan-executor');
const executor = createPlanExecutor({
  submit: (args) => smartSubmitTask(args),
  awaitTask: (args) => awaitTask(args),
  projectDefaults: project.config,
});
const result = await executor.execute({
  plan_path: workItem.origin.plan_path,
  project: project.name,
  working_directory: project.working_directory,
});
if (result.failed_task) {
  factoryIntake.updateWorkItem(workItem.id, {
    status: 'in_progress',
    reject_reason: `task_${result.failed_task}_failed`,
  });
  return { next_state: 'IDLE', reason: `task ${result.failed_task} failed` };
}
factoryIntake.updateWorkItem(workItem.id, { status: 'verifying' });
return { next_state: 'VERIFY' };
```

- [ ] **Step 2: MCP tools**

In `server/handlers/mcp-tools.js`:

```js
execute_plan_file: {
  description: 'Execute a plan file task-by-task: parse → submit each task to TORQUE → await → tick checkboxes. Stops at first failure.',
  inputSchema: {
    type: 'object',
    required: ['plan_path', 'project', 'working_directory'],
    properties: {
      plan_path: { type: 'string' },
      project: { type: 'string' },
      working_directory: { type: 'string' },
      version_intent: { enum: ['feature', 'fix', 'breaking', 'internal'] },
    },
  },
},
get_plan_execution_status: {
  description: 'Parse a plan file and return task/step completion counts + next pending task.',
  inputSchema: { type: 'object', required: ['plan_path'], properties: { plan_path: { type: 'string' } } },
},
```

- [ ] **Step 3: Smoke**

Pick a tiny plan (e.g., Plan 7 per-task-verify or a hand-written 2-task fixture). Run `execute_plan_file` directly → observe TORQUE tasks spawned, checkboxes ticked in the file, plan file updated on disk.

- [ ] **Step 4: Commit**

```bash
git add server/factory/loop-controller.js server/handlers/mcp-tools.js
git commit -m "feat(factory): PLAN stage branches to plan-executor for pre-written plans"
```
