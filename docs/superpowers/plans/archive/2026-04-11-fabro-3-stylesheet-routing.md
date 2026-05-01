# Fabro #3: Stylesheet Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users specify provider/model/reasoning rules with a CSS-like stylesheet on workflows and workflow specs. Rules target tasks by wildcard, tag, or node_id, with CSS-style specificity cascading. Selected properties are merged into each task's provider/model at workflow-creation time.

**Architecture:** A new `server/routing/stylesheet.js` module parses a short stylesheet DSL and resolves properties for each task. Selector specificity: `*` (0) < `.tag` (1) < `#node_id` (2). The workflow-creation path (`createSeededWorkflowTasks`) invokes the resolver for each task to compute its effective provider/model/reasoning. Explicit per-task `provider` / `model` fields still win — stylesheets only apply when the task has nothing set. Add a `model_stylesheet` field at the workflow level in `create_workflow` args and in the workflow-spec YAML schema.

**Tech Stack:** Node.js, existing provider routing code.

**Test invocation:** `torque-remote` on remote project path from `~/.torque-remote.local.json`.

---

## File Structure

**New files:**
- `server/routing/stylesheet.js` — parser + resolver
- `server/tests/stylesheet-parse.test.js`
- `server/tests/stylesheet-resolve.test.js`
- `server/tests/stylesheet-workflow-integration.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `model_stylesheet` in `create_workflow`, apply to tasks
- `server/workflow-spec/schema.js` (if Plan 1 shipped) — accept `model_stylesheet` field
- `server/tool-defs/workflow-defs.js` — document `model_stylesheet` arg on `create_workflow`
- `docs/workflow-specs.md` (if Plan 1 shipped) — document stylesheet field

---

## Task 1: Stylesheet parser

**Files:**
- Create: `server/routing/stylesheet.js`
- Create: `server/tests/stylesheet-parse.test.js`

Supported DSL — a deliberately tiny subset of CSS. Selectors: `*` (universal), `.tag`, `#node_id`. Properties: `provider`, `model`, `reasoning_effort`, `routing_template`. Later rules with equal specificity beat earlier ones. Higher specificity always beats lower. `/* block comments */` allowed. Whitespace insignificant.

- [ ] **Step 1: Write failing tests**

Create `server/tests/stylesheet-parse.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { parseStylesheet } = require('../routing/stylesheet');

describe('parseStylesheet', () => {
  it('parses an empty stylesheet', () => {
    const result = parseStylesheet('');
    expect(result.ok).toBe(true);
    expect(result.rules).toEqual([]);
  });

  it('parses a universal rule', () => {
    const result = parseStylesheet('* { provider: codex; }');
    expect(result.ok).toBe(true);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].selector).toEqual({ type: 'universal' });
    expect(result.rules[0].specificity).toBe(0);
    expect(result.rules[0].props).toEqual({ provider: 'codex' });
  });

  it('parses tag and id selectors with correct specificity', () => {
    const css = `
      * { provider: ollama; }
      .coding { provider: codex; reasoning_effort: high; }
      #review { model: claude-opus-4-6; }
    `;
    const result = parseStylesheet(css);
    expect(result.ok).toBe(true);
    expect(result.rules).toHaveLength(3);
    const [a, b, c] = result.rules;
    expect(a.specificity).toBe(0);
    expect(b.selector).toEqual({ type: 'tag', value: 'coding' });
    expect(b.specificity).toBe(1);
    expect(b.props).toEqual({ provider: 'codex', reasoning_effort: 'high' });
    expect(c.selector).toEqual({ type: 'id', value: 'review' });
    expect(c.specificity).toBe(2);
  });

  it('preserves rule order for equal-specificity tiebreak', () => {
    const css = `
      .a { provider: codex; }
      .a { provider: ollama; }
    `;
    const result = parseStylesheet(css);
    expect(result.rules[1].order).toBeGreaterThan(result.rules[0].order);
  });

  it('rejects unknown properties', () => {
    const result = parseStylesheet('* { unknown: value; }');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unknown/i);
  });

  it('rejects invalid provider values', () => {
    const result = parseStylesheet('* { provider: not-a-real-provider; }');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/provider/i);
  });

  it('rejects invalid reasoning_effort values', () => {
    const result = parseStylesheet('* { reasoning_effort: extreme; }');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/reasoning_effort/i);
  });

  it('ignores block comments', () => {
    const css = `
      /* default everything */
      * { provider: codex; }
      /* override for coding */
      .coding { provider: claude-cli; }
    `;
    const result = parseStylesheet(css);
    expect(result.ok).toBe(true);
    expect(result.rules).toHaveLength(2);
  });

  it('rejects syntactically broken input', () => {
    const result = parseStylesheet('* { provider codex; }');
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run on remote: `npx vitest run tests/stylesheet-parse.test.js --no-coverage`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement parser**

Create `server/routing/stylesheet.js`:

```js
'use strict';

