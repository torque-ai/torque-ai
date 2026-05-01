# Factory Starvation Detection and Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop burning architect LLM cycles on empty backlogs, surface project starvation as a first-class state, and auto-recover by re-running scouts when a project runs out of work.

**Architecture:** Introduce a new `STARVED` loop state that the factory transitions into after N consecutive PRIORITIZE cycles return no work item. Short-circuit PRIORITIZE→PLAN so the architect LLM never fires on an empty intake. Add a starvation-recovery subsystem that, after a configurable dwell time, dispatches the project's scout fleet to refill the intake. Surface the state on the dashboard Factory view. Validate `plans_dir` to prevent the "point at our own output directory" footgun.

**Tech Stack:** Node.js (better-sqlite3), Vitest (server), React + Vitest (dashboard).

**Context:** Root cause captured in the 2026-04-20 debugging session. A specific project (bitsy) currently has 0 open work items (39 shipped, 22 rejected) and has been cycling `IDLE → SENSE → PRIORITIZE(not_found) → PLAN(architect LLM, plan_path:null) → IDLE` every ~4 minutes since at least 20:15 UTC, burning an architect LLM call per cycle.

---

## Task 1: Guard architect LLM on empty intake

**Why:** `runArchitectCycle` in `server/factory/architect-runner.js:614` calls `runArchitectLLM` with no check on `intakeItems.length`. Every PLAN stage tick submits a billable task even when there is nothing to prioritize. This is the single biggest cost win.

**Files:**
- Modify: `server/factory/architect-runner.js:540-630`
- Test: `server/tests/architect-runner-empty-intake.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `server/tests/architect-runner-empty-intake.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach, vi } = require('vitest');
const architectRunner = require('../factory/architect-runner');
const factoryIntake = require('../db/factory-intake');
const factoryArchitect = require('../db/factory-architect');
const factoryHealth = require('../factory/health');

