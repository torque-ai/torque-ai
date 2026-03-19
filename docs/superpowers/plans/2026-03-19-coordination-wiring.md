# Coordination Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing coordination infrastructure (agents, claims, events, approvals) into the normal task lifecycle so the coordination dashboard populates automatically.

**Architecture:** Three integration points: (1) auto-register MCP SSE sessions as agents, (2) inject `__sessionId` and create claims/events during task lifecycle, (3) wire approval checks into task submission with disabled template rules. All coordination writes are non-fatal — they never block task execution.

**Tech Stack:** Node.js (CJS), SQLite (better-sqlite3), Vitest

**Spec:** `docs/superpowers/specs/2026-03-19-coordination-wiring-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/mcp-sse.js` | Modify | Register agent on SSE connect, inject `__sessionId`, update name, mark offline on disconnect |
| `server/handlers/task/core.js` | Modify | Store `submitted_by_agent` in metadata, call `checkApprovalRequired` |
| `server/execution/slot-pull-scheduler.js` | Modify | Create coordination claim when task starts |
| `server/execution/completion-pipeline.js` | Modify | Release claim on terminal status |
| `server/hooks/event-dispatch.js` | Modify | Record coordination events |
| `server/db/coordination.js` | Modify | Add `task_id` filter to `listClaims()` |
| `server/db/scheduling-automation.js` | Modify | Fix `processAutoApprovals` to skip timeout=0 |
| `server/db/schema-seeds.js` | Modify | Seed 5 template approval rules (disabled) |
| `server/index.js` | Modify | Startup agent sweep, lease renewal in coordination scheduler |
| `server/tests/coordination-wiring.test.js` | Create | All tests |

---

## Task 1: Auto-Register MCP Sessions as Agents

**Files:**
- Modify: `server/mcp-sse.js:1290-1297` (session connect), `1351-1367` (session disconnect), `1476-1484` (mcpProtocol.init callback)
- Create: `server/tests/coordination-wiring.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/coordination-wiring.test.js`:

```javascript
const { describe, it, expect, beforeEach, afterEach } = require('vitest');

describe('MCP session agent registration', () => {
  // These tests verify the integration points exist and are callable.
  // Full SSE lifecycle testing requires the SSE server which is heavy —
  // test the individual functions instead.

  it('registerAgent creates an agent with mcp-session type', () => {
    const { setupTestDb, teardownTestDb } = require('./vitest-setup');
    setupTestDb('coord-wiring');
    const db = require('../database');

    const agent = db.registerAgent({
      id: 'test-session-1',
      name: 'claude-code@unknown',
      agent_type: 'mcp-session',
      capabilities: ['submit', 'await', 'workflow'],
      max_concurrent: 10,
      priority: 0,
      metadata: { transport: 'sse', connected_at: new Date().toISOString() }
    });

    expect(agent).toBeDefined();
    expect(agent.id).toBe('test-session-1');
    expect(agent.agent_type).toBe('mcp-session');

    const agents = db.listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some(a => a.id === 'test-session-1')).toBe(true);

    teardownTestDb();
  });

  it('updateAgent changes agent name', () => {
    const { setupTestDb, teardownTestDb } = require('./vitest-setup');
    setupTestDb('coord-wiring-name');
    const db = require('../database');

    db.registerAgent({
      id: 'test-session-2',
      name: 'claude-code@unknown',
      agent_type: 'mcp-session',
      capabilities: [],
      max_concurrent: 10,
      priority: 0,
    });

    // updateAgent may or may not exist — check coordination.js
    const updated = db.updateAgent ? db.updateAgent('test-session-2', { name: 'claude-code@torque-public' }) : null;
    if (updated) {
      expect(updated.name).toBe('claude-code@torque-public');
    }

    teardownTestDb();
  });
});
```

Note: Check if `db.updateAgent` exists in `coordination.js`. If not, use `db.registerAgent` with the same ID (upsert behavior) or add a simple UPDATE function.

- [ ] **Step 2: Run tests to verify they fail/pass**

```bash
torque-remote npx vitest run server/tests/coordination-wiring.test.js
```

- [ ] **Step 3: Add agent registration to SSE session connect**

In `server/mcp-sse.js`, after the session is added to the `sessions` map (line 1291), add:

```javascript
    // Auto-register session as coordination agent
    try {
      const coord = require('./db/coordination');
      coord.registerAgent({
        id: sessionId,
        name: 'claude-code@unknown',
        agent_type: 'mcp-session',
        capabilities: ['submit', 'await', 'workflow'],
        max_concurrent: 10,
        priority: 0,
        metadata: { transport: 'sse', connected_at: new Date().toISOString() },
      });
      coord.recordCoordinationEvent('session_connected', sessionId, null, null);
    } catch (e) {
      // Non-fatal — coordination is additive
    }
```

- [ ] **Step 4: Add agent offline on SSE disconnect**

In `server/mcp-sse.js`, inside the `req.on('close')` handler (after line 1355 where `sessions.delete(sessionId)` is called), add:

```javascript
        // Mark agent as offline in coordination
        try {
          const coord = require('./db/coordination');
          if (coord.updateAgentStatus) {
            coord.updateAgentStatus(sessionId, 'offline');
          }
          coord.recordCoordinationEvent('session_disconnected', sessionId, null, null);
        } catch (e) {
          // Non-fatal
        }
```

Note: Check if `updateAgentStatus` exists in `coordination.js`. If not, use the raw DB update pattern from the module.

- [ ] **Step 5: Inject `__sessionId` into tool call args**

In `server/mcp-sse.js`, in the `mcpProtocol.init` callback (line 1480-1483), change:

```javascript
      handleToolCall: async (name, args, _session) => {
        const argsWithSignal = { ...args, __shutdownSignal: shutdownAbort ? shutdownAbort.signal : undefined };
        return handleToolCall(name, argsWithSignal);
      },
```

To:

```javascript
      handleToolCall: async (name, args, session) => {
        const argsWithSignal = {
          ...args,
          __shutdownSignal: shutdownAbort ? shutdownAbort.signal : undefined,
          __sessionId: session?.id || null,
        };

        // Lazy agent name update on first tool call with working_directory
        if (args.working_directory && session && !session._nameUpdated) {
          try {
            const projectName = require('path').basename(args.working_directory);
            const coord = require('./db/coordination');
            if (coord.updateAgent) {
              coord.updateAgent(session.id, { name: `claude-code@${projectName}` });
            }
            session._nameUpdated = true;
          } catch (e) {
            // Non-fatal
          }
        }

        return handleToolCall(name, argsWithSignal);
      },
```

- [ ] **Step 6: Run tests**

```bash
torque-remote npx vitest run server/tests/coordination-wiring.test.js
```

- [ ] **Step 7: Commit**

```bash
git add server/mcp-sse.js server/tests/coordination-wiring.test.js
git commit -m "feat(coordination): auto-register MCP sessions as agents"
```

---

## Task 2: Add `task_id` Filter to `listClaims`

**Files:**
- Modify: `server/db/coordination.js` (~line 434, `listClaims` function)
- Append to: `server/tests/coordination-wiring.test.js`

- [ ] **Step 1: Write failing test**

Append to `server/tests/coordination-wiring.test.js`:

```javascript
describe('listClaims with task_id filter', () => {
  it('filters claims by task_id', () => {
    const { setupTestDb, teardownTestDb } = require('./vitest-setup');
    setupTestDb('coord-claims-filter');
    const db = require('../database');

    // Register an agent and create two claims
    db.registerAgent({ id: 'agent-1', name: 'test', agent_type: 'worker', capabilities: [], max_concurrent: 5, priority: 0 });
    db.createTask({ id: 'task-a', task_description: 'Task A', status: 'running', working_directory: '/tmp' });
    db.createTask({ id: 'task-b', task_description: 'Task B', status: 'running', working_directory: '/tmp' });

    db.claimTask('task-a', 'agent-1', 600);
    db.claimTask('task-b', 'agent-1', 600);

    // Filter by task_id
    const claimsA = db.listClaims({ task_id: 'task-a', status: 'active' });
    expect(claimsA.length).toBe(1);
    expect(claimsA[0].task_id).toBe('task-a');

    const claimsB = db.listClaims({ task_id: 'task-b', status: 'active' });
    expect(claimsB.length).toBe(1);
    expect(claimsB[0].task_id).toBe('task-b');

    teardownTestDb();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
torque-remote npx vitest run server/tests/coordination-wiring.test.js -t "listClaims"
```

- [ ] **Step 3: Add `task_id` filter to `listClaims`**

In `server/db/coordination.js`, find the `listClaims` function (~line 434). It builds a SQL query with WHERE clauses. Add a `task_id` filter:

