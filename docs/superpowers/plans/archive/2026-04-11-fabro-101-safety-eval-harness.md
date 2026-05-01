# Fabro #101: Safety-Eval Harness — Task / Solver / Scorer + Approvals (Inspect AI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure TORQUE's evaluation layer around **three independent primitives** — `Task` (dataset + metadata), `Solver` (execution strategy / agent scaffold), `Scorer` (grading policy) — plus **approval policies as a runtime primitive** that can approve, modify, reject, escalate, or terminate a sample. Inspired by Inspect AI.

**Architecture:** Extends Plan 70 (eval-framework) and Plan 79 (eval-sdk) with clean abstraction boundaries. A `TaskSpec` binds dataset + solver + scorer + sandbox (Plan 75) + approval policy. Running a task is `runSamples(task)` — the solver drives the sample end-to-end, the scorer produces `{ value, metadata }`, the approval policy can short-circuit *any* tool call inside the solver. Mixed scorers (deterministic + model-graded + expert-override) compose via `composeScorers([...])`.

**Tech Stack:** Node.js. Plans 70, 75, 79 are the foundations. No new deps.

---

## File Structure

**New files:**
- `server/evals/task-spec.js`
- `server/evals/solver.js`
- `server/evals/scorer.js`
- `server/evals/approval-policy.js`
- `server/evals/compose-scorers.js`
- `server/tests/task-spec.test.js`
- `server/tests/solver.test.js`
- `server/tests/scorer.test.js`
- `server/tests/approval-policy.test.js`

**Modified files:**
- `server/evals/run-sample.js` (Plan 70/79) — delegate to TaskSpec's solver+scorer
- `server/handlers/mcp-tools.js` — `create_eval_task`, `run_eval_task`, `set_approval_policy`

---

## Task 1: Task / Solver / Scorer primitives

- [ ] **Step 1: Tests**

Create `server/tests/task-spec.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createTaskSpec } = require('../evals/task-spec');

describe('TaskSpec', () => {
  it('requires dataset, solver, scorer', () => {
    expect(() => createTaskSpec({})).toThrow(/dataset/);
    expect(() => createTaskSpec({ dataset: [{}] })).toThrow(/solver/);
    expect(() => createTaskSpec({ dataset: [{}], solver: {} })).toThrow(/scorer/);
  });

  it('accepts optional sandbox + approval policy', () => {
    const spec = createTaskSpec({
      name: 't', dataset: [{ id: 1 }],
      solver: { run: async () => ({}) }, scorer: { score: async () => ({ value: 1 }) },
      sandbox: { kind: 'docker' }, approvalPolicy: { rules: [] },
    });
    expect(spec.sandbox.kind).toBe('docker');
    expect(spec.approvalPolicy.rules).toEqual([]);
  });

  it('exposes metadata fields', () => {
    const spec = createTaskSpec({ name: 'bench', dataset: [{}], solver: { run: async () => ({}) }, scorer: { score: async () => ({ value: 0 }) }, tags: ['safety'] });
    expect(spec.name).toBe('bench');
    expect(spec.tags).toEqual(['safety']);
  });
});
```

Create `server/tests/solver.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createSolver, chainSolvers } = require('../evals/solver');

describe('Solver', () => {
  it('run returns an output for a sample', async () => {
    const s = createSolver({ name: 'echo', run: async (sample) => ({ output: sample.input }) });
    expect(await s.run({ input: 'hi' })).toEqual({ output: 'hi' });
  });

  it('chainSolvers composes sequentially, passing output forward', async () => {
    const upper = createSolver({ name: 'upper', run: async (s) => ({ output: s.input.toUpperCase() }) });
    const bang = createSolver({ name: 'bang', run: async (s) => ({ output: s.input + '!' }) });
    const chained = chainSolvers([upper, bang]);
    const out = await chained.run({ input: 'hi' });
    expect(out.output).toBe('HI!');
  });
});
```

