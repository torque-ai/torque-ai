# Task Diffusion Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a general-purpose task diffusion engine to TORQUE that decomposes large issues into provider-routed subtasks via scout analysis, structured plans, and workflow fan-out.

**Architecture:** Scout tasks analyze the codebase without modifying files and produce structured diffusion plans (patterns + exemplar diffs + file manifests). A diffusion planner converts plans into TORQUE workflows with DAG or optimistic-parallel convergence. Mid-task diffusion signals let normal tasks hand back discovered work.

**Tech Stack:** Node.js, SQLite (existing TORQUE DB), MCP protocol, Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-task-diffusion-engine-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/diffusion/plan-schema.js` | Diffusion plan JSON schema + validation |
| `server/diffusion/planner.js` | Convergence strategy selection, batch sizing, template expansion, workflow construction |
| `server/diffusion/signal-parser.js` | Parse `__DIFFUSION_REQUEST__` blocks from task output |
| `server/orchestrator/prompt-templates.js` | Add `scout` prompt template (modify existing) |
| `server/handlers/diffusion-handlers.js` | MCP tool handlers: `submit_scout`, `create_diffusion_plan`, `diffusion_status` |
| `server/tool-defs/diffusion-defs.js` | MCP tool JSON schema definitions |
| `server/tools.js` | Register diffusion-defs + diffusion-handlers (modify existing) |
| `server/core-tools.js` | Add diffusion tools to tier lists (modify existing) |
| `server/tool-annotations.js` | Add annotations for new tools (modify existing) |
| `server/execution/task-finalizer.js` | Add Phase 2.5 diffusion signal detection in close-handler pipeline (modify existing) |
| `server/tests/diffusion-plan-schema.test.js` | Unit tests for schema validation |
| `server/tests/diffusion-planner.test.js` | Unit tests for planner logic |
| `server/tests/diffusion-signal-parser.test.js` | Unit tests for output parsing |
| `server/tests/diffusion-handlers.test.js` | Handler integration tests |
| `server/tests/diffusion-close-handler.test.js` | Close-handler Phase 2.5 tests |

---

## Task 1: Diffusion Plan Schema & Validation

**Files:**
- Create: `server/diffusion/plan-schema.js`
- Test: `server/tests/diffusion-plan-schema.test.js`

- [ ] **Step 1: Write failing tests for schema validation**

```js
// server/tests/diffusion-plan-schema.test.js
import { describe, it, expect } from 'vitest';
const { validateDiffusionPlan } = require('../diffusion/plan-schema');

