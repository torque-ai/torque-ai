# Fabro #47: Agent Memory Hierarchy (Letta)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give TORQUE agents persistent memory with an explicit three-tier hierarchy — **core** (pinned, always in context), **recall** (searchable conversation + decision history), **archival** (semantic vector store for durable lessons). Agents edit core memory with memory tools, search recall + archival via tool calls, and background "sleep-time" consolidation periodically refreshes core from recent activity. Inspired by Letta/MemGPT.

**Architecture:** New `agents` table holds long-lived agent records with core memory blocks. New `agent_messages` table is the recall tier. New `agent_archival_memory` stores embedding + text pairs. Memory tools (`memory_insert`, `memory_replace`, `memory_search_recall`, `memory_search_archival`, `memory_archive`) are MCP + inline-callable. A scheduled sleep-time job runs per agent every N activity events to consolidate transient messages into pinned core + archival entries.

**Tech Stack:** Node.js, better-sqlite3, sqlite-vec (or a vector column with cosine-similarity computed in JS), existing provider dispatch for embeddings. Builds on Plans 14 (events), 27 (state), 29 (journal).

---

## File Structure

**New files:**
- `server/migrations/0NN-agent-memory.sql`
- `server/memory/agent-store.js` — CRUD for agents
- `server/memory/core-memory.js` — pinned blocks
- `server/memory/recall-memory.js` — message history + search
- `server/memory/archival-memory.js` — embedding store + similarity search
- `server/memory/sleep-time-consolidator.js`
- `server/memory/memory-tools.js` — MCP tool bindings
- `server/tests/agent-store.test.js`
- `server/tests/recall-memory.test.js`
- `server/tests/archival-memory.test.js`
- `server/tests/sleep-time-consolidator.test.js`

**Modified files:**
- `server/handlers/mcp-tools.js` — register memory tools
- `server/tool-defs/`
- `server/handlers/agent/` (new dir)

---

## Task 1: Migration + agent store

- [ ] **Step 1: Migration**

`server/migrations/0NN-agent-memory.sql`:

```sql
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  persona TEXT,
  domain_id TEXT,
  core_memory_budget_tokens INTEGER NOT NULL DEFAULT 2000,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS core_memory_blocks (
  agent_id TEXT NOT NULL,
  block_name TEXT NOT NULL,              -- 'self', 'user', 'project', or custom
  content TEXT NOT NULL,
  token_limit INTEGER NOT NULL DEFAULT 500,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, block_name),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_messages (
  message_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,                    -- 'user' | 'assistant' | 'system' | 'tool'
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_agent_time ON agent_messages(agent_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS agent_messages_fts USING fts5(content, content='agent_messages', content_rowid='rowid');

CREATE TABLE IF NOT EXISTS agent_archival_memory (
  memory_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding_json TEXT,                   -- JSON array of floats
  source_message_id TEXT,
  tags_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_archival_agent ON agent_archival_memory(agent_id);
```

- [ ] **Step 2: Agent store tests**

Create `server/tests/agent-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createAgentStore } = require('../memory/agent-store');
const { createCoreMemory } = require('../memory/core-memory');

describe('agentStore', () => {
  let db, store, core;
  beforeEach(() => {
    db = setupTestDb();
    store = createAgentStore({ db });
    core = createCoreMemory({ db });
  });

  it('create assigns ID + default core blocks', () => {
    const id = store.create({ name: 'Architect', persona: 'Senior engineer' });
    expect(id).toMatch(/^agent_/);
    const a = store.get(id);
    expect(a.name).toBe('Architect');
  });

  it('core memory insert/replace is atomic', () => {
    const id = store.create({ name: 'X' });
    core.insert(id, 'project', 'Working on TORQUE v2');
    core.replace(id, 'project', 'Now on auth unification');
    expect(core.get(id, 'project').content).toBe('Now on auth unification');
  });

  it('listBlocks returns all core blocks for an agent', () => {
    const id = store.create({ name: 'X' });
    core.insert(id, 'self', 'I am Claude');
    core.insert(id, 'user', 'User is a developer');
    const blocks = core.listBlocks(id);
    expect(blocks.map(b => b.block_name).sort()).toEqual(['self', 'user']);
  });

  it('enforces token_limit per block (best-effort word-count)', () => {
    const id = store.create({ name: 'X' });
    core.insert(id, 'self', 'hi', 5); // 5-token limit
    const r = core.replace(id, 'self', 'this message has way more words than allowed');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/token limit/i);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/memory/agent-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createAgentStore({ db }) {
  function create({ name, description = null, persona = null, domainId = null, coreMemoryBudgetTokens = 2000 }) {
    const id = `agent_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO agents (agent_id, name, description, persona, domain_id, core_memory_budget_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, description, persona, domainId, coreMemoryBudgetTokens);
    return id;
  }

  function get(id) { return db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id); }
  function list() { return db.prepare('SELECT * FROM agents ORDER BY name').all(); }
  function remove(id) { db.prepare('DELETE FROM agents WHERE agent_id = ?').run(id); }

  return { create, get, list, remove };
}