Create `server/tests/scorer.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createScorer } = require('../evals/scorer');
const { composeScorers } = require('../evals/compose-scorers');

describe('Scorer + compose', () => {
  it('match() returns 1 for equality', async () => {
    const s = createScorer({ kind: 'match', target: (sample) => sample.expected });
    const r = await s.score({ expected: 'yes' }, { output: 'yes' });
    expect(r.value).toBe(1);
  });

  it('choice() scores 0/1 against target option', async () => {
    const s = createScorer({ kind: 'choice', target: () => 'B' });
    expect((await s.score({}, { output: 'B' })).value).toBe(1);
    expect((await s.score({}, { output: 'C' })).value).toBe(0);
  });

  it('composeScorers averages numeric values', async () => {
    const a = createScorer({ kind: 'match', target: () => 'x' });
    const b = createScorer({ kind: 'choice', target: () => 'y' });
    const composed = composeScorers([a, b], { reduce: 'mean' });
    const r = await composed.score({}, { output: 'x' });
    expect(r.value).toBeCloseTo(0.5); // match=1, choice=0
    expect(r.components).toHaveLength(2);
  });

  it('composeScorers with reduce=min returns worst score', async () => {
    const a = createScorer({ kind: 'match', target: () => 'x' });
    const b = createScorer({ kind: 'match', target: () => 'y' });
    const composed = composeScorers([a, b], { reduce: 'min' });
    expect((await composed.score({}, { output: 'x' })).value).toBe(0);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/evals/task-spec.js`:

```js
'use strict';

function createTaskSpec({ name, dataset, solver, scorer, sandbox, approvalPolicy, tags = [], metadata = {} }) {
  if (!Array.isArray(dataset) || dataset.length === 0) throw new Error('TaskSpec: dataset required');
  if (!solver || typeof solver.run !== 'function') throw new Error('TaskSpec: solver with run() required');
  if (!scorer || typeof scorer.score !== 'function') throw new Error('TaskSpec: scorer with score() required');
  return { name: name || 'task', dataset, solver, scorer, sandbox, approvalPolicy, tags, metadata };
}

module.exports = { createTaskSpec };
```

Create `server/evals/solver.js`:

```js
'use strict';

function createSolver({ name, run }) {
  if (typeof run !== 'function') throw new Error('solver: run(sample) required');
  return { name: name || 'solver', run };
}

function chainSolvers(solvers) {
  return createSolver({
    name: solvers.map(s => s.name).join('>'),
    run: async (sample) => {
      let cur = { ...sample };
      for (const s of solvers) {
        const out = await s.run(cur);
        cur = { ...cur, ...out, input: out.output ?? cur.input };
      }
      return { output: cur.output };
    },
  });
}

module.exports = { createSolver, chainSolvers };
```

Create `server/evals/scorer.js`:

```js
'use strict';

function createScorer({ kind, target, grade }) {
  const score = async (sample, result) => {
    const tgt = typeof target === 'function' ? target(sample) : target;
    switch (kind) {
      case 'match': return { value: result.output === tgt ? 1 : 0, kind, target: tgt };
      case 'choice': return { value: result.output === tgt ? 1 : 0, kind, target: tgt };
      case 'model_graded':
        if (typeof grade !== 'function') throw new Error('model_graded scorer requires grade(sample,result)');
        return { ...(await grade(sample, result)), kind };
      default: throw new Error(`unknown scorer kind: ${kind}`);
    }
  };
  return { kind, score };
}

module.exports = { createScorer };
```

Create `server/evals/compose-scorers.js`:

```js
'use strict';

function composeScorers(scorers, { reduce = 'mean' } = {}) {
  return {
    kind: 'composite',
    async score(sample, result) {
      const components = [];
      for (const s of scorers) components.push(await s.score(sample, result));
      const nums = components.map(c => c.value).filter(n => typeof n === 'number');
      let value = 0;
      if (reduce === 'mean') value = nums.reduce((a, b) => a + b, 0) / (nums.length || 1);
      else if (reduce === 'min') value = Math.min(...nums);
      else if (reduce === 'max') value = Math.max(...nums);
      else throw new Error(`unknown reduce: ${reduce}`);
      return { value, components, reduce };
    },
  };
}

module.exports = { composeScorers };
```

Run tests → PASS. Commit: `feat(evals): Task/Solver/Scorer primitives + composeScorers`.

---

## Task 2: Approval policy runtime

- [ ] **Step 1: Tests**

