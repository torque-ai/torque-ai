# Fabro #63: Persistent Threads (Marvin)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a first-class **Thread** primitive — a persistent conversation object with an ID, message history, and retrieval API — that tasks and agents opt into with `thread_id: 'ops-2026-04'`. Multiple tasks sharing a thread see the same history; resuming a workflow months later can keep using the same thread for continuity. Inspired by Marvin 3.

**Architecture:** A new `threads` table holds metadata; `thread_messages` holds individual turns. Tasks that set `thread_id` have their `user`/`assistant`/`tool`/`tool_result` messages appended to the thread at the end. When such a task starts, its prompt is prefixed with recent thread messages (token-budget aware). Dashboard has a "Threads" view listing active threads and letting operators inspect transcripts.

**Tech Stack:** Node.js, better-sqlite3, SQLite FTS5 for transcript search. Builds on plans 14 (events), 27 (state), 47 (agent memory).

---

## File Structure

**New files:**
- `server/migrations/0NN-threads.sql`
- `server/threads/thread-store.js`
- `server/threads/prompt-prefix.js` — render recent history into prompt
- `server/tests/thread-store.test.js`
- `server/tests/prompt-prefix.test.js`
- `dashboard/src/views/Threads.jsx`

**Modified files:**
- `server/tool-defs/task-defs.js` — accept `thread_id`
- `server/execution/task-startup.js` — prefix prompt + append result
- `server/handlers/mcp-tools.js` — `create_thread`, `list_threads`, `get_thread`

---

## Task 1: Migration + store

- [ ] **Step 1: Migration**

`server/migrations/0NN-threads.sql`:

```sql
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  domain_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'   -- 'active' | 'archived'
);

CREATE TABLE IF NOT EXISTS thread_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  task_id TEXT,
  role TEXT NOT NULL,                     -- 'user' | 'assistant' | 'tool' | 'tool_result' | 'system'
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_time ON thread_messages(thread_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS thread_messages_fts USING fts5(content, content='thread_messages', content_rowid='rowid');
```

- [ ] **Step 2: Tests**

