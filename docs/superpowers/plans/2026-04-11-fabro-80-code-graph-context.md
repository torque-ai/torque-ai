# Fabro #80: Code Graph Context + @-Mention UX (Cody)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade Plan 17 (repo map) and Plan 49 (symbol search) from per-repo to **cross-repo code graph** context, and expose context selection through a unified **`@-mention`** API: tasks can reference `@file:server/app.js`, `@symbol:Foo.bar`, `@repo:torque-public`, `@dir:server/workflows`, `@url:https://...`. Agents and operators resolve mentions to context chunks before the task runs. Inspired by Sourcegraph Cody.

**Architecture:** Two layers:
1. **Multi-repo symbol index** — extends Plan 49's symbol-search to maintain indexes for multiple registered repos under `server/repo-graph/` with a shared query API.
2. **@-mention resolver** — parses a string with @-references and returns the attached context chunks. Resolution pulls from the indexed graph (fast) or falls back to filesystem/fetch.

**Tech Stack:** Node.js, Plan 49 symbol indexer. Builds on plans 17 (repo map), 49 (symbol search), 50 (plugins).

---

## File Structure

**New files:**
- `server/migrations/0NN-repo-graph.sql`
- `server/repo-graph/repo-registry.js`
- `server/repo-graph/graph-indexer.js` — multi-repo index build
- `server/repo-graph/graph-query.js` — search across indexes
- `server/repo-graph/mention-resolver.js`
- `server/repo-graph/mention-parser.js`
- `server/tests/mention-parser.test.js`
- `server/tests/mention-resolver.test.js`
- `server/tests/repo-registry.test.js`

**Modified files:**
- `server/execution/task-startup.js` — resolve mentions before provider dispatch
- `server/handlers/mcp-tools.js` — `register_repo`, `list_repos`, `resolve_mentions`

---

## Task 1: Mention parser

- [x] **Step 1: Tests**

Create `server/tests/mention-parser.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { parseMentions } = require('../repo-graph/mention-parser');

describe('parseMentions', () => {
  it('extracts file mention', () => {
    const r = parseMentions('fix bug in @file:server/app.js please');
    expect(r.mentions).toEqual([{ kind: 'file', value: 'server/app.js', raw: '@file:server/app.js', original_kind: 'file' }]);
  });

  it('extracts symbol mention with dotted path', () => {
    const r = parseMentions('use @symbol:Logger.info for logging');
    expect(r.mentions[0]).toEqual(expect.objectContaining({ kind: 'symbol', value: 'Logger.info' }));
  });

  it('extracts repo mention', () => {
    const r = parseMentions('compare with @repo:torque-core');
    expect(r.mentions[0].kind).toBe('repo');
  });

  it('extracts multiple mentions', () => {
    const r = parseMentions('update @file:a.js and @file:b.js using @symbol:Helper');
    expect(r.mentions).toHaveLength(3);
  });

  it('extracts url mentions', () => {
    const r = parseMentions('see @url:https://example.com/docs');
    expect(r.mentions[0].kind).toBe('url');
    expect(r.mentions[0].value).toBe('https://example.com/docs');
  });

  it('strippedText has mentions replaced with placeholders', () => {
    const r = parseMentions('fix @file:a.js bug');
    expect(r.strippedText).toBe('fix [[MENTION:0]] bug');
  });

  it('ignores plain @ without kind:', () => {
    const r = parseMentions('email @alice about @file:x.js');
    expect(r.mentions).toHaveLength(1);
    expect(r.mentions[0].kind).toBe('file');
  });

  it('unknown mention kinds marked as kind=unknown', () => {
    const r = parseMentions('@custom:something');
    expect(r.mentions[0].kind).toBe('unknown');
  });
});
```

- [x] **Step 2: Implement**

Create `server/repo-graph/mention-parser.js`:

```js
'use strict';

const KNOWN_KINDS = new Set(['file', 'symbol', 'repo', 'dir', 'url']);
const MENTION_RE = /@(\w+):([^\s)]+)/g;

function parseMentions(text) {
  if (typeof text !== 'string') return { mentions: [], strippedText: text };
  const mentions = [];
  let strippedText = '';
  let lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const kind = KNOWN_KINDS.has(m[1]) ? m[1] : 'unknown';
    const idx = mentions.length;
    mentions.push({ kind, value: m[2], raw: m[0], original_kind: m[1] });
    strippedText += text.slice(lastIndex, m.index) + `[[MENTION:${idx}]]`;
    lastIndex = m.index + m[0].length;
  }
  strippedText += text.slice(lastIndex);
  return { mentions, strippedText };
}

module.exports = { parseMentions };
```

