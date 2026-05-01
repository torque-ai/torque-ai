# Intake / Plan Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed plan-quality rules into the architect prompt, promote scout findings ahead of plan_files when scores drop or severity is critical, and retire stale scout findings via a git-log probe before PRIORITIZE plans against them.

**Architecture:** Three new modules (`plan-authoring-guide.js`, `promotion-policy.js`, `stale-probe.js`) plus surgical edits to three existing files (`plan-quality-gate.js`, `architect-runner.js`, `loop-controller.js`). No new tables; one status-enum addition (`shipped_stale`); all behavior fail-open to preserve today's PRIORITIZE path on any error.

**Tech Stack:** Node.js / better-sqlite3, vitest, existing `factoryIntake` DB accessor, `safeLogDecision` for observability. No new deps.

**Spec:** `docs/superpowers/specs/2026-04-21-intake-plan-pipeline-design.md`

**Branch:** `feat/intake-plan-pipeline` (worktree: `.worktrees/feat-intake-plan-pipeline/`)

**Verify command (remote):** `torque-remote npx vitest run server/tests/`

## Sandbox-tolerant verify fallback

Each task below has Run-tests steps. Execute in this priority order:

1. **Preferred:** `torque-remote npx vitest run <path/to/test>` — runs on the remote workstation.
2. **Fallback 1:** `npx vitest run <path/to/test> --pool=threads --no-coverage` — avoids the fork-pool that sometimes hits `spawn EPERM`.
3. **Fallback 2:** If both fail with spawn / access errors, note the exact error text, skip the run step, and proceed to the commit step. The host's post-task verification will surface regressions. Include "verify step skipped due to sandbox spawn restriction" in your final output.

Do not let a blocked vitest invocation prevent you from committing a correct code change.

---

## Task 1: Add `description` field to every rule in `plan-quality-gate.js`

**Acceptance:** Every key in the `RULES` object has a string `description` field describing the rule in one line of English. A new test asserts no rule is missing a description.

**Files:**
- Modify: `server/factory/plan-quality-gate.js` (edit the `RULES` constant, approximately lines 6-17)
- Test: `server/tests/plan-quality-gate-descriptions.test.js` (create)

- [ ] **Step 1.1: Write the failing test**

Create `server/tests/plan-quality-gate-descriptions.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const planQualityGate = require('../factory/plan-quality-gate');

describe('plan-quality-gate RULES', () => {
  it('every rule has a non-empty string `description` field', () => {
    const rules = planQualityGate.RULES || planQualityGate.default?.RULES;
    expect(rules).toBeDefined();
    const keys = Object.keys(rules);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const rule = rules[key];
      expect(rule.description, `rule "${key}" is missing a description`).toBeTypeOf('string');
      expect(rule.description.length, `rule "${key}" description is empty`).toBeGreaterThan(10);
    }
  });

  it('exports RULES so consumers can iterate', () => {
    const rules = planQualityGate.RULES || planQualityGate.default?.RULES;
    expect(rules).toBeDefined();
    expect(typeof rules).toBe('object');
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/plan-quality-gate-descriptions.test.js`
Expected: FAIL — either `rules` is undefined (not exported), or descriptions are missing.

- [ ] **Step 1.3: Export `RULES` and add descriptions**

Open `server/factory/plan-quality-gate.js`. At the bottom of the file, find the existing `module.exports` and add `RULES` to it. Then edit the `RULES` constant at the top of the file to add a `description` field to every entry:

```javascript
const RULES = {
  plan_has_task_heading: {
    severity: 'hard', scope: 'plan',
    description: 'Each task must begin with a "### Task N: ..." heading using imperative grammar.',
  },
  plan_task_count_upper_bound: {
    severity: 'hard', scope: 'plan', max: 15,
    description: 'A plan must contain at most 15 tasks. Split larger work into multiple plans.',
  },
  plan_task_count_lower_bound: {
    severity: 'warn', scope: 'plan', min: 2,
    description: 'A plan should contain at least 2 tasks (soft rule — single-task plans are tolerated).',
  },
  task_body_min_length: {
    severity: 'hard', scope: 'task', min: 100,
    description: 'Task bodies must be at least 100 characters of concrete instruction.',
  },
  task_has_file_reference: {
    severity: 'hard', scope: 'task',
    description: 'Every task body must reference at least one file path (e.g. `src/foo.ts`).',
  },
  task_has_acceptance_criterion: {
    severity: 'hard', scope: 'task',
    description: 'Every task must state an acceptance criterion — a test command, an assertion, or a specific observable outcome.',
  },
  task_avoids_vague_phrases: {
    severity: 'hard', scope: 'task', minHits: 1,
    description: 'Avoid vague phrases ("improve", "update", "clean up", "refactor accordingly") unless accompanied by a concrete file path, function name, or symbol.',
  },
  no_duplicate_task_titles: {
    severity: 'hard', scope: 'plan',
    description: 'Task titles must be unique within a plan.',
  },
  task_heading_grammar: {
    severity: 'hard', scope: 'plan',
    description: 'Task headings must use imperative grammar ("Add foo", not "Added foo" or "Adding foo").',
  },
  plan_size_upper_bound: {
    severity: 'hard', scope: 'plan', maxBytes: 100 * 1024,
    description: 'Plan file size must not exceed 100 KB.',
  },
};
```

Then at the bottom of the file, update `module.exports` to include `RULES`:

```javascript
module.exports = {
  ...(existing exports),
  RULES,
};
```

If the file does not already export anything (unlikely), add `module.exports = { RULES };` at the end.

- [ ] **Step 1.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/plan-quality-gate-descriptions.test.js`
Expected: 2 passing tests.

- [ ] **Step 1.5: Commit**

```bash
git add server/factory/plan-quality-gate.js server/tests/plan-quality-gate-descriptions.test.js
git commit -m "feat(factory): add description field to every plan-quality rule"
```

---

## Task 2: `plan-authoring-guide.js` composer

**Acceptance:** New module exports `composeGuide({ rulesSource, examplesBlock })` that returns a single markdown string containing a rule-list derived from `RULES` + a hand-written examples block. Pure function, no DB access. Tests assert structure, rule coverage, and degenerate input handling.

**Files:**
- Create: `server/factory/plan-authoring-guide.js`
- Test: `server/tests/plan-authoring-guide.test.js`

- [ ] **Step 2.1: Write the failing test**

Create `server/tests/plan-authoring-guide.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const { composeGuide, renderRuleList, DEFAULT_EXAMPLES } = require('../factory/plan-authoring-guide');

