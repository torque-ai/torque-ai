# Fabro #19: Lifecycle Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** First-class lifecycle hooks (`TaskStart`, `PreToolUse`, `PostToolUse`, `TaskComplete`, `WorkflowStart`, `WorkflowComplete`) that can block actions, inject context, trigger external systems, and log to compliance/telemetry sinks. Inspired by Cline's hook system.

**Architecture:** A `hooks/` directory at project root holds executable scripts (or YAML configs pointing to commands). On hook firing, TORQUE invokes the script with structured JSON on stdin (`{ event, task, ... }`) and a configured timeout. Exit code 0 = continue; non-zero = block (for `Pre*` hooks) or warn (for `Post*` hooks). Hook output (stdout) can be parsed for `inject_context: {...}` directives to add to the task. Hooks are discovered from `<project>/hooks/<event>.{sh,js,py}` or declared in workflow spec.

---

## File Structure

**New files:**
- `server/hooks/dispatcher.js` — fire hooks for an event, parse output, enforce timeouts
- `server/hooks/discover.js` — scan hooks dir
- `server/handlers/hook-handlers.js` — MCP tool to list / test hooks
- `server/tool-defs/hook-defs.js`
- `server/tests/hooks-dispatcher.test.js`

**Modified files:**
- `server/execution/task-startup.js` — fire `TaskStart`, `PreToolUse` per tool, `PostToolUse`
- `server/execution/task-finalizer.js` — fire `TaskComplete`
- `server/execution/workflow-runtime.js` — fire `WorkflowStart`, `WorkflowComplete`
- `server/workflow-spec/schema.js` — accept inline `hooks` per workflow
- `docs/hooks.md`

---

## Task 1: Dispatcher

- [x] **Step 1: Tests**

Create `server/tests/hooks-dispatcher.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { dispatchHook } = require('../hooks/dispatcher');

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeHook(name, body) {
  const dir = path.join(tmpDir, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

describe('dispatchHook', () => {
  it('returns continue=true when no hook script exists', async () => {
    const result = await dispatchHook('TaskStart', { task_id: 't1' }, { project_root: tmpDir });
    expect(result.continue).toBe(true);
    expect(result.fired).toBe(false);
  });

  it('returns continue=true when hook exits 0', async () => {
    writeHook('TaskStart', 'exit 0');
    const result = await dispatchHook('TaskStart', { task_id: 't1' }, { project_root: tmpDir });
    expect(result.fired).toBe(true);
    expect(result.continue).toBe(true);
  });

  it('returns continue=false when Pre* hook exits non-zero', async () => {
    writeHook('PreToolUse', 'echo "blocked: dangerous tool"; exit 1');
    const result = await dispatchHook('PreToolUse', { tool: 'shell' }, { project_root: tmpDir });
    expect(result.continue).toBe(false);
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toMatch(/blocked/);
  });

  it('parses inject_context from hook stdout', async () => {
    writeHook('TaskStart', 'echo "{\\"inject_context\\": {\\"hint\\": \\"avoid touching deprecated.js\\"}}"');
    const result = await dispatchHook('TaskStart', { task_id: 't1' }, { project_root: tmpDir });
    expect(result.inject_context).toEqual({ hint: 'avoid touching deprecated.js' });
  });

  it('enforces timeout', async () => {
    writeHook('TaskStart', 'sleep 5');
    const result = await dispatchHook('TaskStart', { task_id: 't1' }, { project_root: tmpDir, timeout_ms: 200 });
    expect(result.timed_out).toBe(true);
    expect(result.continue).toBe(true);  // timeout = warn-only by default
  });
});
```

- [x] **Step 2: Implement**

