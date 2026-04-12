# Fabro #87: Report Types + Citation Ledger (GPT Researcher)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade Plan 48 research runtime with **typed report variants** (research_report, resource_report, outline_report, detailed_report) and a **citation + source ledger** — every claim in the final report carries a numbered reference into `research_sources` with URL, snippet, retrieval timestamp, and provenance chain. Inspired by GPT Researcher.

**Architecture:** Plan 48's `research-runtime.js` gains a `reportType` parameter that selects the synthesis prompt + output shape. The `research_sources` table accumulates every fetched URL + extracted snippet + reuse count. The finalizer emits a `citations` array parallel to the report text — each citation points at a source_id and an offset range within the report. A reviewer agent (Plan 26 crew) can optionally cross-check the report against the ledger.

**Tech Stack:** Node.js, existing Plan 48 research runtime. Builds on plans 26 (crew), 48 (research), 74 (firecrawl).

---

## File Structure

**New files:**
- `server/migrations/0NN-research-sources.sql`
- `server/research/report-types.js` — prompt + schema per report type
- `server/research/citation-ledger.js`
- `server/tests/report-types.test.js`
- `server/tests/citation-ledger.test.js`

**Modified files:**
- `server/research/research-runtime.js` — accept reportType + write ledger
- `server/handlers/mcp-tools.js` — `run_research` extended, `get_sources`, `get_citations`
- `dashboard/src/views/ResearchDetail.jsx` — render citations as clickable footnotes

---

## Task 1: Report types

- [ ] **Step 1: Tests**

Create `server/tests/report-types.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { getReportType, listReportTypes, REPORT_TYPES } = require('../research/report-types');

describe('report types', () => {
  it('listReportTypes returns all known types', () => {
    const types = listReportTypes();
    expect(types.sort()).toEqual(['detailed_report', 'outline_report', 'research_report', 'resource_report']);
  });

  it('getReportType returns prompt + schema for research_report', () => {
    const r = getReportType('research_report');
    expect(r.prompt).toContain('{{question}}');
    expect(r.prompt).toContain('{{excerpts}}');
    expect(r.schema.properties.summary).toBeDefined();
    expect(r.schema.properties.findings).toBeDefined();
  });

  it('resource_report schema emphasizes source list', () => {
    const r = getReportType('resource_report');
    expect(r.schema.properties.resources).toBeDefined();
    expect(r.schema.required).toContain('resources');
  });

  it('outline_report schema emphasizes structure not prose', () => {
    const r = getReportType('outline_report');
    expect(r.schema.properties.outline).toBeDefined();
  });

  it('unknown type throws', () => {
    expect(() => getReportType('bogus')).toThrow();
  });
});
```

- [ ] **Step 2: Implement**

Create `server/research/report-types.js`:

```js
'use strict';

const REPORT_TYPES = {
  research_report: {
    prompt: `Write a cited research report answering the question. Each finding must reference specific excerpts by [index].

Question:
{{question}}

Excerpts:
{{excerpts}}

Output strict JSON:
{ "summary": "...", "findings": [ { "point": "...", "citations": [integer_indices] } ], "recommendation": "..." }`,
    schema: {
      type: 'object',
      required: ['summary', 'findings'],
      properties: {
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['point', 'citations'],
            properties: {
              point: { type: 'string' },
              citations: { type: 'array', items: { type: 'integer' } },
            },
          },
        },
        recommendation: { type: 'string' },
      },
    },
  },

  resource_report: {
    prompt: `Curate the most useful resources for the question. Return each with a brief summary of why it matters.

Question:
{{question}}

Candidates:
{{excerpts}}

Output strict JSON:
{ "resources": [ { "url": "...", "title": "...", "why_it_matters": "...", "excerpt_index": integer } ] }`,
    schema: {
      type: 'object',
      required: ['resources'],
      properties: {
        resources: {
          type: 'array',
          items: {
            type: 'object',
            required: ['url', 'why_it_matters'],
            properties: { url: { type: 'string' }, title: { type: 'string' }, why_it_matters: { type: 'string' }, excerpt_index: { type: 'integer' } },
          },
        },
      },
    },
  },

  outline_report: {
    prompt: `Produce a detailed outline for a report answering the question. No prose — just structured sections + bullet hints. Each section header references excerpts.

