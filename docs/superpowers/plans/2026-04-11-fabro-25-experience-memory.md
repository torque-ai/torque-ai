# Fabro #25: Experience Memory ("What Worked Last Time") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Maintain a per-project pool of "what worked" — successful task→outcome pairs that can be retrieved as few-shot examples when similar new tasks are submitted. Inspired by TaskWeaver's experience pool. Cheap, automatic, always-on improvement loop without fine-tuning.

**Architecture:** A new `task_experiences` table records `{ task_description_embedding, task_description, output_summary, files_modified, provider, success_score, recorded_at }` for completed-and-verified tasks. Embeddings are computed via a cheap embedding provider (or a local hash-based fallback if no embedding service is available). When a new task starts, TORQUE looks up the top-K nearest experiences by embedding similarity (or substring match in fallback mode) and appends them as a "RELATED PAST EXPERIENCES" block to the task prompt.

---

## File Structure

**New files:**
- `server/experience/embed.js` — embedding (cheap provider or hash fallback)
- `server/experience/store.js` — record + retrieve
- `server/experience/inject.js` — assemble the few-shot block
- `server/handlers/experience-handlers.js`
- `server/tool-defs/experience-defs.js`
- `server/tests/experience-store.test.js`

**Modified files:**
- `server/db/schema-tables.js` — `task_experiences` table
- `server/database.js`
- `server/execution/task-finalizer.js` — record on success
- `server/execution/task-startup.js` — inject related experiences

---

## Task 1: Schema + store

- [ ] **Step 1: Schema**

In `server/db/schema-tables.js`:

```sql
CREATE TABLE IF NOT EXISTS task_experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  task_description TEXT NOT NULL,
  task_description_embedding TEXT,
  output_summary TEXT,
  files_modified TEXT,
  provider TEXT,
  success_score REAL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_experiences_project ON task_experiences(project, success_score DESC);
```

Add `'task_experiences'` to `ALL_TABLES`.

- [ ] **Step 2: Embedding (with hash fallback)**

Create `server/experience/embed.js`:

```js
'use strict';

const crypto = require('crypto');

/**
 * Cheap embedding. If a real embedding provider is wired, use it; otherwise
 * fall back to a simple n-gram hash vector that supports approximate similarity.
 * The hash fallback is NOT semantic — but it lets the rest of the feature work
 * in environments without an embedding provider, with degraded retrieval quality.
 */
async function embedText(text) {
  // Try real embedding provider (env var TORQUE_EMBEDDING_PROVIDER)
  // Skip in fallback mode for now — return hash vector.
  return hashVector(text);
}

function hashVector(text, dim = 64) {
  const vec = new Array(dim).fill(0);
  const tokens = (text || '').toLowerCase().match(/\w+/g) || [];
  for (const tok of tokens) {
    const h = crypto.createHash('sha1').update(tok).digest();
    const idx = h.readUInt16BE(0) % dim;
    vec[idx] += 1;
  }
  // L2-normalize
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map(x => x / norm);
}

function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

module.exports = { embedText, hashVector, cosineSim };
```

- [ ] **Step 3: Store + retrieve**

Create `server/experience/store.js`:

```js
'use strict';

const db = require('../database');
const { embedText, cosineSim } = require('./embed');

async function recordExperience({ project, task_description, output_summary, files_modified, provider, success_score = 1.0 }) {
  const embedding = await embedText(task_description);
  db.prepare(`
    INSERT INTO task_experiences (project, task_description, task_description_embedding, output_summary, files_modified, provider, success_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    project || null,
    task_description,
    JSON.stringify(embedding),
    (output_summary || '').slice(0, 4000),
    JSON.stringify(files_modified || []),
    provider || null,
    success_score,
  );
}

async function findRelatedExperiences({ project, task_description, top_k = 3, min_similarity = 0.4 }) {
  const queryEmb = await embedText(task_description);
  const rows = db.prepare(`
    SELECT * FROM task_experiences WHERE project = ? OR project IS NULL
    ORDER BY recorded_at DESC LIMIT 500
  `).all(project || null);
  const scored = rows.map(r => {
    let emb;
    try { emb = JSON.parse(r.task_description_embedding); } catch { return null; }
    if (!Array.isArray(emb) || emb.length !== queryEmb.length) return null;
    return { ...r, _sim: cosineSim(queryEmb, emb) };
  }).filter(Boolean).filter(x => x._sim >= min_similarity);
  scored.sort((a, b) => b._sim - a._sim);
  return scored.slice(0, top_k).map(x => ({
    task_description: x.task_description,
    output_summary: x.output_summary,
    files_modified: (() => { try { return JSON.parse(x.files_modified); } catch { return []; } })(),
    provider: x.provider,
    similarity: Number(x._sim.toFixed(3)),
  }));
}

module.exports = { recordExperience, findRelatedExperiences };
```

- [ ] **Step 4: Tests + commit**

Create `server/tests/experience-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { recordExperience, findRelatedExperiences } = require('../experience/store');

let db;
beforeAll(() => { db = setupTestDb('experience').db; });
afterAll(() => teardownTestDb());

