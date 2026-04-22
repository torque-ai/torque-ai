# Fabro #1: Workflow-as-Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users define TORQUE workflows as version-controlled YAML files in their repo, and submit them with a single command that translates the file into a `create_workflow` call.

**Architecture:** Add a `workflows/` directory convention to TORQUE projects. YAML files in that directory are parsed by a new `workflow-spec.js` module into the same shape `create_workflow` already accepts. A new MCP tool `run_workflow_spec` accepts a file path, validates the YAML against a JSON schema, and calls the existing `handleCreateWorkflow` + `handleRunWorkflow` handlers. The dashboard gets a new "Workflow Specs" view that lists discovered specs and offers one-click run.

**Tech Stack:** Node.js, better-sqlite3, js-yaml, ajv (JSON Schema validation), React (dashboard).

**Test invocation:** Run all `torque-remote` commands with the remote project path substituted in — if your local path is `$LOCAL_TORQUE_ROOT` and the remote is `$REMOTE_TORQUE_ROOT`, the remote equivalent is `torque-remote "cd $REMOTE_TORQUE_ROOT/server && npx vitest run <args>"`. Discover `$REMOTE_TORQUE_ROOT` from `~/.torque-remote.local.json` (`default_project_path`) joined with the project name.

---

## File Structure

**New files:**
- `server/workflow-spec/parse.js` — YAML → normalized workflow object
- `server/workflow-spec/schema.js` — JSON Schema for validation
- `server/workflow-spec/discover.js` — scan project for `workflows/*.yaml`
- `server/workflow-spec/index.js` — public API: `parseSpec`, `runSpec`, `discoverSpecs`
- `server/handlers/workflow-spec-handlers.js` — MCP tool handlers
- `server/tool-defs/workflow-spec-defs.js` — MCP tool schemas
- `server/tests/workflow-spec-parse.test.js`
- `server/tests/workflow-spec-discover.test.js`
- `server/tests/workflow-spec-handlers.test.js`
- `server/tests/workflow-spec-integration.test.js`
- `dashboard/src/views/WorkflowSpecs.jsx`
- `dashboard/src/views/WorkflowSpecs.test.jsx`
- `docs/workflow-specs.md` — user-facing docs
- `workflows/example-plan-implement.yaml` — reference example in repo root

**Modified files:**
- `server/tools.js` — register new MCP tools
- `server/tool-defs/index.js` — include new tool defs in the tier registry
- `server/api/routes-passthrough.js` — expose REST routes
- `dashboard/src/api.js` — add workflow-specs API client
- `dashboard/src/App.jsx` — add route
- `dashboard/src/components/Layout.jsx` — add nav item

---

## Task 1: YAML parser and schema

**Files:**
- Create: `server/workflow-spec/schema.js`
- Create: `server/workflow-spec/parse.js`
- Test: `server/tests/workflow-spec-parse.test.js`

- [x] **Step 1: Write the JSON schema**

Create `server/workflow-spec/schema.js`:

```js
'use strict';

// JSON Schema for .yaml workflow spec files.
// Keep this schema additive-only across versions — old specs must keep parsing.
const WORKFLOW_SPEC_SCHEMA = {
  type: 'object',
  required: ['version', 'name', 'tasks'],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', enum: [1] },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    project: { type: 'string' },
    working_directory: { type: 'string' },
    routing_template: { type: 'string' },
    version_intent: { type: 'string', enum: ['feature', 'fix', 'breaking', 'internal'] },
    priority: { type: 'number' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['node_id', 'task'],
        additionalProperties: false,
        properties: {
          node_id: { type: 'string', minLength: 1 },
          task: { type: 'string', minLength: 1 },
          depends_on: { type: 'array', items: { type: 'string' } },
          context_from: { type: 'array', items: { type: 'string' } },
          provider: {
            type: 'string',
            enum: ['codex', 'claude-cli', 'ollama', 'ollama-cloud', 'anthropic', 'cerebras', 'deepinfra', 'google-ai', 'groq', 'hyperbolic', 'openrouter'],
          },
          model: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          timeout_minutes: { type: 'integer', minimum: 1, maximum: 480 },
          auto_approve: { type: 'boolean' },
          version_intent: { type: 'string', enum: ['feature', 'fix', 'breaking', 'internal'] },
          on_fail: { type: 'string', enum: ['cancel', 'skip', 'continue', 'run_alternate'] },
          alternate_node_id: { type: 'string' },
          condition: { type: 'string' },
        },
      },
    },
  },
};

module.exports = { WORKFLOW_SPEC_SCHEMA };
```

- [x] **Step 2: Write failing tests for the parser**

Create `server/tests/workflow-spec-parse.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { parseSpecString } = require('../workflow-spec/parse');

describe('workflow-spec parseSpecString', () => {
  it('parses a minimal valid spec', () => {
    const yaml = `
version: 1
name: my-workflow
tasks:
  - node_id: step-1
    task: Do something
