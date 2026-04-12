# Fabro #37: Modular Rule Blocks (Continue)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the monolithic `CLAUDE.md` style with a `.torque/rules/` directory of scoped Markdown files. Each file has YAML frontmatter declaring `globs`, `regex`, `description`, `alwaysApply`, and is auto-injected into task prompts when the task touches matching files. Inspired by Continue's `.continue/rules/` model.

**Architecture:** A new `rules/` module reads `.torque/rules/*.md` at startup (and on file change), parses frontmatter, and exposes `selectRulesForContext({ files, taskKind, workflowName })`. The task startup pipeline calls this and prepends matched rules to the prompt as a "Project rules" section. Rules with `alwaysApply: true` are included unconditionally; others match by file glob, file content regex, or task tag.

**Tech Stack:** Node.js, gray-matter for frontmatter parsing, micromatch for glob matching, chokidar for file-watching. Builds on existing prompt-building pipeline.

---

## File Structure

**New files:**
- `.torque/rules/` — runtime directory (created on first use; not part of build)
- `server/rules/rule-loader.js` — read + parse rule files
- `server/rules/rule-selector.js` — pick rules for a given context
- `server/tests/rule-loader.test.js`
- `server/tests/rule-selector.test.js`
- `docs/torque-rules.md` — user docs

**Modified files:**
- `server/execution/task-startup.js` — inject selected rules into prompt
- `server/index.js` — start file watcher

---

## Task 1: Rule loader

- [ ] **Step 1: Tests**

Create `server/tests/rule-loader.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadRulesFromDir } = require('../rules/rule-loader');

describe('loadRulesFromDir', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name, content) {
    fs.writeFileSync(path.join(dir, name), content);
  }

  it('reads .md files with frontmatter', () => {
    write('a.md', `---\nname: rule-a\nglobs: ["src/**/*.js"]\n---\n\nAlways use 2-space indent.`);
    const rules = loadRulesFromDir(dir);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe('rule-a');
    expect(rules[0].globs).toEqual(['src/**/*.js']);
    expect(rules[0].body.trim()).toBe('Always use 2-space indent.');
  });

  it('skips files without frontmatter', () => {
    write('no-fm.md', 'Just text, no frontmatter.');
    const rules = loadRulesFromDir(dir);
    expect(rules).toHaveLength(0);
  });

  it('treats alwaysApply: true as global rule', () => {
    write('global.md', `---\nname: global\nalwaysApply: true\n---\nGlobal rule body.`);
    const rules = loadRulesFromDir(dir);
    expect(rules[0].alwaysApply).toBe(true);
  });

  it('returns rules in deterministic order (filename)', () => {
    write('z.md', `---\nname: z\n---\nz`);
    write('a.md', `---\nname: a\n---\na`);
    write('m.md', `---\nname: m\n---\nm`);
    const rules = loadRulesFromDir(dir);
    expect(rules.map(r => r.name)).toEqual(['a', 'm', 'z']);
  });

  it('parses regex field and stores compiled RegExp', () => {
    write('reg.md', `---\nname: r\nregex: 'TODO\\\\(.*\\\\):'\n---\nNo open TODOs.`);
    const rules = loadRulesFromDir(dir);
    expect(rules[0].regex).toBeInstanceOf(RegExp);
    expect('TODO(claude): fix this'.match(rules[0].regex)).toBeTruthy();
  });

  it('returns empty array if directory does not exist', () => {
    expect(loadRulesFromDir(path.join(dir, 'nonexistent'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/rules/rule-loader.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

function loadRulesFromDir(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  const rules = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const raw = fs.readFileSync(full, 'utf8');
    if (!raw.trim().startsWith('---')) continue;
    let parsed;
    try { parsed = matter(raw); } catch { continue; }
    const fm = parsed.data || {};
    const rule = {
      name: fm.name || path.basename(f, '.md'),
      description: fm.description || null,
      globs: Array.isArray(fm.globs) ? fm.globs : (fm.globs ? [fm.globs] : []),
      regex: fm.regex ? compileRegex(fm.regex) : null,
      tags: Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []),
      alwaysApply: fm.alwaysApply === true,
      priority: typeof fm.priority === 'number' ? fm.priority : 0,
      body: parsed.content,
      sourcePath: full,
    };
    rules.push(rule);
  }
  return rules;
}

function compileRegex(s) {
  try { return new RegExp(s); }
  catch { return null; }
}

module.exports = { loadRulesFromDir };
```

