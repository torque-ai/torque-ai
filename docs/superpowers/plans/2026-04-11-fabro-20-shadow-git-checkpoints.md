# Fabro #20: Shadow-Git Checkpoints + Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After every task completes, snapshot the working directory's state into a *shadow* git repo (separate from the user's real `.git`). Lets users roll back individual task changes without touching their main repo history. Inspired by Cline's checkpoint system.

**Architecture:** A new `server/checkpoints/` module manages a parallel `.torque-checkpoints/` directory at the project root that's a real git repo containing snapshots of the working tree at each task completion. Snapshots are commits in the shadow repo tagged with `task-<task_id>`. A `rollback_task` MCP tool restores the project files to the state from before a specific task. The shadow repo is gitignored from the main repo. No interaction with the user's real git.

---

## File Structure

**New files:**
- `server/checkpoints/snapshot.js`
- `server/checkpoints/rollback.js`
- `server/handlers/checkpoint-handlers.js`
- `server/tool-defs/checkpoint-defs.js`
- `server/tests/checkpoints.test.js`

**Modified files:**
- `server/execution/task-finalizer.js`
- `docs/checkpoints.md`

---

## Task 1: Shadow repo init + snapshot

- [x] **Step 1: Tests**

Create `server/tests/checkpoints.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ensureShadowRepo, snapshotTaskState } = require('../checkpoints/snapshot');
const { rollbackTask, listCheckpoints } = require('../checkpoints/rollback');

let projectRoot;
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-'));
  fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'initial\n');
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('shadow git checkpoints', () => {
  it('initializes a shadow repo on first snapshot', () => {
    const result = ensureShadowRepo(projectRoot);
    expect(result.created).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.torque-checkpoints', '.git'))).toBe(true);
  });

  it('snapshot captures the current working tree as a tagged commit', () => {
    snapshotTaskState({ project_root: projectRoot, task_id: 'task-1', task_label: 'first' });
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'modified\n');
    snapshotTaskState({ project_root: projectRoot, task_id: 'task-2', task_label: 'second' });

    const checkpoints = listCheckpoints(projectRoot);
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    const taskIds = checkpoints.map(c => c.task_id).sort();
    expect(taskIds).toContain('task-1');
    expect(taskIds).toContain('task-2');
  });

  it('rollback restores the working tree to a previous snapshot', () => {
    snapshotTaskState({ project_root: projectRoot, task_id: 'task-1', task_label: 'first' });
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'modified\n');
    snapshotTaskState({ project_root: projectRoot, task_id: 'task-2', task_label: 'second' });

    expect(fs.readFileSync(path.join(projectRoot, 'a.txt'), 'utf8')).toBe('modified\n');
    rollbackTask({ project_root: projectRoot, task_id: 'task-1' });
    expect(fs.readFileSync(path.join(projectRoot, 'a.txt'), 'utf8')).toBe('initial\n');
  });

  it('rollback returns error when task_id has no snapshot', () => {
    const result = rollbackTask({ project_root: projectRoot, task_id: 'no-such-task' });
    expect(result.ok).toBe(false);
  });
});
```

- [x] **Step 2: Implement snapshot**

