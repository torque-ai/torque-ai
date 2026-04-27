# Codex Fallback for EXECUTE — Phase 2 Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire EXECUTE-stage failover so the factory actually routes to free providers when Codex is down. Phase 1 added the breaker + park state + operator surface but `auto`-policy projects still error on EXECUTE because nothing routes around Codex. Phase 2 closes that gap: a free-eligibility classifier filters work that's small/simple enough for free providers, a "Codex-Down Failover" routing template auto-activates when the breaker is tripped, and the completion pipeline calls `recordFailureByCode` so the breaker auto-trips on Codex error codes (no more manual-only operation).

**Architecture:** Builds on Phase 1's `circuitBreaker` + `decideCodexFallbackAction`. New module `server/routing/eligibility-classifier.js` is a pure function. Failover template lives as a JSON file in `server/routing/templates/` next to the existing presets. Auto-activation hooks into `template-store.js` so a tripped breaker overrides the active template. EXECUTE-stage chain walking extends the existing routing resolver — providers in the template's category chain are tried in order, with backoff and re-queue on chain exhaustion.

**Tech Stack:** Node.js + better-sqlite3; vitest; `torque-remote` for tests.

**Phase scope:** Components B (Free-Eligibility Classifier) + D (Failover routing template + chain walker) from `docs/superpowers/specs/2026-04-26-codex-fallback-execute-design.md`, plus the auto-trip wiring that Phase 1 plumbed but never connected. Phase 3 (auto-augmenter + decompose-on-park) is OUT.

**Prerequisites:**
- Worktree: `.worktrees/feat-codex-fallback-phase2` (created on branch `feat/codex-fallback-phase2`).
- Phase 1 already shipped on main (merge `24930d16`); rebase if main moves further.

---

## File Map

**Created:**
- `server/routing/eligibility-classifier.js` — pure function `classify(workItem, plan, projectConfig)`.
- `server/routing/templates/codex-down-failover.json` — DB seed for the new preset.
- `server/routing/failover-activator.js` — small module that swaps the active template when `circuit:tripped` fires for codex (and restores prior on `circuit:recovered`).
- `server/factory/canary-scheduler.js` — schedules read-only Codex canary tasks at 5-min cadence while breaker is tripped; cancels on `circuit:recovered`.
- New tests: `eligibility-classifier.test.js`, `failover-activator.test.js`, `canary-scheduler.test.js`, `phase2-integration-smoke.test.js`.

**Modified:**
- `server/execution/completion-pipeline.js` — when `task.provider === 'codex'`, call `recordFailureByCode({ errorCode, exitCode })` in addition to (or instead of) `recordFailure(provider, errorOutput)` so the new auto-trip path is exercised.
- `server/factory/loop-controller.js` — `proceed_with_fallback` decision actually routes EXECUTE through the failover chain (previously a no-op fallthrough). Insert after the existing `decideCodexFallbackAction` call site at lines 5003-5074.
- `server/routing/template-store.js` — `getActiveTemplate()` returns the codex-down-failover template when `circuitBreaker.allowRequest('codex') === false`, ignoring user-pinned templates UNLESS the user pinned an explicit override (existing precedence preserved otherwise).
- `server/container.js` — register `failoverActivator` and `canaryScheduler`; eager-init both at startup.
- `server/db/smart-routing.js` — chain-walker extension: when the active template is codex-down-failover, walk the per-category chain trying providers in order, falling through on per-attempt failure; on chain exhaustion increment a counter and re-queue with 10-min backoff; on 3rd exhaustion park with `parked_chain_exhausted` (status added in Phase 1).

---

## Conventions
- Tests live under `server/tests/` matching Phase 1 patterns. `db.prepare(...).run()` for fixtures. Logger stub `{debug,info,warn,error}`.
- Commit messages: `feat(codex-fallback-2):`, `fix(codex-fallback-2):`, `test(codex-fallback-2):` etc. The `-2` distinguishes Phase 2 commits from Phase 1's `feat(codex-fallback):` history.
- All commits land on `feat/codex-fallback-phase2`.
- Tests run via `torque-remote npx vitest run <path>`. Push branch first if torque-remote `--branch` is needed.