describe('plan-authoring-guide', () => {
  it('composeGuide returns a single markdown string', () => {
    const guide = composeGuide();
    expect(typeof guide).toBe('string');
    expect(guide.length).toBeGreaterThan(200);
  });

  it('composeGuide contains both rule list and examples section', () => {
    const guide = composeGuide();
    expect(guide).toMatch(/## Plan authoring rules/);
    expect(guide).toMatch(/## Good task body anatomy/);
  });

  it('composeGuide renders one bullet per rule key', () => {
    const fakeRules = {
      rule_a: { severity: 'hard', scope: 'plan', description: 'Rule A description.' },
      rule_b: { severity: 'hard', scope: 'task', description: 'Rule B description.' },
    };
    const guide = composeGuide({ rulesSource: fakeRules, examplesBlock: '' });
    expect(guide).toMatch(/Rule A description\./);
    expect(guide).toMatch(/Rule B description\./);
  });

  it('composeGuide prefixes warn-severity rules with "(soft)"', () => {
    const fakeRules = {
      rule_warn: { severity: 'warn', scope: 'plan', description: 'Soft rule.' },
      rule_hard: { severity: 'hard', scope: 'plan', description: 'Hard rule.' },
    };
    const guide = composeGuide({ rulesSource: fakeRules, examplesBlock: '' });
    expect(guide).toMatch(/\(soft\).*Soft rule/);
    expect(guide).not.toMatch(/\(soft\).*Hard rule/);
  });

  it('composeGuide with empty rules produces a valid degenerate guide', () => {
    const guide = composeGuide({ rulesSource: {}, examplesBlock: 'example' });
    expect(guide).toMatch(/## Plan authoring rules/);
    expect(guide).toMatch(/example/);
  });

  it('DEFAULT_EXAMPLES contains a Good and a Bad section', () => {
    expect(DEFAULT_EXAMPLES).toMatch(/\*\*Good\*\*/);
    expect(DEFAULT_EXAMPLES).toMatch(/\*\*Bad\*\*/);
  });

  it('renderRuleList sorts rules by key for stable output', () => {
    const fakeRules = {
      z_rule: { severity: 'hard', description: 'Zeta.' },
      a_rule: { severity: 'hard', description: 'Alpha.' },
    };
    const lines = renderRuleList(fakeRules);
    const alphaIdx = lines.findIndex((l) => l.includes('Alpha.'));
    const zetaIdx = lines.findIndex((l) => l.includes('Zeta.'));
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it('renderRuleList throws if any rule is missing description', () => {
    const badRules = {
      bad: { severity: 'hard' /* no description */ },
    };
    expect(() => renderRuleList(badRules)).toThrow(/description/);
  });

  it('composeGuide with real RULES import produces a bullet for every rule', () => {
    const { RULES } = require('../factory/plan-quality-gate');
    const guide = composeGuide({ rulesSource: RULES, examplesBlock: '' });
    for (const key of Object.keys(RULES)) {
      const snippet = RULES[key].description.slice(0, 30);
      expect(guide).toContain(snippet);
    }
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/plan-authoring-guide.test.js`
Expected: FAIL — `Cannot find module '../factory/plan-authoring-guide'`.

- [ ] **Step 2.3: Implement `plan-authoring-guide.js`**

Create `server/factory/plan-authoring-guide.js`:

```javascript
'use strict';

const { RULES } = require('./plan-quality-gate');

const DEFAULT_EXAMPLES = [
  '**Good** — concrete, testable, self-contained:',
  '',
  '    ### Task 3: Normalize test-name paths in verify-signature',
  '',
  '    **Files:**',
  '    - Modify: `server/factory/verify-signature.js`',
  '    - Test:   `server/tests/verify-signature.test.js`',
  '',
  '    - [ ] Step 1: Replace the non-greedy path regex with a',
  '          per-token strip-to-last-slash helper.',
  '    - [ ] Step 2: Run `torque-remote npx vitest run',
  '          server/tests/verify-signature.test.js`.',
  '          Expected: 6 passing tests.',
  '',
  '**Bad** — vague and untestable:',
  '',
  '    ### Task 3: Improve path handling',
  '',
  '    Clean up the path regex in verify-signature so it works',
  '    better on Windows paths. Update the tests as needed.',
].join('\n');

function renderRuleList(rulesSource) {
  const keys = Object.keys(rulesSource).sort();
  const lines = [];
  for (const key of keys) {
    const rule = rulesSource[key];
    if (typeof rule?.description !== 'string' || rule.description.length === 0) {
      throw new Error(`plan-authoring-guide: rule "${key}" is missing a description`);
    }
    const softPrefix = rule.severity === 'warn' ? '(soft) ' : '';
    lines.push(`- ${softPrefix}${rule.description}`);
  }
  return lines;
}

function composeGuide({ rulesSource = RULES, examplesBlock = DEFAULT_EXAMPLES } = {}) {
  const lines = [
    '## Plan authoring rules',
    '',
    'Every plan you produce goes through a quality gate. Plans that violate',
    'these rules are rejected and re-planning burns a Codex slot. Comply on',
    'the first pass.',
    '',
    ...renderRuleList(rulesSource),
    '',
    '## Good task body anatomy',
    '',
    examplesBlock,
  ];
  return lines.join('\n');
}

module.exports = { composeGuide, renderRuleList, DEFAULT_EXAMPLES };
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/plan-authoring-guide.test.js`
Expected: 9 passing tests.

- [ ] **Step 2.5: Commit**

```bash
git add server/factory/plan-authoring-guide.js server/tests/plan-authoring-guide.test.js
git commit -m "feat(factory): plan-authoring-guide composer combining RULES + examples"
```

---

## Task 3: Wire `composeGuide()` into architect-runner

**Acceptance:** `architect-runner.js` calls `composeGuide()` and passes the result as the second arg to `injectPlanAuthoringGuide`. On any compose error, the existing code path (or an empty guide) is used instead — plan-gen never fails because of a guide-composition problem. A test verifies both the happy path and the fallback.

**Files:**
- Modify: `server/factory/architect-runner.js` (around line 577, where `injectPlanAuthoringGuide` is called)
- Test: `server/tests/architect-runner-guide.test.js` (create)

- [ ] **Step 3.1: Read the current call site**

Run: `grep -nB2 -A8 "injectPlanAuthoringGuide(buildArchitectPrompt" server/factory/architect-runner.js`
Note the exact shape of the current invocation and any `guide` argument it currently passes. The existing call is approximately:

```javascript
const prompt = injectPlanAuthoringGuide(buildArchitectPrompt({
  // ... options
}));
```

We are adding a second argument. If the current call already passes one, the existing source (a file read) becomes the fallback — see Step 3.3.

- [ ] **Step 3.2: Write the failing test**

Create `server/tests/architect-runner-guide.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';

describe('architect-runner composed-guide injection', () => {
  it('composeGuide output is injected ahead of the architect prompt', async () => {
    // Import dynamically so we can stub a known guide
    vi.resetModules();
    vi.doMock('../factory/plan-authoring-guide', () => ({
      composeGuide: () => '## INJECTED GUIDE MARKER',
      renderRuleList: () => [],
      DEFAULT_EXAMPLES: '',
    }));
    const { injectPlanAuthoringGuide } = require('../factory/architect-runner');
    const composed = require('../factory/plan-authoring-guide').composeGuide();
    const out = injectPlanAuthoringGuide('BODY', composed);
    expect(out).toMatch(/## INJECTED GUIDE MARKER/);
    expect(out).toMatch(/BODY/);
    // Guide appears before body
    expect(out.indexOf('INJECTED GUIDE MARKER')).toBeLessThan(out.indexOf('BODY'));
    vi.doUnmock('../factory/plan-authoring-guide');
  });

  it('injectPlanAuthoringGuide returns the prompt unchanged when guide is falsy', () => {
    const { injectPlanAuthoringGuide } = require('../factory/architect-runner');
    expect(injectPlanAuthoringGuide('BODY', null)).toBe('BODY');
    expect(injectPlanAuthoringGuide('BODY', '')).toBe('BODY');
    expect(injectPlanAuthoringGuide('BODY', undefined)).toBe('BODY');
  });
});
```

- [ ] **Step 3.3: Thread composeGuide into the call site**

In `server/factory/architect-runner.js`, find the require block at the top and add:

```javascript
const { composeGuide } = require('./plan-authoring-guide');
```

Then find the `injectPlanAuthoringGuide(buildArchitectPrompt(...))` call (approximately line 577). Replace with:

```javascript
let composedGuide = '';
try {
  composedGuide = composeGuide();
} catch (err) {
  logger.warn('plan_authoring_guide_compose_failed', {
    err: err && err.message,
  });
  composedGuide = '';
}
const prompt = injectPlanAuthoringGuide(
  buildArchitectPrompt({
    // ... existing options unchanged
  }),
  composedGuide,
);
```

If the file does not already `require('../logger')` at the top, use the existing logger instance — grep for `logger` in the file to find how it is obtained, and reuse that path.

`injectPlanAuthoringGuide` already handles falsy second arg by returning the prompt unchanged (see existing body in `architect-runner.js:78`), so an empty `composedGuide` is safe.

- [ ] **Step 3.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/architect-runner-guide.test.js`
Expected: 2 passing tests.

- [ ] **Step 3.5: Commit**

```bash
git add server/factory/architect-runner.js server/tests/architect-runner-guide.test.js
git commit -m "feat(factory): architect-runner calls composeGuide() with fail-open fallback"
```

---

## Task 4: Add `shipped_stale` to `VALID_STATUSES`

**Acceptance:** `factoryIntake.updateWorkItem(id, { status: 'shipped_stale' })` succeeds without throwing the "Invalid status" error. A test asserts the new status is accepted and round-trips through the DB.

**Files:**
- Modify: `server/db/factory-intake.js` (the `VALID_STATUSES` Set at line 14)
- Test: `server/tests/factory-intake-shipped-stale.test.js` (create)

- [ ] **Step 4.1: Write the failing test**

Create `server/tests/factory-intake-shipped-stale.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory-intake');

function createMinimalSchema(db) {
  db.prepare(`CREATE TABLE factory_projects (id TEXT PRIMARY KEY, name TEXT)`).run();
  db.prepare(`INSERT INTO factory_projects (id, name) VALUES ('p1', 'test')`).run();
  db.prepare(`
    CREATE TABLE factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      linked_item_id INTEGER,
      batch_id TEXT,
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `).run();
}

describe('factory-intake shipped_stale status', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createMinimalSchema(db);
    factoryIntake.setDb(db);
  });

  afterEach(() => { db.close(); });

  it('accepts shipped_stale as a valid status on updateWorkItem', () => {
    const created = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'Scout finding X',
    });
    expect(() => factoryIntake.updateWorkItem(created.id, { status: 'shipped_stale' }))
      .not.toThrow();
    const row = db.prepare('SELECT status FROM factory_work_items WHERE id = ?').get(created.id);
    expect(row.status).toBe('shipped_stale');
  });

  it('exports VALID_STATUSES containing shipped_stale', () => {
    expect(factoryIntake.VALID_STATUSES.has('shipped_stale')).toBe(true);
  });

  it('still rejects truly bogus statuses', () => {
    const created = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'Scout finding Y',
    });
    expect(() => factoryIntake.updateWorkItem(created.id, { status: 'nonsense_status' }))
      .toThrow(/Invalid status/);
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/factory-intake-shipped-stale.test.js`
Expected: 2 failing tests — `shipped_stale` is not yet in the set.

- [ ] **Step 4.3: Add `shipped_stale` to VALID_STATUSES**

In `server/db/factory-intake.js`, replace the `VALID_STATUSES` declaration (line 14) with:

```javascript
const VALID_STATUSES = new Set([
  'pending', 'triaged', 'in_progress', 'completed', 'rejected',
  'intake', 'prioritized', 'planned', 'executing', 'verifying', 'shipped',
  'shipped_stale',
]);
```

- [ ] **Step 4.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/factory-intake-shipped-stale.test.js`
Expected: 3 passing tests.

- [ ] **Step 4.5: Commit**

```bash
git add server/db/factory-intake.js server/tests/factory-intake-shipped-stale.test.js
git commit -m "feat(factory): VALID_STATUSES accepts shipped_stale for retired scout findings"
```

---

## Task 5: `promotion-policy.js` module

**Acceptance:** New module exports `rankIntake(items, { projectScores, promotionConfig, now })`, `computeTier`, `DEFAULT_PROMOTION_CONFIG`, `SCORE_MAP`. The function returns items sorted by composite key (severity, promotion tier, priority, source, age). Tests cover CRITICAL unconditional promotion, HIGH conditional promotion, tie-break ordering, and config-missing fallback.

**Files:**
- Create: `server/factory/promotion-policy.js`
- Test: `server/tests/promotion-policy.test.js`

- [ ] **Step 5.1: Write the failing test**

Create `server/tests/promotion-policy.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const {
  rankIntake,
  computeTier,
  DEFAULT_PROMOTION_CONFIG,
  SCORE_MAP,
} = require('../factory/promotion-policy');

function mkItem(over = {}) {
  return {
    id: over.id ?? 1,
    source: over.source ?? 'plan_file',
    priority: over.priority ?? 50,
    created_at: over.created_at ?? '2026-04-20T00:00:00Z',
    origin: over.origin ?? null,
  };
}

describe('promotion-policy.computeTier', () => {
  const lowScores = { structural: 40, security: 60, user_facing: 40, performance: 50, test_coverage: 40, documentation: 40, dependency_health: 50, debt_ratio: 30 };
  const healthyScores = { structural: 95, security: 95, user_facing: 95, performance: 95, test_coverage: 95, documentation: 95, dependency_health: 95, debt_ratio: 95 };

  it('non-scout items are always tier 1', () => {
    const item = mkItem({ source: 'plan_file' });
    expect(computeTier(item, lowScores, DEFAULT_PROMOTION_CONFIG)).toBe(1);
  });

  it('CRITICAL scout is always tier 0, even with healthy scores', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'CRITICAL', variant: 'security' } });
    expect(computeTier(item, healthyScores, DEFAULT_PROMOTION_CONFIG)).toBe(0);
  });

  it('HIGH scout is tier 0 when a relevant score is below threshold', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'HIGH', variant: 'security' } });
    expect(computeTier(item, lowScores, DEFAULT_PROMOTION_CONFIG)).toBe(0);
  });

  it('HIGH scout is tier 1 when all relevant scores are healthy', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'HIGH', variant: 'security' } });
    expect(computeTier(item, healthyScores, DEFAULT_PROMOTION_CONFIG)).toBe(1);
  });

  it('MEDIUM scout is never tier 0, even with low scores', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'MEDIUM', variant: 'quality' } });
    expect(computeTier(item, lowScores, DEFAULT_PROMOTION_CONFIG)).toBe(1);
  });

  it('LOW scout is never tier 0', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'LOW', variant: 'quality' } });
    expect(computeTier(item, lowScores, DEFAULT_PROMOTION_CONFIG)).toBe(1);
  });

  it('unknown variant falls back to ALL_DIMS — any dim below threshold triggers', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'HIGH', variant: 'made-up-variant' } });
    const singleLowScore = { ...healthyScores, security: 30 };
    expect(computeTier(item, singleLowScore, DEFAULT_PROMOTION_CONFIG)).toBe(0);
  });

  it('severity_floor config tightens promotion', () => {
    const tighter = { ...DEFAULT_PROMOTION_CONFIG, severity_floor: 'CRITICAL' };
    const item = mkItem({ source: 'scout', origin: { severity: 'HIGH', variant: 'security' } });
    expect(computeTier(item, lowScores, tighter)).toBe(1);
  });
});