Create `server/tests/thread-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createThreadStore } = require('../threads/thread-store');

describe('threadStore', () => {
  let db, store;
  beforeEach(() => {
    db = setupTestDb();
    store = createThreadStore({ db });
  });

  it('create assigns ID + persists name', () => {
    const id = store.create({ name: 'ops-2026-04' });
    expect(id).toMatch(/^thr_/);
    const t = store.get(id);
    expect(t.name).toBe('ops-2026-04');
  });

  it('create is idempotent by name — returns existing id if present', () => {
    const id1 = store.create({ name: 'shared' });
    const id2 = store.create({ name: 'shared' });
    expect(id1).toBe(id2);
  });

  it('append stores messages and updates last_activity_at', () => {
    const id = store.create({ name: 't' });
    store.append(id, { role: 'user', content: 'Hi' });
    store.append(id, { role: 'assistant', content: 'Hello' });
    const msgs = store.recent(id, 10);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    const t = store.get(id);
    expect(t.last_activity_at).not.toBeNull();
  });

  it('recent honors limit + orders chronologically', () => {
    const id = store.create({ name: 't' });
    for (let i = 0; i < 10; i++) store.append(id, { role: 'user', content: `msg ${i}` });
    const recent = store.recent(id, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toBe('msg 7');
    expect(recent[2].content).toBe('msg 9');
  });

  it('archive sets status', () => {
    const id = store.create({ name: 't' });
    store.archive(id);
    expect(store.get(id).status).toBe('archived');
  });

  it('list returns active by default', () => {
    store.create({ name: 'a' });
    const b = store.create({ name: 'b' });
    store.archive(b);
    const active = store.list();
    expect(active.map(t => t.name)).toEqual(['a']);
  });

  it('search finds messages by FTS', () => {
    const id = store.create({ name: 't' });
    store.append(id, { role: 'user', content: 'what about postgres?' });
    store.append(id, { role: 'assistant', content: 'let us use redis' });
    const r = store.search(id, 'postgres');
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].content).toMatch(/postgres/);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/threads/thread-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createThreadStore({ db }) {
  function create({ name, description = null, domainId = null }) {
    const existing = db.prepare('SELECT thread_id FROM threads WHERE name = ?').get(name);
    if (existing) return existing.thread_id;
    const id = `thr_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO threads (thread_id, name, description, domain_id) VALUES (?,?,?,?)`)
      .run(id, name, description, domainId);
    return id;
  }

  function get(id) { return db.prepare('SELECT * FROM threads WHERE thread_id = ?').get(id) || null; }

  function list({ includeArchived = false } = {}) {
    const sql = `SELECT * FROM threads ${includeArchived ? '' : `WHERE status = 'active'`} ORDER BY last_activity_at DESC NULLS LAST`;
    return db.prepare(sql).all();
  }

  function append(threadId, { role, content, taskId = null, metadata = null }) {
    const id = `msg_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO thread_messages (message_id, thread_id, task_id, role, content, metadata_json) VALUES (?,?,?,?,?,?)`)
      .run(id, threadId, taskId, role, content, metadata ? JSON.stringify(metadata) : null);
    try {
      db.prepare(`INSERT INTO thread_messages_fts (rowid, content) SELECT rowid, content FROM thread_messages WHERE message_id = ?`).run(id);
    } catch { /* FTS may be absent in minimal envs */ }
    db.prepare(`UPDATE threads SET last_activity_at = datetime('now') WHERE thread_id = ?`).run(threadId);
    return id;
  }

  function recent(threadId, limit = 20) {
    return db.prepare(`SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(threadId, limit).reverse();
  }

  function search(threadId, query, limit = 20) {
    try {
      return db.prepare(`
        SELECT m.* FROM thread_messages m
        JOIN thread_messages_fts fts ON m.rowid = fts.rowid
        WHERE m.thread_id = ? AND thread_messages_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(threadId, query, limit);
    } catch {
      return db.prepare(`SELECT * FROM thread_messages WHERE thread_id = ? AND content LIKE ? LIMIT ?`)
        .all(threadId, `%${query}%`, limit);
    }
  }

  function archive(id) { db.prepare(`UPDATE threads SET status = 'archived' WHERE thread_id = ?`).run(id); }

  return { create, get, list, append, recent, search, archive };
}

module.exports = { createThreadStore };
```

Run tests → PASS. Commit: `feat(threads): thread store with FTS-backed search`.

---

## Task 2: Prompt prefix + wire into task lifecycle

- [ ] **Step 1: Prefix tests + impl**

Create `server/tests/prompt-prefix.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createThreadStore } = require('../threads/thread-store');
const { buildPromptPrefix } = require('../threads/prompt-prefix');

describe('buildPromptPrefix', () => {
  let db, store;
  beforeEach(() => {
    db = setupTestDb();
    store = createThreadStore({ db });
  });

  it('returns empty string when thread is empty', () => {
    const id = store.create({ name: 't' });
    expect(buildPromptPrefix(store, id)).toBe('');
  });

  it('renders recent messages as role-tagged lines', () => {
    const id = store.create({ name: 't' });
    store.append(id, { role: 'user', content: 'What is 2+2?' });
    store.append(id, { role: 'assistant', content: '4' });
    const prefix = buildPromptPrefix(store, id);
    expect(prefix).toMatch(/user: What is/);
    expect(prefix).toMatch(/assistant: 4/);
  });

  it('honors tokenBudget by truncating older messages', () => {
    const id = store.create({ name: 't' });
    for (let i = 0; i < 50; i++) store.append(id, { role: 'user', content: 'x'.repeat(200) });
    const prefix = buildPromptPrefix(store, id, { tokenBudget: 500 });
    expect(prefix.length).toBeLessThan(3000);
  });
});
```

Create `server/threads/prompt-prefix.js`:

```js
'use strict';

function buildPromptPrefix(threadStore, threadId, { tokenBudget = 2000, headerText = 'Thread history:' } = {}) {
  const msgs = threadStore.recent(threadId, 100);
  if (msgs.length === 0) return '';
  // Approx 4 chars/token. Include newest-first, then reverse.
  const maxChars = tokenBudget * 4;
  const selected = [];
  let total = headerText.length + 10;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const line = `${msgs[i].role}: ${msgs[i].content}`;
    if (total + line.length > maxChars) break;
    selected.push(line);
    total += line.length + 1;
  }
  selected.reverse();
  return `${headerText}\n${selected.join('\n')}\n\n---\n\n`;
}

module.exports = { buildPromptPrefix };
```

- [ ] **Step 2: Tool def + startup hook**

In `server/tool-defs/task-defs.js`:

```js
thread_id: { type: 'string', description: 'Named thread this task participates in. All messages (user instruction + assistant response + tool calls) are appended to the thread history.' },
thread_name: { type: 'string', description: 'Shortcut: create or reuse a thread by name (auto-creates if missing).' },
```

In `server/execution/task-startup.js` after metadata parsing:

```js
const meta = parseTaskMetadata(task);
let threadId = meta.thread_id;
if (!threadId && meta.thread_name) {
  threadId = defaultContainer.get('threadStore').create({ name: meta.thread_name });
}
if (threadId) {
  const { buildPromptPrefix } = require('../threads/prompt-prefix');
  const prefix = buildPromptPrefix(defaultContainer.get('threadStore'), threadId);
  task.task_description = prefix + task.task_description;
  // Also record the user message that kicks off this turn
  defaultContainer.get('threadStore').append(threadId, {
    role: 'user', content: task.task_description, taskId,
  });
  task.__thread_id = threadId;
}
```

In `server/execution/task-finalizer.js` on success:

```js
if (task.__thread_id && finalOutput) {
  defaultContainer.get('threadStore').append(task.__thread_id, {
    role: 'assistant', content: typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput),
    taskId,
  });
}
```

- [ ] **Step 3: MCP tools**

```js
create_thread: { description: 'Create or get a thread by name.', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } } },
list_threads: { description: 'List active threads.', inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean' } } } },
get_thread: { description: 'Fetch thread metadata + recent messages.', inputSchema: { type: 'object', required: ['thread_id'], properties: { thread_id: { type: 'string' }, recent: { type: 'integer', default: 20 } } } },
search_thread: { description: 'FTS search over thread messages.', inputSchema: { type: 'object', required: ['thread_id','query'], properties: { thread_id: {type:'string'}, query: {type:'string'} } } },
```

Container:

```js
container.factory('threadStore', (c) => require('./threads/thread-store').createThreadStore({ db: c.get('db') }));
```

`await_restart`. Smoke: submit task 1 with `thread_name: 'ops-test'` and prompt "remember that we chose Postgres". Submit task 2 with same `thread_name` and prompt "What DB did we pick?" Confirm task 2's response references Postgres.

Commit: `feat(threads): persistent thread primitive wired into task lifecycle`.
