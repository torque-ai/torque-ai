# Fabro #88: First-Class Router for Crew Networks (AgentKit)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade Plan 26 (Crew/Flow Split) with an explicit **router** primitive that chooses the next agent each turn — either deterministic (code), LLM-driven (an agent decides), or hybrid (code filters candidates, LLM picks). Lets a crew move between planned delegation and autonomous hand-off without swapping runtime models. Inspired by Inngest AgentKit's `createRoutingAgent`.

**Architecture:** Plan 26's `runCrew` gains a `router` parameter. Three router factories are provided:
- `codeRouter((state, turn) => agentName | null)` — deterministic
- `llmRouter(agent)` — a dedicated routing agent is asked to pick next speaker
- `hybridRouter({ shortlist: codeFn, chooser: llmAgent })` — code narrows, LLM picks

Each router has access to: shared state (Plan 27), turn history, message counts per agent, last agent result. Returning `null` stops the crew.

**Tech Stack:** Node.js, existing Plan 26 crew runtime. Builds on plans 23 (signatures), 26 (crew), 27 (state), 47 (memory).

---

## File Structure

**New files:**
- `server/crew/routers.js` — code/llm/hybrid factories
- `server/tests/crew-routers.test.js`

**Modified files:**
- `server/crew/crew-runtime.js` (Plan 26) — accept `router` parameter; default to round-robin when absent
- `server/tool-defs/workflow-defs.js` — extend `crew.mode` to include `router: {...}`
- `server/handlers/mcp-tools.js` — expose `create_hybrid_router`

---

## Task 1: Routers

- [ ] **Step 1: Tests**

Create `server/tests/crew-routers.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { codeRouter, llmRouter, hybridRouter, roundRobinRouter } = require('../crew/routers');

describe('routers', () => {
  const roles = [{ name: 'planner' }, { name: 'critic' }, { name: 'writer' }];

  describe('codeRouter', () => {
    it('picks next agent from user-supplied function', async () => {
      const r = codeRouter((state, turn) => turn.turn_count === 0 ? 'planner' : 'writer');
      const first = await r.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      const second = await r.pick({ roles, state: {}, turn: { turn_count: 1, history: [] } });
      expect(first).toBe('planner');
      expect(second).toBe('writer');
    });

    it('returning null stops the crew', async () => {
      const r = codeRouter(() => null);
      expect(await r.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } })).toBeNull();
    });

    it('returning unknown agent name throws', async () => {
      const r = codeRouter(() => 'bogus');
      await expect(r.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } })).rejects.toThrow(/bogus/);
    });
  });

  describe('roundRobinRouter', () => {
    it('cycles through roles in order', async () => {
      const r = roundRobinRouter();
      const seq = [];
      for (let i = 0; i < 5; i++) {
        seq.push(await r.pick({ roles, state: {}, turn: { turn_count: i, history: [] } }));
      }
      expect(seq).toEqual(['planner', 'critic', 'writer', 'planner', 'critic']);
    });
  });

  describe('llmRouter', () => {
    it('asks the routing agent and returns its choice', async () => {
      const callAgent = vi.fn(async () => ({ content: '{"next_agent":"critic"}' }));
      const r = llmRouter({ name: 'router', callAgent });
      const choice = await r.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      expect(choice).toBe('critic');
    });

    it('returns null when routing agent says stop', async () => {
      const callAgent = vi.fn(async () => ({ content: '{"next_agent":null, "reason":"done"}' }));
      const r = llmRouter({ name: 'router', callAgent });
      const choice = await r.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      expect(choice).toBeNull();
    });

    it('malformed router response returns null + logs warning', async () => {
      const callAgent = vi.fn(async () => ({ content: 'not json' }));
      const logger = { warn: vi.fn() };
      const r = llmRouter({ name: 'router', callAgent, logger });
      const choice = await r.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      expect(choice).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('hybridRouter', () => {
    it('shortlist narrows to 1 → returns that agent without consulting LLM', async () => {
      const chooser = vi.fn(async () => ({ content: '{"next_agent":"writer"}' }));
      const r = hybridRouter({
        shortlist: (state, turn) => ['planner'],
        chooser: { callAgent: chooser },
      });
      const choice = await r.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      expect(choice).toBe('planner');
      expect(chooser).not.toHaveBeenCalled();
    });

    it('shortlist has multiple → chooser picks among them', async () => {
      const chooser = vi.fn(async () => ({ content: '{"next_agent":"critic"}' }));
      const r = hybridRouter({
        shortlist: () => ['critic', 'writer'],
        chooser: { callAgent: chooser },
      });
      const choice = await r.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } });
      expect(choice).toBe('critic');
      expect(chooser).toHaveBeenCalled();
    });

    it('shortlist empty → stop', async () => {
      const r = hybridRouter({ shortlist: () => [], chooser: { callAgent: vi.fn() } });
      expect(await r.pick({ roles, state: {}, turn: { turn_count: 0, history: [] } })).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Implement**

Create `server/crew/routers.js`:

```js
'use strict';

function codeRouter(fn) {
  return {
    kind: 'code',
    async pick({ roles, state, turn }) {
      const name = await fn(state, turn);
      if (name === null || name === undefined) return null;
      if (!roles.find(r => r.name === name)) throw new Error(`codeRouter returned unknown agent: ${name}`);
      return name;
    },
  };
}

function roundRobinRouter() {
  return {
    kind: 'round_robin',
    async pick({ roles, turn }) {
      return roles[turn.turn_count % roles.length].name;
    },
  };
}

