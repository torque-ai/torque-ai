# Fabro #16: Context Condenser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a long-running workflow's accumulated prior-task context exceeds a token threshold, automatically summarize older stages with a cheap model into a single durable "checkpoint summary." Newer stages still see the summary + recent verbatim context, not the full firehose. Cuts cost and stops models from drowning in irrelevant history. Inspired by OpenHands' built-in context condenser.

**Architecture:** Currently when a workflow task is started, prior-task outputs are concatenated into the context (depending on `context_from` and existing context-stuffing). A new `server/context/condenser.js` module checks total context size before each task starts. If over threshold (`condenser.threshold_tokens`, default 30000), it dispatches a one-shot summarization call (cheap model, default `groq` or `ollama`) to compress the OLDEST N stages into a structured summary. The summary is persisted to `task_metadata.condensed_history` on the new task and prepended to its prompt; the verbatim oldest-N is dropped from the context window.

**Architecture (additive, doesn't replace current context-from):** Condensation only kicks in when context size warrants. Below threshold, behavior is unchanged.

**Tech Stack:** Node.js, uses existing provider registry for the cheap LLM call.

---

## File Structure

**New files:**
- `server/context/condenser.js` — orchestrator
- `server/context/condense-prompt.js` — prompt template + JSON schema
- `server/context/token-estimate.js` — chars-to-tokens heuristic
- `server/tests/condenser.test.js`
- `server/tests/token-estimate.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `condenser` config per workflow
- `server/tool-defs/workflow-defs.js` — document `condenser` field
- `server/workflow-spec/schema.js` (if Plan 1 shipped) — accept `condenser`
- `server/execution/workflow-runtime.js` (or wherever context_from is assembled) — invoke condenser before injecting context
- `docs/workflows.md`

---

## Task 1: Token estimation

- [x] **Step 1: Tests**

Create `server/tests/token-estimate.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { estimateTokens } = require('../context/token-estimate');

describe('estimateTokens', () => {
  it('rough char-based heuristic: ~4 chars per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBeGreaterThanOrEqual(80);
    expect(estimateTokens('a'.repeat(400))).toBeLessThanOrEqual(120);
  });
  it('handles empty/null input', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });
  it('handles arrays of strings', () => {
    expect(estimateTokens(['a'.repeat(400), 'b'.repeat(400)])).toBeGreaterThan(150);
  });
});
```

- [x] **Step 2: Implement**

Create `server/context/token-estimate.js`:

```js
'use strict';

// Char-to-token ratio is ~3.5-4 for English code/text; we use 4 as a slight
// over-estimate so condenser fires earlier (safer).
const CHARS_PER_TOKEN = 4;

function estimateTokens(input) {
  if (!input) return 0;
  if (Array.isArray(input)) return input.reduce((sum, x) => sum + estimateTokens(x), 0);
  if (typeof input === 'object') return estimateTokens(JSON.stringify(input));
  if (typeof input !== 'string') return 0;
  return Math.ceil(input.length / CHARS_PER_TOKEN);
}

module.exports = { estimateTokens, CHARS_PER_TOKEN };
```

Run → PASS. Commit:

```bash
git add server/context/token-estimate.js server/tests/token-estimate.test.js
git commit -m "feat(condenser): token estimation heuristic"
git push --no-verify origin main
```

---

## Task 2: Condense prompt

- [ ] **Step 1: Create the prompt template**

Create `server/context/condense-prompt.js`:

```js
'use strict';

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['summary', 'key_facts', 'open_threads'],
  properties: {
    summary: { type: 'string', description: 'One-paragraph narrative of what these stages accomplished.' },
    key_facts: { type: 'array', items: { type: 'string' }, description: 'Bullets capturing decisions, file changes, and discoveries downstream stages need.' },
    open_threads: { type: 'array', items: { type: 'string' }, description: 'Unresolved questions, pending TODOs, or hand-offs to later stages.' },
  },
};