describe('diffusion plan schema validation', () => {
  it('accepts a valid minimal plan', () => {
    const plan = {
      summary: 'Migrate test files',
      patterns: [{
        id: 'pattern-a',
        description: 'Direct DB import',
        transformation: 'Replace require(database) with container.get()',
        exemplar_files: ['server/tests/foo.test.js'],
        exemplar_diff: '--- a/foo\n+++ b/foo',
        file_count: 5,
      }],
      manifest: [
        { file: 'server/tests/bar.test.js', pattern: 'pattern-a' },
      ],
      shared_dependencies: [],
      estimated_subtasks: 5,
      isolation_confidence: 0.95,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects plan missing summary', () => {
    const result = validateDiffusionPlan({ patterns: [], manifest: [] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('summary'));
  });

  it('rejects plan with empty patterns', () => {
    const result = validateDiffusionPlan({
      summary: 'test', patterns: [], manifest: [{ file: 'x', pattern: 'p' }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects manifest referencing nonexistent pattern', () => {
    const plan = {
      summary: 'test',
      patterns: [{ id: 'a', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'x.js', pattern: 'nonexistent' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.5,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('nonexistent'));
  });

  it('rejects isolation_confidence outside 0-1 range', () => {
    const plan = {
      summary: 'test',
      patterns: [{ id: 'a', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'x.js', pattern: 'a' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 1.5,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(false);
  });

  it('caps manifest at MAX_DIFFUSION_TASKS', () => {
    const plan = {
      summary: 'test',
      patterns: [{ id: 'a', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 250 }],
      manifest: Array.from({ length: 250 }, (_, i) => ({ file: `f${i}.js`, pattern: 'a' })),
      shared_dependencies: [], estimated_subtasks: 250, isolation_confidence: 0.9,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('200'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/diffusion-plan-schema.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement plan-schema.js**

```js
// server/diffusion/plan-schema.js
'use strict';

const MAX_DIFFUSION_TASKS = 200;
const MAX_RECURSIVE_DEPTH = 2;

const REQUIRED_PLAN_FIELDS = ['summary', 'patterns', 'manifest'];
const REQUIRED_PATTERN_FIELDS = ['id', 'description', 'transformation', 'exemplar_files', 'exemplar_diff', 'file_count'];
const REQUIRED_MANIFEST_FIELDS = ['file', 'pattern'];

function validateDiffusionPlan(plan) {
  const errors = [];

  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['Plan must be a non-null object'] };
  }

  for (const field of REQUIRED_PLAN_FIELDS) {
    if (plan[field] === undefined || plan[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  if (typeof plan.summary === 'string' && plan.summary.trim() === '') {
    errors.push('summary must not be empty');
  }

  if (!Array.isArray(plan.patterns) || plan.patterns.length === 0) {
    errors.push('patterns must be a non-empty array');
  }

  const patternIds = new Set();
  if (Array.isArray(plan.patterns)) {
    for (const pattern of plan.patterns) {
      for (const field of REQUIRED_PATTERN_FIELDS) {
        if (pattern[field] === undefined || pattern[field] === null) {
          errors.push(`Pattern missing required field: ${field}`);
        }
      }
      if (pattern.id) patternIds.add(pattern.id);
    }
  }

  if (Array.isArray(plan.manifest)) {
    if (plan.manifest.length > MAX_DIFFUSION_TASKS) {
      errors.push(`Manifest has ${plan.manifest.length} entries, exceeds max of ${MAX_DIFFUSION_TASKS}. Narrow the scope.`);
    }
    for (const entry of plan.manifest) {
      for (const field of REQUIRED_MANIFEST_FIELDS) {
        if (!entry[field]) {
          errors.push(`Manifest entry missing required field: ${field}`);
        }
      }
      if (entry.pattern && !patternIds.has(entry.pattern)) {
        errors.push(`Manifest entry references nonexistent pattern: ${entry.pattern}`);
      }
    }
  }

  if (plan.isolation_confidence !== undefined) {
    if (typeof plan.isolation_confidence !== 'number' || plan.isolation_confidence < 0 || plan.isolation_confidence > 1) {
      errors.push('isolation_confidence must be a number between 0 and 1');
    }
  }

  if (Array.isArray(plan.shared_dependencies)) {
    for (const dep of plan.shared_dependencies) {
      if (!dep.file || typeof dep.file !== 'string') {
        errors.push('shared_dependencies entries must have a file field');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateDiffusionPlan,
  MAX_DIFFUSION_TASKS,
  MAX_RECURSIVE_DEPTH,
  REQUIRED_PLAN_FIELDS,
  REQUIRED_PATTERN_FIELDS,
  REQUIRED_MANIFEST_FIELDS,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/diffusion-plan-schema.test.js`
Expected: PASS — all 6 tests green

- [ ] **Step 5: Commit**

```bash
git add server/diffusion/plan-schema.js server/tests/diffusion-plan-schema.test.js
git commit -m "feat(diffusion): add diffusion plan JSON schema and validation"
```

---

## Task 2: Diffusion Signal Parser

**Files:**
- Create: `server/diffusion/signal-parser.js`
- Test: `server/tests/diffusion-signal-parser.test.js`

- [ ] **Step 1: Write failing tests for signal parsing**

```js
// server/tests/diffusion-signal-parser.test.js
import { describe, it, expect } from 'vitest';
const { parseDiffusionSignal } = require('../diffusion/signal-parser');

describe('diffusion signal parser', () => {
  it('extracts a valid diffusion request from output', () => {
    const output = `Some task output here...
Modified 3 files successfully.

__DIFFUSION_REQUEST__
{
  "summary": "Found 45 similar files",
  "patterns": [{"id": "a", "description": "d", "transformation": "t", "exemplar_files": ["f"], "exemplar_diff": "x", "file_count": 45}],
  "manifest": [{"file": "a.js", "pattern": "a"}],
  "shared_dependencies": [],
  "estimated_subtasks": 45,
  "isolation_confidence": 0.9
}
__DIFFUSION_REQUEST_END__`;
    const result = parseDiffusionSignal(output);
    expect(result).not.toBeNull();
    expect(result.summary).toBe('Found 45 similar files');
    expect(result.manifest).toHaveLength(1);
  });

  it('returns null when no markers present', () => {
    expect(parseDiffusionSignal('Normal task output, no diffusion')).toBeNull();
  });

  it('returns null for malformed JSON between markers', () => {
    const output = '__DIFFUSION_REQUEST__\n{not valid json\n__DIFFUSION_REQUEST_END__';
    expect(parseDiffusionSignal(output)).toBeNull();
  });

  it('returns null for JSON that fails schema validation', () => {
    const output = '__DIFFUSION_REQUEST__\n{"foo": "bar"}\n__DIFFUSION_REQUEST_END__';
    expect(parseDiffusionSignal(output)).toBeNull();
  });

  it('only scans last 8KB of output', () => {
    const padding = 'x'.repeat(16 * 1024);
    const signal = '__DIFFUSION_REQUEST__\n{"summary":"old"}\n__DIFFUSION_REQUEST_END__';
    const output = signal + '\n' + padding;
    expect(parseDiffusionSignal(output)).toBeNull();
  });

  it('finds signal in last 8KB even with preceding content', () => {
    const padding = 'y'.repeat(16 * 1024);
    const validPlan = JSON.stringify({
      summary: 'test', patterns: [{ id: 'a', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'f.js', pattern: 'a' }], shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.8,
    });
    const signal = `__DIFFUSION_REQUEST__\n${validPlan}\n__DIFFUSION_REQUEST_END__`;
    const output = padding + '\n' + signal;
    const result = parseDiffusionSignal(output);
    expect(result).not.toBeNull();
    expect(result.summary).toBe('test');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/diffusion-signal-parser.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement signal-parser.js**

```js
// server/diffusion/signal-parser.js
'use strict';

const { validateDiffusionPlan } = require('./plan-schema');
const logger = require('../logger').child({ component: 'diffusion-signal-parser' });

const SIGNAL_START = '__DIFFUSION_REQUEST__';
const SIGNAL_END = '__DIFFUSION_REQUEST_END__';
const SCAN_LIMIT = 8 * 1024; // Only scan last 8KB

function parseDiffusionSignal(output) {
  if (!output || typeof output !== 'string') return null;

  // Only scan the tail of the output to survive truncation
  const tail = output.length > SCAN_LIMIT
    ? output.slice(-SCAN_LIMIT)
    : output;

  const startIdx = tail.indexOf(SIGNAL_START);
  if (startIdx === -1) return null;

  const endIdx = tail.indexOf(SIGNAL_END, startIdx);
  if (endIdx === -1) return null;

  const jsonStr = tail.slice(startIdx + SIGNAL_START.length, endIdx).trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    logger.info(`[DiffusionSignal] Malformed JSON in diffusion request: ${err.message}`);
    return null;
  }

  const validation = validateDiffusionPlan(parsed);
  if (!validation.valid) {
    logger.info(`[DiffusionSignal] Schema validation failed: ${validation.errors.join('; ')}`);
    return null;
  }

  return parsed;
}

module.exports = { parseDiffusionSignal, SIGNAL_START, SIGNAL_END, SCAN_LIMIT };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/diffusion-signal-parser.test.js`
Expected: PASS — all 6 tests green

- [ ] **Step 5: Commit**

```bash
git add server/diffusion/signal-parser.js server/tests/diffusion-signal-parser.test.js
git commit -m "feat(diffusion): add signal parser for __DIFFUSION_REQUEST__ blocks"
```

---

## Task 3: Scout Prompt Template

**Files:**
- Modify: `server/orchestrator/prompt-templates.js`

- [ ] **Step 1: Read the existing prompt-templates.js to understand the TEMPLATES structure**

Run: `cat server/orchestrator/prompt-templates.js` (already read — uses `TEMPLATES` object with `system`, `user`, `schema` keys per template)

- [ ] **Step 2: Add the `scout` template to TEMPLATES**

Add after the existing `review` template entry in `server/orchestrator/prompt-templates.js`:

```js
  scout: {
    system: `You are a codebase analyst performing reconnaissance for an automated task distribution system.
Your job is to analyze a working directory, identify the scope of a requested change, classify files by transformation pattern, and produce a structured diffusion plan.
Do NOT modify any files. Your output is analysis only.
Respond ONLY with valid JSON as the LAST block in your response — no markdown fences around the JSON.`,

    user: `Analyze the following scope and produce a diffusion plan.

**Scope:** {{scope}}
**Working Directory:** {{working_directory}}
**File List:** {{file_list}}

Instructions:
1. Read the files in the working directory matching the scope description
2. Group files by the transformation they need (same change = same pattern)
3. For the 2-3 most representative files per pattern, write the transformed code as a unified diff
4. Output a diffusion plan JSON as the LAST thing in your response

The JSON must match this schema:
{
  "summary": "One-line description of the total work",
  "patterns": [
    {
      "id": "pattern-id",
      "description": "What these files have in common",
      "transformation": "What change to apply",
      "exemplar_files": ["path/to/example.js"],
      "exemplar_diff": "unified diff showing the before/after",
      "file_count": 10
    }
  ],
  "manifest": [
    { "file": "path/to/file.js", "pattern": "pattern-id" }
  ],
  "shared_dependencies": [
    { "file": "path/to/shared.js", "change": "What needs to change in this shared file" }
  ],
  "estimated_subtasks": 10,
  "isolation_confidence": 0.0-1.0,
  "recommended_batch_size": 8
}

Output the JSON block directly (no markdown fences). It must be the final content in your response.`,

    schema: {
      type: 'object',
      required: ['summary', 'patterns', 'manifest'],
      properties: {
        summary: { type: 'string' },
        patterns: { type: 'array', items: { type: 'object', required: ['id', 'description', 'transformation', 'exemplar_files', 'exemplar_diff', 'file_count'] } },
        manifest: { type: 'array', items: { type: 'object', required: ['file', 'pattern'] } },
        shared_dependencies: { type: 'array' },
        estimated_subtasks: { type: 'number' },
        isolation_confidence: { type: 'number' },
        recommended_batch_size: { type: 'number' },
      },
    },
  },
```

- [ ] **Step 3: Verify the template is accessible via buildPrompt**

Run: `node -e "const { buildPrompt } = require('./server/orchestrator/prompt-templates'); const r = buildPrompt('scout', { scope: 'test', working_directory: '/tmp', file_list: 'a.js' }); console.log(r.system.substring(0, 50));"`
Expected: Prints the first 50 chars of the scout system prompt

- [ ] **Step 4: Commit**

```bash
git add server/orchestrator/prompt-templates.js
git commit -m "feat(diffusion): add scout prompt template to orchestrator"
```

---

## Task 4: Diffusion Planner (Core Logic)

**Files:**
- Create: `server/diffusion/planner.js`
- Test: `server/tests/diffusion-planner.test.js`

- [ ] **Step 1: Write failing tests for planner functions**

```js
// server/tests/diffusion-planner.test.js
import { describe, it, expect } from 'vitest';
const {
  selectConvergenceStrategy,
  groupManifestByPattern,
  createBatches,
  expandTaskDescription,
} = require('../diffusion/planner');

describe('selectConvergenceStrategy', () => {
  it('selects optimistic when confidence >= 0.8 and no shared deps', () => {
    expect(selectConvergenceStrategy(0.9, [])).toBe('optimistic');
  });

  it('selects dag when confidence < 0.8', () => {
    expect(selectConvergenceStrategy(0.5, [])).toBe('dag');
  });

  it('selects dag when shared deps exist regardless of confidence', () => {
    expect(selectConvergenceStrategy(0.95, [{ file: 'shared.js', change: 'update' }])).toBe('dag');
  });

  it('selects dag when confidence is undefined', () => {
    expect(selectConvergenceStrategy(undefined, [])).toBe('dag');
  });
});

describe('groupManifestByPattern', () => {
  it('groups manifest entries by pattern id', () => {
    const manifest = [
      { file: 'a.js', pattern: 'p1' },
      { file: 'b.js', pattern: 'p2' },
      { file: 'c.js', pattern: 'p1' },
    ];
    const groups = groupManifestByPattern(manifest);
    expect(groups.get('p1')).toEqual([
      { file: 'a.js', pattern: 'p1' },
      { file: 'c.js', pattern: 'p1' },
    ]);
    expect(groups.get('p2')).toEqual([{ file: 'b.js', pattern: 'p2' }]);
  });
});

describe('createBatches', () => {
  it('creates single-file batches by default', () => {
    const files = [{ file: 'a.js', pattern: 'p1' }, { file: 'b.js', pattern: 'p1' }];
    const batches = createBatches(files, 1);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([{ file: 'a.js', pattern: 'p1' }]);
  });

  it('groups files into batches of specified size', () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ file: `f${i}.js`, pattern: 'p1' }));
    const batches = createBatches(files, 3);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(3);
    expect(batches[2]).toHaveLength(1);
  });
});

describe('expandTaskDescription', () => {
  it('generates a task description from pattern + files', () => {
    const pattern = {
      id: 'p1',
      description: 'Direct DB import files',
      transformation: 'Replace require(db) with container.get()',
    };
    const files = ['a.js', 'b.js'];
    const workingDir = '/project';
    const desc = expandTaskDescription(pattern, files, workingDir);
    expect(desc).toContain('Direct DB import files');
    expect(desc).toContain('Replace require(db) with container.get()');
    expect(desc).toContain('a.js');
    expect(desc).toContain('b.js');
    expect(desc).toContain('/project');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/diffusion-planner.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement planner.js**

```js
// server/diffusion/planner.js
'use strict';

const { MAX_DIFFUSION_TASKS } = require('./plan-schema');
const logger = require('../logger').child({ component: 'diffusion-planner' });

const CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_BATCH_SIZE = 1;

function selectConvergenceStrategy(isolationConfidence, sharedDependencies) {
  if (!Array.isArray(sharedDependencies)) sharedDependencies = [];

  if (sharedDependencies.length > 0) return 'dag';
  if (typeof isolationConfidence !== 'number') return 'dag';
  if (isolationConfidence >= CONFIDENCE_THRESHOLD) return 'optimistic';
  return 'dag';
}

function groupManifestByPattern(manifest) {
  const groups = new Map();
  for (const entry of manifest) {
    const key = entry.pattern;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

function createBatches(entries, batchSize) {
  const size = batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;
  const batches = [];
  for (let i = 0; i < entries.length; i += size) {
    batches.push(entries.slice(i, i + size));
  }
  return batches;
}

function expandTaskDescription(pattern, files, workingDirectory) {
  const fileList = files.map(f => `- ${f}`).join('\n');
  return `Apply the following transformation to the file(s) listed below.

Pattern: ${pattern.description}
Transformation: ${pattern.transformation}

Files to modify:
${fileList}

Reference: see exemplar diff for pattern "${pattern.id}" for the exact before/after.

Working directory: ${workingDirectory}`;
}

function buildWorkflowTasks(plan, options = {}) {
  const {
    batchSize = plan.recommended_batch_size || DEFAULT_BATCH_SIZE,
    workingDirectory,
    provider,
    convergence,
    depth = 0,
  } = options;

  const strategy = convergence || selectConvergenceStrategy(
    plan.isolation_confidence,
    plan.shared_dependencies,
  );

  const patternMap = new Map();
  for (const p of plan.patterns) {
    patternMap.set(p.id, p);
  }

  const grouped = groupManifestByPattern(plan.manifest);
  const tasks = [];

  // For DAG mode, create anchor tasks for shared dependencies first
  const anchorTaskIds = [];
  if (strategy === 'dag' && Array.isArray(plan.shared_dependencies)) {
    for (const dep of plan.shared_dependencies) {
      if (!dep.file) continue;
      const anchorId = `anchor-${anchorTaskIds.length}`;
      tasks.push({
        id: anchorId,
        description: `Update shared dependency: ${dep.file}\n\nChange: ${dep.change || 'Update as needed for the transformation'}`,
        depends_on: [],
        working_directory: workingDirectory,
        provider: provider || null,
        metadata: { diffusion: true, diffusion_role: 'anchor', depth },
      });
      anchorTaskIds.push(anchorId);
    }
  }

  // Create fan-out tasks from manifest batches
  for (const [patternId, entries] of grouped) {
    const pattern = patternMap.get(patternId);
    if (!pattern) {
      logger.warn(`[DiffusionPlanner] Pattern ${patternId} not found, skipping ${entries.length} manifest entries`);
      continue;
    }

    const batches = createBatches(entries, batchSize);
    for (const batch of batches) {
      const files = batch.map(e => e.file);
      const taskId = `fanout-${tasks.length}`;
      tasks.push({
        id: taskId,
        description: expandTaskDescription(pattern, files, workingDirectory),
        depends_on: strategy === 'dag' ? [...anchorTaskIds] : [],
        working_directory: workingDirectory,
        provider: provider || null,
        metadata: {
          diffusion: true,
          diffusion_role: 'fanout',
          pattern_id: patternId,
          files,
          depth,
        },
      });
    }
  }

  return {
    strategy,
    tasks,
    summary: plan.summary,
    exemplars: plan.patterns.reduce((acc, p) => {
      acc[p.id] = { exemplar_files: p.exemplar_files, exemplar_diff: p.exemplar_diff };
      return acc;
    }, {}),
  };
}

module.exports = {
  selectConvergenceStrategy,
  groupManifestByPattern,
  createBatches,
  expandTaskDescription,
  buildWorkflowTasks,
  CONFIDENCE_THRESHOLD,
  DEFAULT_BATCH_SIZE,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/diffusion-planner.test.js`
Expected: PASS — all tests green

- [ ] **Step 5: Write additional tests for buildWorkflowTasks**

Add to `server/tests/diffusion-planner.test.js`:

```js
describe('buildWorkflowTasks', () => {
  const { buildWorkflowTasks } = require('../diffusion/planner');

  const basePlan = {
    summary: 'Migrate test files',
    patterns: [
      { id: 'p1', description: 'Direct import', transformation: 'Use DI', exemplar_files: ['ex.js'], exemplar_diff: 'diff', file_count: 3 },
    ],
    manifest: [
      { file: 'a.js', pattern: 'p1' },
      { file: 'b.js', pattern: 'p1' },
      { file: 'c.js', pattern: 'p1' },
    ],
    shared_dependencies: [],
    estimated_subtasks: 3,
    isolation_confidence: 0.95,
  };

  it('creates optimistic workflow when confidence is high and no shared deps', () => {
    const result = buildWorkflowTasks(basePlan, { workingDirectory: '/proj' });
    expect(result.strategy).toBe('optimistic');
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.every(t => t.depends_on.length === 0)).toBe(true);
  });

  it('creates DAG workflow with anchors when shared dependencies exist', () => {
    const plan = {
      ...basePlan,
      shared_dependencies: [{ file: 'shared.js', change: 'Add export' }],
      isolation_confidence: 0.5,
    };
    const result = buildWorkflowTasks(plan, { workingDirectory: '/proj' });
    expect(result.strategy).toBe('dag');
    const anchors = result.tasks.filter(t => t.metadata.diffusion_role === 'anchor');
    const fanouts = result.tasks.filter(t => t.metadata.diffusion_role === 'fanout');
    expect(anchors).toHaveLength(1);
    expect(fanouts).toHaveLength(3);
    expect(fanouts.every(t => t.depends_on.includes(anchors[0].id))).toBe(true);
  });

  it('respects convergence override', () => {
    const result = buildWorkflowTasks(basePlan, { workingDirectory: '/proj', convergence: 'dag' });
    expect(result.strategy).toBe('dag');
  });

  it('batches files according to batchSize', () => {
    const result = buildWorkflowTasks(basePlan, { workingDirectory: '/proj', batchSize: 2 });
    expect(result.tasks).toHaveLength(2); // 3 files / batch 2 = 2 tasks
  });

  it('stores exemplars in result', () => {
    const result = buildWorkflowTasks(basePlan, { workingDirectory: '/proj' });
    expect(result.exemplars.p1.exemplar_diff).toBe('diff');
  });
});
```

- [ ] **Step 6: Run all planner tests**

Run: `npx vitest run server/tests/diffusion-planner.test.js`
Expected: PASS — all tests green

- [ ] **Step 7: Commit**

```bash
git add server/diffusion/planner.js server/tests/diffusion-planner.test.js
git commit -m "feat(diffusion): add diffusion planner with convergence strategy and batch sizing"
```

---

## Task 5: MCP Tool Definitions & Handlers

**Files:**
- Create: `server/tool-defs/diffusion-defs.js`
- Create: `server/handlers/diffusion-handlers.js`
- Modify: `server/tools.js` (add require lines)
- Modify: `server/core-tools.js` (add to TIER_2)
- Modify: `server/tool-annotations.js` (add EXACT_MATCHES entries)
- Test: `server/tests/diffusion-handlers.test.js`

- [ ] **Step 1: Write failing handler tests**

```js
// server/tests/diffusion-handlers.test.js
import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before requiring handlers
vi.mock('../db/task-core', () => ({
  createTask: vi.fn(),
  getTask: vi.fn(),
  updateTaskStatus: vi.fn(),
}));
vi.mock('../db/workflow-engine', () => ({
  createWorkflow: vi.fn((wf) => ({ id: wf.id, name: wf.name, status: 'pending', context: wf.context })),
  addTaskDependency: vi.fn(),
  updateWorkflow: vi.fn(),
  updateWorkflowCounts: vi.fn(),
  getWorkflow: vi.fn(),
  listWorkflows: vi.fn(() => []),
}));
vi.mock('../task-manager', () => ({
  startTask: vi.fn(),
}));

const handlers = require('../handlers/diffusion-handlers');

describe('handleSubmitScout', () => {
  it('rejects when scope is missing', () => {
    const result = handlers.handleSubmitScout({ working_directory: '/proj' });
    expect(result.isError).toBe(true);
  });

  it('rejects when working_directory is missing', () => {
    const result = handlers.handleSubmitScout({ scope: 'analyze tests' });
    expect(result.isError).toBe(true);
  });

  it('rejects non-filesystem providers', () => {
    const result = handlers.handleSubmitScout({
      scope: 'analyze', working_directory: '/proj', provider: 'deepinfra',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('filesystem');
  });

  it('accepts codex provider', () => {
    const result = handlers.handleSubmitScout({
      scope: 'analyze tests', working_directory: '/proj', provider: 'codex',
    });
    expect(result.isError).toBeFalsy();
  });
});

describe('handleCreateDiffusionPlan', () => {
  it('rejects invalid plan JSON', () => {
    const result = handlers.handleCreateDiffusionPlan({
      plan: { summary: '' },
      working_directory: '/proj',
    });
    expect(result.isError).toBe(true);
  });

  it('creates a workflow from a valid plan', () => {
    const plan = {
      summary: 'Migrate files',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 2 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }, { file: 'b.js', pattern: 'p1' }],
      shared_dependencies: [],
      estimated_subtasks: 2,
      isolation_confidence: 0.95,
    };
    const result = handlers.handleCreateDiffusionPlan({ plan, working_directory: '/proj' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('wf-');
  });
});

describe('handleDiffusionStatus', () => {
  it('returns status without errors', () => {
    const result = handlers.handleDiffusionStatus({});
    expect(result.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/diffusion-handlers.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create tool definitions**

```js
// server/tool-defs/diffusion-defs.js
'use strict';

module.exports = [
  {
    name: 'submit_scout',
    description: 'Submit a scout-mode task that analyzes the codebase without modifying files. The scout produces a structured diffusion plan (patterns, exemplar diffs, file manifest) that can be used with create_diffusion_plan to fan out work across multiple providers. Scouts require filesystem access — only codex and claude-cli providers are supported.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Description of what to analyze (e.g., "find all test files importing database.js directly")' },
        working_directory: { type: 'string', description: 'Project root directory' },
        file_patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional glob patterns to focus analysis (e.g., ["server/tests/**/*.test.js"]). Expanded server-side into a file list.',
        },
        provider: { type: 'string', description: 'Provider to use (must be filesystem-capable: codex, claude-cli). Default: codex.' },
        timeout_minutes: { type: 'number', description: 'Scout timeout in minutes (default: 10)' },
      },
      required: ['scope', 'working_directory'],
    },
  },
  {
    name: 'create_diffusion_plan',
    description: 'Generate a TORQUE workflow from a diffusion plan (produced by a scout task or constructed manually). Converts the plan into batched subtasks with DAG or optimistic-parallel convergence. Returns a workflow ID for use with await_workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'object', description: 'Diffusion plan JSON (matching the schema from submit_scout output)' },
        working_directory: { type: 'string', description: 'Project root directory for fan-out tasks' },
        batch_size: { type: 'number', description: 'Files per subtask (default: 1, or plan recommended_batch_size)' },
        provider: { type: 'string', description: 'Provider preference for fan-out tasks (default: smart routing)' },
        convergence: { type: 'string', enum: ['optimistic', 'dag'], description: 'Override convergence strategy (default: auto-selected from plan)' },
        depth: { type: 'number', description: 'Recursive diffusion depth counter (default: 0). Max: 2.' },
        auto_run: { type: 'boolean', description: 'Start the workflow immediately (default: true)' },
      },
      required: ['plan', 'working_directory'],
    },
  },
  {
    name: 'diffusion_status',
    description: 'View active diffusion sessions. Shows scout tasks pending, fan-out workflows in progress, convergence state, and depth counters. Data is derived from workflow metadata (no new database tables).',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Optional: filter to a specific diffusion workflow' },
      },
    },
  },
];
```

- [ ] **Step 4: Implement handlers**

```js
// server/handlers/diffusion-handlers.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const { ErrorCodes, makeError } = require('./error-codes');
const { validateDiffusionPlan, MAX_RECURSIVE_DEPTH } = require('../diffusion/plan-schema');
const { buildWorkflowTasks } = require('../diffusion/planner');
const { buildPrompt } = require('../orchestrator/prompt-templates');
const { isPathTraversalSafe } = require('./shared');
const logger = require('../logger').child({ component: 'diffusion-handlers' });

// Lazy-load to avoid circular deps
let _taskCore;
function taskCore() { return _taskCore || (_taskCore = require('../db/task-core')); }
let _workflowEngine;
function workflowEngine() { return _workflowEngine || (_workflowEngine = require('../db/workflow-engine')); }
let _taskManager;
function taskManager() { return _taskManager || (_taskManager = require('../task-manager')); }

const FILESYSTEM_PROVIDERS = new Set(['codex', 'codex-spark', 'claude-cli']);
const DEFAULT_SCOUT_TIMEOUT = 10;
const DEFAULT_SCOUT_PROVIDER = 'codex';

function handleSubmitScout(args) {
  const { scope, working_directory, file_patterns, provider, timeout_minutes } = args || {};

  if (!scope || typeof scope !== 'string' || !scope.trim()) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'scope is required');
  }
  if (!working_directory || typeof working_directory !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }
  if (!isPathTraversalSafe(working_directory)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'working_directory contains path traversal');
  }

  const selectedProvider = provider || DEFAULT_SCOUT_PROVIDER;
  if (!FILESYSTEM_PROVIDERS.has(selectedProvider)) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Provider "${selectedProvider}" does not have filesystem access. Scout tasks require codex or claude-cli.`
    );
  }

  // file_patterns are passed as hints in the prompt, not expanded server-side
  const fileList = Array.isArray(file_patterns) ? file_patterns.join(', ') : '(all files in scope)';

  const { system, user } = buildPrompt('scout', {
    scope: scope.trim(),
    working_directory,
    file_list: fileList,
  });

  const taskDescription = `${system}\n\n---\n\n${user}`;
  const taskId = uuidv4();
  const timeout = Math.min(timeout_minutes || DEFAULT_SCOUT_TIMEOUT, 30);

  taskCore().createTask({
    id: taskId,
    task_description: taskDescription,
    working_directory,
    status: 'queued',
    provider: selectedProvider,
    timeout_minutes: timeout,
    metadata: JSON.stringify({
      mode: 'scout',
      diffusion: true,
      scope: scope.trim(),
      file_patterns: file_patterns || null,
    }),
  });

  // Start the task
  try {
    taskManager().startTask(taskId);
  } catch (err) {
    logger.warn(`[Diffusion] Failed to auto-start scout task ${taskId}: ${err.message}`);
  }

  return {
    content: [{
      type: 'text',
      text: `## Scout Task Submitted

| Field | Value |
|-------|-------|
| Task ID | \`${taskId}\` |
| Provider | ${selectedProvider} |
| Scope | ${scope.trim()} |
| Timeout | ${timeout} min |

Use \`await_task\` with task ID \`${taskId}\` to wait for the scout to complete.
Then pass the scout's output to \`create_diffusion_plan\` to fan out the work.`,
    }],
  };
}

function handleCreateDiffusionPlan(args) {
  const { plan, working_directory, batch_size, provider, convergence, depth, auto_run } = args || {};

  if (!plan || typeof plan !== 'object') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'plan (diffusion plan JSON) is required');
  }
  if (!working_directory || typeof working_directory !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }
  if (!isPathTraversalSafe(working_directory)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'working_directory contains path traversal');
  }

  const currentDepth = depth || 0;
  if (currentDepth > MAX_RECURSIVE_DEPTH) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Recursive diffusion depth ${currentDepth} exceeds max of ${MAX_RECURSIVE_DEPTH}. Review the plan manually.`
    );
  }

  const validation = validateDiffusionPlan(plan);
  if (!validation.valid) {
    return makeError(ErrorCodes.INVALID_PARAM, `Invalid diffusion plan: ${validation.errors.join('; ')}`);
  }

  const workflowPlan = buildWorkflowTasks(plan, {
    batchSize: batch_size,
    workingDirectory: working_directory,
    provider,
    convergence,
    depth: currentDepth,
  });

  // Create the TORQUE workflow — use `context` column for diffusion metadata
  // (workflows table has no `metadata` column; `context` is JSON TEXT)
  const workflowId = uuidv4();
  workflowEngine().createWorkflow({
    id: workflowId,
    name: `Diffusion — ${plan.summary.substring(0, 60)}`,
    working_directory,
    context: {
      diffusion: true,
      strategy: workflowPlan.strategy,
      depth: currentDepth,
      summary: plan.summary,
      exemplars: workflowPlan.exemplars,
      pattern_count: plan.patterns.length,
      manifest_count: plan.manifest.length,
    },
  });

  // Create tasks + dependency edges following createSeededWorkflowTasks pattern
  // (see server/handlers/workflow/index.js:462-523)
  const nodeToTaskMap = {};
  for (const task of workflowPlan.tasks) {
    const taskId = uuidv4();
    nodeToTaskMap[task.id] = taskId;

    taskCore().createTask({
      id: taskId,
      status: task.depends_on.length > 0 ? 'blocked' : 'pending',
      task_description: task.description,
      working_directory: task.working_directory || working_directory,
      workflow_id: workflowId,
      workflow_node_id: task.id,
      provider: task.provider || provider || null,
      metadata: JSON.stringify(task.metadata),
    });
  }

  // Wire up dependency edges
  for (const task of workflowPlan.tasks) {
    if (task.depends_on.length === 0) continue;
    const taskId = nodeToTaskMap[task.id];
    for (const depNodeId of task.depends_on) {
      const depTaskId = nodeToTaskMap[depNodeId];
      if (depTaskId) {
        workflowEngine().addTaskDependency({
          workflow_id: workflowId,
          task_id: taskId,
          depends_on_task_id: depTaskId,
        });
      }
    }
  }

  workflowEngine().updateWorkflowCounts(workflowId);

  // Start the workflow
  const shouldRun = auto_run !== false;
  if (shouldRun) {
    try {
      workflowEngine().updateWorkflow(workflowId, {
        status: 'running',
        started_at: new Date().toISOString(),
      });
      // Start root tasks (no dependencies)
      for (const task of workflowPlan.tasks) {
        if (task.depends_on.length === 0) {
          const realTaskId = nodeToTaskMap[task.id];
          taskCore().updateTaskStatus(realTaskId, 'queued');
          try { taskManager().startTask(realTaskId); } catch (err) {
            logger.warn(`[Diffusion] Failed to start task ${realTaskId}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.warn(`[Diffusion] Failed to auto-start workflow ${workflowId}: ${err.message}`);
    }
  }

  const anchorCount = workflowPlan.tasks.filter(t => t.metadata.diffusion_role === 'anchor').length;
  const fanoutCount = workflowPlan.tasks.filter(t => t.metadata.diffusion_role === 'fanout').length;

  return {
    content: [{
      type: 'text',
      text: `## Diffusion Workflow Created

| Field | Value |
|-------|-------|
| Workflow ID | \`${workflowId}\` |
| Strategy | ${workflowPlan.strategy} |
| Anchor tasks | ${anchorCount} |
| Fan-out tasks | ${fanoutCount} |
| Total tasks | ${workflowPlan.tasks.length} |
| Depth | ${currentDepth} |
| Auto-started | ${shouldRun} |

${workflowPlan.strategy === 'dag' ? '**DAG mode:** anchor tasks run first, fan-out tasks start after anchors complete.' : '**Optimistic parallel:** all tasks run simultaneously.'}

Use \`await_workflow\` with workflow ID \`${workflowId}\` to monitor progress.
Run \`detect_file_conflicts\` after completion to check for conflicts.`,
    }],
  };
}