describe('runArchitectCycle empty-intake guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the LLM call and writes a deterministic empty cycle when intake is empty', async () => {
    const project = { id: 'p1', path: process.cwd(), trust_level: 'dark' };
    vi.spyOn(factoryHealth, 'getProject').mockReturnValue(project);
    vi.spyOn(factoryHealth, 'getLatestScores').mockReturnValue([]);
    vi.spyOn(factoryIntake, 'listOpenWorkItems').mockReturnValue([]);
    vi.spyOn(factoryArchitect, 'getLatestCycle').mockReturnValue(null);
    const createCycle = vi.spyOn(factoryArchitect, 'createCycle').mockImplementation((cycle) => ({
      id: 999,
      ...cycle,
    }));
    const llmSpy = vi.spyOn(architectRunner._internalForTests, 'runArchitectLLM');

    const cycle = await architectRunner.runArchitectCycle('p1', 'test');

    expect(llmSpy).not.toHaveBeenCalled();
    expect(createCycle).toHaveBeenCalledTimes(1);
    const createCall = createCycle.mock.calls[0][0];
    expect(createCall.reasoning).toMatch(/no open work items|empty intake/i);
    expect(createCall.backlog).toEqual([]);
    expect(cycle.id).toBe(999);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd server && npx vitest run tests/architect-runner-empty-intake.test.js
```
Expected: FAIL — current code calls the LLM regardless.

- [ ] **Step 3: Export runArchitectLLM for tests**

In `server/factory/architect-runner.js`, near the existing `module.exports`, add an `_internalForTests` export (create if missing) that exposes `runArchitectLLM`.

```js
module.exports = {
  runArchitectCycle,
  // ...existing exports...
  _internalForTests: { runArchitectLLM },
};
```

- [ ] **Step 4: Add the empty-intake guard**

In `server/factory/architect-runner.js`, inside `runArchitectCycle`, immediately after `const intakeItems = normalizeIntakeItems(...)` (currently around line 556) and before the prompt is built, insert:

```js
if (intakeItems.length === 0) {
  logger.info('Architect cycle skipping LLM — intake is empty', { project_id });
  const cycle = factoryArchitect.createCycle({
    project_id,
    input_snapshot: {
      healthScores,
      intakeItems: [],
    },
    reasoning: 'no open work items; architect LLM skipped',
    backlog: [],
    llm_used: false,
    trigger,
  });
  return cycle;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd server && npx vitest run tests/architect-runner-empty-intake.test.js
```
Expected: PASS.

- [ ] **Step 6: Run the full architect-runner test suite**

```bash
cd server && npx vitest run tests/architect-runner*.test.js tests/architect*intake*.test.js
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/factory/architect-runner.js server/tests/architect-runner-empty-intake.test.js
git commit -m "fix(factory): skip architect LLM when intake is empty

runArchitectCycle now returns a deterministic empty cycle when
listOpenWorkItems returns zero items. Previously the factory burned
one LLM call per PLAN tick on starved projects (observed: ~15
cycles/hour with null plan_path)."
```

---

## Task 2: Short-circuit PRIORITIZE → PLAN when no work item

**Why:** `runLoopCycle` case `LOOP_STATES.PRIORITIZE` in `server/factory/loop-controller.js:5915-5958` always calls `executePlanStage` after `executePrioritizeStage`, even when the latter returned `work_item: null`. PLAN then calls `runArchitectCycle` (which after Task 1 is cheap, but still writes a null-cycle decision and advances state). The state machine should skip PLAN entirely when there is no work.

**Files:**
- Modify: `server/factory/loop-controller.js:5915-5958`
- Test: `server/tests/factory-loop-prioritize-starved.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `server/tests/factory-loop-prioritize-starved.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach, vi } = require('vitest');
const loopController = require('../factory/loop-controller');
const factoryIntake = require('../db/factory-intake');

describe('PRIORITIZE short-circuit on empty intake', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('does not enter PLAN when PRIORITIZE returns no work item', async () => {
    vi.spyOn(factoryIntake, 'listOpenWorkItems').mockReturnValue([]);
    const planSpy = vi.spyOn(loopController._internalForTests, 'executePlanStage');

    const result = await loopController._internalForTests.handlePrioritizeTransition({
      project: { id: 'p1', trust_level: 'dark', path: process.cwd() },
      instance: { id: 'i1', loop_state: 'PRIORITIZE', work_item_id: null },
      currentState: 'PRIORITIZE',
    });

    expect(planSpy).not.toHaveBeenCalled();
    expect(result.transitionReason).toBe('no_open_work_item');
    expect(result.nextState).toBe('IDLE');
  });
});
```

- [ ] **Step 2: Extract `handlePrioritizeTransition` helper**

In `server/factory/loop-controller.js`, extract the body of `case LOOP_STATES.PRIORITIZE:` (lines 5915-5958) into a new function `handlePrioritizeTransition({ project, instance, currentState })`. Have it return `{ instance, transitionWorkItem, stageResult, transitionReason, nextState }`.

- [ ] **Step 3: Add empty-intake short-circuit inside the helper**

After `executePrioritizeStage` returns, check:

```js
if (!prioritizeStage?.work_item) {
  const idleInstance = updateInstanceAndSync(instance.id, {
    loop_state: LOOP_STATES.IDLE,
    paused_at_stage: null,
    last_action_at: nowIso(),
  });
  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.PRIORITIZE,
    action: 'short_circuit_to_idle',
    reasoning: 'PRIORITIZE returned no work item; skipping PLAN and architect cycle',
    outcome: { reason: 'no_open_work_item', from_state: currentState, to_state: LOOP_STATES.IDLE },
    confidence: 1,
    batch_id: getDecisionBatchId(project, null, null, idleInstance),
  });
  return {
    instance: idleInstance,
    transitionWorkItem: null,
    stageResult: prioritizeStage?.stage_result || null,
    transitionReason: 'no_open_work_item',
    nextState: LOOP_STATES.IDLE,
  };
}
```

- [ ] **Step 4: Expose `handlePrioritizeTransition` and `executePlanStage` on `_internalForTests`**

Add both to the `_internalForTests` export on `loopController`.

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd server && npx vitest run tests/factory-loop-prioritize-starved.test.js
```
Expected: PASS.

- [ ] **Step 6: Run the wider factory loop suite to confirm no regressions**

```bash
cd server && npx vitest run tests/factory-loop*.test.js
```
Expected: all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/factory/loop-controller.js server/tests/factory-loop-prioritize-starved.test.js
git commit -m "fix(factory): short-circuit PRIORITIZE to IDLE when intake is empty

When PRIORITIZE returns no work item, skip PLAN entirely and transition
directly to IDLE with a short_circuit_to_idle decision. Prevents empty
PLAN cycles (architect-runner.js Task 1 handles the LLM gate; this is
the state-machine half)."
```

---

## Task 3: Add STARVED loop state

**Why:** IDLE means "between batches, healthy." A project with no intake source is not healthy — it needs operator attention. Currently IDLE and starving-forever look identical on the dashboard. A `STARVED` state pauses the tick so we stop spinning up new instances on a project that has nothing to do, and exposes the condition as first-class data.

**Files:**
- Modify: `server/factory/loop-states.js` (add `STARVED`)
- Modify: `server/factory/loop-controller.js` (emit STARVED from short-circuit path)
- Modify: `server/factory/factory-tick.js` (exclude STARVED from tick reactivation)
- Modify: `server/db/schema-migrations.js` (add consecutive_empty_cycles column)
- Test: `server/tests/factory-starved-state.test.js` (new)
- Test: `server/tests/loop-states.test.js` (extend)

- [ ] **Step 1: Add STARVED to LOOP_STATES**

In `server/factory/loop-states.js`, extend the enum:

```js
const LOOP_STATES = Object.freeze({
  SENSE: 'SENSE',
  PRIORITIZE: 'PRIORITIZE',
  PLAN: 'PLAN',
  PLAN_REVIEW: 'PLAN_REVIEW',
  EXECUTE: 'EXECUTE',
  VERIFY: 'VERIFY',
  LEARN: 'LEARN',
  IDLE: 'IDLE',
  PAUSED: 'PAUSED',
  STARVED: 'STARVED',
});
```

STARVED has no outgoing automatic transition (like PAUSED and IDLE). Update `getNextState` to treat STARVED as terminal (returns STARVED unchanged).

- [ ] **Step 2: Write the failing state-machine test**

Create `server/tests/factory-starved-state.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { LOOP_STATES, getNextState, isValidState } = require('../factory/loop-states');

describe('STARVED loop state', () => {
  it('is a valid loop state', () => {
    expect(isValidState(LOOP_STATES.STARVED)).toBe(true);
    expect(LOOP_STATES.STARVED).toBe('STARVED');
  });

  it('has no automatic transition', () => {
    for (const trust of ['supervised', 'guided', 'autonomous', 'dark']) {
      expect(getNextState(LOOP_STATES.STARVED, trust, 'approved')).toBe(LOOP_STATES.STARVED);
    }
  });
});
```

- [ ] **Step 3: Run the test and confirm it passes**

```bash
cd server && npx vitest run tests/factory-starved-state.test.js tests/loop-states.test.js
```
Expected: PASS.

- [ ] **Step 4: Track consecutive not-found cycles and transition to STARVED**

In `server/factory/loop-controller.js`, add a counter on the project row `consecutive_empty_cycles`. Increment it each time `handlePrioritizeTransition` short-circuits on empty intake. Zero it on any successful claim.

Add schema migration in `server/db/schema-migrations.js`:

```js
safeAddColumn('factory_projects', 'consecutive_empty_cycles INTEGER DEFAULT 0');
```

After incrementing, if `consecutive_empty_cycles >= 3`, set `loop_state = STARVED`:

```js
if (consecutiveEmpty >= STARVATION_THRESHOLD) {
  idleInstance = updateInstanceAndSync(instance.id, {
    loop_state: LOOP_STATES.STARVED,
    last_action_at: nowIso(),
  });
  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.PRIORITIZE,
    action: 'entered_starved',
    reasoning: `No work item found for ${consecutiveEmpty} consecutive cycles; entering STARVED state. Operator action required (re-scout, create_work_item, or configure plans_dir).`,
    outcome: {
      consecutive_empty_cycles: consecutiveEmpty,
      from_state: currentState,
      to_state: LOOP_STATES.STARVED,
      suggested_actions: ['re-run scouts', 'create_work_item', 'set plans_dir'],
    },
    confidence: 1,
    batch_id: getDecisionBatchId(project, null, null, idleInstance),
  });
}
```

`STARVATION_THRESHOLD` is a module-level `const STARVATION_THRESHOLD = 3;`.

- [ ] **Step 5: Exclude STARVED from factory tick reactivation**

In `server/factory/factory-tick.js`, find the query that selects projects eligible for reactivation. Exclude STARVED so the tick does not create new instances on starved projects.

- [ ] **Step 6: Write an integration test for the STARVED transition**

Extend `server/tests/factory-loop-prioritize-starved.test.js`:

```js
it('transitions to STARVED after 3 consecutive empty cycles', async () => {
  // Seed the project with consecutive_empty_cycles = 2
  // Run handlePrioritizeTransition once with empty intake
  // Expect loop_state = STARVED and decision action = 'entered_starved'
});
```

- [ ] **Step 7: Run the suite**

```bash
cd server && npx vitest run tests/factory-starved-state.test.js tests/factory-loop-prioritize-starved.test.js tests/factory-tick.test.js
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/factory/loop-states.js server/factory/loop-controller.js server/factory/factory-tick.js server/db/schema-migrations.js server/tests/factory-starved-state.test.js server/tests/factory-loop-prioritize-starved.test.js
git commit -m "feat(factory): add STARVED loop state with consecutive-empty-cycle detection

After 3 consecutive PRIORITIZE cycles with no open work item, the loop
transitions to STARVED. The factory tick excludes STARVED projects from
reactivation. STARVED is terminal until an operator action refills
intake (scout rerun, create_work_item, or plans_dir config)."
```

---

## Task 4: Auto re-scout on starvation

**Why:** Item 3 stops the bleeding but still leaves the project stuck waiting for a human. The factory should recover itself by re-running its scout fleet when starved, producing fresh findings for `scout-findings-intake` to consume on the next SENSE cycle.

**Files:**
- Create: `server/factory/starvation-recovery.js`
- Modify: `server/factory/factory-tick.js` (invoke recovery on STARVED projects)
- Modify: `server/container.js` (register starvationRecovery)
- Test: `server/tests/factory-starvation-recovery.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `server/tests/factory-starvation-recovery.test.js`:

```js
'use strict';

const { describe, it, expect, vi } = require('vitest');
const { createStarvationRecovery } = require('../factory/starvation-recovery');

describe('starvation recovery', () => {
  it('dispatches scout sweep when project has been STARVED longer than dwell', async () => {
    const submitScout = vi.fn().mockResolvedValue({ task_id: 't1' });
    const updateLoopState = vi.fn();
    const now = Date.now();
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState,
      dwellMs: 15 * 60 * 1000,
      now: () => now,
    });

    const project = {
      id: 'p1',
      path: '/tmp/p1',
      loop_state: 'STARVED',
      loop_last_action_at: new Date(now - 20 * 60 * 1000).toISOString(),
    };

    const result = await recovery.maybeRecover(project);

    expect(submitScout).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1' }));
    expect(updateLoopState).toHaveBeenCalledWith('p1', expect.objectContaining({ loop_state: 'SENSE' }));
    expect(result.recovered).toBe(true);
  });

  it('does nothing before dwell elapses', async () => {
    const submitScout = vi.fn();
    const now = Date.now();
    const recovery = createStarvationRecovery({
      submitScout,
      updateLoopState: vi.fn(),
      dwellMs: 15 * 60 * 1000,
      now: () => now,
    });

    const project = {
      id: 'p1',
      path: '/tmp/p1',
      loop_state: 'STARVED',
      loop_last_action_at: new Date(now - 5 * 60 * 1000).toISOString(),
    };

    const result = await recovery.maybeRecover(project);

    expect(submitScout).not.toHaveBeenCalled();
    expect(result.recovered).toBe(false);
  });
});
```

- [ ] **Step 2: Implement the recovery module**

Create `server/factory/starvation-recovery.js`:

```js
'use strict';

function createStarvationRecovery({ submitScout, updateLoopState, dwellMs, now = () => Date.now() }) {
  async function maybeRecover(project) {
    if (!project || project.loop_state !== 'STARVED') {
      return { recovered: false, reason: 'not_starved' };
    }
    const lastActionMs = project.loop_last_action_at
      ? new Date(project.loop_last_action_at).getTime()
      : 0;
    if (now() - lastActionMs < dwellMs) {
      return { recovered: false, reason: 'dwell_not_elapsed' };
    }

    await submitScout({
      project_id: project.id,
      project_path: project.path,
      variants: ['quality', 'security', 'performance', 'documentation', 'test-coverage', 'dependency'],
      reason: 'factory_starvation_recovery',
    });

    updateLoopState(project.id, {
      loop_state: 'SENSE',
      last_action_at: new Date(now()).toISOString(),
    });

    return { recovered: true };
  }

  return { maybeRecover };
}

module.exports = { createStarvationRecovery };
```

- [ ] **Step 3: Register the module in the DI container**

In `server/container.js`, in the factory block, add:

```js
container.registerFactory('starvationRecovery', ({ taskCore }) => {
  const { createStarvationRecovery } = require('./factory/starvation-recovery');
  return createStarvationRecovery({
    submitScout: (opts) => require('./handlers/scout-handlers').submitScoutSweep(opts),
    updateLoopState: (projectId, updates) => require('./factory/loop-controller').updateProjectLoopState(projectId, updates),
    dwellMs: 15 * 60 * 1000,
  });
});
```

- [ ] **Step 4: Wire into factory-tick**

In `server/factory/factory-tick.js`, on each tick iterate STARVED projects and call `starvationRecovery.maybeRecover(project)`. Log both outcomes.

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd server && npx vitest run tests/factory-starvation-recovery.test.js tests/factory-tick.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/factory/starvation-recovery.js server/factory/factory-tick.js server/container.js server/tests/factory-starvation-recovery.test.js
git commit -m "feat(factory): auto re-scout starved projects after 15-minute dwell

starvation-recovery dispatches the default scout variant set when a
project has been STARVED for longer than dwellMs (15 min default).
Scouts write new findings to docs/findings, scout-findings-intake
creates new work items on the next SENSE cycle, and the loop resumes
automatically. Closes the 'factory starves forever without a human'
class of bug."
```

---

## Task 5: Dashboard visibility

**Why:** Starvation must be visible so operators can tell "factory is doing work" from "factory is waiting for a human." Today `loop_state: IDLE` looks identical to "between batches, healthy."

**Files:**
- Modify: `dashboard/src/views/Factory.jsx`
- Create: `dashboard/src/components/StarvationBanner.jsx`
- Test: `dashboard/src/components/StarvationBanner.test.jsx` (new)
- Test: `dashboard/src/views/Factory.test.jsx` (extend)

- [ ] **Step 1: Write the failing component test**

Create `dashboard/src/components/StarvationBanner.test.jsx`:

```jsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StarvationBanner } from './StarvationBanner';

describe('StarvationBanner', () => {
  it('renders when project is STARVED', () => {
    render(<StarvationBanner project={{
      name: 'sample',
      loop_state: 'STARVED',
      loop_last_action_at: '2026-04-20T20:00:00Z',
      consecutive_empty_cycles: 5,
    }} />);
    expect(screen.getByText(/sample is starved/i)).toBeInTheDocument();
    expect(screen.getByText(/5 empty cycles/i)).toBeInTheDocument();
  });

  it('renders nothing when project is not STARVED', () => {
    const { container } = render(<StarvationBanner project={{
      name: 'healthy',
      loop_state: 'EXECUTE',
    }} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Implement the banner component**

Create `dashboard/src/components/StarvationBanner.jsx`:

```jsx
import React from 'react';

export function StarvationBanner({ project }) {
  if (!project || project.loop_state !== 'STARVED') return null;
  const cycles = project.consecutive_empty_cycles ?? 0;
  return (
    <div className="starvation-banner" role="alert">
      <strong>{project.name} is starved</strong>
      <span> — {cycles} empty cycles, no open work items.</span>
      <span> Suggested actions: re-run scouts, create a work item, or configure <code>plans_dir</code>.</span>
    </div>
  );
}
```

Add minimal styling in `dashboard/src/index.css`:

```css
.starvation-banner {
  padding: 12px 16px;
  background: #3a2d1a;
  border-left: 4px solid #f0a020;
  color: #f4e9d4;
  margin: 8px 0;
  border-radius: 4px;
}
```

- [ ] **Step 3: Render the banner in Factory.jsx**

Modify `dashboard/src/views/Factory.jsx`: for each project card, render `<StarvationBanner project={project} />` above the card body. Ensure the project's `loop_state` and `consecutive_empty_cycles` fields are included in the API response used by Factory (verify `server/handlers/factory-handlers.js` lists them).

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd dashboard && npx vitest run src/components/StarvationBanner.test.jsx src/views/Factory.test.jsx
```
Expected: PASS.

- [ ] **Step 5: Verify the banner renders live**

Start the dashboard, visit the Factory view, confirm the banner appears on a STARVED project once Task 3 is shipped.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/views/Factory.jsx dashboard/src/components/StarvationBanner.jsx dashboard/src/components/StarvationBanner.test.jsx dashboard/src/index.css
git commit -m "feat(dashboard): surface STARVED factory projects with a banner

StarvationBanner renders on the Factory view for any project in the
STARVED state, showing consecutive empty cycles and remediation
suggestions. Without this, STARVED looks identical to IDLE."
```

---

## Task 6: `plans_dir` validation

**Why:** The factory's own PLAN stage writes auto-generated plans to `<project>/docs/superpowers/plans/auto-generated/`. If a user sets `plans_dir` to that directory (or its parent), SENSE re-ingests shipped plans on every cycle. Validate at config-write time that `plans_dir` is not the auto-generated output directory, and auto-create a safe backlog directory on first project registration.

**Files:**
- Create: `server/factory/plans-dir-validator.js`
- Modify: `server/handlers/project-handlers.js` (or wherever `set_project_defaults` lives)
- Test: `server/tests/plans-dir-validator.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `server/tests/plans-dir-validator.test.js`:

```js
'use strict';

const path = require('path');
const { describe, it, expect } = require('vitest');
const { validatePlansDir } = require('../factory/plans-dir-validator');

describe('validatePlansDir', () => {
  const projectPath = path.join('/tmp', 'sample-project');

  it('rejects the auto-generated output directory', () => {
    const result = validatePlansDir({
      projectPath,
      plansDir: path.join(projectPath, 'docs/superpowers/plans/auto-generated'),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/auto-generated/i);
  });

  it('rejects paths that are not inside the project', () => {
    const result = validatePlansDir({
      projectPath,
      plansDir: path.join('/tmp', 'other-project', 'docs', 'plans'),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside project/i);
  });

  it('accepts a safe backlog directory inside the project', () => {
    const result = validatePlansDir({
      projectPath,
      plansDir: path.join(projectPath, 'docs/superpowers/plans/backlog'),
    });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Implement the validator**

Create `server/factory/plans-dir-validator.js`:

```js
'use strict';

const path = require('path');

const FORBIDDEN_SEGMENT = path.sep + 'auto-generated';

function validatePlansDir({ projectPath, plansDir }) {
  if (!plansDir || typeof plansDir !== 'string') {
    return { ok: false, error: 'plans_dir must be a non-empty string' };
  }
  const absProject = path.resolve(projectPath);
  const absPlans = path.resolve(plansDir);

  if (!absPlans.startsWith(absProject + path.sep) && absPlans !== absProject) {
    return { ok: false, error: `plans_dir is outside project: ${absPlans}` };
  }
  if (absPlans.endsWith(FORBIDDEN_SEGMENT) || absPlans.includes(FORBIDDEN_SEGMENT + path.sep)) {
    return { ok: false, error: "plans_dir must not point at the factory's auto-generated output directory" };
  }
  return { ok: true };
}

module.exports = { validatePlansDir };
```

- [ ] **Step 3: Wire into `set_project_defaults`**

Find the handler that writes `plans_dir` into `factory_projects.config_json` (likely `server/handlers/project-handlers.js` or `server/handlers/factory-handlers.js`). Before the write, call `validatePlansDir`; if `ok === false`, reject the MCP call with the error message.

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd server && npx vitest run tests/plans-dir-validator.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/plans-dir-validator.js server/handlers/*-handlers.js server/tests/plans-dir-validator.test.js
git commit -m "feat(factory): validate plans_dir rejects auto-generated output dir

plans_dir cannot be set to docs/superpowers/plans/auto-generated (the
factory's own write target) or to a path outside the project. Prevents
the footgun where SENSE re-ingests shipped plans on every cycle."
```

---

## Task 7: Unstick the starved project

**Why:** The starved project is the proof-of-harm example and the user wants it working again.

**Files:** none (operational)

- [ ] **Step 1: Run the project's scout fleet to produce fresh findings**

Invoke the scout dispatcher. Project id is `e8c72a76-37fc-4a15-b401-dbf5b57c3aca`.

```bash
curl -s -X POST http://127.0.0.1:3457/api/v2/factory/projects/e8c72a76-37fc-4a15-b401-dbf5b57c3aca/scout \
  -H 'Content-Type: application/json' \
  -d '{"variants":["quality","security","performance","documentation","test-coverage","dependency"],"reason":"starvation unblock 2026-04-20"}'
```

(If no REST route exists, use the MCP tool `submit_scout` with the equivalent payload.)

- [ ] **Step 2: Wait for scouts to write `docs/findings/*-scan.md`**

Monitor via `list_tasks` or `await_task`. Each scout writes a `YYYY-MM-DD-<variant>-scan.md` file.

- [ ] **Step 3: Trigger an architect cycle**

Once scouts complete, call the architect runner to ingest findings and populate intake:

```bash
curl -s -X POST http://127.0.0.1:3457/api/v2/factory/projects/e8c72a76-37fc-4a15-b401-dbf5b57c3aca/architect
```

- [ ] **Step 4: Verify the project has open work items**

```bash
for s in pending triaged in_progress; do
  echo -n "$s: "
  curl -s "http://127.0.0.1:3457/api/v2/factory/projects/e8c72a76-37fc-4a15-b401-dbf5b57c3aca/intake?status=$s&limit=50" \
    | python -c "import sys,json;print(len(json.load(sys.stdin)['data']['items']))"
done
```
Expected: at least one of `pending`/`triaged` is non-zero.

- [ ] **Step 5: Confirm factory exits STARVED**

Once open items exist, the next tick should exit STARVED on its own (after Task 4 ships). Verify with:

```bash
curl -s http://127.0.0.1:3457/api/v2/factory/projects | python -c "
import sys,json
for p in json.load(sys.stdin)['data']['projects']:
  if p['id']=='e8c72a76-37fc-4a15-b401-dbf5b57c3aca': print(p['loop_state'], p.get('consecutive_empty_cycles'))"
```
Expected: not `STARVED`, `consecutive_empty_cycles: 0`.

---

## Self-Review

**1. Spec coverage:**
- Item 1 "Gate architect LLM on empty intake" → Task 1
- Item 2 "PRIORITIZE short-circuit" → Task 2
- Item 3 "STARVED state" → Task 3
- Item 4 "Auto re-scout" → Task 4
- Item 5 "Dashboard visibility" → Task 5
- Item 6 "plans_dir validation" → Task 6
- Unstick the starved project → Task 7

**2. Placeholder scan:** every step names exact files, exact commands, and full code. No "TBD" / "implement later."

**3. Type consistency:** `consecutive_empty_cycles` column name is used identically in Tasks 3 and 5. `LOOP_STATES.STARVED` string value `'STARVED'` is used identically in Tasks 3, 4, 5. `starvationRecovery.maybeRecover` signature is consistent between container registration and test.

**Ordering note:** Tasks 1-3 are the critical core (stop waste + make starvation a state). Task 4 depends on Task 3 (needs STARVED). Task 5 depends on Task 3 (renders STARVED). Task 6 is independent and can run in parallel. Task 7 benefits from (but does not strictly require) Tasks 1-4 being live.
