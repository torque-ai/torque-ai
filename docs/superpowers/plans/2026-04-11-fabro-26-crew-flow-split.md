# Fabro #26: Crew/Flow Split — Autonomous Subteams Inside Deterministic Workflows

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a workflow declare a node as `kind: crew` — a bounded autonomous subteam where 1–N agent loops collaborate freely on an open-ended objective, returning a structured result. The surrounding workflow stays deterministic. Inspired by CrewAI's Crew/Flow split.

**Architecture:** A new task `kind: "crew"` with `crew: { roles: [...], objective, max_rounds, output_schema }`. When the task starts, instead of dispatching to a single provider, TORQUE spawns a `crew-runtime.js` orchestrator that runs N agent roles in turn (or in parallel based on `mode: round_robin | hierarchical | parallel`). The crew runs until: (a) any role declares the objective met (output matches `output_schema`), (b) max_rounds hit, or (c) bounded budget exhausted. Returns a single structured result. Cost is tracked per-role.

**Tech Stack:** Node.js, existing provider registry. Builds on plans 5 (parallel fan-out), 18 (architect/editor), 23 (typed signatures).

---

## File Structure

**New files:**
- `server/crew/crew-runtime.js` — orchestrator
- `server/crew/role-loop.js` — single role's iteration loop
- `server/crew/crew-prompt.js` — system prompt builder per role
- `server/tests/crew-runtime.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `kind: "crew"` + crew config
- `server/tool-defs/workflow-defs.js`
- `server/workflow-spec/schema.js`
- `server/execution/task-startup.js` — branch on `kind: crew`
- `docs/crew-flow.md`

---

## Task 1: Crew schema + validation

- [ ] **Step 1: Tool def fields**

In `server/tool-defs/workflow-defs.js` `tasks.items.properties`:

```js
crew: {
  type: 'object',
  description: 'Bounded autonomous subteam configuration. Active when kind=crew.',
  properties: {
    objective: { type: 'string', description: 'Open-ended goal the crew works toward.' },
    roles: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string', description: 'What this role does + how it interacts with others.' },
          provider: { type: 'string' },
          model: { type: 'string' },
        },
      },
    },
    mode: { type: 'string', enum: ['round_robin', 'hierarchical', 'parallel'], default: 'round_robin' },
    max_rounds: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
    output_schema: { type: 'object', description: 'JSON Schema for the crew result. When any role produces matching output, the crew exits.' },
  },
},
```

(`kind` field already added in Plan 5 — extend its enum to include `'crew'`.)

- [ ] **Step 2: Store in metadata**

In `buildWorkflowTaskMetadata`:

```js
if (taskLike.kind === 'crew') {
  metaObj.kind = 'crew';
  metaObj.crew = taskLike.crew || {};
}
```

Validate in `normalizeInitialWorkflowTasks`:

```js
if (task.kind === 'crew') {
  if (!task.crew?.objective) {
    return makeError(ErrorCodes.INVALID_PARAM, `Crew node '${task.node_id}' must have crew.objective`);
  }
  if (!Array.isArray(task.crew?.roles) || task.crew.roles.length === 0) {
    return makeError(ErrorCodes.INVALID_PARAM, `Crew node '${task.node_id}' must have crew.roles with at least one role`);
  }
}
```

Commit: `feat(crew): accept kind=crew with roles/objective/mode config`.

---

## Task 2: Single role iteration loop

- [ ] **Step 1: Tests**

Create `server/tests/crew-runtime.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { runCrew } = require('../crew/crew-runtime');

