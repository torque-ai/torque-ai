# Fabro #68: LLM Observability Platform (Langfuse)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify TORQUE's observability into one platform with four connected surfaces: **sessions** (group related runs), **datasets** (versioned input/expected-output corpora), **prompts-as-assets** (with deployment labels), and **universal scores** (human, API, LLM-judge). Extends Plan 46 (trace waterfall) and Plan 51 (revisions) by tying quality measurement to execution traces + prompt versions. Inspired by Langfuse.

**Architecture:** Four stores, each a module:
- `sessions` — `(session_id, name, tags)`; workflow runs can carry `session_id` to aggregate
- `datasets` — `(dataset_id, name, current_version)` + `dataset_items` + `dataset_versions`
- `prompts` — `(prompt_id, name)` + `prompt_versions` + `prompt_labels` (prod/staging/etc)
- `scores` — `(score_id, subject_type, subject_id, name, value, source, created_at)`

Scores are universal: any object (trace, session, task, dataset-run) can have scores attached. Dashboard surfaces aggregate score per prompt-version × dataset-version, and diff-between-revisions view shows quality deltas.

**Tech Stack:** Node.js, better-sqlite3, existing provider dispatch (for LLM-as-judge). Builds on plans 14, 29, 46, 51.

---

## File Structure

**New files:**
- `server/migrations/0NN-observability-platform.sql`
- `server/observability/session-store.js`
- `server/observability/dataset-store.js`
- `server/observability/prompt-store.js`
- `server/observability/score-store.js`
- `server/observability/llm-judge.js`
- `server/tests/session-store.test.js`
- `server/tests/dataset-store.test.js`
- `server/tests/prompt-store.test.js`
- `server/tests/score-store.test.js`
- `dashboard/src/views/Sessions.jsx`
- `dashboard/src/views/Datasets.jsx`
- `dashboard/src/views/Prompts.jsx`

---

## Task 1: Migration + 4 stores

- [ ] **Step 1: Migration**

`server/migrations/0NN-observability-platform.sql`:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  user_id TEXT, tags_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT
);

CREATE TABLE IF NOT EXISTS datasets (
  dataset_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dataset_versions (
  dataset_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dataset_id, version)
);