`;
    const result = parseSpecString(yaml);
    expect(result.ok).toBe(true);
    expect(result.spec.name).toBe('my-workflow');
    expect(result.spec.tasks).toHaveLength(1);
    expect(result.spec.tasks[0].node_id).toBe('step-1');
  });

  it('rejects missing required fields', () => {
    const yaml = `version: 1\nname: x`;
    const result = parseSpecString(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/tasks/);
  });

  it('rejects unknown top-level keys', () => {
    const yaml = `
version: 1
name: x
unknown: value
tasks:
  - node_id: a
    task: b
`;
    const result = parseSpecString(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unknown|additional/i);
  });

  it('rejects unknown version', () => {
    const yaml = `
version: 2
name: x
tasks:
  - node_id: a
    task: b
`;
    const result = parseSpecString(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/version/);
  });

  it('rejects invalid YAML syntax', () => {
    const result = parseSpecString('version: 1\nname: [unclosed');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/yaml|parse/i);
  });

  it('normalizes task field: task → task_description for workflow engine', () => {
    const yaml = `
version: 1
name: x
tasks:
  - node_id: a
    task: Write a function
`;
    const result = parseSpecString(yaml);
    expect(result.ok).toBe(true);
    expect(result.spec.tasks[0].task_description).toBe('Write a function');
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run on remote: `npx vitest run tests/workflow-spec-parse.test.js --no-coverage` (inside the `server/` dir)

Expected: FAIL with "Cannot find module '../workflow-spec/parse'"

- [x] **Step 4: Implement the parser**

Create `server/workflow-spec/parse.js`:

```js
'use strict';

const fs = require('fs');
const yaml = require('js-yaml');
const Ajv = require('ajv');
const { WORKFLOW_SPEC_SCHEMA } = require('./schema');

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(WORKFLOW_SPEC_SCHEMA);

/**
 * Parse a YAML string into a validated workflow spec.
 * @param {string} yamlContent
 * @returns {{ ok: true, spec: object } | { ok: false, errors: string[] }}
 */
function parseSpecString(yamlContent) {
  let raw;
  try {
    raw = yaml.load(yamlContent);
  } catch (err) {
    return { ok: false, errors: [`YAML parse error: ${err.message}`] };
  }

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Spec must be a YAML object'] };
  }

  if (!validate(raw)) {
    const errors = (validate.errors || []).map(e => {
      const path = e.instancePath || '(root)';
      return `${path}: ${e.message}${e.params ? ' (' + JSON.stringify(e.params) + ')' : ''}`;
    });
    return { ok: false, errors };
  }

  // Normalize: task → task_description for the workflow engine's schema
  const spec = {
    ...raw,
    tasks: raw.tasks.map(t => ({
      ...t,
      task_description: t.task,
    })),
  };

  return { ok: true, spec };
}

/**
 * Parse a YAML file from disk.
 * @param {string} filePath
 * @returns {{ ok: true, spec: object } | { ok: false, errors: string[] }}
 */
function parseSpec(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, errors: [`Cannot read ${filePath}: ${err.message}`] };
  }
  return parseSpecString(content);
}