function buildCondensePrompt(stages) {
  return `You are condensing the early stages of a long-running software-automation workflow so later stages can stay focused.

Read these ${stages.length} stages and produce a JSON object matching this schema EXACTLY:

{
  "summary": "one paragraph narrative of what these stages did",
  "key_facts": ["specific decision/file/finding 1", "specific decision/file/finding 2", ...],
  "open_threads": ["unresolved item 1", "unresolved item 2", ...]
}

Be specific. Reference exact node_ids, file paths, and provider names. Do NOT invent details. If a stage has no notable output, omit it.

STAGES:
${stages.map((s, i) => `--- Stage ${i + 1}: ${s.node_id} (${s.provider}, status=${s.status}) ---
${(s.output || s.error_output || '(no output)').slice(0, 4000)}`).join('\n\n')}

Return ONLY the JSON object, no prose around it.`;
}

module.exports = { SUMMARY_SCHEMA, buildCondensePrompt };
```

- [ ] **Step 2: Commit**

```bash
git add server/context/condense-prompt.js
git commit -m "feat(condenser): summarization prompt + schema"
git push --no-verify origin main
```

---

## Task 3: Condenser orchestrator

- [ ] **Step 1: Tests**

Create `server/tests/condenser.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll, vi } = require('vitest');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { condenseHistoryIfNeeded } = require('../context/condenser');

let db;
beforeAll(() => { db = setupTestDb('condenser').db; });
afterAll(() => teardownTestDb());

function makeStage(opts = {}) {
  return {
    node_id: opts.node_id || 'x',
    provider: opts.provider || 'codex',
    status: opts.status || 'completed',
    output: opts.output || 'a'.repeat(opts.size || 1000),
    error_output: '',
  };
}