CREATE TABLE IF NOT EXISTS dataset_items (
  item_id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  expected_output_json TEXT,
  metadata_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'archived'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompts (
  prompt_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  prompt_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  author TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (prompt_id, version)
);

CREATE TABLE IF NOT EXISTS prompt_labels (
  prompt_id TEXT NOT NULL,
  label TEXT NOT NULL,                     -- 'production' | 'staging' | 'latest' | custom
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (prompt_id, label)
);

CREATE TABLE IF NOT EXISTS scores (
  score_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,              -- 'trace' | 'session' | 'task' | 'dataset_run'
  subject_id TEXT NOT NULL,
  name TEXT NOT NULL,                      -- 'faithfulness' | 'user_rating' | ...
  value REAL NOT NULL,
  source TEXT NOT NULL,                    -- 'human' | 'api' | 'llm_judge'
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scores_subject ON scores(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_scores_name ON scores(name);
```

- [ ] **Step 2: Tests (one file each)**

Representative tests — full suites live in the individual test files listed above. Each store needs: create + get + list + archive/label + round-trip JSON fields.

Create `server/tests/score-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createScoreStore } = require('../observability/score-store');

describe('scoreStore', () => {
  let db, store;
  beforeEach(() => { db = setupTestDb(); store = createScoreStore({ db }); });

  it('record attaches to any subject with name + value + source', () => {
    const id = store.record({ subjectType: 'task', subjectId: 't1', name: 'faithfulness', value: 0.82, source: 'llm_judge' });
    expect(id).toMatch(/^scr_/);
    const got = store.listFor('task', 't1');
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe('faithfulness');
  });

  it('aggregate returns mean per score name for a subject type', () => {
    store.record({ subjectType: 'task', subjectId: 't1', name: 'rating', value: 0.8, source: 'human' });
    store.record({ subjectType: 'task', subjectId: 't2', name: 'rating', value: 0.9, source: 'human' });
    store.record({ subjectType: 'task', subjectId: 't3', name: 'rating', value: 1.0, source: 'human' });
    const agg = store.aggregateByName({ subjectType: 'task' });
    expect(agg.rating.mean).toBeCloseTo(0.9, 1);
    expect(agg.rating.count).toBe(3);
  });

  it('listBySubjectRange filters by date', () => {
    store.record({ subjectType: 'task', subjectId: 't1', name: 'x', value: 1, source: 'api' });
    const since = new Date(Date.now() + 10000).toISOString();
    expect(store.listSince(since)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Implement stores**

Create `server/observability/score-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createScoreStore({ db }) {
  function record({ subjectType, subjectId, name, value, source, metadata = null }) {
    const id = `scr_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO scores (score_id, subject_type, subject_id, name, value, source, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, subjectType, subjectId, name, value, source, metadata ? JSON.stringify(metadata) : null);
    return id;
  }

  function listFor(subjectType, subjectId) {
    return db.prepare(`SELECT * FROM scores WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC`)
      .all(subjectType, subjectId);
  }

  function aggregateByName({ subjectType, since = null }) {
    const params = [subjectType];
    let sql = `SELECT name, AVG(value) AS mean, COUNT(*) AS count FROM scores WHERE subject_type = ?`;
    if (since) { sql += ` AND created_at >= ?`; params.push(since); }
    sql += ` GROUP BY name`;
    const rows = db.prepare(sql).all(...params);
    const out = {};
    for (const r of rows) out[r.name] = { mean: r.mean, count: r.count };
    return out;
  }

  function listSince(sinceIso) {
    return db.prepare(`SELECT * FROM scores WHERE created_at >= ? ORDER BY created_at DESC`).all(sinceIso);
  }

  return { record, listFor, aggregateByName, listSince };
}

module.exports = { createScoreStore };
```

Create the other 3 stores with analogous shape. For prompts, expose `setLabel(promptId, label, version)` + `resolveByLabel(promptId, label)` returning the labeled version's content. For datasets, `addItem` + `snapshotVersion` (freeze current items JSON into `dataset_versions`).

Run tests → PASS. Commit: `feat(observability): 4 stores (sessions, datasets, prompts, scores)`.

---

## Task 2: LLM-as-judge + dataset experiments

- [ ] **Step 1: Judge module**

Create `server/observability/llm-judge.js`:

```js
'use strict';

const JUDGE_PROMPT = `You are a strict evaluator. Score the assistant response on the criterion below on a 0.0-1.0 scale. Return strict JSON: { "score": <number>, "rationale": "..." }.

Criterion: {{criterion}}

Input:
{{input}}

Expected output (may be missing):
{{expected}}

Actual output:
{{actual}}`;

function createLlmJudge({ callModel, scoreStore, logger = console }) {
  async function judge({ subjectType, subjectId, input, expected = null, actual, criterion, name }) {
    const prompt = JUDGE_PROMPT
      .replace('{{criterion}}', criterion)
      .replace('{{input}}', JSON.stringify(input))
      .replace('{{expected}}', expected ? JSON.stringify(expected) : '(none)')
      .replace('{{actual}}', JSON.stringify(actual));
    let result;
    try {
      result = await callModel({ prompt });
    } catch (err) {
      logger.warn?.('judge call failed', err);
      return { ok: false, error: err.message };
    }
    if (typeof result?.score !== 'number') return { ok: false, error: 'judge returned no numeric score' };
    const scoreId = scoreStore.record({
      subjectType, subjectId, name, value: result.score, source: 'llm_judge',
      metadata: { criterion, rationale: result.rationale },
    });
    return { ok: true, score_id: scoreId, score: result.score, rationale: result.rationale };
  }

  return { judge };
}

module.exports = { createLlmJudge };
```

- [ ] **Step 2: Dataset experiment runner**

A dataset experiment iterates over `dataset_items` at a chosen version, invokes a provided runner function, records results per-item as scores against a `dataset_run_id`. Returns aggregate mean scores. Add a `run_dataset_experiment` MCP tool.

Commit: `feat(observability): llm-judge + dataset experiment runner`.

---

## Task 3: MCP + dashboard

- [ ] **Step 1: MCP tools**

```js
create_session: { description: 'Create a session grouping related workflow runs.', inputSchema: {...} },
create_dataset: { description: 'Create a dataset with versioned input/expected items.', inputSchema: {...} },
upsert_prompt: { description: 'Create or update a named prompt; creates a new version.', inputSchema: {...} },
set_prompt_label: { description: 'Point a label (e.g., production) at a specific prompt version.', inputSchema: {...} },
record_score: { description: 'Record a score against any subject (trace, session, task, dataset_run).', inputSchema: {...} },
run_dataset_experiment: { description: 'Run a workflow/prompt against a dataset version, recording per-item scores.', inputSchema: {...} },
resolve_prompt: { description: 'Resolve a prompt by label. Returns content + version.', inputSchema: {...} },
aggregate_scores: { description: 'Aggregate scores by name + optional filters.', inputSchema: {...} },
```

- [ ] **Step 2: Dashboard views**

Three views: `Sessions.jsx` (list + detail with all runs), `Datasets.jsx` (items + version picker + trigger experiment), `Prompts.jsx` (versions + labels + diff between versions). Add a score-delta widget on `WorkflowRevisions.jsx` (from Plan 51) comparing mean scores between two revisions.

`await_restart`. Smoke: create a dataset with 5 items, create a prompt + label `production`, run a dataset experiment, observe mean scores per item in dashboard. Submit a workflow with `session_id`, confirm it attaches.

Commit: `feat(observability): MCP + dashboard for sessions/datasets/prompts/scores`.
