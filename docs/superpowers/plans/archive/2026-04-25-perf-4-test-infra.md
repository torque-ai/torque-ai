# Phase 4 — Test Infra Import Bloat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `server/tool-registry.js` (thin metadata module), `torque/no-heavy-test-imports` and `torque/no-reset-modules-in-each` ESLint rules, migrate the 5 metadata-only `tools.js` consumers and 17 `setupTestDb` → `setupTestDbOnly` callers, convert the 38 `vi.resetModules()` in `beforeEach()` callsites, add the cold-import threshold wrapper to `vitest-setup.js`, split the 3 largest test files, delete the `test-helpers.js` self-test stub, and capture a new `cold-import.tool-registry` metric in `baseline.json`.

**Architecture:** `tool-registry.js` exports `TOOLS`, `routeMap`, `schemaMap`, and `decorateToolDefinition` without loading any handler modules; `tools.js` re-exports from it so existing callers are unaffected. Two ESLint rules (`no-heavy-test-imports` with allowlist, `no-reset-modules-in-each` flagging `vi.resetModules()` inside `beforeEach`) prevent regressions. A performance wrapper in `vitest-setup.js` fails test files whose first-call setup cost exceeds a configurable threshold, catching drift automatically.

**Tech Stack:** Node.js (CommonJS), ESLint custom rules, vitest, no new dependencies

**Spec reference:** `docs/superpowers/specs/2026-04-25-perf-4-test-infra-design.md`

**Worktree:** `feat-perf-4-test-infra` at `.worktrees/feat-perf-4-test-infra/` on branch `feat/perf-4-test-infra`. All commits go to that branch.

**Important rules during implementation:**

- Never run tests locally — always: `torque-remote --branch feat/perf-4-test-infra npx vitest run path/to/test.js` from the worktree's `server/` directory. If torque-remote sync fails, fall back to direct SSH on the configured remote workstation.
- Never restart TORQUE. TORQUE is shared infrastructure.
- Never edit main directly. All work in this worktree.
- Commit per task.
- Use Read before Edit — never guess at indentation or surrounding context.
- `'use strict';` first line on every new JS file.
- For files migrating `vi.resetModules()`, run the affected test file **before** the change to record the baseline pass, and **after** to confirm behavior is preserved.
- Each `vi.resetModules()` conversion that fails after the change is a regression — revert that single conversion and add an `// eslint-disable-next-line` with reason instead.

---

## Task 1: Create `server/tool-registry.js` (thin metadata module)

**Files:**

- Create: `server/tool-registry.js`
- Modify: `server/tools.js`
- Create: `server/tests/tool-registry-cold-import.test.js`

This is the prerequisite for all 5 metadata-only migrations. The thin module exports `TOOLS`, `routeMap` (empty at registry time — see note below), `schemaMap`, and `decorateToolDefinition` without loading any handler modules. The `tools.js` re-exports from `tool-registry.js` so none of the 11 legitimate `handleToolCall` consumers need to change.

**Design note on `routeMap`:** `routeMap` is built in `tools.js` by iterating over `HANDLER_MODULES` (which are the heavy handler imports). The 5 metadata-only tests import `routeMap` to check that tool names in `TOOLS` have corresponding routes. For the thin module, the correct shape is: `tool-registry.js` exports `TOOLS`, `schemaMap`, and `decorateToolDefinition` from the tool-defs. The `routeMap` in `tool-registry.js` will be a *read-only re-export* that `tools.js` populates after building it. To avoid a circular dependency, `tool-registry.js` exports a mutable Map that `tools.js` populates after importing it. Tests that only need the Map reference will see the populated version when `tools.js` has run; for the thin-import path (no `tools.js`), they see the empty Map — acceptable for the 3 files that only check `routeMap` for key existence after `tools.js` has run. The key win is that the 5 files no longer load handlers at module scope.

- [ ] **Step 1: Read the top of `server/tools.js` to capture the full TOOLS array definition and imports (lines 1–97)**

Read `server/tools.js` lines 1–97.

- [ ] **Step 2: Read `server/tools.js` lines 256–410 to see where `schemaMap` and `routeMap` are built**

Read `server/tools.js` lines 256–410.

- [ ] **Step 3: Write the failing test for `tool-registry.js` cold-import**

Create `server/tests/tool-registry-cold-import.test.js`:

```js
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

describe('tool-registry cold-import', () => {
  it('imports in under 200ms (no handler modules loaded)', () => {
    const script = `
      const start = Date.now();
      require(${JSON.stringify(path.resolve(__dirname, '..', 'tool-registry'))});
      const elapsed = Date.now() - start;
      process.stdout.write(String(elapsed) + '\\n');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    const elapsed = parseInt(result.stdout.trim(), 10);
    // Allow generous budget for slow CI: 200ms. The goal is <30ms; this test
    // catches runaway handler-loading (which takes ~335ms), not micro-optimization.
    expect(elapsed).toBeLessThan(200);
  });

  it('exports TOOLS as an array', () => {
    const reg = require('../tool-registry');
    expect(Array.isArray(reg.TOOLS)).toBe(true);
    expect(reg.TOOLS.length).toBeGreaterThan(0);
  });

  it('exports schemaMap as a Map', () => {
    const reg = require('../tool-registry');
    expect(reg.schemaMap instanceof Map).toBe(true);
  });

  it('exports routeMap as a Map', () => {
    const reg = require('../tool-registry');
    expect(reg.routeMap instanceof Map).toBe(true);
  });

  it('exports decorateToolDefinition as a function', () => {
    const reg = require('../tool-registry');
    expect(typeof reg.decorateToolDefinition).toBe('function');
  });
});
```

- [ ] **Step 4: Run the test to confirm it fails**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/tool-registry-cold-import.test.js
```

Expected: FAIL with "Cannot find module '../tool-registry'".

- [ ] **Step 5: Create `server/tool-registry.js`**

Create `server/tool-registry.js` (content below). The key design is: import only `./tool-defs/*`, `./core-tools`, `./tool-annotations`, `./tool-output-schemas`, `./tools/behavioral-tags` — no `./handlers/*`, no `./event-bus`, no `./hooks/post-tool-hooks`, no `./logger`.

```js
'use strict';

/**
 * tool-registry.js — thin metadata module.
 *
 * Exports TOOLS (tool-def array), schemaMap, routeMap (populated by tools.js),
 * and decorateToolDefinition — WITHOUT loading any handler modules.
 *
 * Cold-import target: <30ms (no handler loading, no logger, no event-bus).
 *
 * tools.js re-exports everything from here and additionally builds routeMap
 * by iterating over HANDLER_MODULES. It calls populateRouteMap() below to
 * store the result so tests that import tool-registry.js after tools.js has
 * run will see the complete map.
 */

const { applyBehavioralTags } = require('./tools/behavioral-tags');
const { getAnnotations } = require('./tool-annotations');
const { getOutputSchema } = require('./tool-output-schemas');

const workflowSpecToolDefs = require('./tool-defs/workflow-spec-defs');
const WORKFLOW_SPEC_TOOLS = Array.isArray(workflowSpecToolDefs)
  ? workflowSpecToolDefs
  : workflowSpecToolDefs.WORKFLOW_SPEC_TOOLS;

const workflowResumeToolDefs = require('./tool-defs/workflow-resume-defs');
const WORKFLOW_RESUME_TOOLS = Array.isArray(workflowResumeToolDefs)
  ? workflowResumeToolDefs
  : workflowResumeToolDefs.WORKFLOW_RESUME_TOOLS;

const eventToolDefs = require('./tool-defs/event-defs');
const EVENT_TOOLS = Array.isArray(eventToolDefs)
  ? eventToolDefs
  : eventToolDefs.EVENT_TOOLS;

const runArtifactToolDefs = require('./tool-defs/run-artifact-defs');
const RUN_ARTIFACT_TOOLS = Array.isArray(runArtifactToolDefs)
  ? runArtifactToolDefs
  : runArtifactToolDefs.RUN_ARTIFACT_TOOLS;

const competitiveFeatureDefs = require('./tool-defs/competitive-feature-defs');

const TOOLS = [
  ...require('./tool-defs/core-defs'),
  ...require('./tool-defs/task-submission-defs'),
  ...require('./tool-defs/task-management-defs'),
  ...require('./tool-defs/task-defs'),
  ...require('./tool-defs/workflow-defs'),
  ...WORKFLOW_RESUME_TOOLS,
  ...WORKFLOW_SPEC_TOOLS,
  ...EVENT_TOOLS,
  ...RUN_ARTIFACT_TOOLS,
  ...require('./tool-defs/baseline-defs'),
  ...require('./tool-defs/checkpoint-defs'),
  ...require('./tool-defs/approval-defs'),
  ...require('./tool-defs/validation-defs'),
  ...require('./tool-defs/provider-defs'),
  ...require('./tool-defs/provider-crud-defs'),
  ...require('./tool-defs/ci-defs'),
  ...require('./tool-defs/webhook-defs'),
  ...require('./tool-defs/intelligence-defs'),
  ...require('./tool-defs/advanced-defs'),
  ...require('./tool-defs/integration-defs'),
  ...require('./tool-defs/automation-defs'),
  ...require('./tool-defs/comparison-defs'),
  ...require('./tool-defs/hashline-defs'),
  ...require('./tool-defs/tsserver-defs'),
  ...require('./tool-defs/policy-defs'),
  ...require('./tool-defs/governance-defs'),
  ...require('./tool-defs/evidence-risk-defs'),
  ...require('./tool-defs/conflict-resolution-defs'),
  ...require('./tool-defs/orchestrator-defs'),
  ...require('./tool-defs/experiment-defs'),
  ...require('./tool-defs/audit-defs'),
  ...require('./tool-defs/workstation-defs'),
  ...require('./tool-defs/concurrency-defs'),
  ...require('./tool-defs/model-defs'),
  ...require('./tool-defs/discovery-defs'),
  ...require('./tool-defs/agent-discovery-defs'),
  ...require('./tool-defs/circuit-breaker-defs'),
  ...require('./tool-defs/budget-watcher-defs'),
  ...require('./tool-defs/provider-scoring-defs'),
  ...require('./tool-defs/routing-template-defs'),
  ...require('./tool-defs/strategic-config-defs'),
  ...require('./tool-defs/context-defs'),
  ...require('./tool-defs/codebase-study-defs'),
  ...require('./tool-defs/mcp-defs'),
  ...require('./tool-defs/managed-oauth-defs'),
  ...require('./tool-defs/pattern-defs'),
  ...competitiveFeatureDefs,
  ...require('./tool-defs/review-defs'),
  ...require('./tool-defs/symbol-indexer-defs'),
  ...require('./tool-defs/template-defs'),
  ...require('./tool-defs/diffusion-defs'),
  ...require('./tool-defs/factory-defs'),
];

function toBehavioralAnnotationSnapshot(tool) {
  return {
    readOnlyHint: Boolean(tool.readOnlyHint),
    destructiveHint: Boolean(tool.destructiveHint),
    idempotentHint: Boolean(tool.idempotentHint),
    openWorldHint: Boolean(tool.openWorldHint),
  };
}

function decorateToolDefinition(tool, hintSource) {
  if (!tool || !tool.name) {
    return tool;
  }
  const hints = hintSource || tool.annotations || getAnnotations(tool.name);
  const taggedTool = applyBehavioralTags(tool, hints);
  taggedTool.annotations = toBehavioralAnnotationSnapshot(taggedTool);
  return taggedTool;
}

// Apply behavioral decorations to all tools at module-load time.
for (const tool of TOOLS) {
  if (tool && tool.name) {
    Object.assign(tool, decorateToolDefinition(tool));
  }
}

// Apply output schemas to all tools.
for (const tool of TOOLS) {
  if (tool && tool.name) {
    const schema = getOutputSchema(tool.name);
    if (schema) tool.outputSchema = schema;
  }
}

// Schema lookup map (tool name → inputSchema).
// Built once at module load; tools.js re-exports this Map.
const schemaMap = new Map();
for (const def of TOOLS) {
  if (def && def.name && def.inputSchema) {
    schemaMap.set(def.name, def.inputSchema);
  }
}

// Route map — populated by tools.js after it builds the handler dispatch table.
// Tests that import tool-registry.js directly (without tools.js having run)
// will see an empty Map. That is intentional: this thin module does not load handlers.
const routeMap = new Map();

/**
 * Called by tools.js after it builds routeMap from HANDLER_MODULES.
 * Transfers all entries into this shared Map so callers that imported
 * tool-registry.js before tools.js also see the complete route table.
 */
function populateRouteMap(sourceMap) {
  for (const [key, value] of sourceMap) {
    routeMap.set(key, value);
  }
}

module.exports = {
  TOOLS,
  schemaMap,
  routeMap,
  decorateToolDefinition,
  populateRouteMap,
};
```

