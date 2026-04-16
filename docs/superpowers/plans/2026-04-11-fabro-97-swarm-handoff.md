# Fabro #97: Function-Return-Agent Handoff (Swarm)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a tool/function return **a reference to another agent** to transfer control. The crew runtime detects the handoff, swaps the active specialist, preserves shared `context_variables`, and continues the conversation. Inspired by OpenAI's Swarm.

**Architecture:** A new `createHandoff(agentName, { contextPatch })` helper returns a sentinel object `{ __handoff: true, agent, contextPatch }`. The crew runner (Plan 26 crew/flow, Plan 88 crew-router) inspects every tool return — if it's a handoff, it updates `activeAgent`, merges `contextPatch` into shared `contextVariables`, and routes the next turn to the new specialist. Loop detection limits handoff chains.

**Tech Stack:** Node.js. Extends Plan 26 (crew-flow-split) + Plan 88 (crew-router). No new deps.

---

## File Structure

**New files:**
- `server/crew/handoff.js`
- `server/crew/context-variables.js`
- `server/tests/handoff.test.js`
- `server/tests/context-variables.test.js`

**Modified files:**
- `server/crew/crew-runner.js` (Plan 26) — inspect tool returns, swap agent
- `server/handlers/mcp-tools.js` — `create_handoff_agent`, `get_handoff_history`

---

## Task 1: Handoff sentinel + context variables

- [x] **Step 1: Tests**

Create `server/tests/handoff.test.js`:

```js
'use strict';
import { describe, it, expect } from 'vitest';
const { createHandoff, isHandoff } = require('../crew/handoff');

describe('handoff', () => {
  it('createHandoff returns a tagged sentinel', () => {
    const h = createHandoff('billing-agent');
    expect(isHandoff(h)).toBe(true);
    expect(h.agent).toBe('billing-agent');
    expect(h.contextPatch).toEqual({});
  });

  it('createHandoff accepts a contextPatch', () => {
    const h = createHandoff('sales-agent', { contextPatch: { plan: 'pro' } });
    expect(h.contextPatch).toEqual({ plan: 'pro' });
  });

  it('isHandoff rejects plain objects', () => {
    expect(isHandoff({ agent: 'x' })).toBe(false);
    expect(isHandoff(null)).toBe(false);
    expect(isHandoff('string')).toBe(false);
  });

  it('createHandoff requires an agent name', () => {
    expect(() => createHandoff('')).toThrow(/agent/);
    expect(() => createHandoff(null)).toThrow(/agent/);
  });
});
```

Create `server/tests/context-variables.test.js`:

```js
'use strict';
import { describe, it, expect } from 'vitest';
const { createContextVariables } = require('../crew/context-variables');

describe('contextVariables', () => {
  it('get/set simple keys', () => {
    const cv = createContextVariables({ user: 'alice' });
    expect(cv.get('user')).toBe('alice');
    cv.set('user', 'bob');
    expect(cv.get('user')).toBe('bob');
  });

  it('merge applies a patch', () => {
    const cv = createContextVariables({ a: 1, b: 2 });
    cv.merge({ b: 3, c: 4 });
    expect(cv.snapshot()).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('snapshot returns a copy (mutating snapshot does not affect state)', () => {
    const cv = createContextVariables({ a: 1 });
    const s = cv.snapshot();
    s.a = 99;
    expect(cv.get('a')).toBe(1);
  });

  it('history tracks merges in order', () => {
    const cv = createContextVariables();
    cv.merge({ a: 1 });
    cv.merge({ b: 2 });
    expect(cv.history()).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
```

- [x] **Step 2: Implement**

Create `server/crew/handoff.js`:

```js
'use strict';

const HANDOFF_TAG = Symbol.for('torque.crew.handoff');

function createHandoff(agent, { contextPatch = {} } = {}) {
  if (!agent || typeof agent !== 'string') throw new Error('createHandoff: agent name required');
  return { [HANDOFF_TAG]: true, __handoff: true, agent, contextPatch };
}

function isHandoff(x) {
  return !!(x && typeof x === 'object' && x[HANDOFF_TAG] === true);
}

module.exports = { createHandoff, isHandoff, HANDOFF_TAG };
```

Create `server/crew/context-variables.js`:

```js
'use strict';

function createContextVariables(initial = {}) {
  let state = { ...initial };
  const log = [];

  return {
    get: (k) => state[k],
    set: (k, v) => { state[k] = v; },
    merge: (patch) => { state = { ...state, ...patch }; log.push({ ...patch }); },
    snapshot: () => ({ ...state }),
    history: () => log.slice(),
  };
}

module.exports = { createContextVariables };
```

Run tests → PASS. Commit: `feat(crew): handoff sentinel + context-variables primitive`.

---

## Task 2: Crew-runner integration + loop guard

- [ ] **Step 1: Runner integration test**

Create `server/tests/crew-handoff-runner.test.js`:

```js
'use strict';
import { describe, it, expect } from 'vitest';
const { runCrewTurn } = require('../crew/crew-runner'); // already exists from Plan 26
const { createHandoff } = require('../crew/handoff');

describe('crew-runner handoff', () => {
  it('swaps active agent when a tool returns a handoff', async () => {
    const agents = {
      triage: { tools: { route: async () => createHandoff('billing', { contextPatch: { issue: 'refund' } }) } },
      billing: { tools: { respond: async (_, ctx) => `billing saw issue=${ctx.get('issue')}` } },
    };
    const state = { activeAgent: 'triage', contextVariables: require('../crew/context-variables').createContextVariables() };
    // First turn: triage calls "route" → handoff to billing
    const turn1 = await runCrewTurn({ agents, state, toolCall: { name: 'route', args: {} } });
    expect(turn1.activeAgent).toBe('billing');
    expect(state.contextVariables.get('issue')).toBe('refund');
    // Second turn: billing responds
    const turn2 = await runCrewTurn({ agents, state, toolCall: { name: 'respond', args: {} } });
    expect(turn2.result).toMatch(/billing.*refund/);
  });

  it('loop guard aborts after > maxHandoffs in one turn chain', async () => {
    const agents = {
      a: { tools: { bounce: async () => createHandoff('b') } },
      b: { tools: { bounce: async () => createHandoff('a') } },
    };
    const state = { activeAgent: 'a', contextVariables: require('../crew/context-variables').createContextVariables() };
    const run = () => runCrewTurn({ agents, state, toolCall: { name: 'bounce', args: {} }, chainAutomatically: true, maxHandoffs: 5 });
    await expect(run()).rejects.toThrow(/handoff/i);
  });
});
```

- [ ] **Step 2: Patch crew-runner**

In `server/crew/crew-runner.js`, after invoking a tool:

```js
const { isHandoff } = require('./handoff');

// inside runCrewTurn, after: const result = await agent.tools[toolCall.name](toolCall.args, state.contextVariables);
if (isHandoff(result)) {
  state.activeAgent = result.agent;
  if (result.contextPatch) state.contextVariables.merge(result.contextPatch);
  state.handoffHistory = state.handoffHistory || [];
  state.handoffHistory.push({ from: agent.name, to: result.agent, at: Date.now(), patch: result.contextPatch });
  if (opts.chainAutomatically) {
    if (state.handoffHistory.length > (opts.maxHandoffs ?? 10)) {
      throw new Error(`handoff chain exceeded maxHandoffs=${opts.maxHandoffs ?? 10}`);
    }
    // Continue with the new agent's next turn (model decides its next tool call)
  }
  return { activeAgent: result.agent, handedOff: true };
}
return { activeAgent: state.activeAgent, result };
```

Run tests → PASS. Commit: `feat(crew): handoff-aware crew-runner + loop guard`.

---

## Task 3: MCP surface

- [ ] **Step 1: Register tools**

In `server/handlers/mcp-tools.js`:

```js
create_handoff_agent: {
  description: 'Declare a named agent that other agents can hand off to. Registers tool wrappers that return createHandoff() sentinels.',
  inputSchema: {
    type: 'object',
    required: ['name', 'system_prompt'],
    properties: {
      name: { type: 'string' },
      system_prompt: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
    },
  },
},
get_handoff_history: {
  description: 'Return the handoff chain for a given workflow/task.',
  inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } },
},
```

- [ ] **Step 2: Smoke**

Start TORQUE → register `triage` and `billing` handoff agents via MCP → run a crew turn where triage calls a routing tool → confirm activeAgent switches and context merges.

Commit: `feat(crew): MCP surface for handoff-agent registration + history query`.
