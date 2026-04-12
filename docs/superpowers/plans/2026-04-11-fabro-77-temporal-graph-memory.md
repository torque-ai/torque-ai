# Fabro #77: Temporal Knowledge Graph Memory (Zep)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a **graph memory** layer complementing Plans 47 (tiered agent memory) and 66 (auto-extracted memory): facts are **time-aware graph edges** between typed entities, and when new information contradicts an older fact, the old edge is **invalidated** rather than overwritten. Retrieval supports point-in-time queries ("what was true on 2026-04-01?"). Optional custom ontologies (Pydantic-style entity/edge typings) shape extraction. Inspired by Zep + Graphiti.

**Architecture:** Three new tables:
- `graph_entities` — `(entity_id, kind, name, attributes_json, created_at)`
- `graph_edges` — `(edge_id, src_id, dst_id, relation, attributes_json, valid_at, invalid_at, created_at)`
- `graph_episodes` — `(episode_id, kind, content, created_at)` — source provenance for extraction

A `graph-extractor.js` runs after task completion (or on-demand): feeds recent messages + existing graph excerpt to an LLM which emits `{ entities: [...], edges: [...], invalidates: [edge_ids] }`. A `graph-query.js` exposes `findEdges({ relation, src_kind, dst_kind, at? })` and `traverse(entity_id, depth)` for point-in-time traversal.

**Tech Stack:** Node.js, better-sqlite3, existing provider dispatch. Builds on plans 47 (memory), 66 (auto-extract).

---

## File Structure

**New files:**
- `server/migrations/0NN-graph-memory.sql`
- `server/memory/graph/graph-store.js`
- `server/memory/graph/graph-extractor.js`
- `server/memory/graph/graph-query.js`
- `server/memory/graph/ontology.js` — optional typed entity/edge schemas
- `server/tests/graph-store.test.js`
- `server/tests/graph-query.test.js`
- `server/tests/graph-extractor.test.js`

**Modified files:**
- `server/execution/task-finalizer.js` — optional graph extraction hook
- `server/handlers/mcp-tools.js` — `graph_add_fact`, `graph_invalidate`, `graph_find`, `graph_point_in_time`

---

## Task 1: Migration + store

- [ ] **Step 1: Migration**

`server/migrations/0NN-graph-memory.sql`:

```sql
CREATE TABLE IF NOT EXISTS graph_entities (
  entity_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  attributes_json TEXT,
  domain_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, name, domain_id)
);

CREATE TABLE IF NOT EXISTS graph_edges (
  edge_id TEXT PRIMARY KEY,
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  attributes_json TEXT,
  domain_id TEXT,
  valid_at TEXT NOT NULL DEFAULT (datetime('now')),
  invalid_at TEXT,
  invalidated_by_edge_id TEXT,
  source_episode_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (src_id) REFERENCES graph_entities(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (dst_id) REFERENCES graph_entities(entity_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges(src_id, relation);
CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges(dst_id, relation);
CREATE INDEX IF NOT EXISTS idx_graph_edges_validity ON graph_edges(valid_at, invalid_at);

CREATE TABLE IF NOT EXISTS graph_episodes (
  episode_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                  -- 'task' | 'message' | 'event'
  content TEXT NOT NULL,
  source_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Tests**

Create `server/tests/graph-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createGraphStore } = require('../memory/graph/graph-store');