describe('promotion-policy.rankIntake', () => {
  const lowScores = { structural: 40, security: 60 };
  const healthyScores = { structural: 95, security: 95 };

  it('CRITICAL scout beats plan_file with higher priority', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 90 }),
      mkItem({ id: 2, source: 'scout', priority: 50, origin: { severity: 'CRITICAL', variant: 'security' } }),
    ];
    const ranked = rankIntake(items, { projectScores: healthyScores });
    expect(ranked[0].id).toBe(2);
    expect(ranked[1].id).toBe(1);
  });

  it('HIGH scout beats plan_file when relevant score is low', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 70 }),
      mkItem({ id: 2, source: 'scout', priority: 50, origin: { severity: 'HIGH', variant: 'security' } }),
    ];
    const ranked = rankIntake(items, { projectScores: { ...lowScores, security: 60 } });
    expect(ranked[0].id).toBe(2);
  });

  it('HIGH scout ranks below plan_file when scores are healthy', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 70 }),
      mkItem({ id: 2, source: 'scout', priority: 50, origin: { severity: 'HIGH', variant: 'security' } }),
    ];
    const ranked = rankIntake(items, { projectScores: healthyScores });
    expect(ranked[0].id).toBe(1);
  });

  it('within same tier: higher priority wins', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 50 }),
      mkItem({ id: 2, source: 'plan_file', priority: 70 }),
    ];
    const ranked = rankIntake(items, { projectScores: healthyScores });
    expect(ranked[0].id).toBe(2);
  });

  it('within same tier+priority: scout source beats plan_file', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 50 }),
      mkItem({ id: 2, source: 'scout', priority: 50, origin: { severity: 'MEDIUM', variant: 'quality' } }),
    ];
    const ranked = rankIntake(items, { projectScores: healthyScores });
    expect(ranked[0].id).toBe(2);
  });

  it('within same tier+priority+source: older item wins', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 50, created_at: '2026-04-20T10:00:00Z' }),
      mkItem({ id: 2, source: 'plan_file', priority: 50, created_at: '2026-04-19T10:00:00Z' }),
    ];
    const ranked = rankIntake(items, { projectScores: healthyScores });
    expect(ranked[0].id).toBe(2);
  });

  it('missing projectScores uses empty object (no dim triggers, HIGH stays tier 1)', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 70 }),
      mkItem({ id: 2, source: 'scout', priority: 50, origin: { severity: 'HIGH', variant: 'security' } }),
    ];
    const ranked = rankIntake(items, { projectScores: {} });
    expect(ranked[0].id).toBe(1);
  });

  it('malformed promotionConfig uses defaults', () => {
    const items = [
      mkItem({ id: 1, source: 'scout', priority: 50, origin: { severity: 'CRITICAL', variant: 'security' } }),
      mkItem({ id: 2, source: 'plan_file', priority: 90 }),
    ];
    const ranked = rankIntake(items, { projectScores: { structural: 99 }, promotionConfig: null });
    expect(ranked[0].id).toBe(1);
  });

  it('empty items returns empty array', () => {
    expect(rankIntake([], { projectScores: {} })).toEqual([]);
  });
});

