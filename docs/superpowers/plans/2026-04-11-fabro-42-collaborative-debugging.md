# Fabro #42: Collaborative Debugging Loop (GPT Pilot)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a task fails verify and the auto-retry pipeline can't fix it, escalate to a **collaborative debugging session** instead of giving up: the agent generates reproduction steps for the operator, the operator runs them and reports what they see, the agent proposes a hypothesis, asks for more evidence, then either suggests a fix or hands off back to the operator. Inspired by GPT Pilot's troubleshooter/debugger.

**Architecture:** A new `debug-session-runtime.js` is triggered from auto-verify-retry when N retries fail. It opens a debug session (a stateful object stored in DB) that goes through phases: `reproduce → observe → hypothesize → fix_or_escalate`. The operator interacts with the session via `submit_observation`, `accept_hypothesis`, `request_fix`. Each phase emits events to the journal so a session can be replayed, paused, or resumed in another conversation.

**Tech Stack:** Node.js, better-sqlite3. Builds on plans 14 (events), 27 (state), 29 (journal), 30 (signals), 41 (spec-capture pattern).

---

## File Structure

**New files:**
- `server/migrations/0NN-debug-sessions.sql`
- `server/debugging/debug-session-runtime.js`
- `server/debugging/repro-prompt.js` — builds reproduction-step request
- `server/debugging/hypothesis-prompt.js` — proposes hypothesis from observation
- `server/tests/debug-session-runtime.test.js`
- `dashboard/src/views/DebugSession.jsx`

**Modified files:**
- `server/validation/auto-verify-retry.js` — escalate to debug session after N failures
- `server/handlers/mcp-tools.js` — `start_debug_session`, `submit_observation`, `accept_hypothesis`, `request_fix`

---

## Task 1: Migration + session model

- [ ] **Step 1: Migration**

`server/migrations/0NN-debug-sessions.sql`:

```sql
CREATE TABLE IF NOT EXISTS debug_sessions (
  session_id TEXT PRIMARY KEY,
  task_id TEXT,
  workflow_id TEXT,
  failure_summary TEXT,
  phase TEXT NOT NULL DEFAULT 'reproduce',
  -- 'reproduce' | 'observe' | 'hypothesize' | 'fix_pending' | 'resolved' | 'escalated'
  reproduction_steps_json TEXT,
  observations_json TEXT DEFAULT '[]',
  hypothesis TEXT,
  proposed_fix TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_debug_sessions_phase ON debug_sessions(phase);
CREATE INDEX IF NOT EXISTS idx_debug_sessions_task ON debug_sessions(task_id);
```

Commit: `feat(debugging): debug_sessions table`.

---

## Task 2: Runtime tests + implementation

- [ ] **Step 1: Tests**