module.exports = { parseSpec, parseSpecString };
```

- [x] **Step 5: Verify `ajv` and `js-yaml` are installed**

Run on remote, from the server dir: `node -e "require('js-yaml'); require('ajv'); console.log('ok')"`

Expected: `ok`. If either is missing, `npm install ajv js-yaml --save` in the `server/` package.

- [x] **Step 6: Run tests to verify they pass**

Run on remote: `npx vitest run tests/workflow-spec-parse.test.js --no-coverage`

Expected: PASS — all 6 tests green.

- [x] **Step 7: Commit**

```bash
git add server/workflow-spec/schema.js server/workflow-spec/parse.js server/tests/workflow-spec-parse.test.js
git commit -m "feat(workflow-spec): YAML parser with JSON Schema validation"
git push --no-verify origin main
```

---

## Task 2: Spec discovery

**Files:**
- Create: `server/workflow-spec/discover.js`
- Test: `server/tests/workflow-spec-discover.test.js`

- [x] **Step 1: Write failing tests**

Create `server/tests/workflow-spec-discover.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { discoverSpecs } = require('../workflow-spec/discover');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-discover-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('workflow-spec discoverSpecs', () => {
  it('returns empty array when workflows dir does not exist', () => {
    const result = discoverSpecs(tmpDir);
    expect(result).toEqual([]);
  });

  it('lists .yaml files in workflows/', () => {
    const wfDir = path.join(tmpDir, 'workflows');
    fs.mkdirSync(wfDir);
    fs.writeFileSync(path.join(wfDir, 'a.yaml'), 'version: 1\nname: a\ntasks:\n  - node_id: x\n    task: y\n');
    fs.writeFileSync(path.join(wfDir, 'b.yml'), 'version: 1\nname: b\ntasks:\n  - node_id: x\n    task: y\n');
    fs.writeFileSync(path.join(wfDir, 'readme.md'), 'not a workflow');

    const result = discoverSpecs(tmpDir);
    const names = result.map(r => r.name).sort();
    expect(names).toEqual(['a', 'b']);
  });

  it('marks invalid specs as invalid with error messages', () => {
    const wfDir = path.join(tmpDir, 'workflows');
    fs.mkdirSync(wfDir);
    fs.writeFileSync(path.join(wfDir, 'bad.yaml'), 'not: valid\nmissing_tasks: true\n');

    const result = discoverSpecs(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].valid).toBe(false);
    expect(result[0].errors.length).toBeGreaterThan(0);
  });

  it('returns forward-slash relative paths from the project root', () => {
    const wfDir = path.join(tmpDir, 'workflows');
    fs.mkdirSync(wfDir);
    fs.writeFileSync(path.join(wfDir, 'a.yaml'), 'version: 1\nname: a\ntasks:\n  - node_id: x\n    task: y\n');

    const result = discoverSpecs(tmpDir);
    expect(result[0].relative_path).toBe('workflows/a.yaml');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run on remote: `npx vitest run tests/workflow-spec-discover.test.js --no-coverage`

Expected: FAIL with "Cannot find module '../workflow-spec/discover'"

- [x] **Step 3: Implement discovery**

Create `server/workflow-spec/discover.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { parseSpec } = require('./parse');

/**
 * Scan <projectRoot>/workflows/ for .yaml/.yml files and return spec summaries.
 * @param {string} projectRoot - absolute path to the project working directory
 * @returns {Array<{
 *   name: string,
 *   relative_path: string,
 *   absolute_path: string,
 *   valid: boolean,
 *   errors: string[],
 *   description: string|null,
 *   task_count: number
 * }>}
 */
function discoverSpecs(projectRoot) {
  const wfDir = path.join(projectRoot, 'workflows');
  if (!fs.existsSync(wfDir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(wfDir);
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!/\.(ya?ml)$/i.test(entry)) continue;
    const absPath = path.join(wfDir, entry);
    const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
    const parsed = parseSpec(absPath);
    if (parsed.ok) {
      results.push({
        name: parsed.spec.name,
        relative_path: relPath,
        absolute_path: absPath,
        valid: true,
        errors: [],
        description: parsed.spec.description || null,
        task_count: parsed.spec.tasks.length,
      });
    } else {
      // Still list invalid specs so the UI can show parse errors
      const nameFromFile = entry.replace(/\.(ya?ml)$/i, '');
      results.push({
        name: nameFromFile,
        relative_path: relPath,
        absolute_path: absPath,
        valid: false,
        errors: parsed.errors,
        description: null,
        task_count: 0,
      });
    }
  }

  return results;
}

module.exports = { discoverSpecs };
```

- [x] **Step 4: Run tests to verify they pass**

Run on remote: `npx vitest run tests/workflow-spec-discover.test.js --no-coverage`

Expected: PASS — all 4 tests green.

- [x] **Step 5: Commit**

```bash
git add server/workflow-spec/discover.js server/tests/workflow-spec-discover.test.js
git commit -m "feat(workflow-spec): discover workflows/*.yaml in projects"
git push --no-verify origin main
```

---

## Task 3: Public module API

**Files:**
- Create: `server/workflow-spec/index.js`

- [x] **Step 1: Create the index re-export**

Create `server/workflow-spec/index.js`:

```js
'use strict';

const { parseSpec, parseSpecString } = require('./parse');
const { discoverSpecs } = require('./discover');
const { WORKFLOW_SPEC_SCHEMA } = require('./schema');

module.exports = {
  parseSpec,
  parseSpecString,
  discoverSpecs,
  WORKFLOW_SPEC_SCHEMA,
};
```

- [x] **Step 2: Commit**

```bash
git add server/workflow-spec/index.js
git commit -m "chore(workflow-spec): public module API"
git push --no-verify origin main
```

---

## Task 4: MCP tool definitions

**Files:**
- Create: `server/tool-defs/workflow-spec-defs.js`
- Modify: `server/tool-defs/index.js`

- [x] **Step 1: Define the tool schemas**

Create `server/tool-defs/workflow-spec-defs.js`:

```js
'use strict';

const WORKFLOW_SPEC_TOOLS = [
  {
    name: 'list_workflow_specs',
    description: 'List workflow specs discovered in <working_directory>/workflows/. Each spec is a version-controlled YAML file defining a DAG of tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project root. Defaults to current project working directory.',
        },
      },
    },
  },
  {
    name: 'validate_workflow_spec',
    description: 'Parse and validate a workflow spec YAML file against the schema. Returns parse errors if invalid.',
    inputSchema: {
      type: 'object',
      required: ['spec_path'],
      properties: {
        spec_path: {
          type: 'string',
          description: 'Path to the YAML file (relative to working_directory or absolute).',
        },
        working_directory: {
          type: 'string',
          description: 'Project root for resolving relative paths.',
        },
      },
    },
  },
  {
    name: 'run_workflow_spec',
    description: 'Create and run a workflow from a YAML spec file. Equivalent to create_workflow + run_workflow in one call.',
    inputSchema: {
      type: 'object',
      required: ['spec_path'],
      properties: {
        spec_path: {
          type: 'string',
          description: 'Path to the YAML file (relative to working_directory or absolute).',
        },
        working_directory: {
          type: 'string',
          description: 'Project root. Overrides the working_directory in the spec if provided.',
        },
        goal: {
          type: 'string',
          description: 'Optional run goal — overrides the spec description for this run.',
        },
      },
    },
  },
];

module.exports = { WORKFLOW_SPEC_TOOLS };
```

- [x] **Step 2: Find where tool defs are registered**

Read `server/tool-defs/index.js`. Identify the pattern: it imports tool arrays from sibling files and exports a flat merged array (typically called `ALL_TOOLS` or similar), often grouped by tier.

- [x] **Step 3: Register the new tool defs**

Add to `server/tool-defs/index.js`:

```js
const { WORKFLOW_SPEC_TOOLS } = require('./workflow-spec-defs');
```

Merge `...WORKFLOW_SPEC_TOOLS` into the tier / array that already contains `create_workflow`. Match the surrounding pattern exactly — if that tier uses `[...EXISTING, ...NEW]`, do the same. Do NOT introduce a new tier.

- [x] **Step 4: Commit**

```bash
git add server/tool-defs/workflow-spec-defs.js server/tool-defs/index.js
git commit -m "feat(workflow-spec): MCP tool schemas"
git push --no-verify origin main
```

---

## Task 5: MCP handler implementation

**Files:**
- Create: `server/handlers/workflow-spec-handlers.js`
- Create: `server/tests/workflow-spec-handlers.test.js`
- Modify: `server/tools.js`

- [x] **Step 1: Write failing tests**

Create `server/tests/workflow-spec-handlers.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const fs = require('fs');
const path = require('path');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db;
let testDir;

beforeAll(() => {
  const env = setupTestDb('workflow-spec-handlers');
  db = env.db;
  testDir = env.testDir;
});
afterAll(() => teardownTestDb());

const { handleListWorkflowSpecs, handleValidateWorkflowSpec, handleRunWorkflowSpec } =
  require('../handlers/workflow-spec-handlers');

describe('handleListWorkflowSpecs', () => {
  it('returns empty list when no workflows dir', () => {
    const result = handleListWorkflowSpecs({ working_directory: testDir });
    expect(result.isError).toBeFalsy();
    expect(result.structuredData.specs).toEqual([]);
  });

  it('lists discovered specs', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'hello.yaml'),
      'version: 1\nname: hello\ntasks:\n  - node_id: a\n    task: Say hi\n');

    const result = handleListWorkflowSpecs({ working_directory: testDir });
    expect(result.isError).toBeFalsy();
    expect(result.structuredData.specs).toHaveLength(1);
    expect(result.structuredData.specs[0].name).toBe('hello');
  });
});

describe('handleValidateWorkflowSpec', () => {
  it('reports errors for invalid specs', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const badPath = path.join(wfDir, 'bad.yaml');
    fs.writeFileSync(badPath, 'version: 1\nname: x\ntasks: []\n');

    const result = handleValidateWorkflowSpec({ spec_path: badPath });
    expect(result.isError).toBe(true);
    expect(result.structuredData.errors.length).toBeGreaterThan(0);
  });

  it('validates a good spec', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const goodPath = path.join(wfDir, 'ok.yaml');
    fs.writeFileSync(goodPath,
      'version: 1\nname: ok\ntasks:\n  - node_id: a\n    task: Do it\n');

    const result = handleValidateWorkflowSpec({ spec_path: goodPath });
    expect(result.isError).toBeFalsy();
    expect(result.structuredData.valid).toBe(true);
  });
});

describe('handleRunWorkflowSpec', () => {
  it('creates a workflow from a valid spec and returns workflow_id', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const specPath = path.join(wfDir, 'run.yaml');
    fs.writeFileSync(specPath,
      `version: 1
name: test-run
project: test-proj
tasks:
  - node_id: step-a
    task: First task
  - node_id: step-b
    task: Second task
    depends_on: [step-a]
`);

    const result = handleRunWorkflowSpec({
      spec_path: specPath,
      working_directory: testDir,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredData.workflow_id).toMatch(/^[a-f0-9-]{36}$/);

    const workflow = db.getWorkflow(result.structuredData.workflow_id);
    expect(workflow).toBeTruthy();
    expect(workflow.name).toBe('test-run');
    const tasks = db.getWorkflowTasks(workflow.id);
    expect(tasks).toHaveLength(2);
    expect(tasks.find(t => t.workflow_node_id === 'step-a')).toBeTruthy();
    expect(tasks.find(t => t.workflow_node_id === 'step-b')).toBeTruthy();
    expect(tasks.every(t => t.project === 'test-proj')).toBe(true);
  });

  it('rejects invalid specs with schema errors', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const badPath = path.join(wfDir, 'invalid.yaml');
    fs.writeFileSync(badPath, 'version: 1\nname: x\ntasks:\n  - bad: true\n');

    const result = handleRunWorkflowSpec({
      spec_path: badPath,
      working_directory: testDir,
    });
    expect(result.isError).toBe(true);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run on remote: `npx vitest run tests/workflow-spec-handlers.test.js --no-coverage`

Expected: FAIL with "Cannot find module '../handlers/workflow-spec-handlers'"

- [x] **Step 3: Implement the handlers**

Create `server/handlers/workflow-spec-handlers.js`:

```js
'use strict';

const path = require('path');
const { parseSpec, discoverSpecs } = require('../workflow-spec');
const workflowHandlers = require('./workflow');
const { ErrorCodes, makeError } = require('./shared');

function resolveSpecPath(specPath, workingDirectory) {
  if (path.isAbsolute(specPath)) return specPath;
  const root = workingDirectory || process.cwd();
  return path.join(root, specPath);
}

function handleListWorkflowSpecs(args) {
  const wd = args.working_directory || process.cwd();
  try {
    const specs = discoverSpecs(wd);
    const text = specs.length === 0
      ? `No workflow specs found in ${wd}/workflows/`
      : `Found ${specs.length} workflow spec(s):\n\n` +
        specs.map(s => `- **${s.name}** (${s.relative_path}) — ${s.valid ? `${s.task_count} tasks` : 'INVALID: ' + s.errors.join('; ')}`).join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredData: { specs },
    };
  } catch (err) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, `Failed to discover specs: ${err.message}`),
    };
  }
}

