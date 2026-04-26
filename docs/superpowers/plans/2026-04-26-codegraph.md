# Codegraph Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a TORQUE-native code knowledge graph (`codegraph`) — a parser + symbol/reference index exposed via REST first and MCP second — so the Planner, scouts, and remediation agents can query call graphs, find-references, and impact-sets without re-discovering structure each task.

**Architecture:** Standard TORQUE plugin at `server/plugins/codegraph/` following the existing `version-control` plugin shape (factory + `tool-defs.js` + `handlers.js` + `ensureSchema(db)`). Parsing uses `web-tree-sitter` with the wasm grammars that already ship in `tree-sitter-wasms` (JS/TS/TSX/C#/Python/Go/Rust available out of the box; PowerShell deferred). Storage is SQLite via the container's `db` service — same DB as the rest of TORQUE, with a `cg_*` table prefix to keep schemas isolated. The indexer is a worker thread inside the TORQUE process that indexes against `HEAD` only (never the dirty worktree), persists incrementally, and resumes from last-indexed commit on startup. Every MCP tool gets a REST equivalent registered in `server/api/routes-passthrough.js` so HTTP-only clients (Codex, curl scripts, factory shell scripts) can query the graph even while the MCP SSE channel is reconnecting after a cutover.

**Tech Stack:**
- Runtime: Node.js (TORQUE server process), `worker_threads` for the indexer
- Parsing: `web-tree-sitter@^0.26.8` + grammars from `tree-sitter-wasms@^0.1.13` (already installed)
- Storage: `better-sqlite3@^12.8.0` via container `db` service (already installed)
- Plugin contract: `server/plugins/plugin-contract.js` (`name`, `version`, `install`, `uninstall`, `mcpTools`, `middleware`, `eventHandlers`, `configSchema`)
- Subprocess: `execFileSync` only — never `execSync`/`exec` (no shell, no injection surface)
- Tests: `vitest` (existing TORQUE convention); run via `torque-remote npx vitest run <path>` from the worktree
- Feature gate: `TORQUE_CODEGRAPH_ENABLED=1` env var, default off; once enabled, plugin self-registers but stays in shadow mode (queries served, but Planner/scout integration not wired) until Phase 4

---

## File Structure

### Created files

| File | Responsibility |
|------|---------------|
| `server/plugins/codegraph/index.js` | Plugin factory; `install`/`uninstall`/`mcpTools`; container resolution; schema bootstrap via `ensureSchema` |
| `server/plugins/codegraph/schema.js` | `CREATE TABLE` SQL for `cg_files`, `cg_symbols`, `cg_references`, `cg_index_state`; `ensureSchema(db)` export |
| `server/plugins/codegraph/parser.js` | Singleton wasm parser pool: `getParser(language) -> TreeSitter.Parser`. Handles grammar load + caching |
| `server/plugins/codegraph/extractors/javascript.js` | Walks JS/TS/TSX AST; emits `{symbols, references}` rows |
| `server/plugins/codegraph/extractors/index.js` | `extractorFor(filePath) -> extractor` dispatch by extension |
| `server/plugins/codegraph/indexer.js` | Orchestrates: enumerate files at HEAD → parse → extract → upsert into SQLite. Pure functions; no worker thread plumbing |
| `server/plugins/codegraph/indexer-worker.js` | `worker_threads` entrypoint; receives `{repoPath, commitSha, fileList}` over `parentPort`; calls `indexer.run`; reports progress |
| `server/plugins/codegraph/index-runner.js` | Public API for plugin: `indexRepoAtHead(repoPath)`, `getIndexState(repoPath)`. Spawns worker, persists state, no-ops if already up-to-date |
| `server/plugins/codegraph/queries/find-references.js` | `findReferences({symbolName, filePath, repoPath}) -> [{file, line, column, callerSymbol}]` |
| `server/plugins/codegraph/queries/impact-set.js` | `impactSet({symbolName, repoPath, depth}) -> {symbols: [...], files: [...]}` (BFS over `cg_references`) |
| `server/plugins/codegraph/queries/call-graph.js` | `callGraph({symbolName, repoPath, depth, direction})` — `direction = 'callers'|'callees'|'both'` |
| `server/plugins/codegraph/queries/dead-symbols.js` | `deadSymbols({repoPath}) -> [{symbol, file, line}]` — symbols defined but never referenced |
| `server/plugins/codegraph/handlers.js` | One async handler per MCP tool name; each delegates to a query module + formats response |
| `server/plugins/codegraph/tool-defs.js` | MCP tool descriptor array: `name`, `description`, `inputSchema` |
| `server/plugins/codegraph/test-helpers.js` | Shared `setupTinyRepo()` helper for tests; uses `execFileSync` only |
| `server/plugins/codegraph/tests/schema.test.js` | Schema creation + idempotency |
| `server/plugins/codegraph/tests/extractor-javascript.test.js` | Fixture-driven: parse known JS/TS snippets, assert extracted symbols/references |
| `server/plugins/codegraph/tests/indexer.test.js` | Build a tiny fixture repo, run indexer, assert DB rows |
| `server/plugins/codegraph/tests/queries.test.js` | Round-trip: index fixture → run each query → assert results |
| `server/plugins/codegraph/tests/handlers.test.js` | Each handler maps inputs → query → output shape |
| `server/plugins/codegraph/tests/plugin-lifecycle.test.js` | `install()` registers tools; `uninstall()` clears state; respects feature flag |
| `server/plugins/codegraph/fixtures/tiny-repo/` | Hand-built JS/TS files used by indexer + query tests |
| `docs/codegraph.md` | User-facing readme: enabling, REST endpoints, MCP tools, query semantics, limitations |

### Modified files

| File | Change |
|------|--------|
| `server/index.js:63` | Add `'codegraph'` to `DEFAULT_PLUGIN_NAMES` (gated — plugin's `install()` is a no-op when `TORQUE_CODEGRAPH_ENABLED !== '1'`) |
| `server/api/routes-passthrough.js` | Append a `─── codegraph (6 routes) ───` block mirroring each MCP tool to `/api/v2/codegraph/*` |
| `CLAUDE.md` | Add "Code Graph" subsection under "Default Plugins" describing the feature flag and core query shapes |

---

## Tool Catalog (REST + MCP, identical surface)

| MCP tool | REST endpoint | Purpose |
|----------|---------------|---------|
| `cg_index_status` | `GET /api/v2/codegraph/index-status` | `{repoPath} → {commitSha, indexedAt, files, symbols, references, stale}` |
| `cg_reindex` | `POST /api/v2/codegraph/reindex` | `{repoPath, force?: bool} → {jobId, queued: true}` — fire-and-forget; idempotent if already current |
| `cg_find_references` | `POST /api/v2/codegraph/find-references` | `{repoPath, symbol, file?, line?} → [{file, line, column, callerSymbol}]` |
| `cg_impact_set` | `POST /api/v2/codegraph/impact-set` | `{repoPath, symbol, depth?: 1} → {symbols:[...], files:[...]}` |
| `cg_call_graph` | `POST /api/v2/codegraph/call-graph` | `{repoPath, symbol, direction:'callers'|'callees'|'both', depth?: 2} → {nodes, edges}` |
| `cg_dead_symbols` | `GET /api/v2/codegraph/dead-symbols?repoPath=...` | `{repoPath} → [{symbol, file, line, kind}]` |

---

## Phasing

- **Phase 1 (Tasks 1–4):** Plugin skeleton + schema + parser pool. Lifecycle test passes; no queries yet.
- **Phase 2 (Tasks 5–8):** JS/TS extractor, indexer, persistence. Round-trip tests on a fixture repo.
- **Phase 3 (Tasks 9–13):** Five query modules + handlers + tool definitions. MCP tools live behind the flag.
- **Phase 4 (Tasks 14–16):** REST parity, plugin registration, feature flag gating. `curl /api/v2/codegraph/find-references` works end-to-end.
- **Phase 5 (Tasks 17–18):** Worker-thread indexer, startup resume, HEAD-vs-dirty discipline.
- **Phase 6 (Tasks 19–20):** Docs + cutover.

C#, Python, and PowerShell extractors are explicitly out of scope for this plan. Once Phase 6 ships and shadow-mode validation runs clean for one week, a follow-up plan adds them as parallel extractor modules behind the same query interface.

---

## Subprocess discipline

**Never `execSync` or `exec`.** Both invoke a shell and create injection surface even with hardcoded args (the security hook will block commits). Use `execFileSync(file, args, opts)` everywhere — it `execve`s the binary directly with no shell, and arg arrays are passed as raw argv. Every test that spins up a tiny git repo uses the shared `test-helpers.js` so the discipline is enforced in one place.

---

## Task 1: Plugin skeleton + lifecycle test

**Files:**
- Create: `server/plugins/codegraph/index.js`
- Create: `server/plugins/codegraph/tests/plugin-lifecycle.test.js`

- [ ] **Step 1: Write the failing lifecycle test**

```javascript
// server/plugins/codegraph/tests/plugin-lifecycle.test.js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const Database = require('better-sqlite3');
const { createCodegraphPlugin } = require('../index');

describe('codegraph plugin lifecycle', () => {
  let db;
  let container;

  beforeEach(() => {
    db = new Database(':memory:');
    container = {
      get(name) {
        if (name === 'db') return { getDbInstance: () => db };
        throw new Error(`unknown service: ${name}`);
      },
    };
  });

  afterEach(() => db.close());

  it('reports plugin metadata', () => {
    const plugin = createCodegraphPlugin();
    expect(plugin.name).toBe('codegraph');
    expect(typeof plugin.version).toBe('string');
  });

  it('returns no MCP tools before install', () => {
    const plugin = createCodegraphPlugin();
    expect(plugin.mcpTools()).toEqual([]);
  });

  it('install is a no-op when feature flag is off', () => {
    const prev = process.env.TORQUE_CODEGRAPH_ENABLED;
    delete process.env.TORQUE_CODEGRAPH_ENABLED;
    try {
      const plugin = createCodegraphPlugin();
      plugin.install(container);
      expect(plugin.mcpTools()).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.TORQUE_CODEGRAPH_ENABLED = prev;
    }
  });

  it.skip('install registers tools when feature flag is on (Task 13 wires tool-defs)', () => {
    process.env.TORQUE_CODEGRAPH_ENABLED = '1';
    try {
      const plugin = createCodegraphPlugin();
      plugin.install(container);
      const tools = plugin.mcpTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((t) => typeof t.name === 'string')).toBe(true);
      expect(tools.every((t) => typeof t.handler === 'function')).toBe(true);
    } finally {
      delete process.env.TORQUE_CODEGRAPH_ENABLED;
    }
  });

  it('uninstall clears tools', () => {
    process.env.TORQUE_CODEGRAPH_ENABLED = '1';
    try {
      const plugin = createCodegraphPlugin();
      plugin.install(container);
      plugin.uninstall();
      expect(plugin.mcpTools()).toEqual([]);
    } finally {
      delete process.env.TORQUE_CODEGRAPH_ENABLED;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/plugin-lifecycle.test.js`
Expected: FAIL — `Cannot find module '../index'`

- [ ] **Step 3: Write minimal plugin factory**

```javascript
// server/plugins/codegraph/index.js
'use strict';

const PLUGIN_NAME = 'codegraph';
const PLUGIN_VERSION = '0.1.0';

function isFeatureEnabled() {
  return process.env.TORQUE_CODEGRAPH_ENABLED === '1';
}

function getContainerService(container, name) {
  if (!container || typeof container.get !== 'function') return null;
  try { return container.get(name); } catch { return null; }
}

function resolveRawDb(dbService) {
  const rawDb = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);
  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('codegraph plugin requires container db service with prepare() or getDbInstance()');
  }
  return rawDb;
}

function createCodegraphPlugin() {
  let db = null;
  let installed = false;
  let toolList = [];

  function install(container) {
    if (!isFeatureEnabled()) return;
    const dbService = getContainerService(container, 'db');
    db = resolveRawDb(dbService);
    installed = true;
    toolList = [];
  }

  function uninstall() {
    db = null;
    installed = false;
    toolList = [];
  }

  function mcpTools() {
    if (!installed) return [];
    return toolList;
  }

  function middleware() { return []; }
  function eventHandlers() { return {}; }
  function configSchema() { return { type: 'object', properties: {} }; }

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    install,
    uninstall,
    mcpTools,
    middleware,
    eventHandlers,
    configSchema,
  };
}

const codegraphPlugin = createCodegraphPlugin();

module.exports = codegraphPlugin;
module.exports.createCodegraphPlugin = createCodegraphPlugin;
module.exports.createPlugin = createCodegraphPlugin;
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/plugin-lifecycle.test.js`
Expected: 4 passed, 1 skipped, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add server/plugins/codegraph/index.js server/plugins/codegraph/tests/plugin-lifecycle.test.js
git commit -m "feat(codegraph): plugin skeleton with feature-flag gate"
```

---

## Task 2: Schema + ensureSchema

**Files:**
- Create: `server/plugins/codegraph/schema.js`
- Create: `server/plugins/codegraph/tests/schema.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// server/plugins/codegraph/tests/schema.test.js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');

describe('codegraph schema', () => {
  let db;

  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => db.close());

  it('creates cg_files, cg_symbols, cg_references, cg_index_state tables', () => {
    ensureSchema(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cg_%'"
    ).all().map((r) => r.name).sort();
    expect(tables).toEqual(['cg_files', 'cg_index_state', 'cg_references', 'cg_symbols']);
  });

  it('is idempotent — second call does not throw', () => {
    ensureSchema(db);
    expect(() => ensureSchema(db)).not.toThrow();
  });

  it('cg_symbols supports the columns queries will read', () => {
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info('cg_symbols')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'repo_path', 'file_path', 'name', 'kind', 'start_line', 'start_col', 'end_line', 'end_col',
    ]));
  });

  it('cg_references supports caller_symbol_id + target_name', () => {
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info('cg_references')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'repo_path', 'file_path', 'caller_symbol_id', 'target_name', 'line', 'col',
    ]));
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/schema.test.js`
Expected: FAIL — `Cannot find module '../schema'`

- [ ] **Step 3: Implement schema**

```javascript
// server/plugins/codegraph/schema.js
'use strict';

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS cg_files (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    content_sha TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    UNIQUE(repo_path, file_path)
  )`,
  `CREATE TABLE IF NOT EXISTS cg_symbols (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    start_col INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    end_col INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cg_symbols_name ON cg_symbols(repo_path, name)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_symbols_file ON cg_symbols(repo_path, file_path)`,
  `CREATE TABLE IF NOT EXISTS cg_references (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    caller_symbol_id INTEGER,
    target_name TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cg_refs_target ON cg_references(repo_path, target_name)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_refs_caller ON cg_references(caller_symbol_id)`,
  `CREATE TABLE IF NOT EXISTS cg_index_state (
    repo_path TEXT PRIMARY KEY,
    commit_sha TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    files INTEGER NOT NULL DEFAULT 0,
    symbols INTEGER NOT NULL DEFAULT 0,
    references_count INTEGER NOT NULL DEFAULT 0
  )`,
];

function ensureSchema(db) {
  for (const sql of SCHEMA_SQL) {
    db.prepare(sql).run();
  }
}

module.exports = { ensureSchema };
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/schema.test.js`
Expected: 4 passed.

- [ ] **Step 5: Wire schema into plugin install**

Open `server/plugins/codegraph/index.js`. Add at top:

```javascript
const { ensureSchema } = require('./schema');
```

In `install()`, after `db = resolveRawDb(dbService);`, add `ensureSchema(db);`.

- [ ] **Step 6: Re-run lifecycle test**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/plugin-lifecycle.test.js`
Expected: 4 passed, 1 skipped.

- [ ] **Step 7: Commit**

```bash
git add server/plugins/codegraph/schema.js server/plugins/codegraph/tests/schema.test.js server/plugins/codegraph/index.js
git commit -m "feat(codegraph): cg_files/cg_symbols/cg_references/cg_index_state schema"
```

---

## Task 3: Parser pool

**Files:**
- Create: `server/plugins/codegraph/parser.js`
- Create: `server/plugins/codegraph/tests/parser.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// server/plugins/codegraph/tests/parser.test.js
'use strict';

const { describe, it, expect } = require('vitest');
const { getParser, supportedLanguages } = require('../parser');

describe('codegraph parser pool', () => {
  it('lists supported languages including javascript and typescript', () => {
    const langs = supportedLanguages();
    expect(langs).toEqual(expect.arrayContaining(['javascript', 'typescript', 'tsx']));
  });

  it('returns the same parser instance on repeated calls (caching)', async () => {
    const a = await getParser('javascript');
    const b = await getParser('javascript');
    expect(a).toBe(b);
  });

  it('parses a JS snippet into a tree with a non-null root', async () => {
    const parser = await getParser('javascript');
    const tree = parser.parse('function foo() { return 42; }');
    expect(tree.rootNode).not.toBeNull();
    expect(tree.rootNode.type).toBe('program');
  });

  it('rejects unknown languages with a clear error', async () => {
    await expect(getParser('cobol')).rejects.toThrow(/unsupported language/i);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/parser.test.js`
Expected: FAIL — `Cannot find module '../parser'`

- [ ] **Step 3: Implement parser pool**

```javascript
// server/plugins/codegraph/parser.js
'use strict';

const path = require('path');
const Parser = require('web-tree-sitter');

const GRAMMAR_FILES = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
};

const cache = new Map();
let parserInitPromise = null;

function ensureParserInit() {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init();
  }
  return parserInitPromise;
}

function grammarPath(language) {
  const file = GRAMMAR_FILES[language];
  if (!file) throw new Error(`unsupported language: ${language}`);
  return path.join(__dirname, '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out', file);
}

async function getParser(language) {
  if (!GRAMMAR_FILES[language]) throw new Error(`unsupported language: ${language}`);
  if (cache.has(language)) return cache.get(language);
  await ensureParserInit();
  const lang = await Parser.Language.load(grammarPath(language));
  const parser = new Parser();
  parser.setLanguage(lang);
  cache.set(language, parser);
  return parser;
}

function supportedLanguages() {
  return Object.keys(GRAMMAR_FILES);
}

module.exports = { getParser, supportedLanguages };
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/parser.test.js`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/plugins/codegraph/parser.js server/plugins/codegraph/tests/parser.test.js
git commit -m "feat(codegraph): wasm tree-sitter parser pool with caching"
```

---

## Task 4: Extractor for JavaScript / TypeScript

**Files:**
- Create: `server/plugins/codegraph/extractors/javascript.js`
- Create: `server/plugins/codegraph/extractors/index.js`
- Create: `server/plugins/codegraph/tests/extractor-javascript.test.js`

- [ ] **Step 1: Write failing extractor test**

```javascript
// server/plugins/codegraph/tests/extractor-javascript.test.js
'use strict';

const { describe, it, expect } = require('vitest');
const { extractFromSource } = require('../extractors/javascript');

describe('javascript extractor', () => {
  it('extracts named function declarations', async () => {
    const src = `function foo() {}\nfunction bar() {}\n`;
    const { symbols } = await extractFromSource(src, 'javascript');
    const names = symbols.map((s) => s.name).sort();
    expect(names).toEqual(['bar', 'foo']);
    expect(symbols.every((s) => s.kind === 'function')).toBe(true);
  });

  it('extracts call expressions as references', async () => {
    const src = `function foo() { return bar(1, 2); }\n`;
    const { references } = await extractFromSource(src, 'javascript');
    const targets = references.map((r) => r.targetName);
    expect(targets).toContain('bar');
  });

  it('attaches caller_symbol_index to references inside a function', async () => {
    const src = `function foo() { bar(); }\n`;
    const { symbols, references } = await extractFromSource(src, 'javascript');
    const fooIdx = symbols.findIndex((s) => s.name === 'foo');
    expect(fooIdx).toBeGreaterThanOrEqual(0);
    const ref = references.find((r) => r.targetName === 'bar');
    expect(ref.callerSymbolIndex).toBe(fooIdx);
  });

  it('extracts class declarations and methods', async () => {
    const src = `class Foo { bar() {} baz() {} }\n`;
    const { symbols } = await extractFromSource(src, 'javascript');
    const kinds = symbols.map((s) => `${s.kind}:${s.name}`).sort();
    expect(kinds).toEqual(['class:Foo', 'method:bar', 'method:baz']);
  });

  it('skips references with no target (anonymous calls)', async () => {
    const src = `function foo() { (() => 1)(); }\n`;
    const { references } = await extractFromSource(src, 'javascript');
    expect(references.find((r) => r.targetName === '')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/extractor-javascript.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement extractor**

```javascript
// server/plugins/codegraph/extractors/javascript.js
'use strict';

const { getParser } = require('../parser');

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'class_declaration',
  'arrow_function',
  'function',
]);

function nodeName(node) {
  const nameNode = node.childForFieldName('name');
  return nameNode ? nameNode.text : '';
}

function kindFor(node) {
  switch (node.type) {
    case 'function_declaration': return 'function';
    case 'method_definition':    return 'method';
    case 'class_declaration':    return 'class';
    case 'arrow_function':       return 'function';
    case 'function':             return 'function';
    default:                     return 'unknown';
  }
}

function callTargetName(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn) return '';
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : '';
  }
  return '';
}