Run tests → PASS. Commit: `feat(mention): parser extracts @-mentions with kind classification`.

---

## Task 2: Repo registry + indexer

- [x] **Step 1: Migration**

`server/migrations/0NN-repo-graph.sql`:

```sql
CREATE TABLE IF NOT EXISTS registered_repos (
  repo_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  remote_url TEXT,
  default_branch TEXT DEFAULT 'main',
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS repo_symbols (
  repo_id TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  body_preview TEXT,
  PRIMARY KEY (repo_id, symbol_id),
  FOREIGN KEY (repo_id) REFERENCES registered_repos(repo_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_repo_symbols_name ON repo_symbols(name);
CREATE INDEX IF NOT EXISTS idx_repo_symbols_qualified ON repo_symbols(qualified_name);
```

- [x] **Step 2: Registry**

Create `server/repo-graph/repo-registry.js` exposing `{ register, getByName, get, list, unregister, markIndexed }`. `register` is idempotent on `name` — returns existing `repo_id` if present. See analogous factory patterns in Plan 50 catalog.

- [x] **Step 3: Indexer**

Create `server/repo-graph/graph-indexer.js`: uses Plan 49's symbol-search `indexFile` to walk repo files, inserts/updates `repo_symbols` rows. Skips `node_modules`, `.git`, `dist`, `build`. Exposes `indexRepo(repoId)` and `indexAll()`.

Tests cover: idempotent register, unregister cascades, list ordering, markIndexed updates timestamp.

Commit: `feat(repo-graph): registry + multi-repo indexer`.

---

## Task 3: Mention resolver

- [x] **Step 1: Tests**

Create `server/tests/mention-resolver.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRepoRegistry } = require('../repo-graph/repo-registry');
const { createMentionResolver } = require('../repo-graph/mention-resolver');

describe('mentionResolver', () => {
  let db, reg, resolver, repoDir;
  beforeEach(() => {
    db = setupTestDb();
    reg = createRepoRegistry({ db });
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
    fs.mkdirSync(path.join(repoDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'server', 'app.js'), 'const x = 1');
    reg.register({ name: 'test-repo', rootPath: repoDir });
    resolver = createMentionResolver({ db, repoRegistry: reg });
  });

  it('resolves @file:path to file content', async () => {
    const r = await resolver.resolve([{ kind: 'file', value: 'server/app.js', raw: '@file:server/app.js' }]);
    expect(r[0].content).toMatch(/const x/);
    expect(r[0].resolved).toBe(true);
  });

  it('resolves @file:repo:path with explicit repo', async () => {
    const r = await resolver.resolve([{ kind: 'file', value: 'test-repo:server/app.js', raw: '@file:test-repo:server/app.js' }]);
    expect(r[0].resolved).toBe(true);
  });

  it('resolves @symbol:qualifiedName from repo_symbols', async () => {
    const repoId = reg.getByName('test-repo').repo_id;
    db.prepare(`INSERT INTO repo_symbols (repo_id, symbol_id, kind, name, qualified_name, file_path, body_preview) VALUES (?,?,?,?,?,?,?)`)
      .run(repoId, 's1', 'function', 'hello', 'utils.hello', 'utils.js', 'return hi');
    const r = await resolver.resolve([{ kind: 'symbol', value: 'utils.hello', raw: '@symbol:utils.hello' }]);
    expect(r[0].resolved).toBe(true);
    expect(r[0].body_preview).toMatch(/hi/);
  });

  it('unresolved mention returns resolved=false + reason', async () => {
    const r = await resolver.resolve([{ kind: 'file', value: 'missing.js', raw: '@file:missing.js' }]);
    expect(r[0].resolved).toBe(false);
    expect(r[0].reason).toMatch(/not found/i);
  });

  it('url mentions use provided fetcher', async () => {
    const fetcher = vi.fn(async () => 'fetched body');
    const r2 = createMentionResolver({ db, repoRegistry: reg, urlFetcher: fetcher });
    const r = await r2.resolve([{ kind: 'url', value: 'https://example.com', raw: '@url:https://example.com' }]);
    expect(r[0].content).toBe('fetched body');
    expect(fetcher).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Implement**

Create `server/repo-graph/mention-resolver.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

