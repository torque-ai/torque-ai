# Fabro #39: Workflow Visibility Query Layer (Cadence)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a SQL-like search layer over workflows + tasks: `provider=codex AND failure_class=verify_failed AND created_after=2026-04-01 ORDER BY duration DESC LIMIT 50`. Includes mutable per-workflow search attributes that tasks can update at runtime, an allowlist of indexed attribute names, and a SearchWorkflows / CountWorkflows REST API. Inspired by Cadence visibility.

**Architecture:** A new `search_attributes` table holds `(entity_type, entity_id, attribute_name, attribute_value)` rows with a per-domain allowlist enforced at write time. A new `query-parser.js` module parses a small filter DSL into safe parameterized SQL. Workflows and tasks both index a base set of standard attributes (provider, status, failure_class, duration_seconds, etc.); user-defined attributes (`upsert_search_attributes(...)` MCP tool) are scoped per domain.

**Tech Stack:** Node.js, better-sqlite3, peggy or hand-written parser. Builds on Plan 38 (domains).

---

## File Structure

**New files:**
- `server/migrations/0NN-search-attributes.sql`
- `server/visibility/query-parser.js`
- `server/visibility/search-engine.js`
- `server/visibility/standard-attrs.js` — built-in attrs always indexed
- `server/tests/query-parser.test.js`
- `server/tests/search-engine.test.js`
- `dashboard/src/views/SearchWorkflows.jsx`

**Modified files:**
- `server/handlers/mcp-tools.js` — `search_workflows`, `count_workflows`, `upsert_search_attributes`
- `server/tool-defs/`
- `server/execution/task-finalizer.js` — index standard attrs on completion

---

## Task 1: Migration + standard attributes

- [ ] **Step 1: Migration**

`server/migrations/0NN-search-attributes.sql`:

```sql
CREATE TABLE IF NOT EXISTS search_attributes (
  entity_type TEXT NOT NULL,           -- 'workflow' | 'task'
  entity_id TEXT NOT NULL,
  domain_id TEXT,
  attribute_name TEXT NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_bool INTEGER,
  value_datetime TEXT,
  PRIMARY KEY (entity_type, entity_id, attribute_name)
);

CREATE INDEX IF NOT EXISTS idx_search_attrs_name_text   ON search_attributes(attribute_name, value_text);
CREATE INDEX IF NOT EXISTS idx_search_attrs_name_number ON search_attributes(attribute_name, value_number);
CREATE INDEX IF NOT EXISTS idx_search_attrs_domain      ON search_attributes(domain_id, attribute_name);

CREATE TABLE IF NOT EXISTS search_attribute_definitions (
  attribute_name TEXT NOT NULL,
  domain_id TEXT,
  value_type TEXT NOT NULL,            -- 'text' | 'number' | 'bool' | 'datetime'
  PRIMARY KEY (attribute_name, domain_id)
);
```

- [ ] **Step 2: Standard attributes**

Create `server/visibility/standard-attrs.js`:

```js
'use strict';

// Standard attributes always indexed for every workflow/task.
// (attribute_name, value_type, source_extractor)
const STANDARD_TASK_ATTRS = [
  { name: 'provider',        type: 'text',     extract: (t) => t.provider },
  { name: 'status',          type: 'text',     extract: (t) => t.status },
  { name: 'failure_class',   type: 'text',     extract: (t) => parseMeta(t).failure_class },
  { name: 'duration_seconds',type: 'number',   extract: (t) => t.duration_seconds || null },
  { name: 'created_at',      type: 'datetime', extract: (t) => t.created_at },
  { name: 'completed_at',    type: 'datetime', extract: (t) => t.completed_at },
  { name: 'concurrency_key', type: 'text',     extract: (t) => t.concurrency_key },
  { name: 'work_pool',       type: 'text',     extract: (t) => t.work_pool },
];

const STANDARD_WORKFLOW_ATTRS = [
  { name: 'status',       type: 'text',     extract: (w) => w.status },
  { name: 'name',         type: 'text',     extract: (w) => w.name },
  { name: 'created_at',   type: 'datetime', extract: (w) => w.created_at },
  { name: 'completed_at', type: 'datetime', extract: (w) => w.completed_at },
  { name: 'task_count',   type: 'number',   extract: (w) => w.task_count || null },
];

function parseMeta(row) {
  if (!row || !row.metadata) return {};
  if (typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row.metadata); } catch { return {}; }
}

module.exports = { STANDARD_TASK_ATTRS, STANDARD_WORKFLOW_ATTRS, parseMeta };
```

