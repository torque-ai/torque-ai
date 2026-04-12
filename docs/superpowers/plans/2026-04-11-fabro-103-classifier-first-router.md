# Fabro #103: Classifier-First Turn Router (Agents Squad)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a **front-door classifier** that decides which specialist agent (or Plan 26 crew) should own the next **end-user turn**, based on the user input plus cross-agent conversation history. Couple it with **per-specialist ChatStorage scoping** and an **orchestrator-owned streaming/fallback layer**. Inspired by AWS Labs' Agent Squad.

**Architecture:** Plan 88 (crew-router) picks *next speaker inside a crew*. Plan 103 sits *above* that: it picks which specialist owns the current user turn. Three modules:
1. `turn-classifier.js` — takes `{ userInput, globalHistory, agents }` and returns `{ agent_id, confidence }`. Adapter-based (heuristic / llm-bedrock / llm-anthropic / llm-openai).
2. `specialist-storage.js` — per-agent transcript scoped by `(user_id, session_id, agent_id)`, while the classifier reads a global cross-agent view.
3. `routed-orchestrator.js` — owns `routeTurn()`: classify, dispatch, stream, persist both specialist and global transcripts, fallback to a default agent.

**Tech Stack:** Node.js. Extends Plans 26 + 88. Reuses existing provider layer.

---

## File Structure

**New files:**
- `server/routing/turn-classifier.js`
- `server/routing/specialist-storage.js`
- `server/routing/routed-orchestrator.js`
- `server/migrations/0XX-specialist-chat-history.sql`
- `server/tests/turn-classifier.test.js`
- `server/tests/specialist-storage.test.js`
- `server/tests/routed-orchestrator.test.js`

**Modified files:**
- `server/container.js` — register `routedOrchestrator`
- `server/handlers/mcp-tools.js` — `register_specialist`, `route_turn`, `get_session_history`

---

## Task 1: Classifier + storage

- [ ] **Step 1: Classifier tests**

Create `server/tests/turn-classifier.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createTurnClassifier } = require('../routing/turn-classifier');

const AGENTS = [
  { id: 'billing', description: 'Handles invoices, refunds, and billing disputes.' },
  { id: 'support', description: 'General technical support for account issues.' },
  { id: 'sales', description: 'Product questions, pricing, upgrades.' },
];

describe('turnClassifier (heuristic adapter)', () => {
  it('routes refund phrasing to billing', async () => {
    const c = createTurnClassifier({ adapter: 'heuristic' });
    const { agent_id } = await c.classify({ userInput: 'I want a refund for my last invoice', history: [], agents: AGENTS });
    expect(agent_id).toBe('billing');
  });

  it('routes login issues to support', async () => {
    const c = createTurnClassifier({ adapter: 'heuristic' });
    const { agent_id } = await c.classify({ userInput: 'I cannot log in to my account', history: [], agents: AGENTS });
    expect(agent_id).toBe('support');
  });

  it('follow-up "again" prefers the previous specialist', async () => {
    const c = createTurnClassifier({ adapter: 'heuristic' });
    const history = [
      { role: 'user', content: 'refund please', agent_id: 'billing' },
      { role: 'assistant', content: 'ok, done', agent_id: 'billing' },
    ];
    const { agent_id } = await c.classify({ userInput: 'again', history, agents: AGENTS });
    expect(agent_id).toBe('billing');
  });

  it('llm adapter delegates to provided classifier fn', async () => {
    const c = createTurnClassifier({ adapter: 'llm', classifyFn: async () => ({ agent_id: 'sales', confidence: 0.9 }) });
    expect((await c.classify({ userInput: 'pricing?', history: [], agents: AGENTS })).agent_id).toBe('sales');
  });

  it('returns null agent_id when no heuristic matches', async () => {
    const c = createTurnClassifier({ adapter: 'heuristic' });
    const out = await c.classify({ userInput: 'xyz unrelated phrase qqq', history: [], agents: AGENTS });
    expect(out.agent_id).toBeNull();
  });
});
```

- [ ] **Step 2: Implement classifier**

Create `server/routing/turn-classifier.js`:

```js
'use strict';

const HEURISTIC_RULES = [
  { agent_id: 'billing', keywords: ['refund', 'invoice', 'charge', 'billing', 'payment'] },
  { agent_id: 'support', keywords: ['login', 'cannot', 'error', 'broken', 'password', 'support'] },
  { agent_id: 'sales', keywords: ['price', 'pricing', 'upgrade', 'plan', 'sales'] },
];

function heuristicClassify({ userInput, history, agents }) {
  const text = (userInput || '').toLowerCase();
  if (/^(again|tell me more|more|continue)$/i.test(userInput.trim())) {
    const last = [...history].reverse().find(m => m.agent_id);
    if (last) return { agent_id: last.agent_id, confidence: 0.6 };
  }
  for (const rule of HEURISTIC_RULES) {
    if (rule.keywords.some(k => text.includes(k)) && agents.find(a => a.id === rule.agent_id)) {
      return { agent_id: rule.agent_id, confidence: 0.8 };
    }
  }
  return { agent_id: null, confidence: 0 };
}

function createTurnClassifier({ adapter = 'heuristic', classifyFn } = {}) {
  return {
    async classify(args) {
      if (adapter === 'heuristic') return heuristicClassify(args);
      if (adapter === 'llm') {
        if (typeof classifyFn !== 'function') throw new Error('llm adapter requires classifyFn');
        return classifyFn(args);
      }
      throw new Error(`unknown adapter: ${adapter}`);
    },
  };
}

module.exports = { createTurnClassifier };
```

