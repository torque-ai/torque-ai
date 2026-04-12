# Fabro #91: Pattern Library (fabric)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `.torque/patterns/` directory of reusable **prompt patterns** — one folder per pattern with `system.md`, `user.md` (template), and `metadata.json`. Expose through a pipe-friendly CLI (`torque fabric -p extract_wisdom < input.txt > output.md`), MCP tool, and chainable composition. Complementary to Plan 37 rules (applied implicitly) and Plan 61 functions (typed outputs). Inspired by Daniel Miessler's fabric.

**Architecture:** A new `server/patterns/` module scans `.torque/patterns/*/` on startup and on file change. Each pattern has:
- `system.md` — main instructions
- `user.md` — optional template with `{{input}}` placeholder
- `metadata.json` — `{ name, description, tags, variables }`

A `runPattern(patternName, input, vars)` entry point renders + runs + returns. The CLI wraps this with stdin/stdout for shell composition.

**Tech Stack:** Node.js, gray-matter, chokidar, existing provider dispatch. Builds on plans 1 (workflow), 37 (rules), 61 (.torquefn), 83 (streaming).

---

## File Structure

**New files:**
- `server/patterns/pattern-loader.js`
- `server/patterns/pattern-runner.js`
- `server/patterns/cli.js` — `torque fabric`
- `server/tests/pattern-loader.test.js`
- `server/tests/pattern-runner.test.js`
- `.torque/patterns/example/system.md` — template

**Modified files:**
- `server/handlers/mcp-tools.js` — `list_patterns`, `run_pattern`, `describe_pattern`

---

## Task 1: Pattern loader

- [ ] **Step 1: Tests**

Create `server/tests/pattern-loader.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadPatternsFromDir } = require('../patterns/pattern-loader');

describe('loadPatternsFromDir', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writePattern(name, files) {
    const patDir = path.join(dir, name);
    fs.mkdirSync(patDir);
    for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(patDir, k), v);
  }

  it('loads a minimal pattern with just system.md', () => {
    writePattern('summarize', { 'system.md': '# Summarize\nGiven text, return 3 bullets.' });
    const patterns = loadPatternsFromDir(dir);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].name).toBe('summarize');
    expect(patterns[0].system).toMatch(/3 bullets/);
  });

  it('loads user.md template', () => {
    writePattern('translate', {
      'system.md': 'You translate text',
      'user.md': 'Translate this: {{input}}',
    });
    const patterns = loadPatternsFromDir(dir);
    expect(patterns[0].user_template).toBe('Translate this: {{input}}');
  });

  it('loads metadata.json with description + tags', () => {
    writePattern('extract_wisdom', {
      'system.md': '...',
      'metadata.json': JSON.stringify({ description: 'Pulls insights', tags: ['summarize', 'wisdom'] }),
    });
    const patterns = loadPatternsFromDir(dir);
    expect(patterns[0].description).toBe('Pulls insights');
    expect(patterns[0].tags).toEqual(['summarize', 'wisdom']);
  });

  it('skips directories without system.md', () => {
    writePattern('broken', { 'user.md': 'no system' });
    expect(loadPatternsFromDir(dir)).toHaveLength(0);
  });

  it('returns empty list when dir does not exist', () => {
    expect(loadPatternsFromDir(path.join(dir, 'nope'))).toEqual([]);
  });

  it('returns patterns sorted by name', () => {
    writePattern('zebra', { 'system.md': 'x' });
    writePattern('apple', { 'system.md': 'y' });
    writePattern('mango', { 'system.md': 'z' });
    const names = loadPatternsFromDir(dir).map(p => p.name);
    expect(names).toEqual(['apple', 'mango', 'zebra']);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/patterns/pattern-loader.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

function loadPatternsFromDir(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const patterns = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const patDir = path.join(dir, entry.name);
    const systemPath = path.join(patDir, 'system.md');
    if (!fs.existsSync(systemPath)) continue;
    const pattern = {
      name: entry.name,
      system: fs.readFileSync(systemPath, 'utf8'),
      user_template: null,
      description: null,
      tags: [],
      variables: [],
      source_dir: patDir,
    };
    const userPath = path.join(patDir, 'user.md');
    if (fs.existsSync(userPath)) pattern.user_template = fs.readFileSync(userPath, 'utf8');
    const metaPath = path.join(patDir, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.description) pattern.description = meta.description;
        if (Array.isArray(meta.tags)) pattern.tags = meta.tags;
        if (Array.isArray(meta.variables)) pattern.variables = meta.variables;
      } catch { /* skip malformed */ }
    }
    patterns.push(pattern);
  }
  return patterns;
}

module.exports = { loadPatternsFromDir };
```

Run tests → PASS. Commit: `feat(patterns): filesystem loader for .torque/patterns/*/`.

---

## Task 2: Pattern runner

- [ ] **Step 1: Tests**