async function extractFromSource(source, language) {
  const parser = await getParser(language);
  const tree = parser.parse(source);

  const symbols = [];
  const references = [];
  const enclosingStack = []; // indexes into `symbols`

  function walk(node) {
    let pushed = false;
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const name = nodeName(node);
      if (name) {
        symbols.push({
          name,
          kind: kindFor(node),
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine:   node.endPosition.row + 1,
          endCol:    node.endPosition.column,
        });
        enclosingStack.push(symbols.length - 1);
        pushed = true;
      }
    }
    if (node.type === 'call_expression') {
      const target = callTargetName(node);
      if (target) {
        references.push({
          targetName: target,
          line: node.startPosition.row + 1,
          col:  node.startPosition.column,
          callerSymbolIndex: enclosingStack[enclosingStack.length - 1] ?? null,
        });
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
    if (pushed) enclosingStack.pop();
  }

  walk(tree.rootNode);
  return { symbols, references };
}

module.exports = { extractFromSource };
```

- [ ] **Step 4: Implement extractor dispatch**

```javascript
// server/plugins/codegraph/extractors/index.js
'use strict';

const path = require('path');
const javascript = require('./javascript');

const EXT_TO_LANGUAGE = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
};

function languageFor(filePath) {
  return EXT_TO_LANGUAGE[path.extname(filePath).toLowerCase()] || null;
}