Run tests → PASS. Commit: `feat(rules): rule-loader for .torque/rules/*.md with frontmatter`.

---

## Task 2: Selector

- [ ] **Step 1: Tests**

Create `server/tests/rule-selector.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { selectRulesForContext } = require('../rules/rule-selector');

const rules = [
  { name: 'global', alwaysApply: true, globs: [], tags: [], body: 'Global guidance.', priority: 0 },
  { name: 'js-style', alwaysApply: false, globs: ['**/*.js', '**/*.jsx'], tags: [], body: 'JS rules.', priority: 0 },
  { name: 'tests', alwaysApply: false, globs: ['**/*.test.js', '**/tests/**'], tags: [], body: 'Test rules.', priority: 0 },
  { name: 'security-tag', alwaysApply: false, globs: [], tags: ['security'], body: 'Security rules.', priority: 5 },
  { name: 'todo-regex', alwaysApply: false, globs: [], regex: /TODO\(/, body: 'No TODOs.', priority: 1 },
];

describe('selectRulesForContext', () => {
  it('always includes alwaysApply rules', () => {
    const out = selectRulesForContext(rules, { files: [], tags: [], taskBody: '' });
    expect(out.map(r => r.name)).toContain('global');
  });

  it('matches by file glob', () => {
    const out = selectRulesForContext(rules, { files: ['src/foo.js'], tags: [], taskBody: '' });
    expect(out.map(r => r.name)).toContain('js-style');
    expect(out.map(r => r.name)).not.toContain('tests');
  });

  it('matches multiple globs OR-style', () => {
    const out = selectRulesForContext(rules, { files: ['server/tests/foo.test.js'], tags: [], taskBody: '' });
    expect(out.map(r => r.name)).toContain('js-style'); // matches *.js
    expect(out.map(r => r.name)).toContain('tests');    // matches both globs
  });

  it('matches by task tag', () => {
    const out = selectRulesForContext(rules, { files: [], tags: ['security'], taskBody: '' });
    expect(out.map(r => r.name)).toContain('security-tag');
  });

  it('matches by regex against task body', () => {
    const out = selectRulesForContext(rules, { files: [], tags: [], taskBody: 'fix TODO(me) please' });
    expect(out.map(r => r.name)).toContain('todo-regex');
  });

  it('orders by priority desc then name asc', () => {
    const out = selectRulesForContext(rules, { files: ['x.js'], tags: ['security'], taskBody: 'TODO(me)' });
    const names = out.map(r => r.name);
    // security-tag (priority 5) > todo-regex (1) > global/js-style (0) sorted by name
    expect(names[0]).toBe('security-tag');
    expect(names[1]).toBe('todo-regex');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/rules/rule-selector.js`:

```js
'use strict';
const micromatch = require('micromatch');

function selectRulesForContext(rules, { files = [], tags = [], taskBody = '' }) {
  const matched = [];
  for (const rule of rules) {
    if (rule.alwaysApply) { matched.push(rule); continue; }
    let match = false;
    if (rule.globs && rule.globs.length > 0 && files.length > 0) {
      if (files.some(f => micromatch.isMatch(f, rule.globs))) match = true;
    }
    if (!match && rule.tags && rule.tags.length > 0 && tags.length > 0) {
      if (rule.tags.some(t => tags.includes(t))) match = true;
    }
    if (!match && rule.regex && taskBody) {
      if (rule.regex.test(taskBody)) match = true;
    }
    if (match) matched.push(rule);
  }
  matched.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.name.localeCompare(b.name);
  });
  return matched;
}

module.exports = { selectRulesForContext };
```