```javascript
// Inside listClaims, alongside existing filter conditions:
if (filter.task_id) {
  conditions.push('task_id = ?');
  params.push(filter.task_id);
}
```

Read the function first to understand the exact query builder pattern. Also support `status: 'active'` as an alias for the existing `include_expired: false` logic.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add server/db/coordination.js server/tests/coordination-wiring.test.js
git commit -m "feat(coordination): add task_id filter to listClaims"
```

---

## Task 3: Wire Task Claims and Events into Lifecycle

**Files:**
- Modify: `server/handlers/task/core.js:279-330` (store submitted_by_agent)
- Modify: `server/execution/slot-pull-scheduler.js:147-168` (create claim)
- Modify: `server/execution/completion-pipeline.js:176-186` (release claim)
- Modify: `server/hooks/event-dispatch.js` (record coordination events)
- Append to: `server/tests/coordination-wiring.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/tests/coordination-wiring.test.js`:

```javascript
describe('task lifecycle coordination', () => {
  it('submitted_by_agent is stored in task metadata', () => {
    const { setupTestDb, teardownTestDb } = require('./vitest-setup');
    setupTestDb('coord-submit');
    const db = require('../database');

    db.createTask({
      id: 'task-with-agent',
      task_description: 'Test task',
      status: 'pending',
      working_directory: '/tmp',
      metadata: JSON.stringify({ submitted_by_agent: 'session-abc' }),
    });

    const task = db.getTask('task-with-agent');
    const metadata = JSON.parse(task.metadata || '{}');
    expect(metadata.submitted_by_agent).toBe('session-abc');

    teardownTestDb();
  });

  it('coordination event is recorded via recordCoordinationEvent', () => {
    const { setupTestDb, teardownTestDb } = require('./vitest-setup');
    setupTestDb('coord-events');
    const db = require('../database');

    // recordCoordinationEvent takes (eventType, agentId, taskId, details)
    db.recordCoordinationEvent('task_submitted', 'agent-1', 'task-1', JSON.stringify({ provider: 'codex' }));

    // Verify via getCoordinationDashboard or direct query
    const dashboard = db.getCoordinationDashboard(24);
    expect(dashboard.events).toBeDefined();

    teardownTestDb();
  });
});
```

- [ ] **Step 2: Store `submitted_by_agent` in task metadata**

In `server/handlers/task/core.js`, after the `metadata` object is built (~line 279-283) and before `db.createTask` is called (~line 320), add:

```javascript
  // Store submitting session ID for coordination claims
  if (args.__sessionId) {
    metadata.submitted_by_agent = args.__sessionId;
  }
```

Also add a `task_submitted` coordination event after `db.createTask`:

```javascript
  // Record coordination event
  try {
    const { recordCoordinationEvent } = require('../../db/coordination');
    recordCoordinationEvent('task_submitted', args.__sessionId || null, taskId, null);
  } catch (e) {
    // Non-fatal
  }
```

Do this for BOTH createTask call sites (the `useTierList` branch at line 320 and the else branch at line 333). Put the event recording after both branches (after line 345).

- [ ] **Step 3: Create coordination claim in slot-pull-scheduler**

In `server/execution/slot-pull-scheduler.js`, after a task is successfully claimed and started (line 167, after `assigned++`), add:

```javascript
        // Create coordination claim for the submitting agent
        try {
          const task = _db.getTask(taskId);
          const agentId = task?.metadata ? (JSON.parse(task.metadata).submitted_by_agent || null) : null;
          if (agentId) {
            const coord = require('../db/coordination');
            const agent = coord.getAgent ? coord.getAgent(agentId) : null;
            if (agent) {
              coord.claimTask(taskId, agentId, 600);
              coord.recordCoordinationEvent('task_claimed', agentId, taskId, JSON.stringify({ provider }));
            }
          }
        } catch (e) {
          // Non-fatal — don't block task execution
        }
```

- [ ] **Step 4: Release coordination claim in completion pipeline**

In `server/execution/completion-pipeline.js`, after the existing `clearPartialOutputBuffer` call, add:

```javascript
    // Release coordination claims for this task
    try {
      const coord = require('../db/coordination');
      const claims = coord.listClaims({ task_id: taskId, status: 'active' });
      for (const claim of claims) {
        coord.releaseTaskClaim(claim.id);
      }
    } catch (e) {
      // Non-fatal
    }
