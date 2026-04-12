# Software Factory Phase 11: End-to-End Bring-Up + Plan 1 Smoke

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** First real end-to-end run of the factory on a live plan. Register `torque-public` as a factory project with `plans_dir` pointing at `docs/superpowers/plans/`, set trust level `supervised`, and drive Plan 1 (workflow-as-code) through `SENSE → PRIORITIZE → PLAN → EXECUTE → VERIFY → LEARN → IDLE`. Document every gap discovered and patch the factory to close it.

**Architecture:** No new factory modules. This phase is integration + fixture + observability work. Three tasks:
1. **Register the project** — use existing Phase 1 tooling (`factory_projects`) to add `torque-public` with `plans_dir`, `trust_level: supervised`, `verify_command` from project defaults.
2. **Dry-run Plan 1** — run `scan_plans_directory` then drive the loop manually through each state, capturing approval prompts + state transitions.
3. **Observability + gap log** — record every state transition in `factory_decision_log`, compare against expected flow, file fixes for any missing hook.

**Tech Stack:** Existing factory + TORQUE MCP. Depends on Phase 9 (plan-file-intake) and Phase 10 (plan-executor) landing first.

---

## File Structure

**New files:**
- `docs/findings/2026-04-12-factory-bringup-plan-1.md` (written during Task 3)
- `server/tests/factory-bringup-plan-1.test.js` (regression guard after fixes)

**Modified files:**
- `server/factory/loop-controller.js` — any bring-up patches discovered
- Project registration row (runtime, not a file)

---

## Task 1: Register torque-public as a factory project

- [ ] **Step 1: Confirm Phase 1 project-registration APIs exist**

Run:

```bash
node -e "const {listProjects} = require('./server/db/factory-health'); console.log(listProjects());"
```

Expected: an array (possibly empty). If the module shape differs, note the actual registration path (likely `factoryProjects.register(...)` in `server/db/factory-health.js` or a dedicated `factory-projects.js`).

- [ ] **Step 2: Register the project**

Via MCP (preferred) or a one-shot script:

```js
// server/scripts/register-torque-public-factory.js (one-shot, not committed long-term)
'use strict';
const path = require('path');
const { getDb } = require('../db/connection');
const factoryProjects = require('../db/factory-projects'); // or wherever registration lives

const REPO_ROOT = process.env.TORQUE_REPO_ROOT || path.resolve(__dirname, '..', '..');
const PLANS_DIR = path.join(REPO_ROOT, 'docs', 'superpowers', 'plans');

factoryProjects.setDb(getDb());
const id = factoryProjects.register({
  name: 'torque-public',
  working_directory: REPO_ROOT,
  trust_level: 'supervised',
  config: {
    plans_dir: PLANS_DIR,
    verify_command: 'npx vitest run',
    ui_review: false,
  },
});
console.log('registered project id:', id);
```

Run it, capture the project id. Set `TORQUE_REPO_ROOT` in the environment if the script is invoked from outside the repo tree.

- [ ] **Step 3: Verify via MCP**

Call `get_factory_project { id: <id> }` (or equivalent MCP tool) — expect trust_level=supervised, plans_dir set, current_state=IDLE.

- [ ] **Step 4: Commit the registration script (or remove if one-shot)**

If we keep the script for future reruns:

```bash
git add server/scripts/register-torque-public-factory.js
git commit -m "feat(factory): register torque-public as factory project (supervised)"
```

Otherwise delete it; the registration persists in the DB.

---

## Task 2: Drive Plan 1 through the loop

- [ ] **Step 1: SENSE — ingest plans**

Call `scan_plans_directory { project_id, plans_dir }`. Expected: 103+ new work items, `source='plan_file'`, one per `2026-04-11-fabro-*.md` file. Record the work_item_id that corresponds to `2026-04-11-fabro-1-workflow-as-code.md` — call it `WI_1`.

- [ ] **Step 2: PRIORITIZE — approval gate 1**

Advance the loop (`tick_factory_loop` or whatever API exists). Expected: state transitions to PRIORITIZE, then **pauses** because trust=supervised and PRIORITIZE is gated. Approve via `approve_factory_transition { project_id, state: 'PRIORITIZE', work_item_id: WI_1 }`. The factory should set `WI_1.priority` based on scorer output (Phase 1b) and move on.

- [ ] **Step 3: PLAN — architect skipped**

Advance again. Because `WI_1.origin.plan_path` exists (Phase 9 wrote it), Phase 10's branch should fire: state moves directly to EXECUTE with reason `'pre-written plan detected'`. **No architect run should happen.** Confirm by checking `factory_decision_log` for a `plan_stage_skipped` entry.

- [ ] **Step 4: EXECUTE — plan-executor runs**

