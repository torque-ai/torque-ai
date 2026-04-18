# Scheduler Fixes & One-Time Schedules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two MCP handler bugs (toggle_schedule, cancel_scheduled) and add one-time schedule support (fire at datetime, auto-delete after execution, with workflow support and dashboard UI).

**Architecture:** Extend the existing `scheduled_tasks` table with `schedule_type='once'` using the existing `scheduled_time` column. Reuse the scheduler tick's `getDueScheduledTasks()` query unchanged. Add delay string parsing, a new MCP tool, workflow firing branch in the scheduler, and a datetime picker in the dashboard.

**Tech Stack:** Node.js, better-sqlite3, Vitest, React (dashboard)

**Spec:** `docs/superpowers/specs/2026-03-31-scheduler-fixes-one-time-schedules-design.md`

---

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `server/handlers/advanced/scheduling.js` | MCP handlers for schedules (create_cron, list, toggle) | Modify: fix toggle, add `handleCreateOneTimeSchedule`, update list output |
| `server/handlers/task/operations.js` | MCP handlers for cancel_scheduled, pause_scheduled | Modify: switch from `projectConfigCore` to `schedulingAutomation` |
| `server/db/cron-scheduling.js` | Schedule CRUD, cron parsing, next-run calculation | Modify: add `parseDelay`, `createOneTimeSchedule`, modify `markScheduledTaskRun` and `toggleScheduledTask` |
| `server/db/scheduling-automation.js` | Re-exports from cron-scheduling + other schedule modules | No change needed (auto-re-exports via spread) |
| `server/tool-defs/advanced-defs.js` | MCP tool definitions for advanced tools | Modify: add `create_one_time_schedule` tool definition |
| `server/maintenance/scheduler.js` | Scheduler tick -- fires due schedules | Modify: add workflow branch and origin metadata |
| `server/api/v2-governance-handlers.js` | REST API handlers for dashboard schedule CRUD | Modify: handle `schedule_type='once'` in create |
| `dashboard/src/views/Schedules.jsx` | Schedule list + create form UI | Modify: type toggle, datetime picker, type column |
| `dashboard/src/api.js` | Dashboard API client | No change needed (existing create/toggle/delete work) |
| `server/tests/handler-adv-scheduling.test.js` | Tests for scheduling MCP handlers | Modify: add one-time schedule tests |
| `server/tests/task-operations-handlers.test.js` | Tests for task operation handlers | Modify: verify cancel_scheduled fix |
| `server/tests/maintenance-scheduler.test.js` | Tests for maintenance scheduler | Modify: add workflow firing + origin metadata tests |

---

## Task 1: Fix `toggle_schedule` MCP Handler

**Files:**
- Modify: `server/handlers/advanced/scheduling.js:112-134`
- Test: `server/tests/handler-adv-scheduling.test.js`

- [x] **Step 1: Write a failing test for explicit `enabled: false`**

Add a test that creates an enabled schedule, toggles with `enabled: false`, then verifies calling toggle again with `enabled: false` keeps it disabled (not toggling back).

```js
// In server/tests/handler-adv-scheduling.test.js, inside describe('toggle_schedule')
it('respects explicit enabled: false without toggling', async () => {
  // Create an enabled schedule
  const createResult = await handleToolCall('create_cron_schedule', {
    name: 'explicit-false-test',
    cron_expression: '0 12 * * *',
    task: 'Test explicit false',
  });
  const scheduleId = parseScheduleId(getText(createResult));
  expect(scheduleId).toBeTruthy();

  // Disable it explicitly
  const disableResult = await handleToolCall('toggle_schedule', {
    schedule_id: scheduleId,
    enabled: false,
  });
  expect(disableResult.isError).toBeFalsy();
  expect(getText(disableResult)).toContain('disabled');

  // Call toggle again with enabled: false -- should STAY disabled, not toggle to enabled
  const secondResult = await handleToolCall('toggle_schedule', {
    schedule_id: scheduleId,
    enabled: false,
  });
  expect(secondResult.isError).toBeFalsy();
  expect(getText(secondResult)).toContain('disabled');
});

it('toggles when enabled is omitted', async () => {
  const createResult = await handleToolCall('create_cron_schedule', {
    name: 'omit-toggle-test',
    cron_expression: '0 6 * * *',
    task: 'Test omit toggle',
  });
  const scheduleId = parseScheduleId(getText(createResult));

  // Toggle without enabled param -- should flip from enabled to disabled
  const result = await handleToolCall('toggle_schedule', {
    schedule_id: scheduleId,
  });
  expect(result.isError).toBeFalsy();
  expect(getText(result)).toContain('disabled');
});
```

- [x] **Step 2: Run test to verify failure**

Run: `npx vitest run server/tests/handler-adv-scheduling.test.js --reporter=verbose 2>&1 | tail -30`

Expected: The "respects explicit enabled: false" test may fail if the second call toggles instead of setting. The "toggles when enabled is omitted" test may fail if omitting `enabled` doesn't trigger toggle.

- [x] **Step 3: Fix the handler**

In `server/handlers/advanced/scheduling.js`, replace the `handleToggleSchedule` function:

```js
function handleToggleSchedule(args) {
  const { schedule_id } = args;

  if (!schedule_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'schedule_id is required');
  }

  // Use 'in' check to distinguish "enabled: false" from "enabled not provided"
  const enabled = 'enabled' in args ? Boolean(args.enabled) : undefined;
  const schedule = toggleScheduledTask(schedule_id, enabled);

  if (!schedule) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Schedule not found: ${schedule_id}`);
  }

  const statusEmoji = schedule.enabled ? '\u2705' : '\u274c';
  const statusText = schedule.enabled ? 'enabled' : 'disabled';

  let output = `## Schedule ${statusText.charAt(0).toUpperCase() + statusText.slice(1)}\n\n`;
  output += `${statusEmoji} **${schedule.name}** is now ${statusText}.\n\n`;

  if (schedule.enabled && schedule.next_run_at) {
    output += `**Next Run:** ${new Date(schedule.next_run_at).toLocaleString()}`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/handler-adv-scheduling.test.js --reporter=verbose 2>&1 | tail -30`

Expected: All toggle_schedule tests pass.

- [x] **Step 5: Commit**

```
git add server/handlers/advanced/scheduling.js server/tests/handler-adv-scheduling.test.js
git commit -m "fix(toggle_schedule): respect explicit enabled param via 'in' check"
```

---

## Task 2: Fix `cancel_scheduled` and `pause_scheduled` MCP Handlers

**Files:**
- Modify: `server/handlers/task/operations.js:580-628`
- Test: `server/tests/task-operations-handlers.test.js`

- [x] **Step 1: Run existing cancel_scheduled tests to confirm current state**

Run: `npx vitest run server/tests/task-operations-handlers.test.js -t "cancel_scheduled" --reporter=verbose 2>&1 | tail -20`

Expected: Either passes (if DI is wired in test setup) or fails with "getScheduledTask is not a function".

- [x] **Step 2: Add the scheduling-automation import**

At the top of `server/handlers/task/operations.js`, add:

```js
const schedulingAutomation = require('../../db/scheduling-automation');
```

- [x] **Step 3: Fix `handleCancelScheduled`**

Replace `projectConfigCore.getScheduledTask` and `projectConfigCore.deleteScheduledTask` with `schedulingAutomation.getScheduledTask` and `schedulingAutomation.deleteScheduledTask` in the `handleCancelScheduled` function (around line 580).

```js
function handleCancelScheduled(args) {
  const scheduled = schedulingAutomation.getScheduledTask(args.schedule_id);

  if (!scheduled) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Scheduled task not found: ${args.schedule_id}`);
  }

  const deleted = schedulingAutomation.deleteScheduledTask(args.schedule_id);

  if (deleted) {
    return {
      content: [{
        type: 'text',
        text: `## Scheduled Task Cancelled\n\n**Name:** ${scheduled.name}\n**Ran:** ${scheduled.run_count} times`
      }]
    };
  }

  return makeError(ErrorCodes.OPERATION_FAILED, 'Failed to cancel scheduled task');
}
```

- [x] **Step 4: Fix `handlePauseScheduled`**

Replace `projectConfigCore` calls with `schedulingAutomation` in `handlePauseScheduled` (around line 605):

```js
function handlePauseScheduled(args) {
  if (!args.schedule_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'schedule_id is required');
  }
  if (args.action !== 'pause' && args.action !== 'resume') {
    return makeError(ErrorCodes.INVALID_PARAM, 'action must be "pause" or "resume"');
  }

  const scheduled = schedulingAutomation.getScheduledTask(args.schedule_id);

  if (!scheduled) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Scheduled task not found: ${args.schedule_id}`);
  }

  const newStatus = args.action === 'pause' ? 'paused' : 'active';
  schedulingAutomation.updateScheduledTask(args.schedule_id, { status: newStatus });

  return {
    content: [{
      type: 'text',
      text: `## Scheduled Task ${args.action === 'pause' ? 'Paused' : 'Resumed'}\n\n**Name:** ${scheduled.name}\n**Status:** ${newStatus}`
    }]
  };
}
```

- [x] **Step 5: Run tests**

Run: `npx vitest run server/tests/task-operations-handlers.test.js -t "cancel_scheduled" --reporter=verbose 2>&1 | tail -20`

Expected: All cancel_scheduled and pause_scheduled tests pass.

- [x] **Step 6: Commit**

```
git add server/handlers/task/operations.js
git commit -m "fix(cancel_scheduled): use schedulingAutomation instead of projectConfigCore"
```

---

## Task 3: Add `parseDelay` Utility

**Files:**
- Modify: `server/db/cron-scheduling.js`
- Test: `server/tests/handler-adv-scheduling.test.js`

- [x] **Step 1: Write tests for delay parsing**

Add a new `describe('parseDelay')` block in `server/tests/handler-adv-scheduling.test.js`:

```js
describe('parseDelay', () => {
  let cronScheduling;
  beforeAll(() => {
    cronScheduling = require('../db/cron-scheduling');
  });

  it('parses minutes', () => {
    expect(cronScheduling.parseDelay('30m')).toBe(30 * 60 * 1000);
  });

  it('parses hours', () => {
    expect(cronScheduling.parseDelay('4h')).toBe(4 * 60 * 60 * 1000);
  });

  it('parses days', () => {
    expect(cronScheduling.parseDelay('1d')).toBe(24 * 60 * 60 * 1000);
  });

  it('parses compound durations', () => {
    expect(cronScheduling.parseDelay('2h30m')).toBe(2.5 * 60 * 60 * 1000);
  });

  it('parses complex compound', () => {
    expect(cronScheduling.parseDelay('1d6h')).toBe(30 * 60 * 60 * 1000);
  });

  it('throws on empty string', () => {
    expect(() => cronScheduling.parseDelay('')).toThrow();
  });

  it('throws on invalid format', () => {
    expect(() => cronScheduling.parseDelay('abc')).toThrow();
  });

  it('throws on zero duration', () => {
    expect(() => cronScheduling.parseDelay('0m')).toThrow();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/handler-adv-scheduling.test.js -t "parseDelay" --reporter=verbose 2>&1 | tail -20`

Expected: FAIL -- `cronScheduling.parseDelay is not a function`

- [x] **Step 3: Implement `parseDelay`**

Add to `server/db/cron-scheduling.js`, before the exports section:

```js
/**
 * Parse a delay string into milliseconds.
 * Format: concatenated segments of \d+[dhm]
 * Examples: "30m", "4h", "2h30m", "1d6h"
 * @param {string} delayStr - The delay string to parse
 * @returns {number} Delay in milliseconds
 * @throws {Error} On invalid or zero-duration input
 */
function parseDelay(delayStr) {
  if (typeof delayStr !== 'string' || delayStr.trim().length === 0) {
    throw new Error('DELAY_EMPTY: delay string cannot be empty');
  }

  const pattern = /(\d+)([dhm])/g;
  let totalMs = 0;
  let match;
  let matchCount = 0;

  while ((match = pattern.exec(delayStr)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    matchCount++;

    switch (unit) {
      case 'd': totalMs += value * 24 * 60 * 60 * 1000; break;
      case 'h': totalMs += value * 60 * 60 * 1000; break;
      case 'm': totalMs += value * 60 * 1000; break;
    }
  }

  if (matchCount === 0) {
    throw new Error(`DELAY_INVALID: cannot parse delay string "${delayStr}" -- expected format like "4h", "30m", "2h30m"`);
  }

  if (totalMs <= 0) {
    throw new Error('DELAY_ZERO: delay must be greater than zero');
  }

  return totalMs;
}
```

Add `parseDelay` to the `module.exports` object.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/handler-adv-scheduling.test.js -t "parseDelay" --reporter=verbose 2>&1 | tail -20`

Expected: All parseDelay tests pass.

- [x] **Step 5: Commit**

```
git add server/db/cron-scheduling.js server/tests/handler-adv-scheduling.test.js
git commit -m "feat: add parseDelay utility for one-time schedule relative offsets"
```

---

## Task 4: Add `createOneTimeSchedule` and Modify `markScheduledTaskRun`

**Files:**
- Modify: `server/db/cron-scheduling.js`
- Test: `server/tests/handler-adv-scheduling.test.js`

- [x] **Step 1: Write tests for one-time schedule creation and fire-and-delete**

Add to `server/tests/handler-adv-scheduling.test.js`:

```js
describe('one-time schedule DB functions', () => {
  let cronScheduling;
  beforeAll(() => {
    cronScheduling = require('../db/cron-scheduling');
  });

  it('creates a one-time schedule with run_at', () => {
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    const schedule = cronScheduling.createOneTimeSchedule({
      name: 'one-time-test',
      run_at: futureDate,
      task_config: { task: 'Run once', working_directory: '/tmp' },
    });

    expect(schedule.id).toBeTruthy();
    expect(schedule.schedule_type).toBe('once');
    expect(schedule.name).toBe('one-time-test');
    expect(schedule.next_run_at).toBe(futureDate);
    expect(schedule.enabled).toBe(true);
  });

  it('creates a one-time schedule with delay', () => {
    const before = Date.now();
    const schedule = cronScheduling.createOneTimeSchedule({
      name: 'delay-test',
      delay: '2h',
      task_config: { task: 'Delayed task' },
    });

    const runAt = new Date(schedule.next_run_at).getTime();
    const expectedMin = before + 2 * 60 * 60 * 1000 - 5000; // 5s tolerance
    const expectedMax = before + 2 * 60 * 60 * 1000 + 5000;
    expect(runAt).toBeGreaterThan(expectedMin);
    expect(runAt).toBeLessThan(expectedMax);
  });

  it('rejects past run_at', () => {
    const pastDate = new Date(Date.now() - 120000).toISOString();
    expect(() => cronScheduling.createOneTimeSchedule({
      name: 'past-test',
      run_at: pastDate,
      task_config: { task: 'Should fail' },
    })).toThrow('future');
  });

  it('rejects missing run_at and delay', () => {
    expect(() => cronScheduling.createOneTimeSchedule({
      name: 'no-time',
      task_config: { task: 'Should fail' },
    })).toThrow();
  });

  it('markScheduledTaskRun deletes one-time schedules', () => {
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    const schedule = cronScheduling.createOneTimeSchedule({
      name: 'auto-delete-test',
      run_at: futureDate,
      task_config: { task: 'Delete after run' },
    });

    const result = cronScheduling.markScheduledTaskRun(schedule.id);
    expect(result).toBeNull();

    const fetched = cronScheduling.getScheduledTask(schedule.id);
    expect(fetched).toBeFalsy();
  });

  it('markScheduledTaskRun keeps cron schedules', () => {
    const cron = cronScheduling.createCronScheduledTask({
      name: 'cron-keep-test',
      cron_expression: '0 12 * * *',
      task_config: { task: 'Keep me' },
    });

    const result = cronScheduling.markScheduledTaskRun(cron.id);
    expect(result).toBeTruthy();
    expect(result.run_count).toBe(1);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/handler-adv-scheduling.test.js -t "one-time schedule DB" --reporter=verbose 2>&1 | tail -20`

Expected: FAIL -- `cronScheduling.createOneTimeSchedule is not a function`

- [x] **Step 3: Implement `createOneTimeSchedule`**

Add to `server/db/cron-scheduling.js`, after `createCronScheduledTask`:

```js
/**
 * Create a one-time scheduled task that fires at a specific datetime.
 * Accepts either run_at (ISO 8601) or delay (e.g., "4h", "2h30m").
 * After firing, the schedule is auto-deleted by markScheduledTaskRun.
 */
function createOneTimeSchedule(data) {
  const { v4: uuidv4 } = require('uuid');
  const now = new Date();

  // Resolve run_at from either absolute or relative input
  let runAt;
  if (data.run_at) {
    runAt = new Date(data.run_at);
  } else if (data.delay) {
    const delayMs = parseDelay(data.delay);
    runAt = new Date(now.getTime() + delayMs);
  } else {
    throw new Error('ONE_TIME_NO_TIME: either run_at or delay is required');
  }

  // Validate run_at is in the future (60-second grace window)
  if (runAt.getTime() < now.getTime() - 60000) {
    throw new Error('ONE_TIME_PAST: scheduled time must be in the future');
  }

  const scheduleId = uuidv4();
  const taskConfig = data.task_config || {};
  const runAtIso = runAt.toISOString();

  const stmt = db.prepare(`
    INSERT INTO scheduled_tasks (
      id, name, task_description, working_directory, timeout_minutes,
      auto_approve, schedule_type, cron_expression, scheduled_time, next_run_at,
      enabled, created_at, task_config, updated_at, timezone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const nowIso = now.toISOString();
  stmt.run(
    scheduleId,
    data.name,
    taskConfig.task || 'One-time scheduled task',
    taskConfig.working_directory || null,
    taskConfig.timeout_minutes || 30,
    taskConfig.auto_approve ? 1 : 0,
    'once',
    null,       // no cron_expression for one-time
    runAtIso,   // scheduled_time
    runAtIso,   // next_run_at (so getDueScheduledTasks picks it up)
    data.enabled !== false ? 1 : 0,
    nowIso,
    JSON.stringify(taskConfig),
    nowIso,
    data.timezone || null
  );

  return {
    id: scheduleId,
    name: data.name,
    schedule_type: 'once',
    run_at: runAtIso,
    timezone: data.timezone || null,
    task_config: taskConfig,
    enabled: data.enabled !== false,
    next_run_at: runAtIso,
  };
}
```

- [x] **Step 4: Modify `markScheduledTaskRun` to delete one-time schedules**

Replace the existing `markScheduledTaskRun` function:

```js
function markScheduledTaskRun(id) {
  const now = new Date();
  const schedule = getScheduledTask(id);
  if (!schedule) return null;

  // One-time schedules: delete after firing (no ghost entries)
  if (schedule.schedule_type === 'once') {
    deleteScheduledTask(id);
    return null;
  }

  // Cron schedules: update next_run and increment count
  const nextRun = calculateNextRun(schedule.cron_expression, now, schedule.timezone || null);

  const stmt = db.prepare(`
    UPDATE scheduled_tasks
    SET last_run_at = ?, next_run_at = ?, run_count = run_count + 1, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(now.toISOString(), nextRun ? nextRun.toISOString() : null, now.toISOString(), id);

  return getScheduledTask(id);
}
```

- [x] **Step 5: Add exports**

Add `createOneTimeSchedule` to the `module.exports` in `server/db/cron-scheduling.js`:

```js
module.exports = {
  setDb,
  // ... existing exports ...
  parseDelay,
  createOneTimeSchedule,
  createCronScheduledTask,
  // ... rest of exports ...
};
```

- [x] **Step 6: Run tests**

Run: `npx vitest run server/tests/handler-adv-scheduling.test.js -t "one-time schedule DB" --reporter=verbose 2>&1 | tail -30`

Expected: All one-time schedule DB tests pass.

- [x] **Step 7: Commit**

```
git add server/db/cron-scheduling.js server/tests/handler-adv-scheduling.test.js
git commit -m "feat: add createOneTimeSchedule and auto-delete in markScheduledTaskRun"
```

---

## Task 5: Add `create_one_time_schedule` MCP Tool

**Files:**
- Modify: `server/handlers/advanced/scheduling.js`
- Modify: `server/tool-defs/advanced-defs.js`
- Test: `server/tests/handler-adv-scheduling.test.js`

- [x] **Step 1: Write integration tests for the MCP tool**

Add to `server/tests/handler-adv-scheduling.test.js`:

```js
describe('create_one_time_schedule', () => {
  it('creates a one-time schedule with run_at', async () => {
    const futureDate = new Date(Date.now() + 7200000).toISOString();
    const result = await handleToolCall('create_one_time_schedule', {
      name: 'mcp-one-time',
      run_at: futureDate,
      task: 'One-time MCP test',
      working_directory: '/tmp',
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('One-Time Schedule Created');
    expect(text).toContain('mcp-one-time');
    expect(text).toContain('once');
  });

  it('creates a one-time schedule with delay', async () => {
    const result = await handleToolCall('create_one_time_schedule', {
      name: 'mcp-delay',
      delay: '4h',
      task: 'Delayed MCP test',
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('One-Time Schedule Created');
    expect(text).toContain('mcp-delay');
  });

  it('creates a one-time schedule with workflow_id', async () => {
    const futureDate = new Date(Date.now() + 7200000).toISOString();
    const result = await handleToolCall('create_one_time_schedule', {
      name: 'mcp-workflow',
      run_at: futureDate,
      workflow_id: 'test-workflow-123',
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('One-Time Schedule Created');
    expect(text).toContain('workflow');
  });

  it('rejects when both run_at and delay are provided', async () => {
    const result = await handleToolCall('create_one_time_schedule', {
      name: 'both-time',
      run_at: new Date(Date.now() + 7200000).toISOString(),
      delay: '4h',
      task: 'Should fail',
    });

    expect(result.isError).toBeTruthy();
  });

  it('rejects when neither task nor workflow_id is provided', async () => {
    const result = await handleToolCall('create_one_time_schedule', {
      name: 'no-work',
      delay: '1h',
    });

    expect(result.isError).toBeTruthy();
  });

  it('rejects past run_at', async () => {
    const result = await handleToolCall('create_one_time_schedule', {
      name: 'past-time',
      run_at: new Date(Date.now() - 120000).toISOString(),
      task: 'Should fail',
    });

    expect(result.isError).toBeTruthy();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/handler-adv-scheduling.test.js -t "create_one_time_schedule" --reporter=verbose 2>&1 | tail -20`

Expected: FAIL -- handler not found or tool not defined.

- [x] **Step 3: Add the MCP tool definition**

Add to the array in `server/tool-defs/advanced-defs.js`, after the `toggle_schedule` definition (after line 191):

```js
{
  name: 'create_one_time_schedule',
  description: 'Create a one-time schedule that fires at a specific datetime, executes a task or workflow, then auto-deletes.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Schedule name'
      },
      run_at: {
        type: 'string',
        description: 'ISO 8601 datetime to fire (e.g., "2026-04-01T02:00:00"). Mutually exclusive with delay.'
      },
      delay: {
        type: 'string',
        description: 'Relative delay before firing (e.g., "4h", "30m", "2h30m", "1d"). Mutually exclusive with run_at.'
      },
      task: {
        type: 'string',
        description: 'Task description to execute. Mutually exclusive with workflow_id.'
      },
      workflow_id: {
        type: 'string',
        description: 'Existing workflow ID to run at scheduled time. Mutually exclusive with task.'
      },
      working_directory: {
        type: 'string',
        description: 'Working directory for the task'
      },
      provider: {
        type: 'string',
        description: 'Provider to use (e.g., "<git-user>", "ollama")'
      },
      model: {
        type: 'string',
        description: 'Model to use'
      },
      auto_approve: {
        type: 'boolean',
        description: 'Auto-approve provider actions',
        default: false
      },
      timeout_minutes: {
        type: 'number',
        description: 'Task timeout in minutes',
        default: 30
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone for run_at interpretation (e.g., "America/New_York")'
      }
    },
    required: ['name']
  }
},
```

- [x] **Step 4: Add the handler**

Update the import at the top of `server/handlers/advanced/scheduling.js` to include `createOneTimeSchedule`:

```js
const { createCronScheduledTask, listScheduledTasks, toggleScheduledTask, getResourceUsage, getResourceUsageByProject, setResourceLimits, getResourceReport, createOneTimeSchedule } = require('../../db/scheduling-automation');
```

Add the handler function after `handleToggleSchedule`:

```js
/**
 * Create a one-time scheduled task
 */
function handleCreateOneTimeSchedule(args) {
  const { name, run_at, delay, task, workflow_id, working_directory, provider, model, auto_approve = false, timeout_minutes = 30, timezone } = args;

  // Validate: exactly one of run_at or delay
  if (run_at && delay) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Provide either run_at or delay, not both');
  }
  if (!run_at && !delay) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Either run_at or delay is required');
  }

  // Validate: exactly one of task or workflow_id
  if (task && workflow_id) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Provide either task or workflow_id, not both');
  }
  if (!task && !workflow_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Either task or workflow_id is required');
  }

  try {
    const taskConfig = { task, workflow_id, working_directory, provider, model, auto_approve, timeout_minutes };
    const schedule = createOneTimeSchedule({
      name,
      run_at: run_at || undefined,
      delay: delay || undefined,
      task_config: taskConfig,
      timezone: timezone || null,
    });

    let output = `## One-Time Schedule Created\n\n`;
    output += `**Name:** ${schedule.name}\n`;
    output += `**ID:** ${schedule.id}\n`;
    output += `**Type:** once\n`;
    output += `**Fires At:** ${new Date(schedule.run_at).toLocaleString()}\n`;
    if (schedule.timezone) {
      output += `**Timezone:** ${schedule.timezone}\n`;
    }
    output += `**Status:** ${schedule.enabled ? 'Enabled' : 'Disabled'}\n\n`;

    if (workflow_id) {
      output += `**Workflow:** ${workflow_id}\n`;
    } else {
      output += `**Task:** ${task}\n`;
    }

    if (working_directory) {
      output += `**Working Directory:** ${working_directory}\n`;
    }

    output += `\n*This schedule will auto-delete after firing.*`;

    return {
      content: [{ type: 'text', text: output }]
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to create one-time schedule: ${err.message}`);
  }
}
```

- [x] **Step 5: Export the handler**

Add `handleCreateOneTimeSchedule` to both `createSchedulingHandlers` and `module.exports`:

```js
function createSchedulingHandlers() {
  return {
    handleCreateCronSchedule,
    handleListSchedules,
    handleToggleSchedule,
    handleCreateOneTimeSchedule,
    handleGetResourceUsage,
    handleSetResourceLimits,
    handleResourceReport,
  };
}

module.exports = {
  handleCreateCronSchedule,
  handleListSchedules,
  handleToggleSchedule,
  handleCreateOneTimeSchedule,
  handleGetResourceUsage,
  handleSetResourceLimits,
  handleResourceReport,
  createSchedulingHandlers,
};
```

- [x] **Step 6: Run tests**

Run: `npx vitest run server/tests/handler-adv-scheduling.test.js -t "create_one_time_schedule" --reporter=verbose 2>&1 | tail -30`

Expected: All create_one_time_schedule tests pass.

- [x] **Step 7: Commit**

```
git add server/handlers/advanced/scheduling.js server/tool-defs/advanced-defs.js server/tests/handler-adv-scheduling.test.js
git commit -m "feat: add create_one_time_schedule MCP tool"
```

---

## Task 6: Modify Scheduler Tick for Workflow Firing and Origin Metadata

**Files:**
- Modify: `server/maintenance/scheduler.js:110-137`
- Test: `server/tests/maintenance-scheduler.test.js`

- [x] **Step 1: Read the current test file to understand mock patterns**

Read `server/tests/maintenance-scheduler.test.js` to understand how `buildDb`, `startMaintenanceScheduler`, and mocks are set up. Adapt new tests to match the existing pattern.

- [x] **Step 2: Write tests for origin metadata and workflow firing**

Add tests that verify:
1. Origin metadata (`scheduled_by`, `schedule_name`, `scheduled`) is attached to `createTask` calls
2. When `task_config.workflow_id` exists, a workflow callback is invoked instead of `createTask`

Adapt the mock pattern from existing tests in the file. The key change: `startMaintenanceScheduler` needs an `opts` parameter to receive the `runWorkflow` callback. If the function signature doesn't already accept opts, the test should pass it as a second argument.

```js
it('attaches origin metadata to scheduled tasks', async () => {
  db = buildDb({
    getDueScheduledTasks: vi.fn(() => [{
      id: 'schedule-meta',
      name: 'Metadata test',
      schedule_type: 'cron',
      task_description: 'Test metadata',
      working_directory: '/tmp',
      timeout_minutes: 30,
      task_config: { task: 'Test metadata' },
    }]),
    createTask: vi.fn(),
    markScheduledTaskRun: vi.fn(),
  });
  uuidMock.v4.mockReturnValue('meta-task-1');

  const { startMaintenanceScheduler } = require('../maintenance/scheduler');
  startMaintenanceScheduler(db, {});
  vi.advanceTimersByTime(60000);

  expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({
    metadata: expect.objectContaining({
      scheduled_by: 'schedule-meta',
      schedule_name: 'Metadata test',
      scheduled: true,
    }),
  }));
});

it('runs workflow when workflow_id is in task_config', async () => {
  const runWorkflowMock = vi.fn();
  db = buildDb({
    getDueScheduledTasks: vi.fn(() => [{
      id: 'schedule-wf',
      name: 'Workflow schedule',
      schedule_type: 'once',
      task_description: 'Run workflow',
      task_config: { workflow_id: 'wf-123', working_directory: '/tmp' },
    }]),
    createTask: vi.fn(),
    markScheduledTaskRun: vi.fn(),
  });

  const { startMaintenanceScheduler } = require('../maintenance/scheduler');
  startMaintenanceScheduler(db, { runWorkflow: runWorkflowMock });
  vi.advanceTimersByTime(60000);

  expect(db.createTask).not.toHaveBeenCalled();
  expect(runWorkflowMock).toHaveBeenCalledWith('wf-123', expect.objectContaining({
    scheduled_by: 'schedule-wf',
  }));
});
```

- [x] **Step 3: Modify the scheduler tick**

In `server/maintenance/scheduler.js`, check the function signature of `startMaintenanceScheduler`. If it doesn't already accept an `opts` parameter, add one.

Replace the C-2 block (lines ~110-137):

```js
      // C-2: Execute due user cron scheduled tasks
      try {
        const dueSchedules = db.getDueScheduledTasks();
        for (const schedule of dueSchedules) {
          try {
            const config = schedule.task_config || {};

            // Origin metadata for traceability
            const originMetadata = {
              scheduled_by: schedule.id,
              schedule_name: schedule.name,
              schedule_type: schedule.schedule_type || 'cron',
              scheduled: true,
            };

            if (config.workflow_id) {
              // Workflow firing: mark run first, then invoke callback
              db.markScheduledTaskRun(schedule.id);
              if (typeof opts?.runWorkflow === 'function') {
                opts.runWorkflow(config.workflow_id, originMetadata);
              } else {
                logger.warn(`Scheduled workflow ${config.workflow_id} skipped -- no runWorkflow handler`);
              }
              debugLog(`Executed scheduled workflow "${schedule.name}" -> workflow ${config.workflow_id}`);
            } else {
              // Task firing: create and start a task
              const taskId = require('uuid').v4();
              db.createTask({
                id: taskId,
                task_description: config.task || schedule.task_description || 'Scheduled task',
                working_directory: config.working_directory || schedule.working_directory || null,
                provider: config.provider || null,
                model: config.model || null,
                tags: config.tags || null,
                timeout_minutes: config.timeout_minutes || schedule.timeout_minutes || 30,
                auto_approve: config.auto_approve || false,
                priority: config.priority || 0,
                metadata: originMetadata,
              });
              db.markScheduledTaskRun(schedule.id);
              const taskManager = require('../task-manager');
              taskManager.startTask(taskId);
              debugLog(`Executed scheduled task "${schedule.name}" -> task ${taskId}`);
            }
          } catch (schedErr) {
            logger.error(`Scheduled task execution failed: ${schedErr.message}`);
            debugLog(`Failed to execute scheduled task "${schedule.name}": ${schedErr.message}`);
          }
        }
      } catch (cronErr) {
        debugLog(`Cron schedule check error: ${cronErr.message}`);
      }
```

Make sure the `opts` variable is accessible in the scheduler tick closure. If `startMaintenanceScheduler(db)` is the current signature, change it to `startMaintenanceScheduler(db, opts = {})`.

- [x] **Step 4: Run tests**

Run: `npx vitest run server/tests/maintenance-scheduler.test.js --reporter=verbose 2>&1 | tail -30`

Expected: All tests pass including new ones.

- [x] **Step 5: Commit**

```
git add server/maintenance/scheduler.js server/tests/maintenance-scheduler.test.js
git commit -m "feat: add workflow firing and origin metadata to scheduler tick"
```

---

## Task 7: Update `list_schedules` Output for One-Time Schedules

**Files:**
- Modify: `server/handlers/advanced/scheduling.js:74-103` (handleListSchedules)
- Test: `server/tests/handler-adv-scheduling.test.js`

- [ ] **Step 1: Write test for one-time schedule appearing in list**

```js
describe('list_schedules with one-time', () => {
  it('shows type column and run_at for one-time schedules', async () => {
    await handleToolCall('create_one_time_schedule', {
      name: 'list-once',
      delay: '2h',
      task: 'Listed one-time',
    });

    const result = await handleToolCall('list_schedules', {});
    const text = getText(result);

    expect(result.isError).toBeFalsy();
    expect(text).toContain('list-once');
    expect(text).toContain('Type');
    expect(text).toContain('once');
  });

  it('shows cron type for cron schedules', async () => {
    await handleToolCall('create_cron_schedule', {
      name: 'list-cron',
      cron_expression: '0 0 * * *',
      task: 'Listed cron',
    });

    const result = await handleToolCall('list_schedules', {});
    const text = getText(result);

    expect(result.isError).toBeFalsy();
    expect(text).toContain('list-cron');
    expect(text).toContain('cron');
  });
});
```

- [ ] **Step 2: Update `handleListSchedules`**

Replace the function in `server/handlers/advanced/scheduling.js`:

```js
function handleListSchedules(args) {
  const { enabled_only = false, limit = 50 } = args;

  const schedules = listScheduledTasks({ enabled_only, limit });

  if (schedules.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Scheduled Tasks\n\nNo scheduled tasks found${enabled_only ? ' (enabled only)' : ''}.`
      }]
    };
  }

  let output = `## Scheduled Tasks\n\n`;
  output += `| ID | Name | Type | Schedule | Status | Next Run | Run Count |\n`;
  output += `|----|------|------|----------|--------|----------|----------|\n`;

  for (const s of schedules) {
    const status = s.enabled ? '\u2705 Enabled' : '\u274c Disabled';
    const nextRun = s.next_run_at ? new Date(s.next_run_at).toLocaleString() : '-';
    const schedType = s.schedule_type || 'cron';
    const scheduleCol = schedType === 'once'
      ? (s.scheduled_time ? new Date(s.scheduled_time).toLocaleString() : nextRun)
      : `\`${s.cron_expression}\``;
    output += `| ${s.id} | ${s.name} | ${schedType} | ${scheduleCol} | ${status} | ${nextRun} | ${s.run_count} |\n`;
  }

  output += `\n**Total:** ${schedules.length} schedule(s)`;

  return {
    content: [{ type: 'text', text: output }]
  };
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run server/tests/handler-adv-scheduling.test.js -t "list_schedules" --reporter=verbose 2>&1 | tail -20`

Expected: All list_schedules tests pass.

- [ ] **Step 4: Commit**

```
git add server/handlers/advanced/scheduling.js server/tests/handler-adv-scheduling.test.js
git commit -m "feat: show schedule type and run_at in list_schedules output"
```

---

## Task 8: Update `toggleScheduledTask` for One-Time Schedules

**Files:**
- Modify: `server/db/cron-scheduling.js:431-451`
- Test: `server/tests/handler-adv-scheduling.test.js`

- [ ] **Step 1: Write test for toggling one-time schedules**

```js
describe('toggle one-time schedule', () => {
  it('preserves run_at when re-enabling a one-time schedule', async () => {
    const futureDate = new Date(Date.now() + 7200000).toISOString();
    const createResult = await handleToolCall('create_one_time_schedule', {
      name: 'toggle-once',
      run_at: futureDate,
      task: 'Toggle test',
    });
    const scheduleId = parseScheduleId(getText(createResult));

    // Disable
    await handleToolCall('toggle_schedule', { schedule_id: scheduleId, enabled: false });

    // Re-enable
    const result = await handleToolCall('toggle_schedule', { schedule_id: scheduleId, enabled: true });
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain('enabled');

    // Verify next_run_at is still the original run_at
    const schedule = schedulingAutomation.getScheduledTask(scheduleId);
    expect(schedule.next_run_at).toBe(futureDate);
  });
});
```

- [ ] **Step 2: Update `toggleScheduledTask`**

Replace in `server/db/cron-scheduling.js`:

```js
function toggleScheduledTask(id, enabled) {
  const now = new Date().toISOString();
  const schedule = getScheduledTask(id);
  if (!schedule) return null;

  const newEnabled = enabled !== undefined ? enabled : !schedule.enabled;

  // Recalculate next_run for cron schedules when enabling
  // For one-time schedules, keep the original scheduled_time
  let nextRun = schedule.next_run_at;
  if (newEnabled && !schedule.enabled) {
    if (schedule.schedule_type === 'once') {
      nextRun = schedule.scheduled_time || schedule.next_run_at;
    } else {
      const next = calculateNextRun(schedule.cron_expression, new Date(), schedule.timezone || null);
      nextRun = next ? next.toISOString() : null;
    }
  }

  const stmt = db.prepare(`
    UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(newEnabled ? 1 : 0, nextRun, now, id);

  return getScheduledTask(id);
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run server/tests/handler-adv-scheduling.test.js --reporter=verbose 2>&1 | tail -30`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```
git add server/db/cron-scheduling.js server/tests/handler-adv-scheduling.test.js
git commit -m "feat: toggle preserves run_at for one-time schedules"
```

---

## Task 9: Update REST API for One-Time Schedules

**Files:**
- Modify: `server/api/v2-governance-handlers.js:152-182`

- [ ] **Step 1: Update `handleCreateSchedule`**

Replace the function to support both cron and one-time creation. This also fixes the existing bug where `createCronScheduledTask` was called with positional args instead of an object:

```js
async function handleCreateSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const name = (body.name || '').trim();
  if (!name) {
    return sendError(res, requestId, 'validation_error', 'name is required', 400, undefined, req);
  }

  const scheduleType = body.schedule_type || 'cron';

  try {
    let schedule;

    if (scheduleType === 'once') {
      if (!body.run_at && !body.delay) {
        return sendError(res, requestId, 'validation_error', 'run_at or delay is required for one-time schedules', 400, undefined, req);
      }
      if (!body.task_description && !body.workflow_id) {
        return sendError(res, requestId, 'validation_error', 'task_description or workflow_id is required', 400, undefined, req);
      }

      schedule = schedulingAutomation.createOneTimeSchedule({
        name,
        run_at: body.run_at || undefined,
        delay: body.delay || undefined,
        task_config: {
          task: body.task_description || null,
          workflow_id: body.workflow_id || null,
          provider: body.provider || null,
          model: body.model || null,
          working_directory: body.working_directory || null,
        },
        timezone: body.timezone || null,
      });
    } else {
      if (!body.cron_expression) {
        return sendError(res, requestId, 'validation_error', 'cron_expression is required', 400, undefined, req);
      }
      if (!body.task_description) {
        return sendError(res, requestId, 'validation_error', 'task_description is required', 400, undefined, req);
      }

      schedule = schedulingAutomation.createCronScheduledTask({
        name,
        cron_expression: body.cron_expression,
        task_config: {
          task: body.task_description,
          provider: body.provider || null,
          model: body.model || null,
          working_directory: body.working_directory || null,
        },
        timezone: body.timezone || null,
      });
    }

    sendSuccess(res, requestId, schedule, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}
```

- [ ] **Step 2: Run existing dashboard tests**

Run: `npx vitest run server/tests/dashboard-admin-routes.test.js --reporter=verbose 2>&1 | tail -20`

Expected: Existing tests still pass. Some may need adjustment if they relied on the old positional-args signature.

- [ ] **Step 3: Commit**

```
git add server/api/v2-governance-handlers.js
git commit -m "feat: REST API supports one-time schedule creation"
```

---

## Task 10: Dashboard UI -- Schedule Type Toggle and Datetime Picker

**Files:**
- Modify: `dashboard/src/views/Schedules.jsx`

This is a full-file rewrite since changes touch most of the component. See the spec for the complete JSX. Key changes:

1. **Form state**: Add `schedule_type` and `run_at` fields
2. **Type toggle**: Cron/One-Time segmented button in the form
3. **Conditional fields**: Cron expression input when type=cron, `<input type="datetime-local">` when type=once
4. **Validation**: Check cron or run_at depending on type, reject past dates for one-time
5. **Create payload**: Include `schedule_type` and either `cron_expression` or `run_at`
6. **Table Type column**: New column between Name and Schedule showing "Cron"/"Once" badge
7. **Schedule column**: Show cron expression for cron, formatted datetime for one-time
8. **Column count**: Update empty-state `colSpan` to 7

- [ ] **Step 1: Update form state**

Change the initial `form` state (line 47):

```jsx
const [form, setForm] = useState({
  name: '',
  schedule_type: 'cron',
  cron_expression: '',
  run_at: '',
  task_description: '',
  provider: '',
  model: '',
  working_directory: '',
});
```

- [ ] **Step 2: Update validation and create handler**

Replace `handleCreate` to validate based on schedule_type and send the correct payload.

- [ ] **Step 3: Update form JSX**

Add type toggle (Cron | One-Time segmented button). Show cron input when cron, datetime-local input when once. Use `[color-scheme:dark]` class on the datetime input for dark mode compatibility.

- [ ] **Step 4: Update table**

Add Type column header. In each row, show a colored badge (blue for Cron, purple for Once). Update the Schedule column to show formatted datetime for one-time schedules. Update colSpan to 7.

- [ ] **Step 5: Reset form on submit**

Update the form reset in handleCreate to include the new fields.

- [ ] **Step 6: Build verification**

Run: `cd dashboard && npm run build 2>&1 | tail -10`

Expected: Build succeeds.

- [ ] **Step 7: Commit**

```
git add dashboard/src/views/Schedules.jsx
git commit -m "feat: dashboard schedule type toggle, datetime picker, and type column"
```

---

## Task 11: Full Test Suite Verification

- [ ] **Step 1: Run all scheduler-related tests**

```
npx vitest run server/tests/handler-adv-scheduling.test.js server/tests/task-operations-handlers.test.js server/tests/maintenance-scheduler.test.js --reporter=verbose 2>&1 | tail -40
```

Expected: All tests pass.

- [ ] **Step 2: Run full server test suite**

```
npx vitest run server/tests/ --reporter=verbose 2>&1 | tail -40
```

Expected: No regressions.

- [ ] **Step 3: Fix any regressions and commit**

Only if Step 2 found issues:
```
git add -A
git commit -m "fix: address test regressions from scheduler changes"
```
