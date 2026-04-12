# Fabro #48: Browser-Driven Research Stage (Devika)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `kind: research` workflow step that turns an open-ended question into structured evidence — search engine queries, visited URLs, page text extraction, and a ranked findings summary — which downstream tasks consume as structured input. Inspired by Devika's Browser Agent.

**Architecture:** A new `research-runtime.js` takes `{ question, max_pages, allowlist }` and runs: (1) ask the model for 3-5 search queries, (2) call a search adapter (Brave/DuckDuckGo/Bing API), (3) fetch top pages via headless browser, (4) extract readable text via readability, (5) ask the model to rank findings and produce a structured summary. Output is persisted to `research_runs` with per-URL records. Exposed as both a system task (Plan 43) and a standalone MCP tool.

**Tech Stack:** Node.js, Playwright (headless), Mozilla Readability, existing provider dispatch, pluggable search adapter. Builds on plans 26 (crew), 41 (spec-capture), 43 (system tasks).

---

## File Structure

**New files:**
- `server/migrations/0NN-research-runs.sql`
- `server/research/research-runtime.js`
- `server/research/search-adapters.js` — brave, duckduckgo, bing
- `server/research/page-fetcher.js` — Playwright + readability
- `server/research/synthesis-prompt.js`
- `server/tests/research-runtime.test.js`
- `server/tests/page-fetcher.test.js`

**Modified files:**
- `server/tool-defs/` — `run_research` tool + `kind: research` system task
- `server/system-tasks/system-task-runner.js` — dispatch to research runtime
- `server/handlers/mcp-tools.js`

---

## Task 1: Migration + page fetcher

- [ ] **Step 1: Migration**

`server/migrations/0NN-research-runs.sql`:

```sql
CREATE TABLE IF NOT EXISTS research_runs (
  research_id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  task_id TEXT,
  workflow_id TEXT,
  queries_json TEXT,
  summary TEXT,
  findings_json TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS research_pages (
  page_id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  text_content TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  error TEXT,
  FOREIGN KEY (research_id) REFERENCES research_runs(research_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_pages_run ON research_pages(research_id);
```

- [ ] **Step 2: Page fetcher — key behaviors**

Use `@mozilla/readability` + `jsdom` to extract article text from fetched HTML. Implement `fetchPageText({ url, fetchImpl, timeoutMs, allowlist })`:
- Optional allowlist (host-matching with subdomain support)
- AbortController-based timeout
- Readability pass over fetched HTML to strip navs/ads
- Return `{ url, title, text, excerpt }` on success or `{ url, error }` on HTTP >= 400 / parse failure

Write tests covering: happy-path extraction, allowlist rejection, timeout behavior, HTTP error path. Target ~15KB text cap.

Commit: `feat(research): page fetcher with readability + allowlist + timeout`.

---

## Task 2: Search adapters

Create `server/research/search-adapters.js` exporting `getAdapter(name)` and `ADAPTERS` map. Three adapters:

- **duckduckgo** — no API key; parse `duckduckgo.com/html/` results with a regex
- **brave** — requires `BRAVE_API_KEY`; calls `api.search.brave.com/res/v1/web/search`
- **bing** — requires `BING_SEARCH_API_KEY`; calls `api.bing.microsoft.com/v7.0/search`

Each adapter takes `{ query, limit, apiKey }` and returns `[{ url, title, snippet? }]`.

Commit: `feat(research): search adapters (duckduckgo, brave, bing)`.

---

## Task 3: Research runtime

- [ ] **Step 1: Tests**