Run tests → PASS. Commit: `feat(rules): rule-selector with glob/tag/regex matching`.

---

## Task 3: Wire into task startup + watcher

- [ ] **Step 1: Container + startup loader**

In `server/container.js`:

```js
container.factory('rulesStore', (c) => {
  const path = require('path');
  const { loadRulesFromDir } = require('./rules/rule-loader');
  const dir = path.join(process.cwd(), '.torque', 'rules');
  let rules = loadRulesFromDir(dir);
  return {
    all: () => rules,
    reload: () => { rules = loadRulesFromDir(dir); return rules.length; },
    sourceDir: dir,
  };
});
```

- [ ] **Step 2: Inject into prompt**

In `server/execution/task-startup.js` — after the base prompt is built:

```js
const rulesStore = defaultContainer.get('rulesStore');
const { selectRulesForContext } = require('../rules/rule-selector');
const meta = parseTaskMetadata(task);
const ctx = {
  files: Array.isArray(meta.files) ? meta.files : [],
  tags: Array.isArray(task.tags) ? task.tags : (typeof task.tags === 'string' ? task.tags.split(',') : []),
  taskBody: task.task_description || '',
};
const matched = selectRulesForContext(rulesStore.all(), ctx);
if (matched.length > 0) {
  const rulesBlock = '## Project rules\n\n' + matched.map(r => `### ${r.name}\n${r.body}`).join('\n\n');
  task.task_description = `${rulesBlock}\n\n---\n\n${task.task_description}`;
}
```

- [ ] **Step 3: File watcher**

In `server/index.js` after rules store is loaded:

```js
const chokidar = require('chokidar');
const rulesStore = defaultContainer.get('rulesStore');
const watcher = chokidar.watch(rulesStore.sourceDir, { ignoreInitial: true });
watcher.on('all', () => {
  const n = rulesStore.reload();
  logger.info('rules reloaded', { count: n });
});
```

- [ ] **Step 4: Sample rules**

Create `.torque/rules/example.md` (gitignored or template):

```markdown
---
name: example
description: Example rule that always applies
alwaysApply: true
priority: 0
---

This is an example rule. Replace it with project-specific guidance.
Place rules in `.torque/rules/` as `*.md` files with frontmatter.
```

`await_restart`. Smoke: drop `.torque/rules/no-emojis.md` (with `alwaysApply: true`), submit any task, confirm "no emojis" guidance appears in the running task's prompt context.

Commit: `feat(rules): wire .torque/rules/ into task startup + hot reload`.

---

## Task 4: MCP tool for inspection

- [ ] **Step 1: Tool def**

In `server/tool-defs/`:

```js
list_rules: {
  description: 'List all loaded project rules from .torque/rules/. Useful for verifying which rules will be selected for a task.',
  inputSchema: { type: 'object', properties: {} },
},
preview_rules_for_context: {
  description: 'Preview which rules would match a hypothetical task context.',
  inputSchema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      task_body: { type: 'string' },
    },
  },
},
```

- [ ] **Step 2: Handlers**

```js
case 'list_rules': {
  const rules = defaultContainer.get('rulesStore').all();
  return { count: rules.length, rules: rules.map(r => ({ name: r.name, description: r.description, alwaysApply: r.alwaysApply, globs: r.globs, tags: r.tags, priority: r.priority, source: r.sourcePath })) };
}
case 'preview_rules_for_context': {
  const { selectRulesForContext } = require('../rules/rule-selector');
  const matched = selectRulesForContext(defaultContainer.get('rulesStore').all(), {
    files: args.files || [], tags: args.tags || [], taskBody: args.task_body || '',
  });
  return { count: matched.length, matched: matched.map(r => r.name) };
}
```

Commit: `feat(rules): MCP tools for rule inspection`.