Create `server/tests/pattern-runner.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { runPattern } = require('../patterns/pattern-runner');

describe('runPattern', () => {
  it('calls model with system + rendered user template', async () => {
    const callModel = vi.fn(async () => 'result');
    const pattern = {
      name: 'summarize',
      system: 'You summarize.',
      user_template: 'Summarize: {{input}}',
    };
    const out = await runPattern({ pattern, input: 'long text', callModel });
    expect(out).toBe('result');
    expect(callModel).toHaveBeenCalledWith(expect.objectContaining({
      system: 'You summarize.',
      user: 'Summarize: long text',
    }));
  });

  it('uses raw input as user when no template provided', async () => {
    const callModel = vi.fn(async () => 'x');
    await runPattern({
      pattern: { name: 'p', system: 'x', user_template: null },
      input: 'plain input',
      callModel,
    });
    expect(callModel).toHaveBeenCalledWith(expect.objectContaining({ user: 'plain input' }));
  });

  it('substitutes named vars in template', async () => {
    const callModel = vi.fn(async () => 'x');
    await runPattern({
      pattern: { name: 'p', system: 's', user_template: 'Hello {{name}}, topic={{topic}}' },
      input: 'ignored',
      vars: { name: 'Alice', topic: 'db' },
      callModel,
    });
    const call = callModel.mock.calls[0][0];
    expect(call.user).toBe('Hello Alice, topic=db');
  });

  it('{{input}} takes precedence over vars.input', async () => {
    const callModel = vi.fn(async () => 'x');
    await runPattern({
      pattern: { name: 'p', system: 's', user_template: '{{input}}' },
      input: 'from positional',
      vars: { input: 'from vars' },
      callModel,
    });
    const call = callModel.mock.calls[0][0];
    expect(call.user).toBe('from positional');
  });

  it('missing variable leaves literal placeholder', async () => {
    const callModel = vi.fn(async () => 'x');
    await runPattern({
      pattern: { name: 'p', system: 's', user_template: 'Hello {{missing}}' },
      input: '', callModel,
    });
    const call = callModel.mock.calls[0][0];
    expect(call.user).toBe('Hello {{missing}}');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/patterns/pattern-runner.js`:

```js
'use strict';

function render(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => {
    if (vars[name] === undefined) return m; // keep placeholder literal
    return String(vars[name]);
  });
}

async function runPattern({ pattern, input, vars = {}, callModel }) {
  const mergedVars = { ...vars, input };
  const user = pattern.user_template ? render(pattern.user_template, mergedVars) : (input || '');
  return callModel({ system: pattern.system, user, pattern_name: pattern.name });
}

module.exports = { runPattern, render };
```

Run tests → PASS. Commit: `feat(patterns): runner with {{input}} + named var substitution`.

---

## Task 3: CLI + MCP + watcher

- [ ] **Step 1: CLI**

Create `server/patterns/cli.js`:

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { loadPatternsFromDir } = require('./pattern-loader');
const { runPattern } = require('./pattern-runner');

async function main() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p' || args[i] === '--pattern') opts.pattern = args[++i];
    else if (args[i] === '-l' || args[i] === '--list') opts.list = true;
    else if (args[i] === '-v') { const [k, v] = args[++i].split('='); opts.vars = opts.vars || {}; opts.vars[k] = v; }
    else if (args[i] === '--dir') opts.dir = args[++i];
  }
  const dir = opts.dir || path.join(process.cwd(), '.torque', 'patterns');
  const patterns = loadPatternsFromDir(dir);

  if (opts.list) {
    for (const p of patterns) {
      console.log(`${p.name}${p.description ? ' - ' + p.description : ''}`);
    }
    return;
  }

  const pattern = patterns.find(p => p.name === opts.pattern);
  if (!pattern) {
    console.error(`Unknown pattern: ${opts.pattern}. Run with -l to list.`);
    process.exit(1);
  }

  const input = await readStdin();
  const providerRegistry = require('../providers/registry');
  const codex = providerRegistry.getProviderInstance('codex');
  const output = await runPattern({
    pattern, input, vars: opts.vars || {},
    callModel: async ({ system, user }) => codex.runPrompt({ prompt: `${system}\n\n${user}`, max_tokens: 2000 }),
  });
  process.stdout.write(typeof output === 'string' ? output : JSON.stringify(output));
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => resolve(data));
  });
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: MCP tools**

```js
list_patterns: { description: 'List all patterns from .torque/patterns/.', inputSchema: { type: 'object', properties: {} } },
describe_pattern: { description: 'Show the system prompt + template + metadata for a pattern.', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
run_pattern: {
  description: 'Run a named pattern with input + optional variables.',
  inputSchema: {
    type: 'object', required: ['name', 'input'],
    properties: {
      name: { type: 'string' }, input: { type: 'string' },
      vars: { type: 'object' }, provider: { type: 'string' },
    },
  },
},
```

- [ ] **Step 3: Container + example pattern**

```js
container.factory('patternsStore', (c) => {
  const path = require('path');
  const { loadPatternsFromDir } = require('./patterns/pattern-loader');
  const dir = path.join(process.cwd(), '.torque', 'patterns');
  let patterns = loadPatternsFromDir(dir);
  return {
    list: () => patterns,
    get: (name) => patterns.find(p => p.name === name) || null,
    reload: () => { patterns = loadPatternsFromDir(dir); return patterns.length; },
    sourceDir: dir,
  };
});
```

Create `.torque/patterns/extract_wisdom/` with sample `system.md` + `metadata.json` as a starter.

`await_restart`. Smoke: `cat some-text.txt | node server/patterns/cli.js -p extract_wisdom` — confirm output prints. `run_pattern({name:'extract_wisdom', input:'...'})` via MCP returns same.

Commit: `feat(patterns): CLI + MCP + filesystem watcher for .torque/patterns`.