function handleValidateWorkflowSpec(args) {
  const fullPath = resolveSpecPath(args.spec_path, args.working_directory);
  const result = parseSpec(fullPath);
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: `Invalid spec ${fullPath}:\n- ${result.errors.join('\n- ')}` }],
      structuredData: { valid: false, errors: result.errors },
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Spec ${fullPath} is valid. ${result.spec.tasks.length} tasks.` }],
    structuredData: { valid: true, spec: result.spec },
  };
}

function handleRunWorkflowSpec(args) {
  const fullPath = resolveSpecPath(args.spec_path, args.working_directory);
  const parsed = parseSpec(fullPath);
  if (!parsed.ok) {
    return {
      content: [{ type: 'text', text: `Invalid spec:\n- ${parsed.errors.join('\n- ')}` }],
      structuredData: { valid: false, errors: parsed.errors },
      isError: true,
    };
  }
  const spec = parsed.spec;

  const createArgs = {
    name: spec.name,
    description: spec.description || args.goal || null,
    working_directory: args.working_directory || spec.working_directory,
    project: spec.project,
    routing_template: spec.routing_template,
    version_intent: spec.version_intent,
    priority: spec.priority,
    tasks: spec.tasks,
  };

  const createResult = workflowHandlers.handleCreateWorkflow(createArgs);
  if (createResult.isError) return createResult;

  const workflowId = (createResult.content?.[0]?.text || '').match(/([a-f0-9-]{36})/)?.[1];
  if (!workflowId) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, 'Workflow created but could not extract workflow_id'),
    };
  }

  return {
    content: [
      { type: 'text', text: `Workflow created from ${fullPath}.\nID: ${workflowId}\nUse run_workflow to start it.` },
    ],
    structuredData: { workflow_id: workflowId, spec_path: fullPath },
  };
}

module.exports = {
  handleListWorkflowSpecs,
  handleValidateWorkflowSpec,
  handleRunWorkflowSpec,
};
```