function llmRouter({ name = 'router', callAgent, logger = console }) {
  return {
    kind: 'llm',
    async pick({ roles, state, turn }) {
      const prompt = `You are the turn router for a multi-agent crew. Choose which agent should speak next, or stop the crew.

Available agents:
${roles.map(r => `- ${r.name}${r.description ? ': ' + r.description : ''}`).join('\n')}

Current state:
${JSON.stringify(state).slice(0, 2000)}

Recent turns (most recent last):
${(turn.history || []).slice(-6).map(h => `- ${h.agent}: ${JSON.stringify(h.output).slice(0, 200)}`).join('\n')}

Respond with strict JSON: { "next_agent": "<name>" | null, "reason": "..." }.
Return null when the crew's objective is complete or further turns would add nothing.`;
      let res;
      try { res = await callAgent({ prompt }); }
      catch (err) { logger.warn?.('llmRouter call failed', err); return null; }
      let parsed;
      try { parsed = JSON.parse(res.content); }
      catch { logger.warn?.('llmRouter response not JSON', { content: res.content }); return null; }
      if (parsed.next_agent === null || parsed.next_agent === undefined) return null;
      if (!roles.find(r => r.name === parsed.next_agent)) {
        logger.warn?.('llmRouter picked unknown agent', { name: parsed.next_agent });
        return null;
      }
      return parsed.next_agent;
    },
  };
}

function hybridRouter({ shortlist, chooser, logger = console }) {
  return {
    kind: 'hybrid',
    async pick({ roles, state, turn }) {
      const narrow = await shortlist(state, turn);
      if (!narrow || narrow.length === 0) return null;
      if (narrow.length === 1) return narrow[0];
      const candidates = roles.filter(r => narrow.includes(r.name));
      const llm = llmRouter({ callAgent: chooser.callAgent, logger });
      return llm.pick({ roles: candidates, state, turn });
    },
  };
}

module.exports = { codeRouter, llmRouter, hybridRouter, roundRobinRouter };
```

Run tests → PASS. Commit: `feat(crew): code/llm/hybrid/round-robin router factories`.

---

## Task 2: Wire into crew runtime

- [ ] **Step 1: Update crew-runtime.js**

In `server/crew/crew-runtime.js` (from Plan 26) — accept optional `router`:

```js
async function runCrew({ objective, roles, mode = 'round_robin', max_rounds = 5, output_schema, router = null, callRole }) {
  const { roundRobinRouter } = require('./routers');
  const activeRouter = router || roundRobinRouter();
  const validate = output_schema ? ajv.compile(output_schema) : null;
  const history = [];

  for (let turn_count = 0; turn_count < max_rounds * roles.length; turn_count++) {
    const nextAgentName = await activeRouter.pick({ roles, state: history.reduce(reducer, {}), turn: { turn_count, history } });
    if (nextAgentName === null) {
      return { terminated_by: 'router_stopped', rounds: turn_count, history, final_output: history[history.length - 1]?.output || null };
    }
    const role = roles.find(r => r.name === nextAgentName);
    const result = await callRole({ role, history, objective });
    history.push({ role: role.name, agent: role.name, turn_count, output: result.output });
    if (validate && validate(result.output)) {
      return { terminated_by: 'output_matched_schema', rounds: turn_count + 1, history, final_output: result.output };
    }
  }
  return { terminated_by: 'max_rounds', rounds: max_rounds, history, final_output: history[history.length - 1]?.output || null };
}

function reducer(state, turn) { return { ...state, [turn.role]: turn.output }; }
```

- [ ] **Step 2: Extend `kind: crew` config**

In `server/tool-defs/workflow-defs.js` add to the `crew` schema:

```js
router: {
  type: 'object',
  description: 'Optional router config. mode=code → provide code_fn (JS source); mode=llm → provide agent_model; mode=hybrid → both.',
  properties: {
    mode: { type: 'string', enum: ['code', 'llm', 'hybrid', 'round_robin'] },
    code_fn: { type: 'string', description: 'JS function source body; receives (state, turn) → string | null' },
    agent_model: { type: 'string' },
    agent_provider: { type: 'string' },
  },
},
```

When `router.mode === 'code'`, the runtime evaluates `code_fn` as a sandboxed function (Plan 75 sandbox or restricted `vm` context) — never shell-interpolated. `mode: llm` delegates to a router agent call via the same provider dispatch. `mode: hybrid` combines them.

- [ ] **Step 3: Document modes**

Update `docs/crew-flow.md` (from Plan 26) with a new section:

````markdown
## Router modes

The `router` field controls which agent speaks next each turn.

- `round_robin` (default) — cycles through roles in order
- `code` — a JS function you provide decides each turn
- `llm` — a routing agent picks next speaker
- `hybrid` — code narrows to N candidates, LLM picks among them

```yaml
- node_id: plan
  kind: crew
  crew:
    objective: ...
    roles: [ { name: planner }, { name: critic }, { name: writer } ]
    max_rounds: 8
    router:
      mode: hybrid
      code_fn: |
        // Must produce a list of candidate names, or [] to stop.
        if (turn.turn_count === 0) return ['planner'];
        const last = turn.history[turn.history.length - 1];
        if (last?.role === 'writer') return ['critic'];
        return ['writer', 'critic'];
      agent_model: gpt-5.3-codex-spark
```
````

`await_restart`. Smoke: crew with 3 roles + hybrid router that says "planner first, then always alternate critic/writer until critic marks done". Confirm router picks match the expected sequence.

Commit: `feat(crew): wire router into runCrew + extend config schema + docs`.