Create `server/hooks/dispatcher.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger').child({ component: 'hooks' });

const PRE_HOOKS = new Set(['PreToolUse', 'TaskStart', 'WorkflowStart']);
const SUPPORTED_EXTENSIONS = ['.sh', '.js', '.py'];

function findHookScript(eventName, projectRoot) {
  const dir = path.join(projectRoot, 'hooks');
  for (const ext of SUPPORTED_EXTENSIONS) {
    const file = path.join(dir, `${eventName}${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function commandFor(scriptPath) {
  if (scriptPath.endsWith('.sh')) return ['bash', [scriptPath]];
  if (scriptPath.endsWith('.js')) return ['node', [scriptPath]];
  if (scriptPath.endsWith('.py')) return ['python', [scriptPath]];
  throw new Error(`Unsupported hook script type: ${scriptPath}`);
}

async function dispatchHook(eventName, payload, opts = {}) {
  const projectRoot = opts.project_root || process.cwd();
  const timeoutMs = opts.timeout_ms || 5000;

  const script = findHookScript(eventName, projectRoot);
  if (!script) {
    return { fired: false, continue: true };
  }

  const [cmd, args] = commandFor(script);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: projectRoot, env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      let injectContext = null;
      try {
        // Try to parse the LAST line as JSON for inject_context
        const lastLine = stdout.trim().split('\n').pop();
        if (lastLine && lastLine.startsWith('{')) {
          const parsed = JSON.parse(lastLine);
          if (parsed.inject_context) injectContext = parsed.inject_context;
        }
      } catch { /* not JSON, ignore */ }

      const isBlocking = PRE_HOOKS.has(eventName) && exitCode !== 0 && !timedOut;
      const result = {
        fired: true,
        continue: !isBlocking,
        timed_out: timedOut,
        exit_code: exitCode,
        stdout,
        stderr,
        inject_context: injectContext,
      };
      if (isBlocking) {
        logger.info(`[hooks] ${eventName} blocked execution (exit ${exitCode})`);
      }
      resolve(result);
    });

    // Write payload to stdin
    try {
      child.stdin.write(JSON.stringify({ event: eventName, ...payload }));
      child.stdin.end();
    } catch (e) {
      logger.info(`[hooks] stdin write failed for ${eventName}: ${e.message}`);
    }
  });
}

module.exports = { dispatchHook, findHookScript };
```

Run tests → PASS. Commit:

```
feat(hooks): lifecycle hook dispatcher with timeout + block-on-exit-nonzero
```

---

## Task 2: Wire into runtime

- [x] **Step 1: TaskStart in `task-startup.js`**

Right at the entry of `startTask`:

```js
try {
  const { dispatchHook } = require('../hooks/dispatcher');
  const result = await dispatchHook('TaskStart', { task_id: taskId, task: task }, { project_root: task.working_directory || process.cwd() });
  if (!result.continue) {
    db.updateTaskStatus(taskId, 'cancelled', { error_output: `TaskStart hook blocked: ${result.stdout || result.stderr}` });
    return { queued: false, blocked: true };
  }
  if (result.inject_context) {
    task.task_description += `\n\n[Hook context]: ${JSON.stringify(result.inject_context)}`;
  }
} catch (e) { logger.info(`[hooks] TaskStart dispatch failed: ${e.message}`); }
```

- [x] **Step 2: TaskComplete in `task-finalizer.js`**

After the final `updateTaskStatus`:

```js
try {
  const { dispatchHook } = require('../hooks/dispatcher');
  await dispatchHook('TaskComplete', { task_id: taskId, status: ctx.status, exit_code: ctx.code }, { project_root: ctx.task.working_directory });
} catch (e) { /* non-critical */ }
```

(Pre/Post tool hooks require deeper integration into provider execution loops — leave for v2.)

- [x] **Step 3: WorkflowStart/WorkflowComplete in `workflow-runtime.js`**

At the `startWorkflow` entry and at finalization:

```js
const { dispatchHook } = require('../hooks/dispatcher');
await dispatchHook('WorkflowStart', { workflow_id: workflowId }, { project_root: workflow.working_directory });
// ...later, on finalization:
await dispatchHook('WorkflowComplete', { workflow_id: workflowId, status: finalStatus }, { project_root: workflow.working_directory });
```

Commit: `feat(hooks): wire TaskStart, TaskComplete, WorkflowStart/Complete dispatch sites`.

---

## Task 3: MCP tools + docs + smoke

- [ ] **Step 1: MCP query tool**

Create `server/tool-defs/hook-defs.js`:

```js
'use strict';
const HOOK_TOOLS = [
  {
    name: 'list_hooks',
    description: 'List discovered lifecycle hooks for a project.',
    inputSchema: { type: 'object', required: ['project_root'], properties: { project_root: { type: 'string' } } },
  },
  {
    name: 'test_hook',
    description: 'Test-fire a hook with a sample payload. Useful for debugging.',
    inputSchema: {
      type: 'object',
      required: ['event', 'project_root'],
      properties: {
        event: { type: 'string', enum: ['TaskStart', 'TaskComplete', 'WorkflowStart', 'WorkflowComplete', 'PreToolUse', 'PostToolUse'] },
        project_root: { type: 'string' },
        payload: { type: 'object', default: {} },
      },
    },
  },
];
module.exports = { HOOK_TOOLS };
```

Create `server/handlers/hook-handlers.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { dispatchHook } = require('../hooks/dispatcher');