Create `server/checkpoints/snapshot.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../logger').child({ component: 'checkpoints' });

const SHADOW_DIR_NAME = '.torque-checkpoints';
const SHADOW_AUTHOR_NAME = 'TORQUE Checkpoints';
const SHADOW_AUTHOR_ID = 'noreply+checkpoints';   // local-only, never used as a real address

function shadowDir(projectRoot) {
  return path.join(projectRoot, SHADOW_DIR_NAME);
}

function gitCmd(args, opts) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts });
}

function ensureShadowRepo(projectRoot) {
  const dir = shadowDir(projectRoot);
  if (fs.existsSync(path.join(dir, '.git'))) return { created: false, dir };

  fs.mkdirSync(dir, { recursive: true });
  // The shadow repo's working tree IS the project root, but its git dir is .torque-checkpoints/.git
  gitCmd(['init', '--quiet', '--separate-git-dir=' + path.join(dir, '.git'), projectRoot]);
  // Ensure .torque-checkpoints itself is ignored by both repos
  const ignorePath = path.join(projectRoot, '.gitignore');
  if (fs.existsSync(ignorePath)) {
    const cur = fs.readFileSync(ignorePath, 'utf8');
    if (!cur.includes('.torque-checkpoints')) {
      fs.appendFileSync(ignorePath, '\n.torque-checkpoints/\n');
    }
  } else {
    fs.writeFileSync(ignorePath, '.torque-checkpoints/\n');
  }
  // Configure shadow git author so commits don't fail. Local-only — never sent anywhere.
  const env = { ...process.env, GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: projectRoot };
  gitCmd(['config', 'user.name', SHADOW_AUTHOR_NAME], { env });
  gitCmd(['config', 'user.email', `${SHADOW_AUTHOR_ID}@local`], { env });
  return { created: true, dir };
}

function snapshotTaskState({ project_root, task_id, task_label }) {
  ensureShadowRepo(project_root);
  const dir = shadowDir(project_root);
  const env = { ...process.env, GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: project_root };
  try {
    gitCmd(['add', '-A'], { env });
    gitCmd(['commit', '--allow-empty', '-m', `task-${task_id}: ${task_label || ''}`], { env });
    gitCmd(['tag', '-f', `task-${task_id}`, 'HEAD'], { env });
    return { ok: true, task_id };
  } catch (err) {
    logger.info(`[checkpoints] snapshot failed for ${task_id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { ensureShadowRepo, snapshotTaskState, shadowDir, SHADOW_DIR_NAME };
```

- [x] **Step 3: Implement rollback**

Create `server/checkpoints/rollback.js`:

```js
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { shadowDir } = require('./snapshot');

function rollbackTask({ project_root, task_id }) {
  const dir = shadowDir(project_root);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return { ok: false, error: 'No shadow repo at this project' };
  }
  const env = { ...process.env, GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: project_root };
  try {
    execFileSync('git', ['rev-parse', `task-${task_id}`], { env, encoding: 'utf8' });
  } catch {
    return { ok: false, error: `No snapshot found for task ${task_id}` };
  }
  try {
    execFileSync('git', ['checkout', '-f', `task-${task_id}`, '--', '.'], { env, encoding: 'utf8' });
    return { ok: true, restored_to: `task-${task_id}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function listCheckpoints(project_root) {
  const dir = shadowDir(project_root);
  if (!fs.existsSync(path.join(dir, '.git'))) return [];
  const env = { ...process.env, GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: project_root };
  let out;
  try {
    out = execFileSync('git', ['log', '--all', '--format=%H|%ai|%s'], { env, encoding: 'utf8' });
  } catch { return []; }
  return out.split('\n').filter(Boolean).map(line => {
    const [sha, ai, ...rest] = line.split('|');
    const subject = rest.join('|');
    const m = subject.match(/^task-([a-f0-9-]+):/);
    return {
      sha,
      timestamp: ai,
      subject,
      task_id: m ? m[1] : null,
    };
  });
}

module.exports = { rollbackTask, listCheckpoints };
```

- [x] **Step 4: Run tests, commit**

Run on remote: `npx vitest run tests/checkpoints.test.js --no-coverage` → PASS.

Commit: `feat(checkpoints): shadow-git snapshot + rollback`.

---

## Task 2: Wire snapshot into task finalization

- [x] **Step 1: Modify `task-finalizer.js`**

After the final `updateTaskStatus` succeeds, fire snapshot asynchronously:

```js
try {
  const { snapshotTaskState } = require('../checkpoints/snapshot');
  // Fire-and-forget — checkpoint must not block finalization
  Promise.resolve().then(() => snapshotTaskState({
    project_root: ctx.task.working_directory,
    task_id: taskId,
    task_label: (ctx.task.task_description || '').slice(0, 80),
  })).catch(err => logger.info(`[checkpoints] snapshot failed: ${err.message}`));
} catch { /* module unavailable */ }
```

Commit: `feat(checkpoints): snapshot working tree on task finalization`.

---

## Task 3: MCP tools + docs + smoke

- [ ] **Step 1: Tool defs**

Create `server/tool-defs/checkpoint-defs.js`:

```js
'use strict';
const CHECKPOINT_TOOLS = [
  {
    name: 'list_checkpoints',
    description: 'List all task checkpoints (shadow-git snapshots) for a project.',
    inputSchema: { type: 'object', required: ['project_root'], properties: { project_root: { type: 'string' } } },
  },
  {
    name: 'rollback_task',
    description: 'Restore the working tree to the snapshot from a specific task. Does NOT touch the user-facing main git repo. Irreversible.',
    inputSchema: {
      type: 'object',
      required: ['project_root', 'task_id'],
      properties: {
        project_root: { type: 'string' },
        task_id: { type: 'string' },
      },
    },
  },
];
module.exports = { CHECKPOINT_TOOLS };
```

- [ ] **Step 2: Handler**

Create `server/handlers/checkpoint-handlers.js`:

```js
'use strict';
const { listCheckpoints, rollbackTask } = require('../checkpoints/rollback');

function handleListCheckpoints(args) {
  const checkpoints = listCheckpoints(args.project_root);
  return {
    content: [{ type: 'text', text: `${checkpoints.length} checkpoint(s):\n` + checkpoints.slice(0, 50).map(c => `- ${c.task_id || '(untagged)'} @ ${c.timestamp} — ${c.subject}`).join('\n') }],
    structuredData: { checkpoints },
  };
}

function handleRollbackTask(args) {
  const result = rollbackTask(args);
  if (!result.ok) {
    return { content: [{ type: 'text', text: `Rollback failed: ${result.error}` }], isError: true };
  }
  return {
    content: [{ type: 'text', text: `Restored project to snapshot for task ${args.task_id}` }],
    structuredData: result,
  };
}

module.exports = { handleListCheckpoints, handleRollbackTask };
```

Wire dispatch + REST.

- [ ] **Step 3: Docs + restart + smoke**

Create `docs/checkpoints.md`:

```markdown
# Task Checkpoints

After every task completes, TORQUE snapshots the working tree into a *shadow* git repo at `<project>/.torque-checkpoints/`. The shadow repo is automatically gitignored from your main repo — it never touches your real history.

## Why

- Roll back a single task without disturbing other tasks' work
- Inspect what each task changed via `git diff` on the shadow repo
- Recover from rogue agent behavior even after the task is marked completed

## MCP tools

```
list_checkpoints { project_root: "..." }
rollback_task { project_root: "...", task_id: "..." }
```

## Storage

Each task = one tagged commit in `.torque-checkpoints/`. Tags are `task-<task_id>`. The shadow repo is a regular git repo — you can `cd .torque-checkpoints` and run `git log` to inspect.

## Caveats

- Shadow repo grows over time. Garbage-collection / pruning is not yet automated.
- Rollback restores files but does NOT undo other side effects (DB writes, external API calls, etc.). It only touches the working tree.
```

`await_restart`. Submit a small task, let it finish. Confirm `.torque-checkpoints/.git/` exists. Use `list_checkpoints` to see the snapshot. Modify a file, then `rollback_task` — confirm file restored.

Commit: `docs(checkpoints): shadow-git rollback guide`.
