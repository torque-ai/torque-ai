# Fabro #74: Firecrawl Research Integration (Firecrawl)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Swap Plan 48's basic page fetcher for **Firecrawl** — LLM-ready markdown, schema-driven extraction, `/map` + `/crawl` with depth control, PDF + screenshot support, batch async. Plan 48 research becomes dramatically more reliable without TORQUE owning a scraping stack. Self-hosted Firecrawl or Firecrawl Cloud, selected per project via config. Inspired by Firecrawl.

**Architecture:** A new `firecrawl-adapter.js` implements the `fetchPage` + `search` + `extract` + `map` + `crawl` primitives against the Firecrawl API. Plan 48's research runtime is refactored to use adapter interfaces (`PageFetcher`, `Searcher`, `Extractor`, `Crawler`) instead of hardcoded fetch + readability. A fallback chain lets TORQUE fall through to Plan 48's original page fetcher if Firecrawl is unreachable.

**Tech Stack:** Node.js, existing Firecrawl JS SDK (`@mendable/firecrawl-js`) or raw fetch. Builds on plans 48 (research stage), 52 (connections for API key).

---

## File Structure

**New files:**
- `server/research/adapters/firecrawl-adapter.js`
- `server/research/adapters/interfaces.js` — type stubs for adapter contracts
- `server/research/extractor.js` — schema-driven extraction helper
- `server/tests/firecrawl-adapter.test.js`
- `server/tests/extractor.test.js`

**Modified files:**
- `server/research/research-runtime.js` — accept adapter injection
- `server/research/search-adapters.js` — add Firecrawl search adapter
- `server/research/page-fetcher.js` — become default fallback
- `server/handlers/mcp-tools.js` — `extract_from_url`, `crawl_site`, `map_site` tools

---

## Task 1: Firecrawl adapter

- [ ] **Step 1: Tests**

Create `server/tests/firecrawl-adapter.test.js`:

```js
'use strict';
const { describe, it, expect, vi, beforeEach } = require('vitest');
const { createFirecrawlAdapter } = require('../research/adapters/firecrawl-adapter');

describe('firecrawlAdapter', () => {
  let fetchMock, adapter;
  beforeEach(() => {
    fetchMock = vi.fn();
    adapter = createFirecrawlAdapter({
      apiKey: 'fc-test-xxx',
      baseUrl: 'https://api.firecrawl.dev',
      fetchImpl: fetchMock,
    });
  });

  it('scrape returns {url, title, markdown} from Firecrawl JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: true, data: { markdown: '# Hello\ntext', metadata: { title: 'Hello' } } }),
    });
    const r = await adapter.scrape({ url: 'https://x' });
    expect(r.title).toBe('Hello');
    expect(r.markdown).toMatch(/Hello/);
    expect(fetchMock).toHaveBeenCalledWith('https://api.firecrawl.dev/v1/scrape', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer fc-test-xxx' }),
    }));
  });

  it('extract returns parsed object matching provided schema', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: true, data: { name: 'Acme', price: 99 } }),
    });
    const r = await adapter.extract({
      urls: ['https://x'],
      schema: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' } } },
    });
    expect(r.data.name).toBe('Acme');
    expect(r.data.price).toBe(99);
  });

  it('map returns list of discovered URLs', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: true, links: ['https://x/a', 'https://x/b', 'https://x/c'] }),
    });
    const r = await adapter.map({ url: 'https://x', search: null });
    expect(r.links).toHaveLength(3);
  });

  it('crawl starts async job + returns job_id', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: true, id: 'crawl-123', url: 'https://api.firecrawl.dev/v1/crawl/crawl-123' }),
    });
    const r = await adapter.crawl({ url: 'https://x', limit: 50 });
    expect(r.id).toBe('crawl-123');
  });

  it('crawlStatus polls + returns completed data', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ status: 'completed', data: [{ markdown: 'page 1' }, { markdown: 'page 2' }] }),
    });
    const r = await adapter.crawlStatus({ id: 'crawl-123' });
    expect(r.status).toBe('completed');
    expect(r.data).toHaveLength(2);
  });

  it('returns {error} when Firecrawl returns non-200', async () => {
    fetchMock.mockResolvedValueOnce({ status: 429, json: async () => ({ error: 'rate limited' }) });
    const r = await adapter.scrape({ url: 'https://x' });
    expect(r.error).toMatch(/429|rate/i);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/research/adapters/firecrawl-adapter.js`:

```js
'use strict';

function createFirecrawlAdapter({ apiKey, baseUrl = 'https://api.firecrawl.dev', fetchImpl = fetch }) {
  async function call(path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status >= 400) {
      const err = await res.json().catch(() => ({}));
      return { error: err.error || `HTTP ${res.status}` };
    }
    return await res.json();
  }

  async function scrape({ url, formats = ['markdown'], onlyMainContent = true }) {
    const r = await call('/v1/scrape', { url, formats, onlyMainContent });
    if (r.error) return { url, error: r.error };
    const data = r.data || {};
    return {
      url,
      title: data.metadata?.title || null,
      markdown: data.markdown || null,
      html: data.html || null,
      links: data.links || [],
    };
  }

  async function extract({ urls, schema, prompt = null }) {
    return await call('/v1/extract', { urls, schema, prompt });
  }

  async function map({ url, search = null }) {
    const body = { url };
    if (search) body.search = search;
    return await call('/v1/map', body);
  }

  async function crawl({ url, limit = 20, includePaths = null, excludePaths = null, maxDepth = null }) {
    const body = { url, limit };
    if (includePaths)  body.includePaths = includePaths;
    if (excludePaths)  body.excludePaths = excludePaths;
    if (maxDepth != null) body.maxDiscoveryDepth = maxDepth;
    return await call('/v1/crawl', body);
  }

  async function crawlStatus({ id }) {
    const res = await fetchImpl(`${baseUrl}/v1/crawl/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status >= 400) return { error: `HTTP ${res.status}` };
    return await res.json();
  }

  async function batch({ urls, formats = ['markdown'] }) {
    return await call('/v1/batch/scrape', { urls, formats });
  }

  return { scrape, extract, map, crawl, crawlStatus, batch };
}

module.exports = { createFirecrawlAdapter };
```

Run tests → PASS. Commit: `feat(firecrawl): adapter with scrape/extract/map/crawl/batch`.

---

## Task 2: Schema-driven extractor

- [ ] **Step 1: Tests**

Create `server/tests/extractor.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { extractFromUrls } = require('../research/extractor');

describe('extractFromUrls', () => {
  it('calls adapter.extract + validates result against schema', async () => {
    const adapter = { extract: vi.fn(async () => ({ success: true, data: { name: 'Acme', price: 99 } })) };
    const schema = { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: 'number' } } };
    const r = await extractFromUrls({ adapter, urls: ['https://x'], schema });
    expect(r.ok).toBe(true);
    expect(r.value.name).toBe('Acme');
  });

  it('rejects result that fails schema validation', async () => {
    const adapter = { extract: vi.fn(async () => ({ success: true, data: { name: 'Acme' /* price missing */ } })) };
    const schema = { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: 'number' } } };
    const r = await extractFromUrls({ adapter, urls: ['https://x'], schema });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/price/);
  });

  it('passes prompt to adapter when provided', async () => {
    const adapter = { extract: vi.fn(async () => ({ success: true, data: { x: 1 } })) };
    await extractFromUrls({ adapter, urls: ['https://x'], schema: { type: 'object' }, prompt: 'Extract prices only' });
    expect(adapter.extract).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Extract prices only' }));
  });
});
```

- [ ] **Step 2: Implement**

Create `server/research/extractor.js`:

```js
'use strict';
const Ajv = require('ajv');
const ajv = new Ajv({ strict: false, allErrors: true });

async function extractFromUrls({ adapter, urls, schema, prompt = null }) {
  const result = await adapter.extract({ urls, schema, prompt });
  if (result.error) return { ok: false, errors: [result.error] };
  const data = result.data ?? result;

  if (schema) {
    const validate = ajv.compile(schema);
    if (!validate(data)) {
      return { ok: false, errors: validate.errors.map(e => `${e.instancePath || '(root)'}: ${e.message}`) };
    }
  }
  return { ok: true, value: data };
}