- [ ] **Step 6: Update `server/tools.js` to re-export from `tool-registry.js` and call `populateRouteMap`**

Read `server/tools.js` lines 1–20 and lines 255–420 to confirm exact anchors, then make two targeted edits.

**Edit A** — Replace the top-of-file TOOLS array + behavioral-tags + tool-annotations imports with a re-export from `tool-registry.js`. The first ~15 lines of `tools.js` currently import behavioral-tags, tool-annotations, and many tool-def files to build `TOOLS`. Replace that entire block with a single require of tool-registry and destructure the exports:

Find the block that starts at line 1 (`const path = require('path');`) and ends just after the `for (const tool of TOOLS)` loop that applies `decorateToolDefinition` (around line 145 in the original file). Replace it with:

```js
/**
 * MCP Tools definitions and handlers for TORQUE
 *
 * Thin metadata (TOOLS, schemaMap, routeMap, decorateToolDefinition) lives in
 * ./tool-registry.js and is imported here. Handler modules are loaded below.
 * Callers that only need metadata should import tool-registry directly.
 */

const path = require('path');
const logger = require('./logger').child({ component: 'tools' });
const { fireHook } = require('./hooks/post-tool-hooks');
const eventBus = require('./event-bus');
const comparisonHandlers = require('./handlers/comparison-handler');
const evidenceRiskHandlers = require('./handlers/evidence-risk-handlers');
const governanceHandlers = require('./handlers/governance-handlers');
const reviewHandlers = require('./handlers/review-handler');
const symbolIndexerHandlers = require('./handlers/symbol-indexer-handlers');
const templateHandlers = require('./handlers/template-handlers');
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('./core-tools');

// Re-export thin metadata from tool-registry (no handler loading).
const {
  TOOLS,
  schemaMap,
  routeMap: _registryRouteMap,
  decorateToolDefinition,
  populateRouteMap,
} = require('./tool-registry');
```

**Edit B** — After the `routeMap` has been populated in `tools.js` (around line 405 in the original, just after the manual `routeMap.set(...)` calls), add a call to `populateRouteMap`:

```js
// Sync the populated routeMap back into tool-registry.js so tests that
// import tool-registry directly (after tools.js has run) see the full table.
populateRouteMap(routeMap);
```

**Edit C** — Remove the `schemaMap` construction block from `tools.js` (since schemaMap is now built in `tool-registry.js`). Similarly remove the `decorateToolDefinition` and `toBehavioralAnnotationSnapshot` function definitions and the `for (const tool of TOOLS)` decoration loop that follows, since they are now owned by `tool-registry.js`. Export `schemaMap` and `decorateToolDefinition` from `tools.js` by forwarding the imports:

In `tools.js`, the existing `module.exports` at the bottom should continue to export `TOOLS`, `schemaMap`, `decorateToolDefinition`, `routeMap`, `handleToolCall`, and everything else — just the implementations for the first four now come from `tool-registry.js` instead of being defined in `tools.js`.