const ALLOWED_PROVIDERS = new Set([
  'codex', 'claude-cli', 'ollama', 'ollama-cloud', 'anthropic',
  'cerebras', 'deepinfra', 'google-ai', 'groq', 'hyperbolic', 'openrouter',
]);

const ALLOWED_REASONING = new Set(['low', 'medium', 'high']);
const ALLOWED_PROPS = new Set(['provider', 'model', 'reasoning_effort', 'routing_template']);

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseSelector(raw) {
  const s = raw.trim();
  if (s === '*') return { selector: { type: 'universal' }, specificity: 0 };
  if (s.startsWith('.') && /^\.[\w-]+$/.test(s)) {
    return { selector: { type: 'tag', value: s.slice(1) }, specificity: 1 };
  }
  if (s.startsWith('#') && /^#[\w-]+$/.test(s)) {
    return { selector: { type: 'id', value: s.slice(1) }, specificity: 2 };
  }
  return null;
}

function parseProps(body, errors) {
  const props = {};
  const decls = body.split(';').map(d => d.trim()).filter(Boolean);
  for (const d of decls) {
    const idx = d.indexOf(':');
    if (idx < 0) {
      errors.push(`Missing ':' in declaration "${d}"`);
      continue;
    }
    const key = d.slice(0, idx).trim();
    const value = d.slice(idx + 1).trim();
    if (!ALLOWED_PROPS.has(key)) {
      errors.push(`Unknown property "${key}" (allowed: ${[...ALLOWED_PROPS].join(', ')})`);
      continue;
    }
    if (key === 'provider' && !ALLOWED_PROVIDERS.has(value)) {
      errors.push(`Invalid provider "${value}" in declaration "${d}"`);
      continue;
    }
    if (key === 'reasoning_effort' && !ALLOWED_REASONING.has(value)) {
      errors.push(`Invalid reasoning_effort "${value}" (allowed: low/medium/high)`);
      continue;
    }
    props[key] = value;
  }
  return props;
}

/**
 * Parse a stylesheet into a list of rules.
 * @param {string} css
 * @returns {{ ok: true, rules: Array } | { ok: false, errors: string[] }}
 */