Create `server/tests/debug-session-runtime.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createDebugSessionRuntime } = require('../debugging/debug-session-runtime');

describe('debugSessionRuntime', () => {
  let db, runtime, callModel;
  beforeEach(() => {
    db = setupTestDb();
    callModel = vi.fn();
    runtime = createDebugSessionRuntime({ db, callModel });
  });

  it('start creates a session in reproduce phase and asks for repro steps', async () => {
    callModel.mockResolvedValueOnce({
      reproduction_steps: ['Run npm test', 'Note the failing assertion'],
    });
    const id = await runtime.start({ taskId: 't1', failureSummary: 'verify failed: tsc error in foo.ts' });
    const s = runtime.get(id);
    expect(s.phase).toBe('reproduce');
    expect(JSON.parse(s.reproduction_steps_json)).toContain('Run npm test');
  });

  it('submitObservation appends and transitions to hypothesize', async () => {
    callModel.mockResolvedValueOnce({ reproduction_steps: ['x'] });
    callModel.mockResolvedValueOnce({ hypothesis: 'Type narrowing dropped the union' });
    const id = await runtime.start({ taskId: 't1', failureSummary: 'x' });
    await runtime.submitObservation(id, 'I see TS2322 on line 47');
    const s = runtime.get(id);
    expect(s.phase).toBe('hypothesize');
    expect(s.hypothesis).toMatch(/Type narrowing/);
    expect(JSON.parse(s.observations_json)).toEqual(['I see TS2322 on line 47']);
  });

  it('acceptHypothesis transitions to fix_pending and proposes a fix', async () => {
    callModel.mockResolvedValueOnce({ reproduction_steps: ['x'] });
    callModel.mockResolvedValueOnce({ hypothesis: 'h' });
    callModel.mockResolvedValueOnce({ proposed_fix: 'Add type guard at line 47' });

    const id = await runtime.start({ taskId: 't1', failureSummary: 'x' });
    await runtime.submitObservation(id, 'obs');
    await runtime.acceptHypothesis(id);
    const s = runtime.get(id);
    expect(s.phase).toBe('fix_pending');
    expect(s.proposed_fix).toMatch(/type guard/);
  });

  it('rejectHypothesis returns to observe phase', async () => {
    callModel.mockResolvedValueOnce({ reproduction_steps: ['x'] });
    callModel.mockResolvedValueOnce({ hypothesis: 'h1' });
    const id = await runtime.start({ taskId: 't1', failureSummary: 'x' });
    await runtime.submitObservation(id, 'obs1');
    await runtime.rejectHypothesis(id);
    const s = runtime.get(id);
    expect(s.phase).toBe('observe');
    expect(s.hypothesis).toBeNull();
  });

  it('resolve marks session as resolved with timestamp', async () => {
    callModel.mockResolvedValueOnce({ reproduction_steps: ['x'] });
    const id = await runtime.start({ taskId: 't1', failureSummary: 'x' });
    runtime.resolve(id, 'fixed by adding type guard');
    const s = runtime.get(id);
    expect(s.phase).toBe('resolved');
    expect(s.resolved_at).not.toBeNull();
  });

  it('escalate marks session as escalated', () => {
    const id = db.prepare(`INSERT INTO debug_sessions (session_id, task_id, failure_summary, phase) VALUES (?,?,?,?)`)
      .bind('ds_test','t1','f','observe').run() && 'ds_test';
    runtime.escalate(id, 'no progress after 3 hypotheses');
    const s = runtime.get(id);
    expect(s.phase).toBe('escalated');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/debugging/debug-session-runtime.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

const REPRO_PROMPT = `A task failed verification. The operator needs reproduction steps they can run by hand to see the failure. Output strict JSON: {"reproduction_steps":[string,...]}.

Failure summary:
{{failure_summary}}

Recent task description:
{{task_description}}

Be specific. Each step should be a single command or single observation. Aim for 3-7 steps.`;

const HYPOTHESIS_PROMPT = `The operator ran the reproduction steps and observed the following. Propose a single most-likely hypothesis for what is wrong. Output strict JSON: {"hypothesis": "..."}.

Failure summary:
{{failure_summary}}

Reproduction steps:
{{reproduction_steps}}

Observations:
{{observations}}

If you need more observation, set hypothesis to "NEED_MORE_OBSERVATION" and the runtime will ask the operator for more.`;

const FIX_PROMPT = `The operator accepted this hypothesis. Propose a concrete fix as a unified-diff or step-by-step instruction. Output strict JSON: {"proposed_fix": "..."}.