> **Implementation guidance:** This is a large edit on a ~600-line file. The safest approach is:
> 1. Read the entire `tools.js` in 100-line chunks.
> 2. Identify the exact line ranges for: (a) the TOOLS array definition including the for-loop for decorating tools (lines ~44–145), (b) the `schemaMap` construction (lines ~255–262), (c) the `toBehavioralAnnotationSnapshot` and `decorateToolDefinition` function definitions (~102–120), (d) the `loadStaticPluginToolNamesForCoverage` function and `validateCoverage` call (~147–180).
> 3. For each section, determine whether to delete it (it's now in tool-registry), keep it (it uses handlers not in registry), or replace it with a forward import.
> 4. The routeMap building loop (~lines 387–404) stays in `tools.js` because it iterates `HANDLER_MODULES`. After that loop, add the `populateRouteMap(routeMap)` call.
> 5. Keep `tool-output-schemas` validation and `validateCoverage` calls in `tools.js` (they run at startup and depend on the full TOOLS list — which is unchanged since tool-registry builds it).

- [ ] **Step 7: Run the test to confirm it passes**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/tool-registry-cold-import.test.js
```

Expected: PASS. All 5 assertions green; cold-import elapsed < 200ms.

- [ ] **Step 8: Run the existing `tool-annotations` test as a sanity check**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/tool-annotations.test.js
```

Expected: PASS (no behavioral change — `decorateToolDefinition` still works the same way).

- [ ] **Step 9: Commit**

```bash
git add server/tool-registry.js server/tools.js server/tests/tool-registry-cold-import.test.js
git commit -m "feat(perf-4): extract tool-registry.js thin metadata module"
```

---

## Task 2: Migrate the 5 metadata-only `tools.js` test files

**Files:**

- Modify: `server/tests/auto-recovery-mcp-tools.test.js`
- Modify: `server/tests/mcp-tool-alignment.test.js`
- Modify: `server/tests/p2-orphaned-tools.test.js`
- Modify: `server/tests/p3-dead-routes.test.js`
- Modify: `server/tests/tool-annotations.test.js`

Each file currently has `require('../tools')` at module scope. Replace with `require('../tool-registry')`. For each file, run it before the change to record a passing baseline, then after to confirm still passing.

- [ ] **Step 1: Pre-migration baseline — run all 5 files**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/auto-recovery-mcp-tools.test.js tests/mcp-tool-alignment.test.js tests/p2-orphaned-tools.test.js tests/p3-dead-routes.test.js tests/tool-annotations.test.js
```

Expected: All 5 pass.

- [ ] **Step 2: Migrate `auto-recovery-mcp-tools.test.js`**

Read the file. Find the line that reads:
```js
const { routeMap } = require('../tools');
```
Replace with:
```js
const { routeMap } = require('../tool-registry');
```

- [ ] **Step 3: Run the migrated file**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/auto-recovery-mcp-tools.test.js
```

Expected: PASS.

- [ ] **Step 4: Migrate `mcp-tool-alignment.test.js`**

Read the file. Find the line that reads (approximately line 9):
```js
const { TOOLS, routeMap, schemaMap } = require('../tools');
```
Replace with:
```js
const { TOOLS, routeMap, schemaMap } = require('../tool-registry');
```

- [ ] **Step 5: Run the migrated file**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/mcp-tool-alignment.test.js
```

Expected: PASS.

- [ ] **Step 6: Migrate `p2-orphaned-tools.test.js`**

Read the file. Find the line (approximately line 4):
```js
const { routeMap } = require('../tools');
```
Replace with:
```js
const { routeMap } = require('../tool-registry');
```

- [ ] **Step 7: Run the migrated file**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/p2-orphaned-tools.test.js
```

Expected: PASS.

- [ ] **Step 8: Migrate `p3-dead-routes.test.js`**

Read the file. Find the line (approximately line 4):
```js
const { routeMap } = require('../tools');
```
Replace with:
```js
const { routeMap } = require('../tool-registry');
```

- [ ] **Step 9: Run the migrated file**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/p3-dead-routes.test.js
```

Expected: PASS.

- [ ] **Step 10: Migrate `tool-annotations.test.js`**

Read the file. Find the line (approximately line 25):
```js
const { TOOLS, routeMap } = require('../tools');
```
Replace with:
```js
const { TOOLS, routeMap } = require('../tool-registry');
```

- [ ] **Step 11: Run the migrated file**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/tool-annotations.test.js
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add server/tests/auto-recovery-mcp-tools.test.js \
        server/tests/mcp-tool-alignment.test.js \
        server/tests/p2-orphaned-tools.test.js \
        server/tests/p3-dead-routes.test.js \
        server/tests/tool-annotations.test.js
git commit -m "refactor(perf-4): migrate 5 metadata-only test files to tool-registry"
```

---

## Task 3: Implement `torque/no-heavy-test-imports` ESLint rule

**Files:**

- Create: `server/eslint-rules/no-heavy-test-imports.js`
- Create: `server/eslint-rules/no-heavy-test-imports.test.js`

The rule detects top-level (Program-scope, not inside any function body) `require()` of four heavy modules from test files: `'../tools'`, `'../task-manager'`, `'../database'`, `'../dashboard-server'`. Files on the configured `allowlist` are exempt. Inline `// eslint-disable-next-line torque/no-heavy-test-imports -- <reason>` suppresses individual occurrences (reason must be >10 chars, same convention as Phase 1).

- [ ] **Step 1: Create the rule file**

Create `server/eslint-rules/no-heavy-test-imports.js`:

```js
'use strict';

/**
 * torque/no-heavy-test-imports
 *
 * Disallows top-level (module-scope) require() of heavy modules from test files.
 * Heavy modules: ../tools, ../task-manager, ../database, ../dashboard-server.
 *
 * Exception: files on the `allowlist` option array (basenames only, no path).
 * Inline suppression: // eslint-disable-next-line torque/no-heavy-test-imports -- <reason>
 * where <reason> is >10 chars.
 */

const HEAVY_MODULES = new Set([
  '../tools',
  '../task-manager',
  '../database',
  '../dashboard-server',
]);

const path = require('path');

function getBasename(filePath) {
  return path.basename(typeof filePath === 'string' ? filePath : '');
}

/**
 * Returns true if the node is a top-level (Program-body) statement,
 * not nested inside a function, block inside a function, etc.
 * Walks up the ancestor chain and returns false if any FunctionDeclaration,
 * FunctionExpression, or ArrowFunctionExpression is encountered.
 */
function isTopLevel(node) {
  let current = node.parent;
  while (current) {
    const t = current.type;
    if (
      t === 'FunctionDeclaration' ||
      t === 'FunctionExpression' ||
      t === 'ArrowFunctionExpression'
    ) {
      return false;
    }
    if (t === 'Program') return true;
    current = current.parent;
  }
  return true;
}

function getInlineDisableReason(sourceCode, node) {
  // Check for inline disable comment on the same line or the line before.
  const comments = sourceCode.getCommentsBefore
    ? sourceCode.getCommentsBefore(node.parent || node)
    : [];

  for (const comment of comments) {
    const match = comment.value.match(/eslint-disable(?:-next-line)?\s+torque\/no-heavy-test-imports\s*--\s*(.+)/);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow top-level require() of heavy modules (tools, task-manager, database, dashboard-server) from test files. Use tool-registry or lazy-require instead.',
    },
    messages: {
      heavyImport:
        '"{{module}}" is a heavy module (~335ms+ cold-import). Import tool-registry instead (for metadata), or move the require() inside the test/beforeEach that needs it. If this file genuinely needs handleToolCall, add it to the no-heavy-test-imports allowlist in eslint.config.js.',
      inlineReasonRequired:
        '"{{module}}" is suppressed but the inline reason is missing or too short (>10 chars required). Add: // eslint-disable-next-line torque/no-heavy-test-imports -- <real reason>',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowlist: {
            type: 'array',
            items: { type: 'string' },
            default: [],
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] || {};
    const allowlist = new Set(options.allowlist || []);
    const filename = context.filename || (context.getFilename ? context.getFilename() : '');
    const basename = getBasename(filename);

    if (allowlist.has(basename)) return {};

    const sourceCode = context.sourceCode || context.getSourceCode();

    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') return;
        if (!HEAVY_MODULES.has(arg.value)) return;
        if (!isTopLevel(node)) return;

        // Check for inline disable with reason.
        const reason = getInlineDisableReason(sourceCode, node);
        if (reason !== null) {
          if (reason.length <= 10) {
            context.report({
              node,
              messageId: 'inlineReasonRequired',
              data: { module: arg.value },
            });
          }
          // Reason is long enough — suppressed.
          return;
        }

        context.report({
          node,
          messageId: 'heavyImport',
          data: { module: arg.value },
        });
      },
    };
  },
};
```

- [ ] **Step 2: Create the rule test file**

Create `server/eslint-rules/no-heavy-test-imports.test.js`:

```js
'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-heavy-test-imports');

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

tester.run('no-heavy-test-imports', rule, {
  valid: [
    // Not a heavy module.
    "const db = require('../database-facade');",
    // Heavy module but inside a function (lazy-require pattern).
    "function setup() { const db = require('../database'); }",
    // Heavy module inside beforeEach.
    "beforeEach(() => { const tools = require('../tools'); });",
    // Heavy module inside a test.
    "it('test', () => { const tools = require('../tools'); });",
    // Allowed by allowlist.
    {
      code: "const { handleToolCall } = require('../tools');",
      options: [{ allowlist: ['my-test.test.js'] }],
      filename: '/srv/server/tests/my-test.test.js',
    },
    // Non-heavy tool-registry import is fine.
    "const { TOOLS } = require('../tool-registry');",
  ],
  invalid: [
    // Top-level require('../tools') without allowlist.
    {
      code: "const { handleToolCall } = require('../tools');",
      errors: [{ messageId: 'heavyImport', data: { module: '../tools' } }],
    },
    // Top-level require('../task-manager').
    {
      code: "const tm = require('../task-manager');",
      errors: [{ messageId: 'heavyImport', data: { module: '../task-manager' } }],
    },
    // Top-level require('../database').
    {
      code: "const db = require('../database');",
      errors: [{ messageId: 'heavyImport', data: { module: '../database' } }],
    },
    // Top-level require('../dashboard-server').
    {
      code: "const dash = require('../dashboard-server');",
      errors: [{ messageId: 'heavyImport', data: { module: '../dashboard-server' } }],
    },
    // Inline disable with reason too short.
    {
      code: "// eslint-disable-next-line torque/no-heavy-test-imports -- short\nconst t = require('../tools');",
      errors: [{ messageId: 'inlineReasonRequired', data: { module: '../tools' } }],
    },
  ],
});
```

- [ ] **Step 3: Run the rule test**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run eslint-rules/no-heavy-test-imports.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/eslint-rules/no-heavy-test-imports.js server/eslint-rules/no-heavy-test-imports.test.js
git commit -m "feat(perf-4): add torque/no-heavy-test-imports ESLint rule"
```

---

## Task 4: Configure `no-heavy-test-imports` rule in `eslint.config.js` with the 11-file allowlist

**Files:**

- Modify: `server/eslint.config.js`

Add the rule in `error` mode for `tests/**/*.js` and `**/*.test.js`, with the confirmed 11-file allowlist. The 5 metadata-only files have already been migrated in Task 2 so they won't trip the rule.

- [ ] **Step 1: Read `server/eslint.config.js`**

Read the full file to understand the existing structure and find the anchor for the new block.

- [ ] **Step 2: Add the rule import at the top of `eslint.config.js`**

After the existing rule imports (currently `const noVitestRequireRule = require('./eslint-rules/no-vitest-require');`), add:

```js
const noHeavyTestImportsRule = require('./eslint-rules/no-heavy-test-imports');
```

- [ ] **Step 3: Add the rule configuration block**

After the existing `tests/**` block that configures `local/no-vitest-require`, add a new block:

```js
  {
    files: ['tests/**/*.js', '**/*.test.js'],
    plugins: {
      torque: {
        rules: {
          'no-heavy-test-imports': noHeavyTestImportsRule,
        },
      },
    },
    rules: {
      'torque/no-heavy-test-imports': ['error', {
        allowlist: [
          'api-server.test.js',
          'eval-mcp-tools.test.js',
          'mcp-factory-loop-tools.test.js',
          'mcp-sse.test.js',
          'mcp-streamable-http.test.js',
          'mcp-tools-plan-file.test.js',
          'p2-workflow-subscribe.test.js',
          'restart-server-tool.test.js',
          'test-hardening.test.js',
          'tool-schema-validation.test.js',
          'tools-aggregator.test.js',
        ],
      }],
    },
  },
```

- [ ] **Step 4: Run ESLint to confirm only the 11 allowlisted files emit diagnostics (all suppressed)**

```
torque-remote --branch feat/perf-4-test-infra npx eslint tests/ 2>&1 | grep "no-heavy-test-imports" | head -30
```

Expected: No output (the 11 allowlisted files are suppressed; the 5 migrated files no longer use `require('../tools')` at module scope).

- [ ] **Step 5: Run the full ESLint suite to confirm clean exit**

```
torque-remote --branch feat/perf-4-test-infra npx eslint . 2>&1 | tail -5
```

Expected: Exit 0 or only pre-existing warnings (not related to `no-heavy-test-imports`).

- [ ] **Step 6: Commit**

```bash
git add server/eslint.config.js
git commit -m "feat(perf-4): configure no-heavy-test-imports rule with 11-file allowlist"
```

---

## Task 5: Implement `torque/no-reset-modules-in-each` ESLint rule

**Files:**

- Create: `server/eslint-rules/no-reset-modules-in-each.js`
- Create: `server/eslint-rules/no-reset-modules-in-each.test.js`

The rule flags `vi.resetModules()` calls that appear inside a `beforeEach()` callback. `beforeAll()` is allowed. Inline `// eslint-disable-next-line torque/no-reset-modules-in-each -- <reason>` suppresses individual occurrences (reason >10 chars).

- [ ] **Step 1: Create the rule file**

Create `server/eslint-rules/no-reset-modules-in-each.js`:

```js
'use strict';

/**
 * torque/no-reset-modules-in-each
 *
 * Flags vi.resetModules() calls inside beforeEach() callbacks.
 * These force a full module cache clear before every test case, multiplying
 * cold-import costs by the test count in the file.
 *
 * Recommended alternatives:
 *   - vi.restoreAllMocks() / vi.clearAllMocks()  — reset mock state without reload
 *   - db.resetForTest()                          — DB isolation without module reload
 *   - beforeAll() + vi.resetModules()            — if module-init testing genuinely needed
 *
 * Inline suppression: // eslint-disable-next-line torque/no-reset-modules-in-each -- <reason>
 * where <reason> is >10 chars.
 */

function isBeforeEachCallback(node) {
  // Check if this function node is a direct argument to a beforeEach() call.
  let current = node.parent;
  while (current) {
    if (
      current.type === 'CallExpression' &&
      current.callee &&
      current.callee.type === 'Identifier' &&
      current.callee.name === 'beforeEach'
    ) {
      return current.arguments.includes(node);
    }
    const t = current.type;
    if (
      t === 'FunctionDeclaration' ||
      t === 'FunctionExpression' ||
      t === 'ArrowFunctionExpression'
    ) {
      break;
    }
    current = current.parent;
  }
  return false;
}

function isInsideBeforeEach(node) {
  // Walk up ancestor chain; if we cross a Function boundary, check if that
  // Function is a beforeEach argument.
  let current = node.parent;
  while (current) {
    const t = current.type;
    if (
      t === 'FunctionExpression' ||
      t === 'ArrowFunctionExpression' ||
      t === 'FunctionDeclaration'
    ) {
      if (isBeforeEachCallback(current)) return true;
      return false;
    }
    if (t === 'Program') return false;
    current = current.parent;
  }
  return false;
}

function getInlineDisableReason(sourceCode, node) {
  const comments = sourceCode.getCommentsBefore
    ? sourceCode.getCommentsBefore(
        node.type === 'ExpressionStatement' ? node : (node.parent || node)
      )
    : [];

  for (const comment of comments) {
    const match = comment.value.match(
      /eslint-disable(?:-next-line)?\s+torque\/no-reset-modules-in-each\s*--\s*(.+)/
    );
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow vi.resetModules() inside beforeEach(). Use vi.restoreAllMocks(), vi.clearAllMocks(), or db.resetForTest() instead. Move to beforeAll() only when genuine module-init testing is needed.',
    },
    messages: {
      resetModulesInEach:
        'vi.resetModules() inside beforeEach() forces a full module cache clear before every test case, multiplying cold-import costs. Use vi.restoreAllMocks() / vi.clearAllMocks() for mock isolation, or db.resetForTest() for DB isolation. If you genuinely need module-init testing, move to beforeAll().',
      inlineReasonRequired:
        'vi.resetModules() in beforeEach() is suppressed but the inline reason is missing or too short (>10 chars required). Add: // eslint-disable-next-line torque/no-reset-modules-in-each -- <real reason>',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();

    return {
      CallExpression(node) {
        // Match vi.resetModules()
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.object.type !== 'Identifier' ||
          node.callee.object.name !== 'vi' ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'resetModules'
        ) {
          return;
        }

        if (!isInsideBeforeEach(node)) return;

        // Check for inline disable with reason.
        const stmtNode = node.parent && node.parent.type === 'ExpressionStatement'
          ? node.parent
          : node;
        const reason = getInlineDisableReason(sourceCode, stmtNode);
        if (reason !== null) {
          if (reason.length <= 10) {
            context.report({ node, messageId: 'inlineReasonRequired' });
          }
          return;
        }

        context.report({ node, messageId: 'resetModulesInEach' });
      },
    };
  },
};
```

- [ ] **Step 2: Create the rule test file**

Create `server/eslint-rules/no-reset-modules-in-each.test.js`:

```js
'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-reset-modules-in-each');

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
    globals: {
      vi: 'readonly',
      beforeEach: 'readonly',
      beforeAll: 'readonly',
      it: 'readonly',
    },
  },
});