function parseStylesheet(css) {
  const errors = [];
  const rules = [];
  const source = stripComments(css || '');
  const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  let order = 0;
  while ((match = ruleRegex.exec(source)) !== null) {
    const [, selectorPart, bodyPart] = match;
    const parsed = parseSelector(selectorPart);
    if (!parsed) {
      errors.push(`Unsupported selector "${selectorPart.trim()}" — use *, .tag, or #node_id`);
      continue;
    }
    const props = parseProps(bodyPart, errors);
    rules.push({
      selector: parsed.selector,
      specificity: parsed.specificity,
      order: order++,
      props,
    });
  }

  const residue = source.replace(ruleRegex, '').replace(/\s/g, '');
  if (residue.length > 0) {
    errors.push(`Unparsed content: "${residue.slice(0, 40)}..."`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rules };
}

/**
 * Resolve the effective stylesheet props for a single task.
 * @param {Array} rules - output of parseStylesheet
 * @param {{node_id?: string, tags?: string[]}} task
 * @returns {object} props subset to apply
 */
function resolveTaskProps(rules, task) {
  const candidates = rules.filter(r => matchesSelector(r.selector, task));
  if (candidates.length === 0) return {};
  candidates.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const merged = {};
  for (const r of candidates) {
    for (const [k, v] of Object.entries(r.props)) {
      merged[k] = v;
    }
  }
  return merged;
}

function matchesSelector(selector, task) {
  if (selector.type === 'universal') return true;
  if (selector.type === 'tag') {
    return Array.isArray(task.tags) && task.tags.includes(selector.value);
  }
  if (selector.type === 'id') {
    return task.node_id === selector.value;
  }
  return false;
}

module.exports = { parseStylesheet, resolveTaskProps };
```

- [ ] **Step 4: Run tests**

Run on remote: `npx vitest run tests/stylesheet-parse.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routing/stylesheet.js server/tests/stylesheet-parse.test.js
git commit -m "feat(stylesheet): CSS-like parser for routing rules"
git push --no-verify origin main
```

---

## Task 2: Resolver tests

**Files:**
- Create: `server/tests/stylesheet-resolve.test.js`

- [ ] **Step 1: Write tests**

Create `server/tests/stylesheet-resolve.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { parseStylesheet, resolveTaskProps } = require('../routing/stylesheet');

function rulesFor(css) {
  const r = parseStylesheet(css);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.rules;
}

describe('resolveTaskProps', () => {
  it('returns empty object when no rule matches', () => {
    const rules = rulesFor('.coding { provider: codex; }');
    const props = resolveTaskProps(rules, { node_id: 'review', tags: [] });
    expect(props).toEqual({});
  });

  it('universal rule applies to everything', () => {
    const rules = rulesFor('* { provider: ollama; }');
    expect(resolveTaskProps(rules, { node_id: 'x', tags: [] })).toEqual({ provider: 'ollama' });
  });

  it('tag rule beats universal (higher specificity)', () => {
    const rules = rulesFor(`
      * { provider: ollama; }
      .coding { provider: codex; }
    `);
    expect(resolveTaskProps(rules, { node_id: 'x', tags: ['coding'] })).toEqual({ provider: 'codex' });
    expect(resolveTaskProps(rules, { node_id: 'x', tags: ['docs'] })).toEqual({ provider: 'ollama' });
  });

  it('id rule beats tag rule', () => {
    const rules = rulesFor(`
      .coding { provider: codex; }
      #review { provider: anthropic; }
    `);
    expect(resolveTaskProps(rules, { node_id: 'review', tags: ['coding'] })).toEqual({ provider: 'anthropic' });
  });

  it('later rule wins for equal specificity', () => {
    const rules = rulesFor(`
      .a { provider: codex; }
      .a { provider: ollama; }
    `);
    expect(resolveTaskProps(rules, { node_id: 'x', tags: ['a'] })).toEqual({ provider: 'ollama' });
  });

  it('merges props from multiple matching rules at different specificities', () => {
    const rules = rulesFor(`
      * { reasoning_effort: low; }
      .coding { provider: codex; reasoning_effort: high; }
      #implement { model: gpt-5.4; }
    `);
    const props = resolveTaskProps(rules, { node_id: 'implement', tags: ['coding'] });
    expect(props).toEqual({
      reasoning_effort: 'high',
      provider: 'codex',
      model: 'gpt-5.4',
    });
  });
});
```

- [ ] **Step 2: Run tests (should already pass since resolver is in place)**

Run on remote: `npx vitest run tests/stylesheet-resolve.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/tests/stylesheet-resolve.test.js
git commit -m "test(stylesheet): resolver specificity cascade tests"
git push --no-verify origin main
```

---

## Task 3: Integrate into workflow creation

**Files:**
- Modify: `server/handlers/workflow/index.js`

- [ ] **Step 1: Locate `createSeededWorkflowTasks`**

Read `server/handlers/workflow/index.js`. Find `function createSeededWorkflowTasks` and `function normalizeInitialWorkflowTasks`. The former iterates tasks and calls `createTask`; the latter builds the normalized task list from user input.

- [ ] **Step 2: Add stylesheet resolution**

In `handleCreateWorkflow`, after `normalizedTasks` is built and before `createSeededWorkflowTasks` is called, resolve stylesheet rules and merge into tasks:

```js
// Near the top of handleCreateWorkflow, after args validation:
const { parseStylesheet, resolveTaskProps } = require('../../routing/stylesheet');

let styleRules = [];
if (args.model_stylesheet) {
  const parsed = parseStylesheet(args.model_stylesheet);
  if (!parsed.ok) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Invalid model_stylesheet:\n- ${parsed.errors.join('\n- ')}`
    );
  }
  styleRules = parsed.rules;
}
```

Then, after `normalizedTasks.tasks` is produced and before the seed pass, apply:

```js
if (styleRules.length > 0) {
  for (const task of normalizedTasks.tasks) {
    const props = resolveTaskProps(styleRules, task);
    if (props.provider && !task.provider) task.provider = props.provider;
    if (props.model && !task.model) task.model = props.model;
    if (props.reasoning_effort && !task.reasoning_effort) task.reasoning_effort = props.reasoning_effort;
    if (props.routing_template && !task.routing_template) task.routing_template = props.routing_template;
  }
}
```

- [ ] **Step 3: Advertise the argument in the tool def**

Open `server/tool-defs/workflow-defs.js`. Find the `create_workflow` schema `properties`. Add at the top level alongside `routing_template`:

```js
model_stylesheet: {
  type: 'string',
  description: 'CSS-like rules mapping tasks to providers/models. Selectors: * (all), .tag (class), #node_id (id). Example: "* { provider: ollama; } .coding { provider: codex; }"',
},
```

- [ ] **Step 4: Integration test**

Create `server/tests/stylesheet-workflow-integration.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('stylesheet-integration'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

function extractUUID(text) {
  return text.match(/([a-f0-9-]{36})/)?.[1];
}

describe('create_workflow with model_stylesheet', () => {
  it('applies universal rule to tasks without explicit provider', async () => {
    const result = await safeTool('create_workflow', {
      name: 'ss-test-1',
      working_directory: testDir,
      model_stylesheet: '* { provider: ollama; }',
      tasks: [
        { node_id: 'a', task_description: 'A' },
        { node_id: 'b', task_description: 'B' },
      ],
    });
    expect(result.isError).toBeFalsy();
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    expect(tasks.every(t => t.provider === 'ollama')).toBe(true);
  });

  it('tag selector overrides universal selector', async () => {
    const result = await safeTool('create_workflow', {
      name: 'ss-test-2',
      working_directory: testDir,
      model_stylesheet: `
        * { provider: ollama; }
        .coding { provider: codex; }
      `,
      tasks: [
        { node_id: 'doc', task_description: 'docs', tags: ['docs'] },
        { node_id: 'code', task_description: 'code', tags: ['coding'] },
      ],
    });
    expect(result.isError).toBeFalsy();
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    const doc = tasks.find(t => t.workflow_node_id === 'doc');
    const code = tasks.find(t => t.workflow_node_id === 'code');
    expect(doc.provider).toBe('ollama');
    expect(code.provider).toBe('codex');
  });

  it('explicit task provider beats stylesheet', async () => {
    const result = await safeTool('create_workflow', {
      name: 'ss-test-3',
      working_directory: testDir,
      model_stylesheet: '* { provider: ollama; }',
      tasks: [
        { node_id: 'override', task_description: 'x', provider: 'codex' },
      ],
    });
    expect(result.isError).toBeFalsy();
    const wfId = extractUUID(getText(result));
    const tasks = db.getWorkflowTasks(wfId);
    expect(tasks[0].provider).toBe('codex');
  });

  it('returns a clear error for invalid stylesheet', async () => {
    const result = await safeTool('create_workflow', {
      name: 'ss-test-4',
      working_directory: testDir,
      model_stylesheet: '* { provider: not-a-provider; }',
      tasks: [{ node_id: 'a', task_description: 'x' }],
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/invalid.*stylesheet|provider/i);
  });
});
```

- [ ] **Step 5: Run integration tests**

Run on remote: `npx vitest run tests/stylesheet-workflow-integration.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/handlers/workflow/index.js server/tool-defs/workflow-defs.js server/tests/stylesheet-workflow-integration.test.js
git commit -m "feat(stylesheet): apply model_stylesheet during create_workflow"
git push --no-verify origin main
```

---

## Task 4: Extend workflow-spec schema (if Plan 1 shipped)

**Files:**
- Modify: `server/workflow-spec/schema.js`
- Modify: `server/handlers/workflow-spec-handlers.js`

**Skip this task if Plan 1 (workflow-as-code) has not shipped.**

- [ ] **Step 1: Add `model_stylesheet` to schema**

In `server/workflow-spec/schema.js`, add to the top-level properties:

```js
model_stylesheet: { type: 'string' },
```

- [ ] **Step 2: Pass through in handler**

In `server/handlers/workflow-spec-handlers.js` `handleRunWorkflowSpec`, extend the `createArgs` object:

```js
const createArgs = {
  name: spec.name,
  description: spec.description || args.goal || null,
  working_directory: args.working_directory || spec.working_directory,
  project: spec.project,
  routing_template: spec.routing_template,
  version_intent: spec.version_intent,
  priority: spec.priority,
  model_stylesheet: spec.model_stylesheet,
  tasks: spec.tasks,
};
```

- [ ] **Step 3: Test**

Add a test case to `server/tests/workflow-spec-handlers.test.js`:

```js
it('passes model_stylesheet through to create_workflow', () => {
  const wfDir = path.join(testDir, 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  const specPath = path.join(wfDir, 'style.yaml');
  fs.writeFileSync(specPath, `
version: 1
name: style-test
project: p
model_stylesheet: |
  * { provider: ollama; }
tasks:
  - node_id: x
    task: do x
`);
  const result = handleRunWorkflowSpec({ spec_path: specPath, working_directory: testDir });
  expect(result.isError).toBeFalsy();
  const tasks = db.getWorkflowTasks(result.structuredData.workflow_id);
  expect(tasks[0].provider).toBe('ollama');
});
```

Run tests. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/workflow-spec/schema.js server/handlers/workflow-spec-handlers.js server/tests/workflow-spec-handlers.test.js
git commit -m "feat(workflow-spec): accept model_stylesheet field"
git push --no-verify origin main
```

---

## Task 5: Docs update

**Files:**
- Create or modify: `docs/routing.md`

- [ ] **Step 1: Add a stylesheet section to routing docs**

Add a new section to `docs/routing.md` (create if missing):

````markdown
## Model stylesheets

You can assign providers and models to tasks using CSS-like rules. Supply them on `create_workflow` as `model_stylesheet`, or at the top of a workflow spec YAML.

### Selectors

| Selector | Matches | Specificity |
|---|---|---|
| `*` | All tasks | 0 |
| `.tag-name` | Tasks with that tag | 1 |
| `#node-id` | The task with that node_id | 2 |

Later rules beat earlier rules of equal specificity. Higher specificity always beats lower.

### Properties

- `provider` — one of `codex`, `claude-cli`, `ollama`, `ollama-cloud`, `anthropic`, `cerebras`, `deepinfra`, `google-ai`, `groq`, `hyperbolic`, `openrouter`
- `model` — model ID
- `reasoning_effort` — `low` / `medium` / `high`
- `routing_template` — routing template name

### Example

```yaml
version: 1
name: ensemble
model_stylesheet: |
  /* Default everything to a cheap local model */
  * { provider: ollama; reasoning_effort: medium; }
  /* Coding steps get Codex on high reasoning */
  .coding { provider: codex; reasoning_effort: high; }
  /* Reviews use a different vendor for fresh eyes */
  .review { provider: claude-cli; }
  /* This specific node always uses Opus */
  #final-synthesis { model: claude-opus-4-6; }
tasks:
  - node_id: plan
    task: Write a plan
  - node_id: implement
    task: Implement the plan
    tags: [coding]
  - node_id: critique
    task: Critique the implementation
    tags: [review]
  - node_id: final-synthesis
    task: Produce the final summary
```

### Precedence with explicit fields

An explicit `provider` / `model` on a task always wins over the stylesheet. Stylesheets only fill fields the task left unset.

### Precedence with routing templates

`routing_template` from the stylesheet follows the same rule — task-level `routing_template` beats stylesheet. The existing smart-routing fallback chain still runs downstream; the stylesheet just picks the preferred provider/model upfront.
````

- [ ] **Step 2: Commit**

```bash
git add docs/routing.md
git commit -m "docs(stylesheet): routing stylesheet guide"
git push --no-verify origin main
```

---

## Task 6: Full suite + restart + smoke

- [ ] **Step 1: Run all related tests**

Run on remote: `npx vitest run tests/stylesheet --no-coverage`

Expected: All PASS.

- [ ] **Step 2: Restart TORQUE**

`await_restart` with reason `Load stylesheet routing`.

- [ ] **Step 3: Smoke test via MCP**

Call `create_workflow`:

```
{
  name: "stylesheet-smoke",
  working_directory: "<project root>",
  model_stylesheet: "* { provider: ollama; } .coding { provider: codex; }",
  tasks: [
    { node_id: "a", task_description: "do a" },
    { node_id: "b", task_description: "do b", tags: ["coding"] }
  ]
}
```

Fetch the created tasks and confirm:
- `a.provider === "ollama"`
- `b.provider === "codex"`