function createMentionResolver({ db, repoRegistry, urlFetcher = null, logger = console }) {
  async function resolve(mentions) {
    const out = [];
    for (const m of mentions) {
      try {
        if (m.kind === 'file')          out.push(await resolveFile(m));
        else if (m.kind === 'symbol')   out.push(resolveSymbol(m));
        else if (m.kind === 'repo')     out.push(resolveRepo(m));
        else if (m.kind === 'dir')      out.push(resolveDir(m));
        else if (m.kind === 'url') {
          if (!urlFetcher) out.push({ ...m, resolved: false, reason: 'url fetcher not configured' });
          else {
            const content = await urlFetcher(m.value);
            out.push({ ...m, resolved: true, content });
          }
        }
        else out.push({ ...m, resolved: false, reason: `unknown mention kind: ${m.kind}` });
      } catch (err) {
        out.push({ ...m, resolved: false, reason: err.message });
      }
    }
    return out;
  }

  async function resolveFile(m) {
    const [repoName, filePath] = m.value.includes(':') ? m.value.split(':') : [defaultRepoName(), m.value];
    const repo = repoRegistry.getByName(repoName);
    if (!repo) return { ...m, resolved: false, reason: `unknown repo: ${repoName}` };
    const abs = path.join(repo.root_path, filePath);
    if (!fs.existsSync(abs)) return { ...m, resolved: false, reason: 'not found' };
    return { ...m, resolved: true, repo: repoName, file_path: filePath, content: fs.readFileSync(abs, 'utf8') };
  }

  function resolveSymbol(m) {
    const row = db.prepare(`SELECT * FROM repo_symbols WHERE qualified_name = ? OR name = ? LIMIT 1`).get(m.value, m.value);
    if (!row) return { ...m, resolved: false, reason: 'symbol not found' };
    return { ...m, resolved: true, repo_id: row.repo_id, file_path: row.file_path, body_preview: row.body_preview, start_line: row.start_line };
  }

  function resolveRepo(m) {
    const repo = repoRegistry.getByName(m.value);
    if (!repo) return { ...m, resolved: false, reason: 'repo not registered' };
    return { ...m, resolved: true, repo_id: repo.repo_id, root_path: repo.root_path };
  }

  function resolveDir(m) {
    const [repoName, dirPath] = m.value.includes(':') ? m.value.split(':') : [defaultRepoName(), m.value];
    const repo = repoRegistry.getByName(repoName);
    if (!repo) return { ...m, resolved: false, reason: `unknown repo: ${repoName}` };
    const abs = path.join(repo.root_path, dirPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { ...m, resolved: false, reason: 'dir not found' };
    const entries = fs.readdirSync(abs, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
    return { ...m, resolved: true, repo: repoName, entries };
  }

  function defaultRepoName() {
    const all = repoRegistry.list();
    return all.length === 1 ? all[0].name : null;
  }

  return { resolve };
}

module.exports = { createMentionResolver };
```

Run tests → PASS. Commit: `feat(mention): resolver for file/symbol/repo/dir/url across registered repos`.

---

## Task 4: Wire + MCP tools

- [x] **Step 1: Task startup injects resolved context**

In `server/execution/task-startup.js`:

```js
const { parseMentions } = require('../repo-graph/mention-parser');
const resolver = defaultContainer.get('mentionResolver');
const parsed = parseMentions(task.task_description);
if (parsed.mentions.length > 0) {
  const resolved = await resolver.resolve(parsed.mentions);
  const contextBlock = resolved.filter(r => r.resolved).map(r =>
    `## Context: ${r.raw}\n${r.content || r.body_preview || JSON.stringify(r)}`
  ).join('\n\n');
  task.task_description = `${contextBlock}\n\n---\n\n${task.task_description}`;
  const unresolved = resolved.filter(r => !r.resolved);
  if (unresolved.length > 0) {
    addTaskTag(taskId, `mentions:unresolved:${unresolved.length}`);
  }
}
```

- [x] **Step 2: MCP tools**

```js
register_repo: { description: 'Register a repo for cross-repo code graph queries + @-mention resolution.', inputSchema: {...} },
list_repos: { description: 'List registered repos.', inputSchema: { type: 'object' } },
reindex_repo: { description: 'Rebuild symbol index for a repo.', inputSchema: { type: 'object', required: ['repo_id'] } },
resolve_mentions: { description: 'Resolve @-mentions in a string without starting a task.', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
```

`await_restart`. Smoke: register 2 repos, reindex, submit task with `"summarize @file:server/app.js and @symbol:Logger"`. Confirm context prepended to prompt.

Commit: `feat(repo-graph): multi-repo @-mention resolver wired into task startup + MCP`.