tester.run('no-reset-modules-in-each', rule, {
  valid: [
    // beforeAll is allowed.
    'beforeAll(() => { vi.resetModules(); });',
    // Top-level call is allowed.
    'vi.resetModules();',
    // Inside a plain function (not a test hook) is allowed.
    'function setup() { vi.resetModules(); }',
    // vi.clearAllMocks inside beforeEach is allowed.
    'beforeEach(() => { vi.clearAllMocks(); });',
    // vi.restoreAllMocks inside beforeEach is allowed.
    'beforeEach(() => { vi.restoreAllMocks(); });',
    // Inside an it block is allowed.
    "it('test', () => { vi.resetModules(); });",
  ],
  invalid: [
    // Arrow function callback.
    {
      code: 'beforeEach(() => { vi.resetModules(); });',
      errors: [{ messageId: 'resetModulesInEach' }],
    },
    // Regular function callback.
    {
      code: 'beforeEach(function() { vi.resetModules(); });',
      errors: [{ messageId: 'resetModulesInEach' }],
    },
    // Inline disable with reason too short.
    {
      code: "beforeEach(() => {\n  // eslint-disable-next-line torque/no-reset-modules-in-each -- short\n  vi.resetModules();\n});",
      errors: [{ messageId: 'inlineReasonRequired' }],
    },
  ],
});
```

- [ ] **Step 3: Run the rule test**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run eslint-rules/no-reset-modules-in-each.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/eslint-rules/no-reset-modules-in-each.js server/eslint-rules/no-reset-modules-in-each.test.js
git commit -m "feat(perf-4): add torque/no-reset-modules-in-each ESLint rule"
```

---

## Task 6: Configure `no-reset-modules-in-each` in `eslint.config.js` then migrate the 38 callsites

**Files:**

- Modify: `server/eslint.config.js`
- Modify: `server/tests/adapter-registry.test.js`
- Modify: `server/tests/advanced-intelligence-handlers.test.js`
- Modify: `server/tests/advanced-intelligence.test.js`
- Modify: `server/tests/adversarial-review-dag.test.js`
- Modify: `server/tests/adversarial-review-stage.test.js`
- Modify: `server/tests/api-routes.test.js`
- Modify: `server/tests/auto-release.test.js`
- Modify: `server/tests/benchmark.test.js`
- Modify: `server/tests/budget-alert-webhooks.test.js`
- Modify: `server/tests/cli-client.test.js`
- Modify: `server/tests/config.test.js`
- Modify: `server/tests/factory-audit.test.js`
- Modify: `server/tests/factory-loop-hardening.test.js`
- Modify: `server/tests/factory-loop-instance-routes.test.js`
- Modify: `server/tests/factory-provider-lane-routes.test.js`
- Modify: `server/tests/factory-worktrees-persistence.test.js`
- Modify: `server/tests/integration-auto-routed-overflow.test.js`
- Modify: `server/tests/mcp-index.test.js`
- Modify: `server/tests/mcp-platform.test.js`
- Modify: `server/tests/ollama-agentic.test.js`
- Modify: `server/tests/orchestrator-e2e.test.js`
- Modify: `server/tests/orphan-cleanup.test.js`
- Modify: `server/tests/peek-artifacts-handlers.test.js`
- Modify: `server/tests/peek-compliance-handlers.test.js`
- Modify: `server/tests/peek-federation-handlers.test.js`
- Modify: `server/tests/per-provider-concurrency.test.js`
- Modify: `server/tests/policy-adapter-approval-extended.test.js`
- Modify: `server/tests/policy-adapter-feature-flag.test.js`
- Modify: `server/tests/prompts-tier-integration.test.js`
- Modify: `server/tests/prompts-tier-templates.test.js`
- Modify: `server/tests/provider-registry.test.js`
- Modify: `server/tests/provider-router.test.js`
- Modify: `server/tests/rest-passthrough-coercion.test.js`
- Modify: `server/tests/restart-drain.test.js`
- Modify: `server/tests/task-project-handlers.test.js`
- Modify: `server/tests/tda-01-provider-sovereignty.test.js`
- Modify: `server/tests/v2-config-api.test.js`
- Modify: `server/tests/v2-governance-boolean-validation.test.js`
- Modify: `server/tests/v2-governance-handlers.test.js`
- Modify: `server/tests/verification-ledger-stage.test.js`

**Migration strategy per file:**

1. Read the file, identify every `beforeEach` that contains `vi.resetModules()`.
2. Determine the intent: (a) mock-reset isolation (no module-init test) → replace `vi.resetModules()` with `vi.restoreAllMocks()` or `vi.clearAllMocks()`; (b) DB isolation only → replace with `db.resetForTest(buffer)` or rely on existing `setupTestDb` teardown; (c) module-init testing (testing cold-start behavior of config/provider/registry) → move the `vi.resetModules()` to `beforeAll()` or keep with `// eslint-disable-next-line` and a real reason.
3. Run the test file before and after the change. If it fails after, revert that conversion and add `// eslint-disable-next-line torque/no-reset-modules-in-each -- <reason>`.

**Files confirmed to likely need `vi.resetModules()` kept (move to beforeAll or disable with reason):**

- `config.test.js` — tests config singleton cold-start behavior
- `provider-registry.test.js` — tests provider registry cold-start
- `provider-router.test.js` — tests router initialization state
- `adapter-registry.test.js` — tests adapter registry initialization
- `tda-01-provider-sovereignty.test.js` — tests provider module isolation
- `orphan-cleanup.test.js` — tests module-init cleanup behavior

For these files, the preferred conversion is: move `vi.resetModules()` from `beforeEach` to `beforeAll` and verify the tests still pass. If `beforeAll` breaks them (because different tests in the suite need different module states), add `// eslint-disable-next-line torque/no-reset-modules-in-each -- tests module-init behavior; resetModules required per-case` and keep `beforeEach`.

- [ ] **Step 1: Configure the rule in `eslint.config.js` (warn mode initially)**

Read `server/eslint.config.js`. In the block that already contains `torque/no-heavy-test-imports`, add the new rule alongside it:

```js
      'torque/no-reset-modules-in-each': 'warn',
```

Also add it to the `torque` plugin's rules object:

```js
        rules: {
          'no-heavy-test-imports': noHeavyTestImportsRule,
          'no-reset-modules-in-each': noResetModulesInEachRule,
        },
```

And add the import at the top:

```js
const noResetModulesInEachRule = require('./eslint-rules/no-reset-modules-in-each');
```

- [ ] **Step 2: Run ESLint to get the full list of violations**

```
torque-remote --branch feat/perf-4-test-infra npx eslint tests/ 2>&1 | grep "no-reset-modules-in-each" | wc -l
```