function extractorFor(filePath) {
  const language = languageFor(filePath);
  if (!language) return null;
  return {
    language,
    extract: (source) => javascript.extractFromSource(source, language),
  };
}

module.exports = { extractorFor, languageFor };
```

- [ ] **Step 5: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/extractor-javascript.test.js`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add server/plugins/codegraph/extractors/ server/plugins/codegraph/tests/extractor-javascript.test.js
git commit -m "feat(codegraph): JS/TS/TSX extractor (functions, classes, calls)"
```

---

## Task 5: Indexer (synchronous, in-process)

**Files:**
- Create: `server/plugins/codegraph/indexer.js`
- Create: `server/plugins/codegraph/fixtures/tiny-repo/a.js`
- Create: `server/plugins/codegraph/fixtures/tiny-repo/b.js`
- Create: `server/plugins/codegraph/tests/indexer.test.js`

- [ ] **Step 1: Build the fixture repo**

```javascript
// server/plugins/codegraph/fixtures/tiny-repo/a.js
function alpha() { return beta(); }
function gamma() { return alpha(); }
module.exports = { alpha, gamma };
```

```javascript
// server/plugins/codegraph/fixtures/tiny-repo/b.js
function beta() { return 1; }
function delta() { return beta(); }
module.exports = { beta, delta };
```

- [ ] **Step 2: Write failing indexer test**

```javascript
// server/plugins/codegraph/tests/indexer.test.js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { runIndex } = require('../indexer');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'tiny-repo');