describe('runCrew', () => {
  it('round_robin: each role takes a turn until objective met or rounds exhausted', async () => {
    const calls = [];
    const callRole = vi.fn(async ({ role, history }) => {
      calls.push({ role: role.name, round: history.length });
      // First role declares done on round 2
      if (role.name === 'planner' && calls.filter(c => c.role === 'planner').length === 2) {
        return { output: { plan: 'final', done: true } };
      }
      return { output: { partial: `${role.name} round` } };
    });
    const result = await runCrew({
      objective: 'Plan a feature',
      roles: [{ name: 'planner', description: 'Plans' }, { name: 'critic', description: 'Critiques' }],
      mode: 'round_robin',
      max_rounds: 5,
      output_schema: { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } } },
      callRole,
    });
    expect(result.terminated_by).toBe('output_matched_schema');
    expect(result.final_output.done).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('terminates at max_rounds even if no role declares done', async () => {
    const callRole = vi.fn(async () => ({ output: { partial: 'still working' } }));
    const result = await runCrew({
      objective: 'never finish',
      roles: [{ name: 'r1', description: '' }],
      mode: 'round_robin',
      max_rounds: 3,
      output_schema: { type: 'object', required: ['done'] },
      callRole,
    });
    expect(result.terminated_by).toBe('max_rounds');
    expect(callRole).toHaveBeenCalledTimes(3);
  });

  it('parallel mode runs all roles concurrently in each round', async () => {
    const startTimes = [];
    const callRole = vi.fn(async ({ role }) => {
      startTimes.push({ role: role.name, t: Date.now() });
      await new Promise(r => setTimeout(r, 50));
      return { output: { from: role.name } };
    });
    await runCrew({
      objective: 'race',
      roles: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      mode: 'parallel',
      max_rounds: 1,
      callRole,
    });
    // All three start within a few ms of each other
    const spread = Math.max(...startTimes.map(s => s.t)) - Math.min(...startTimes.map(s => s.t));
    expect(spread).toBeLessThan(40);
  });

  it('returns aggregated history for downstream observability', async () => {
    const callRole = vi.fn(async ({ role }) => ({ output: { from: role.name } }));
    const result = await runCrew({
      objective: 'log',
      roles: [{ name: 'r1' }],
      mode: 'round_robin',
      max_rounds: 2,
      callRole,
    });
    expect(result.history).toHaveLength(2);
    expect(result.history[0].role).toBe('r1');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/crew/crew-runtime.js`:

```js
'use strict';

const Ajv = require('ajv');
const logger = require('../logger').child({ component: 'crew' });
const ajv = new Ajv({ strict: false });

async function runRoundRobin({ roles, callRole, history, output_schema, validate }) {
  for (const role of roles) {
    const result = await callRole({ role, history, objective: arguments[0].objective });
    history.push({ role: role.name, round: history.length, output: result.output });
    if (validate && validate(result.output)) {
      return { matched: true, final_output: result.output };
    }
  }
  return { matched: false };
}

async function runParallel({ roles, callRole, history, validate }) {
  const results = await Promise.all(roles.map(role =>
    callRole({ role, history }).then(r => ({ role, output: r.output }))
  ));
  for (const { role, output } of results) {
    history.push({ role: role.name, round: history.length, output });
  }
  for (const r of results) {
    if (validate && validate(r.output)) {
      return { matched: true, final_output: r.output };
    }
  }
  return { matched: false };
}

async function runHierarchical({ roles, callRole, history, validate, objective }) {
  // First role acts as manager — sees the full history and chooses the next sub-role
  const manager = roles[0];
  const workers = roles.slice(1);
  const managerOutput = await callRole({ role: manager, history, objective, workers });
  history.push({ role: manager.name, round: history.length, output: managerOutput.output });
  if (validate && validate(managerOutput.output)) {
    return { matched: true, final_output: managerOutput.output };
  }
  const nextRoleName = managerOutput.output?.delegate_to;
  const target = workers.find(r => r.name === nextRoleName);
  if (!target) return { matched: false }; // no delegation — round ends
  const workerOutput = await callRole({ role: target, history, objective });
  history.push({ role: target.name, round: history.length, output: workerOutput.output });
  if (validate && validate(workerOutput.output)) {
    return { matched: true, final_output: workerOutput.output };
  }
  return { matched: false };
}

async function runCrew({ objective, roles, mode = 'round_robin', max_rounds = 5, output_schema, callRole }) {
  const validate = output_schema ? ajv.compile(output_schema) : null;
  const history = [];
  const runner = mode === 'parallel' ? runParallel
    : mode === 'hierarchical' ? runHierarchical
    : runRoundRobin;

  for (let round = 0; round < max_rounds; round++) {
    const r = await runner({ objective, roles, callRole, history, output_schema, validate });
    if (r.matched) {
      return {
        terminated_by: 'output_matched_schema',
        rounds: round + 1,
        history,
        final_output: r.final_output,
      };
    }
  }
  return {
    terminated_by: 'max_rounds',
    rounds: max_rounds,
    history,
    final_output: history[history.length - 1]?.output || null,
  };
}

module.exports = { runCrew };
```

Run tests → PASS. Commit:

```
feat(crew): runCrew orchestrator with round_robin/parallel/hierarchical modes
```

---

## Task 3: Wire into task-startup

- [ ] **Step 1: Branch on kind=crew**

In `server/execution/task-startup.js` after task is loaded:

```js
let taskMeta;
try { taskMeta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}); } catch { taskMeta = {}; }
if (taskMeta.kind === 'crew') {
  return runCrewTask(task, taskMeta, taskId);
}
```

- [ ] **Step 2: Implement runCrewTask**

```js
async function runCrewTask(task, taskMeta, taskId) {
  const { runCrew } = require('../crew/crew-runtime');
  const providerRegistry = require('../providers/registry');
  const crew = taskMeta.crew || {};

  // Define how to call a single role — uses each role's provider via runPrompt
  const callRole = async ({ role, history, objective }) => {
    const provider = role.provider || 'codex';
    const inst = providerRegistry.getProviderInstance(provider);
    if (!inst || typeof inst.runPrompt !== 'function') {
      throw new Error(`Crew role ${role.name}: provider ${provider} not available`);
    }
    const prompt = `You are ${role.name}. ${role.description || ''}\n\nObjective: ${objective}\n\nHistory so far (${history.length} turns):\n${history.map(h => `- ${h.role}: ${JSON.stringify(h.output)}`).join('\n')}\n\nRespond with a JSON object representing your contribution. If you believe the objective is achieved, include "done": true and any required output fields.`;
    const out = await inst.runPrompt({ prompt, format: 'json', max_tokens: 1500 });
    return { output: typeof out === 'string' ? JSON.parse(out) : out };
  };

  const result = await runCrew({
    objective: crew.objective,
    roles: crew.roles,
    mode: crew.mode || 'round_robin',
    max_rounds: crew.max_rounds || 5,
    output_schema: crew.output_schema,
    callRole,
  });

  // Persist result as task output
  db.updateTaskStatus(taskId, 'completed', {
    output: JSON.stringify(result.final_output, null, 2),
    metadata: JSON.stringify({ ...taskMeta, crew_result: { terminated_by: result.terminated_by, rounds: result.rounds, history_count: result.history.length } }),
  });

  return { queued: false, alreadyRunning: false, crew: true };
}
```

Commit: `feat(crew): branch task-startup on kind=crew`.

---

## Task 4: Workflow-spec + docs + smoke

- [ ] **Step 1: Schema (Plan 1 dependent)**

Add to `server/workflow-spec/schema.js` `tasks.items.properties`:

```js
crew: {
  type: 'object',
  properties: {
    objective: { type: 'string' },
    roles: { type: 'array' },
    mode: { type: 'string', enum: ['round_robin', 'hierarchical', 'parallel'] },
    max_rounds: { type: 'integer' },
    output_schema: { type: 'object' },
  },
},
```

And extend the `kind` enum:

```js
kind: { type: 'string', enum: ['agent', 'parallel_fanout', 'merge', 'crew'] },
```

- [ ] **Step 2: Docs**

Create `docs/crew-flow.md`:

````markdown
# Crew/Flow Split

A workflow node can be a `crew` — a bounded autonomous subteam working toward an open-ended objective. The surrounding workflow stays deterministic; only the crew node is autonomous.

## When to use

- Open-ended research where the answer shape is known but the path isn't
- Multi-perspective review (e.g., security + arch + UX critics on the same change)
- Brainstorming or ideation tasks that benefit from cross-pollination

## When NOT to use

- Anything reproducible — use a regular task
- Tasks where you know exactly what should happen — use the architect/editor split (Plan 18) instead

## Example

```yaml
- node_id: research
  task: Research best library for JSON schema validation
  kind: crew
  crew:
    objective: Pick a library, justify the choice, list 2 alternatives with trade-offs.
    mode: round_robin
    max_rounds: 4
    roles:
      - name: surveyor
        description: Lists candidate libraries and their key properties
        provider: claude-cli
      - name: critic
        description: Identifies weaknesses in the surveyor's picks
        provider: anthropic
      - name: arbiter
        description: Synthesizes a final recommendation. Set "done": true when confident.
        provider: claude-cli
    output_schema:
      type: object
      required: [pick, alternatives, done]
      properties:
        pick: { type: string }
        alternatives: { type: array }
        done: { type: boolean }
```

## Modes

- `round_robin` — each role takes a turn in declared order, repeating up to `max_rounds`
- `parallel` — all roles run concurrently each round, results merged into shared history
- `hierarchical` — first role is manager, decides which worker role to delegate to next via `output.delegate_to`

## Termination

- `output_matched_schema` — any role's output matches `output_schema` (and `done: true` if the schema requires it)
- `max_rounds` — round limit hit; final output is the last role's output
````

`await_restart`. Smoke: submit a workflow with a `kind: crew` node that has 2 roles, `max_rounds: 2`. Confirm task completes with crew_result in metadata.

Commit: `docs(crew): autonomous subteam guide`.