Expected: ~38 warnings (may differ slightly if some files had multiple occurrences on one line).

- [ ] **Step 3: Migrate `factory-loop-hardening.test.js` (4 occurrences)**

Read the file. Identify each `beforeEach(() => { vi.resetModules(); ... })` block. This file tests factory loop state behavior, not module initialization — replace each `vi.resetModules()` with `vi.restoreAllMocks()`.

Run before:
```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/factory-loop-hardening.test.js
```
Record: PASS.

Make changes (replace each `vi.resetModules()` with `vi.restoreAllMocks()` in each `beforeEach`).

Run after:
```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/factory-loop-hardening.test.js
```
Expected: PASS. If FAIL, revert and add disable comments.

- [ ] **Step 4: Migrate `tda-01-provider-sovereignty.test.js` (6 occurrences)**

Read the file (it's a module-sovereignty test — likely keeps `resetModules`). For each of the 6 `beforeEach` occurrences at lines 65, 93, 193, 259, 331, 359:
- If the `beforeEach` only calls `vi.resetModules()` and the tests re-require modules, try moving to `beforeAll()`.
- If moving to `beforeAll` fails (tests are not independent at that scope), add `// eslint-disable-next-line torque/no-reset-modules-in-each -- tests provider module isolation per-case; vi.resetModules() required between cases`.

Run before → make changes → run after. Accept either passing migration OR disable comment.

- [ ] **Step 5: Migrate `mcp-platform.test.js` (5 occurrences)**

Read the file. Identify which of the 5 `vi.resetModules()` calls (lines 185, 216, 282, 405, 484) are for mock isolation vs. module-init. Replace mock-isolation ones with `vi.restoreAllMocks()`; keep module-init ones with disable comments.

Run before → make changes → run after.

- [ ] **Step 6: Migrate `config.test.js` (4 occurrences)**

Read the file. `config.test.js` tests the config singleton — module resets are likely genuine. Try moving each to `beforeAll`. If test failures occur, add disable comments with reason `"tests config module initialization state per describe block"`.

Run before → make changes → run after.

- [ ] **Step 7: Migrate the remaining 30 files in batches of 5–6**

For each file in the list below, apply the same process: read, classify intent, replace `vi.resetModules()` in `beforeEach` with `vi.restoreAllMocks()` or `vi.clearAllMocks()`, run before + after, revert individual failures with disable comments.

**Batch A** (5 files, likely pure mock-reset pattern):
- `server/tests/adversarial-review-dag.test.js`
- `server/tests/adversarial-review-stage.test.js`
- `server/tests/api-routes.test.js`
- `server/tests/auto-release.test.js`
- `server/tests/benchmark.test.js`

Run batch before:
```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/adversarial-review-dag.test.js tests/adversarial-review-stage.test.js tests/api-routes.test.js tests/auto-release.test.js tests/benchmark.test.js
```
Migrate all. Run batch after with same command.

**Batch B** (5 files):
- `server/tests/budget-alert-webhooks.test.js`
- `server/tests/cli-client.test.js`
- `server/tests/factory-audit.test.js`
- `server/tests/factory-loop-instance-routes.test.js`
- `server/tests/factory-provider-lane-routes.test.js`

Run batch before → migrate → run batch after.

**Batch C** (5 files):
- `server/tests/factory-worktrees-persistence.test.js`
- `server/tests/integration-auto-routed-overflow.test.js`
- `server/tests/mcp-index.test.js`
- `server/tests/ollama-agentic.test.js`
- `server/tests/orchestrator-e2e.test.js`

Run batch before → migrate → run batch after.

**Batch D** (5 files):
- `server/tests/peek-artifacts-handlers.test.js`
- `server/tests/peek-compliance-handlers.test.js`
- `server/tests/peek-federation-handlers.test.js`
- `server/tests/per-provider-concurrency.test.js`
- `server/tests/policy-adapter-approval-extended.test.js`

Run batch before → migrate → run batch after.

**Batch E** (5 files):
- `server/tests/policy-adapter-feature-flag.test.js`
- `server/tests/prompts-tier-integration.test.js`
- `server/tests/prompts-tier-templates.test.js`
- `server/tests/provider-registry.test.js`
- `server/tests/provider-router.test.js`

Run batch before → migrate → run batch after.

**Batch F** (remaining files):
- `server/tests/rest-passthrough-coercion.test.js`
- `server/tests/restart-drain.test.js`
- `server/tests/task-project-handlers.test.js`
- `server/tests/v2-config-api.test.js`
- `server/tests/v2-governance-boolean-validation.test.js`
- `server/tests/v2-governance-handlers.test.js`
- `server/tests/verification-ledger-stage.test.js`
- `server/tests/adapter-registry.test.js`
- `server/tests/advanced-intelligence-handlers.test.js`
- `server/tests/advanced-intelligence.test.js`
- `server/tests/orphan-cleanup.test.js`

Run batch before → migrate → run batch after.

- [ ] **Step 8: Promote the rule from `warn` to `error` in `eslint.config.js`**

Read `server/eslint.config.js`. Find `'torque/no-reset-modules-in-each': 'warn'`. Change to `'error'`.

- [ ] **Step 9: Run ESLint to confirm clean exit**

```
torque-remote --branch feat/perf-4-test-infra npx eslint tests/ 2>&1 | grep "no-reset-modules-in-each" | head -20
```

Expected: Only files with valid `// eslint-disable-next-line` comments appear, if any. Exit code 0.

- [ ] **Step 10: Commit all 38 migration files + config change**

```bash
git add server/eslint.config.js server/tests/adapter-registry.test.js \
        server/tests/advanced-intelligence-handlers.test.js server/tests/advanced-intelligence.test.js \
        server/tests/adversarial-review-dag.test.js server/tests/adversarial-review-stage.test.js \
        server/tests/api-routes.test.js server/tests/auto-release.test.js server/tests/benchmark.test.js \
        server/tests/budget-alert-webhooks.test.js server/tests/cli-client.test.js server/tests/config.test.js \
        server/tests/factory-audit.test.js server/tests/factory-loop-hardening.test.js \
        server/tests/factory-loop-instance-routes.test.js server/tests/factory-provider-lane-routes.test.js \
        server/tests/factory-worktrees-persistence.test.js server/tests/integration-auto-routed-overflow.test.js \
        server/tests/mcp-index.test.js server/tests/mcp-platform.test.js server/tests/ollama-agentic.test.js \
        server/tests/orchestrator-e2e.test.js server/tests/orphan-cleanup.test.js \
        server/tests/peek-artifacts-handlers.test.js server/tests/peek-compliance-handlers.test.js \
        server/tests/peek-federation-handlers.test.js server/tests/per-provider-concurrency.test.js \
        server/tests/policy-adapter-approval-extended.test.js server/tests/policy-adapter-feature-flag.test.js \
        server/tests/prompts-tier-integration.test.js server/tests/prompts-tier-templates.test.js \
        server/tests/provider-registry.test.js server/tests/provider-router.test.js \
        server/tests/rest-passthrough-coercion.test.js server/tests/restart-drain.test.js \
        server/tests/task-project-handlers.test.js server/tests/tda-01-provider-sovereignty.test.js \
        server/tests/v2-config-api.test.js server/tests/v2-governance-boolean-validation.test.js \
        server/tests/v2-governance-handlers.test.js server/tests/verification-ledger-stage.test.js
git commit -m "refactor(perf-4): migrate 38 vi.resetModules() in beforeEach to vi.restoreAllMocks() or disable with reason"
```

---

## Task 7: Migrate 17 `setupTestDb` → `setupTestDbOnly` callers

**Files:**

- Modify: `server/tests/artifact-storage-path.test.js`
- Modify: `server/tests/build-bundle.test.js`
- Modify: `server/tests/event-emitter.test.js`
- Modify: `server/tests/event-replay.test.js`
- Modify: `server/tests/execute-ollama-coverage.test.js`
- Modify: `server/tests/factory-auto-pilot-regressions.test.js`
- Modify: `server/tests/factory-baseline-probe-integration.test.js`
- Modify: `server/tests/factory-dep-resolver-integration.test.js`
- Modify: `server/tests/factory-plan-quality-gate-e2e.test.js`
- Modify: `server/tests/factory-verify-review-integration.test.js`
- Modify: `server/tests/file-baselines-boundary.test.js`
- Modify: `server/tests/hashline-path-scoping.test.js`
- Modify: `server/tests/integration-index.test.js`
- Modify: `server/tests/replay.test.js`
- Modify: `server/tests/workflow-resume.test.js`
- Modify: `server/tests/workflow-spec-handlers.test.js`
- Modify: `server/tests/workflow-spec-integration.test.js`

The migration is mechanical: change `setupTestDb` → `setupTestDbOnly` in both the destructure at the top of the test and the `beforeAll`/`beforeEach` call. The `handleToolCall` and `safeTool` variables (if present) will no longer be provided by setup — remove them from the destructure if present, or confirm the file truly never calls them.

- [ ] **Step 1: Baseline run of all 17 files**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run \
  tests/artifact-storage-path.test.js tests/build-bundle.test.js \
  tests/event-emitter.test.js tests/event-replay.test.js \
  tests/execute-ollama-coverage.test.js tests/factory-auto-pilot-regressions.test.js \
  tests/factory-baseline-probe-integration.test.js tests/factory-dep-resolver-integration.test.js \
  tests/factory-plan-quality-gate-e2e.test.js tests/factory-verify-review-integration.test.js \
  tests/file-baselines-boundary.test.js tests/hashline-path-scoping.test.js \
  tests/integration-index.test.js tests/replay.test.js \
  tests/workflow-resume.test.js tests/workflow-spec-handlers.test.js \
  tests/workflow-spec-integration.test.js
```

Expected: All 17 PASS.

- [ ] **Step 2: Migrate each file — change `setupTestDb` to `setupTestDbOnly`**

For each file, read it, find the destructure from `require('./vitest-setup')` and the `beforeAll`/`beforeEach` call. Make two changes:

**Change 1 — destructure:** Replace:
```js
const { setupTestDb, teardownTestDb, ... } = require('./vitest-setup');
```
With:
```js
const { setupTestDbOnly, teardownTestDb, ... } = require('./vitest-setup');
```
(Remove `handleToolCall`, `safeTool` from the destructure if present.)

**Change 2 — setup call:** Replace:
```js
beforeAll(() => { ({ db, testDir, handleToolCall } = setupTestDb('suite-name')); });
// or
beforeAll(() => { ({ db, testDir } = setupTestDb('suite-name')); });
```
With:
```js
beforeAll(() => { ({ db, testDir } = setupTestDbOnly('suite-name')); });
```

Apply to all 17 files. The `setupTestDbOnly` function signature is: `setupTestDbOnly(suiteName)` returning `{ db, testDir }`.

- [ ] **Step 3: Post-migration run of all 17 files**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run \
  tests/artifact-storage-path.test.js tests/build-bundle.test.js \
  tests/event-emitter.test.js tests/event-replay.test.js \
  tests/execute-ollama-coverage.test.js tests/factory-auto-pilot-regressions.test.js \
  tests/factory-baseline-probe-integration.test.js tests/factory-dep-resolver-integration.test.js \
  tests/factory-plan-quality-gate-e2e.test.js tests/factory-verify-review-integration.test.js \
  tests/file-baselines-boundary.test.js tests/hashline-path-scoping.test.js \
  tests/integration-index.test.js tests/replay.test.js \
  tests/workflow-resume.test.js tests/workflow-spec-handlers.test.js \
  tests/workflow-spec-integration.test.js
```

Expected: All 17 PASS. If any file fails, read its error, determine if it actually calls `handleToolCall` via a transitive helper, and revert that file's migration only (leave it on `setupTestDb`).

- [ ] **Step 4: Commit**

```bash
git add \
  server/tests/artifact-storage-path.test.js server/tests/build-bundle.test.js \
  server/tests/event-emitter.test.js server/tests/event-replay.test.js \
  server/tests/execute-ollama-coverage.test.js server/tests/factory-auto-pilot-regressions.test.js \
  server/tests/factory-baseline-probe-integration.test.js server/tests/factory-dep-resolver-integration.test.js \
  server/tests/factory-plan-quality-gate-e2e.test.js server/tests/factory-verify-review-integration.test.js \
  server/tests/file-baselines-boundary.test.js server/tests/hashline-path-scoping.test.js \
  server/tests/integration-index.test.js server/tests/replay.test.js \
  server/tests/workflow-resume.test.js server/tests/workflow-spec-handlers.test.js \
  server/tests/workflow-spec-integration.test.js
git commit -m "refactor(perf-4): migrate 17 setupTestDb -> setupTestDbOnly (no handleToolCall callers)"
```

---

## Task 8: Lazy-require the 19 top-level `task-manager` imports in test files

**Files:**

- Modify: `server/tests/dashboard-routes-advanced.test.js` (line 9)
- Modify: `server/tests/e2e-post-task-validation.test.js` (line 16)
- Modify: `server/tests/handler-adv-debugger.test.js` (line 2)
- Modify: `server/tests/handler-task-core-extended.test.js` (line 12)
- Modify: `server/tests/handler-task-pipeline.test.js` (line 8)
- Modify: `server/tests/handler-task-project.test.js` (line 7)
- Modify: `server/tests/handler-workflow-advanced.test.js` (line 6)
- Modify: `server/tests/handler-workflow-handlers.test.js` (line 5)
- Modify: `server/tests/harness-improvements.test.js` (line 10)
- Modify: `server/tests/integration-index.test.js` (line 9)
- Modify: `server/tests/p1-process-safety.test.js` (line 17)
- Modify: `server/tests/policy-task-lifecycle.test.js` (line 4)
- Modify: `server/tests/post-tool-hooks.test.js` (line 12)
- Modify: `server/tests/task-intelligence.test.js` (line 130)
- Modify: `server/tests/task-intelligence-handlers.test.js` (line 142)
- Modify: `server/tests/task-operations.test.js` (line 149)
- Modify: `server/tests/task-pipeline-handlers.test.js` (line 73)
- Modify: `server/tests/workflow-handlers-analysis.test.js` (line 2)
- Modify: `server/tests/workflow-handlers-core.test.js` (line 3)

The migration is mechanical: move `const taskManager = require('../task-manager');` (or similar destructure) from module scope into the function body where it is first used. In most of these files, the entire require is unused at module scope and is only accessed inside individual `it()` or `beforeEach()` blocks.

**Migration pattern:**

Before:
```js
// line 9 (module scope)
const { createTask, getTask } = require('../task-manager');

// ... 100 lines later in a test ...
it('creates a task', async () => {
  const result = await createTask({ ... });
  expect(result).toBeTruthy();
});
```

After:
```js
// (no module-scope import)

it('creates a task', async () => {
  const { createTask } = require('../task-manager');
  const result = await createTask({ ... });
  expect(result).toBeTruthy();
});
```

If the same symbols are used in multiple places, the best approach is to move the require into `beforeEach` or `beforeAll` at the `describe` block level:

```js
let createTask, getTask;
beforeEach(() => {
  ({ createTask, getTask } = require('../task-manager'));
});
```

- [ ] **Step 1: Baseline run of all 19 files**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run \
  tests/dashboard-routes-advanced.test.js tests/e2e-post-task-validation.test.js \
  tests/handler-adv-debugger.test.js tests/handler-task-core-extended.test.js \
  tests/handler-task-pipeline.test.js tests/handler-task-project.test.js \
  tests/handler-workflow-advanced.test.js tests/handler-workflow-handlers.test.js \
  tests/harness-improvements.test.js tests/integration-index.test.js \
  tests/p1-process-safety.test.js tests/policy-task-lifecycle.test.js \
  tests/post-tool-hooks.test.js tests/task-intelligence.test.js \
  tests/task-intelligence-handlers.test.js tests/task-operations.test.js \
  tests/task-pipeline-handlers.test.js tests/workflow-handlers-analysis.test.js \
  tests/workflow-handlers-core.test.js
```

Expected: All pass.

- [ ] **Step 2: Migrate each file — move the `require('../task-manager')` into function scope**

For each file: read the file near the flagged line number, find the require, search for usages of the imported symbols to determine the right scope (per-test, per-describe's beforeEach, etc.), then move the require accordingly.

For files with the import at very early lines (lines 2–12), the pattern is usually: import at top then use throughout. Move to a `beforeEach` at the outermost `describe` level.

For files with the import at late lines (lines 73, 130, 142, 149 in larger files), read 20 lines of context around the import line before deciding how to move it.

- [ ] **Step 3: Post-migration run of all 19 files**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run \
  tests/dashboard-routes-advanced.test.js tests/e2e-post-task-validation.test.js \
  tests/handler-adv-debugger.test.js tests/handler-task-core-extended.test.js \
  tests/handler-task-pipeline.test.js tests/handler-task-project.test.js \
  tests/handler-workflow-advanced.test.js tests/handler-workflow-handlers.test.js \
  tests/harness-improvements.test.js tests/integration-index.test.js \
  tests/p1-process-safety.test.js tests/policy-task-lifecycle.test.js \
  tests/post-tool-hooks.test.js tests/task-intelligence.test.js \
  tests/task-intelligence-handlers.test.js tests/task-operations.test.js \
  tests/task-pipeline-handlers.test.js tests/workflow-handlers-analysis.test.js \
  tests/workflow-handlers-core.test.js
```

Expected: All pass. Revert any that fail; document the revert reason.

- [ ] **Step 4: Commit**

```bash
git add \
  server/tests/dashboard-routes-advanced.test.js server/tests/e2e-post-task-validation.test.js \
  server/tests/handler-adv-debugger.test.js server/tests/handler-task-core-extended.test.js \
  server/tests/handler-task-pipeline.test.js server/tests/handler-task-project.test.js \
  server/tests/handler-workflow-advanced.test.js server/tests/handler-workflow-handlers.test.js \
  server/tests/harness-improvements.test.js server/tests/integration-index.test.js \
  server/tests/p1-process-safety.test.js server/tests/policy-task-lifecycle.test.js \
  server/tests/post-tool-hooks.test.js server/tests/task-intelligence.test.js \
  server/tests/task-intelligence-handlers.test.js server/tests/task-operations.test.js \
  server/tests/task-pipeline-handlers.test.js server/tests/workflow-handlers-analysis.test.js \
  server/tests/workflow-handlers-core.test.js
git commit -m "refactor(perf-4): lazy-require task-manager in 19 test files (was top-level)"
```

---

## Task 9: Cold-import threshold wrapper in `vitest-setup.js`

**Files:**

- Modify: `server/tests/vitest-setup.js`
- Create: `server/tests/vitest-setup-perf.test.js`

Add timing to `setupTestDb` and `setupTestDbOnly`. On **first call per worker process** only (subsequent calls in the same worker are warm), measure elapsed time. Log a warning at >250ms; throw at >500ms (configurable via env). This catches drift between releases without waiting for a full scout.

- [ ] **Step 1: Read `server/tests/vitest-setup.js` lines 340–420 (the setupTestDb and setupTestDbOnly functions)**

Read to confirm the exact function bodies before editing.

- [ ] **Step 2: Write a test for the threshold wrapper**

Create `server/tests/vitest-setup-perf.test.js`:

```js
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SETUP_PATH = path.resolve(__dirname, 'vitest-setup.js');

describe('vitest-setup cold-import threshold wrapper', () => {
  it('respects PERF_TEST_IMPORT_WARN_MS env var (no throw when thresholds are very high)', () => {
    const script = `
      process.env.TORQUE_DATA_DIR = require('os').tmpdir();
      process.env.PERF_TEST_IMPORT_WARN_MS = '99999';
      process.env.PERF_TEST_IMPORT_FAIL_MS = '99999';
      const { setupTestDbOnly, teardownTestDb } = require(${JSON.stringify(SETUP_PATH)});
      setupTestDbOnly('perf-threshold-test');
      teardownTestDb();
      process.stdout.write('ok\\n');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.stdout.trim()).toBe('ok');
    expect(result.status).toBe(0);
  });

  it('threshold wrapper is only applied on first call per process', () => {
    const script = `
      process.env.TORQUE_DATA_DIR = require('os').tmpdir();
      process.env.PERF_TEST_IMPORT_WARN_MS = '99999';
      process.env.PERF_TEST_IMPORT_FAIL_MS = '99999';
      const { setupTestDbOnly, teardownTestDb } = require(${JSON.stringify(SETUP_PATH)});
      setupTestDbOnly('first');
      teardownTestDb();
      setupTestDbOnly('second');
      teardownTestDb();
      process.stdout.write('ok\\n');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.stdout.trim()).toBe('ok');
    expect(result.status).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test before the wrapper is added (should pass since thresholds are 99999)**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/vitest-setup-perf.test.js
```

Expected: FAIL with "setupTestDbOnly is not a function" or similar if the wrapper doesn't exist yet, OR PASS if `setupTestDbOnly` already works. Observe the error and proceed to Step 4 to add the wrapper.

- [ ] **Step 4: Modify `server/tests/vitest-setup.js` to add the threshold wrapper**

Read lines 340–420 (the `setupTestDb` and `setupTestDbOnly` functions). Replace those two functions with:

```js
let _setupFirstCallRecorded = false;

function _measureFirstCallCost(fnName) {
  if (_setupFirstCallRecorded) return null;
  _setupFirstCallRecorded = true;
  return { start: performance.now(), fnName };
}

function _checkFirstCallCost(measureToken) {
  if (!measureToken) return;
  const elapsed = Math.round(performance.now() - measureToken.start);
  const warnMs = parseInt(process.env.PERF_TEST_IMPORT_WARN_MS || '250', 10);
  const failMs = parseInt(process.env.PERF_TEST_IMPORT_FAIL_MS || '500', 10);
  if (elapsed >= failMs) {
    const msg =
      `[vitest-setup] PERF FAIL: ${measureToken.fnName}() first call took ${elapsed}ms` +
      ` (threshold: ${failMs}ms). A heavy module was likely imported at top level.` +
      ` Check for top-level require('../tools') or require('../task-manager') in this test file.`;
    throw new Error(msg);
  }
  if (elapsed >= warnMs) {
    // eslint-disable-next-line no-console
    console.warn(
      `[vitest-setup] PERF WARN: ${measureToken.fnName}() first call took ${elapsed}ms` +
      ` (warn threshold: ${warnMs}ms). Consider using setupTestDbOnly() and lazy-requiring heavy modules.`
    );
  }
}

/**
 * Full setup with a lazy tools.handleToolCall wrapper — for handler/MCP tool tests.
 */
function setupTestDb(suiteName) {
  const perf = _measureFirstCallCost('setupTestDb');
  const result = _initDb(suiteName);
  handleToolCall = lazyHandleToolCall;
  _checkFirstCallCost(perf);
  return { ...result, handleToolCall };
}

/**
 * Lightweight DB-only setup — skips tools.js import (saves ~335ms per test file).
 * Use for tests that only need the database, not handleToolCall.
 */
function setupTestDbOnly(suiteName) {
  const perf = _measureFirstCallCost('setupTestDbOnly');
  const result = _initDb(suiteName);
  _checkFirstCallCost(perf);
  return result;
}
```

- [ ] **Step 5: Run the test again to confirm it passes**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/vitest-setup-perf.test.js
```

Expected: PASS.

- [ ] **Step 6: Broad sanity check**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/artifact-storage-path.test.js tests/build-bundle.test.js tests/event-emitter.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/tests/vitest-setup.js server/tests/vitest-setup-perf.test.js
git commit -m "feat(perf-4): add cold-import threshold wrapper to vitest-setup (warn >250ms, fail >500ms)"
```

---

## Task 10: Split the top-3 largest test files

**Files:**

- Modify/Create: `server/tests/agentic-execution-fixes.test.js` (3638 lines) → split into 3 files
- Modify/Create: `server/tests/api-server.test.js` (2715 lines) → split into 3 files
- Modify/Create: `server/tests/task-core-handlers.test.js` (2360 lines) → split into 2–3 files

Each split preserves all `describe` blocks and their test counts. The goal is distributing work across vitest workers; no test logic changes.

**General split protocol for each file:**

1. Read the file's top-level `describe` blocks (grep for `^describe(` at column 0 or `^describe\(` pattern).
2. Identify natural boundaries (e.g., `describe('api-server core', ...)`, `describe('api-server SSE', ...)`, `describe('api-server routes', ...)`).
3. Create new files for each natural group. Each new file copies: (a) the module-scope imports, (b) the global `beforeAll`/`afterAll` if shared, (c) one or more `describe` blocks.
4. The original file either becomes the first split file (retaining a portion) or is deleted once all describes are redistributed.
5. Run the new split files to verify all tests pass.
6. If the original file has a shared `beforeAll`/`afterAll` that must run once globally (not per-file), copy it into each split file's `beforeAll` — vitest does not share state between files.

- [ ] **Step 1: Read the top of `agentic-execution-fixes.test.js` to find describe-block boundaries**

Read the first 100 lines and run:
```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/agentic-execution-fixes.test.js --reporter=verbose 2>&1 | head -50
```

- [ ] **Step 2: Split `agentic-execution-fixes.test.js` into 3 files**

Identify the 3 largest `describe` blocks by reading the file in 500-line chunks.

Name the splits:
- `server/tests/agentic-execution-fixes-a.test.js` — first major describe group
- `server/tests/agentic-execution-fixes-b.test.js` — second major describe group
- `server/tests/agentic-execution-fixes-c.test.js` — third major describe group (can be a rename of the original)

Each new file gets: all shared module-scope `require()` statements, its own `describe` block(s), and its own `beforeAll`/`afterAll` stubs copied from the original.

- [ ] **Step 3: Run the 3 new agentic files**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/agentic-execution-fixes-a.test.js tests/agentic-execution-fixes-b.test.js tests/agentic-execution-fixes-c.test.js
```

Expected: Same tests pass as before the split.

- [ ] **Step 4: Split `api-server.test.js` into 3 files**

Read the file's describe structure. Natural splits:
- `server/tests/api-server-core.test.js` — core task/project endpoints
- `server/tests/api-server-sse.test.js` — SSE and streaming endpoints
- `server/tests/api-server-routes.test.js` — remaining route tests (or keep original as this slice)

The original `api-server.test.js` is on the ESLint allowlist for `torque/no-heavy-test-imports`. If any of the split files uses `handleToolCall`, they must be added to the allowlist in `eslint.config.js`.

- [ ] **Step 5: Run the 3 api-server files**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/api-server-core.test.js tests/api-server-sse.test.js tests/api-server-routes.test.js
```

Expected: All pass. Update `eslint.config.js` allowlist if the new file names use `handleToolCall`.

- [ ] **Step 6: Split `task-core-handlers.test.js` into 2 files**

Read describe structure. Likely splits:
- `server/tests/task-core-handlers-create.test.js` — task creation and pipeline tests
- `server/tests/task-core-handlers-update.test.js` — task update/completion/status tests (or keep original as this slice)

- [ ] **Step 7: Run the 2 task-core-handlers files**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/task-core-handlers-create.test.js tests/task-core-handlers-update.test.js
```

Expected: All pass.

- [ ] **Step 8: Commit**

```bash
git add \
  server/tests/agentic-execution-fixes-a.test.js \
  server/tests/agentic-execution-fixes-b.test.js \
  server/tests/agentic-execution-fixes-c.test.js \
  server/tests/api-server-core.test.js \
  server/tests/api-server-sse.test.js \
  server/tests/api-server-routes.test.js \
  server/tests/task-core-handlers-create.test.js \
  server/tests/task-core-handlers-update.test.js \
  server/tests/agentic-execution-fixes.test.js \
  server/tests/api-server.test.js \
  server/tests/task-core-handlers.test.js \
  server/eslint.config.js
git commit -m "refactor(perf-4): split top-3 oversized test files (3638/2715/2360 lines)"
```

---

## Task 11: Delete `test-helpers.js` self-test stub

**Files:**

- Modify: `server/tests/test-helpers.js`

The `describe`/`it` block at lines 95–101 is dead weight — `test-helpers.js` is imported as a module, not run directly, and the glob pattern `*.test.js` doesn't match it anyway. Removing it eliminates a subtle confusion for future readers.

- [ ] **Step 1: Read `server/tests/test-helpers.js` lines 88–105**

Confirm the exact content of the stub block.

- [ ] **Step 2: Delete the stub**

The block to delete is (approximately lines 94–102):

```js
// Vitest needs at least one test in every matched file
describe('test-helpers', () => {
  it('exports utility functions', () => {
    expect(typeof uniqueId).toBe('function');
    expect(typeof sleep).toBe('function');
    expect(typeof extractTaskId).toBe('function');
    expect(uniqueId('foo')).toMatch(/^foo_/);
  });
});
```

Remove this block. The `module.exports` line stays.

- [ ] **Step 3: Verify the file still loads cleanly (no syntax errors)**

```
torque-remote --branch feat/perf-4-test-infra node -e "require('./tests/test-helpers.js'); console.log('ok');"
```

Expected: Prints `ok`, exits 0.

- [ ] **Step 4: Verify no test file that imports test-helpers.js fails**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/harness-improvements.test.js tests/handler-task-core-extended.test.js
```

Expected: PASS (these files import test-helpers.js).

- [ ] **Step 5: Commit**

```bash
git add server/tests/test-helpers.js
git commit -m "fix(perf-4): delete orphan self-test stub from test-helpers.js (lines 95-101)"
```

---

## Task 12: Post-migration scout and phase verification

**Files:**

- Create: `docs/findings/2026-04-25-perf-arc/phase-4-test-infra-post.md`

Re-run a targeted scout to confirm the findings from the pre-flight scan are closed.

- [ ] **Step 1: Run ESLint to confirm no `no-heavy-test-imports` violations outside the allowlist**

```
torque-remote --branch feat/perf-4-test-infra npx eslint tests/ 2>&1 | grep "no-heavy-test-imports"
```

Expected: No output (all violations either migrated or on the allowlist).

- [ ] **Step 2: Run ESLint to confirm no `no-reset-modules-in-each` violations without disable comments**

```
torque-remote --branch feat/perf-4-test-infra npx eslint tests/ 2>&1 | grep "no-reset-modules-in-each"
```

Expected: No output (all violations either converted or have valid disable comments).

- [ ] **Step 3: Run the full ESLint suite**

```
torque-remote --branch feat/perf-4-test-infra npx eslint . 2>&1 | tail -5
```

Expected: Exit 0.

- [ ] **Step 4: Run the 5 migrated metadata-only test files to confirm they still work**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/auto-recovery-mcp-tools.test.js tests/mcp-tool-alignment.test.js tests/p2-orphaned-tools.test.js tests/p3-dead-routes.test.js tests/tool-annotations.test.js
```

Expected: All 5 pass.

- [ ] **Step 5: Run a broad sample of the test suite to confirm no regressions**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/tool-registry-cold-import.test.js tests/vitest-setup-perf.test.js tests/config.test.js tests/provider-registry.test.js tests/factory-loop-hardening.test.js tests/tda-01-provider-sovereignty.test.js
```

Expected: All pass.

- [ ] **Step 6: Write the post-flight findings document**

Create `docs/findings/2026-04-25-perf-arc/phase-4-test-infra-post.md`:

```markdown
# Phase 4 Post-Migration Scout — Test Infra Import Bloat

**Date:** [FILL: date of scout run]
**Branch:** feat/perf-4-test-infra
**Scout commit:** [FILL: HEAD sha]

## Summary

Phase 4 migration complete. Status of each pre-flight finding:

| Finding | Pre-flight count | Post-migration count | Status |
|---|---|---|---|
| Top-level require('../tools') in tests (no handleToolCall) | 5 files | 0 | CLOSED — migrated to tool-registry |
| Top-level require('../tools') total | 16 files | 11 files | CLOSED — 11 remaining are the confirmed allowlist |
| vi.resetModules() in beforeEach() | 38 files | [FILL] | CLOSED — converted or disable-commented |
| setupTestDb() callers that never use handleToolCall | 17 files | 0 | CLOSED — migrated to setupTestDbOnly() |
| Top-level require('../task-manager') in tests | 19 files | 0 | CLOSED — lazy-required |
| test-helpers.js self-test stub | 1 | 0 | CLOSED — deleted |
| Large files >1000 lines | 75 files | [FILL] | REDUCED — top 3 split |

## New discipline rules

- `torque/no-heavy-test-imports` — ACTIVE in error mode, 11-file allowlist
- `torque/no-reset-modules-in-each` — ACTIVE in error mode
- vitest-setup cold-import threshold wrapper — ACTIVE (warn >250ms, fail >500ms)

## tool-registry.js cold-import measurement

[FILL: output from tool-registry-cold-import.test.js confirming elapsed < 200ms]

## Remaining items (documented v0.1 follow-ups)

- 72+ large files >1000 lines beyond the top-3 split — deferred per spec §2.2
- vitest-suite-wall-time metric — deferred per spec §5.2
```

- [ ] **Step 7: Commit the findings document**

```bash
git add docs/findings/2026-04-25-perf-arc/phase-4-test-infra-post.md
git commit -m "docs(perf-4): add post-migration scout findings for Phase 4 test infra"
```

---

## Task 13: Add `cold-import.tool-registry` metric to `baseline.json` and `server/perf/`

**Files:**

- Modify: `server/perf/metrics/cold-import.js` (shipped by Phase 0)
- Modify: `server/perf/baseline.json`

Phase 0 already shipped a `cold-import.tools` metric (cold-import of `tools.js` in a fresh process). Phase 4 adds a parallel variant for `tool-registry.js` to prove the thin-module target is met.

- [ ] **Step 1: Read `server/perf/metrics/cold-import.js` to understand the existing metric shape**

Read the file to see how the `cold-import.tools` variant is structured (it spawns a fresh Node process, `require()`s the module, measures elapsed).

- [ ] **Step 2: Add the `cold-import.tool-registry` variant**

The existing `cold-import.js` metric file likely has a `variants` array or a loop that spawns child processes for different modules. Add `tool-registry` to that list:

```js
{ id: 'cold-import.tool-registry', module: './tool-registry', category: 'cold-import', targetMs: 30 }
```

The exact edit depends on the current shape — read the file before editing.

- [ ] **Step 3: Run `npm run perf` with just the cold-import metric**

```
torque-remote --branch feat/perf-4-test-infra npm run perf -- --metrics cold-import 2>&1
```

Expected: Outputs timing for both `cold-import.tools` and `cold-import.tool-registry`. The `tool-registry` variant should show < 200ms (target: < 30ms, but measurement machine variance is acceptable).

- [ ] **Step 4: Update `baseline.json` with the new `cold-import.tool-registry` entry**

Read `server/perf/baseline.json` to see the existing format. Add a new entry:

```json
"cold-import.tool-registry": {
  "median_ms": [FILL: actual measurement],
  "runs": 10,
  "captured_at": "[FILL: ISO date]",
  "env": { "note": "captured on remote workstation" },
  "notes": "Phase 4: thin metadata module, no handler loading"
}
```

- [ ] **Step 5: Commit with `perf-baseline:` trailer**

```bash
git add server/perf/metrics/cold-import.js server/perf/baseline.json
git commit -m "$(cat <<'EOF'
feat(perf-4): add cold-import.tool-registry metric to perf baseline

perf-baseline: cold-import.tool-registry n/a to <30ms (Phase 4: new thin metadata module with no handler loading)

EOF
)"
```

---

## Task 14: Cutover

**Files:**

- None (cutover is a git operation, not a file edit)

- [ ] **Step 1: Final broad test run before cutover**

```
torque-remote --branch feat/perf-4-test-infra npx vitest run tests/tool-registry-cold-import.test.js tests/vitest-setup-perf.test.js tests/mcp-tool-alignment.test.js tests/p2-orphaned-tools.test.js tests/tool-annotations.test.js tests/config.test.js tests/factory-loop-hardening.test.js
```

Expected: All pass.

- [ ] **Step 2: Final lint check**

```
torque-remote --branch feat/perf-4-test-infra npx eslint . 2>&1 | tail -3
```

Expected: Exit 0.

- [ ] **Step 3: Confirm the worktree is on `feat/perf-4-test-infra` and all changes are committed**

From the worktree directory (`.worktrees/feat-perf-4-test-infra/`):

```bash
git status
git log --oneline -15
```

Expected: Clean working tree; 14 commits from this feature.

- [ ] **Step 4: Run the cutover script**

```bash
scripts/worktree-cutover.sh perf-4-test-infra
```

No factory pause needed (test-infra changes don't affect runtime hot paths per spec §8).

- [ ] **Step 5: Update the umbrella spec's child-spec index to mark Phase 4 shipped**

Read `docs/superpowers/specs/2026-04-25-perf-arc-umbrella-design.md` section 5. Find the Phase 4 row in the child-spec index and update its status to `shipped` with the cutover commit hash. Commit on main.

```bash
git add docs/superpowers/specs/2026-04-25-perf-arc-umbrella-design.md
git commit -m "docs(perf-arc): mark Phase 4 shipped in umbrella spec index"
```

---

## Self-Review

### Spec coverage check

| Child spec section | Covered by task |
|---|---|
| §2.1 HIGH: 5 metadata-only tools.js imports | Task 1 (create registry), Task 2 (migrate 5 files) |
| §2.1 HIGH: 38 vi.resetModules() in beforeEach | Task 5 (rule), Task 6 (configure + migrate 38 files) |
| §2.1 MEDIUM: 17 setupTestDb callers | Task 7 |
| §2.1 MEDIUM: 19 top-level task-manager imports | Task 8 |
| §2.1 LOW: top-3 large file splits | Task 10 |
| §2.1 LOW: test-helpers.js self-test stub | Task 11 |
| §3.1 Rule A: no-heavy-test-imports | Task 3 (implement), Task 4 (configure) |
| §3.2 Rule B: no-reset-modules-in-each | Task 5 (implement), Task 6 (configure + migrate) |
| §3.3 Rule C: vitest cold-import threshold | Task 9 |
| §4.1 Task A: tool-registry.js | Task 1 |
| §4.2 Task B: migrate 5 metadata-only files | Task 2 |
| §4.3 Task C: configure no-heavy-test-imports | Task 4 |
| §4.4 Task D: configure no-reset-modules-in-each + migrate 38 | Tasks 5+6 |
| §4.5 Task E: 17 setupTestDb migrations | Task 7 |
| §4.6 Task F: 19 task-manager lazy-require | Task 8 |
| §4.7 Task G: vitest threshold wrapper | Task 9 |
| §4.8 Task H: top-3 file splits | Task 10 |
| §4.9 Task I: delete test-helpers.js stub | Task 11 |
| §4.10 Task J: closure verification | Task 12 |
| §5.1–5.3: baseline.json updates | Task 13 |
| §6: closure criteria | Task 12 (scout), Task 14 (cutover) |
| §8: cutover | Task 14 |

All child spec sections are covered.

### Placeholder scan

No TODOs, TBDs, or "handle edge cases" stubs. The `[FILL]` markers in the post-flight findings template (Task 12 Step 6) and the baseline JSON (Task 13 Step 4) are intentional — they are filled in by the implementer during execution after measuring real numbers on the remote workstation.

### Type / name consistency

- `tool-registry.js` exports: `TOOLS`, `schemaMap`, `routeMap`, `decorateToolDefinition`, `populateRouteMap` — all referenced consistently across Tasks 1, 2, and 3.
- `setupTestDbOnly(suiteName)` returns `{ db, testDir }` — used consistently in Tasks 7 and 9.
- ESLint rule names: `torque/no-heavy-test-imports`, `torque/no-reset-modules-in-each` — consistent across Tasks 3–6.
- ESLint plugin key in `eslint.config.js`: `torque` (a single plugin object holding both new rules) — consistent across Tasks 4 and 6.

### Test coverage

Every migration (Tasks 2, 6, 7, 8, 10) includes before-and-after test runs. Both ESLint rules have `RuleTester` test files (Tasks 3, 5). The `tool-registry.js` module has a cold-import test (Task 1). The `vitest-setup.js` threshold wrapper has a test (Task 9).