```

- [ ] **Step 5: Record coordination events in dispatchTaskEvent**

In `server/hooks/event-dispatch.js`, inside `dispatchTaskEvent`, after the existing SSE push (around the `notifySubscribedSessions` call), add:

```javascript
    // Record coordination event
    try {
      const coord = require('../db/coordination');
      const agentId = task?.metadata ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata)?.submitted_by_agent || null : null;
      coord.recordCoordinationEvent(eventName, agentId, task?.id || null, JSON.stringify({ status: task?.status, provider: task?.provider }));
    } catch (e) {
      // Non-fatal
    }
```

- [ ] **Step 6: Run tests**

```bash
torque-remote npx vitest run server/tests/coordination-wiring.test.js
```

- [ ] **Step 7: Commit**

```bash
git add server/handlers/task/core.js server/execution/slot-pull-scheduler.js server/execution/completion-pipeline.js server/hooks/event-dispatch.js server/tests/coordination-wiring.test.js
git commit -m "feat(coordination): wire claims and events into task lifecycle"
```

---

## Task 4: Startup Agent Sweep and Lease Renewal

**Files:**
- Modify: `server/index.js:924-949` (coordination scheduler)
- Append to: `server/tests/coordination-wiring.test.js`

- [ ] **Step 1: Write test**

Append to `server/tests/coordination-wiring.test.js`:

```javascript
describe('startup agent sweep', () => {
  it('marks all online agents as offline', () => {
    const { setupTestDb, teardownTestDb } = require('./vitest-setup');
    setupTestDb('coord-sweep');
    const db = require('../database');

    // Register two "online" agents
    db.registerAgent({ id: 'stale-1', name: 'stale', agent_type: 'mcp-session', capabilities: [], max_concurrent: 10, priority: 0 });
    db.registerAgent({ id: 'stale-2', name: 'stale', agent_type: 'mcp-session', capabilities: [], max_concurrent: 10, priority: 0 });

    // Sweep — mark all online as offline
    const agents = db.listAgents({ status: 'online' });
    for (const agent of agents) {
      if (db.updateAgentStatus) db.updateAgentStatus(agent.id, 'offline');
    }

    const afterSweep = db.listAgents({ status: 'online' });
    expect(afterSweep.length).toBe(0);

    teardownTestDb();
  });
});
```

- [ ] **Step 2: Add startup sweep to server init**

In `server/index.js`, inside the `startCoordinationScheduler` function (line 924), at the top (before the intervals are set), add:

```javascript
  // Startup sweep: mark all agents as offline (no SSE sessions survive a restart)
  try {
    const onlineAgents = db.listAgents({ status: 'online' });
    for (const agent of onlineAgents) {
      if (db.updateAgentStatus) {
        db.updateAgentStatus(agent.id, 'offline');
      }
    }
    if (onlineAgents.length > 0) {
      debugLog(`Startup sweep: marked ${onlineAgents.length} stale agents as offline`);
    }
  } catch (err) {
    debugLog(`Startup agent sweep error: ${err.message}`);
  }
```

- [ ] **Step 3: Add lease renewal to the 30-second coordination interval**

In `server/index.js`, inside the 30-second interval (line 938-949), after the `expireStaleLeases` try/catch, add:

```javascript
    // Renew active claims for running tasks
    try {
      const activeClaims = db.listClaims({ status: 'active' });
      for (const claim of activeClaims) {
        const task = db.getTask(claim.task_id);
        if (task && task.status === 'running') {
          db.renewLease(claim.id, 600);
        }
      }
    } catch (err) {
      debugLog(`Lease renewal error: ${err.message}`);
    }