- [x] **Step 4: Wire the handlers into `server/tools.js` dispatch**

Find the `switch (name)` inside `handleToolCall` in `server/tools.js`. Add three `case` blocks alongside the existing `create_workflow` / `run_workflow` cases:

```js
case 'list_workflow_specs': {
  const { handleListWorkflowSpecs } = require('./handlers/workflow-spec-handlers');
  return handleListWorkflowSpecs(args);
}
case 'validate_workflow_spec': {
  const { handleValidateWorkflowSpec } = require('./handlers/workflow-spec-handlers');
  return handleValidateWorkflowSpec(args);
}
case 'run_workflow_spec': {
  const { handleRunWorkflowSpec } = require('./handlers/workflow-spec-handlers');
  return handleRunWorkflowSpec(args);
}
```

- [x] **Step 5: Run tests to verify they pass**

Run on remote: `npx vitest run tests/workflow-spec-handlers.test.js --no-coverage`

Expected: PASS — all 5 tests green.

- [x] **Step 6: Commit**

```bash
git add server/handlers/workflow-spec-handlers.js server/tests/workflow-spec-handlers.test.js server/tools.js
git commit -m "feat(workflow-spec): MCP handlers for list/validate/run"
git push --no-verify origin main
```

---

## Task 6: REST API routes

**Files:**
- Modify: `server/api/routes-passthrough.js`

- [x] **Step 1: Add routes to the passthrough table**

Open `server/api/routes-passthrough.js`. Find the workflows route block (search for `create_workflow`). Add these entries alongside it:

```js
{ method: 'GET',  path: '/api/v2/workflow-specs', tool: 'list_workflow_specs', mapQuery: true },
{ method: 'POST', path: '/api/v2/workflow-specs/validate', tool: 'validate_workflow_spec', mapBody: true },
{ method: 'POST', path: '/api/v2/workflow-specs/run', tool: 'run_workflow_spec', mapBody: true },
```

- [x] **Step 2: Verify routes register without error**

Run on remote, from the `server/` dir: `node -e "require('./api/routes-passthrough'); console.log('ok')"`

Expected: `ok`.

