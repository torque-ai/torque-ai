# Fabro #94: Chroma-Backed Archival Memory (Chroma)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Plan 47's custom archival-memory cosine math with a **Chroma-backed collection API**: one collection per agent/workspace, hybrid filtering via `where` (metadata) + `where_document` (content substring), built-in embedding function abstraction with pluggable providers, and optional local/remote Chroma server modes. Inspired by Chroma.

**Architecture:** A new `ArchivalMemory` implementation backed by `chromadb` Node client. Same API as Plan 47 (`store`, `search`) but now:
- Collections are keyed `agent:<id>` or `workspace:<name>`
- Stored records carry `ids`, `documents`, `metadatas`, `embeddings`
- Search supports `where` filters (`{ source: 'task', year: { $gte: 2025 } }`) and `where_document` text filters
- Embedding function is pluggable: default is a local Transformer.js or an Ollama embed call

Runtime mode is configurable: embedded in-memory, persistent client with local disk, or HTTP client against `chroma run`.

**Tech Stack:** Node.js, `chromadb` client package, optional local `@xenova/transformers`. Builds on plans 47 (memory), 50 (plugins).

---

## File Structure

**New files:**
- `server/memory/chroma-archival.js`
- `server/memory/embedding-functions.js`
- `server/memory/tests/chroma-archival.test.js`

**Modified files:**
- `server/container.js` — factory `archivalMemory` now wraps Chroma
- `server/handlers/mcp-tools.js` — extended filters on `memory_search_archival`

---

## Task 1: Embedding functions

- [ ] **Step 1: Interface**

Create `server/memory/embedding-functions.js`:

```js
'use strict';

// All embedding functions implement: async embed(texts: string[]) → number[][]
// and expose a stable `name` for logging.
const PROVIDERS = {};

function register(name, factory) { PROVIDERS[name] = factory; }

function get(name, opts) {
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`unknown embedding provider: ${name}`);
  return factory(opts || {});
}

function listProviders() { return Object.keys(PROVIDERS).sort(); }

// --- Built-in providers ---
register('ollama', ({ baseUrl = 'http://127.0.0.1:11434', model = 'nomic-embed-text' }) => ({
  name: `ollama:${model}`,
  async embed(texts) {
    const out = [];
    for (const text of texts) {
      const res = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
      });
      if (!res.ok) throw new Error(`ollama embed failed: HTTP ${res.status}`);
      const data = await res.json();
      out.push(data.embedding);
    }
    return out;
  },
}));

register('openai-compat', ({ baseUrl, apiKey, model }) => ({
  name: `openai:${model}`,
  async embed(texts) {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ input: texts, model }),
    });
    if (!res.ok) throw new Error(`openai embed failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.data.map(d => d.embedding);
  },
}));

register('stub', () => ({
  name: 'stub',
  async embed(texts) {
    // Deterministic hash-based stub for tests — not semantic
    return texts.map(t => {
      const arr = new Array(16).fill(0);
      for (let i = 0; i < t.length; i++) arr[i % 16] += t.charCodeAt(i);
      return arr.map(x => x / 1000);
    });
  },
}));

module.exports = { register, get, listProviders };
```

Commit: `feat(memory): pluggable embedding function registry (ollama/openai/stub)`.

---

## Task 2: Chroma-backed archival memory

- [ ] **Step 1: Tests**

Create `server/memory/tests/chroma-archival.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { createChromaArchivalMemory } = require('../chroma-archival');
const { get: getEmbedder } = require('../embedding-functions');

describe('chromaArchivalMemory (in-memory stub client)', () => {
  let memory, clientMock, collectionMock;

  beforeEach(() => {
    collectionMock = {
      add:    vi.fn(async () => {}),
      query:  vi.fn(async () => ({ ids: [[]], documents: [[]], metadatas: [[]], distances: [[]] })),
      get:    vi.fn(async () => ({ ids: [], documents: [], metadatas: [] })),
      upsert: vi.fn(async () => {}),
      count:  vi.fn(async () => 0),
    };
    clientMock = {
      getOrCreateCollection: vi.fn(async () => collectionMock),
      listCollections: vi.fn(async () => [{ name: 'agent:a1' }]),
    };
    memory = createChromaArchivalMemory({
      client: clientMock,
      embedder: getEmbedder('stub'),
    });
  });

  it('store adds a document with embedding + metadata', async () => {
    await memory.store('a1', 'user prefers postgres', { tags: ['db', 'preference'] });
    expect(clientMock.getOrCreateCollection).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent:a1' }));
    expect(collectionMock.add).toHaveBeenCalledWith(expect.objectContaining({
      documents: ['user prefers postgres'],
      metadatas: [expect.objectContaining({ tags_json: '["db","preference"]' })],
      embeddings: [expect.any(Array)],
      ids: [expect.any(String)],
    }));
  });

  it('search queries with nResults + returns mapped records', async () => {
    collectionMock.query.mockResolvedValueOnce({
      ids: [['m1','m2']],
      documents: [['postgres is great', 'mysql is fine']],
      metadatas: [[{ tags_json: '["db"]' }, { tags_json: '[]' }]],
      distances: [[0.1, 0.3]],
    });
    const results = await memory.search('a1', 'which database', 2);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('postgres is great');
    expect(results[0].tags).toEqual(['db']);
    expect(results[0].score).toBeCloseTo(0.9); // 1 - distance
  });

  it('passes where filter through to Chroma query', async () => {
    await memory.search('a1', 'q', 5, { where: { source: 'task' } });
    expect(collectionMock.query).toHaveBeenCalledWith(expect.objectContaining({
      where: { source: 'task' },
    }));
  });

  it('passes where_document filter through', async () => {
    await memory.search('a1', 'q', 5, { whereDocument: { $contains: 'postgres' } });
    expect(collectionMock.query).toHaveBeenCalledWith(expect.objectContaining({
      whereDocument: { $contains: 'postgres' },
    }));
  });
});
```

- [ ] **Step 2: Implement**

Create `server/memory/chroma-archival.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function collectionNameForAgent(agentId) {
  return `agent:${agentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`;
}