- [ ] **Step 3: Storage tests**

Create `server/tests/specialist-storage.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/setup-test-db');
const { createSpecialistStorage } = require('../routing/specialist-storage');

describe('specialistStorage', () => {
  let db, s;
  beforeEach(() => {
    db = setupTestDb(['0XX-specialist-chat-history.sql']);
    s = createSpecialistStorage({ db });
  });

  it('append + readSpecialist isolates per-agent transcripts', () => {
    s.append({ user_id: 'u1', session_id: 's1', agent_id: 'billing', role: 'user', content: 'refund' });
    s.append({ user_id: 'u1', session_id: 's1', agent_id: 'support', role: 'user', content: 'login issue' });
    expect(s.readSpecialist({ user_id: 'u1', session_id: 's1', agent_id: 'billing' })).toHaveLength(1);
    expect(s.readSpecialist({ user_id: 'u1', session_id: 's1', agent_id: 'support' })[0].content).toBe('login issue');
  });

  it('readGlobal returns cross-agent history for a session in order', () => {
    s.append({ user_id: 'u1', session_id: 's1', agent_id: 'billing', role: 'user', content: 'a' });
    s.append({ user_id: 'u1', session_id: 's1', agent_id: 'support', role: 'user', content: 'b' });
    const global = s.readGlobal({ user_id: 'u1', session_id: 's1' });
    expect(global.map(m => m.content)).toEqual(['a', 'b']);
  });

  it('readGlobal is scoped to the session (does not leak other sessions)', () => {
    s.append({ user_id: 'u1', session_id: 's1', agent_id: 'billing', role: 'user', content: 'here' });
    s.append({ user_id: 'u1', session_id: 's2', agent_id: 'billing', role: 'user', content: 'there' });
    const g = s.readGlobal({ user_id: 'u1', session_id: 's1' });
    expect(g.map(m => m.content)).toEqual(['here']);
  });
});
```

- [ ] **Step 4: Schema + implement**

Create `server/migrations/0XX-specialist-chat-history.sql`:

```sql
CREATE TABLE specialist_chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_spec_history_session ON specialist_chat_history(user_id, session_id, created_at);
CREATE INDEX idx_spec_history_agent   ON specialist_chat_history(user_id, session_id, agent_id, created_at);
```

Create `server/routing/specialist-storage.js`:

```js
'use strict';

function createSpecialistStorage({ db }) {
  return {
    append({ user_id, session_id, agent_id, role, content }) {
      db.prepare(`
        INSERT INTO specialist_chat_history (user_id, session_id, agent_id, role, content, created_at)
        VALUES (?,?,?,?,?,?)
      `).run(user_id, session_id, agent_id, role, content, Date.now());
    },
    readSpecialist({ user_id, session_id, agent_id, limit = 100 }) {
      return db.prepare(`
        SELECT * FROM specialist_chat_history WHERE user_id=? AND session_id=? AND agent_id=? ORDER BY created_at ASC LIMIT ?
      `).all(user_id, session_id, agent_id, limit);
    },
    readGlobal({ user_id, session_id, limit = 200 }) {
      return db.prepare(`
        SELECT * FROM specialist_chat_history WHERE user_id=? AND session_id=? ORDER BY created_at ASC LIMIT ?
      `).all(user_id, session_id, limit);
    },
  };
}

module.exports = { createSpecialistStorage };
```

Run tests → PASS. Commit: `feat(routing): turn-classifier + specialist-storage with per-agent + global views`.

---

## Task 2: Routed orchestrator

- [ ] **Step 1: Tests**