Question:
{{question}}

Excerpts:
{{excerpts}}

Output strict JSON:
{ "outline": [ { "heading": "...", "bullets": [string, ...], "citations": [integer, ...] } ] }`,
    schema: {
      type: 'object',
      required: ['outline'],
      properties: {
        outline: {
          type: 'array',
          items: {
            type: 'object',
            required: ['heading'],
            properties: { heading: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } }, citations: { type: 'array', items: { type: 'integer' } } },
          },
        },
      },
    },
  },

  detailed_report: {
    prompt: `Write a detailed cited report. Produce each section as prose with inline [index] citations. Each section must be backed by at least 2 distinct excerpts.

Question:
{{question}}

Excerpts:
{{excerpts}}

Output strict JSON:
{ "title": "...", "sections": [ { "heading": "...", "body": "...", "citations": [integer, ...] } ] }`,
    schema: {
      type: 'object',
      required: ['title', 'sections'],
      properties: {
        title: { type: 'string' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            required: ['heading', 'body'],
            properties: { heading: { type: 'string' }, body: { type: 'string' }, citations: { type: 'array', items: { type: 'integer' } } },
          },
        },
      },
    },
  },
};

function listReportTypes() { return Object.keys(REPORT_TYPES); }

function getReportType(name) {
  if (!REPORT_TYPES[name]) throw new Error(`unknown report type: ${name}`);
  return REPORT_TYPES[name];
}

module.exports = { REPORT_TYPES, listReportTypes, getReportType };
```

Run tests → PASS. Commit: `feat(report-types): research/resource/outline/detailed schemas + prompts`.

---

## Task 2: Citation ledger

- [ ] **Step 1: Migration**

`server/migrations/0NN-research-sources.sql`:

```sql
CREATE TABLE IF NOT EXISTS research_sources (
  source_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  excerpt TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  reuse_count INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT,
  UNIQUE (url, content_hash)
);

CREATE TABLE IF NOT EXISTS research_citations (
  research_id TEXT NOT NULL,
  citation_index INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  finding_id TEXT,
  PRIMARY KEY (research_id, citation_index),
  FOREIGN KEY (source_id) REFERENCES research_sources(source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_citations_research ON research_citations(research_id);
```

- [ ] **Step 2: Tests**

Create `server/tests/citation-ledger.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createCitationLedger } = require('../research/citation-ledger');

describe('citationLedger', () => {
  let db, ledger;
  beforeEach(() => {
    db = setupTestDb();
    ledger = createCitationLedger({ db });
  });

  it('upsertSource creates new sources + dedupes by URL+hash', () => {
    const a = ledger.upsertSource({ url: 'https://x.com', excerpt: 'hello' });
    const b = ledger.upsertSource({ url: 'https://x.com', excerpt: 'hello' });
    expect(a).toBe(b);
    const row = db.prepare('SELECT reuse_count FROM research_sources WHERE source_id = ?').get(a);
    expect(row.reuse_count).toBe(2);
  });

  it('different URL → different source', () => {
    const a = ledger.upsertSource({ url: 'https://x.com', excerpt: 'hi' });
    const b = ledger.upsertSource({ url: 'https://y.com', excerpt: 'hi' });
    expect(a).not.toBe(b);
  });

  it('recordCitations maps numbered indices to source_ids', () => {
    const s1 = ledger.upsertSource({ url: 'https://a', excerpt: '...' });
    const s2 = ledger.upsertSource({ url: 'https://b', excerpt: '...' });
    ledger.recordCitations({ researchId: 'r1', indexToSourceId: { 1: s1, 2: s2 } });
    const list = ledger.listForResearch('r1');
    expect(list).toHaveLength(2);
    expect(list.find(c => c.citation_index === 1).source_id).toBe(s1);
  });

  it('listForResearch joins in URL + excerpt', () => {
    const s = ledger.upsertSource({ url: 'https://a', title: 'Page A', excerpt: 'content' });
    ledger.recordCitations({ researchId: 'r1', indexToSourceId: { 1: s } });
    const list = ledger.listForResearch('r1');
    expect(list[0].url).toBe('https://a');
    expect(list[0].title).toBe('Page A');
  });

  it('mostReusedSources returns top N by reuse_count', () => {
    for (let i = 0; i < 3; i++) ledger.upsertSource({ url: 'https://popular', excerpt: 'x' });
    ledger.upsertSource({ url: 'https://rare', excerpt: 'y' });
    const top = ledger.mostReusedSources({ limit: 1 });
    expect(top[0].url).toBe('https://popular');
  });
});
```