describe('experience store', () => {
  it('records and retrieves similar experiences', async () => {
    await recordExperience({
      project: 'p',
      task_description: 'Add a database migration to create users table',
      output_summary: 'Created migration 0042_users.sql',
      files_modified: ['db/migrations/0042_users.sql'],
      provider: 'codex',
    });
    await recordExperience({
      project: 'p',
      task_description: 'Refactor logger to use pino',
      output_summary: 'Migrated all logger.info calls',
      files_modified: ['logger.js'],
      provider: 'codex',
    });

    const related = await findRelatedExperiences({
      project: 'p',
      task_description: 'Add a database migration for posts table',
      top_k: 1,
      min_similarity: 0.1,
    });
    expect(related).toHaveLength(1);
    expect(related[0].task_description).toMatch(/database migration/);
  });
});
```

Run → PASS. Commit: `feat(experience): record + retrieve nearest past experiences`.

---

## Task 2: Hook recording into finalizer + retrieval into startup

- [ ] **Step 1: Record on success**

In `server/execution/task-finalizer.js`, after the task is marked completed AND verify tag is `tests:pass`:

```js
try {
  if (ctx.status === 'completed') {
    let tags;
    try { tags = typeof ctx.task.tags === 'string' ? JSON.parse(ctx.task.tags) : (ctx.task.tags || []); } catch { tags = []; }
    const verifyOk = tags.includes('tests:pass') || !tags.some(t => t.startsWith('tests:'));
    if (verifyOk) {
      const { recordExperience } = require('../experience/store');
      // Fire-and-forget — recording must not block finalization
      Promise.resolve().then(() => recordExperience({
        project: ctx.task.project,
        task_description: ctx.task.task_description,
        output_summary: (ctx.output || '').slice(0, 2000),
        files_modified: ctx.filesModified,
        provider: ctx.task.provider,
        success_score: 1.0,
      })).catch(err => logger.info(`[experience] record failed: ${err.message}`));
    }
  }
} catch { /* non-critical */ }
```

- [ ] **Step 2: Inject related at task start**

In `server/execution/task-startup.js`, after task is loaded, before provider dispatch:

```js
try {
  // Skip if explicitly disabled or no project
  if (task.project) {
    const { findRelatedExperiences } = require('../experience/store');
    const related = await findRelatedExperiences({
      project: task.project,
      task_description: task.task_description,
      top_k: 3,
      min_similarity: 0.4,
    });
    if (related.length > 0) {
      const block = '\n\n## Related past experiences (similar tasks that succeeded)\n\n' +
        related.map((r, i) => `### Past task ${i + 1} (similarity ${r.similarity}, ran on ${r.provider})\n${r.task_description}\nResult: ${r.output_summary?.slice(0, 500)}\nFiles touched: ${r.files_modified.join(', ')}`).join('\n\n');
      task.task_description = task.task_description + block;
    }
  }
} catch (err) {
  logger.info(`[experience] retrieval failed: ${err.message}`);
}
```

Commit: `feat(experience): record on success, inject related at start`.

---

## Task 3: MCP tools + docs + smoke

- [ ] **Step 1: Tools**

Create `server/tool-defs/experience-defs.js`:

```js
'use strict';
const EXPERIENCE_TOOLS = [
  {
    name: 'find_related_experiences',
    description: 'Find past task experiences similar to a query description.',
    inputSchema: {
      type: 'object',
      required: ['task_description'],
      properties: {
        task_description: { type: 'string' },
        project: { type: 'string' },
        top_k: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        min_similarity: { type: 'number', default: 0.3 },
      },
    },
  },
  {
    name: 'record_experience',
    description: 'Manually record a successful task experience for future retrieval.',
    inputSchema: {
      type: 'object',
      required: ['task_description', 'output_summary'],
      properties: {
        task_description: { type: 'string' },
        output_summary: { type: 'string' },
        project: { type: 'string' },
        files_modified: { type: 'array', items: { type: 'string' } },
        provider: { type: 'string' },
      },
    },
  },
];
module.exports = { EXPERIENCE_TOOLS };
```

Create `server/handlers/experience-handlers.js`:

```js
'use strict';
const { recordExperience, findRelatedExperiences } = require('../experience/store');

async function handleFindRelated(args) {
  const results = await findRelatedExperiences(args);
  return {
    content: [{ type: 'text', text: `${results.length} related experience(s):\n\n` + results.map(r => `- (sim ${r.similarity}, ${r.provider}) ${r.task_description.slice(0, 100)}`).join('\n') }],
    structuredData: { results },
  };
}

async function handleRecord(args) {
  await recordExperience(args);
  return { content: [{ type: 'text', text: 'Recorded experience' }], structuredData: { ok: true } };
}

module.exports = { handleFindRelated, handleRecord };
```

Wire dispatch.

- [ ] **Step 2: Docs**

Create `docs/experience-memory.md`:

```markdown
# Experience Memory

TORQUE remembers what worked. Every task that completes successfully (with `tests:pass` or no verify tag) gets recorded into the `task_experiences` table along with an embedding of its description.

When a new task starts, TORQUE looks up the top-3 most similar past experiences (in the same project) and appends them to the task prompt as `## Related past experiences`.

## Why

- Cheap, automatic improvement loop — no fine-tuning required
- Lets agents reuse patterns: "last time you did X, you touched these files and produced this summary"
- Compounds value over time — older projects accumulate richer experience pools

## Embeddings

A real embedding provider can be wired via env var (TODO: `TORQUE_EMBEDDING_PROVIDER`). In its absence, TORQUE falls back to a hash-based vector — degraded retrieval quality but it works without external dependencies.

## MCP tools

```
find_related_experiences { task_description: "...", project: "torque", top_k: 5 }
record_experience { task_description: "...", output_summary: "..." }
```

## Privacy

Experiences are stored locally in the TORQUE DB. They are NOT sent to any external service unless an embedding provider is explicitly configured.
```

`await_restart`. Smoke: submit 2 similar tasks one after the other; the second should see `## Related past experiences` in its prompt referencing the first.

Commit: `docs(experience): experience memory guide`.