Create `server/tests/routed-orchestrator.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/setup-test-db');
const { createSpecialistStorage } = require('../routing/specialist-storage');
const { createTurnClassifier } = require('../routing/turn-classifier');
const { createRoutedOrchestrator } = require('../routing/routed-orchestrator');

describe('routedOrchestrator', () => {
  let db, storage, classifier, orch;
  const agents = {
    billing: { id: 'billing', description: 'refunds', respond: async () => 'billing responded' },
    support: { id: 'support', description: 'support', respond: async () => 'support responded' },
    fallback: { id: 'fallback', description: 'default', respond: async () => 'fallback responded' },
  };
  beforeEach(() => {
    db = setupTestDb(['0XX-specialist-chat-history.sql']);
    storage = createSpecialistStorage({ db });
    classifier = createTurnClassifier({ adapter: 'heuristic' });
    orch = createRoutedOrchestrator({ classifier, storage, agents, defaultAgent: 'fallback' });
  });

  it('routes a refund turn to billing and persists transcripts', async () => {
    const r = await orch.routeTurn({ user_id: 'u1', session_id: 's1', userInput: 'refund please' });
    expect(r.agent_id).toBe('billing');
    expect(r.response).toBe('billing responded');
    expect(storage.readSpecialist({ user_id: 'u1', session_id: 's1', agent_id: 'billing' })).toHaveLength(2); // user + assistant
    expect(storage.readGlobal({ user_id: 'u1', session_id: 's1' })).toHaveLength(2);
  });

  it('falls back to defaultAgent when classifier returns null', async () => {
    const r = await orch.routeTurn({ user_id: 'u1', session_id: 's1', userInput: 'qqq unrelated' });
    expect(r.agent_id).toBe('fallback');
    expect(r.response).toBe('fallback responded');
  });

  it('surfaces error from the selected specialist without breaking persistence', async () => {
    agents.billing.respond = async () => { throw new Error('boom'); };
    await expect(orch.routeTurn({ user_id: 'u1', session_id: 's1', userInput: 'refund' })).rejects.toThrow('boom');
    // user message was still persisted
    expect(storage.readGlobal({ user_id: 'u1', session_id: 's1' }).length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/routing/routed-orchestrator.js`:

```js
'use strict';

function createRoutedOrchestrator({ classifier, storage, agents, defaultAgent }) {
  async function routeTurn({ user_id, session_id, userInput }) {
    storage.append({ user_id, session_id, agent_id: 'global', role: 'user', content: userInput });

    const history = storage.readGlobal({ user_id, session_id });
    const { agent_id, confidence } = await classifier.classify({
      userInput, history, agents: Object.values(agents).map(a => ({ id: a.id, description: a.description })),
    });
    const chosen = (agent_id && agents[agent_id]) || agents[defaultAgent];
    if (!chosen) throw new Error('no agent available (classifier returned null and no defaultAgent)');

    storage.append({ user_id, session_id, agent_id: chosen.id, role: 'user', content: userInput });
    const response = await chosen.respond({
      userInput,
      specialistHistory: storage.readSpecialist({ user_id, session_id, agent_id: chosen.id }),
      globalHistory: history,
    });
    storage.append({ user_id, session_id, agent_id: chosen.id, role: 'assistant', content: response });

    return { agent_id: chosen.id, response, confidence, routed: !!agent_id };
  }

  return { routeTurn };
}

module.exports = { createRoutedOrchestrator };
```

Run tests → PASS. Commit: `feat(routing): routed-orchestrator — classify, dispatch, persist, fallback`.

---

## Task 3: MCP surface

- [ ] **Step 1: Register tools**

In `server/handlers/mcp-tools.js`:

```js
register_specialist: {
  description: 'Register a specialist agent with id, description, and a handler reference (existing provider/crew/workflow).',
  inputSchema: {
    type: 'object',
    required: ['id', 'description', 'handler'],
    properties: {
      id: { type: 'string' },
      description: { type: 'string' },
      handler: { type: 'object', description: 'e.g. { kind:"provider", provider:"codex" } or { kind:"crew", crew_id:"..." } or { kind:"workflow", workflow_id:"..." }' },
    },
  },
},
route_turn: {
  description: 'Classify a user turn, dispatch to the chosen specialist, persist transcripts.',
  inputSchema: {
    type: 'object',
    required: ['user_id', 'session_id', 'user_input'],
    properties: {
      user_id: { type: 'string' },
      session_id: { type: 'string' },
      user_input: { type: 'string' },
      classifier_adapter: { enum: ['heuristic', 'llm'], description: 'default heuristic' },
      default_agent: { type: 'string' },
    },
  },
},
get_session_history: {
  description: 'Return specialist-scoped or global session history.',
  inputSchema: {
    type: 'object',
    required: ['user_id', 'session_id'],
    properties: {
      user_id: { type: 'string' },
      session_id: { type: 'string' },
      agent_id: { type: 'string', description: 'Omit for global view.' },
    },
  },
},
```

- [ ] **Step 2: Container wiring + smoke**

In `server/container.js`:

```js
const { createSpecialistStorage } = require('./routing/specialist-storage');
const { createTurnClassifier } = require('./routing/turn-classifier');
const { createRoutedOrchestrator } = require('./routing/routed-orchestrator');

container.singleton('specialistStorage', c => createSpecialistStorage({ db: c.get('db') }));
container.singleton('turnClassifier', () => createTurnClassifier({ adapter: 'heuristic' }));
container.factory('routedOrchestrator', c => createRoutedOrchestrator({
  classifier: c.get('turnClassifier'),
  storage: c.get('specialistStorage'),
  agents: c.get('registeredSpecialists') || {},
  defaultAgent: 'general',
}));
```

Smoke: register 3 specialists → send "I need a refund" via `route_turn` → confirm billing agent picked, both specialist and global transcripts updated. Send "again" → confirm billing picked again via history follow-up rule.

Commit: `feat(routing): MCP surface for classifier-first specialist routing`.