Hypothesis: {{hypothesis}}
Reproduction: {{reproduction_steps}}
Observations: {{observations}}`;

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v, null, 2);
    return String(v ?? '');
  });
}

function createDebugSessionRuntime({ db, callModel, logger = console }) {
  function get(sessionId) {
    return db.prepare('SELECT * FROM debug_sessions WHERE session_id = ?').get(sessionId);
  }

  async function start({ taskId, workflowId = null, failureSummary, taskDescription = '' }) {
    const id = `ds_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO debug_sessions (session_id, task_id, workflow_id, failure_summary, phase)
      VALUES (?, ?, ?, ?, 'reproduce')
    `).run(id, taskId, workflowId, failureSummary);

    const out = await callModel({
      kind: 'reproduce',
      prompt: fillTemplate(REPRO_PROMPT, { failure_summary: failureSummary, task_description: taskDescription }),
    });
    const steps = out?.reproduction_steps || [];
    db.prepare(`UPDATE debug_sessions SET reproduction_steps_json = ? WHERE session_id = ?`)
      .run(JSON.stringify(steps), id);
    return id;
  }

  async function submitObservation(sessionId, text) {
    const s = get(sessionId);
    if (!s) throw new Error('unknown session');
    const observations = s.observations_json ? JSON.parse(s.observations_json) : [];
    observations.push(text);
    db.prepare(`UPDATE debug_sessions SET observations_json = ?, phase = 'observe' WHERE session_id = ?`)
      .run(JSON.stringify(observations), sessionId);

    // Try to form a hypothesis
    const reproSteps = s.reproduction_steps_json ? JSON.parse(s.reproduction_steps_json) : [];
    const out = await callModel({
      kind: 'hypothesize',
      prompt: fillTemplate(HYPOTHESIS_PROMPT, {
        failure_summary: s.failure_summary,
        reproduction_steps: reproSteps,
        observations,
      }),
    });
    const h = out?.hypothesis;
    if (h && h !== 'NEED_MORE_OBSERVATION') {
      db.prepare(`UPDATE debug_sessions SET hypothesis = ?, phase = 'hypothesize' WHERE session_id = ?`).run(h, sessionId);
    }
  }

  async function acceptHypothesis(sessionId) {
    const s = get(sessionId);
    if (!s || !s.hypothesis) throw new Error('no hypothesis to accept');
    const observations = s.observations_json ? JSON.parse(s.observations_json) : [];
    const reproSteps = s.reproduction_steps_json ? JSON.parse(s.reproduction_steps_json) : [];
    const out = await callModel({
      kind: 'fix',
      prompt: fillTemplate(FIX_PROMPT, {
        hypothesis: s.hypothesis, reproduction_steps: reproSteps, observations,
      }),
    });
    db.prepare(`UPDATE debug_sessions SET proposed_fix = ?, phase = 'fix_pending' WHERE session_id = ?`)
      .run(out?.proposed_fix || null, sessionId);
  }

  function rejectHypothesis(sessionId) {
    db.prepare(`UPDATE debug_sessions SET hypothesis = NULL, phase = 'observe' WHERE session_id = ?`).run(sessionId);
  }

  function resolve(sessionId, note) {
    db.prepare(`UPDATE debug_sessions SET phase = 'resolved', resolved_at = datetime('now'), proposed_fix = COALESCE(?, proposed_fix) WHERE session_id = ?`)
      .run(note, sessionId);
  }

  function escalate(sessionId, reason) {
    db.prepare(`UPDATE debug_sessions SET phase = 'escalated', proposed_fix = COALESCE(proposed_fix, ?) WHERE session_id = ?`)
      .run(`Escalated: ${reason}`, sessionId);
  }

  return { start, submitObservation, acceptHypothesis, rejectHypothesis, resolve, escalate, get };
}

module.exports = { createDebugSessionRuntime };
```

Run tests → PASS. Commit: `feat(debugging): session runtime with reproduce/observe/hypothesize/fix phases`.

---

## Task 3: Hook into auto-verify-retry

- [ ] **Step 1: Escalate after N failures**

In `server/validation/auto-verify-retry.js` after the configured retry budget is exhausted:

```js
const config = defaultContainer.get('serverConfig');
const debugThreshold = parseInt(config.get('auto_debug_after_retries') || '3', 10);

if (retryCount >= debugThreshold) {
  const runtime = defaultContainer.get('debugSessionRuntime');
  const sessionId = await runtime.start({
    taskId: task.task_id,
    workflowId: task.workflow_id,
    failureSummary: `Verify failed ${retryCount} times: ${lastError}`,
    taskDescription: task.task_description,
  });
  // Tag the task and emit an event so dashboard can surface
  addTaskTag(task.task_id, 'debug:open');
  defaultContainer.get('journalWriter').write({
    workflowId: task.workflow_id, taskId: task.task_id,
    type: 'debug_session_opened', payload: { session_id: sessionId },
  });
  return; // do not auto-resubmit; wait for human / debug session
}
```