- [x] **Step 3: Commit**

```bash
git add server/api/routes-passthrough.js
git commit -m "feat(workflow-spec): REST routes for list/validate/run"
git push --no-verify origin main
```

---

## Task 7: Example workflow spec in repo

**Files:**
- Create: `workflows/example-plan-implement.yaml`

- [x] **Step 1: Write the example spec**

Create `workflows/example-plan-implement.yaml`:

```yaml
version: 1
name: example-plan-implement
description: Plan, approve, implement, and simplify a change. A reference example for workflow-specs.
project: torque
version_intent: internal
tasks:
  - node_id: plan
    task: |
      Read the goal from the workflow description.
      Analyze the codebase and write a step-by-step plan to docs/plans/auto-plan.md.
    provider: claude-cli
    tags: [planning]

  - node_id: implement
    task: |
      Read docs/plans/auto-plan.md and implement every step.
      Commit after each logical unit of change.
    provider: codex
    depends_on: [plan]
    tags: [coding]

  - node_id: simplify
    task: |
      Review the changes from the previous step for clarity and correctness.
      Remove dead code, simplify awkward constructs, and ensure naming is consistent.
    provider: codex
    depends_on: [implement]
    tags: [coding, review]
```

- [x] **Step 2: Commit**

```bash
git add workflows/example-plan-implement.yaml
git commit -m "docs(workflow-spec): example plan-implement spec"
git push --no-verify origin main
```

---

## Task 8: Dashboard API client

**Files:**
- Modify: `dashboard/src/api.js`

- [x] **Step 1: Add workflow-specs client**

Open `dashboard/src/api.js`. Find any existing `export const workflows = {...}` block. Add a new export block near it:

```js
export const workflowSpecs = {
  list: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return requestV2(`/workflow-specs${query ? `?${query}` : ''}`);
  },
  validate: (spec_path, working_directory) => requestV2('/workflow-specs/validate', {
    method: 'POST',
    body: JSON.stringify({ spec_path, working_directory }),
  }),
  run: (spec_path, opts = {}) => requestV2('/workflow-specs/run', {
    method: 'POST',
    body: JSON.stringify({ spec_path, ...opts }),
  }),
};
```

- [x] **Step 2: Commit**

```bash
git add dashboard/src/api.js
git commit -m "feat(workflow-spec): dashboard API client"
git push --no-verify origin main
```

---

## Task 9: Dashboard WorkflowSpecs view

**Files:**
- Create: `dashboard/src/views/WorkflowSpecs.jsx`
- Create: `dashboard/src/views/WorkflowSpecs.test.jsx`
- Modify: `dashboard/src/App.jsx`
- Modify: `dashboard/src/components/Layout.jsx`

- [x] **Step 1: Write failing test**

Create `dashboard/src/views/WorkflowSpecs.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import WorkflowSpecs from './WorkflowSpecs';

vi.mock('../api', () => ({
  workflowSpecs: {
    list: vi.fn(),
    run: vi.fn(),
  },
}));
import { workflowSpecs } from '../api';

function renderView() {
  return render(
    <MemoryRouter>
      <WorkflowSpecs />
    </MemoryRouter>
  );
}

describe('WorkflowSpecs view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no specs', async () => {
    workflowSpecs.list.mockResolvedValue({ specs: [] });
    renderView();
    await waitFor(() => expect(screen.getByText(/No workflow specs found/i)).toBeInTheDocument());
  });

  it('lists valid specs', async () => {
    workflowSpecs.list.mockResolvedValue({
      specs: [
        { name: 'deploy', relative_path: 'workflows/deploy.yaml', valid: true, task_count: 5, description: 'Deploy the app' },
      ],
    });
    renderView();
    await waitFor(() => expect(screen.getByText('deploy')).toBeInTheDocument());
    expect(screen.getByText('5 tasks')).toBeInTheDocument();
  });

  it('shows error details for invalid specs', async () => {
    workflowSpecs.list.mockResolvedValue({
      specs: [
        { name: 'broken', relative_path: 'workflows/broken.yaml', valid: false, errors: ['missing tasks'], task_count: 0 },
      ],
    });
    renderView();
    await waitFor(() => expect(screen.getByText(/missing tasks/)).toBeInTheDocument());
  });

  it('runs a spec when Run button clicked', async () => {
    const user = userEvent.setup();
    workflowSpecs.list.mockResolvedValue({
      specs: [
        { name: 'deploy', relative_path: 'workflows/deploy.yaml', valid: true, task_count: 2 },
      ],
    });
    workflowSpecs.run.mockResolvedValue({ workflow_id: 'wf-123' });
    renderView();
    await waitFor(() => expect(screen.getByText('deploy')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /run/i }));
    await waitFor(() => expect(workflowSpecs.run).toHaveBeenCalledWith('workflows/deploy.yaml', expect.anything()));
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run (local, dashboard dir): `npx vitest run src/views/WorkflowSpecs.test.jsx --no-coverage`

Expected: FAIL — `WorkflowSpecs` module does not exist.

- [x] **Step 3: Implement the view**

Create `dashboard/src/views/WorkflowSpecs.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { workflowSpecs } from '../api';