Create `server/tests/research-runtime.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createResearchRuntime } = require('../research/research-runtime');

describe('researchRuntime.run', () => {
  let db, runtime, mocks;
  beforeEach(() => {
    db = setupTestDb();
    mocks = {
      callModel: vi.fn()
        .mockResolvedValueOnce({ queries: ['best json schema lib', 'json schema comparison'] })
        .mockResolvedValueOnce({
          summary: 'Ajv is the strongest option',
          findings: [
            { point: 'Ajv is fastest', citations: ['https://ajv.js.org'] },
            { point: 'Joi is ergonomic', citations: ['https://joi.dev'] },
          ],
        }),
      search: vi.fn(async () => [
        { url: 'https://ajv.js.org', title: 'Ajv' },
        { url: 'https://joi.dev', title: 'Joi' },
      ]),
      fetchPage: vi.fn(async ({ url }) => ({ url, title: 'Page', text: 'some extracted text from ' + url })),
    };
    runtime = createResearchRuntime({ db, ...mocks });
  });

  it('runs full pipeline and persists a research_run with findings', async () => {
    const r = await runtime.run({ question: 'Which JSON schema library?' });
    expect(r.research_id).toMatch(/^res_/);
    expect(r.summary).toMatch(/Ajv/);
    expect(r.findings).toHaveLength(2);
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(mocks.fetchPage).toHaveBeenCalled();
    const row = db.prepare('SELECT * FROM research_runs WHERE research_id = ?').get(r.research_id);
    expect(row.status).toBe('completed');
    expect(JSON.parse(row.findings_json).length).toBe(2);
  });

  it('honors max_pages', async () => {
    await runtime.run({ question: 'q', maxPages: 1 });
    expect(mocks.fetchPage).toHaveBeenCalledTimes(1);
  });

  it('marks research as failed if synthesis throws', async () => {
    const r = createResearchRuntime({
      db,
      callModel: vi.fn().mockResolvedValueOnce({ queries: ['x'] }).mockRejectedValueOnce(new Error('synth fail')),
      search: mocks.search,
      fetchPage: mocks.fetchPage,
    });
    await expect(r.run({ question: 'q' })).rejects.toThrow(/synth fail/);
    const row = db.prepare('SELECT status FROM research_runs LIMIT 1').get();
    expect(row.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/research/research-runtime.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

const QUERIES_PROMPT = `You are a research planner. Given a question, produce 3-5 diverse web search queries that together will surface high-quality answers. Output strict JSON: { "queries": [string, ...] }.

Question:
{{question}}`;

const SYNTHESIS_PROMPT = `You are a research synthesizer. Given a question and excerpts from the web, produce:
- A one-paragraph summary answering the question.
- 3-7 findings, each with a short "point" and 1-3 citation URLs.

Output strict JSON: { "summary": "...", "findings": [ { "point": "...", "citations": [ "https://..." ] } ] }.

Question:
{{question}}

Excerpts:
{{excerpts}}`;

function createResearchRuntime({ db, callModel, search, fetchPage, logger = console }) {
  async function run({ question, taskId = null, workflowId = null, maxPages = 6, searchAdapter = 'duckduckgo', allowlist = null }) {
    const researchId = `res_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO research_runs (research_id, question, task_id, workflow_id) VALUES (?,?,?,?)`)
      .run(researchId, question, taskId, workflowId);

    try {
      const planResult = await callModel({ prompt: QUERIES_PROMPT.replace('{{question}}', question) });
      const queries = (planResult.queries || []).slice(0, 5);
      db.prepare(`UPDATE research_runs SET queries_json = ? WHERE research_id = ?`).run(JSON.stringify(queries), researchId);

      const urls = new Set();
      for (const q of queries) {
        const hits = await search({ query: q, limit: 5, adapter: searchAdapter });
        for (const h of hits) if (urls.size < maxPages * 2) urls.add(h.url);
      }

      const excerpts = [];
      const urlList = Array.from(urls).slice(0, maxPages);
      for (const url of urlList) {
        try {
          const page = await fetchPage({ url, allowlist });
          const pageId = `rp_${randomUUID().slice(0, 12)}`;
          db.prepare(`INSERT INTO research_pages (page_id, research_id, url, title, text_content, error) VALUES (?,?,?,?,?,?)`)
            .run(pageId, researchId, url, page.title || null, page.text || null, page.error || null);
          if (page.text) excerpts.push({ url, title: page.title, excerpt: page.text.slice(0, 2000) });
        } catch (err) {
          logger.warn('page fetch failed', { url, err: err.message });
        }
      }

      const synth = await callModel({
        prompt: SYNTHESIS_PROMPT
          .replace('{{question}}', question)
          .replace('{{excerpts}}', excerpts.map((e, i) => `[${i + 1}] ${e.title || e.url}\n${e.excerpt}`).join('\n\n---\n\n')),
      });

      db.prepare(`UPDATE research_runs SET summary = ?, findings_json = ?, status = 'completed', completed_at = datetime('now') WHERE research_id = ?`)
        .run(synth.summary || null, JSON.stringify(synth.findings || []), researchId);

      return {
        research_id: researchId,
        question,
        queries,
        pages_visited: urlList.length,
        summary: synth.summary,
        findings: synth.findings || [],
      };
    } catch (err) {
      db.prepare(`UPDATE research_runs SET status = 'failed', completed_at = datetime('now') WHERE research_id = ?`).run(researchId);
      throw err;
    }
  }

  return { run };
}

module.exports = { createResearchRuntime };
```

