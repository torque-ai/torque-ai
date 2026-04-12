# Fabro #62: Reasoning Toolkits (Agno)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose reasoning as a set of **MCP tools** — `think(thought)`, `analyze(claim)`, `search_memory(query)`, `rate_confidence(claim)` — that an agent chooses to call during a task, producing a durable scratchpad instead of hidden chain-of-thought. Inspired by Agno's ReasoningTools / KnowledgeTools / MemoryTools.

**Architecture:** A `reasoning-toolkit.js` registers these tools with the MCP server. Each call appends a row to `reasoning_scratchpad` keyed by task_id + turn + kind. The scratchpad is rendered as a section in the dashboard task detail (Plan 46 trace), and available to downstream tasks as `$reasoning.thoughts`. Reasoning tools are lightweight, cheap, and observable — they don't call external services; they record model-emitted reasoning that would otherwise disappear into the prompt context.

**Tech Stack:** Node.js, better-sqlite3, existing MCP tool dispatch. Builds on plans 14 (events), 27 (state), 46 (trace waterfall).

---

## File Structure

**New files:**
- `server/migrations/0NN-reasoning-scratchpad.sql`
- `server/reasoning/reasoning-toolkit.js`
- `server/tests/reasoning-toolkit.test.js`
- `dashboard/src/components/ReasoningScratchpad.jsx`

**Modified files:**
- `server/handlers/mcp-tools.js` — register 4 tools
- `server/tool-defs/` — tool schemas
- `dashboard/src/views/TaskDetail.jsx` — show scratchpad panel

---

## Task 1: Migration + toolkit

- [ ] **Step 1: Migration**

`server/migrations/0NN-reasoning-scratchpad.sql`:

```sql
CREATE TABLE IF NOT EXISTS reasoning_scratchpad (
  scratchpad_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workflow_id TEXT,
  turn INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,                    -- 'think' | 'analyze' | 'search_memory' | 'rate_confidence'
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reasoning_task_turn ON reasoning_scratchpad(task_id, turn);
```

- [ ] **Step 2: Tests**