Plan 1's tasks now get submitted to TORQUE one at a time via Phase 10's executor. For each task:
- TORQUE submission appears in `list_tasks` (queued→running→completed)
- `verify_command` runs post-task
- On success, `2026-04-11-fabro-1-workflow-as-code.md` checkboxes flip from `[ ]` to `[x]` on disk

Watch the Factory dashboard in real time. If a task fails verify, the loop should transition to IDLE with `reject_reason`.

- [ ] **Step 5: VERIFY — approval gate 2**

After EXECUTE finishes clean, VERIFY is gated under supervised trust. Approve via `approve_factory_transition { ..., state: 'VERIFY' }`. Factory runs the project-level verify (beyond per-task): full `npx vitest run` and `git status`. Record results.

- [ ] **Step 6: LEARN — approval gate 3**

Approve. LEARN records completion metrics in `factory_feedback` (Phase 7). State moves to IDLE. `WI_1.status` moves to `shipped`.

- [ ] **Step 7: Confirm on-disk state**

```bash
git log --oneline -5
# Expect N new commits, one per task in Plan 1, with Plan 1's commit messages.
grep -c '- \[x\]' docs/superpowers/plans/2026-04-11-fabro-1-workflow-as-code.md
# Expect all step checkboxes ticked.
```

---

## Task 3: Gap log + regression test

- [ ] **Step 1: Write the bring-up report**

Create `docs/findings/2026-04-12-factory-bringup-plan-1.md` documenting:
- Actual state transitions vs expected
- Time spent in each state
- Any manual interventions needed (e.g., a missing config key we had to hand-set)
- Any hooks that didn't fire (e.g., per-hunk approval if trust was guided, decision-log entries missing)
- TORQUE-side issues (task stalls, verify flakes, provider quirks)

Structure:

```markdown
# Factory Bring-Up: Plan 1 (Workflow-as-Code)

**Date:** 2026-04-12
**Project:** torque-public
**Trust level:** supervised
**Work item:** WI_<id>
**Outcome:** <shipped | partial | failed>

## Timeline
| Time | State | Duration | Notes |
|------|-------|----------|-------|
| ... | SENSE | 2s | scanned 103 plans |
| ... | PRIORITIZE | 40s | paused for approval, approved via MCP |
...

## Gaps Found
1. **<short title>** — <description>. **Fix:** <file:line change or new task>.
...

## Next Plan to Try
<plan id + rationale>
```

- [ ] **Step 2: Regression test**

Create `server/tests/factory-bringup-plan-1.test.js` — NOT a full e2e (too slow), but a deterministic fixture test that replays the decision_log events and confirms state transitions matched expectations. One `it(...)` per state transition: `SENSE → PRIORITIZE`, `PLAN skipped when plan_path`, `EXECUTE → VERIFY on success`, etc.

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { getNextState } = require('../factory/loop-states');

describe('factory bring-up regression — Plan 1 transitions', () => {
  it('SENSE -> PRIORITIZE gated under supervised until approved', () => {
    // unapproved
    expect(getNextState('SENSE', 'supervised', null)).toBe('PAUSED');
    // approved
    expect(getNextState('SENSE', 'supervised', 'approved')).toBe('PRIORITIZE');
  });

  it('PLAN -> EXECUTE is the desired transition when plan_path present', () => {
    // Confirms loop-controller still branches correctly after edits
    expect(getNextState('PLAN', 'supervised', 'approved')).toBe('EXECUTE');
  });

  it('EXECUTE -> VERIFY after successful plan run', () => {
    expect(getNextState('EXECUTE', 'supervised', null)).toBe('VERIFY');
  });

  it('VERIFY gated, LEARN gated, LEARN -> IDLE on approve', () => {
    expect(getNextState('VERIFY', 'supervised', null)).toBe('PAUSED');
    expect(getNextState('VERIFY', 'supervised', 'approved')).toBe('LEARN');
    expect(getNextState('LEARN', 'supervised', 'approved')).toBe('IDLE');
  });

  it('any rejected approval returns to IDLE', () => {
    for (const s of ['SENSE', 'PRIORITIZE', 'PLAN', 'VERIFY', 'LEARN']) {
      expect(getNextState(s, 'supervised', 'rejected')).toBe('IDLE');
    }
  });
});
```

Run: `npx vitest run server/tests/factory-bringup-plan-1.test.js` → all pass.

- [ ] **Step 3: Commit**

```bash
git add docs/findings/2026-04-12-factory-bringup-plan-1.md server/tests/factory-bringup-plan-1.test.js
git commit -m "docs(factory): Plan 1 bring-up report + transition regression test"
```

- [ ] **Step 4: File any gap-closing follow-ups**

For each entry in the Gaps Found table that needs a code change, file a follow-up plan under `docs/superpowers/plans/` using the naming `2026-04-12-factory-gap-<slug>.md`. One plan per gap. Keep each tight (1–2 tasks).

Do NOT fix the gaps in this plan — this plan is the bring-up + triage. Gap-fix plans run as follow-ups.