Create `server/tests/approval-policy.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createApprovalPolicy } = require('../evals/approval-policy');

describe('ApprovalPolicy', () => {
  it('approves a tool that matches an allow rule', async () => {
    const p = createApprovalPolicy({ rules: [{ match: { tool: 'read_file' }, action: 'approve' }] });
    expect((await p.evaluate({ tool: 'read_file', args: {} })).action).toBe('approve');
  });

  it('rejects a tool that matches a reject rule', async () => {
    const p = createApprovalPolicy({ rules: [{ match: { tool: 'rm_rf' }, action: 'reject' }] });
    expect((await p.evaluate({ tool: 'rm_rf', args: {} })).action).toBe('reject');
  });

  it('modify rewrites args via rewriter fn', async () => {
    const p = createApprovalPolicy({
      rules: [{
        match: { tool: 'shell', args_prefix: { cmd: 'rm ' } },
        action: 'modify',
        rewrite: (ctx) => ({ ...ctx.args, cmd: ctx.args.cmd.replace(/^rm /, 'echo ') }),
      }],
    });
    const result = await p.evaluate({ tool: 'shell', args: { cmd: 'rm -rf /' } });
    expect(result.action).toBe('modify');
    expect(result.args.cmd).toBe('echo -rf /');
  });

  it('escalate returns pending status for human review', async () => {
    const p = createApprovalPolicy({ rules: [{ match: { tool: 'deploy' }, action: 'escalate' }] });
    expect((await p.evaluate({ tool: 'deploy', args: {} })).action).toBe('escalate');
  });

  it('terminate halts the sample', async () => {
    const p = createApprovalPolicy({ rules: [{ match: { tool: 'exfil' }, action: 'terminate' }] });
    expect((await p.evaluate({ tool: 'exfil', args: {} })).action).toBe('terminate');
  });

  it('first matching rule wins; default=approve', async () => {
    const p = createApprovalPolicy({
      rules: [
        { match: { tool: 'shell', args_prefix: { cmd: 'ls' } }, action: 'approve' },
        { match: { tool: 'shell' }, action: 'escalate' },
      ],
    });
    expect((await p.evaluate({ tool: 'shell', args: { cmd: 'ls -la' } })).action).toBe('approve');
    expect((await p.evaluate({ tool: 'shell', args: { cmd: 'cat /etc/passwd' } })).action).toBe('escalate');
    expect((await p.evaluate({ tool: 'other', args: {} })).action).toBe('approve'); // default
  });
});
```

- [ ] **Step 2: Implement**

Create `server/evals/approval-policy.js`:

```js
'use strict';

function matches(rule, ctx) {
  if (rule.match.tool && rule.match.tool !== ctx.tool) return false;
  if (rule.match.args_prefix) {
    for (const [k, v] of Object.entries(rule.match.args_prefix)) {
      const av = ctx.args?.[k];
      if (typeof av !== 'string' || !av.startsWith(v)) return false;
    }
  }
  return true;
}

function createApprovalPolicy({ rules = [] }) {
  return {
    async evaluate(ctx) {
      for (const rule of rules) {
        if (matches(rule, ctx)) {
          if (rule.action === 'modify') {
            return { action: 'modify', args: rule.rewrite ? rule.rewrite(ctx) : ctx.args };
          }
          return { action: rule.action };
        }
      }
      return { action: 'approve' };
    },
    rules,
  };
}

module.exports = { createApprovalPolicy };
```

Run tests → PASS. Commit: `feat(evals): approval policy runtime — approve/reject/modify/escalate/terminate`.

---

## Task 3: MCP surface + run integration

- [ ] **Step 1: Run-sample hook**

In `server/evals/run-sample.js` (Plan 70/79): before any tool call inside the solver, consult `task.approvalPolicy.evaluate({ tool, args })` and dispatch by action. On `reject`/`terminate` record the sample as blocked; on `modify` substitute returned `args`; on `escalate` queue a human review task and pause.

- [ ] **Step 2: MCP tools**

In `server/handlers/mcp-tools.js`:

```js
create_eval_task: {
  description: 'Register an evaluation task (dataset + solver + scorer + optional sandbox + approval policy).',
  inputSchema: {
    type: 'object',
    required: ['name', 'dataset', 'solver', 'scorer'],
    properties: {
      name: { type: 'string' },
      dataset: { type: 'array' },
      solver: { type: 'object', required: ['run_js'], properties: { run_js: { type: 'string' } } },
      scorer: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' }, target_js: { type: 'string' }, grade_js: { type: 'string' } } },
      sandbox: { type: 'object' },
      approval_policy: { type: 'object', properties: { rules: { type: 'array' } } },
      tags: { type: 'array', items: { type: 'string' } },
    },
  },
},
run_eval_task: {
  description: 'Run a registered eval task and return per-sample scores + aggregate.',
  inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, limit: { type: 'number' } } },
},
set_approval_policy: {
  description: 'Set/replace the approval policy for a registered eval task.',
  inputSchema: { type: 'object', required: ['name', 'rules'], properties: { name: { type: 'string' }, rules: { type: 'array' } } },
},
```

Smoke: create a small match-scorer task over 3 samples → run → confirm per-sample values + aggregate. Add an approval rule rejecting `shell` tool → run a solver that calls shell → confirm samples are blocked.

Commit: `feat(evals): MCP surface + approval-policy integration into run-sample loop`.
