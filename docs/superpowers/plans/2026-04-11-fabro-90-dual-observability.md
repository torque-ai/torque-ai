# Fabro #90: Dual-Integration Observability + Properties (Helicone)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Two adoption paths for TORQUE observability from external callers: **proxy mode** (inline, can enforce policy, adds latency) and **async-log mode** (off critical path, zero propagation delay, observe only). Both accept **properties** — arbitrary metadata headers like `X-TORQUE-Property-Env`, `X-TORQUE-User`, `X-TORQUE-Feature` — that become first-class dimensions in dashboards and analytics. Inspired by Helicone.

**Architecture:** An `observability-gateway.js` exposes two endpoints:
- `POST /observe` (proxy) — receives LLM request + target URL, forwards it, records span, returns response. Latency cost included.
- `POST /observe/async` — fire-and-forget log that returns 202 before logging completes.

Both extract `X-TORQUE-Property-*` headers as dimensional metadata and write it onto Plan 68 traces/scores. A query layer lets dashboards filter traces by any property combination (env/user/feature/customer).

**Tech Stack:** Node.js, Express, existing provider adapters. Builds on plans 46 (trace), 68 (observability), 78 (otel), 89 (budget).

---

## File Structure

**New files:**
- `server/observability/observe-gateway.js`
- `server/observability/property-extractor.js`
- `server/observability/async-log-queue.js`
- `server/observability/property-query.js`
- `server/tests/property-extractor.test.js`
- `server/tests/async-log-queue.test.js`
- `server/tests/property-query.test.js`

**Modified files:**
- `server/api/routes/observe.js` — new route mounted under `/observe`
- `server/migrations/0NN-observation-properties.sql`

---

## Task 1: Property extractor

- [ ] **Step 1: Tests**

Create `server/tests/property-extractor.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { extractProperties } = require('../observability/property-extractor');

describe('extractProperties', () => {
  it('extracts X-TORQUE-Property-* headers as key→value map', () => {
    const headers = {
      'x-torque-property-env': 'production',
      'x-torque-property-feature': 'summarize',
      'x-torque-user-id': 'alice',
      'content-type': 'application/json',
    };
    const { properties, user_id } = extractProperties(headers);
    expect(properties).toEqual({ env: 'production', feature: 'summarize' });
    expect(user_id).toBe('alice');
  });

  it('lowercases header names for case-insensitive match', () => {
    const { properties } = extractProperties({ 'X-TORQUE-Property-Env': 'staging' });
    expect(properties.env).toBe('staging');
  });

  it('returns empty properties + null user when none present', () => {
    const { properties, user_id } = extractProperties({ 'content-type': 'application/json' });
    expect(properties).toEqual({});
    expect(user_id).toBeNull();
  });

  it('handles session + request id headers', () => {
    const { session_id, request_id } = extractProperties({
      'x-torque-session-id': 'sess-123',
      'x-torque-request-id': 'req-abc',
    });
    expect(session_id).toBe('sess-123');
    expect(request_id).toBe('req-abc');
  });

  it('rejects property names with invalid characters', () => {
    const { properties } = extractProperties({ 'x-torque-property-$$bad': 'x', 'x-torque-property-good': 'y' });
    expect(properties).toEqual({ good: 'y' });
  });

  it('trims whitespace from values', () => {
    const { properties } = extractProperties({ 'x-torque-property-env': '  prod  ' });
    expect(properties.env).toBe('prod');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/observability/property-extractor.js`:

```js
'use strict';

const PROPERTY_PREFIX = 'x-torque-property-';
const VALID_NAME_RE = /^[a-z0-9_-]+$/;

function extractProperties(headers) {
  const properties = {};
  let user_id = null;
  let session_id = null;
  let request_id = null;

  for (const [rawKey, rawVal] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase();
    const val = typeof rawVal === 'string' ? rawVal.trim() : rawVal;
    if (key.startsWith(PROPERTY_PREFIX)) {
      const name = key.slice(PROPERTY_PREFIX.length);
      if (VALID_NAME_RE.test(name)) properties[name] = val;
    } else if (key === 'x-torque-user-id') {
      user_id = val;
    } else if (key === 'x-torque-session-id') {
      session_id = val;
    } else if (key === 'x-torque-request-id') {
      request_id = val;
    }
  }
  return { properties, user_id, session_id, request_id };
}

module.exports = { extractProperties };
```

Run tests → PASS. Commit: `feat(observe): property extractor with user/session/request headers`.

---