Commit: `feat(visibility): table + standard attribute definitions`.

---

## Task 2: Query parser

- [ ] **Step 1: Tests**

Create `server/tests/query-parser.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { parseQuery } = require('../visibility/query-parser');

describe('parseQuery', () => {
  it('parses a single equality clause', () => {
    const ast = parseQuery('provider = "codex"');
    expect(ast.where).toEqual([{ name: 'provider', op: '=', value: 'codex' }]);
  });

  it('parses AND of multiple clauses', () => {
    const ast = parseQuery('provider = "codex" AND status = "completed"');
    expect(ast.where).toHaveLength(2);
    expect(ast.where[0]).toEqual({ name: 'provider', op: '=', value: 'codex' });
    expect(ast.where[1]).toEqual({ name: 'status', op: '=', value: 'completed' });
  });

  it('supports numeric comparisons', () => {
    const ast = parseQuery('duration_seconds > 60');
    expect(ast.where[0]).toEqual({ name: 'duration_seconds', op: '>', value: 60 });
  });

  it('supports IN with list', () => {
    const ast = parseQuery('failure_class IN ("verify_failed","timeout")');
    expect(ast.where[0]).toEqual({ name: 'failure_class', op: 'IN', value: ['verify_failed', 'timeout'] });
  });

  it('parses ORDER BY clause', () => {
    const ast = parseQuery('status = "completed" ORDER BY duration_seconds DESC');
    expect(ast.orderBy).toEqual({ name: 'duration_seconds', dir: 'DESC' });
  });

  it('parses LIMIT clause', () => {
    const ast = parseQuery('status = "running" LIMIT 25');
    expect(ast.limit).toBe(25);
  });

  it('rejects malformed input', () => {
    expect(() => parseQuery('this is not a query')).toThrow();
    expect(() => parseQuery('provider =')).toThrow();
    expect(() => parseQuery('LIMIT abc')).toThrow();
  });
});
```

- [ ] **Step 2: Implement (small hand-written parser)**

Create `server/visibility/query-parser.js`:

```js
'use strict';

// Tiny tokenizer + recursive descent parser for our visibility DSL.
// Grammar (simplified):
//   Query := WhereClause? ('ORDER BY' Identifier ('ASC'|'DESC')?)? ('LIMIT' Number)?
//   WhereClause := Predicate ('AND' Predicate)*
//   Predicate := Identifier Op Value
//   Op := '=' | '!=' | '>' | '<' | '>=' | '<=' | 'IN'
//   Value := String | Number | List

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const len = input.length;
  while (i < len) {
    const c = input[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < len && input[j] !== q) j++;
      tokens.push({ type: 'string', value: input.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(input[i + 1]))) {
      let j = i + 1;
      while (j < len && /[0-9.]/.test(input[j])) j++;
      tokens.push({ type: 'number', value: parseFloat(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === '(' || c === ')') { tokens.push({ type: c }); i++; continue; }
    if (c === ',') { tokens.push({ type: ',' }); i++; continue; }
    if (input.slice(i, i + 2) === '!=') { tokens.push({ type: 'op', value: '!=' }); i += 2; continue; }
    if (input.slice(i, i + 2) === '>=') { tokens.push({ type: 'op', value: '>=' }); i += 2; continue; }
    if (input.slice(i, i + 2) === '<=') { tokens.push({ type: 'op', value: '<=' }); i += 2; continue; }
    if (c === '=' || c === '>' || c === '<') { tokens.push({ type: 'op', value: c }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_]/.test(input[j])) j++;
      const word = input.slice(i, j);
      const upper = word.toUpperCase();
      if (['AND', 'IN', 'ORDER', 'BY', 'LIMIT', 'ASC', 'DESC'].includes(upper)) {
        tokens.push({ type: 'kw', value: upper });
      } else {
        tokens.push({ type: 'ident', value: word });
      }
      i = j;
      continue;
    }
    throw new Error(`Unexpected character at position ${i}: ${c}`);
  }
  return tokens;
}

function parseQuery(input) {
  const tokens = tokenize(input);
  let pos = 0;

  function peek(n = 0) { return tokens[pos + n]; }
  function consume(type, value) {
    const t = tokens[pos];
    if (!t) throw new Error('Unexpected end of query');
    if (type && t.type !== type) throw new Error(`Expected ${type}, got ${t.type}`);
    if (value !== undefined && t.value !== value) throw new Error(`Expected ${value}, got ${t.value}`);
    pos++;
    return t;
  }

  function parseValue() {
    const t = peek();
    if (!t) throw new Error('Expected value');
    if (t.type === 'string' || t.type === 'number') { pos++; return t.value; }
    if (t.type === '(') {
      consume('(');
      const items = [];
      while (peek() && peek().type !== ')') {
        const v = parseValue();
        items.push(v);
        if (peek() && peek().type === ',') consume(',');
      }
      consume(')');
      return items;
    }
    throw new Error(`Expected value, got ${t.type}`);
  }

  function parsePredicate() {
    const ident = consume('ident').value;
    const op = consume('op').value;  // for IN we allow keyword too — extend below
    if (op === undefined) {
      // IN keyword
      const kw = consume('kw').value;
      if (kw !== 'IN') throw new Error(`Expected IN, got ${kw}`);
      const list = parseValue();
      return { name: ident, op: 'IN', value: list };
    }
    const value = parseValue();
    return { name: ident, op, value };
  }

  // Special: for IN we need to handle the keyword
  function parsePredicateOrIn() {
    const ident = consume('ident').value;
    const next = peek();
    if (next && next.type === 'kw' && next.value === 'IN') {
      consume('kw', 'IN');
      const list = parseValue();
      return { name: ident, op: 'IN', value: list };
    }
    if (next && next.type === 'op') {
      const op = consume('op').value;
      const value = parseValue();
      return { name: ident, op, value };
    }
    throw new Error(`Expected operator after ${ident}`);
  }

  const where = [];
  while (peek() && peek().type === 'ident') {
    where.push(parsePredicateOrIn());
    if (peek() && peek().type === 'kw' && peek().value === 'AND') {
      consume('kw', 'AND');
    } else { break; }
  }

  let orderBy = null;
  if (peek() && peek().type === 'kw' && peek().value === 'ORDER') {
    consume('kw', 'ORDER');
    consume('kw', 'BY');
    const name = consume('ident').value;
    let dir = 'ASC';
    if (peek() && peek().type === 'kw' && (peek().value === 'ASC' || peek().value === 'DESC')) {
      dir = consume('kw').value;
    }
    orderBy = { name, dir };
  }

  let limit = null;
  if (peek() && peek().type === 'kw' && peek().value === 'LIMIT') {
    consume('kw', 'LIMIT');
    const n = consume('number').value;
    if (!Number.isInteger(n)) throw new Error('LIMIT must be an integer');
    limit = n;
  }

  if (peek()) throw new Error(`Unexpected trailing token: ${JSON.stringify(peek())}`);
  return { where, orderBy, limit };
}

module.exports = { parseQuery };
```

Run tests → PASS. Commit: `feat(visibility): query parser for filter DSL`.

---

## Task 3: Search engine

- [ ] **Step 1: Tests**