module.exports = { extractFromUrls };
```

Run tests → PASS. Commit: `feat(firecrawl): schema-driven extractor with Ajv validation`.

---

## Task 3: Plan 48 refactor + MCP tools

- [ ] **Step 1: Refactor research-runtime**

Modify `server/research/research-runtime.js` to accept `fetchPage` as an adapter function (already parameterized). Update container factory to use Firecrawl if configured, else page-fetcher:

```js
container.factory('researchRuntime', (c) => {
  const { createResearchRuntime } = require('./research/research-runtime');
  const { fetchPageText } = require('./research/page-fetcher');
  const { createFirecrawlAdapter } = require('./research/adapters/firecrawl-adapter');
  const { getAdapter } = require('./research/search-adapters');

  const fcKey = process.env.FIRECRAWL_API_KEY;
  const fcAdapter = fcKey ? createFirecrawlAdapter({ apiKey: fcKey }) : null;

  const fetchPage = fcAdapter
    ? async ({ url, allowlist }) => {
        const r = await fcAdapter.scrape({ url });
        if (r.error) return { url, error: r.error };
        return { url, title: r.title, text: r.markdown || '' };
      }
    : fetchPageText;

  return createResearchRuntime({
    db: c.get('db'),
    callModel: async ({ prompt }) => {
      const provider = c.get('providerRegistry').getProviderInstance('codex');
      const out = await provider.runPrompt({ prompt, format: 'json', max_tokens: 2000 });
      return typeof out === 'string' ? JSON.parse(out) : out;
    },
    search: async ({ query, limit, adapter }) => {
      if (fcAdapter && adapter === 'firecrawl') {
        const r = await fcAdapter.map({ url: 'https://www.google.com', search: query });
        return (r.links || []).slice(0, limit).map(url => ({ url, title: null }));
      }
      return getAdapter(adapter)({ query, limit });
    },
    fetchPage,
  });
});
```

- [ ] **Step 2: MCP tools**

```js
extract_from_url: {
  description: 'Extract a structured object from one or more URLs using Firecrawl. Returns data matching the provided JSON Schema or null if unavailable.',
  inputSchema: {
    type: 'object',
    required: ['urls', 'schema'],
    properties: { urls: { type: 'array', items: { type: 'string' } }, schema: { type: 'object' }, prompt: { type: 'string' } },
  },
},
crawl_site: {
  description: 'Crawl a site starting from a URL. Returns a job_id; poll crawl_status for results.',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string' },
      limit: { type: 'integer', default: 20 },
      include_paths: { type: 'array', items: { type: 'string' } },
      exclude_paths: { type: 'array', items: { type: 'string' } },
      max_depth: { type: 'integer' },
    },
  },
},
crawl_status: {
  description: 'Poll the status of a crawl job.',
  inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
},
map_site: {
  description: 'Fast URL discovery for a site. Returns a list of discovered URLs.',
  inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, search: { type: 'string' } } },
},
```

Handlers dispatch to `defaultContainer.get('firecrawlAdapter')` (container factory registers it only when `FIRECRAWL_API_KEY` is set):

```js
container.factory('firecrawlAdapter', () => {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  return require('./research/adapters/firecrawl-adapter').createFirecrawlAdapter({ apiKey: key });
});
```

Handlers early-return with a clear error when the adapter is `null`:

```js
case 'extract_from_url': {
  const fc = defaultContainer.get('firecrawlAdapter');
  if (!fc) return { ok: false, error: 'Firecrawl not configured — set FIRECRAWL_API_KEY' };
  return await require('./research/extractor').extractFromUrls({ adapter: fc, ...args });
}
```

`await_restart`. Smoke (requires `FIRECRAWL_API_KEY` env): `run_research({question: 'Best JSON validator'})` should now produce cleaner markdown excerpts. `extract_from_url({urls:['...'], schema:{...}})` returns structured data.

Commit: `feat(firecrawl): wire adapter into research runtime + MCP tools`.