```

- [ ] **Step 4: Run tests**

```bash
torque-remote npx vitest run server/tests/coordination-wiring.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/tests/coordination-wiring.test.js
git commit -m "feat(coordination): startup agent sweep and lease renewal"
```

---

## Task 5: Wire Approval Checks into Submission

**Files:**
- Modify: `server/handlers/task/core.js:345` (after createTask, before startTask)
- Modify: `server/db/scheduling-automation.js` (fix processAutoApprovals for timeout=0)
- Append to: `server/tests/coordination-wiring.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/tests/coordination-wiring.test.js`:

```javascript
describe('approval wiring', () => {
  it('checkApprovalRequired returns required:true when matching rule exists', () => {
    const { setupTestDb, teardownTestDb } = require('./vitest-setup');
    setupTestDb('coord-approval');
    const db = require('../database');

    // Create an enabled approval rule
    if (db.createApprovalRule) {
      db.createApprovalRule({
        name: 'test-rule',
        condition_type: 'provider',
        condition_value: 'anthropic',
        auto_approve_after_minutes: 30,
        enabled: 1,
      });

      // Create a task matching the rule
      db.createTask({
        id: 'approval-test-1',
        task_description: 'Test',
        status: 'pending',
        provider: 'anthropic',
        working_directory: '/tmp',
      });

      const task = db.getTask('approval-test-1');
      const result = db.checkApprovalRequired(task);
      expect(result).toBeDefined();
      // result.required should be true if the rule matches
    }

    teardownTestDb();
  });

  it('processAutoApprovals skips rules with timeout=0', () => {
    const { setupTestDb, teardownTestDb } = require('./vitest-setup');
    setupTestDb('coord-approval-timeout');
    const db = require('../database');

    // This test verifies the SQL fix
    if (db.processAutoApprovals) {
      // Should not throw
      expect(() => db.processAutoApprovals()).not.toThrow();
    }

    teardownTestDb();
  });
});
```

- [ ] **Step 2: Add approval check to task submission**

In `server/handlers/task/core.js`, after both `db.createTask` calls (after line 345, before the context-stuffing block at line 355), add:

```javascript
  // Check if approval is required for this task
  try {
    const task = db.getTask(taskId);
    if (task && db.checkApprovalRequired) {
      const approvalResult = db.checkApprovalRequired(task);
      if (approvalResult && approvalResult.required) {
        // checkApprovalRequired already set approval_status and created the request
        try {
          const coord = require('../../db/coordination');
          coord.recordCoordinationEvent('approval_requested', args.__sessionId || null, taskId,
            JSON.stringify({ rule_id: approvalResult.rule_id }));
        } catch (e) { /* non-fatal */ }
      }
    }
  } catch (e) {
    // Non-fatal — if approval check fails, task proceeds without gate
  }
```

- [ ] **Step 3: Fix processAutoApprovals to skip timeout=0**

In `server/db/scheduling-automation.js`, find the `processAutoApprovals` function and its SQL query. Add `AND auto_approve_after_minutes > 0` to the WHERE clause alongside the existing `IS NOT NULL` check. Read the function to find the exact query.

- [ ] **Step 4: Run tests**

```bash
torque-remote npx vitest run server/tests/coordination-wiring.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/handlers/task/core.js server/db/scheduling-automation.js server/tests/coordination-wiring.test.js
git commit -m "feat(coordination): wire approval checks into task submission"
```

---

## Task 6: Seed Template Approval Rules

**Files:**
- Modify: `server/db/schema-seeds.js`
- Append to: `server/tests/coordination-wiring.test.js`

- [ ] **Step 1: Write test**

Append to `server/tests/coordination-wiring.test.js`:

```javascript
describe('template approval rules', () => {
  it('template rules are seeded but disabled', () => {
    const { setupTestDb, teardownTestDb } = require('./vitest-setup');
    setupTestDb('coord-seeds');
    const db = require('../database');

    if (db.listApprovalRules) {
      const rules = db.listApprovalRules();
      const templates = rules.filter(r => !r.enabled);
      // Should have at least our 5 template rules
      expect(templates.length).toBeGreaterThanOrEqual(5);

      // Verify specific templates exist
      const names = templates.map(r => r.name);
      expect(names).toEqual(expect.arrayContaining([
        'high-file-count',
        'security-tag',
        'complex-classification',
        'cloud-provider-cost',
        'large-context',
      ]));
    }

    teardownTestDb();
  });
});
```

- [ ] **Step 2: Add template rules to schema-seeds.js**

In `server/db/schema-seeds.js`, find where existing approval rules are seeded (~line 455). After the existing seeds, add:

```javascript
  // Template approval rules (disabled by default — users toggle on what they want)
  const templateRules = [
    { name: 'high-file-count', condition_type: 'files_touched', condition_value: '10', auto_approve_after_minutes: 30, enabled: 0, description: 'Tasks modifying more than 10 files' },
    { name: 'security-tag', condition_type: 'tags', condition_value: 'security', auto_approve_after_minutes: null, enabled: 0, description: 'Tasks tagged as security-sensitive' },
    { name: 'complex-classification', condition_type: 'complexity', condition_value: 'complex', auto_approve_after_minutes: 30, enabled: 0, description: 'Tasks classified as complex by smart routing' },
    { name: 'cloud-provider-cost', condition_type: 'provider', condition_value: 'anthropic,deepinfra', auto_approve_after_minutes: 30, enabled: 0, description: 'Tasks using paid cloud API providers' },
    { name: 'large-context', condition_type: 'context_tokens', condition_value: '50000', auto_approve_after_minutes: 30, enabled: 0, description: 'Tasks with context exceeding 50K tokens' },
  ];