Add `debug_session_opened`, `debug_session_resolved`, `debug_session_escalated` to `VALID_EVENT_TYPES` in `server/journal/journal-writer.js`.

Commit: `feat(debugging): auto-escalate to debug session after N failures`.

---

## Task 4: MCP tools + dashboard

- [ ] **Step 1: Tool defs**

In `server/tool-defs/`:

```js
list_debug_sessions: { description: 'List open debug sessions.', inputSchema: { type: 'object', properties: {} } },
get_debug_session: { description: 'Fetch a debug session by id.', inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' } } } },
submit_observation: {
  description: 'Submit an observation to an open debug session. The agent will attempt to form a hypothesis.',
  inputSchema: { type: 'object', required: ['session_id', 'text'], properties: { session_id: { type: 'string' }, text: { type: 'string' } } },
},
accept_hypothesis: {
  description: 'Accept the current hypothesis. Agent will propose a fix.',
  inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' } } },
},
reject_hypothesis: {
  description: 'Reject the current hypothesis and request a new one based on more observations.',
  inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' } } },
},
resolve_debug_session: {
  description: 'Mark a debug session as resolved.',
  inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, note: { type: 'string' } } },
},
escalate_debug_session: {
  description: 'Escalate a debug session as un-fixable by AI; leave for human follow-up.',
  inputSchema: { type: 'object', required: ['session_id', 'reason'], properties: { session_id: { type: 'string' }, reason: { type: 'string' } } },
},
```

- [ ] **Step 2: Handlers**

```js
case 'list_debug_sessions': {
  const rows = defaultContainer.get('db').prepare(`
    SELECT session_id, task_id, phase, failure_summary, created_at FROM debug_sessions WHERE phase NOT IN ('resolved','escalated') ORDER BY created_at DESC
  `).all();
  return { count: rows.length, sessions: rows };
}
case 'get_debug_session':
  return defaultContainer.get('debugSessionRuntime').get(args.session_id);
case 'submit_observation':
  await defaultContainer.get('debugSessionRuntime').submitObservation(args.session_id, args.text);
  return { ok: true, session: defaultContainer.get('debugSessionRuntime').get(args.session_id) };
case 'accept_hypothesis':
  await defaultContainer.get('debugSessionRuntime').acceptHypothesis(args.session_id);
  return { ok: true, session: defaultContainer.get('debugSessionRuntime').get(args.session_id) };
case 'reject_hypothesis':
  defaultContainer.get('debugSessionRuntime').rejectHypothesis(args.session_id);
  return { ok: true };
case 'resolve_debug_session':
  defaultContainer.get('debugSessionRuntime').resolve(args.session_id, args.note);
  return { ok: true };
case 'escalate_debug_session':
  defaultContainer.get('debugSessionRuntime').escalate(args.session_id, args.reason);
  return { ok: true };
```

- [ ] **Step 3: Container**

```js
container.factory('debugSessionRuntime', (c) => {
  const { createDebugSessionRuntime } = require('./debugging/debug-session-runtime');
  const provider = c.get('providerRegistry').getProviderInstance('codex');
  return createDebugSessionRuntime({
    db: c.get('db'),
    callModel: async ({ prompt }) => {
      const out = await provider.runPrompt({ prompt, format: 'json', max_tokens: 1500 });
      return typeof out === 'string' ? JSON.parse(out) : out;
    },
    logger: c.get('logger'),
  });
});
```

- [ ] **Step 4: Dashboard**

Create `dashboard/src/views/DebugSession.jsx` showing:
- Failure summary at top
- Reproduction steps (numbered list)
- Observation input + history
- Hypothesis with Accept / Reject buttons
- Proposed fix (when present) with Apply / Resolve buttons
- "Escalate as un-fixable" button at bottom

`await_restart`. Smoke: trigger a verify failure 3+ times to open a session, walk through reproduce → observe → hypothesize → fix in the dashboard, mark resolved.

Commit: `feat(debugging): MCP tools + dashboard for collaborative debug sessions`.