Run tests → PASS. Commit: `feat(research): runtime coordinates queries → search → fetch → synthesize`.

---

## Task 4: System task kind + MCP tool

- [ ] **Step 1: Register `kind: research`**

In `server/execution/task-startup.js` add `research` to the SYSTEM_KINDS set. In `server/system-tasks/system-task-runner.js` add a case:

```js
case 'research': {
  const cfg = taskMeta.research || {};
  const runtime = container.get('researchRuntime');
  const result = await runtime.run({
    question: cfg.question || task.task_description,
    taskId: task.task_id,
    workflowId: task.workflow_id,
    maxPages: cfg.max_pages,
    searchAdapter: cfg.search_adapter,
    allowlist: cfg.allowlist,
  });
  db.prepare(`UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now') WHERE task_id = ?`)
    .run(JSON.stringify(result, null, 2), task.task_id);
  return { systemTask: true, kind: 'research' };
}
```

- [ ] **Step 2: MCP tool**

In `server/tool-defs/`:

```js
run_research: {
  description: 'Execute a research run: decompose question into queries, search, fetch pages, synthesize findings. Returns summary + structured findings.',
  inputSchema: {
    type: 'object',
    required: ['question'],
    properties: {
      question: { type: 'string' },
      max_pages: { type: 'integer', default: 6 },
      search_adapter: { type: 'string', enum: ['duckduckgo', 'brave', 'bing'], default: 'duckduckgo' },
      allowlist: { type: 'array', items: { type: 'string' } },
    },
  },
},
```

- [ ] **Step 3: Container + handler**

```js
container.factory('researchRuntime', (c) => {
  const { createResearchRuntime } = require('./research/research-runtime');
  const { fetchPageText } = require('./research/page-fetcher');
  const { getAdapter } = require('./research/search-adapters');
  const provider = c.get('providerRegistry').getProviderInstance('codex');
  return createResearchRuntime({
    db: c.get('db'),
    callModel: async ({ prompt }) => {
      const out = await provider.runPrompt({ prompt, format: 'json', max_tokens: 2000 });
      return typeof out === 'string' ? JSON.parse(out) : out;
    },
    search: async ({ query, limit, adapter }) => getAdapter(adapter)({ query, limit }),
    fetchPage: fetchPageText,
  });
});
```

In `server/handlers/mcp-tools.js`:

```js
case 'run_research':
  return await defaultContainer.get('researchRuntime').run({
    question: args.question, maxPages: args.max_pages,
    searchAdapter: args.search_adapter, allowlist: args.allowlist,
  });
```

`await_restart`. Smoke: `run_research({question: 'Best JSON schema validator for Node.js'})`. Confirm findings include citations and `research_runs` table has a completed row.

Commit: `feat(research): kind=research system task + MCP tool`.