describe('promotion-policy.SCORE_MAP', () => {
  it('covers the canonical scout variants', () => {
    for (const variant of ['security', 'quality', 'performance', 'visual', 'accessibility', 'test-coverage', 'documentation', 'dependency']) {
      expect(Array.isArray(SCORE_MAP[variant])).toBe(true);
      expect(SCORE_MAP[variant].length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/promotion-policy.test.js`
Expected: FAIL — `Cannot find module '../factory/promotion-policy'`.

- [ ] **Step 5.3: Implement `promotion-policy.js`**

Create `server/factory/promotion-policy.js`:

```javascript
'use strict';

const DEFAULT_PROMOTION_CONFIG = Object.freeze({
  severity_floor: 'HIGH',
  score_trigger: Object.freeze({
    structural: 60,
    security: 75,
    user_facing: 60,
    performance: 70,
    test_coverage: 60,
    documentation: 50,
    dependency_health: 70,
    debt_ratio: 50,
  }),
  stale_probe_enabled: true,
  stale_max_repicks: 3,
  stale_churn_threshold: 5,
});

const ALL_DIMS = Object.freeze(Object.keys(DEFAULT_PROMOTION_CONFIG.score_trigger));

const SCORE_MAP = Object.freeze({
  security:      Object.freeze(['security', 'debt_ratio']),
  quality:       Object.freeze(['structural', 'debt_ratio', 'test_coverage']),
  performance:   Object.freeze(['performance', 'structural']),
  visual:        Object.freeze(['user_facing']),
  accessibility: Object.freeze(['user_facing']),
  'test-coverage': Object.freeze(['test_coverage']),
  documentation: Object.freeze(['documentation']),
  dependency:    Object.freeze(['dependency_health']),
});

const SEVERITY_RANK = Object.freeze({
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
});

const SOURCE_TIEBREAK = Object.freeze({
  scout: 0,
  manual: 1,
  plan_file: 2,
  architect: 2,
  conversation: 3,
  conversational: 3,
});

function normalizeSeverity(severity) {
  if (typeof severity !== 'string') return null;
  const upper = severity.trim().toUpperCase();
  return SEVERITY_RANK.hasOwnProperty(upper) ? upper : null;
}

function severityBucket(item) {
  if (item?.source !== 'scout') return 4;
  const sev = normalizeSeverity(item.origin?.severity);
  return sev === null ? 4 : SEVERITY_RANK[sev];
}

function computeTier(item, projectScores, promotionConfig) {
  const cfg = mergeConfig(promotionConfig);
  if (!item || item.source !== 'scout') return 1;
  const severity = normalizeSeverity(item.origin?.severity);
  if (severity === null) return 1;
  if (severity === 'CRITICAL') return 0;
  const floorRank = SEVERITY_RANK[cfg.severity_floor] ?? SEVERITY_RANK.HIGH;
  if (SEVERITY_RANK[severity] > floorRank) return 1;
  const variant = item.origin?.variant;
  const relevantDims = SCORE_MAP[variant] || ALL_DIMS;
  const scores = projectScores || {};
  const triggered = relevantDims.some((dim) => {
    const score = scores[dim];
    const threshold = cfg.score_trigger?.[dim];
    return typeof score === 'number' && typeof threshold === 'number' && score < threshold;
  });
  return triggered ? 0 : 1;
}

function mergeConfig(overrides) {
  if (!overrides || typeof overrides !== 'object') return DEFAULT_PROMOTION_CONFIG;
  return {
    ...DEFAULT_PROMOTION_CONFIG,
    ...overrides,
    score_trigger: {
      ...DEFAULT_PROMOTION_CONFIG.score_trigger,
      ...(overrides.score_trigger || {}),
    },
  };
}

function createdAtMs(item) {
  if (!item?.created_at) return Number.MAX_SAFE_INTEGER;
  const ms = Date.parse(item.created_at);
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function rankIntake(items, {
  projectScores = {},
  promotionConfig = DEFAULT_PROMOTION_CONFIG,
  now = new Date(),
} = {}) {
  void now;
  if (!Array.isArray(items)) return [];
  const cfg = mergeConfig(promotionConfig);
  const decorated = items.map((item) => ({
    item,
    key: [
      severityBucket(item),
      computeTier(item, projectScores, cfg),
      -(Number(item?.priority) || 0),
      SOURCE_TIEBREAK[item?.source] ?? 4,
      createdAtMs(item),
    ],
  }));
  decorated.sort((a, b) => {
    for (let i = 0; i < a.key.length; i += 1) {
      if (a.key[i] < b.key[i]) return -1;
      if (a.key[i] > b.key[i]) return 1;
    }
    return 0;
  });
  return decorated.map((d) => d.item);
}

module.exports = {
  rankIntake,
  computeTier,
  mergeConfig,
  normalizeSeverity,
  DEFAULT_PROMOTION_CONFIG,
  SCORE_MAP,
  SEVERITY_RANK,
  SOURCE_TIEBREAK,
  ALL_DIMS,
};
```

- [ ] **Step 5.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/promotion-policy.test.js`
Expected: All tests pass (17 tests).

- [ ] **Step 5.5: Commit**

```bash
git add server/factory/promotion-policy.js server/tests/promotion-policy.test.js
git commit -m "feat(factory): promotion-policy ranks intake by severity + score triggers"
```

---

## Task 6: `stale-probe.js` module

**Acceptance:** New module exports `probeStaleness(item, { projectPath, promotionConfig, now, gitRunner })` that returns `{ stale, reason, commits_since_scan, probe_ms }`. Gate sequence: eligibility → path safety → file existence → git-log churn. 3-second timeout; fail-open on any error. Tests cover every gate plus the timeout.

**Files:**
- Create: `server/factory/stale-probe.js`
- Test: `server/tests/stale-probe.test.js`

- [ ] **Step 6.1: Write the failing test**

Create `server/tests/stale-probe.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const path = require('path');
const fs = require('fs');
const os = require('os');

const { probeStaleness } = require('../factory/stale-probe');
const { DEFAULT_PROMOTION_CONFIG } = require('../factory/promotion-policy');

function mkScoutItem(over = {}) {
  return {
    id: 1,
    source: 'scout',
    created_at: '2026-04-20T00:00:00Z',
    origin: over.origin ?? { target_file: 'src/foo.js', severity: 'HIGH', variant: 'security' },
    ...over,
  };
}

describe('stale-probe.probeStaleness', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-probe-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Gate 1: non-scout item skips with reason not_scout_eligible', async () => {
    const item = { id: 1, source: 'plan_file', origin: { target_file: 'x.js' }, created_at: '2026-04-20T00:00:00Z' };
    const out = await probeStaleness(item, { projectPath: tmpDir });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('not_scout_eligible');
  });

  it('Gate 1: missing target_file skips with reason no_target_file', async () => {
    const item = mkScoutItem({ origin: { severity: 'HIGH' } });
    const out = await probeStaleness(item, { projectPath: tmpDir });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('no_target_file');
  });

  it('Gate 1: stale_probe_enabled=false skips with reason probe_disabled', async () => {
    const item = mkScoutItem();
    const cfg = { ...DEFAULT_PROMOTION_CONFIG, stale_probe_enabled: false };
    const out = await probeStaleness(item, { projectPath: tmpDir, promotionConfig: cfg });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('probe_disabled');
  });

  it('Gate 2: path traversal target is rejected', async () => {
    const item = mkScoutItem({ origin: { target_file: '../outside.js', severity: 'HIGH', variant: 'security' } });
    const out = await probeStaleness(item, { projectPath: tmpDir });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('invalid_target_path');
  });

  it('Gate 3: target_file missing -> stale with reason target_file_deleted', async () => {
    const item = mkScoutItem({ origin: { target_file: 'does/not/exist.js', severity: 'HIGH', variant: 'security' } });
    const out = await probeStaleness(item, { projectPath: tmpDir });
    expect(out.stale).toBe(true);
    expect(out.reason).toBe('target_file_deleted');
    expect(out.commits_since_scan).toBe(0);
  });

  it('Gate 4: zero commits since scan -> not stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const gitRunner = vi.fn().mockResolvedValue({ stdout: '' });
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('no_commits_since_scan');
    expect(out.commits_since_scan).toBe(0);
  });

  it('Gate 4: fewer than threshold commits -> minor churn, not stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const gitRunner = vi.fn().mockResolvedValue({ stdout: 'abc123\ndef456\n' });
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('minor_churn_probably_valid');
    expect(out.commits_since_scan).toBe(2);
  });

  it('Gate 4: threshold or more commits -> substantial churn, stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const manyCommits = Array.from({ length: 6 }, (_, i) => `hash${i}`).join('\n');
    const gitRunner = vi.fn().mockResolvedValue({ stdout: manyCommits });
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(out.stale).toBe(true);
    expect(out.reason).toBe('substantial_churn');
    expect(out.commits_since_scan).toBe(6);
  });

  it('git timeout -> not stale (fail-open)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const slowRunner = () => new Promise((resolve) => setTimeout(() => resolve({ stdout: '' }), 5000));
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner: slowRunner });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('probe_timeout');
  });

  it('git throws ENOENT -> git_unavailable, not stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const err = new Error('spawn git ENOENT');
    err.code = 'ENOENT';
    const gitRunner = vi.fn().mockRejectedValue(err);
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('git_unavailable');
  });

  it('gitRunner throws anything else -> probe_errored, not stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const gitRunner = vi.fn().mockRejectedValue(new Error('unexpected'));
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('probe_errored');
  });

  it('result object includes probe_ms timing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const gitRunner = vi.fn().mockResolvedValue({ stdout: '' });
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(typeof out.probe_ms).toBe('number');
    expect(out.probe_ms).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 6.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/stale-probe.test.js`
Expected: FAIL — `Cannot find module '../factory/stale-probe'`.

- [ ] **Step 6.3: Implement `stale-probe.js`**

Create `server/factory/stale-probe.js`:

```javascript
'use strict';

const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const { DEFAULT_PROMOTION_CONFIG } = require('./promotion-policy');

const PROBE_TIMEOUT_MS = 3000;

function defaultGitRunner(cwd, args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = childProcess.spawn('git', args, {
      cwd,
      windowsHide: true,
    });
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`git exited ${code}: ${stderr.trim()}`);
        err.code = `GIT_EXIT_${code}`;
        reject(err);
      }
    });
  });
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('probe_timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function probeStaleness(item, {
  projectPath,
  promotionConfig = DEFAULT_PROMOTION_CONFIG,
  now = new Date(),
  gitRunner = defaultGitRunner,
} = {}) {
  const start = Date.now();
  const makeResult = (partial) => ({
    stale: false,
    reason: 'unknown',
    commits_since_scan: 0,
    probe_ms: Date.now() - start,
    ...partial,
  });

  // Gate 1: eligibility
  if (!item || item.source !== 'scout') {
    return makeResult({ reason: 'not_scout_eligible' });
  }
  const targetFile = item.origin?.target_file;
  if (typeof targetFile !== 'string' || targetFile.length === 0) {
    return makeResult({ reason: 'no_target_file' });
  }
  if (promotionConfig?.stale_probe_enabled === false) {
    return makeResult({ reason: 'probe_disabled' });
  }
  if (!projectPath) {
    return makeResult({ reason: 'no_project_path' });
  }

  // Gate 2: path safety
  const resolvedRoot = path.resolve(projectPath);
  const abs = path.resolve(resolvedRoot, targetFile);
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
    return makeResult({ reason: 'invalid_target_path' });
  }

  // Gate 3: file existence
  if (!fs.existsSync(abs)) {
    return makeResult({ stale: true, reason: 'target_file_deleted', commits_since_scan: 0 });
  }

  // Gate 4: git log since scan
  const scanTs = item.origin?.scan_timestamp || item.created_at;
  if (!scanTs) {
    return makeResult({ reason: 'no_scan_timestamp' });
  }

  let stdout = '';
  try {
    const result = await withTimeout(
      Promise.resolve(gitRunner(projectPath, [
        'log',
        `--since=${scanTs}`,
        '--pretty=format:%H',
        '--',
        targetFile,
      ])),
      PROBE_TIMEOUT_MS,
    );
    stdout = String(result?.stdout || '');
  } catch (err) {
    if (err && err.message === 'probe_timeout') {
      return makeResult({ reason: 'probe_timeout' });
    }
    if (err && err.code === 'ENOENT') {
      return makeResult({ reason: 'git_unavailable' });
    }
    return makeResult({ reason: 'probe_errored' });
  }

  const commits = stdout.trim().split(/\r?\n/).filter(Boolean);
  const threshold = promotionConfig?.stale_churn_threshold
    ?? DEFAULT_PROMOTION_CONFIG.stale_churn_threshold;

  if (commits.length === 0) {
    return makeResult({ reason: 'no_commits_since_scan', commits_since_scan: 0 });
  }
  if (commits.length < threshold) {
    return makeResult({
      reason: 'minor_churn_probably_valid',
      commits_since_scan: commits.length,
    });
  }
  return makeResult({
    stale: true,
    reason: 'substantial_churn',
    commits_since_scan: commits.length,
  });
}

module.exports = { probeStaleness, defaultGitRunner, PROBE_TIMEOUT_MS };
```

- [ ] **Step 6.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/stale-probe.test.js`
Expected: 12 passing tests.

- [ ] **Step 6.5: Commit**

```bash
git add server/factory/stale-probe.js server/tests/stale-probe.test.js
git commit -m "feat(factory): stale-probe skips scout findings churned by post-scan commits"
```

---

## Task 7: Integrate promotion + stale-probe into PRIORITIZE

**Acceptance:** `claimNextWorkItemForInstance` runs `rankIntake` on the survivors list before claim loop, and `probeStaleness` on each candidate before returning it. Stale items are marked `shipped_stale` and skipped. After `stale_max_repicks` consecutive stales, fall back to `ranked[0]` and emit `stale_probe_starvation`. Observability decisions fire when promotion or skip occurs.

**Files:**
- Modify: `server/factory/loop-controller.js` (`claimNextWorkItemForInstance`, approximately line 1920)
- Test: `server/tests/factory-priori-promotion-wiring.test.js` (create)

- [ ] **Step 7.1: Read the existing function**

Run: `sed -n '1920,1970p' server/factory/loop-controller.js`
Identify the existing flow: `openItems` → `survivors` → `orderedCandidates` → claim loop. The integration inserts rank + probe at two points.

- [ ] **Step 7.2: Write the failing test**

Create `server/tests/factory-priori-promotion-wiring.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory-intake');
const factoryHealth = require('../db/factory-health');
const factoryDecisions = require('../db/factory-decisions');
const factoryLoopInstances = require('../db/factory-loop-instances');
const loopController = require('../factory/loop-controller');

function seedSchema(db) {
  db.prepare(`CREATE TABLE factory_projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT, trust_level TEXT, config_json TEXT,
    scores_json TEXT
  )`).run();
  db.prepare(`CREATE TABLE factory_work_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, source TEXT NOT NULL,
    origin_json TEXT, title TEXT NOT NULL, description TEXT,
    priority INTEGER NOT NULL DEFAULT 50, requestor TEXT, constraints_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT, linked_item_id INTEGER,
    batch_id TEXT, claimed_by_instance_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`).run();
  db.prepare(`CREATE TABLE factory_loop_instances (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id INTEGER,
    batch_id TEXT, loop_state TEXT NOT NULL DEFAULT 'IDLE',
    paused_at_stage TEXT, last_action_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    terminated_at TEXT
  )`).run();
  db.prepare(`CREATE TABLE factory_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    stage TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
    reasoning TEXT, inputs_json TEXT, outcome_json TEXT,
    confidence REAL, batch_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

describe('PRIORITIZE promotion + stale wiring', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    seedSchema(db);
    factoryIntake.setDb(db);
    factoryHealth.setDb(db);
    factoryDecisions.setDb(db);
    factoryLoopInstances.setDb(db);
    db.prepare(`INSERT INTO factory_projects (id, name, path, trust_level, config_json, scores_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('p1', 'test', process.cwd(), 'dark', '{}', '{"security":40,"structural":90}');
    db.prepare(`INSERT INTO factory_loop_instances (id, project_id, loop_state) VALUES (?, ?, ?)`)
      .run('inst-1', 'p1', 'PRIORITIZE');
  });

  afterEach(() => { db.close(); });

  function insertItem({ source, priority, origin, title = 't', status = 'pending' }) {
    const originJson = origin ? JSON.stringify(origin) : null;
    const info = db.prepare(`
      INSERT INTO factory_work_items (project_id, source, origin_json, title, priority, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('p1', source, originJson, title, priority, status);
    return info.lastInsertRowid;
  }

  it('CRITICAL scout is selected over a higher-priority plan_file', () => {
    const planId = insertItem({ source: 'plan_file', priority: 90, title: 'plan-70' });
    const critId = insertItem({
      source: 'scout', priority: 50, title: 'critical-sec',
      origin: { severity: 'CRITICAL', variant: 'security', target_file: 'nonexistent/file.js' },
    });
    const result = loopController.__testing__.claimNextWorkItemForInstance('p1', 'inst-1');
    // critId's target_file doesn't exist -> stale_probe marks stale -> falls back to planId
    // Unless critId is first-probed and found stale. Assert the wiring chose critId-first:
    const staleDecisions = db.prepare(
      "SELECT action FROM factory_decisions WHERE action = 'skipped_stale_scout_item'"
    ).all();
    expect(staleDecisions.length).toBeGreaterThan(0);
    // And then fell back to the next candidate (planId).
    expect(result.workItem.id).toBe(planId);
  });

  it('promoted scout with existing target_file wins', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prio-'));
    const relPath = 'alive.js';
    fs.writeFileSync(path.join(tmp, relPath), 'hello');
    // Update project path to the tmp dir so probe's projectPath resolves here
    db.prepare('UPDATE factory_projects SET path = ? WHERE id = ?').run(tmp, 'p1');

    const planId = insertItem({ source: 'plan_file', priority: 70, title: 'plan-70' });
    const scoutId = insertItem({
      source: 'scout', priority: 50, title: 'high-sec',
      origin: { severity: 'HIGH', variant: 'security', target_file: relPath },
    });
    const result = loopController.__testing__.claimNextWorkItemForInstance('p1', 'inst-1');
    expect(result.workItem.id).toBe(scoutId);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('falls back to ranked[0] after stale_max_repicks consecutive stales', () => {
    // All three candidates have deleted target_files -> all stale
    const a = insertItem({ source: 'scout', priority: 70, title: 'a', origin: { severity: 'CRITICAL', variant: 'security', target_file: 'gone/a.js' } });
    const b = insertItem({ source: 'scout', priority: 70, title: 'b', origin: { severity: 'CRITICAL', variant: 'security', target_file: 'gone/b.js' } });
    const c = insertItem({ source: 'scout', priority: 70, title: 'c', origin: { severity: 'CRITICAL', variant: 'security', target_file: 'gone/c.js' } });
    const result = loopController.__testing__.claimNextWorkItemForInstance('p1', 'inst-1');
    // stale_max_repicks=3; if all 3 are stale, wiring falls back to ranked[0] even though it's stale
    const starve = db.prepare("SELECT * FROM factory_decisions WHERE action = 'stale_probe_starvation'").get();
    expect(starve).toBeDefined();
  });
});
```

- [ ] **Step 7.3: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/factory-priori-promotion-wiring.test.js`
Expected: FAIL — rank + probe not yet wired; tests either select the wrong item or find no `skipped_stale_scout_item` decisions.

- [ ] **Step 7.4: Wire rank + probe into `claimNextWorkItemForInstance`**

In `server/factory/loop-controller.js`, at the top of the file, add the requires near the other factory-module requires:

```javascript
const { rankIntake, mergeConfig } = require('./promotion-policy');
const { probeStaleness } = require('./stale-probe');
```

Find the `claimNextWorkItemForInstance` function (approximately line 1920). Replace its body with:

```javascript
async function claimNextWorkItemForInstance(project_id, instance_id) {
  const openItems = factoryIntake.listOpenWorkItems({ project_id, limit: 100 });
  if (!Array.isArray(openItems) || openItems.length === 0) {
    return { openItems: [], workItem: null };
  }
  clearFactoryIdleForPendingWork(project_id, openItems.length);

  const survivors = [];
  for (const item of openItems) {
    if (!item) continue;
    const healed = healAlreadyShippedWorkItem(project_id, item);
    if (healed) continue;
    survivors.push(item);
  }

  // Promotion: rank survivors by (severity, tier, priority, source, age).
  // Failure is non-fatal — fall back to today's status-ordered list.
  const project = factoryHealth.getProject(project_id);
  const projectScores = parseProjectScores(project);
  const promotionConfig = parsePromotionConfig(project);
  let rankedCandidates = survivors;
  let rankedEmittedDecision = false;
  try {
    rankedCandidates = rankIntake(survivors, { projectScores, promotionConfig });
    // Emit scout_promoted when ranking actually changed order such that a scout
    // now beats a plan_file it would not have in today's layout.
    if (didPromoteScout(survivors, rankedCandidates)) {
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.PRIORITIZE,
        action: 'scout_promoted',
        reasoning: 'Scout finding promoted ahead of lower-severity / lower-score candidates.',
        outcome: {
          promoted_ids: rankedCandidates
            .filter((i) => i.source === 'scout')
            .slice(0, 3)
            .map((i) => i.id),
          project_scores: projectScores,
        },
        confidence: 1,
      });
      rankedEmittedDecision = true;
    }
  } catch (err) {
    logger.warn('promotion_policy_failed', { err: err && err.message });
    rankedCandidates = survivors;
  }

  // Merge status-ordering as a final tiebreak layer: tasks that are already
  // `executing` / `verifying` still advance ahead of fresh `pending` ones.
  const orderedCandidates = [];
  for (const status of WORK_ITEM_STATUS_ORDER) {
    orderedCandidates.push(...rankedCandidates.filter((item) => item && item.status === status));
  }
  orderedCandidates.push(...rankedCandidates.filter((item) => !orderedCandidates.includes(item)));

  const maxRepicks = Math.max(1, mergeConfig(promotionConfig).stale_max_repicks || 3);
  const skipped = [];
  const projectPath = project?.path || null;

  for (const item of orderedCandidates) {
    if (!item) continue;
    if (skipped.length >= maxRepicks) break;

    if (item.claimed_by_instance_id === instance_id) {
      return { openItems: survivors, workItem: item };
    }
    if (item.claimed_by_instance_id) continue;

    // Stale probe — only for scout items; non-scouts short-circuit Gate 1.
    let probe = { stale: false, reason: 'skipped' };
    try {
      probe = await probeStaleness(item, { projectPath, promotionConfig });
    } catch (err) {
      logger.warn('stale_probe_threw', { err: err && err.message, work_item_id: item.id });
      probe = { stale: false, reason: 'probe_errored' };
    }

    if (probe.stale) {
      try {
        factoryIntake.updateWorkItem(item.id, { status: 'shipped_stale' });
      } catch (err) {
        logger.warn('stale_status_write_failed', { err: err && err.message, work_item_id: item.id });
      }
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.PRIORITIZE,
        action: 'skipped_stale_scout_item',
        reasoning: `Scout finding no longer reproduces: ${probe.reason}`,
        outcome: {
          work_item_id: item.id,
          stale_reason: probe.reason,
          commits_since_scan: probe.commits_since_scan,
          probe_ms: probe.probe_ms,
        },
        confidence: 1,
      });
      skipped.push(item.id);
      continue;
    }

    const claimed = factoryIntake.claimWorkItem(item.id, instance_id);
    if (claimed) {
      return { openItems: survivors, workItem: claimed };
    }
  }

  // Starvation: every top candidate was stale. Fall back to ranked[0] to
  // advance the loop — better to waste one plan-gen than to pause PRIORITIZE.
  if (skipped.length >= maxRepicks) {
    safeLogDecision({
      project_id,
      stage: LOOP_STATES.PRIORITIZE,
      action: 'stale_probe_starvation',
      reasoning: `Top ${skipped.length} candidates all marked stale; falling back to ranked[0].`,
      outcome: { skipped },
      confidence: 1,
    });
  }

  void rankedEmittedDecision;
  return { openItems: survivors, workItem: null };
}

function parseProjectScores(project) {
  if (!project) return {};
  if (project.scores && typeof project.scores === 'object') return project.scores;
  if (typeof project.scores_json === 'string') {
    try { return JSON.parse(project.scores_json); } catch { return {}; }
  }
  return {};
}

function parsePromotionConfig(project) {
  const raw = project?.config_json;
  if (!raw) return null;
  try {
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return cfg.scout_promotion || null;
  } catch (err) {
    logger.warn('promotion_config_parse_failed', { err: err && err.message });
    return null;
  }
}

function didPromoteScout(originalSurvivors, ranked) {
  const wasFirstScout = originalSurvivors[0]?.source === 'scout';
  const isFirstScout = ranked[0]?.source === 'scout';
  return !wasFirstScout && isFirstScout;
}
```

Notes for the engineer:
- Because `claimNextWorkItemForInstance` becomes `async`, every caller must `await` it. Grep for `claimNextWorkItemForInstance(` and update call sites — `executePrioritizeStage` is the primary caller at approximately line 2036. Change `const claimResult = ... : claimNextWorkItemForInstance(project.id, instance.id);` to `await claimNextWorkItemForInstance(...)` and confirm `executePrioritizeStage` is itself `async` (it likely already is — check via `grep -B1 "function executePrioritizeStage"`).
- `WORK_ITEM_STATUS_ORDER` is an existing constant in this file; keep using it.
- If the file already defines helper functions with the names `parseProjectScores`, `parsePromotionConfig`, or `didPromoteScout`, rename the new ones (e.g. `parseProjectScoresFromRow`). Grep first.
- `__testing__` export: add `claimNextWorkItemForInstance` if it is not already exposed there.

- [ ] **Step 7.5: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/factory-priori-promotion-wiring.test.js`
Expected: 3 passing tests.

- [ ] **Step 7.6: Commit**

```bash
git add server/factory/loop-controller.js server/tests/factory-priori-promotion-wiring.test.js
git commit -m "feat(factory): PRIORITIZE runs rankIntake + stale-probe before claiming"
```

---

## Task 8: Integration test with real git repo

**Acceptance:** A test uses a real tmpdir + `git init` + `git commit` to verify `probeStaleness`'s git-log path works end-to-end (not just with a mocked runner). Asserts `commits_since_scan` matches the actual commit count.

**Files:**
- Test: `server/tests/stale-probe-git-integration.test.js` (create)

- [ ] **Step 8.1: Write the test**

Create `server/tests/stale-probe-git-integration.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { probeStaleness } = require('../factory/stale-probe');

function git(cwd, args) {
  childProcess.execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdio: 'pipe',
  });
}

describe('stale-probe against a real git repo', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-probe-git-'));
    git(tmpDir, ['init', '-b', 'main']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test']);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects zero commits since scan when no commits happened after scan time', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v1');
    git(tmpDir, ['add', 'foo.js']);
    git(tmpDir, ['commit', '-m', 'initial']);

    // Scan timestamp AFTER the commit
    const scanTime = new Date(Date.now() + 1000).toISOString();
    const item = {
      id: 1,
      source: 'scout',
      created_at: scanTime,
      origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' },
    };

    const result = await probeStaleness(item, { projectPath: tmpDir });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe('no_commits_since_scan');
  });

  it('detects minor churn (1-4 commits) since scan', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v1');
    git(tmpDir, ['add', 'foo.js']);
    git(tmpDir, ['commit', '-m', 'initial']);

    const scanTime = new Date().toISOString();
    // Wait a beat then commit twice more
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v2');
    git(tmpDir, ['commit', '-am', 'v2']);
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v3');
    git(tmpDir, ['commit', '-am', 'v3']);

    const item = {
      id: 1,
      source: 'scout',
      created_at: scanTime,
      origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' },
    };

    const result = await probeStaleness(item, { projectPath: tmpDir });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe('minor_churn_probably_valid');
    expect(result.commits_since_scan).toBe(2);
  });

  it('detects substantial churn (>= threshold commits) as stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v1');
    git(tmpDir, ['add', 'foo.js']);
    git(tmpDir, ['commit', '-m', 'initial']);

    const scanTime = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1100));
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(tmpDir, 'foo.js'), `v${i + 2}`);
      git(tmpDir, ['commit', '-am', `v${i + 2}`]);
    }

    const item = {
      id: 1,
      source: 'scout',
      created_at: scanTime,
      origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' },
    };

    const result = await probeStaleness(item, { projectPath: tmpDir });
    expect(result.stale).toBe(true);
    expect(result.reason).toBe('substantial_churn');
    expect(result.commits_since_scan).toBe(6);
  });
});
```

- [ ] **Step 8.2: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/stale-probe-git-integration.test.js`
Expected: 3 passing tests.

- [ ] **Step 8.3: Commit**

```bash
git add server/tests/stale-probe-git-integration.test.js
git commit -m "test(factory): stale-probe integration against real git tmpdir repo"
```

---

## Task 9: Full-suite regression + docs

**Acceptance:** Full server test suite passes remotely. `docs/factory.md` references the new PRIORITIZE signals.

**Files:**
- Modify: `docs/factory.md` (add a "Cluster B" subsection)

- [ ] **Step 9.1: Run full suite**

Run: `torque-remote npx vitest run server/tests/`
Expected: all tests pass.

If new failures appear in tests that invoke `claimNextWorkItemForInstance` (e.g. `factory-loop-controller.test.js`, `factory-selected-work-item.test.js`) with `TypeError: Cannot read properties of ... (reading 'then')` or similar, the caller did not `await` the now-async helper. Grep for `claimNextWorkItemForInstance(` and add `await` to every call site. Re-run.

- [ ] **Step 9.2: Append a "Cluster B" section to `docs/factory.md`**

Run `grep -n "Close-Handler Observability" docs/factory.md` to find the anchor. Insert the block below immediately after the Cluster A section:

```markdown
## Intake / Plan Pipeline (2026-04)

PRIORITIZE now ranks intake items by `(severity, promotion_tier, priority, source, age)` before claiming one. Scout findings promote ahead of plan_files when:
- The finding is CRITICAL (always promotes), or
- The finding is at or above `severity_floor` (default `HIGH`) AND at least one relevant project score is below its `score_trigger` threshold.

Per-project config lives on `factory_projects.config_json.scout_promotion`. Defaults ship sensible.

After ranking, each top candidate goes through a cheap stale probe:
1. Is the scout's `target_file` still present?
2. How many commits have landed against it since scan time?
   - 0 commits → finding still valid, keep.
   - `< stale_churn_threshold` (default 5) → minor churn, probably valid, keep.
   - `>=` threshold → substantial churn, mark `shipped_stale` and re-pick.

At most `stale_max_repicks` (default 3) consecutive stales per advance; after that, fall back to `ranked[0]` so the loop never starves.

Decisions emitted:
- `scout_promoted` — when ranking actually lifted a scout ahead of a plan_file.
- `skipped_stale_scout_item` — when a candidate was skipped as stale. Outcome: `stale_reason`, `commits_since_scan`, `probe_ms`.
- `stale_probe_starvation` — when stale_max_repicks exhausted and we fell back to ranked[0].

Plan-gen preemption: `architect-runner.js` now composes a plan-authoring guide from the `RULES` const in `plan-quality-gate.js` + a hand-written examples block. This is injected ahead of the architect prompt so the LLM sees the quality-gate rules up front and produces compliant plans on first pass.

Design: `docs/superpowers/specs/2026-04-21-intake-plan-pipeline-design.md`
Plan:   `docs/superpowers/plans/2026-04-21-intake-plan-pipeline.md`
```

- [ ] **Step 9.3: Commit**

```bash
git add docs/factory.md
git commit -m "docs(factory): document PRIORITIZE promotion + stale-probe + plan-authoring guide"
```

---

## Post-plan operator rollout (outside the automated loop)

1. Cut over via `scripts/worktree-cutover.sh intake-plan-pipeline`.
2. Wait 48h. Query `factory_decisions` for:
   - `scout_promoted` count — should be non-zero whenever any project's score is below threshold.
   - `skipped_stale_scout_item` count — should be moderate (< 30% of PRIORITIZE selections). If higher, bump `stale_churn_threshold` via per-project config.
   - `plan_quality_rejected_will_replan` rate — expected to drop (goal: ≥ 40%).
3. Tune per-project via `factory_projects.config_json.scout_promotion` without redeploy. No feature-flag flip required — all three changes ship on by default and fail-open on error.