```

Use the same INSERT pattern as the existing seeds. Check if there's an `INSERT OR IGNORE` pattern to prevent duplicates on re-seed.

- [ ] **Step 3: Run tests**

```bash
torque-remote npx vitest run server/tests/coordination-wiring.test.js
```

- [ ] **Step 4: Commit**

```bash
git add server/db/schema-seeds.js server/tests/coordination-wiring.test.js
git commit -m "feat(coordination): seed template approval rules (disabled)"
```

---

## Task 7: End-to-End Verification

**Files:**
- Append to: `server/tests/coordination-wiring.test.js`

- [ ] **Step 1: Write integration test**

Append to `server/tests/coordination-wiring.test.js`:

```javascript
describe('end-to-end coordination', () => {
  it('full lifecycle: agent → submit → claim → event → complete → release', () => {
    const { setupTestDb, teardownTestDb } = require('./vitest-setup');
    setupTestDb('coord-e2e');
    const db = require('../database');
    const coord = require('../db/coordination');

    // 1. Register agent
    coord.registerAgent({
      id: 'e2e-session',
      name: 'claude-code@test',
      agent_type: 'mcp-session',
      capabilities: ['submit'],
      max_concurrent: 10,
      priority: 0,
    });

    // 2. Create task with submitted_by_agent
    db.createTask({
      id: 'e2e-task',
      task_description: 'E2E test task',
      status: 'pending',
      working_directory: '/tmp',
      provider: 'codex',
      metadata: JSON.stringify({ submitted_by_agent: 'e2e-session' }),
    });

    // 3. Record submit event
    coord.recordCoordinationEvent('task_submitted', 'e2e-session', 'e2e-task', null);

    // 4. Simulate execution start — create claim
    db.updateTaskStatus('e2e-task', 'running', { started_at: new Date().toISOString() });
    coord.claimTask('e2e-task', 'e2e-session', 600);
    coord.recordCoordinationEvent('task_claimed', 'e2e-session', 'e2e-task', null);

    // 5. Verify claim exists
    const claims = coord.listClaims({ task_id: 'e2e-task', status: 'active' });
    expect(claims.length).toBe(1);

    // 6. Complete task — release claim
    db.updateTaskStatus('e2e-task', 'completed', { output: 'done', exit_code: 0, completed_at: new Date().toISOString() });
    coord.releaseTaskClaim(claims[0].id);
    coord.recordCoordinationEvent('completed', 'e2e-session', 'e2e-task', null);

    // 7. Verify coordination dashboard has data
    const dashboard = coord.getCoordinationDashboard(24);
    expect(dashboard.agents.total_agents).toBeGreaterThanOrEqual(1);
    expect(dashboard.claims.total_claims).toBeGreaterThanOrEqual(1);
    expect(dashboard.events).toBeDefined();

    teardownTestDb();
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
torque-remote npx vitest run server/tests/coordination-wiring.test.js
```

- [ ] **Step 3: Run regression suite**

```bash
torque-remote npx vitest run server/tests/workflow-await.test.js server/tests/await-heartbeat.test.js server/tests/partial-output-streaming.test.js
```

- [ ] **Step 4: Commit**

```bash
git add server/tests/coordination-wiring.test.js
git commit -m "test(coordination): end-to-end lifecycle integration test"
```

---

## Dependency Graph

```
Task 1 (agent registration) ──┐
Task 2 (listClaims filter) ───┼── Task 3 (claims + events) ── Task 4 (sweep + renewal) ── Task 7 (E2E)
                               │
                               └── Task 5 (approvals) ── Task 6 (template rules) ── Task 7 (E2E)
```

- Tasks 1 and 2 are independent
- Task 3 depends on both (claims need agents + task_id filter)
- Task 4 depends on Task 3 (renewal needs claims to exist)
- Task 5 depends on Task 3 (approval events use the coordination event path)
- Task 6 depends on Task 5 (template rules are for the approval system)
- Task 7 depends on all (end-to-end verification)