Create `server/tests/search-engine.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createSearchEngine } = require('../visibility/search-engine');

describe('search-engine', () => {
  let db, engine;

  beforeEach(() => {
    db = setupTestDb();
    engine = createSearchEngine({ db });

    // Seed some search_attribute rows
    db.prepare(`INSERT INTO search_attributes (entity_type, entity_id, attribute_name, value_text) VALUES
      ('task','t1','provider','codex'),
      ('task','t2','provider','ollama'),
      ('task','t3','provider','codex'),
      ('task','t1','status','completed'),
      ('task','t2','status','failed'),
      ('task','t3','status','completed')`).run();
    db.prepare(`INSERT INTO search_attributes (entity_type, entity_id, attribute_name, value_number) VALUES
      ('task','t1','duration_seconds',12),
      ('task','t2','duration_seconds',45),
      ('task','t3','duration_seconds',120)`).run();
  });

  it('returns ids matching a single equality', () => {
    const r = engine.search('task', 'provider = "codex"');
    expect(r.results.sort()).toEqual(['t1','t3']);
  });

  it('combines AND clauses', () => {
    const r = engine.search('task', 'provider = "codex" AND status = "completed"');
    expect(r.results.sort()).toEqual(['t1','t3']);
  });

  it('honors numeric comparisons', () => {
    const r = engine.search('task', 'duration_seconds > 30');
    expect(r.results.sort()).toEqual(['t2','t3']);
  });

  it('honors IN', () => {
    const r = engine.search('task', 'provider IN ("codex","ollama")');
    expect(r.results.sort()).toEqual(['t1','t2','t3']);
  });

  it('count returns count without ids', () => {
    const r = engine.count('task', 'status = "completed"');
    expect(r.count).toBe(2);
  });

  it('honors LIMIT', () => {
    const r = engine.search('task', 'provider = "codex" LIMIT 1');
    expect(r.results.length).toBe(1);
  });

  it('rejects unknown attribute when allowlist enforced', () => {
    expect(() => engine.search('task', 'unknown_attr = "x"', { strict: true })).toThrow(/unknown attribute/i);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/visibility/search-engine.js`:

```js
'use strict';
const { parseQuery } = require('./query-parser');

const COL_FOR_VALUE = (v) => {
  if (typeof v === 'number') return 'value_number';
  if (typeof v === 'boolean') return 'value_bool';
  return 'value_text';
};

function createSearchEngine({ db }) {
  function buildSql(entityType, ast) {
    const params = [entityType];
    let sql = `SELECT entity_id FROM search_attributes WHERE entity_type = ?`;

    for (const clause of (ast.where || [])) {
      if (clause.op === 'IN') {
        const placeholders = clause.value.map(() => '?').join(',');
        const col = COL_FOR_VALUE(clause.value[0]);
        sql += ` AND entity_id IN (
          SELECT entity_id FROM search_attributes
          WHERE entity_type = ? AND attribute_name = ? AND ${col} IN (${placeholders})
        )`;
        params.push(entityType, clause.name, ...clause.value);
      } else {
        const col = COL_FOR_VALUE(clause.value);
        sql += ` AND entity_id IN (
          SELECT entity_id FROM search_attributes
          WHERE entity_type = ? AND attribute_name = ? AND ${col} ${clause.op} ?
        )`;
        params.push(entityType, clause.name, clause.value);
      }
    }

    sql += ` GROUP BY entity_id`;

    if (ast.orderBy) {
      sql += ` ORDER BY (
        SELECT COALESCE(value_number, value_text) FROM search_attributes
        WHERE entity_type = '${entityType.replace(/'/g, "''")}' AND attribute_name = '${ast.orderBy.name.replace(/'/g, "''")}' AND entity_id = search_attributes.entity_id LIMIT 1
      ) ${ast.orderBy.dir}`;
    }
    if (ast.limit) sql += ` LIMIT ${parseInt(ast.limit, 10)}`;
    return { sql, params };
  }

  function search(entityType, queryString, { strict = false } = {}) {
    const ast = parseQuery(queryString);
    if (strict) {
      const known = new Set(db.prepare('SELECT DISTINCT attribute_name FROM search_attributes WHERE entity_type = ?').all(entityType).map(r => r.attribute_name));
      for (const c of ast.where) {
        if (!known.has(c.name)) throw new Error(`Unknown attribute '${c.name}' for entity type ${entityType}`);
      }
    }
    const { sql, params } = buildSql(entityType, ast);
    const rows = db.prepare(sql).all(...params);
    return { count: rows.length, results: rows.map(r => r.entity_id) };
  }

  function count(entityType, queryString) {
    const r = search(entityType, queryString);
    return { count: r.count };
  }

  function upsertAttribute({ entityType, entityId, domainId = null, name, value }) {
    const cols = { value_text: null, value_number: null, value_bool: null, value_datetime: null };
    if (typeof value === 'number') cols.value_number = value;
    else if (typeof value === 'boolean') cols.value_bool = value ? 1 : 0;
    else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) cols.value_datetime = value;
    else cols.value_text = String(value);

    db.prepare(`
      INSERT INTO search_attributes (entity_type, entity_id, domain_id, attribute_name, value_text, value_number, value_bool, value_datetime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id, attribute_name) DO UPDATE SET
        value_text = excluded.value_text,
        value_number = excluded.value_number,
        value_bool = excluded.value_bool,
        value_datetime = excluded.value_datetime
    `).run(entityType, entityId, domainId, name, cols.value_text, cols.value_number, cols.value_bool, cols.value_datetime);
  }

  return { search, count, upsertAttribute };
}

module.exports = { createSearchEngine };
```

Run tests → PASS. Commit: `feat(visibility): search engine over search_attributes`.

---

## Task 4: Index standard attrs + MCP surface

- [ ] **Step 1: Index from finalizer**

In `server/execution/task-finalizer.js` after task completes:

```js
const engine = defaultContainer.get('searchEngine');
const { STANDARD_TASK_ATTRS } = require('../visibility/standard-attrs');
for (const a of STANDARD_TASK_ATTRS) {
  const v = a.extract(task);
  if (v !== null && v !== undefined) {
    engine.upsertAttribute({ entityType: 'task', entityId: task.task_id, domainId: task.domain_id, name: a.name, value: v });
  }
}
```

Same for workflow finalization.

- [ ] **Step 2: MCP tools**

In `server/tool-defs/`:

```js
search_workflows: {
  description: 'Search workflows using a SQL-like filter DSL: `status = "completed" AND created_after > "2026-04-01" ORDER BY duration_seconds DESC LIMIT 50`.',
  inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
},
search_tasks: { description: 'Same DSL, scoped to tasks.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
count_workflows: { description: 'Count matches without returning IDs.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
upsert_search_attributes: {
  description: 'Add or update custom search attributes on a workflow or task.',
  inputSchema: {
    type: 'object',
    required: ['entity_type', 'entity_id', 'attributes'],
    properties: {
      entity_type: { type: 'string', enum: ['workflow', 'task'] },
      entity_id: { type: 'string' },
      attributes: { type: 'object' },
    },
  },
},
```

- [ ] **Step 3: Handlers**

```js
case 'search_workflows':
  return defaultContainer.get('searchEngine').search('workflow', args.query);
case 'search_tasks':
  return defaultContainer.get('searchEngine').search('task', args.query);
case 'count_workflows':
  return defaultContainer.get('searchEngine').count('workflow', args.query);
case 'upsert_search_attributes': {
  const engine = defaultContainer.get('searchEngine');
  for (const [name, value] of Object.entries(args.attributes)) {
    engine.upsertAttribute({ entityType: args.entity_type, entityId: args.entity_id, name, value });
  }
  return { ok: true };
}
```

- [ ] **Step 4: Container + dashboard**

```js
container.factory('searchEngine', (c) => require('./visibility/search-engine').createSearchEngine({ db: c.get('db') }));
```

Dashboard: `dashboard/src/views/SearchWorkflows.jsx` with a query input box, results table, and link-out to each workflow detail page.

`await_restart`. Smoke: run a few workflows with mixed providers/statuses, then call `search_workflows({query: 'status = "completed"'})`. Confirm the IDs match.

Commit: `feat(visibility): MCP tools + dashboard search panel`.
