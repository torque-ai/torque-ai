# Fabro #17: Repository Map (Tree-Sitter Project Map) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-generate a token-budget-aware repository map (file tree + key symbols ranked by dependency centrality) and inject it into task prompts. Better than naive context stuffing or vector search because it gives the model whole-repo awareness while staying within context budget. Inspired by Aider and Plandex.

**Architecture:** A new `server/repo-map/` module uses tree-sitter to parse source files, extracts top-level symbols (functions, classes), builds a fan-in/fan-out reference graph, ranks files by graph centrality (PageRank-lite), then emits a Markdown map fitting a configured token budget. The map is generated lazily per-task and cached in DB (`repo_maps` table with content-hash key). Tasks opt in via `inject_repo_map: true`.

**Tech Stack:** Node.js, web-tree-sitter, better-sqlite3.

---

## File Structure

**New files:**
- `server/repo-map/extract-symbols.js`
- `server/repo-map/build-graph.js`
- `server/repo-map/render-map.js`
- `server/repo-map/cache.js`
- `server/handlers/repo-map-handlers.js`
- `server/tool-defs/repo-map-defs.js`
- `server/tests/extract-symbols.test.js`
- `server/tests/render-map.test.js`
- `server/tests/repo-map-integration.test.js`

**Modified files:**
- `server/db/schema-tables.js`
- `server/handlers/workflow/index.js`
- `server/tool-defs/workflow-defs.js`
- `server/execution/task-startup.js` (or wherever prompts are finalized)
- `server/package.json`

---

## Task 1: Symbol extraction

- [x] **Step 1: Install deps**

In `server/`, install: `web-tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`. Save to dependencies.

- [x] **Step 2: Tests**

Create `server/tests/extract-symbols.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { extractSymbols } = require('../repo-map/extract-symbols');

describe('extractSymbols', () => {
  it('extracts top-level functions and classes from JS', async () => {
    const code = `function foo(a, b) { return a + b; }\nclass Bar { method() {} }\nconst baz = () => 42;`;
    const result = await extractSymbols('test.js', code);
    expect(result.symbols.map(s => s.name).sort()).toEqual(['Bar', 'baz', 'foo']);
    expect(result.symbols.find(s => s.name === 'foo').kind).toBe('function');
    expect(result.symbols.find(s => s.name === 'Bar').kind).toBe('class');
  });

  it('extracts python defs and classes', async () => {
    const code = `def foo(x): return x + 1\nclass Bar:\n    def method(self): pass`;
    const result = await extractSymbols('test.py', code);
    expect(result.symbols.map(s => s.name).sort()).toEqual(['Bar', 'foo']);
  });

  it('extracts references to imported modules', async () => {
    const code = `const path = require('path');\nconst { foo } = require('./helpers');`;
    const result = await extractSymbols('test.js', code);
    expect(result.references).toContain('./helpers');
  });

  it('returns empty result for unsupported file types', async () => {
    const result = await extractSymbols('test.bin', 'binary garbage');
    expect(result.symbols).toEqual([]);
    expect(result.unsupported).toBe(true);
  });
});
```

- [x] **Step 3: Implement**

Create `server/repo-map/extract-symbols.js`:

```js
'use strict';

const path = require('path');
let Parser;
const grammars = {};

async function loadParser() {
  if (Parser) return Parser;
  Parser = require('web-tree-sitter');
  await Parser.init();
  grammars.javascript = await Parser.Language.load(require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm'));
  try { grammars.typescript = await Parser.Language.load(require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm')); } catch {}
  try { grammars.python = await Parser.Language.load(require.resolve('tree-sitter-python/tree-sitter-python.wasm')); } catch {}
  return Parser;
}

function languageFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (['.ts', '.tsx'].includes(ext)) return 'typescript';
  if (ext === '.py') return 'python';
  return null;
}

const NODE_TO_KIND = {
  function_declaration: 'function',
  function_expression: 'function',
  arrow_function: 'function',
  method_definition: 'method',
  class_declaration: 'class',
  class_definition: 'class',
  function_definition: 'function',
};

function walk(node, callback, depth = 0) {
  callback(node, depth);
  for (let i = 0; i < node.namedChildCount; i++) {
    walk(node.namedChild(i), callback, depth + 1);
  }
}

async function extractSymbols(filePath, sourceCode) {
  const lang = languageFor(filePath);
  if (!lang) return { symbols: [], references: [], unsupported: true };

  await loadParser();
  if (!grammars[lang]) return { symbols: [], references: [], unsupported: true };

  const parser = new Parser();
  parser.setLanguage(grammars[lang]);
  const tree = parser.parse(sourceCode);

  const symbols = [];
  const references = new Set();

  walk(tree.rootNode, (node, depth) => {
    if (depth > 2) return;
    const kind = NODE_TO_KIND[node.type];
    if (!kind) return;
    const nameNode = node.childForFieldName?.('name') || node.descendantsOfType?.('identifier')?.[0];
    if (!nameNode) return;
    symbols.push({ name: nameNode.text, kind, line: node.startPosition.row + 1 });
  });

  const importRegex = /(?:require|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRegex.exec(sourceCode)) !== null) {
    references.add(m[1]);
  }

  return { symbols, references: [...references], unsupported: false };
}

module.exports = { extractSymbols, languageFor };
```

Run tests → PASS.

- [x] **Step 4: Commit**

Stage `server/repo-map/extract-symbols.js`, the test file, and the package files. Commit message: `feat(repo-map): tree-sitter symbol extraction`.

---

## Task 2: Build reference graph + rank

- [ ] **Step 1: Implement `build-graph.js`**

```js
'use strict';

const path = require('path');

function buildGraphAndRank(fileSymbols, repoRoot) {
  const knownFiles = new Set(fileSymbols.keys());
  const edges = new Map();
  for (const [fromFile, info] of fileSymbols) {
    const dir = path.dirname(fromFile);
    const out = new Set();
    for (const ref of info.references || []) {
      if (!ref.startsWith('.')) continue;
      const candidates = [
        path.normalize(path.join(dir, ref)),
        path.normalize(path.join(dir, ref + '.js')),
        path.normalize(path.join(dir, ref + '.ts')),
        path.normalize(path.join(dir, ref + '.py')),
        path.normalize(path.join(dir, ref, 'index.js')),
      ];
      for (const c of candidates) {
        if (knownFiles.has(c)) { out.add(c); break; }
      }
    }
    edges.set(fromFile, out);
  }

  const N = knownFiles.size || 1;
  let scores = new Map();
  for (const f of knownFiles) scores.set(f, 1 / N);
  const inEdges = new Map();
  for (const f of knownFiles) inEdges.set(f, []);
  for (const [from, outs] of edges) {
    for (const to of outs) inEdges.get(to)?.push(from);
  }
  for (let iter = 0; iter < 10; iter++) {
    const next = new Map();
    for (const f of knownFiles) {
      let sum = 0;
      for (const src of inEdges.get(f) || []) {
        const outDeg = edges.get(src)?.size || 1;
        sum += (scores.get(src) || 0) / outDeg;
      }
      next.set(f, 0.15 / N + 0.85 * sum);
    }
    scores = next;
  }
  return scores;
}

module.exports = { buildGraphAndRank };
```

- [ ] **Step 2: Commit**

Stage `server/repo-map/build-graph.js`. Commit: `feat(repo-map): reference graph + PageRank centrality`.

---

## Task 3: Token-budgeted Markdown renderer

- [ ] **Step 1: Tests**

Create `server/tests/render-map.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { renderRepoMap } = require('../repo-map/render-map');

const fileSymbols = new Map([
  ['src/a.js', { symbols: [{ name: 'foo', kind: 'function', line: 3 }, { name: 'Bar', kind: 'class', line: 10 }] }],
  ['src/b.js', { symbols: [{ name: 'helper', kind: 'function', line: 5 }] }],
  ['src/c.js', { symbols: [{ name: 'main', kind: 'function', line: 1 }] }],
]);
const ranks = new Map([['src/a.js', 0.5], ['src/b.js', 0.3], ['src/c.js', 0.2]]);

describe('renderRepoMap', () => {
  it('renders highest-ranked files first', () => {
    const md = renderRepoMap(fileSymbols, ranks, { token_budget: 1000 });
    expect(md.indexOf('src/a.js')).toBeLessThan(md.indexOf('src/c.js'));
  });
  it('respects token budget', () => {
    const md = renderRepoMap(fileSymbols, ranks, { token_budget: 30 });
    expect(md).toContain('src/a.js');
    expect(md).not.toContain('src/c.js');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/repo-map/render-map.js`:

```js
'use strict';

const { estimateTokens } = require('../context/token-estimate');

function renderRepoMap(fileSymbols, ranks, opts = {}) {
  const budget = opts.token_budget || 4000;
  const sorted = [...fileSymbols.entries()].sort(
    (a, b) => (ranks.get(b[0]) || 0) - (ranks.get(a[0]) || 0)
  );

  const lines = ['# Repository Map', ''];
  let runningTokens = estimateTokens(lines.join('\n'));

  for (const [filePath, info] of sorted) {
    const fileLines = [`## ${filePath}`];
    for (const sym of info.symbols.slice(0, 20)) {
      fileLines.push(`- ${sym.kind} \`${sym.name}\` (line ${sym.line})`);
    }
    fileLines.push('');
    const fileText = fileLines.join('\n');
    const fileTokens = estimateTokens(fileText);
    if (runningTokens + fileTokens > budget) break;
    lines.push(...fileLines);
    runningTokens += fileTokens;
  }

  return lines.join('\n');
}

module.exports = { renderRepoMap };
```

Run tests → PASS. Commit: `feat(repo-map): token-budgeted Markdown renderer`.

---

## Task 4: DB cache + scan orchestrator

- [ ] **Step 1: Schema**

Add to `server/db/schema-tables.js`:

```sql
CREATE TABLE IF NOT EXISTS repo_maps (
  project_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  map_markdown TEXT NOT NULL,
  file_count INTEGER,
  symbol_count INTEGER
);
```

Add `'repo_maps'` to `ALL_TABLES`.

- [ ] **Step 2: Cache + scan module**

Create `server/repo-map/cache.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractSymbols, languageFor } = require('./extract-symbols');
const { buildGraphAndRank } = require('./build-graph');
const { renderRepoMap } = require('./render-map');
const db = require('../database');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target']);

function walkRepo(root, files = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkRepo(full, files);
    } else if (entry.isFile() && languageFor(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) {
    try {
      const stat = fs.statSync(f);
      h.update(`${f}:${stat.size}:${stat.mtimeMs}\n`);
    } catch {}
  }
  return h.digest('hex').slice(0, 16);
}

async function getOrBuildRepoMap(projectPath, opts = {}) {
  const files = walkRepo(projectPath);
  const hash = hashFiles(files);

  const cached = db.prepare('SELECT * FROM repo_maps WHERE project_path = ? AND content_hash = ?').get(projectPath, hash);
  if (cached) return { map: cached.map_markdown, cached: true };

  const fileSymbols = new Map();
  for (const f of files) {
    try {
      const code = fs.readFileSync(f, 'utf8');
      const result = await extractSymbols(f, code);
      if (result.symbols.length > 0) {
        fileSymbols.set(f, result);
      }
    } catch { /* skip unreadable */ }
  }
  const ranks = buildGraphAndRank(fileSymbols, projectPath);

  const relSymbols = new Map();
  const relRanks = new Map();
  for (const [k, v] of fileSymbols) relSymbols.set(path.relative(projectPath, k).replace(/\\/g, '/'), v);
  for (const [k, v] of ranks) relRanks.set(path.relative(projectPath, k).replace(/\\/g, '/'), v);

  const map = renderRepoMap(relSymbols, relRanks, { token_budget: opts.token_budget || 4000 });

  db.prepare(`
    INSERT INTO repo_maps (project_path, content_hash, generated_at, map_markdown, file_count, symbol_count)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      generated_at = excluded.generated_at,
      map_markdown = excluded.map_markdown,
      file_count = excluded.file_count,
      symbol_count = excluded.symbol_count
  `).run(projectPath, hash, new Date().toISOString(), map, fileSymbols.size,
    [...fileSymbols.values()].reduce((s, v) => s + v.symbols.length, 0));

  return { map, cached: false };
}