describe('graphStore', () => {
  let db, store;
  beforeEach(() => {
    db = setupTestDb();
    store = createGraphStore({ db });
  });

  it('upsertEntity is idempotent by (kind, name, domain_id)', () => {
    const id1 = store.upsertEntity({ kind: 'user', name: 'alice' });
    const id2 = store.upsertEntity({ kind: 'user', name: 'alice' });
    expect(id1).toBe(id2);
  });

  it('addFact creates entities + edge', () => {
    const r = store.addFact({
      src: { kind: 'user', name: 'alice' },
      relation: 'prefers',
      dst: { kind: 'db', name: 'postgres' },
    });
    expect(r.edge_id).toMatch(/^edge_/);
    const edges = store.listEdgesFor(r.src_id);
    expect(edges).toHaveLength(1);
  });

  it('invalidate marks edge invalid_at + stores successor pointer', () => {
    const first = store.addFact({
      src: { kind: 'user', name: 'alice' }, relation: 'prefers', dst: { kind: 'db', name: 'mysql' },
    });
    const second = store.addFact({
      src: { kind: 'user', name: 'alice' }, relation: 'prefers', dst: { kind: 'db', name: 'postgres' },
    });
    store.invalidate(first.edge_id, { byEdgeId: second.edge_id });
    const row = db.prepare('SELECT * FROM graph_edges WHERE edge_id = ?').get(first.edge_id);
    expect(row.invalid_at).not.toBeNull();
    expect(row.invalidated_by_edge_id).toBe(second.edge_id);
  });

  it('currentEdgesFor returns only active edges', () => {
    const e1 = store.addFact({ src: { kind: 'u', name: 'a' }, relation: 'likes', dst: { kind: 'c', name: 'red' } });
    const e2 = store.addFact({ src: { kind: 'u', name: 'a' }, relation: 'likes', dst: { kind: 'c', name: 'blue' } });
    store.invalidate(e1.edge_id);
    const current = store.currentEdgesFor(e1.src_id);
    expect(current).toHaveLength(1);
    expect(current[0].edge_id).toBe(e2.edge_id);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/memory/graph/graph-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createGraphStore({ db }) {
  function upsertEntity({ kind, name, attributes = null, domainId = null }) {
    const existing = db.prepare('SELECT entity_id FROM graph_entities WHERE kind = ? AND name = ? AND COALESCE(domain_id, "") = COALESCE(?, "")').get(kind, name, domainId);
    if (existing) return existing.entity_id;
    const id = `ent_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO graph_entities (entity_id, kind, name, attributes_json, domain_id) VALUES (?,?,?,?,?)`)
      .run(id, kind, name, attributes && JSON.stringify(attributes), domainId);
    return id;
  }

  function addFact({ src, relation, dst, attributes = null, validAt = null, sourceEpisodeId = null, domainId = null }) {
    const srcId = upsertEntity({ ...src, domainId });
    const dstId = upsertEntity({ ...dst, domainId });
    const edgeId = `edge_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO graph_edges (edge_id, src_id, dst_id, relation, attributes_json, domain_id, valid_at, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)
    `).run(edgeId, srcId, dstId, relation, attributes && JSON.stringify(attributes), domainId, validAt, sourceEpisodeId);
    return { edge_id: edgeId, src_id: srcId, dst_id: dstId };
  }

  function invalidate(edgeId, { byEdgeId = null, at = null } = {}) {
    db.prepare(`UPDATE graph_edges SET invalid_at = COALESCE(?, datetime('now')), invalidated_by_edge_id = ? WHERE edge_id = ?`)
      .run(at, byEdgeId, edgeId);
  }

  function listEdgesFor(entityId) {
    return db.prepare(`SELECT * FROM graph_edges WHERE src_id = ? OR dst_id = ? ORDER BY valid_at DESC`)
      .all(entityId, entityId);
  }

  function currentEdgesFor(entityId, { at = null } = {}) {
    if (at) {
      return db.prepare(`
        SELECT * FROM graph_edges
        WHERE (src_id = ? OR dst_id = ?)
          AND valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)
      `).all(entityId, entityId, at, at);
    }
    return db.prepare(`
      SELECT * FROM graph_edges
      WHERE (src_id = ? OR dst_id = ?) AND invalid_at IS NULL
    `).all(entityId, entityId);
  }

  function getEntity(entityId) {
    return db.prepare('SELECT * FROM graph_entities WHERE entity_id = ?').get(entityId);
  }

  function findEntityByName({ kind, name, domainId = null }) {
    return db.prepare('SELECT * FROM graph_entities WHERE kind = ? AND name = ? AND COALESCE(domain_id, "") = COALESCE(?, "")').get(kind, name, domainId);
  }

  return { upsertEntity, addFact, invalidate, listEdgesFor, currentEdgesFor, getEntity, findEntityByName };
}

module.exports = { createGraphStore };
```

Run tests → PASS. Commit: `feat(graph-memory): entities + time-aware edges + invalidation`.

---

## Task 2: Point-in-time query

- [ ] **Step 1: Tests**

Create `server/tests/graph-query.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createGraphStore } = require('../memory/graph/graph-store');
const { createGraphQuery } = require('../memory/graph/graph-query');

describe('graphQuery', () => {
  let db, store, query;
  beforeEach(() => {
    db = setupTestDb();
    store = createGraphStore({ db });
    query = createGraphQuery({ db });
  });

  it('findEdges filters by relation', () => {
    store.addFact({ src: { kind: 'u', name: 'a' }, relation: 'likes', dst: { kind: 'c', name: 'red' } });
    store.addFact({ src: { kind: 'u', name: 'a' }, relation: 'dislikes', dst: { kind: 'c', name: 'blue' } });
    expect(query.findEdges({ relation: 'likes' })).toHaveLength(1);
  });

  it('findEdges filters by src/dst kind', () => {
    store.addFact({ src: { kind: 'u', name: 'a' }, relation: 'likes', dst: { kind: 'c', name: 'red' } });
    store.addFact({ src: { kind: 'u', name: 'b' }, relation: 'likes', dst: { kind: 'p', name: 'pasta' } });
    expect(query.findEdges({ relation: 'likes', dstKind: 'c' })).toHaveLength(1);
  });

  it('findEdges with at= returns edges valid at that point', () => {
    const f1 = store.addFact({ src: { kind: 'u', name: 'a' }, relation: 'lives_in', dst: { kind: 'city', name: 'NYC' } });
    const t1 = new Date().toISOString();
    // Small delay to ensure timestamp ordering
    db.prepare(`UPDATE graph_edges SET invalid_at = datetime('now') WHERE edge_id = ?`).run(f1.edge_id);
    const f2 = store.addFact({ src: { kind: 'u', name: 'a' }, relation: 'lives_in', dst: { kind: 'city', name: 'SF' } });
    const past = query.findEdges({ relation: 'lives_in', at: t1 });
    expect(past.map(e => e.edge_id)).toContain(f1.edge_id);
    const now = query.findEdges({ relation: 'lives_in' });
    expect(now.map(e => e.edge_id)).toContain(f2.edge_id);
  });

  it('traverse returns reachable nodes within depth', () => {
    const a = store.addFact({ src: { kind: 'u', name: 'a' }, relation: 'knows', dst: { kind: 'u', name: 'b' } });
    const b = store.addFact({ src: { kind: 'u', name: 'b' }, relation: 'knows', dst: { kind: 'u', name: 'c' } });
    store.addFact({ src: { kind: 'u', name: 'c' }, relation: 'knows', dst: { kind: 'u', name: 'd' } });
    const reached = query.traverse(a.src_id, { maxDepth: 2 });
    const names = reached.map(r => r.name);
    expect(names).toContain('b');
    expect(names).toContain('c');
    expect(names).not.toContain('d'); // depth > 2
  });
});
```

- [ ] **Step 2: Implement**

Create `server/memory/graph/graph-query.js`:

```js
'use strict';

function createGraphQuery({ db }) {
  function findEdges({ relation = null, srcKind = null, dstKind = null, at = null, domainId = null } = {}) {
    const where = [];
    const params = [];
    if (relation) { where.push('e.relation = ?'); params.push(relation); }
    if (srcKind)  { where.push('es.kind = ?'); params.push(srcKind); }
    if (dstKind)  { where.push('ed.kind = ?'); params.push(dstKind); }
    if (domainId) { where.push('e.domain_id = ?'); params.push(domainId); }
    if (at) {
      where.push('e.valid_at <= ?'); params.push(at);
      where.push('(e.invalid_at IS NULL OR e.invalid_at > ?)'); params.push(at);
    } else {
      where.push('e.invalid_at IS NULL');
    }
    const sql = `
      SELECT e.*, es.name AS src_name, es.kind AS src_kind, ed.name AS dst_name, ed.kind AS dst_kind
      FROM graph_edges e
      JOIN graph_entities es ON e.src_id = es.entity_id
      JOIN graph_entities ed ON e.dst_id = ed.entity_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.valid_at DESC
    `;
    return db.prepare(sql).all(...params);
  }

  function traverse(entityId, { maxDepth = 2, at = null } = {}) {
    const visited = new Set([entityId]);
    const reached = [];
    let frontier = [entityId];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next = [];
      for (const id of frontier) {
        const edges = findEdges({ at }).filter(e => e.src_id === id || e.dst_id === id);
        for (const e of edges) {
          const other = e.src_id === id ? e.dst_id : e.src_id;
          if (!visited.has(other)) {
            visited.add(other);
            const ent = db.prepare('SELECT * FROM graph_entities WHERE entity_id = ?').get(other);
            reached.push(ent);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    return reached;
  }

  return { findEdges, traverse };
}

module.exports = { createGraphQuery };
```

Run tests → PASS. Commit: `feat(graph-memory): point-in-time findEdges + bounded traversal`.

---

## Task 3: Extractor + MCP + wiring

- [ ] **Step 1: Extractor**

Create `server/memory/graph/graph-extractor.js`:

```js
'use strict';

const EXTRACTION_PROMPT = `You extract a knowledge graph from conversation. Existing graph excerpt follows. For each new fact observed in the conversation, emit either a new edge or an invalidation of an existing edge.

Return strict JSON:
{
  "entities": [ { "kind": "...", "name": "..." } ],
  "edges": [ { "src": { "kind": "...", "name": "..." }, "relation": "...", "dst": { "kind": "...", "name": "..." } } ],
  "invalidates": [ <edge_id> ]
}

Valid relations should be verb phrases: "prefers", "lives_in", "works_for", etc. Do not emit duplicate facts already active in the graph.

Existing graph excerpt:
{{excerpt}}

Conversation:
{{conversation}}`;

async function extractGraphDelta({ callModel, conversation, existingExcerpt = '(empty)', logger = console }) {
  const prompt = EXTRACTION_PROMPT
    .replace('{{excerpt}}', existingExcerpt)
    .replace('{{conversation}}', conversation);
  try {
    const result = await callModel({ prompt });
    return {
      entities: Array.isArray(result.entities) ? result.entities : [],
      edges: Array.isArray(result.edges) ? result.edges : [],
      invalidates: Array.isArray(result.invalidates) ? result.invalidates : [],
    };
  } catch (err) {
    logger.warn?.('graph extraction failed', err);
    return { entities: [], edges: [], invalidates: [], error: err.message };
  }
}

async function applyDelta({ graphStore, delta, episodeId = null }) {
  for (const edgeId of delta.invalidates || []) {
    graphStore.invalidate(edgeId);
  }
  const addedEdges = [];
  for (const edge of delta.edges || []) {
    const r = graphStore.addFact({
      src: edge.src, relation: edge.relation, dst: edge.dst,
      attributes: edge.attributes, sourceEpisodeId: episodeId,
    });
    addedEdges.push(r.edge_id);
  }
  return { invalidated: delta.invalidates || [], added: addedEdges };
}

module.exports = { extractGraphDelta, applyDelta };
```

- [ ] **Step 2: MCP tools + container**

```js
graph_add_fact: { description: 'Manually add a fact edge between two entities.', inputSchema: { type:'object', required:['src','relation','dst'], properties: { src:{type:'object'}, relation:{type:'string'}, dst:{type:'object'}, attributes:{type:'object'} } } },
graph_invalidate: { description: 'Mark an edge as invalid (without deletion).', inputSchema: { type:'object', required:['edge_id'], properties: { edge_id:{type:'string'} } } },
graph_find: { description: 'Find active edges matching filters.', inputSchema: { type:'object', properties: { relation:{type:'string'}, src_kind:{type:'string'}, dst_kind:{type:'string'} } } },
graph_point_in_time: { description: 'Find edges that were valid at a given ISO timestamp.', inputSchema: { type:'object', required:['at'], properties: { at:{type:'string'}, relation:{type:'string'} } } },
graph_traverse: { description: 'Return entities reachable from a starting entity within depth.', inputSchema: { type:'object', required:['entity_id'], properties: { entity_id:{type:'string'}, max_depth:{type:'integer', default:2} } } },
```

Container:

```js
container.factory('graphStore', (c) => require('./memory/graph/graph-store').createGraphStore({ db: c.get('db') }));
container.factory('graphQuery', (c) => require('./memory/graph/graph-query').createGraphQuery({ db: c.get('db') }));
```

- [ ] **Step 3: Post-task extraction hook (opt-in)**

In `server/execution/task-finalizer.js`:

```js
const meta = parseTaskMetadata(task);
if (meta.extract_graph === true && finalOutput) {
  const { extractGraphDelta, applyDelta } = require('../memory/graph/graph-extractor');
  const provider = providerRegistry.getProviderInstance('codex');
  const conversation = `user: ${task.task_description}\nassistant: ${typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput)}`;
  (async () => {
    try {
      const delta = await extractGraphDelta({
        callModel: async ({ prompt }) => JSON.parse(await provider.runPrompt({ prompt, format: 'json', max_tokens: 2000 })),
        conversation,
      });
      const applied = await applyDelta({ graphStore: defaultContainer.get('graphStore'), delta });
      if (applied.added.length > 0 || applied.invalidated.length > 0) {
        addTaskTag(taskId, `graph:added:${applied.added.length}_invalidated:${applied.invalidated.length}`);
      }
    } catch (err) { logger.warn('graph extraction failed', { taskId, err: err.message }); }
  })();
}
```

`await_restart`. Smoke: submit a task with `extract_graph: true` and a conversation that says "Alice prefers Postgres." Then a second task that says "Alice changed her mind, she prefers MySQL now." Call `graph_find({relation:'prefers', src_kind:'user'})` — confirm current edge is to MySQL, and `graph_point_in_time({at:<first task's completed_at>})` returns the Postgres edge.

Commit: `feat(graph-memory): extractor + MCP + post-task hook`.