## Task 2: Async log queue

- [ ] **Step 1: Migration**

`server/migrations/0NN-observation-properties.sql`:

```sql
CREATE TABLE IF NOT EXISTS observations (
  observation_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,           -- 'external_call' | 'internal_task' | 'internal_tool'
  user_id TEXT,
  session_id TEXT,
  request_id TEXT,
  provider TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  latency_ms INTEGER,
  input_summary TEXT,
  output_summary TEXT,
  properties_json TEXT,
  status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_observations_user ON observations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id, created_at);
```

- [ ] **Step 2: Queue tests + impl**

Create `server/tests/async-log-queue.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createAsyncLogQueue } = require('../observability/async-log-queue');

describe('asyncLogQueue', () => {
  let db, queue;
  beforeEach(() => { db = setupTestDb(); queue = createAsyncLogQueue({ db, batchSize: 3 }); });

  it('enqueue returns immediately, flush writes to DB', async () => {
    queue.enqueue({ subjectType: 'external_call', provider: 'codex', properties: { env: 'prod' } });
    await queue.flush();
    const rows = db.prepare('SELECT * FROM observations').all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].properties_json).env).toBe('prod');
  });

  it('automatic flush when batch_size reached', async () => {
    for (let i = 0; i < 3; i++) {
      queue.enqueue({ subjectType: 'external_call', provider: 'p', properties: {} });
    }
    await new Promise(r => setTimeout(r, 10)); // let auto-flush settle
    await queue.flush();
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n).toBe(3);
  });

  it('drop oldest when queue fills beyond maxSize', async () => {
    const q = createAsyncLogQueue({ db, batchSize: 1000, maxSize: 5 });
    for (let i = 0; i < 10; i++) q.enqueue({ subjectType: 'x', provider: 'p', properties: { i: String(i) } });
    expect(q.queueSize()).toBe(5);
    await q.flush();
    const rows = db.prepare('SELECT properties_json FROM observations').all();
    const is = rows.map(r => parseInt(JSON.parse(r.properties_json).i, 10)).sort((a,b) => a - b);
    expect(Math.min(...is)).toBe(5); // earliest 5 dropped
  });
});
```

Create `server/observability/async-log-queue.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createAsyncLogQueue({ db, batchSize = 50, flushIntervalMs = 2000, maxSize = 10000 }) {
  const buffer = [];

  function enqueue(entry) {
    buffer.push(entry);
    if (buffer.length > maxSize) buffer.splice(0, buffer.length - maxSize);
    if (buffer.length >= batchSize) setImmediate(flush);
  }

  async function flush() {
    if (buffer.length === 0) return;
    const toWrite = buffer.splice(0);
    const stmt = db.prepare(`
      INSERT INTO observations (observation_id, subject_type, user_id, session_id, request_id, provider, model, prompt_tokens, completion_tokens, latency_ms, input_summary, output_summary, properties_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((entries) => {
      for (const e of entries) {
        stmt.run(
          `obs_${randomUUID().slice(0, 12)}`, e.subjectType, e.user_id || null, e.session_id || null, e.request_id || null,
          e.provider || null, e.model || null, e.prompt_tokens || null, e.completion_tokens || null, e.latency_ms || null,
          e.input_summary || null, e.output_summary || null, JSON.stringify(e.properties || {}), e.status || 'logged',
        );
      }
    });
    tx(toWrite);
  }

  function queueSize() { return buffer.length; }

  setInterval(() => { flush().catch(() => {}); }, flushIntervalMs).unref?.();

  return { enqueue, flush, queueSize };
}

module.exports = { createAsyncLogQueue };
```

Run tests → PASS. Commit: `feat(observe): async log queue with batch flush + drop-oldest overflow`.

---

## Task 3: Gateway + property query + REST

- [ ] **Step 1: Property query**

Create `server/observability/property-query.js`:

```js
'use strict';