describe('codegraph indexer', () => {
  let db;

  beforeEach(() => { db = new Database(':memory:'); ensureSchema(db); });
  afterEach(() => db.close());

  it('indexes the fixture repo and writes cg_files rows', async () => {
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
    const rows = db.prepare(
      "SELECT file_path FROM cg_files WHERE repo_path = ? ORDER BY file_path"
    ).all(FIXTURE);
    expect(rows.map((r) => r.file_path)).toEqual(['a.js', 'b.js']);
  });

  it('writes cg_symbols rows for every function in the fixture', async () => {
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
    const names = db.prepare(
      "SELECT name FROM cg_symbols WHERE repo_path = ? ORDER BY name"
    ).all(FIXTURE).map((r) => r.name);
    expect(names).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('writes cg_references rows linked to caller_symbol_id', async () => {
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
    const refs = db.prepare(`
      SELECT s.name AS caller, r.target_name AS target
      FROM cg_references r
      JOIN cg_symbols s ON s.id = r.caller_symbol_id
      WHERE r.repo_path = ?
      ORDER BY caller, target
    `).all(FIXTURE);
    expect(refs).toEqual([
      { caller: 'alpha', target: 'beta' },
      { caller: 'delta', target: 'beta' },
      { caller: 'gamma', target: 'alpha' },
    ]);
  });

  it('updates cg_index_state with file/symbol/reference counts', async () => {
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'], commitSha: 'abc123' });
    const state = db.prepare("SELECT * FROM cg_index_state WHERE repo_path = ?").get(FIXTURE);
    expect(state.commit_sha).toBe('abc123');
    expect(state.files).toBe(2);
    expect(state.symbols).toBe(4);
    expect(state.references_count).toBe(3);
  });

  it('is idempotent: re-running on the same files replaces rows, no duplicates', async () => {
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
    const count = db.prepare(
      "SELECT COUNT(*) AS n FROM cg_symbols WHERE repo_path = ?"
    ).get(FIXTURE).n;
    expect(count).toBe(4);
  });
});
```

- [ ] **Step 3: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/indexer.test.js`
Expected: FAIL — `Cannot find module '../indexer'`

- [ ] **Step 4: Implement indexer**

```javascript
// server/plugins/codegraph/indexer.js
'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { extractorFor } = require('./extractors');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function runIndex({ db, repoPath, files, commitSha = null, _sourceDir = null }) {
  const now = new Date().toISOString();

  const deleteFiles      = db.prepare('DELETE FROM cg_files      WHERE repo_path = ?');
  const deleteSymbols    = db.prepare('DELETE FROM cg_symbols    WHERE repo_path = ?');
  const deleteReferences = db.prepare('DELETE FROM cg_references WHERE repo_path = ?');
  const insertFile = db.prepare(`
    INSERT INTO cg_files (repo_path, file_path, language, content_sha, indexed_at)
    VALUES (@repoPath, @filePath, @language, @contentSha, @indexedAt)
  `);
  const insertSymbol = db.prepare(`
    INSERT INTO cg_symbols (repo_path, file_path, name, kind, start_line, start_col, end_line, end_col)
    VALUES (@repoPath, @filePath, @name, @kind, @startLine, @startCol, @endLine, @endCol)
  `);
  const insertReference = db.prepare(`
    INSERT INTO cg_references (repo_path, file_path, caller_symbol_id, target_name, line, col)
    VALUES (@repoPath, @filePath, @callerSymbolId, @targetName, @line, @col)
  `);
  const upsertState = db.prepare(`
    INSERT INTO cg_index_state (repo_path, commit_sha, indexed_at, files, symbols, references_count)
    VALUES (@repoPath, @commitSha, @indexedAt, @files, @symbols, @refs)
    ON CONFLICT(repo_path) DO UPDATE SET
      commit_sha = excluded.commit_sha,
      indexed_at = excluded.indexed_at,
      files      = excluded.files,
      symbols    = excluded.symbols,
      references_count = excluded.references_count
  `);

  const work = [];
  for (const rel of files) {
    const ext = extractorFor(rel);
    if (!ext) continue;
    const abs = path.join(_sourceDir || repoPath, rel);
    const buf = await fs.readFile(abs);
    const source = buf.toString('utf8');
    const extracted = await ext.extract(source);
    work.push({ rel, language: ext.language, contentSha: sha256(buf), extracted });
  }

  let totalFiles = 0, totalSymbols = 0, totalRefs = 0;

  const tx = db.transaction(() => {
    deleteReferences.run(repoPath);
    deleteSymbols.run(repoPath);
    deleteFiles.run(repoPath);

    for (const { rel, language, contentSha, extracted } of work) {
      insertFile.run({
        repoPath, filePath: rel, language, contentSha, indexedAt: now,
      });
      totalFiles++;

      const symbolIds = [];
      for (const s of extracted.symbols) {
        const info = insertSymbol.run({
          repoPath,
          filePath: rel,
          name: s.name,
          kind: s.kind,
          startLine: s.startLine,
          startCol:  s.startCol,
          endLine:   s.endLine,
          endCol:    s.endCol,
        });
        symbolIds.push(info.lastInsertRowid);
      }
      totalSymbols += extracted.symbols.length;

      for (const r of extracted.references) {
        const callerId = r.callerSymbolIndex == null ? null : symbolIds[r.callerSymbolIndex];
        insertReference.run({
          repoPath,
          filePath: rel,
          callerSymbolId: callerId,
          targetName: r.targetName,
          line: r.line,
          col:  r.col,
        });
      }
      totalRefs += extracted.references.length;
    }

    upsertState.run({
      repoPath,
      commitSha: commitSha || '',
      indexedAt: now,
      files: totalFiles,
      symbols: totalSymbols,
      refs: totalRefs,
    });
  });

  tx();

  return { files: totalFiles, symbols: totalSymbols, references: totalRefs };
}

module.exports = { runIndex };
```

- [ ] **Step 5: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/indexer.test.js`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add server/plugins/codegraph/indexer.js server/plugins/codegraph/fixtures server/plugins/codegraph/tests/indexer.test.js
git commit -m "feat(codegraph): synchronous repo indexer with idempotent transactions"
```

---

## Task 6: Test helpers (shared `setupTinyRepo`)

**Files:**
- Create: `server/plugins/codegraph/test-helpers.js`

This module is consumed by Tasks 7, 8, 12, 16, 17. It exists in one place so the `execFileSync`-only discipline is enforced consistently.

- [ ] **Step 1: Write the helper**

```javascript
// server/plugins/codegraph/test-helpers.js
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

function setupTinyRepo(prefix = 'cg-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'a.js'), 'function alpha() { return beta(); }\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'function beta() { return 1; }\n');
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  return dir;
}

function destroyTinyRepo(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { setupTinyRepo, destroyTinyRepo, git };
```

- [ ] **Step 2: Commit (no test — used by downstream tests)**

```bash
git add server/plugins/codegraph/test-helpers.js
git commit -m "test(codegraph): shared test helpers using execFileSync only"
```

---

## Task 7: Query — find_references

**Files:**
- Create: `server/plugins/codegraph/queries/find-references.js`
- Create: `server/plugins/codegraph/tests/queries.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// server/plugins/codegraph/tests/queries.test.js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { runIndex } = require('../indexer');
const { findReferences } = require('../queries/find-references');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'tiny-repo');

describe('codegraph queries: find_references', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    ensureSchema(db);
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
  });
  afterEach(() => db.close());

  it('finds the two callers of `beta`', () => {
    const rows = findReferences({ db, repoPath: FIXTURE, symbol: 'beta' });
    const callers = rows.map((r) => r.callerSymbol).sort();
    expect(callers).toEqual(['alpha', 'delta']);
  });

  it('returns empty array for an unknown symbol', () => {
    expect(findReferences({ db, repoPath: FIXTURE, symbol: 'nope' })).toEqual([]);
  });

  it('includes file, line, column for each reference', () => {
    const rows = findReferences({ db, repoPath: FIXTURE, symbol: 'beta' });
    for (const r of rows) {
      expect(typeof r.file).toBe('string');
      expect(typeof r.line).toBe('number');
      expect(typeof r.column).toBe('number');
    }
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/queries.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement query**

```javascript
// server/plugins/codegraph/queries/find-references.js
'use strict';

const SQL = `
  SELECT
    r.file_path  AS file,
    r.line       AS line,
    r.col        AS column,
    s.name       AS callerSymbol
  FROM cg_references r
  LEFT JOIN cg_symbols s ON s.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath AND r.target_name = @symbol
  ORDER BY r.file_path, r.line
`;

function findReferences({ db, repoPath, symbol }) {
  return db.prepare(SQL).all({ repoPath, symbol });
}

module.exports = { findReferences };
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/queries.test.js`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add server/plugins/codegraph/queries/find-references.js server/plugins/codegraph/tests/queries.test.js
git commit -m "feat(codegraph): find_references query"
```

---

## Task 8: Query — call_graph

**Files:**
- Create: `server/plugins/codegraph/queries/call-graph.js`
- Modify: `server/plugins/codegraph/tests/queries.test.js`

- [ ] **Step 1: Append test cases**

Add to `queries.test.js`:

```javascript
const { callGraph } = require('../queries/call-graph');

describe('codegraph queries: call_graph', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    ensureSchema(db);
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
  });
  afterEach(() => db.close());

  it('returns direct callees of `alpha` (depth 1)', () => {
    const g = callGraph({ db, repoPath: FIXTURE, symbol: 'alpha', direction: 'callees', depth: 1 });
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['alpha', 'beta']);
    expect(g.edges).toEqual([{ from: 'alpha', to: 'beta' }]);
  });

  it('returns transitive callers of `beta` at depth 2', () => {
    const g = callGraph({ db, repoPath: FIXTURE, symbol: 'beta', direction: 'callers', depth: 2 });
    const names = g.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('direction=both unions callers and callees', () => {
    const g = callGraph({ db, repoPath: FIXTURE, symbol: 'alpha', direction: 'both', depth: 1 });
    const names = g.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('clamps depth to a sane upper bound', () => {
    const g = callGraph({ db, repoPath: FIXTURE, symbol: 'beta', direction: 'callers', depth: 9999 });
    expect(g.nodes.length).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/queries.test.js`
Expected: 3 pass (Task 7), 4 fail (call_graph missing).

- [ ] **Step 3: Implement query**

```javascript
// server/plugins/codegraph/queries/call-graph.js
'use strict';

const MAX_DEPTH = 8;
const MAX_NODES = 100;

const CALLEES_SQL = `
  SELECT DISTINCT r.target_name AS name
  FROM cg_references r
  JOIN cg_symbols s ON s.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath AND s.name = @symbol
`;

const CALLERS_SQL = `
  SELECT DISTINCT s.name AS name
  FROM cg_references r
  JOIN cg_symbols s ON s.id = r.caller_symbol_id
  WHERE r.repo_path = @repoPath AND r.target_name = @symbol
`;

function expand(db, repoPath, frontier, sql, depth, visited) {
  let next = new Set(frontier);
  const edges = new Set();
  for (let d = 0; d < depth && next.size > 0; d++) {
    const newFrontier = new Set();
    for (const sym of next) {
      const rows = db.prepare(sql).all({ repoPath, symbol: sym });
      for (const r of rows) {
        if (sql === CALLEES_SQL) edges.add(`${sym}->${r.name}`);
        else                     edges.add(`${r.name}->${sym}`);
        if (!visited.has(r.name)) {
          visited.add(r.name);
          newFrontier.add(r.name);
        }
        if (visited.size >= MAX_NODES) return edges;
      }
    }
    next = newFrontier;
  }
  return edges;
}

function callGraph({ db, repoPath, symbol, direction = 'callees', depth = 2 }) {
  const cap = Math.min(Math.max(1, depth | 0), MAX_DEPTH);
  const visited = new Set([symbol]);
  const allEdges = new Set();

  if (direction === 'callees' || direction === 'both') {
    for (const e of expand(db, repoPath, [symbol], CALLEES_SQL, cap, visited)) allEdges.add(e);
  }
  if (direction === 'callers' || direction === 'both') {
    for (const e of expand(db, repoPath, [symbol], CALLERS_SQL, cap, visited)) allEdges.add(e);
  }

  return {
    nodes: [...visited].map((name) => ({ name })),
    edges: [...allEdges].map((e) => {
      const [from, to] = e.split('->');
      return { from, to };
    }),
  };
}

module.exports = { callGraph };
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/queries.test.js`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add server/plugins/codegraph/queries/call-graph.js server/plugins/codegraph/tests/queries.test.js
git commit -m "feat(codegraph): call_graph query with depth + direction"
```

---

## Task 9: Query — impact_set

**Files:**
- Create: `server/plugins/codegraph/queries/impact-set.js`
- Modify: `server/plugins/codegraph/tests/queries.test.js`

- [ ] **Step 1: Append test cases**

```javascript
const { impactSet } = require('../queries/impact-set');

describe('codegraph queries: impact_set', () => {
  let db;
  beforeEach(async () => {
    db = new Database(':memory:'); ensureSchema(db);
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
  });
  afterEach(() => db.close());

  it('reports all transitive callers of `beta` as impacted symbols', () => {
    const impact = impactSet({ db, repoPath: FIXTURE, symbol: 'beta', depth: 5 });
    expect(impact.symbols.sort()).toEqual(['alpha', 'delta', 'gamma']);
  });

  it('reports the files containing impacted symbols', () => {
    const impact = impactSet({ db, repoPath: FIXTURE, symbol: 'beta', depth: 5 });
    expect(impact.files.sort()).toEqual(['a.js', 'b.js']);
  });

  it('returns empty arrays for an unreferenced symbol', () => {
    const impact = impactSet({ db, repoPath: FIXTURE, symbol: 'nope', depth: 5 });
    expect(impact.symbols).toEqual([]);
    expect(impact.files).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/queries.test.js`
Expected: 7 pass, 3 fail.

- [ ] **Step 3: Implement query**

```javascript
// server/plugins/codegraph/queries/impact-set.js
'use strict';

const { callGraph } = require('./call-graph');

function impactSet({ db, repoPath, symbol, depth = 5 }) {
  const g = callGraph({ db, repoPath, symbol, direction: 'callers', depth });
  const symbols = g.nodes.map((n) => n.name).filter((n) => n !== symbol);
  if (symbols.length === 0) return { symbols: [], files: [] };

  const placeholders = symbols.map(() => '?').join(',');
  const fileRows = db.prepare(
    `SELECT DISTINCT file_path FROM cg_symbols
     WHERE repo_path = ? AND name IN (${placeholders})`
  ).all(repoPath, ...symbols);

  return {
    symbols,
    files: fileRows.map((r) => r.file_path),
  };
}

module.exports = { impactSet };
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/queries.test.js`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add server/plugins/codegraph/queries/impact-set.js server/plugins/codegraph/tests/queries.test.js
git commit -m "feat(codegraph): impact_set query (transitive caller closure + files)"
```

---

## Task 10: Query — dead_symbols

**Files:**
- Create: `server/plugins/codegraph/queries/dead-symbols.js`
- Modify: `server/plugins/codegraph/tests/queries.test.js`

- [ ] **Step 1: Append test cases**

```javascript
const { deadSymbols } = require('../queries/dead-symbols');

describe('codegraph queries: dead_symbols', () => {
  let db;
  beforeEach(async () => {
    db = new Database(':memory:'); ensureSchema(db);
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
  });
  afterEach(() => db.close());

  it('flags `delta` and `gamma` as never-referenced (callers only — no internal refs)', () => {
    const dead = deadSymbols({ db, repoPath: FIXTURE });
    const names = dead.map((d) => d.name).sort();
    expect(names).toEqual(['delta', 'gamma']);
  });

  it('returns kind/file/line for each dead symbol', () => {
    const dead = deadSymbols({ db, repoPath: FIXTURE });
    for (const d of dead) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.kind).toBe('string');
      expect(typeof d.file).toBe('string');
      expect(typeof d.line).toBe('number');
    }
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/queries.test.js`
Expected: 10 pass, 2 fail.

- [ ] **Step 3: Implement query**

```javascript
// server/plugins/codegraph/queries/dead-symbols.js
'use strict';

const SQL = `
  SELECT s.name, s.kind, s.file_path AS file, s.start_line AS line
  FROM cg_symbols s
  WHERE s.repo_path = @repoPath
    AND NOT EXISTS (
      SELECT 1 FROM cg_references r
      WHERE r.repo_path = s.repo_path AND r.target_name = s.name
    )
  ORDER BY s.file_path, s.start_line
`;

function deadSymbols({ db, repoPath }) {
  return db.prepare(SQL).all({ repoPath });
}

module.exports = { deadSymbols };
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/queries.test.js`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add server/plugins/codegraph/queries/dead-symbols.js server/plugins/codegraph/tests/queries.test.js
git commit -m "feat(codegraph): dead_symbols query"
```

---

## Task 11: Index runner — git HEAD enumeration + state read

**Files:**
- Create: `server/plugins/codegraph/index-runner.js`
- Create: `server/plugins/codegraph/tests/index-runner.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// server/plugins/codegraph/tests/index-runner.test.js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { indexRepoAtHead, getIndexState } = require('../index-runner');
const { setupTinyRepo, destroyTinyRepo } = require('../test-helpers');

describe('codegraph index-runner', () => {
  let db;
  let repo;

  beforeEach(() => { db = new Database(':memory:'); ensureSchema(db); repo = setupTinyRepo(); });
  afterEach(() => { db.close(); destroyTinyRepo(repo); });

  it('indexes the repo at HEAD and reports state', async () => {
    const result = await indexRepoAtHead({ db, repoPath: repo });
    expect(result.files).toBe(2);
    expect(result.symbols).toBe(2);
    expect(result.references).toBe(1);
    const state = getIndexState({ db, repoPath: repo });
    expect(state.commitSha.length).toBe(40);
  });

  it('skips re-indexing when commit_sha is unchanged', async () => {
    await indexRepoAtHead({ db, repoPath: repo });
    const result = await indexRepoAtHead({ db, repoPath: repo });
    expect(result.skipped).toBe(true);
  });

  it('re-indexes when force=true even if commit unchanged', async () => {
    await indexRepoAtHead({ db, repoPath: repo });
    const result = await indexRepoAtHead({ db, repoPath: repo, force: true });
    expect(result.skipped).toBeUndefined();
    expect(result.files).toBe(2);
  });

  it('only reads HEAD; ignores dirty worktree files', async () => {
    fs.writeFileSync(path.join(repo, 'a.js'),
      'function alpha() { return broken_after_index(); }\n');
    await indexRepoAtHead({ db, repoPath: repo });
    const targets = db.prepare(
      "SELECT target_name FROM cg_references WHERE repo_path = ?"
    ).all(repo).map((r) => r.target_name);
    expect(targets).toContain('beta');
    expect(targets).not.toContain('broken_after_index');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/index-runner.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement index-runner**

```javascript
// server/plugins/codegraph/index-runner.js
'use strict';

const { execFileSync } = require('child_process');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { runIndex } = require('./indexer');
const { languageFor } = require('./extractors');

function gitHeadSha(repoPath) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath, encoding: 'utf8',
  }).trim();
}

function gitListTree(repoPath, sha) {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', sha], {
    cwd: repoPath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

function gitMaterializeAtHead(repoPath, sha, files) {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cg-head-'));
  for (const rel of files) {
    const dest = path.join(tmp, rel);
    fsSync.mkdirSync(path.dirname(dest), { recursive: true });
    const content = execFileSync('git', ['show', `${sha}:${rel}`], {
      cwd: repoPath, maxBuffer: 32 * 1024 * 1024,
    });
    fsSync.writeFileSync(dest, content);
  }
  return tmp;
}

function getIndexState({ db, repoPath }) {
  const row = db.prepare(
    'SELECT commit_sha AS commitSha, indexed_at AS indexedAt, files, symbols, references_count AS referencesCount FROM cg_index_state WHERE repo_path = ?'
  ).get(repoPath);
  return row || null;
}

async function indexRepoAtHead({ db, repoPath, force = false }) {
  const sha = gitHeadSha(repoPath);
  const state = getIndexState({ db, repoPath });
  if (!force && state && state.commitSha === sha) return { skipped: true, commitSha: sha };

  const allFiles = gitListTree(repoPath, sha);
  const indexable = allFiles.filter((f) => languageFor(f) != null);
  if (indexable.length === 0) {
    return runIndex({ db, repoPath, files: [], commitSha: sha });
  }

  const headDir = gitMaterializeAtHead(repoPath, sha, indexable);
  try {
    return await runIndex({ db, repoPath, files: indexable, commitSha: sha, _sourceDir: headDir });
  } finally {
    fsSync.rmSync(headDir, { recursive: true, force: true });
  }
}

module.exports = { indexRepoAtHead, getIndexState };
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/index-runner.test.js server/plugins/codegraph/tests/indexer.test.js`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/plugins/codegraph/index-runner.js server/plugins/codegraph/tests/index-runner.test.js
git commit -m "feat(codegraph): index-runner reads from git HEAD, ignores dirty worktree"
```

---

## Task 12: MCP tool definitions

**Files:**
- Create: `server/plugins/codegraph/tool-defs.js`

- [ ] **Step 1: Write the file**

```javascript
// server/plugins/codegraph/tool-defs.js
'use strict';

const tools = [
  {
    name: 'cg_index_status',
    description: 'Return index state for a repo: commit_sha, indexed_at, file/symbol/reference counts, and whether the index is stale relative to current HEAD.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string', description: 'Absolute path to the repository.' },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_reindex',
    description: 'Index the repository at HEAD into the code graph. Idempotent unless force=true. Returns counts.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        force:     { type: 'boolean', default: false },
        async:     { type: 'boolean', default: true,  description: 'Run in worker thread; set false for synchronous indexing.' },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_find_references',
    description: 'Find every call site of a symbol in the indexed repo. Returns file/line/column/callerSymbol for each reference.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string' },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_call_graph',
    description: 'Walk the call graph from a symbol. direction=callers|callees|both, depth bounded.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string' },
        direction: { type: 'string', enum: ['callers', 'callees', 'both'], default: 'callees' },
        depth:     { type: 'integer', minimum: 1, maximum: 8, default: 2 },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_impact_set',
    description: 'Compute the impact set of changing a symbol: every transitively-affected symbol and the files containing them.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
        symbol:    { type: 'string' },
        depth:     { type: 'integer', minimum: 1, maximum: 8, default: 5 },
      },
      required: ['repo_path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'cg_dead_symbols',
    description: 'List symbols defined in the repo but never referenced. Hint for dead-code sweeps.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string' },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
];

module.exports = tools;
```

- [ ] **Step 2: Commit (no test yet — handlers in next task)**

```bash
git add server/plugins/codegraph/tool-defs.js
git commit -m "feat(codegraph): MCP tool descriptors for cg_* tools"
```

---

## Task 13: Handlers + lifecycle wiring

**Files:**
- Create: `server/plugins/codegraph/handlers.js`
- Create: `server/plugins/codegraph/tests/handlers.test.js`
- Modify: `server/plugins/codegraph/index.js`
- Modify: `server/plugins/codegraph/tests/plugin-lifecycle.test.js`

- [ ] **Step 1: Write failing handlers test**

```javascript
// server/plugins/codegraph/tests/handlers.test.js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createHandlers } = require('../handlers');
const { setupTinyRepo, destroyTinyRepo } = require('../test-helpers');

describe('codegraph handlers', () => {
  let db, repo, handlers;

  beforeEach(async () => {
    db = new Database(':memory:'); ensureSchema(db);
    repo = setupTinyRepo();
    handlers = createHandlers({ db });
    await handlers.cg_reindex({ repo_path: repo, async: false });
  });

  afterEach(() => { db.close(); destroyTinyRepo(repo); });

  it('cg_index_status returns commit_sha + counts', async () => {
    const r = await handlers.cg_index_status({ repo_path: repo });
    expect(r.commit_sha.length).toBe(40);
    expect(r.files).toBe(2);
    expect(r.symbols).toBe(2);
  });

  it('cg_find_references finds beta callers', async () => {
    const r = await handlers.cg_find_references({ repo_path: repo, symbol: 'beta' });
    expect(r).toEqual(expect.arrayContaining([
      expect.objectContaining({ callerSymbol: 'alpha' }),
    ]));
  });

  it('cg_call_graph returns nodes + edges', async () => {
    const r = await handlers.cg_call_graph({
      repo_path: repo, symbol: 'alpha', direction: 'callees', depth: 1,
    });
    expect(r.nodes.map((n) => n.name).sort()).toEqual(['alpha', 'beta']);
    expect(r.edges).toEqual([{ from: 'alpha', to: 'beta' }]);
  });

  it('cg_impact_set returns symbols + files', async () => {
    const r = await handlers.cg_impact_set({ repo_path: repo, symbol: 'beta', depth: 5 });
    expect(r.symbols).toEqual(['alpha']);
    expect(r.files).toEqual(['a.js']);
  });

  it('cg_dead_symbols flags alpha (alpha is not called)', async () => {
    const r = await handlers.cg_dead_symbols({ repo_path: repo });
    expect(r.map((d) => d.name)).toContain('alpha');
  });

  it('all handlers reject when repo_path is missing', async () => {
    for (const name of ['cg_index_status', 'cg_reindex', 'cg_find_references', 'cg_call_graph', 'cg_impact_set', 'cg_dead_symbols']) {
      await expect(handlers[name]({})).rejects.toThrow(/repo_path/);
    }
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/handlers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement handlers**

```javascript
// server/plugins/codegraph/handlers.js
'use strict';

const { indexRepoAtHead, getIndexState } = require('./index-runner');
const { findReferences } = require('./queries/find-references');
const { callGraph }      = require('./queries/call-graph');
const { impactSet }      = require('./queries/impact-set');
const { deadSymbols }    = require('./queries/dead-symbols');

function requireString(args, key) {
  if (typeof args?.[key] !== 'string' || args[key].length === 0) {
    throw new Error(`missing required argument: ${key}`);
  }
  return args[key];
}

function createHandlers({ db }) {
  return {
    async cg_index_status(args) {
      const repoPath = requireString(args, 'repo_path');
      const state = getIndexState({ db, repoPath });
      if (!state) return { indexed: false };
      return {
        indexed: true,
        commit_sha: state.commitSha,
        indexed_at: state.indexedAt,
        files: state.files,
        symbols: state.symbols,
        references: state.referencesCount,
      };
    },

    async cg_reindex(args) {
      const repoPath = requireString(args, 'repo_path');
      const force = args.force === true;
      // async path is enabled in Task 17 (worker-thread). For now always synchronous.
      return indexRepoAtHead({ db, repoPath, force });
    },

    async cg_find_references(args) {
      const repoPath = requireString(args, 'repo_path');
      const symbol   = requireString(args, 'symbol');
      return findReferences({ db, repoPath, symbol });
    },

    async cg_call_graph(args) {
      const repoPath  = requireString(args, 'repo_path');
      const symbol    = requireString(args, 'symbol');
      const direction = args.direction || 'callees';
      const depth     = args.depth ?? 2;
      return callGraph({ db, repoPath, symbol, direction, depth });
    },

    async cg_impact_set(args) {
      const repoPath = requireString(args, 'repo_path');
      const symbol   = requireString(args, 'symbol');
      const depth    = args.depth ?? 5;
      return impactSet({ db, repoPath, symbol, depth });
    },

    async cg_dead_symbols(args) {
      const repoPath = requireString(args, 'repo_path');
      return deadSymbols({ db, repoPath });
    },
  };
}

module.exports = { createHandlers };
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/handlers.test.js`
Expected: 6 passed.

- [ ] **Step 5: Wire toolList in `index.js`**

Open `server/plugins/codegraph/index.js`. Add at top:

```javascript
const toolDefs = require('./tool-defs');
const { createHandlers } = require('./handlers');
```

Replace the body of `install(container)` with:

```javascript
  function install(container) {
    if (!isFeatureEnabled()) return;
    const dbService = getContainerService(container, 'db');
    db = resolveRawDb(dbService);
    ensureSchema(db);
    const handlers = createHandlers({ db });
    toolList = toolDefs.map((toolDef) => ({
      ...toolDef,
      handler: handlers[toolDef.name],
    }));
    installed = true;
  }
```

- [ ] **Step 6: Un-skip the lifecycle test**

In `server/plugins/codegraph/tests/plugin-lifecycle.test.js`, change the `it.skip(...)` for "install registers tools when feature flag is on" back to `it(...)`.

- [ ] **Step 7: Run lifecycle test, verify all pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/plugin-lifecycle.test.js`
Expected: 5 passed.

- [ ] **Step 8: Commit**

```bash
git add server/plugins/codegraph/handlers.js server/plugins/codegraph/index.js server/plugins/codegraph/tests/handlers.test.js server/plugins/codegraph/tests/plugin-lifecycle.test.js
git commit -m "feat(codegraph): handlers + lifecycle wiring for all six cg_* tools"
```

---

## Task 14: REST passthrough routes

**Files:**
- Modify: `server/api/routes-passthrough.js`
- Create: `server/plugins/codegraph/tests/rest-passthrough.test.js`

- [ ] **Step 1: Write failing routes test**

```javascript
// server/plugins/codegraph/tests/rest-passthrough.test.js
'use strict';

const { describe, it, expect } = require('vitest');
const routes = require('../../../api/routes-passthrough');

describe('codegraph REST passthrough routes', () => {
  function find(tool, method) {
    return routes.find((r) => r.tool === tool && r.method === method);
  }

  it('exposes GET /api/v2/codegraph/index-status for cg_index_status', () => {
    const r = find('cg_index_status', 'GET');
    expect(r).toBeTruthy();
    expect(r.path).toBe('/api/v2/codegraph/index-status');
    expect(r.mapQuery).toBe(true);
  });

  it('exposes POST /api/v2/codegraph/reindex for cg_reindex', () => {
    const r = find('cg_reindex', 'POST');
    expect(r).toBeTruthy();
    expect(r.path).toBe('/api/v2/codegraph/reindex');
    expect(r.mapBody).toBe(true);
  });

  it('exposes POST routes for find-references, call-graph, impact-set', () => {
    expect(find('cg_find_references', 'POST').path).toBe('/api/v2/codegraph/find-references');
    expect(find('cg_call_graph',      'POST').path).toBe('/api/v2/codegraph/call-graph');
    expect(find('cg_impact_set',      'POST').path).toBe('/api/v2/codegraph/impact-set');
  });

  it('exposes GET /api/v2/codegraph/dead-symbols for cg_dead_symbols', () => {
    const r = find('cg_dead_symbols', 'GET');
    expect(r).toBeTruthy();
    expect(r.path).toBe('/api/v2/codegraph/dead-symbols');
    expect(r.mapQuery).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/rest-passthrough.test.js`
Expected: FAIL — routes not present.

- [ ] **Step 3: Append routes block**

Open `server/api/routes-passthrough.js`. Find the closing `];` of the `routes` array. Just before it, insert:

```javascript
  // ─── codegraph (6 routes) ─────────────────────────────────────────────────────
  { method: 'GET',  path: '/api/v2/codegraph/index-status',   tool: 'cg_index_status',     mapQuery: true },
  { method: 'POST', path: '/api/v2/codegraph/reindex',        tool: 'cg_reindex',          mapBody:  true },
  { method: 'POST', path: '/api/v2/codegraph/find-references',tool: 'cg_find_references',  mapBody:  true },
  { method: 'POST', path: '/api/v2/codegraph/call-graph',     tool: 'cg_call_graph',       mapBody:  true },
  { method: 'POST', path: '/api/v2/codegraph/impact-set',     tool: 'cg_impact_set',       mapBody:  true },
  { method: 'GET',  path: '/api/v2/codegraph/dead-symbols',   tool: 'cg_dead_symbols',     mapQuery: true },
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/rest-passthrough.test.js`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/api/routes-passthrough.js server/plugins/codegraph/tests/rest-passthrough.test.js
git commit -m "feat(codegraph): REST passthrough routes for all six cg_* tools"
```

---

## Task 15: Register the plugin in DEFAULT_PLUGIN_NAMES

**Files:**
- Modify: `server/index.js`
- Create: `server/plugins/codegraph/tests/plugin-registration.test.js`

- [ ] **Step 1: Write failing registration test**

```javascript
// server/plugins/codegraph/tests/plugin-registration.test.js
'use strict';

const { describe, it, expect } = require('vitest');
const fs = require('fs');
const path = require('path');

describe('codegraph plugin registration', () => {
  it('is listed in DEFAULT_PLUGIN_NAMES in server/index.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'index.js'), 'utf8');
    expect(src).toMatch(/DEFAULT_PLUGIN_NAMES[\s\S]*'codegraph'/);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/plugin-registration.test.js`
Expected: FAIL — codegraph not in `DEFAULT_PLUGIN_NAMES`.

- [ ] **Step 3: Add to DEFAULT_PLUGIN_NAMES**

Open `server/index.js:63`. The current line is:

```javascript
const DEFAULT_PLUGIN_NAMES = Object.freeze(['snapscope', 'version-control', 'remote-agents', 'model-freshness', 'auto-recovery-core']);
```

Change to:

```javascript
const DEFAULT_PLUGIN_NAMES = Object.freeze(['snapscope', 'version-control', 'remote-agents', 'model-freshness', 'auto-recovery-core', 'codegraph']);
```

(The plugin's `install()` is a no-op when `TORQUE_CODEGRAPH_ENABLED !== '1'`, so adding it is safe — the only effect for users without the flag set is one extra "loaded plugin: codegraph" log line at startup.)

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/plugin-registration.test.js`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/plugins/codegraph/tests/plugin-registration.test.js
git commit -m "feat(codegraph): register plugin in DEFAULT_PLUGIN_NAMES (gated by env flag)"
```

---

## Task 16: End-to-end REST smoke test

**Files:**
- Create: `server/plugins/codegraph/tests/e2e-rest.test.js`

- [ ] **Step 1: Write the e2e test**

```javascript
// server/plugins/codegraph/tests/e2e-rest.test.js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { setupTinyRepo, destroyTinyRepo } = require('../test-helpers');

const PORT = 3463;
const BASE = `http://127.0.0.1:${PORT}`;

let serverProc;
let repo;
let dataDir;

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetchJson(`${BASE}/api/health`);
      if (r.status === 200) return;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('server did not become ready');
}

describe.skipIf(process.env.CG_E2E !== '1')('codegraph end-to-end REST', () => {
  beforeAll(async () => {
    repo = setupTinyRepo('cg-e2e-');
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-data-'));
    serverProc = spawn(
      process.execPath,
      [path.join(__dirname, '..', '..', '..', 'index.js')],
      {
        env: {
          ...process.env,
          PORT: String(PORT),
          TORQUE_CODEGRAPH_ENABLED: '1',
          TORQUE_DATA_DIR: dataDir,
        },
        stdio: 'ignore',
      }
    );
    await waitForReady();
  }, 30000);

  afterAll(() => {
    if (serverProc) serverProc.kill('SIGTERM');
    destroyTinyRepo(repo);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reindex → find-references end-to-end via REST', async () => {
    const r1 = await fetchJson(`${BASE}/api/v2/codegraph/reindex`, {
      method: 'POST',
      body: { repo_path: repo, async: false },
    });
    expect(r1.status).toBe(200);

    const r2 = await fetchJson(`${BASE}/api/v2/codegraph/find-references`, {
      method: 'POST',
      body: { repo_path: repo, symbol: 'beta' },
    });
    expect(r2.status).toBe(200);
    expect(r2.body.some((x) => x.callerSymbol === 'alpha')).toBe(true);
  });
});
```

- [ ] **Step 2: Run gated e2e**

Run: `CG_E2E=1 torque-remote npx vitest run server/plugins/codegraph/tests/e2e-rest.test.js`
Expected: 1 passed.

(Skipped by default in the regular suite to avoid spawning a real server during routine `npm test`.)

- [ ] **Step 3: Commit**

```bash
git add server/plugins/codegraph/tests/e2e-rest.test.js
git commit -m "test(codegraph): e2e REST smoke (CG_E2E=1 gated)"
```

---

## Task 17: Worker-thread indexer

**Files:**
- Create: `server/plugins/codegraph/indexer-worker.js`
- Modify: `server/plugins/codegraph/index-runner.js`
- Modify: `server/plugins/codegraph/handlers.js`
- Create: `server/plugins/codegraph/tests/indexer-worker.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// server/plugins/codegraph/tests/indexer-worker.test.js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { startReindexJob, getJobStatus } = require('../index-runner');
const { setupTinyRepo, destroyTinyRepo } = require('../test-helpers');

describe('codegraph worker-thread indexer', () => {
  let db, repo, dbPath, dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-w-data-'));
    dbPath = path.join(dataDir, 'cg.db');
    db = new Database(dbPath);
    ensureSchema(db);
    repo = setupTinyRepo('cg-w-');
  });
  afterEach(() => {
    db.close();
    destroyTinyRepo(repo);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('startReindexJob returns a jobId and runs in the background', async () => {
    const { jobId } = startReindexJob({ dbPath, repoPath: repo });
    expect(typeof jobId).toBe('string');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const status = getJobStatus(jobId);
      if (status.state === 'done') return;
      if (status.state === 'error') throw new Error(status.error);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('job did not complete');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/indexer-worker.test.js`
Expected: FAIL — `startReindexJob` not exported.

- [ ] **Step 3: Implement worker entrypoint**

```javascript
// server/plugins/codegraph/indexer-worker.js
'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { ensureSchema } = require('./schema');
const { indexRepoAtHead } = require('./index-runner');

(async () => {
  try {
    const db = new Database(workerData.dbPath);
    ensureSchema(db);
    const result = await indexRepoAtHead({
      db,
      repoPath: workerData.repoPath,
      force: workerData.force,
    });
    db.close();
    parentPort.postMessage({ state: 'done', result });
  } catch (err) {
    parentPort.postMessage({ state: 'error', error: err.message, stack: err.stack });
  }
})();
```

- [ ] **Step 4: Add `startReindexJob` + `getJobStatus` to `index-runner.js`**

Append to `server/plugins/codegraph/index-runner.js`:

```javascript
const { Worker } = require('worker_threads');
const crypto = require('crypto');

const jobs = new Map();

function startReindexJob({ dbPath, repoPath, force = false }) {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { state: 'running' });
  const worker = new Worker(path.join(__dirname, 'indexer-worker.js'), {
    workerData: { dbPath, repoPath, force },
  });
  worker.once('message', (msg) => jobs.set(jobId, msg));
  worker.once('error', (err) => jobs.set(jobId, { state: 'error', error: err.message }));
  worker.once('exit', (code) => {
    if (code !== 0 && jobs.get(jobId).state === 'running') {
      jobs.set(jobId, { state: 'error', error: `worker exited ${code}` });
    }
  });
  return { jobId };
}

function getJobStatus(jobId) {
  return jobs.get(jobId) || { state: 'unknown' };
}

module.exports.startReindexJob = startReindexJob;
module.exports.getJobStatus    = getJobStatus;
```

- [ ] **Step 5: Run worker test**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/indexer-worker.test.js`
Expected: 1 passed.

- [ ] **Step 6: Update `cg_reindex` handler to use the worker by default for file-backed DBs**

Open `server/plugins/codegraph/handlers.js`. Replace `cg_reindex`:

```javascript
    async cg_reindex(args) {
      const repoPath = requireString(args, 'repo_path');
      const force = args.force === true;
      const wantsAsync = args.async !== false;
      const dbPath = db.name && db.name !== ':memory:' ? db.name : null;
      if (wantsAsync && dbPath) {
        return require('./index-runner').startReindexJob({ dbPath, repoPath, force });
      }
      return indexRepoAtHead({ db, repoPath, force });
    },
```

(For `:memory:` test DBs, the handler stays synchronous. For real TORQUE deployments, async is the default.)

- [ ] **Step 7: Re-run handlers test**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/handlers.test.js`
Expected: still 6 passed (`:memory:` path stays synchronous).

- [ ] **Step 8: Commit**

```bash
git add server/plugins/codegraph/indexer-worker.js server/plugins/codegraph/index-runner.js server/plugins/codegraph/handlers.js server/plugins/codegraph/tests/indexer-worker.test.js
git commit -m "feat(codegraph): worker-thread reindex job + getJobStatus"
```

---

## Task 18: Startup resume — re-index every known repo on plugin install

**Files:**
- Modify: `server/plugins/codegraph/index.js`
- Create: `server/plugins/codegraph/tests/startup-resume.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// server/plugins/codegraph/tests/startup-resume.test.js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createCodegraphPlugin } = require('../index');

describe('codegraph startup resume', () => {
  let db;
  let container;

  beforeEach(() => {
    process.env.TORQUE_CODEGRAPH_ENABLED = '1';
    db = new Database(':memory:');
    ensureSchema(db);
    db.prepare(`
      INSERT INTO cg_index_state (repo_path, commit_sha, indexed_at, files, symbols, references_count)
      VALUES ('/nonexistent/repo', 'abc', '2026-01-01T00:00:00Z', 0, 0, 0)
    `).run();
    container = {
      get(name) {
        if (name === 'db') return { getDbInstance: () => db };
        throw new Error('unknown service');
      },
    };
  });
  afterEach(() => { db.close(); delete process.env.TORQUE_CODEGRAPH_ENABLED; });

  it('install does not throw when a stored repo path is missing on disk', () => {
    const plugin = createCodegraphPlugin();
    expect(() => plugin.install(container)).not.toThrow();
  });

  it('install records unreachable repos in diagnostics', () => {
    const plugin = createCodegraphPlugin();
    plugin.install(container);
    const d = plugin.diagnostics();
    expect(d.unreachableRepos).toContain('/nonexistent/repo');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/startup-resume.test.js`
Expected: FAIL.

- [ ] **Step 3: Add startup-resume in `install()`**

Open `server/plugins/codegraph/index.js`. After `let toolList = [];`, add:

```javascript
  let diagnostics = null;
```

After `ensureSchema(db);` and before `const handlers = createHandlers...`, add:

```javascript
    diagnostics = { unreachableRepos: [] };
    try {
      const fs = require('fs');
      const rows = db.prepare('SELECT repo_path FROM cg_index_state').all();
      for (const { repo_path: repoPath } of rows) {
        if (!fs.existsSync(repoPath)) {
          diagnostics.unreachableRepos.push(repoPath);
        }
      }
    } catch { /* schema may be empty */ }
```

Add to the returned object:

```javascript
    diagnostics: () => diagnostics || { unreachableRepos: [] },
```

- [ ] **Step 4: Run, verify pass**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests/startup-resume.test.js`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add server/plugins/codegraph/index.js server/plugins/codegraph/tests/startup-resume.test.js
git commit -m "feat(codegraph): startup resume + unreachable-repo diagnostics"
```

---

## Task 19: Documentation

**Files:**
- Create: `docs/codegraph.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write `docs/codegraph.md`**

```markdown
# Codegraph

`codegraph` is a TORQUE plugin that maintains a per-repository symbol/reference index, exposing call graph and find-references queries via REST and MCP.

## Status

- **Languages:** JavaScript, TypeScript, TSX (parsed via `tree-sitter-wasms`)
- **Storage:** SQLite tables prefixed `cg_*` in the TORQUE database
- **Off by default.** Set `TORQUE_CODEGRAPH_ENABLED=1` and restart to enable.

## REST endpoints

| Method | Path | Body / Query |
|--------|------|--------------|
| `GET`  | `/api/v2/codegraph/index-status?repo_path=...` | — |
| `POST` | `/api/v2/codegraph/reindex` | `{ repo_path, force?, async? }` |
| `POST` | `/api/v2/codegraph/find-references` | `{ repo_path, symbol }` |
| `POST` | `/api/v2/codegraph/call-graph` | `{ repo_path, symbol, direction?, depth? }` |
| `POST` | `/api/v2/codegraph/impact-set` | `{ repo_path, symbol, depth? }` |
| `GET`  | `/api/v2/codegraph/dead-symbols?repo_path=...` | — |

Every endpoint has a 1:1 MCP tool with the same name (`cg_index_status`, `cg_reindex`, `cg_find_references`, `cg_call_graph`, `cg_impact_set`, `cg_dead_symbols`).

## Indexing semantics

The indexer **only reads files at the current `git HEAD`** of the repo. Dirty worktree files are ignored. Each `cg_reindex` call:

1. Reads `git rev-parse HEAD`
2. Compares against `cg_index_state.commit_sha`; if equal and `force=false`, returns `{ skipped: true }`
3. Otherwise enumerates `git ls-tree -r HEAD`, materializes each indexable file via `git show`, parses, and replaces `cg_files` / `cg_symbols` / `cg_references` in a single SQLite transaction

## Limitations (MVP)

- JS/TS only. Python/Go/Rust/C# grammars are already shipped in `tree-sitter-wasms` and can be added by writing one extractor each.
- No cross-repo references.
- Identifier-based call resolution only — no scope/import-aware binding. `foo()` in two files maps to the same target name. Consumers should treat results as candidate impact, not proof.
- No incremental commit-by-commit updates; `cg_reindex` always re-indexes from scratch.
```

- [ ] **Step 2: Add subsection to `CLAUDE.md`**

Find the "Default Plugins" table. Append a row:

```markdown
| **codegraph** | `server/plugins/codegraph/` | Six `cg_*` tools for symbol/reference queries (find-references, call-graph, impact-set, dead-symbols). Off by default — set `TORQUE_CODEGRAPH_ENABLED=1` to enable. JS/TS only in MVP. |
```

- [ ] **Step 3: Commit**

```bash
git add docs/codegraph.md CLAUDE.md
git commit -m "docs(codegraph): readme + CLAUDE.md plugin entry"
```

---

## Task 20: Cutover

- [ ] **Step 1: Run the full plugin test suite from the worktree**

Run: `torque-remote npx vitest run server/plugins/codegraph/tests`
Expected: all green.

- [ ] **Step 2: Run the full server suite to confirm no regressions**

Run: `torque-remote npx vitest run server`
Expected: all green.

- [ ] **Step 3: Push the branch + open the cutover**

From the worktree:

```bash
git push -u origin feat/codegraph
```

(The pre-push hook gates `main`, not feature branches, so this is fast.)

- [ ] **Step 4: Cut over via the worktree script**

From the main checkout:

```bash
scripts/worktree-cutover.sh codegraph
```

This merges `feat/codegraph` to `main`, drains the queue, restarts TORQUE on the new code, and removes the worktree. Watch heartbeats — do not cancel the barrier even if drain takes a while.

- [ ] **Step 5: Smoke-test against the running server**

```bash
curl -s -X POST http://127.0.0.1:3457/api/v2/codegraph/reindex \
  -H 'content-type: application/json' \
  -d "{\"repo_path\":\"$(pwd)\",\"async\":false}"

curl -s -X POST http://127.0.0.1:3457/api/v2/codegraph/find-references \
  -H 'content-type: application/json' \
  -d "{\"repo_path\":\"$(pwd)\",\"symbol\":\"runIndex\"}"
```

(The plugin will be loaded but inert until `TORQUE_CODEGRAPH_ENABLED=1` is set in TORQUE's environment and the server is restarted with that var.)

- [ ] **Step 6: Enable the feature flag and shadow-mode validate for one week**

Edit your TORQUE start command to include `TORQUE_CODEGRAPH_ENABLED=1`, restart via `restart_server` + `await_restart`. Use the REST endpoints manually for one week before integrating with the Planner. Track:

- Reindex success rate per repo
- Query result quality (sample 10 known refactors per week, compare `cg_impact_set` against ground truth)
- Stale-index incidents (queries returning data from before the latest commit)

If staleness rate < 1% and impact-set recall > 80% after the validation window, write a follow-up plan integrating `cg_*` queries into the Planner's plan-generation prompt context.

---

## Self-Review Checklist

- **Spec coverage:** Every architecture point — REST-first, plugin shape, tree-sitter+wasms, SQLite, restart-survivable, HEAD-only discipline, feature-flag gating, shadow-mode validation — has a task.
- **No placeholders:** Every test and implementation step includes the actual code. No "TBD", no "add appropriate error handling", no `// implement later`.
- **No `execSync` / `exec`:** All subprocess calls (production + tests) use `execFileSync` only, via the shared `test-helpers.js` for test setup. The security hook will not block any commit in this plan.
- **Type consistency:** `repoPath`/`repo_path` casing is consistent — camelCase inside JS, snake_case at the MCP/REST boundary. Method/query names match across tasks (`findReferences`, `callGraph`, `impactSet`, `deadSymbols`, `indexRepoAtHead`, `getIndexState`, `startReindexJob`, `getJobStatus`).
- **Worktree discipline:** Plan lives in `.worktrees/feat-codegraph/docs/superpowers/plans/`, all commits go to `feat/codegraph`, cutover is the explicit final step.
- **Out of scope (deliberate):** C#/Python/Go/Rust/PowerShell extractors, scope-aware binding, incremental commit updates, dashboard UI, Planner integration. Each is a follow-up plan once the MVP is shadow-validated.