---

## Task 1: Free-Eligibility Classifier

**Files:**
- Create: `server/routing/eligibility-classifier.js`
- Create: `server/tests/eligibility-classifier.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
'use strict';
/* global describe, it, expect */

const { classify } = require('../routing/eligibility-classifier');

describe('classify (free-eligibility)', () => {
  it('returns codex_only for architectural category', () => {
    const result = classify({ category: 'architectural' }, {}, {});
    expect(result.eligibility).toBe('codex_only');
    expect(result.reason).toMatch(/architectural/);
  });

  it.each(['large_code_gen', 'xaml_wpf', 'security', 'reasoning'])('returns codex_only for %s', (cat) => {
    const result = classify({ category: cat }, {}, {});
    expect(result.eligibility).toBe('codex_only');
  });

  it.each(['simple_generation', 'targeted_file_edit', 'documentation', 'default'])(
    '%s within size cap returns free',
    (cat) => {
      const plan = { tasks: [{ files_touched: ['a.js'], estimated_lines: 50 }] };
      const result = classify({ category: cat }, plan, {});
      expect(result.eligibility).toBe('free');
    }
  );

  it('size cap exceeded (files > 3) returns codex_only', () => {
    const plan = {
      tasks: [
        { files_touched: ['a.js', 'b.js'], estimated_lines: 30 },
        { files_touched: ['c.js', 'd.js'], estimated_lines: 30 },
      ],
    };
    const result = classify({ category: 'simple_generation' }, plan, {});
    expect(result.eligibility).toBe('codex_only');
    expect(result.reason).toMatch(/files=4/);
  });

  it('size cap exceeded (lines > 200) returns codex_only', () => {
    const plan = { tasks: [{ files_touched: ['a.js'], estimated_lines: 250 }] };
    const result = classify({ category: 'simple_generation' }, plan, {});
    expect(result.eligibility).toBe('codex_only');
    expect(result.reason).toMatch(/lines=250/);
  });

  it('project policy=wait_for_codex always returns codex_only', () => {
    const plan = { tasks: [{ files_touched: ['a.js'], estimated_lines: 50 }] };
    const result = classify(
      { category: 'simple_generation' },
      plan,
      { codex_fallback_policy: 'wait_for_codex' }
    );
    expect(result.eligibility).toBe('codex_only');
    expect(result.reason).toMatch(/wait_for_codex/);
  });

  it('falls back to structural estimate when plan tasks are missing fields', () => {
    const plan = { tasks: [] };
    const result = classify({ category: 'simple_generation' }, plan, {});
    // empty plan → 0 files, 0 lines → free-eligible
    expect(result.eligibility).toBe('free');
  });
});
```

- [ ] **Step 2: Run, expect FAIL — module not found.**

`torque-remote npx vitest run server/tests/eligibility-classifier.test.js`

- [ ] **Step 3: Implement**

Create `server/routing/eligibility-classifier.js`:

```javascript
'use strict';

const CODEX_ONLY_CATEGORIES = new Set([
  'architectural',
  'large_code_gen',
  'xaml_wpf',
  'security',
  'reasoning',
]);

const FREE_ELIGIBLE_CATEGORIES = new Set([
  'simple_generation',
  'targeted_file_edit',
  'documentation',
  'default',
]);

const SIZE_CAP_FILES = 3;
const SIZE_CAP_LINES = 200;

function estimateSize(plan) {
  if (!plan || !Array.isArray(plan.tasks)) return { files: 0, lines: 0 };
  const fileSet = new Set();
  let lines = 0;
  for (const task of plan.tasks) {
    if (Array.isArray(task.files_touched)) {
      for (const f of task.files_touched) fileSet.add(f);
    }
    if (Number.isFinite(task.estimated_lines)) lines += task.estimated_lines;
  }
  return { files: fileSet.size, lines };
}

function classify(workItem, plan, projectConfig = {}) {
  const policy = projectConfig.codex_fallback_policy;
  if (policy === 'wait_for_codex') {
    return { eligibility: 'codex_only', reason: 'project_policy:wait_for_codex' };
  }

  const category = workItem?.category || 'default';

  if (CODEX_ONLY_CATEGORIES.has(category)) {
    return { eligibility: 'codex_only', reason: `category_codex_only:${category}` };
  }

  if (!FREE_ELIGIBLE_CATEGORIES.has(category)) {
    // Unknown category — treat as codex_only conservatively.
    return { eligibility: 'codex_only', reason: `category_unknown:${category}` };
  }

  const { files, lines } = estimateSize(plan);
  if (files > SIZE_CAP_FILES) {
    return { eligibility: 'codex_only', reason: `size_cap_exceeded:files=${files}` };
  }
  if (lines > SIZE_CAP_LINES) {
    return { eligibility: 'codex_only', reason: `size_cap_exceeded:lines=${lines}` };
  }

  return { eligibility: 'free', reason: `size_within_cap:files=${files},lines=${lines}` };
}

module.exports = {
  classify,
  CODEX_ONLY_CATEGORIES,
  FREE_ELIGIBLE_CATEGORIES,
  SIZE_CAP_FILES,
  SIZE_CAP_LINES,
};
```