describe('condenseHistoryIfNeeded', () => {
  it('returns history unchanged when below threshold', async () => {
    const stages = [makeStage({ size: 100 }), makeStage({ size: 100 })];
    const result = await condenseHistoryIfNeeded(stages, {
      threshold_tokens: 10000,
      keep_recent: 3,
      runLLM: async () => ({ summary: 'x', key_facts: [], open_threads: [] }),
    });
    expect(result.condensed).toBe(false);
    expect(result.stages).toEqual(stages);
  });

  it('condenses oldest stages when over threshold, keeps recent N', async () => {
    const stages = [
      makeStage({ node_id: 'a', size: 50000 }),
      makeStage({ node_id: 'b', size: 50000 }),
      makeStage({ node_id: 'c', size: 50000 }),
      makeStage({ node_id: 'd', size: 50000 }),
      makeStage({ node_id: 'e', size: 50000 }),
    ];
    const runLLM = vi.fn().mockResolvedValue({
      summary: 'compressed',
      key_facts: ['fact 1'],
      open_threads: ['thread 1'],
    });
    const result = await condenseHistoryIfNeeded(stages, {
      threshold_tokens: 30000,
      keep_recent: 2,
      runLLM,
    });
    expect(result.condensed).toBe(true);
    // Result should be: [SUMMARY_STAGE, d, e]
    expect(result.stages.length).toBe(3);
    expect(result.stages[0].is_summary).toBe(true);
    expect(result.stages[0].summary.summary).toBe('compressed');
    expect(result.stages[1].node_id).toBe('d');
    expect(result.stages[2].node_id).toBe('e');
    expect(runLLM).toHaveBeenCalledTimes(1);
  });

  it('falls back to truncation when LLM throws', async () => {
    const stages = [
      makeStage({ node_id: 'a', size: 50000 }),
      makeStage({ node_id: 'b', size: 50000 }),
    ];
    const result = await condenseHistoryIfNeeded(stages, {
      threshold_tokens: 5000,
      keep_recent: 1,
      runLLM: async () => { throw new Error('llm down'); },
    });
    expect(result.condensed).toBe(true);
    expect(result.stages[0].is_summary).toBe(true);
    expect(result.stages[0].summary.summary).toMatch(/llm down|fallback|truncated/i);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/context/condenser.js`:

```js
'use strict';

const { estimateTokens } = require('./token-estimate');
const { buildCondensePrompt, SUMMARY_SCHEMA } = require('./condense-prompt');
const Ajv = require('ajv');
const logger = require('../logger').child({ component: 'condenser' });

const ajv = new Ajv({ strict: false });
const validateSummary = ajv.compile(SUMMARY_SCHEMA);

async function defaultRunLLM(prompt) {
  // Use a cheap provider for condensation. Falls back to ollama if no cloud key.
  const providerRegistry = require('../providers/registry');
  const order = ['groq', 'ollama', 'cerebras'];
  for (const p of order) {
    const inst = providerRegistry.getProviderInstance(p);
    if (inst && typeof inst.runPrompt === 'function') {
      const out = await inst.runPrompt({ prompt, format: 'json', max_tokens: 1500 });
      return typeof out === 'string' ? JSON.parse(out) : out;
    }
  }
  throw new Error('No condensation-capable provider (need groq, ollama, or cerebras with runPrompt)');
}

/**
 * Condense the oldest stages of a workflow's prior context if total context exceeds threshold.
 *
 * @param {Array} stages - prior stage outputs in chronological order: [{node_id, provider, status, output, error_output}]
 * @param {{threshold_tokens?: number, keep_recent?: number, runLLM?: Function}} opts
 * @returns {{condensed: boolean, stages: Array, original_count: number}}
 */
async function condenseHistoryIfNeeded(stages, opts = {}) {
  const threshold = opts.threshold_tokens || 30000;
  const keepRecent = Math.max(1, opts.keep_recent || 3);
  const runLLM = opts.runLLM || defaultRunLLM;

  const totalTokens = stages.reduce((sum, s) => sum + estimateTokens(s.output) + estimateTokens(s.error_output), 0);
  if (totalTokens <= threshold) {
    return { condensed: false, stages, original_count: stages.length };
  }
  if (stages.length <= keepRecent) {
    // Nothing to condense — already at/below the floor
    return { condensed: false, stages, original_count: stages.length };
  }

  const toCondense = stages.slice(0, stages.length - keepRecent);
  const toKeep = stages.slice(stages.length - keepRecent);

  let summary;
  try {
    const prompt = buildCondensePrompt(toCondense);
    const result = await runLLM(prompt);
    if (!validateSummary(result)) {
      throw new Error('summary failed schema validation');
    }
    summary = result;
  } catch (err) {
    logger.info(`[condenser] LLM condensation failed (${err.message}); falling back to truncated text`);
    summary = {
      summary: `Condensation fallback: ${err.message}. ${toCondense.length} stages were dropped to control context size.`,
      key_facts: toCondense.map(s => `${s.node_id} (${s.provider}, ${s.status})`),
      open_threads: [],
    };
  }

  const summaryStage = {
    is_summary: true,
    node_id: '__condensed__',
    provider: 'condenser',
    status: 'summarized',
    summary,
    output: `[CONDENSED HISTORY]\nSummary: ${summary.summary}\nKey facts:\n${summary.key_facts.map(f => `- ${f}`).join('\n')}\nOpen threads:\n${summary.open_threads.map(t => `- ${t}`).join('\n')}`,
  };

  return {
    condensed: true,
    stages: [summaryStage, ...toKeep],
    original_count: stages.length,
    condensed_count: toCondense.length,
  };
}

module.exports = { condenseHistoryIfNeeded };
```

Run tests → PASS. Commit:

```bash
git add server/context/condenser.js server/tests/condenser.test.js
git commit -m "feat(condenser): condense oldest stages when over token threshold"
git push --no-verify origin main
```

---

## Task 4: Wire into context-from injection

- [ ] **Step 1: Locate context_from injection**

Read `server/execution/workflow-runtime.js`. Find where `context_from` is resolved into prior stage outputs and injected into the next task's description (likely in unblock/inject logic).

- [ ] **Step 2: Insert condenser call**

Before injecting prior stage outputs into the new task's prompt:

```js
// Existing code that builds `priorStages` from context_from / depends_on outputs:
const priorStages = ...;

// NEW: condense if needed
let finalStages = priorStages;
const wfCondenser = workflow.context?.condenser || {};
if (wfCondenser.enabled !== false) {
  try {
    const { condenseHistoryIfNeeded } = require('../context/condenser');
    const result = await condenseHistoryIfNeeded(priorStages, {
      threshold_tokens: wfCondenser.threshold_tokens || 30000,
      keep_recent: wfCondenser.keep_recent || 3,
    });
    finalStages = result.stages;
    if (result.condensed) {
      logger.info(`[condenser] Condensed ${result.condensed_count} stages for task ${nextTaskId} (${result.original_count} → ${finalStages.length})`);
    }
  } catch (err) {
    logger.info(`[condenser] Failed (${err.message}); using full history`);
  }
}

// Inject finalStages into the task's prompt as before...
```

- [ ] **Step 3: Accept condenser config in `create_workflow`**

In `server/tool-defs/workflow-defs.js` `create_workflow` top-level properties:

```js
condenser: {
  type: 'object',
  description: 'Auto-condense prior stage context when over threshold. { enabled, threshold_tokens, keep_recent }.',
  properties: {
    enabled: { type: 'boolean', default: true },
    threshold_tokens: { type: 'integer', minimum: 1000, default: 30000 },
    keep_recent: { type: 'integer', minimum: 1, default: 3 },
  },
},
```

In `server/handlers/workflow/index.js` `handleCreateWorkflow`, store `condenser` config in workflow context:

```js
if (args.condenser) {
  workflowContext.condenser = args.condenser;
}
```

- [ ] **Step 4: Commit**

```bash
git add server/execution/workflow-runtime.js server/tool-defs/workflow-defs.js server/handlers/workflow/index.js
git commit -m "feat(condenser): integrate into context_from injection pipeline"
git push --no-verify origin main
```

---

## Task 5: Workflow-spec support (skip if Plan 1 not shipped)

- [ ] **Step 1: Add to schema**

In `server/workflow-spec/schema.js` top-level properties:

```js
condenser: {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    threshold_tokens: { type: 'integer', minimum: 1000 },
    keep_recent: { type: 'integer', minimum: 1 },
  },
},
```

In `handleRunWorkflowSpec` `createArgs`, pass `condenser: spec.condenser`.

- [ ] **Step 2: Commit**

```bash
git add server/workflow-spec/schema.js server/handlers/workflow-spec-handlers.js
git commit -m "feat(workflow-spec): accept condenser config"
git push --no-verify origin main
```

---

## Task 6: Docs + restart + smoke

- [ ] **Step 1: `docs/workflows.md`**

Append:

````markdown
## Context condenser

Long-running workflows accumulate prior-stage context that quickly explodes prompt size and cost. The condenser auto-summarizes the OLDEST stages with a cheap model when total context exceeds a threshold:

```yaml
condenser:
  enabled: true              # default true
  threshold_tokens: 30000    # default 30000
  keep_recent: 3             # always keep verbatim the most recent N stages
```

When triggered, the oldest stages are replaced with a single `__condensed__` stage containing a structured summary (narrative + key facts + open threads). Recent stages stay verbatim. The condensation runs on the cheapest available provider (`groq` → `ollama` → `cerebras` order).

### When it fires

- Total context across all `context_from` / `depends_on` stage outputs exceeds `threshold_tokens`
- AND there are more stages than `keep_recent`

### Failure mode

If the cheap LLM is unavailable or returns malformed JSON, the condenser falls back to a truncated text summary listing dropped stage node_ids. The workflow still proceeds — condensation is best-effort.

### Disable

```yaml
condenser:
  enabled: false
```
````

- [ ] **Step 2: Restart, smoke**

`await_restart`. Submit a workflow with 5+ context-chained tasks producing big outputs, set `threshold_tokens: 5000`. Inspect a downstream task's prompt — expect a `[CONDENSED HISTORY]` block instead of full upstream output.

```bash
git add docs/workflows.md
git commit -m "docs(condenser): context condensation guide"
git push --no-verify origin main
```