// Query observations by property dimensions.
function queryObservations({ db, filters = {}, window = null, limit = 500 }) {
  const where = [];
  const params = [];
  for (const [name, value] of Object.entries(filters)) {
    where.push(`json_extract(properties_json, '$.${name.replace(/"/g, '')}') = ?`);
    params.push(value);
  }
  if (window?.since) { where.push(`created_at >= ?`); params.push(window.since); }
  const sql = `SELECT * FROM observations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit);
}

function aggregateByProperty({ db, propertyName, filters = {}, window = null }) {
  const extraWhere = [];
  const params = [];
  for (const [name, value] of Object.entries(filters)) {
    extraWhere.push(`json_extract(properties_json, '$.${name.replace(/"/g, '')}') = ?`);
    params.push(value);
  }
  if (window?.since) { extraWhere.push(`created_at >= ?`); params.push(window.since); }
  const sql = `
    SELECT json_extract(properties_json, '$.${propertyName.replace(/"/g, '')}') AS value,
           COUNT(*) AS count,
           AVG(latency_ms) AS avg_latency_ms,
           SUM(prompt_tokens) AS total_prompt_tokens,
           SUM(completion_tokens) AS total_completion_tokens
    FROM observations ${extraWhere.length ? 'WHERE ' + extraWhere.join(' AND ') : ''}
    GROUP BY value ORDER BY count DESC
  `;
  return db.prepare(sql).all(...params);
}

module.exports = { queryObservations, aggregateByProperty };
```

Tests cover: filter by single property, filter by multiple, aggregate by property returns grouped counts.

- [ ] **Step 2: Gateway + REST**

Create `server/api/routes/observe.js`:

```js
'use strict';
const express = require('express');
const router = express.Router();
const { defaultContainer } = require('../../container');
const { extractProperties } = require('../../observability/property-extractor');

// Async logging: fast ACK, no latency on critical path
router.post('/async', express.json({ limit: '4mb' }), (req, res) => {
  const { properties, user_id, session_id, request_id } = extractProperties(req.headers);
  const body = req.body || {};
  defaultContainer.get('asyncLogQueue').enqueue({
    subjectType: body.subject_type || 'external_call',
    user_id, session_id, request_id,
    provider: body.provider, model: body.model,
    prompt_tokens: body.prompt_tokens, completion_tokens: body.completion_tokens,
    latency_ms: body.latency_ms,
    input_summary: body.input_summary?.slice(0, 500),
    output_summary: body.output_summary?.slice(0, 500),
    properties,
    status: body.status || 'logged',
  });
  res.status(202).json({ ok: true });
});

// Proxy mode: forward request, measure latency, log, return response
router.post('/', express.json({ limit: '8mb' }), async (req, res) => {
  const { properties, user_id, session_id, request_id } = extractProperties(req.headers);
  const { target_url, provider, method = 'POST', body, headers: forwardedHeaders = {} } = req.body || {};
  if (!target_url) return res.status(400).json({ error: 'target_url required' });
  const start = Date.now();
  try {
    const resp = await fetch(target_url, { method, headers: forwardedHeaders, body: body ? JSON.stringify(body) : undefined });
    const respBody = await resp.text();
    const latencyMs = Date.now() - start;
    defaultContainer.get('asyncLogQueue').enqueue({
      subjectType: 'external_call', user_id, session_id, request_id,
      provider, latency_ms: latencyMs,
      input_summary: JSON.stringify(body || {}).slice(0, 500),
      output_summary: respBody.slice(0, 500),
      properties, status: `${resp.status}`,
    });
    res.status(resp.status).type(resp.headers.get('content-type') || 'application/json').send(respBody);
  } catch (err) {
    defaultContainer.get('asyncLogQueue').enqueue({
      subjectType: 'external_call', user_id, session_id, request_id,
      provider, latency_ms: Date.now() - start,
      properties, status: 'error',
      output_summary: err.message,
    });
    res.status(502).json({ error: err.message });
  }
});

// Query + aggregate endpoints
router.get('/query', (req, res) => {
  const { queryObservations } = require('../../observability/property-query');
  res.json({ observations: queryObservations({ db: defaultContainer.get('db'), filters: req.query }) });
});

router.get('/aggregate/:property', (req, res) => {
  const { aggregateByProperty } = require('../../observability/property-query');
  res.json({ groups: aggregateByProperty({ db: defaultContainer.get('db'), propertyName: req.params.property, filters: req.query }) });
});

module.exports = router;
```

Mount in `server/index.js`:

```js
const observeRouter = require('./api/routes/observe');
app.use('/observe', observeRouter);
```

Container factory for `asyncLogQueue`.

`await_restart`. Smoke: async log — `curl -X POST http://localhost:3457/observe/async -H 'X-TORQUE-Property-Env: prod' -H 'X-TORQUE-User-Id: alice' -d '{"provider":"codex","prompt_tokens":100}'`. Confirm returns 202 immediately. Within 2s, `curl http://localhost:3457/observe/aggregate/env` shows the `prod` bucket.

Commit: `feat(observe): dual proxy/async gateway + property query + aggregate`.