- [ ] **Step 3: Implement**

Create `server/research/citation-ledger.js`:

```js
'use strict';
const crypto = require('crypto');
const { randomUUID } = require('crypto');

function hashExcerpt(s) {
  return crypto.createHash('sha256').update(s || '').digest('hex').slice(0, 16);
}

function createCitationLedger({ db }) {
  function upsertSource({ url, title = null, excerpt = null }) {
    const contentHash = hashExcerpt(excerpt);
    const existing = db.prepare('SELECT source_id FROM research_sources WHERE url = ? AND content_hash = ?').get(url, contentHash);
    if (existing) {
      db.prepare('UPDATE research_sources SET reuse_count = reuse_count + 1 WHERE source_id = ?').run(existing.source_id);
      return existing.source_id;
    }
    const id = `src_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO research_sources (source_id, url, title, excerpt, content_hash) VALUES (?,?,?,?,?)`)
      .run(id, url, title, excerpt, contentHash);
    return id;
  }

  function recordCitations({ researchId, indexToSourceId }) {
    const stmt = db.prepare(`INSERT OR REPLACE INTO research_citations (research_id, citation_index, source_id) VALUES (?, ?, ?)`);
    for (const [idx, sourceId] of Object.entries(indexToSourceId)) {
      stmt.run(researchId, parseInt(idx, 10), sourceId);
    }
  }

  function listForResearch(researchId) {
    return db.prepare(`
      SELECT c.*, s.url, s.title, s.excerpt, s.first_seen_at
      FROM research_citations c
      JOIN research_sources s ON c.source_id = s.source_id
      WHERE c.research_id = ?
      ORDER BY c.citation_index
    `).all(researchId);
  }

  function mostReusedSources({ limit = 20 } = {}) {
    return db.prepare(`SELECT * FROM research_sources ORDER BY reuse_count DESC LIMIT ?`).all(limit);
  }

  return { upsertSource, recordCitations, listForResearch, mostReusedSources };
}

module.exports = { createCitationLedger };
```

Run tests → PASS. Commit: `feat(research): citation ledger with dedupe + reuse tracking`.

---

## Task 3: Wire into research runtime + MCP

- [ ] **Step 1: Research runtime upgrade**

In `server/research/research-runtime.js` add `reportType` to signature. Use `getReportType(reportType)` to pick prompt + schema for the synthesis call. After synthesis, walk the output's `citations` arrays and:

```js
const ledger = container.get('citationLedger');
const indexToSourceId = {};
for (let i = 0; i < excerpts.length; i++) {
  const excerpt = excerpts[i];
  const sourceId = ledger.upsertSource({ url: excerpt.url, title: excerpt.title, excerpt: excerpt.excerpt });
  indexToSourceId[i + 1] = sourceId;
}
ledger.recordCitations({ researchId, indexToSourceId });
```

- [ ] **Step 2: MCP tools**

Extend `run_research` to accept `report_type`. Add:

```js
get_research_sources: { description: 'List sources accumulated across research runs (sorted by reuse).', inputSchema: { type: 'object', properties: { limit: {type:'integer'} } } },
get_research_citations: { description: 'Return the citation ledger for a research run.', inputSchema: { type: 'object', required: ['research_id'], properties: { research_id: {type:'string'} } } },
```

- [ ] **Step 3: Dashboard citations view**

In `dashboard/src/views/ResearchDetail.jsx` render the report body with clickable `[1]`, `[2]` numbered superscripts that expand into a side panel showing URL + excerpt + retrieval timestamp.

`await_restart`. Smoke: `run_research({question:'Best JSON validator', report_type:'detailed_report'})`. Confirm output has `title`, `sections[].body` with `[1][2]` inline, and `get_research_citations({research_id})` returns source-linked entries.

Commit: `feat(research): report types + citation ledger wired into runtime + MCP + dashboard`.