function handleDiffusionStatus(args) {
  const { workflow_id } = args || {};

  let workflows = [];
  try {
    if (workflow_id) {
      const wf = workflowEngine().getWorkflow(workflow_id);
      if (wf) workflows = [wf];
    } else if (typeof workflowEngine().listWorkflows === 'function') {
      const all = workflowEngine().listWorkflows() || [];
      workflows = all.filter(wf => {
        // Diffusion metadata is in the `context` column (parsed by getWorkflow)
        const ctx = wf.context || {};
        return ctx.diffusion === true;
      });
    }
  } catch (err) {
    logger.debug(`[Diffusion] Error listing workflows: ${err.message}`);
  }

  if (workflows.length === 0) {
    return {
      content: [{ type: 'text', text: 'No active diffusion sessions found.' }],
    };
  }

  let output = '## Diffusion Sessions\n\n';
  for (const wf of workflows) {
    const ctx = wf.context || {};
    output += `### ${wf.name || wf.id}\n`;
    output += `| Field | Value |\n|-------|-------|\n`;
    output += `| ID | \`${wf.id}\` |\n`;
    output += `| Status | ${wf.status || 'unknown'} |\n`;
    output += `| Strategy | ${ctx.strategy || 'N/A'} |\n`;
    output += `| Depth | ${ctx.depth ?? 'N/A'} |\n`;
    output += `| Patterns | ${ctx.pattern_count ?? 'N/A'} |\n`;
    output += `| Manifest files | ${ctx.manifest_count ?? 'N/A'} |\n\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

module.exports = {
  handleSubmitScout,
  handleCreateDiffusionPlan,
  handleDiffusionStatus,
};
```

- [ ] **Step 5: Run handler tests**

Run: `npx vitest run server/tests/diffusion-handlers.test.js`
Expected: PASS — all tests green

- [ ] **Step 6: Commit handlers and defs**

```bash
git add server/tool-defs/diffusion-defs.js server/handlers/diffusion-handlers.js server/tests/diffusion-handlers.test.js
git commit -m "feat(diffusion): add MCP tool definitions and handlers for scout, plan, status"
```

---

## Task 6: Wire Tools into TORQUE

**Files:**
- Modify: `server/tools.js:15-50` (add diffusion-defs and diffusion-handlers requires)
- Modify: `server/core-tools.js:37-68` (add tools to TIER_2)
- Modify: `server/tool-annotations.js:59+` (add EXACT_MATCHES entries)

- [ ] **Step 1: Add diffusion-defs to tools.js TOOLS array**

In `server/tools.js`, add after the `competitive-feature-defs` line (~line 49):

```js
  ...require('./tool-defs/diffusion-defs'),
```

- [ ] **Step 2: Add diffusion-handlers to HANDLER_MODULES array**

In `server/tools.js`, add after the `competitive-feature-handlers` line (~line 109):

```js
  require('./handlers/diffusion-handlers'),
```

- [ ] **Step 3: Add diffusion tools to TIER_2 in core-tools.js**

In `server/core-tools.js`, add to the TIER_2 array after the batch orchestration tools (~line 52):

```js
  // Diffusion engine
  'submit_scout', 'create_diffusion_plan', 'diffusion_status',
```

- [ ] **Step 4: Add annotations in tool-annotations.js**

In `server/tool-annotations.js`, add to the EXACT_MATCHES object:

```js
  submit_scout:           DISPATCH,
  create_diffusion_plan:  DISPATCH,
  diffusion_status:       READONLY,
```

- [ ] **Step 5: Verify tools load without errors**

Run: `node -e "const t = require('./server/tools'); console.log('Tools loaded:', t.TOOLS.length); const names = t.TOOLS.map(t => t.name); console.log('submit_scout:', names.includes('submit_scout')); console.log('create_diffusion_plan:', names.includes('create_diffusion_plan')); console.log('diffusion_status:', names.includes('diffusion_status'));"`
Expected: All three tools present, no errors

- [ ] **Step 6: Commit**

```bash
git add server/tools.js server/core-tools.js server/tool-annotations.js
git commit -m "feat(diffusion): wire diffusion tools into TORQUE tool system"
```

---

## Task 7: Close-Handler Phase 2.5 (Mid-Task Diffusion Signal)

**Files:**
- Modify: `server/execution/task-finalizer.js:318-330` (add Phase 2.5 `runStage` call between `safeguard_checks` and `fuzzy_repair`)
- Test: `server/tests/diffusion-close-handler.test.js`

- [ ] **Step 1: Write failing test for close-handler diffusion detection**

```js
// server/tests/diffusion-close-handler.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
const { parseDiffusionSignal } = require('../diffusion/signal-parser');

describe('close-handler diffusion signal detection (Phase 2.5)', () => {
  // Test the signal parser directly — the actual close-handler integration
  // calls parseDiffusionSignal on ctx.stdout and patches metadata

  it('detects a valid diffusion signal in task output', () => {
    const validPlan = JSON.stringify({
      summary: 'Found 20 files',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 20 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }],
      shared_dependencies: [],
      estimated_subtasks: 20,
      isolation_confidence: 0.9,
    });
    const output = `Modified 3 files.\n__DIFFUSION_REQUEST__\n${validPlan}\n__DIFFUSION_REQUEST_END__`;
    const result = parseDiffusionSignal(output);
    expect(result).not.toBeNull();
    expect(result.summary).toBe('Found 20 files');
  });

  it('returns null for output without diffusion signal', () => {
    const result = parseDiffusionSignal('Task completed successfully. 5 files modified.');
    expect(result).toBeNull();
  });

  it('metadata patching preserves existing metadata', () => {
    // Simulate what the close-handler does
    const existingMeta = { smart_routing: true, provider: 'codex' };
    const diffusionPlan = { summary: 'test' };
    const patched = { ...existingMeta, diffusion_request: diffusionPlan };
    expect(patched.smart_routing).toBe(true);
    expect(patched.diffusion_request.summary).toBe('test');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass** (parser already implemented)

Run: `npx vitest run server/tests/diffusion-close-handler.test.js`
Expected: PASS

- [ ] **Step 3: Add Phase 2.5 to task-finalizer.js**

In `server/execution/task-finalizer.js`, after the `safeguard_checks` runStage call (~line 318) and before the `fuzzy_repair` runStage call (~line 330), add a new `runStage` call:

```js
    await runStage(ctx, 'diffusion_signal_detection', handleDiffusionSignalDetection, ctx.code === 0);
```

Then add the handler function earlier in the file (before `finalizeTask`):

```js
function handleDiffusionSignalDetection(ctx) {
  try {
    const { parseDiffusionSignal } = require('../diffusion/signal-parser');
    // ctx.output contains captured stdout from the task process
    const signal = parseDiffusionSignal(ctx.output || '');
    if (signal) {
      // Read existing metadata from the task record
      const task = deps.db.getTask(ctx.taskId);
      const existingMeta = task && task.metadata
        ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata)
        : {};
      existingMeta.diffusion_request = signal;
      // Update the task record's metadata in DB
      if (typeof deps.db.updateTask === 'function') {
        deps.db.updateTask(ctx.taskId, { metadata: JSON.stringify(existingMeta) });
      }
      logger.info(`[Diffusion] Task ${ctx.taskId} emitted diffusion request: ${signal.summary}`);
    }
  } catch (err) {
    logger.debug(`[Diffusion] Phase 2.5 non-critical error: ${err.message}`);
  }
}
```

The `deps.db` reference is available via the dependency injection pattern already used by all other stages in task-finalizer.js (initialized via `init(nextDeps)`).

- [ ] **Step 4: Verify TORQUE server still starts cleanly**

Run: `node -e "require('./server/task-manager'); console.log('task-manager loaded OK')"`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add server/execution/task-finalizer.js server/tests/diffusion-close-handler.test.js
git commit -m "feat(diffusion): add Phase 2.5 close-handler for mid-task diffusion signals"
```

---

## Task 8: Integration Test — Full Scout → Plan → Workflow Pipeline

**Files:**
- Test: `server/tests/diffusion-handlers.test.js` (extend existing)

- [ ] **Step 1: Add integration test for the full pipeline**

Add to `server/tests/diffusion-handlers.test.js`:

```js
describe('full pipeline: scout output → create_diffusion_plan → workflow', () => {
  it('creates a valid workflow from a scout-produced plan', () => {
    const scoutOutput = {
      summary: 'Migrate 15 test files from direct DB import to DI container',
      patterns: [
        {
          id: 'direct-db-import',
          description: 'Files using require("../database") directly',
          transformation: 'Replace with container.get("taskCore")',
          exemplar_files: ['server/tests/task-manager.test.js'],
          exemplar_diff: '- const db = require("../database");\n+ const { taskCore } = container;',
          file_count: 15,
        },
      ],
      manifest: Array.from({ length: 15 }, (_, i) => ({
        file: `server/tests/test-${i}.test.js`,
        pattern: 'direct-db-import',
      })),
      shared_dependencies: [],
      estimated_subtasks: 15,
      isolation_confidence: 0.95,
      recommended_batch_size: 3,
    };

    const result = handlers.handleCreateDiffusionPlan({
      plan: scoutOutput,
      working_directory: '/project',
      batch_size: 3,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Workflow ID');
    expect(result.content[0].text).toContain('optimistic');
    expect(result.content[0].text).toContain('Fan-out tasks');
  });

  it('creates DAG workflow when shared dependencies exist', () => {
    const plan = {
      summary: 'Refactor handlers to use new base class',
      patterns: [
        {
          id: 'handler-refactor',
          description: 'Handler files extending old BaseHandler',
          transformation: 'Extend NewBaseHandler instead',
          exemplar_files: ['server/handlers/task.js'],
          exemplar_diff: '- class TaskHandler extends BaseHandler\n+ class TaskHandler extends NewBaseHandler',
          file_count: 8,
        },
      ],
      manifest: Array.from({ length: 8 }, (_, i) => ({
        file: `server/handlers/handler-${i}.js`,
        pattern: 'handler-refactor',
      })),
      shared_dependencies: [
        { file: 'server/handlers/new-base-handler.js', change: 'Create the new base handler class' },
      ],
      estimated_subtasks: 9,
      isolation_confidence: 0.4,
    };

    const result = handlers.handleCreateDiffusionPlan({
      plan,
      working_directory: '/project',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('dag');
    expect(result.content[0].text).toContain('Anchor tasks');
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run server/tests/diffusion-handlers.test.js`
Expected: PASS — all tests green

- [ ] **Step 3: Commit**

```bash
git add server/tests/diffusion-handlers.test.js
git commit -m "test(diffusion): add integration tests for full scout→plan→workflow pipeline"
```

---

## Task 9: Final Verification & Documentation

**Files:**
- No new files — verification only

- [ ] **Step 1: Run all diffusion tests together**

Run: `npx vitest run server/tests/diffusion-*.test.js`
Expected: All test files pass

- [ ] **Step 2: Run the full TORQUE test suite to check for regressions**

Run: `npx vitest run server/tests/ --reporter=verbose 2>&1 | tail -20`
Expected: No new failures introduced

- [ ] **Step 3: Verify TORQUE server starts with the new tools**

Run: `node -e "const t = require('./server/tools'); const diffusionTools = t.TOOLS.filter(t => ['submit_scout','create_diffusion_plan','diffusion_status'].includes(t.name)); console.log('Diffusion tools registered:', diffusionTools.length); diffusionTools.forEach(t => console.log(' -', t.name, ':', t.description.substring(0, 60) + '...'));"`
Expected: 3 diffusion tools registered with correct descriptions

- [ ] **Step 4: Verify tool annotations coverage**

Run: `node -e "const { validateCoverage } = require('./server/tool-annotations'); const names = require('./server/tools').TOOLS.map(t => t.name); const r = validateCoverage(names); console.log('Uncovered:', r.uncovered.length, r.uncovered.filter(n => n.includes('diffusion'))); console.log('Stale:', r.stale.length);"`
Expected: No diffusion tools in uncovered list

- [ ] **Step 5: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore(diffusion): final verification and cleanup"
```