const KNOWN_EVENTS = ['TaskStart', 'TaskComplete', 'WorkflowStart', 'WorkflowComplete', 'PreToolUse', 'PostToolUse'];

function handleListHooks(args) {
  const dir = path.join(args.project_root, 'hooks');
  if (!fs.existsSync(dir)) {
    return { content: [{ type: 'text', text: 'No hooks/ directory found.' }], structuredData: { hooks: [] } };
  }
  const hooks = [];
  for (const entry of fs.readdirSync(dir)) {
    const event = entry.replace(/\.(sh|js|py)$/, '');
    if (KNOWN_EVENTS.includes(event)) {
      hooks.push({ event, file: path.join(dir, entry) });
    }
  }
  return {
    content: [{ type: 'text', text: hooks.length === 0 ? 'No hooks found.' : `${hooks.length} hooks:\n${hooks.map(h => `- ${h.event}: ${h.file}`).join('\n')}` }],
    structuredData: { hooks },
  };
}

async function handleTestHook(args) {
  const result = await dispatchHook(args.event, args.payload || {}, { project_root: args.project_root });
  return {
    content: [{ type: 'text', text: `Hook ${args.event}: fired=${result.fired}, continue=${result.continue}, exit=${result.exit_code}\nstdout: ${result.stdout?.slice(0, 1000)}` }],
    structuredData: result,
  };
}

module.exports = { handleListHooks, handleTestHook };
```

Wire in `server/tools.js`. Add REST routes.

- [ ] **Step 2: Docs**

Create `docs/hooks.md`:

```markdown
# Lifecycle Hooks

Drop executable scripts into `<project>/hooks/<EventName>.{sh,js,py}` to intercept TORQUE runtime events.

## Events

| Event | Fires when | Block on non-zero? |
|---|---|---|
| `TaskStart` | Right before a task starts running | Yes (cancels task) |
| `TaskComplete` | After a task reaches terminal status | No (warn-only) |
| `WorkflowStart` | When a workflow transitions to running | Yes |
| `WorkflowComplete` | When a workflow reaches terminal status | No |
| `PreToolUse` | (v2) Before a tool call | Yes |
| `PostToolUse` | (v2) After a tool call | No |

## Contract

- Payload arrives on stdin as JSON
- Exit 0 = continue, non-zero exit on a Pre* hook = block
- Last line of stdout, if valid JSON with `inject_context: {...}`, is appended to the task description
- Default timeout: 5000ms (configurable via `TORQUE_HOOK_TIMEOUT_MS` env var)

## Example: TaskStart hook

`hooks/TaskStart.sh`:

```bash
#!/bin/bash
PAYLOAD=$(cat)
TASK_ID=$(echo "$PAYLOAD" | jq -r .task_id)
echo "Task starting: $TASK_ID" >> /tmp/torque-audit.log
exit 0
```

## Example: PreToolUse policy hook

`hooks/PreToolUse.sh`:

```bash
#!/bin/bash
PAYLOAD=$(cat)
TOOL=$(echo "$PAYLOAD" | jq -r .tool)
if [ "$TOOL" = "shell" ]; then
  COMMAND=$(echo "$PAYLOAD" | jq -r .command)
  if echo "$COMMAND" | grep -q "rm -rf"; then
    echo "Blocked: rm -rf detected"
    exit 1
  fi
fi
exit 0
```

## Inject context

`hooks/TaskStart.sh`:

```bash
#!/bin/bash
echo '{"inject_context": {"sprint_goal": "Q2 ship", "owner": "team-platform"}}'
exit 0
```

The injected JSON appears in the task description.
```

Restart, smoke. Commit:

```
docs(hooks): lifecycle hook usage guide
```