- [ ] **Step 4: PASS** — 9+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/routing/eligibility-classifier.js server/tests/eligibility-classifier.test.js
git commit -m "feat(codex-fallback-2): add free-eligibility classifier"
```

---

## Task 2: Codex-Down Failover routing template

**Files:**
- Create: `server/routing/templates/codex-down-failover.json`
- Modify: `server/routing/template-store.js` (if templates are loaded explicitly by name) — verify auto-discovery picks up the new file.

- [ ] **Step 1: Write the test**

Create `server/tests/codex-down-failover-template.test.js`:

```javascript
'use strict';
/* global describe, it, expect */

const fs = require('fs');
const path = require('path');

describe('codex-down-failover template', () => {
  const templatePath = path.join(__dirname, '..', 'routing', 'templates', 'codex-down-failover.json');

  it('exists and is valid JSON', () => {
    const raw = fs.readFileSync(templatePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe('Codex-Down Failover');
    expect(parsed.rules).toBeDefined();
  });

  it('has chains for free-eligible categories', () => {
    const tmpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    expect(tmpl.rules.simple_generation).toBeDefined();
    expect(tmpl.rules.targeted_file_edit).toBeDefined();
    expect(tmpl.rules.documentation).toBeDefined();
    expect(tmpl.rules.default).toBeDefined();
  });

  it('does NOT have chains for codex_only categories', () => {
    const tmpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    expect(tmpl.rules.architectural).toBeUndefined();
    expect(tmpl.rules.large_code_gen).toBeUndefined();
    expect(tmpl.rules.xaml_wpf).toBeUndefined();
    expect(tmpl.rules.security).toBeUndefined();
    expect(tmpl.rules.reasoning).toBeUndefined();
  });

  it('chains never contain codex provider', () => {
    const tmpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    for (const [cat, chain] of Object.entries(tmpl.rules)) {
      for (const link of chain) {
        expect(link.provider).not.toBe('codex');
        expect(link.provider).not.toBe('codex-spark');
      }
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Create the template**

Create `server/routing/templates/codex-down-failover.json`:

```json
{
  "name": "Codex-Down Failover",
  "description": "Auto-activates when the Codex circuit breaker is tripped. Routes free-eligible work through the free-provider chain by category. Codex-only categories deliberately have no chain — those items park.",
  "rules": {
    "simple_generation": [
      {"provider": "groq", "model": "openai/gpt-oss-120b"},
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "ollama"}
    ],
    "targeted_file_edit": [
      {"provider": "groq", "model": "openai/gpt-oss-120b"},
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "ollama"}
    ],
    "documentation": [
      {"provider": "groq", "model": "openai/gpt-oss-120b"},
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "google-ai", "model": "gemini-2.5-flash"}
    ],
    "default": [
      {"provider": "groq", "model": "openai/gpt-oss-120b"},
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "google-ai", "model": "gemini-2.5-flash"}
    ],
    "tests": [
      {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"},
      {"provider": "google-ai", "model": "gemini-2.5-flash"},
      {"provider": "ollama-cloud", "model": "kimi-k2:1t"}
    ]
  }
}
```

- [ ] **Step 4: PASS — 4 tests.**

- [ ] **Step 5: Commit**

```bash
git add server/routing/templates/codex-down-failover.json server/tests/codex-down-failover-template.test.js
git commit -m "feat(codex-fallback-2): add Codex-Down Failover routing template"
```

---

## Task 3: Failover activator (auto-swap active template on trip/recover)

**Files:**
- Create: `server/routing/failover-activator.js`
- Create: `server/tests/failover-activator.test.js`

- [ ] **Step 1: Write the test**

```javascript
'use strict';
/* global describe, it, expect, beforeEach, vi */

const { createFailoverActivator } = require('../routing/failover-activator');

function makeEventBus() {
  const subs = new Map();
  return {
    on(e, fn) { (subs.get(e) || subs.set(e, []).get(e)).push(fn); },
    emit(e, p) { (subs.get(e) || []).forEach(fn => fn(p)); },
  };
}

describe('failover-activator', () => {
  let store, eventBus, logger;

  beforeEach(() => {
    store = {
      getActiveName: vi.fn(() => 'system-default'),
      setActive: vi.fn(),
    };
    eventBus = makeEventBus();
    logger = { info: vi.fn(), warn: vi.fn() };
  });

  it('on circuit:tripped for codex, swaps to codex-down-failover and remembers prior', () => {
    createFailoverActivator({ store, eventBus, logger });
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    expect(store.setActive).toHaveBeenCalledWith('codex-down-failover');
  });

  it('ignores trips for non-codex providers', () => {
    createFailoverActivator({ store, eventBus, logger });
    eventBus.emit('circuit:tripped', { provider: 'groq' });
    expect(store.setActive).not.toHaveBeenCalled();
  });

  it('on circuit:recovered for codex, restores the prior template', () => {
    createFailoverActivator({ store, eventBus, logger });
    store.getActiveName.mockReturnValueOnce('quality-first'); // active before trip
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    eventBus.emit('circuit:recovered', { provider: 'codex' });
    expect(store.setActive).toHaveBeenLastCalledWith('quality-first');
  });

  it('does not swap if already on codex-down-failover (e.g. duplicate trip)', () => {
    createFailoverActivator({ store, eventBus, logger });
    store.getActiveName.mockReturnValue('codex-down-failover');
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    expect(store.setActive).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```javascript
'use strict';

const FAILOVER_TEMPLATE = 'codex-down-failover';

function createFailoverActivator({ store, eventBus, logger }) {
  if (!store) throw new Error('createFailoverActivator requires store');
  if (!eventBus) throw new Error('createFailoverActivator requires eventBus');
  const log = logger || { info() {}, warn() {} };
  let priorTemplate = null;

  eventBus.on('circuit:tripped', (payload) => {
    if (!payload || payload.provider !== 'codex') return;
    try {
      const current = store.getActiveName();
      if (current === FAILOVER_TEMPLATE) return; // already active
      priorTemplate = current;
      store.setActive(FAILOVER_TEMPLATE);
      log.info('[codex-fallback-2] activated codex-down-failover', { prior: priorTemplate });
    } catch (err) {
      log.warn('[codex-fallback-2] failover activation failed', { error: err.message });
    }
  });

  eventBus.on('circuit:recovered', (payload) => {
    if (!payload || payload.provider !== 'codex') return;
    try {
      if (priorTemplate) {
        store.setActive(priorTemplate);
        log.info('[codex-fallback-2] restored prior template', { prior: priorTemplate });
        priorTemplate = null;
      }
    } catch (err) {
      log.warn('[codex-fallback-2] template restore failed', { error: err.message });
    }
  });

  return {};
}

module.exports = { createFailoverActivator, FAILOVER_TEMPLATE };
```

- [ ] **Step 4: PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/routing/failover-activator.js server/tests/failover-activator.test.js
git commit -m "feat(codex-fallback-2): auto-swap routing template on codex trip/recover"
```

---

## Task 4: Wire failover-activator into DI container

**Files:**
- Modify: `server/container.js`
- Create: `server/tests/container-failover.test.js`

- [ ] **Step 1: Write test verifying registration**

```javascript
'use strict';
/* global describe, it, expect */

const { defaultContainer } = require('../container');

describe('container — failoverActivator', () => {
  it('is registered', () => {
    expect(defaultContainer.has('failoverActivator')).toBe(true);
  });

  it('subscribes to events without throwing on construction', () => {
    expect(() => defaultContainer.get('failoverActivator')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Register**

In `server/container.js`, add alongside existing registrations:

```javascript
_defaultContainer.register(
  'failoverActivator',
  ['eventBus', 'logger'],
  ({ eventBus, logger: log }) => {
    const { createFailoverActivator } = require('./routing/failover-activator');
    // template-store factory must be obtained at call time to avoid early init.
    const store = require('./routing/template-store').getDefaultStore();
    return createFailoverActivator({ store, eventBus, logger: log });
  }
);
```

In `server/index.js`, after `defaultContainer.boot()`, eagerly construct: `defaultContainer.get('failoverActivator');`.

- [ ] **Step 4: PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/container.js server/index.js server/tests/container-failover.test.js
git commit -m "feat(codex-fallback-2): wire failover-activator at startup"
```

---

## Task 5: Auto-trip wiring — completion-pipeline calls recordFailureByCode for Codex

**Files:**
- Modify: `server/execution/completion-pipeline.js`
- Modify or create: a test that verifies the Codex path uses recordFailureByCode.

- [ ] **Step 1: Read** `server/execution/completion-pipeline.js` around line 379. The current call is `circuitBreaker.recordFailure(task.provider, ctx.errorOutput || '');`.

- [ ] **Step 2: Test**

In `server/tests/completion-pipeline-codex-trip.test.js`:

```javascript
'use strict';
/* global describe, it, expect, vi, beforeEach */

// Patch require.cache for the circuit-breaker / container deps the same way
// circuit-breaker-handlers.test.js does (see Phase 1 commit ab6db8cc for the
// pattern).

const Database = require('better-sqlite3');
const { createTables } = require('../db/schema-tables');
const { createCircuitBreaker } = require('../execution/circuit-breaker');

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

describe('completion-pipeline calls recordFailureByCode for codex', () => {
  let db, cb;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db, SILENT);
    cb = createCircuitBreaker({ eventBus: { emit() {}, on() {} }, store: null });

    // Mock the container's circuitBreaker to be our test instance.
    // Use the require.cache patching pattern.
    const containerPath = require.resolve('../container');
    require.cache[containerPath] = {
      id: containerPath,
      filename: containerPath,
      loaded: true,
      exports: {
        defaultContainer: {
          has: (name) => name === 'circuitBreaker',
          get: (name) => name === 'circuitBreaker' ? cb : null,
        },
      },
    };
    delete require.cache[require.resolve('../execution/completion-pipeline')];
  });

  it('Codex failure with errorCode=quota_exceeded triggers recordFailureByCode', async () => {
    const spy = vi.spyOn(cb, 'recordFailureByCode');
    const { closeTask } = require('../execution/completion-pipeline');
    // Construct the close-task ctx — exact shape depends on the file's API.
    // Verify the call site receives errorCode and exitCode.
    // (Implementer should fill in the exact wiring after reading completion-pipeline.js.)
  });
});
```

(The exact test wiring depends on `completion-pipeline.js` shape — implementer reads the file first and adapts. The skeleton above shows the intent.)

- [ ] **Step 3: Implement**

In `server/execution/completion-pipeline.js`, around line 379, change:

```javascript
if (ctx.exitCode === 0) {
  circuitBreaker.recordSuccess(task.provider);
} else {
  if (task.provider === 'codex' || task.provider === 'codex-spark') {
    circuitBreaker.recordFailureByCode(task.provider, {
      errorCode: task.error_code,
      exitCode: task.exit_code,
    });
  } else {
    circuitBreaker.recordFailure(task.provider, ctx.errorOutput || '');
  }
}
```

(Adjust `task.error_code` / `task.exit_code` to whatever fields exist on the task object at this call site.)

- [ ] **Step 4: PASS** — new test + existing completion-pipeline tests.

- [ ] **Step 5: Commit**

```bash
git add server/execution/completion-pipeline.js server/tests/completion-pipeline-codex-trip.test.js
git commit -m "feat(codex-fallback-2): completion-pipeline auto-trips breaker on Codex error codes"
```

---

## Task 6: PRIORITIZE branch — handle proceed_with_fallback

**Files:**
- Modify: `server/factory/loop-controller.js` (the call site from Phase 1 at lines 5003-5074)
- Modify or extend: `server/tests/loop-controller-codex-fallback.test.js` (Phase 1 test).

- [ ] **Step 1: Find Phase 1's PRIORITIZE call site**

`grep -n "decideCodexFallbackAction\|proceed_with_fallback" server/factory/loop-controller.js`

- [ ] **Step 2: Test additions**

Add to `server/tests/loop-controller-codex-fallback.test.js`:

```javascript
it('proceed_with_fallback path hands off to free-provider chain (Phase 2)', () => {
  // Stub breaker as tripped; ensure the active template is codex-down-failover.
  // Verify that EXECUTE-stage call uses the chain rather than codex.
  // Implementation depends on Phase 2's chain-walker integration in smart-routing.
});
```

(Concrete assertions depend on Task 7's chain-walker shape.)

- [ ] **Step 3: Implement**

In `loop-controller.js`'s `handlePrioritizeTransition`, where Phase 1 currently has the comment block at lines 5072-5073 noting "Phase 2 wiring point", add: when `decision.action === 'proceed_with_fallback'`, set a flag on the work item / instance metadata that the EXECUTE stage's smart-routing should consult to use the failover chain. Actual routing happens in Task 7.

The loop-controller's job here is to mark the item as "use failover chain" — not to do the routing itself.

- [ ] **Step 4: PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/factory/loop-controller.js server/tests/loop-controller-codex-fallback.test.js
git commit -m "feat(codex-fallback-2): PRIORITIZE marks proceed_with_fallback for chain-walker"
```

---

## Task 7: Chain walker in smart-routing

**Files:**
- Modify: `server/db/smart-routing.js`
- Create: `server/tests/smart-routing-failover-chain.test.js`

This is the heart of Phase 2 — when the active template is `codex-down-failover` and a task arrives for routing, walk the chain trying providers in order.

- [ ] **Step 1: Read** `server/db/smart-routing.js`. It's 1111 lines. Find:
  - The function that resolves `task → provider` given the active template.
  - The retry/fallback logic if any.

- [ ] **Step 2: Test**

```javascript
'use strict';
/* global describe, it, expect, vi */

// Test the chain walker in isolation.
const { walkFailoverChain } = require('../db/smart-routing');

describe('walkFailoverChain', () => {
  it('returns first provider that allows the request', () => {
    const breaker = { allowRequest: vi.fn((p) => p !== 'groq') };
    const chain = [
      { provider: 'groq', model: 'gpt-oss-120b' },
      { provider: 'cerebras', model: 'qwen-235b' },
    ];
    const choice = walkFailoverChain({ chain, breaker });
    expect(choice.provider).toBe('cerebras');
  });

  it('returns null on chain exhaustion', () => {
    const breaker = { allowRequest: () => false };
    const chain = [{ provider: 'groq' }, { provider: 'cerebras' }];
    expect(walkFailoverChain({ chain, breaker })).toBeNull();
  });

  it('null breaker treats all providers as available', () => {
    const chain = [{ provider: 'groq' }];
    const choice = walkFailoverChain({ chain, breaker: null });
    expect(choice.provider).toBe('groq');
  });
});
```

- [ ] **Step 3: Implement** — add `walkFailoverChain` to `smart-routing.js` and wire it into the routing resolver. When the active template is `codex-down-failover`, use this chain instead of single-provider selection.

- [ ] **Step 4: PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/db/smart-routing.js server/tests/smart-routing-failover-chain.test.js
git commit -m "feat(codex-fallback-2): add walkFailoverChain for codex-down-failover routing"
```

---

## Task 8: Canary scheduler

**Files:**
- Create: `server/factory/canary-scheduler.js`
- Create: `server/tests/canary-scheduler.test.js`

When the breaker trips, schedule a canary task at 5-minute cadence to probe Codex recovery. On canary success, the breaker auto-untrips via the existing `recordSuccess` path. On canary failure, schedule the next probe.

- [ ] **Step 1: Test** — covers: subscribes to `circuit:tripped`, schedules canary, on canary success doesn't reschedule, on canary failure reschedules.

- [ ] **Step 2: Implement** using `setTimeout` with cleanup on `circuit:recovered`. The canary task is a read-only Codex call (the existing `Read-only canary check: list files in /src` pattern).

- [ ] **Step 3: Wire into container** at `server/container.js` and eagerly construct in `index.js`.

- [ ] **Step 4: PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/factory/canary-scheduler.js server/tests/canary-scheduler.test.js server/container.js server/index.js
git commit -m "feat(codex-fallback-2): auto-schedule Codex canary probes while breaker tripped"
```

---

## Task 9: Phase 2 integration smoke test

**Files:**
- Create: `server/tests/integration/codex-fallback-phase2-smoke.test.js`

Exercises the full auto-trip → fallback → auto-recover cycle:
1. Submit a Codex task that fails with `quota_exceeded` 3 times in 15 min.
2. Breaker auto-trips via `recordFailureByCode`.
3. Active template auto-swaps to `codex-down-failover` via `failoverActivator`.
4. Submit a free-eligible task; verify it routes through the failover chain.
5. Submit a codex-only task while breaker tripped; verify Phase 1 park behavior still kicks in for `wait_for_codex` projects.
6. Trigger canary success; verify breaker untrips, template restores, parked items resume.

Run the full Phase 2 surface together:
```bash
torque-remote npx vitest run \
  server/tests/eligibility-classifier.test.js \
  server/tests/codex-down-failover-template.test.js \
  server/tests/failover-activator.test.js \
  server/tests/container-failover.test.js \
  server/tests/completion-pipeline-codex-trip.test.js \
  server/tests/smart-routing-failover-chain.test.js \
  server/tests/canary-scheduler.test.js \
  server/tests/integration/codex-fallback-phase2-smoke.test.js
```

- [ ] **Commit + cutover**

```bash
git add server/tests/integration/codex-fallback-phase2-smoke.test.js
git commit -m "test(codex-fallback-2): Phase 2 integration smoke test"
```

Then `scripts/worktree-cutover.sh codex-fallback-phase2` (expect to bypass pre-push gate again per Phase 1 precedent).

---

## Self-Review

**Spec coverage:**
- ✓ Component B (eligibility classifier) — Task 1
- ✓ Component D (failover routing template + chain walker) — Tasks 2, 3, 4, 7
- ✓ Auto-trip wiring (closes Phase 1 plumbing) — Task 5
- ✓ Auto-canary (closes Phase 1 manual-only loop) — Task 8
- ✓ PRIORITIZE proceed_with_fallback handling — Task 6

**Out of scope (Phase 3):**
- Component C (auto-augmenter for plan-quality)
- Component E (decompose-on-park)
- Plan-quality gate calibration

**Dependencies between tasks:**
- Tasks 1, 2 are independent.
- Task 3 depends on Task 2 (template must exist before activator can swap to it).
- Task 4 depends on Task 3.
- Task 5 is independent (uses Phase 1's `recordFailureByCode`).
- Task 7 depends on Task 2.
- Task 6 depends on Task 7 (PRIORITIZE flag is consumed by chain-walker).
- Task 8 is independent of all routing tasks.
- Task 9 depends on all of 1-8.

**Type/method consistency:**
- `classify(workItem, plan, projectConfig)` returns `{ eligibility, reason }`.
- `walkFailoverChain({ chain, breaker })` returns `{ provider, model } | null`.
- Both `failoverActivator` and `canaryScheduler` are container-registered factories returning `{}` (event-bus side effects only).
- `breaker.recordFailureByCode(provider, { errorCode, exitCode })` matches Phase 1's signature.