module.exports = { getOrBuildRepoMap, walkRepo, hashFiles };
```

Commit: `feat(repo-map): scan orchestrator with content-hash cache`.

---

## Task 5: Inject into task prompts + MCP tool

- [ ] **Step 1: Per-task field**

In `server/tool-defs/workflow-defs.js` `create_workflow` `tasks.items.properties`:

```js
inject_repo_map: { type: 'boolean', description: 'Inject the project repository map into this task prompt.' },
```

In `buildWorkflowTaskMetadata`:

```js
if (taskLike.inject_repo_map === true) metaObj.inject_repo_map = true;
```

- [ ] **Step 2: Inject in task-startup**

Find where the task prompt is finalized before the provider runs. After existing context-stuff logic:

```js
let taskMeta;
try { taskMeta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}); } catch { taskMeta = {}; }
if (taskMeta.inject_repo_map && task.working_directory) {
  try {
    const { getOrBuildRepoMap } = require('../repo-map/cache');
    const { map } = await getOrBuildRepoMap(task.working_directory, { token_budget: 4000 });
    task.task_description = `${map}\n\n---\n\n${task.task_description}`;
  } catch (err) {
    logger.info(`[repo-map] Failed for task ${taskId}: ${err.message}`);
  }
}
```

- [ ] **Step 3: MCP tool to view the map**

Create `server/tool-defs/repo-map-defs.js`:

```js
'use strict';
const REPO_MAP_TOOLS = [
  {
    name: 'get_repo_map',
    description: 'Get the cached or freshly-built repository map for a project.',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        token_budget: { type: 'integer', minimum: 500, maximum: 16000, default: 4000 },
      },
    },
  },
];
module.exports = { REPO_MAP_TOOLS };
```

Create `server/handlers/repo-map-handlers.js`:

```js
'use strict';
const { getOrBuildRepoMap } = require('../repo-map/cache');

async function handleGetRepoMap(args) {
  const { map, cached } = await getOrBuildRepoMap(args.project_path, { token_budget: args.token_budget });
  return {
    content: [{ type: 'text', text: map }],
    structuredData: { map, cached, project_path: args.project_path },
  };
}

module.exports = { handleGetRepoMap };
```

Wire into `server/tools.js` and add REST route in `server/api/routes-passthrough.js`:

```js
{ method: 'POST', path: '/api/v2/repo-map', tool: 'get_repo_map', mapBody: true },
```

- [ ] **Step 4: Integration test**

Create `server/tests/repo-map-integration.test.js`:

```js
'use strict';
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const fs = require('fs');
const path = require('path');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('repo-map-int'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

describe('repo-map end-to-end', () => {
  it('builds and caches a map for a small project', async () => {
    fs.writeFileSync(path.join(testDir, 'a.js'), `function foo() { return require('./b').helper; }`);
    fs.writeFileSync(path.join(testDir, 'b.js'), `module.exports.helper = () => 42;`);

    const { getOrBuildRepoMap } = require('../repo-map/cache');
    const first = await getOrBuildRepoMap(testDir, { token_budget: 1000 });
    expect(first.cached).toBe(false);
    expect(first.map).toContain('a.js');
    expect(first.map).toContain('b.js');
    expect(first.map).toContain('foo');
    expect(first.map).toContain('helper');

    const second = await getOrBuildRepoMap(testDir, { token_budget: 1000 });
    expect(second.cached).toBe(true);
  });
});
```

Run → PASS. Commit: `feat(repo-map): inject_repo_map per-task + get_repo_map MCP tool`.

---

## Task 6: Workflow-spec (skip if Plan 1 not shipped) + docs + restart

- [ ] **Step 1: Schema (if Plan 1 shipped)**

Add `inject_repo_map: { type: 'boolean' }` to `tasks.items.properties` in `server/workflow-spec/schema.js`.

- [ ] **Step 2: Docs**

Create `docs/repo-map.md` with a usage guide. Include: when to use (cross-file refactors, greenfield generation), caching behavior, supported languages (js/ts/py), and the MCP tool reference.

- [ ] **Step 3: Restart, smoke**

`await_restart`. Then call the MCP tool to retrieve the map for the TORQUE project itself. Expect a Markdown map with `server/task-manager.js` near the top (highest centrality given its fan-in).

Commit: `docs(repo-map): user guide`.