function createChromaArchivalMemory({ client, embedder, logger = console }) {
  async function getOrCreate(agentId) {
    return client.getOrCreateCollection({ name: collectionNameForAgent(agentId) });
  }

  async function store(agentId, content, { tags = [], metadata = {} } = {}) {
    const collection = await getOrCreate(agentId);
    const [embedding] = await embedder.embed([content]);
    const id = `mem_${randomUUID().slice(0, 12)}`;
    await collection.add({
      ids: [id],
      documents: [content],
      embeddings: [embedding],
      metadatas: [{
        ...metadata,
        tags_json: JSON.stringify(tags),
        stored_at: new Date().toISOString(),
      }],
    });
    return id;
  }

  async function search(agentId, query, k = 5, { where = null, whereDocument = null } = {}) {
    const collection = await getOrCreate(agentId);
    const [queryEmbedding] = await embedder.embed([query]);
    const result = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: k,
      where, whereDocument,
    });
    const ids        = result.ids?.[0] || [];
    const documents  = result.documents?.[0] || [];
    const metadatas  = result.metadatas?.[0] || [];
    const distances  = result.distances?.[0] || [];
    return ids.map((id, i) => {
      const meta = metadatas[i] || {};
      return {
        memory_id: id,
        content: documents[i],
        score: 1 - (distances[i] || 0),
        tags: meta.tags_json ? safeParse(meta.tags_json) : [],
        metadata: meta,
      };
    });
  }

  async function listCollections() {
    return (await client.listCollections()).map(c => c.name);
  }

  async function count(agentId) {
    const collection = await getOrCreate(agentId);
    return collection.count();
  }

  return { store, search, listCollections, count };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return []; } }

module.exports = { createChromaArchivalMemory, collectionNameForAgent };
```

Run tests → PASS. Commit: `feat(memory): chroma-backed archival memory with where + whereDocument`.

---

## Task 3: Container wiring + MCP upgrade

- [ ] **Step 1: Container**

```js
container.factory('archivalMemory', (c) => {
  const { createChromaArchivalMemory } = require('./memory/chroma-archival');
  const { get: getEmbedder } = require('./memory/embedding-functions');
  const { ChromaClient } = require('chromadb');

  const mode = process.env.TORQUE_CHROMA_MODE || 'embedded';
  let client;
  if (mode === 'http') {
    client = new ChromaClient({ path: process.env.TORQUE_CHROMA_URL || 'http://127.0.0.1:8000' });
  } else {
    // embedded (persistent client with default persist_dir)
    client = new ChromaClient({ path: process.env.TORQUE_CHROMA_DATA_DIR || '.torque/chroma' });
  }

  const embedderName = process.env.TORQUE_EMBED_PROVIDER || 'ollama';
  const embedder = getEmbedder(embedderName, {
    baseUrl: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    model: process.env.TORQUE_EMBED_MODEL || 'nomic-embed-text',
  });

  return createChromaArchivalMemory({ client, embedder, logger: c.get('logger') });
});
```

- [ ] **Step 2: Upgrade `memory_search_archival` tool schema**

```js
memory_search_archival: {
  description: 'Semantic search over an agent\'s archival memory. Supports metadata filters (where) and content filters (where_document).',
  inputSchema: {
    type: 'object',
    required: ['agent_id', 'query'],
    properties: {
      agent_id: { type: 'string' },
      query: { type: 'string' },
      k: { type: 'integer', default: 5 },
      where: { type: 'object', description: 'Metadata filter (e.g., {"source":"task", "year":{"$gte":2025}}).' },
      where_document: { type: 'object', description: 'Content filter (e.g., {"$contains":"postgres"}).' },
    },
  },
},
```

Update handler to pass `where` + `whereDocument` through.

- [ ] **Step 3: Migration note for existing Plan 47 data**

Create `docs/memory-migration.md` describing the one-time migration from the legacy `agent_archival_memory` table to Chroma: iterate all rows → call `store()` with their existing `content` + `tags_json` → verify counts match → drop old table.

`await_restart`. Smoke: set env `TORQUE_EMBED_PROVIDER=stub` for tests. Call `memory_archive({agent_id:'a', content:'postgres is our db', tags:['db']})` then `memory_search_archival({agent_id:'a', query:'which db', where:{source:'task'}})` — confirm Chroma is queried with the `where` filter and results include the tags.

Commit: `feat(memory): Chroma-backed archival memory + pluggable embedders + metadata/content filters`.