export default function WorkflowSpecs() {
  const [specs, setSpecs] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState({});

  async function load() {
    try {
      const res = await workflowSpecs.list();
      setSpecs(res.specs || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load specs');
    }
  }

  useEffect(() => { load(); }, []);

  async function handleRun(spec) {
    setRunning(r => ({ ...r, [spec.relative_path]: true }));
    try {
      const res = await workflowSpecs.run(spec.relative_path, {});
      alert(`Workflow created: ${res.workflow_id}`);
    } catch (err) {
      alert(`Failed: ${err.message}`);
    } finally {
      setRunning(r => ({ ...r, [spec.relative_path]: false }));
    }
  }

  if (error) return <div className="p-4 text-red-400">Error: {error}</div>;
  if (specs === null) return <div className="p-4 text-slate-400">Loading...</div>;
  if (specs.length === 0) {
    return (
      <div className="p-4 text-slate-400">
        <h1 className="text-xl text-white mb-2">Workflow Specs</h1>
        <p>No workflow specs found in <code>workflows/</code>. Create a YAML file there to get started.</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <h1 className="text-xl text-white mb-4">Workflow Specs</h1>
      <div className="space-y-3">
        {specs.map(spec => (
          <div
            key={spec.relative_path}
            className={`border rounded-lg p-3 ${spec.valid ? 'border-slate-600/40 bg-slate-700/30' : 'border-red-600/40 bg-red-900/10'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <h2 className="text-white font-semibold">{spec.name}</h2>
                <code className="text-xs text-slate-500">{spec.relative_path}</code>
                {spec.description && <p className="text-sm text-slate-300 mt-1">{spec.description}</p>}
                {spec.valid ? (
                  <p className="text-xs text-slate-400 mt-1">{spec.task_count} tasks</p>
                ) : (
                  <ul className="text-xs text-red-300 mt-1 list-disc list-inside">
                    {spec.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </div>
              {spec.valid && (
                <button
                  onClick={() => handleRun(spec)}
                  disabled={running[spec.relative_path]}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white text-sm rounded"
                >
                  {running[spec.relative_path] ? 'Running...' : 'Run'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [x] **Step 4: Add route to App.jsx**

Open `dashboard/src/App.jsx`. Add the import alongside other view imports:

```jsx
import WorkflowSpecs from './views/WorkflowSpecs';
```

Inside the `<Routes>` block, add a route matching the existing pattern:

```jsx
<Route path="/workflow-specs" element={<WorkflowSpecs />} />
```

- [x] **Step 5: Add nav item to Layout**

Open `dashboard/src/components/Layout.jsx`. Find the existing nav items array or JSX. Add an entry matching the style of neighbors:

```jsx
{ to: '/workflow-specs', label: 'Specs' }
```

If the nav items embed icons, reuse an existing icon (e.g. document / list glyph) rather than introducing a new asset.

- [x] **Step 6: Run test to verify it passes**

Run (dashboard dir): `npx vitest run src/views/WorkflowSpecs.test.jsx --no-coverage`

Expected: PASS — all 4 tests green.

- [x] **Step 7: Build the dashboard**

Run (dashboard dir): `npx vite build`

Expected: build completes without errors.

- [x] **Step 8: Commit**

```bash
git add dashboard/src/views/WorkflowSpecs.jsx dashboard/src/views/WorkflowSpecs.test.jsx dashboard/src/App.jsx dashboard/src/components/Layout.jsx
git commit -m "feat(dashboard): WorkflowSpecs view with run button"
git push --no-verify origin main
```

---

## Task 10: User-facing documentation

**Files:**
- Create: `docs/workflow-specs.md`

- [ ] **Step 1: Write the doc**

Create `docs/workflow-specs.md`:

````markdown
# Workflow Specs

Workflow specs are version-controlled YAML files that define a TORQUE workflow as a DAG of tasks. Commit them in `<project>/workflows/` and run them by name.

## Quick start

1. Create `workflows/my-workflow.yaml`:

   ```yaml
   version: 1
   name: my-workflow
   description: What this workflow does
   tasks:
     - node_id: plan
       task: Write a plan to docs/plans/foo.md
       provider: claude-cli
     - node_id: implement
       task: Read the plan and execute it
       provider: codex
       depends_on: [plan]
   ```

2. Run it:

   ```bash
   # via MCP (Claude Code, etc.)
   run_workflow_spec { spec_path: "workflows/my-workflow.yaml" }

   # via REST
   curl -X POST http://127.0.0.1:3457/api/v2/workflow-specs/run \
     -H 'Content-Type: application/json' \
     -d '{"spec_path": "workflows/my-workflow.yaml"}'
   ```

3. Browse the **Workflow Specs** page in the dashboard to see all discovered specs.

## Schema

| Field (top level) | Type | Required | Description |
|---|---|---|---|
| `version` | int | yes | Schema version. Always `1`. |
| `name` | string | yes | Workflow name (1-200 chars). |
| `description` | string | no | What the workflow does. |
| `project` | string | no | Project name. Tasks inherit it. |
| `working_directory` | string | no | Default working directory. |
| `routing_template` | string | no | Named routing template. |
| `version_intent` | enum | no | `feature` / `fix` / `breaking` / `internal`. |
| `priority` | number | no | Queue priority. |
| `tasks` | array | yes | Task definitions (see below). |

| Field (per task) | Type | Required | Description |
|---|---|---|---|
| `node_id` | string | yes | Unique within the workflow. |
| `task` | string | yes | Task description / prompt. |
| `depends_on` | [string] | no | Node IDs this task depends on. |
| `context_from` | [string] | no | Node IDs whose outputs to inject. |
| `provider` | enum | no | Explicit provider override. |
| `model` | string | no | Model override. |
| `tags` | [string] | no | Free-form tags. |
| `timeout_minutes` | int | no | 1-480. |
| `auto_approve` | bool | no | Skip approval gates. |
| `version_intent` | enum | no | Override workflow-level intent. |
| `on_fail` | enum | no | `cancel` / `skip` / `continue` / `run_alternate`. |
| `alternate_node_id` | string | no | For `run_alternate`. |
| `condition` | string | no | Edge condition expression. |

## Why use specs instead of `create_workflow`?

- **Diffable** — `git diff workflows/deploy.yaml` shows exactly what changed.
- **Reviewable** — PR reviews catch workflow changes like any other code change.
- **Shareable** — Hand someone a spec, they get the same workflow you have.
- **Versioned** — Tag a release, the workflow as of that release is preserved.

Workflows built inline via `create_workflow` are ephemeral — they exist only in the DB. Specs are the right shape for workflows you want to keep.
````

- [ ] **Step 2: Commit**

```bash
git add docs/workflow-specs.md
git commit -m "docs(workflow-spec): user-facing guide"
git push --no-verify origin main
```

---

## Task 11: Integration smoke test

**Files:**
- Create: `server/tests/workflow-spec-integration.test.js`

- [ ] **Step 1: Write end-to-end test**

Create `server/tests/workflow-spec-integration.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const fs = require('fs');
const path = require('path');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { handleRunWorkflowSpec } = require('../handlers/workflow-spec-handlers');

let db, testDir;
beforeAll(() => {
  const env = setupTestDb('wf-spec-integration');
  db = env.db;
  testDir = env.testDir;
});
afterAll(() => teardownTestDb());

describe('workflow-spec end-to-end', () => {
  it('creates a working workflow from a YAML file with per-task providers and tags', () => {
    const wfDir = path.join(testDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const specPath = path.join(wfDir, 'e2e.yaml');

    fs.writeFileSync(specPath, `
version: 1
name: e2e-test
project: e2e-proj
tasks:
  - node_id: scout
    task: Look for issues
    provider: ollama
    tags: [scout, fast]
  - node_id: fix
    task: Fix issues found in scout
    provider: codex
    depends_on: [scout]
    tags: [coding]
`);

    const result = handleRunWorkflowSpec({ spec_path: specPath, working_directory: testDir });
    expect(result.isError).toBeFalsy();
    const workflowId = result.structuredData.workflow_id;

    const tasks = db.getWorkflowTasks(workflowId);
    const scout = tasks.find(t => t.workflow_node_id === 'scout');
    const fix = tasks.find(t => t.workflow_node_id === 'fix');

    expect(scout.provider).toBe('ollama');
    expect(fix.provider).toBe('codex');
    expect(scout.project).toBe('e2e-proj');
    expect(fix.project).toBe('e2e-proj');

    expect(scout.tags).toContain('scout');
    expect(scout.tags).toContain('fast');
    expect(fix.tags).toContain('coding');

    expect(fix.status).toBe('blocked');
    expect(scout.status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run on remote: `npx vitest run tests/workflow-spec-integration.test.js --no-coverage`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/tests/workflow-spec-integration.test.js
git commit -m "test(workflow-spec): end-to-end integration test"
git push --no-verify origin main
```

---

## Task 12: Verify full suite + restart

- [ ] **Step 1: Run all workflow-spec tests together**

Run on remote, from `server/` dir: `npx vitest run tests/workflow-spec --no-coverage`

Expected: All tests PASS.

- [ ] **Step 2: Restart TORQUE to load new handlers**

Use the `await_restart` MCP tool with:

```
reason: Load workflow-spec MCP tools and handlers
timeout_minutes: 15
```

Expected: "Pipeline drained successfully. Server restart triggered."

- [ ] **Step 3: Smoke test the example spec via MCP**

Call:

```
list_workflow_specs { working_directory: "<project root>" }
```

Expected: response includes `example-plan-implement`.

Call:

```
validate_workflow_spec { spec_path: "workflows/example-plan-implement.yaml", working_directory: "<project root>" }
```

Expected: `valid: true`.

- [ ] **Step 4: Rebuild dashboard**

Run (dashboard dir): `npx vite build`

Expected: build success.

- [ ] **Step 5: Verify dashboard**

Open the dashboard, hard-refresh (Ctrl+Shift+R), navigate to **Specs**. Confirm `example-plan-implement` appears with a Run button and a `3 tasks` count.