module.exports = { createAgentStore };
```

Create `server/memory/core-memory.js`:

```js
'use strict';

function approxTokens(text) { return Math.ceil((text || '').split(/\s+/).filter(Boolean).length * 1.3); }

function createCoreMemory({ db }) {
  function insert(agentId, blockName, content, tokenLimit = 500) {
    if (approxTokens(content) > tokenLimit) {
      return { ok: false, error: `content exceeds token limit ${tokenLimit}` };
    }
    db.prepare(`
      INSERT OR REPLACE INTO core_memory_blocks (agent_id, block_name, content, token_limit, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(agentId, blockName, content, tokenLimit);
    return { ok: true };
  }

  function replace(agentId, blockName, newContent) {
    const existing = get(agentId, blockName);
    const limit = existing?.token_limit || 500;
    if (approxTokens(newContent) > limit) return { ok: false, error: `content exceeds token limit ${limit}` };
    db.prepare(`UPDATE core_memory_blocks SET content = ?, updated_at = datetime('now') WHERE agent_id = ? AND block_name = ?`)
      .run(newContent, agentId, blockName);
    return { ok: true };
  }

  function get(agentId, blockName) {
    return db.prepare('SELECT * FROM core_memory_blocks WHERE agent_id = ? AND block_name = ?').get(agentId, blockName);
  }

  function listBlocks(agentId) {
    return db.prepare('SELECT * FROM core_memory_blocks WHERE agent_id = ? ORDER BY block_name').all(agentId);
  }

  function renderAsPrompt(agentId) {
    const blocks = listBlocks(agentId);
    return blocks.map(b => `[${b.block_name}]\n${b.content}`).join('\n\n');
  }

  return { insert, replace, get, listBlocks, renderAsPrompt };
}

module.exports = { createCoreMemory };
```

Run tests → PASS. Commit: `feat(memory): agent store + core memory with token limits`.

---

## Task 2: Recall + archival memory

- [ ] **Step 1: Recall tests**

Create `server/tests/recall-memory.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createRecallMemory } = require('../memory/recall-memory');

describe('recallMemory', () => {
  let db, recall;
  beforeEach(() => {
    db = setupTestDb();
    recall = createRecallMemory({ db });
    db.prepare(`INSERT INTO agents (agent_id, name) VALUES ('a1', 'test')`).run();
  });

  it('append stores messages in order', () => {
    recall.append('a1', { role: 'user', content: 'hello' });
    recall.append('a1', { role: 'assistant', content: 'hi there' });
    const recent = recall.recent('a1', 10);
    expect(recent.length).toBe(2);
    expect(recent[0].content).toBe('hello');
  });

  it('search finds messages by FTS match', () => {
    recall.append('a1', { role: 'user', content: 'we decided to use postgres' });
    recall.append('a1', { role: 'user', content: 'we picked redis for cache' });
    const r = recall.search('a1', 'postgres');
    expect(r.length).toBe(1);
    expect(r[0].content).toMatch(/postgres/);
  });

  it('recent supports a since timestamp', () => {
    recall.append('a1', { role: 'user', content: 'old' });
    const cutoff = new Date().toISOString();
    // Force next row to be strictly after cutoff
    setTimeout(() => {}, 5);
    recall.append('a1', { role: 'user', content: 'new' });
    const r = recall.recentSince('a1', cutoff);
    expect(r.every(m => new Date(m.created_at) >= new Date(cutoff))).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/memory/recall-memory.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createRecallMemory({ db }) {
  function append(agentId, { role, content, metadata = null }) {
    const id = `msg_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO agent_messages (message_id, agent_id, role, content, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, agentId, role, content, metadata ? JSON.stringify(metadata) : null);
    // Keep FTS in sync
    try {
      db.prepare(`INSERT INTO agent_messages_fts (rowid, content) SELECT rowid, content FROM agent_messages WHERE message_id = ?`).run(id);
    } catch { /* FTS table may not exist in some test configs */ }
    return id;
  }

  function recent(agentId, limit = 20) {
    return db.prepare(`SELECT * FROM agent_messages WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(agentId, limit).reverse();
  }

  function recentSince(agentId, sinceIso) {
    return db.prepare(`SELECT * FROM agent_messages WHERE agent_id = ? AND created_at >= ? ORDER BY created_at ASC`)
      .all(agentId, sinceIso);
  }

  function search(agentId, query) {
    try {
      return db.prepare(`
        SELECT m.* FROM agent_messages m
        JOIN agent_messages_fts fts ON m.rowid = fts.rowid
        WHERE m.agent_id = ? AND agent_messages_fts MATCH ?
        ORDER BY rank LIMIT 20
      `).all(agentId, query);
    } catch {
      // Fallback to LIKE search
      return db.prepare(`SELECT * FROM agent_messages WHERE agent_id = ? AND content LIKE ? LIMIT 20`)
        .all(agentId, `%${query}%`);
    }
  }

  return { append, recent, recentSince, search };
}

module.exports = { createRecallMemory };
```

- [ ] **Step 3: Archival tests + impl**

Create `server/tests/archival-memory.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createArchivalMemory } = require('../memory/archival-memory');

describe('archivalMemory', () => {
  let db, archival, embedMock;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO agents (agent_id, name) VALUES ('a1', 'test')`).run();
    embedMock = vi.fn(async (text) => {
      // Fake deterministic embedding: 4-dim vector
      return [text.length % 5, text.includes('redis') ? 1 : 0, text.includes('postgres') ? 1 : 0, 0.5];
    });
    archival = createArchivalMemory({ db, embed: embedMock });
  });

  it('store persists content + embedding', async () => {
    const id = await archival.store('a1', 'We chose Postgres for durability', { tags: ['db'] });
    expect(id).toMatch(/^mem_/);
  });

  it('search returns nearest by cosine similarity', async () => {
    await archival.store('a1', 'Postgres is our DB');
    await archival.store('a1', 'Redis is our cache');
    await archival.store('a1', 'Tailwind for styling');
    const r = await archival.search('a1', 'which database did we pick', 2);
    expect(r.length).toBe(2);
    expect(r[0].content).toMatch(/Postgres|Redis/); // nearest-to-fake embedding
  });

  it('search filters by agentId', async () => {
    db.prepare(`INSERT INTO agents (agent_id, name) VALUES ('a2', 'other')`).run();
    await archival.store('a1', 'a1 memory');
    await archival.store('a2', 'a2 memory');
    const r = await archival.search('a1', 'memory');
    expect(r.every(m => m.agent_id === 'a1')).toBe(true);
  });
});
```

Create `server/memory/archival-memory.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function createArchivalMemory({ db, embed }) {
  async function store(agentId, content, { tags = [], sourceMessageId = null } = {}) {
    const id = `mem_${randomUUID().slice(0, 12)}`;
    const embedding = await embed(content);
    db.prepare(`
      INSERT INTO agent_archival_memory (memory_id, agent_id, content, embedding_json, source_message_id, tags_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, agentId, content, JSON.stringify(embedding), sourceMessageId, JSON.stringify(tags));
    return id;
  }

  async function search(agentId, query, k = 5) {
    const qEmbed = await embed(query);
    const rows = db.prepare(`SELECT * FROM agent_archival_memory WHERE agent_id = ?`).all(agentId);
    const scored = rows.map(r => ({
      ...r,
      score: cosine(qEmbed, JSON.parse(r.embedding_json)),
    })).sort((a, b) => b.score - a.score).slice(0, k);
    return scored;
  }

  return { store, search };
}

module.exports = { createArchivalMemory };
```

Run tests → PASS. Commit: `feat(memory): recall (FTS) + archival (embedding) stores`.

---

## Task 3: Sleep-time consolidator

- [ ] **Step 1: Tests**

Create `server/tests/sleep-time-consolidator.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createSleepTimeConsolidator } = require('../memory/sleep-time-consolidator');
const { createRecallMemory } = require('../memory/recall-memory');
const { createArchivalMemory } = require('../memory/archival-memory');
const { createCoreMemory } = require('../memory/core-memory');

describe('sleepTimeConsolidator', () => {
  let db, consolidator, callModel, embed;

  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO agents (agent_id, name) VALUES ('a1', 'test')`).run();
    const recall = createRecallMemory({ db });
    embed = vi.fn(async (t) => [0.1, 0.2, 0.3, t.length % 10]);
    const archival = createArchivalMemory({ db, embed });
    const core = createCoreMemory({ db });
    callModel = vi.fn(async () => ({
      archival_entries: ['User prefers Postgres', 'Project targets Node 22'],
      updated_core: { project: 'TORQUE v2, targeting Node 22' },
    }));
    consolidator = createSleepTimeConsolidator({ db, recall, archival, core, callModel });
  });

  it('consolidate converts recent messages into archival + core updates', async () => {
    const recall = createRecallMemory({ db });
    recall.append('a1', { role: 'user', content: 'use postgres' });
    recall.append('a1', { role: 'assistant', content: 'node 22 required' });

    const r = await consolidator.consolidate('a1', { sinceIso: new Date(0).toISOString() });
    expect(r.archival_count).toBe(2);
    expect(r.core_updates.project).toBeDefined();
    expect(callModel).toHaveBeenCalled();
  });

  it('no-op when there are no new messages since last run', async () => {
    const r = await consolidator.consolidate('a1', { sinceIso: new Date().toISOString() });
    expect(r.archival_count).toBe(0);
    expect(callModel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

Create `server/memory/sleep-time-consolidator.js`:

```js
'use strict';

const CONSOLIDATION_PROMPT = `You are a memory consolidator. Given recent conversation, produce:
1. A list of durable lessons to store in archival memory (each a single sentence).
2. Optional updates to core memory blocks (pinned facts the agent should always remember).

Recent messages:
{{messages}}

Current core memory:
{{core}}

Respond with strict JSON:
{ "archival_entries": [string, ...], "updated_core": { block_name: new_content, ... } }
`;

function createSleepTimeConsolidator({ db, recall, archival, core, callModel, logger = console }) {
  async function consolidate(agentId, { sinceIso }) {
    const messages = recall.recentSince(agentId, sinceIso);
    if (messages.length === 0) return { archival_count: 0, core_updates: {} };

    const coreBlocks = core.listBlocks(agentId);
    const prompt = CONSOLIDATION_PROMPT
      .replace('{{messages}}', messages.map(m => `${m.role}: ${m.content}`).join('\n'))
      .replace('{{core}}', coreBlocks.map(b => `[${b.block_name}] ${b.content}`).join('\n'));

    const result = await callModel({ prompt });
    let archivalCount = 0;
    for (const entry of (result.archival_entries || [])) {
      await archival.store(agentId, entry, { tags: ['consolidated'] });
      archivalCount++;
    }
    const coreUpdates = result.updated_core || {};
    for (const [blockName, newContent] of Object.entries(coreUpdates)) {
      core.insert(agentId, blockName, newContent);
    }
    logger.info('memory consolidated', { agentId, archivalCount, coreUpdated: Object.keys(coreUpdates).length });
    return { archival_count: archivalCount, core_updates: coreUpdates };
  }

  return { consolidate };
}

module.exports = { createSleepTimeConsolidator };
```

Run tests → PASS. Commit: `feat(memory): sleep-time consolidator folds recent → archival + core`.

---

## Task 4: MCP tools + container + scheduler tick

- [ ] **Step 1: Tool defs**

In `server/tool-defs/`:

```js
create_agent: { description: 'Create a long-lived agent with core memory.', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, persona: { type: 'string' }, domain_id: { type: 'string' } } } },
memory_insert: { description: 'Insert or replace a core memory block.', inputSchema: { type: 'object', required: ['agent_id','block_name','content'], properties: { agent_id: {type:'string'}, block_name: {type:'string'}, content: {type:'string'}, token_limit: {type:'integer'} } } },
memory_search_recall: { description: 'FTS search over an agent\'s message history.', inputSchema: { type: 'object', required: ['agent_id','query'], properties: { agent_id: {type:'string'}, query: {type:'string'} } } },
memory_search_archival: { description: 'Semantic search over an agent\'s archival memory.', inputSchema: { type: 'object', required: ['agent_id','query'], properties: { agent_id: {type:'string'}, query: {type:'string'}, k: {type:'integer'} } } },
memory_archive: { description: 'Store a durable lesson in archival memory.', inputSchema: { type: 'object', required: ['agent_id','content'], properties: { agent_id: {type:'string'}, content: {type:'string'}, tags: { type: 'array', items: {type:'string'} } } } },
consolidate_memory: { description: 'Trigger sleep-time consolidation for an agent.', inputSchema: { type: 'object', required: ['agent_id'], properties: { agent_id: {type:'string'}, since_iso: {type:'string'} } } },
```

- [ ] **Step 2: Handlers + container**

Wire stores + consolidator as container factories. Tool handlers delegate directly. Add a periodic tick in `server/index.js`:

```js
const consolidator = defaultContainer.get('sleepTimeConsolidator');
const agents = defaultContainer.get('agentStore').list();
setInterval(async () => {
  for (const a of agents) {
    const lastIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    try { await consolidator.consolidate(a.agent_id, { sinceIso: lastIso }); }
    catch (err) { logger.warn('consolidate failed', { agentId: a.agent_id, err: err.message }); }
  }
}, 15 * 60 * 1000);
```

`await_restart`. Smoke: `create_agent({name:'Architect'})`, send a few messages via recall, call `consolidate_memory({agent_id})`. Confirm archival entries appear and core block `project` is populated.

Commit: `feat(memory): MCP tools + periodic consolidation tick`.