Create `server/tests/reasoning-toolkit.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createReasoningToolkit } = require('../reasoning/reasoning-toolkit');

describe('reasoningToolkit', () => {
  let db, tk;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO tasks (task_id, status) VALUES ('t1','running')`).run();
    tk = createReasoningToolkit({ db });
  });

  it('think appends a thought to the scratchpad', () => {
    const id = tk.think({ taskId: 't1', content: 'I should check the config first' });
    expect(id).toMatch(/^scr_/);
    const row = db.prepare('SELECT * FROM reasoning_scratchpad WHERE scratchpad_id = ?').get(id);
    expect(row.kind).toBe('think');
    expect(row.content).toMatch(/config first/);
  });

  it('turn auto-increments per task', () => {
    tk.think({ taskId: 't1', content: 'a' });
    tk.analyze({ taskId: 't1', content: 'b', subject: 'hypothesis' });
    tk.think({ taskId: 't1', content: 'c' });
    const turns = db.prepare('SELECT turn FROM reasoning_scratchpad WHERE task_id = ? ORDER BY turn').all('t1').map(r => r.turn);
    expect(turns).toEqual([1, 2, 3]);
  });

  it('rateConfidence stores numeric value in metadata', () => {
    tk.rateConfidence({ taskId: 't1', content: 'The fix is in config.js', confidence: 0.8 });
    const row = db.prepare('SELECT metadata_json FROM reasoning_scratchpad WHERE task_id = ?').get('t1');
    expect(JSON.parse(row.metadata_json).confidence).toBe(0.8);
  });

  it('listForTask returns scratchpad entries in turn order', () => {
    tk.think({ taskId: 't1', content: 'first' });
    tk.analyze({ taskId: 't1', content: 'second' });
    const items = tk.listForTask('t1');
    expect(items).toHaveLength(2);
    expect(items[0].content).toBe('first');
  });

  it('searchMemory records query + placeholder result', () => {
    tk.searchMemory({ taskId: 't1', query: 'redis config' });
    const row = db.prepare('SELECT kind, content FROM reasoning_scratchpad WHERE task_id = ?').get('t1');
    expect(row.kind).toBe('search_memory');
    expect(row.content).toMatch(/redis config/);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/reasoning/reasoning-toolkit.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createReasoningToolkit({ db, onEvent = () => {} }) {
  function append({ taskId, workflowId = null, kind, content, metadata = null }) {
    const row = db.prepare(`SELECT COALESCE(MAX(turn), 0) + 1 AS n FROM reasoning_scratchpad WHERE task_id = ?`).get(taskId);
    const turn = row.n;
    const id = `scr_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO reasoning_scratchpad (scratchpad_id, task_id, workflow_id, turn, kind, content, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, workflowId, turn, kind, content, metadata ? JSON.stringify(metadata) : null);
    onEvent({ type: 'reasoning_recorded', task_id: taskId, turn, kind });
    return id;
  }

  function think({ taskId, workflowId, content }) {
    return append({ taskId, workflowId, kind: 'think', content });
  }

  function analyze({ taskId, workflowId, content, subject = null }) {
    return append({ taskId, workflowId, kind: 'analyze', content, metadata: subject ? { subject } : null });
  }

  function searchMemory({ taskId, workflowId, query }) {
    return append({ taskId, workflowId, kind: 'search_memory', content: `Query: ${query}`, metadata: { query } });
  }

  function rateConfidence({ taskId, workflowId, content, confidence }) {
    return append({ taskId, workflowId, kind: 'rate_confidence', content, metadata: { confidence } });
  }

  function listForTask(taskId) {
    return db.prepare('SELECT * FROM reasoning_scratchpad WHERE task_id = ? ORDER BY turn').all(taskId);
  }

  return { think, analyze, searchMemory, rateConfidence, listForTask };
}

module.exports = { createReasoningToolkit };
```

Run tests → PASS. Commit: `feat(reasoning): scratchpad + toolkit with think/analyze/search/confidence`.

---

## Task 2: MCP tools + dashboard

- [ ] **Step 1: Tool defs**

In `server/tool-defs/`:

```js
think: {
  description: 'Record a reasoning step for the current task. Use to narrate what you plan to do next or what you notice. Visible on the task timeline.',
  inputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } },
},
analyze: {
  description: 'Record an analysis step. Use to evaluate a claim, compare options, or break down a problem.',
  inputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, subject: { type: 'string' } } },
},
search_memory: {
  description: 'Query prior task memory for relevant context. If the agent_memory plan is installed, results come from archival memory; otherwise just records the query.',
  inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
},
rate_confidence: {
  description: 'Record your confidence in a claim (0-1).',
  inputSchema: { type: 'object', required: ['content', 'confidence'], properties: { content: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 } } },
},
```

- [ ] **Step 2: Handlers**

```js
case 'think':
  return { scratchpad_id: defaultContainer.get('reasoningToolkit').think({ taskId: ctx.taskId, workflowId: ctx.workflowId, content: args.content }) };
case 'analyze':
  return { scratchpad_id: defaultContainer.get('reasoningToolkit').analyze({ taskId: ctx.taskId, workflowId: ctx.workflowId, content: args.content, subject: args.subject }) };
case 'rate_confidence':
  return { scratchpad_id: defaultContainer.get('reasoningToolkit').rateConfidence({ taskId: ctx.taskId, workflowId: ctx.workflowId, content: args.content, confidence: args.confidence }) };
case 'search_memory': {
  const tk = defaultContainer.get('reasoningToolkit');
  const id = tk.searchMemory({ taskId: ctx.taskId, workflowId: ctx.workflowId, query: args.query });
  // If Plan 47 (agent memory) installed, also run archival search
  const archival = defaultContainer.has?.('archivalMemory') ? defaultContainer.get('archivalMemory') : null;
  if (archival && ctx.agentId) {
    const results = await archival.search(ctx.agentId, args.query, 5);
    return { scratchpad_id: id, results: results.map(r => ({ content: r.content, score: r.score })) };
  }
  return { scratchpad_id: id, results: [] };
}
```

- [ ] **Step 3: Container + dashboard**

```js
container.factory('reasoningToolkit', (c) => {
  const { createReasoningToolkit } = require('./reasoning/reasoning-toolkit');
  return createReasoningToolkit({ db: c.get('db'), onEvent: c.get('journalWriter').write });
});
```

Add `reasoning_recorded` to `VALID_EVENT_TYPES`.

Create `dashboard/src/components/ReasoningScratchpad.jsx` that pulls `/api/tasks/:id/scratchpad` and renders each turn with a colored badge per kind. Add `GET /api/tasks/:id/scratchpad` route.

`await_restart`. Smoke: submit a task whose prompt encourages tool use: "Use `think()` to plan, then `analyze()` each option, then answer." Confirm scratchpad rows appear and dashboard shows them.

Commit: `feat(reasoning): MCP tools + dashboard scratchpad panel`.
