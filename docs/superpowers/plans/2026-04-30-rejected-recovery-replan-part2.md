# Rejected-Item Replan Recovery Implementation Plan — Part 2

> Continuation of `2026-04-30-rejected-recovery-replan.md`. Tasks 5 through 16.

---

## Task 5: rewrite-description strategy

**Files:**
- Create: `server/factory/recovery-strategies/rewrite-description.js`
- Test: `server/tests/recovery-strategy-rewrite-description.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/recovery-strategy-rewrite-description.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const strategy = require('../factory/recovery-strategies/rewrite-description');
const { createMockArchitect } = require('./helpers/mock-architect');

const baseWorkItem = () => ({
  id: 1,
  title: 'old title',
  description: 'old description',
  reject_reason: 'cannot_generate_plan: too vague',
});

const baseHistory = () => ({
  attempts: 0,
  priorReason: 'cannot_generate_plan: too vague',
  priorDescription: 'old description',
  priorPlans: [],
  recoveryRecords: [],
});

const noopLogger = { warn() {}, error() {}, info() {} };

describe('rewrite-description strategy', () => {
  it('owns the expected reject reasons', () => {
    expect(strategy.reasonPatterns.some((p) => p.test('cannot_generate_plan: x'))).toBe(true);
    expect(strategy.reasonPatterns.some((p) => p.test('pre_written_plan_rejected_by_quality_gate'))).toBe(true);
    expect(strategy.reasonPatterns.some((p) => p.test('Rejected by user'))).toBe(true);
  });

  it('returns rewrote outcome on valid architect response', async () => {
    const longDesc = 'x'.repeat(150);
    const architect = createMockArchitect({
      rewrite: { title: 'New T', description: longDesc, acceptance_criteria: ['must X', 'must Y'] },
    });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger },
    });
    expect(result.outcome).toBe('rewrote');
    expect(result.updates.title).toBe('New T');
    expect(result.updates.description).toContain('must X');
    expect(result.updates.description).toContain('must Y');
    expect(architect.calls.rewrite).toHaveLength(1);
    expect(architect.calls.rewrite[0].workItem.id).toBe(1);
    expect(architect.calls.rewrite[0].history.priorReason).toBe('cannot_generate_plan: too vague');
  });

  it('returns unrecoverable when title is empty', async () => {
    const architect = createMockArchitect({
      rewrite: { title: '', description: 'x'.repeat(150), acceptance_criteria: ['must X'] },
    });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger },
    });
    expect(result.outcome).toBe('unrecoverable');
    expect(result.reason).toMatch(/rewrite_response_invalid/);
  });

  it('returns unrecoverable when description is too short', async () => {
    const architect = createMockArchitect({
      rewrite: { title: 'T', description: 'short', acceptance_criteria: ['must X'] },
    });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('returns unrecoverable when acceptance criteria are missing', async () => {
    const architect = createMockArchitect({
      rewrite: { title: 'T', description: 'x'.repeat(150), acceptance_criteria: [] },
    });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('returns unrecoverable when architect response is null/non-object', async () => {
    const architect = createMockArchitect({ rewriteImpl: () => null });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger },
    });
    expect(result.outcome).toBe('unrecoverable');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/recovery-strategy-rewrite-description.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the strategy**

Create `server/factory/recovery-strategies/rewrite-description.js`:

```js
'use strict';

const MIN_DESCRIPTION_LENGTH = 100;

const reasonPatterns = [
  /^cannot_generate_plan:/i,
  /^pre_written_plan_rejected_by_quality_gate$/i,
  /^Rejected by user$/i,
];

function validateRewriteResponse(response) {
  if (!response || typeof response !== 'object') {
    return { ok: false, reason: 'rewrite_response_invalid: not an object' };
  }
  if (typeof response.title !== 'string' || !response.title.trim()) {
    return { ok: false, reason: 'rewrite_response_invalid: missing title' };
  }
  if (typeof response.description !== 'string' || response.description.length < MIN_DESCRIPTION_LENGTH) {
    return { ok: false, reason: `rewrite_response_invalid: description shorter than ${MIN_DESCRIPTION_LENGTH} chars` };
  }
  if (!Array.isArray(response.acceptance_criteria) || response.acceptance_criteria.length === 0) {
    return { ok: false, reason: 'rewrite_response_invalid: no acceptance criteria' };
  }
  return { ok: true };
}

function appendAcceptanceCriteria(description, criteria) {
  const lines = ['', '## Acceptance Criteria', ''];
  for (const c of criteria) {
    lines.push(`- ${String(c).trim()}`);
  }
  return `${description.trimEnd()}\n${lines.join('\n')}`;
}

async function replan({ workItem, history, deps }) {
  const { architectRunner, logger } = deps;
  let response;
  try {
    response = await architectRunner.rewriteWorkItem({ workItem, history });
  } catch (err) {
    if (logger?.warn) {
      logger.warn('rewrite-description: architect call threw', {
        work_item_id: workItem.id,
        err: err.message,
      });
    }
    throw err;  // dispatcher catches and counts as failed attempt
  }

  const validation = validateRewriteResponse(response);
  if (!validation.ok) {
    return { outcome: 'unrecoverable', reason: validation.reason };
  }

  const updatedDescription = appendAcceptanceCriteria(response.description, response.acceptance_criteria);
  return {
    outcome: 'rewrote',
    updates: {
      title: response.title.trim(),
      description: updatedDescription,
    },
  };
}

module.exports = {
  name: 'rewrite-description',
  reasonPatterns,
  replan,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/recovery-strategy-rewrite-description.test.js`
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add server/factory/recovery-strategies/rewrite-description.js server/tests/recovery-strategy-rewrite-description.test.js
git commit -m "feat(replan-recovery): rewrite-description strategy"
```

---

## Task 6: decompose strategy

**Files:**
- Create: `server/factory/recovery-strategies/decompose.js`
- Test: `server/tests/recovery-strategy-decompose.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/recovery-strategy-decompose.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const strategy = require('../factory/recovery-strategies/decompose');
const { createMockArchitect } = require('./helpers/mock-architect');

const longDesc = (extra = '') => `${'x'.repeat(120)} ${extra}`;
const noopLogger = { warn() {}, error() {}, info() {} };

const baseWorkItem = () => ({
  id: 1,
  title: 'parent item',
  description: 'parent description',
  reject_reason: 'plan_quality_gate_rejected_after_2_attempts',
  depth: 0,
});

const baseHistory = () => ({
  attempts: 1,
  priorReason: 'plan_quality_gate_rejected_after_2_attempts',
  priorDescription: 'parent description',
  priorPlans: [{ attempt: 1, planMarkdown: '# Plan\n## Tasks\n- bad task', lintErrors: ['too vague'] }],
  recoveryRecords: [],
});

const goodChildren = (n = 2) => Array.from({ length: n }, (_, i) => ({
  title: `Child ${i + 1}`,
  description: longDesc(`unique-${i}`),
  acceptance_criteria: [`must do ${i + 1}`],
}));

const baseConfig = { splitMaxChildren: 5, splitMaxDepth: 2 };

describe('decompose strategy', () => {
  it('owns the expected reject reasons', () => {
    expect(strategy.reasonPatterns.some((p) => p.test('plan_quality_gate_rejected_after_2_attempts'))).toBe(true);
    expect(strategy.reasonPatterns.some((p) => p.test('replan_generation_failed'))).toBe(true);
  });

  it('returns split outcome on valid response', async () => {
    const architect = createMockArchitect({ decompose: { children: goodChildren(3) } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('split');
    expect(result.children).toHaveLength(3);
    expect(result.children[0].title).toBe('Child 1');
  });

  it('rejects when fewer than 2 children', async () => {
    const architect = createMockArchitect({ decompose: { children: goodChildren(1) } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('rejects when more than splitMaxChildren', async () => {
    const architect = createMockArchitect({ decompose: { children: goodChildren(6) } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('rejects when child description too short', async () => {
    const bad = goodChildren(2);
    bad[0].description = 'too short';
    const architect = createMockArchitect({ decompose: { children: bad } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('rejects when child titles are duplicate', async () => {
    const bad = goodChildren(2);
    bad[1].title = bad[0].title;
    const architect = createMockArchitect({ decompose: { children: bad } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('rejects when a child is >= 90% similar to parent', async () => {
    const bad = goodChildren(2);
    bad[0].title = 'parent item rephrased';
    bad[0].description = 'parent description with two extra words plus padding'.repeat(3);
    const parent = baseWorkItem();
    parent.description = bad[0].description;  // make Jaccard similarity ~1.0
    const architect = createMockArchitect({ decompose: { children: bad } });
    const result = await strategy.replan({
      workItem: parent,
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('refuses cascade fan-out at splitMaxDepth', async () => {
    const deep = baseWorkItem();
    deep.depth = 2;
    const architect = createMockArchitect({ decompose: { children: goodChildren(2) } });
    const result = await strategy.replan({
      workItem: deep,
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
    expect(result.reason).toMatch(/depth/i);
  });

  it('rejects cycles in depends_on_index', async () => {
    const children = goodChildren(2);
    children[0].depends_on_index = 1;
    children[1].depends_on_index = 0;
    const architect = createMockArchitect({ decompose: { children } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/recovery-strategy-decompose.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the strategy**

Create `server/factory/recovery-strategies/decompose.js`:

```js
'use strict';

const MIN_DESCRIPTION_LENGTH = 100;
const SIMILARITY_THRESHOLD = 0.9;

const reasonPatterns = [
  /^plan_quality_gate_rejected_after_2_attempts$/i,
  /^replan_generation_failed$/i,
];

function tokenize(text) {
  return new Set(
    String(text || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function detectCycle(children) {
  // children may declare depends_on_index pointing at sibling indices.
  const n = children.length;
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const dep = children[i].depends_on_index;
    if (dep === undefined || dep === null) continue;
    if (typeof dep !== 'number' || !Number.isInteger(dep) || dep < 0 || dep >= n) {
      return true;  // invalid dep index = treat as cycle for safety
    }
    if (dep === i) return true;
    adj[i].push(dep);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array(n).fill(WHITE);
  function dfs(u) {
    color[u] = GRAY;
    for (const v of adj[u]) {
      if (color[v] === GRAY) return true;
      if (color[v] === WHITE && dfs(v)) return true;
    }
    color[u] = BLACK;
    return false;
  }
  for (let i = 0; i < n; i++) {
    if (color[i] === WHITE && dfs(i)) return true;
  }
  return false;
}

function validateDecomposeResponse(response, parent, config) {
  if (!response || typeof response !== 'object') {
    return { ok: false, reason: 'decompose_response_invalid: not an object' };
  }
  if (!Array.isArray(response.children)) {
    return { ok: false, reason: 'decompose_response_invalid: children not an array' };
  }
  const minChildren = 2;
  const maxChildren = config?.splitMaxChildren ?? 5;
  if (response.children.length < minChildren) {
    return { ok: false, reason: `decompose_response_invalid: fewer than ${minChildren} children` };
  }
  if (response.children.length > maxChildren) {
    return { ok: false, reason: `decompose_response_invalid: more than ${maxChildren} children` };
  }
  const titles = new Set();
  for (const child of response.children) {
    if (!child || typeof child.title !== 'string' || !child.title.trim()) {
      return { ok: false, reason: 'decompose_response_invalid: child missing title' };
    }
    if (typeof child.description !== 'string' || child.description.length < MIN_DESCRIPTION_LENGTH) {
      return { ok: false, reason: `decompose_response_invalid: child description < ${MIN_DESCRIPTION_LENGTH} chars` };
    }
    if (!Array.isArray(child.acceptance_criteria) || child.acceptance_criteria.length === 0) {
      return { ok: false, reason: 'decompose_response_invalid: child missing acceptance_criteria' };
    }
    const t = child.title.trim().toLowerCase();
    if (titles.has(t)) {
      return { ok: false, reason: 'decompose_response_invalid: duplicate child titles' };
    }
    titles.add(t);
  }
  if (detectCycle(response.children)) {
    return { ok: false, reason: 'decompose_response_invalid: cycle in depends_on_index' };
  }
  // Similarity check vs parent
  const parentTokens = tokenize(`${parent.title} ${parent.description}`);
  for (const child of response.children) {
    const childTokens = tokenize(`${child.title} ${child.description}`);
    if (jaccard(parentTokens, childTokens) >= SIMILARITY_THRESHOLD) {
      return { ok: false, reason: 'decompose_response_invalid: child >= 90% similar to parent' };
    }
  }
  return { ok: true };
}

function appendAcceptanceCriteria(description, criteria) {
  const lines = ['', '## Acceptance Criteria', ''];
  for (const c of criteria) lines.push(`- ${String(c).trim()}`);
  return `${description.trimEnd()}\n${lines.join('\n')}`;
}

async function replan({ workItem, history, deps }) {
  const { architectRunner, logger, config } = deps;
  const splitMaxDepth = config?.splitMaxDepth ?? 2;
  const currentDepth = Number(workItem.depth || 0);
  if (currentDepth >= splitMaxDepth) {
    return {
      outcome: 'unrecoverable',
      reason: `decompose_refused: depth ${currentDepth} >= max ${splitMaxDepth}`,
    };
  }

  let response;
  try {
    response = await architectRunner.decomposeWorkItem({
      workItem,
      history,
      priorPlans: history.priorPlans || [],
    });
  } catch (err) {
    if (logger?.warn) {
      logger.warn('decompose: architect call threw', { work_item_id: workItem.id, err: err.message });
    }
    throw err;
  }

  const validation = validateDecomposeResponse(response, workItem, config);
  if (!validation.ok) {
    return { outcome: 'unrecoverable', reason: validation.reason };
  }

  const children = response.children.map((c) => ({
    title: c.title.trim(),
    description: appendAcceptanceCriteria(c.description, c.acceptance_criteria),
    constraints: c.constraints || null,
  }));

  return { outcome: 'split', children };
}

module.exports = {
  name: 'decompose',
  reasonPatterns,
  replan,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/recovery-strategy-decompose.test.js`
Expected: PASS — all 8 cases green.

- [ ] **Step 5: Commit**

```bash
git add server/factory/recovery-strategies/decompose.js server/tests/recovery-strategy-decompose.test.js
git commit -m "feat(replan-recovery): decompose strategy"
```

---

## Task 7: escalate-architect strategy

**Files:**
- Create: `server/factory/recovery-strategies/escalate-architect.js`
- Test: `server/tests/recovery-strategy-escalate.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/recovery-strategy-escalate.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const strategy = require('../factory/recovery-strategies/escalate-architect');

const noopLogger = { warn() {}, error() {}, info() {} };

const baseWorkItem = (rejectReason = 'zero_diff_across_retries', constraintsJson = null) => ({
  id: 1,
  title: 't',
  description: 'd',
  reject_reason: rejectReason,
  constraints_json: constraintsJson,
  project_id: 'proj-1',
});

const projectChain = ['ollama', 'codex-spark', 'codex', 'claude-cli'];

const stubFactoryHealth = (chain = projectChain) => ({
  getProject(projectId) {
    return {
      id: projectId,
      provider_chain_json: JSON.stringify(chain),
    };
  },
});

describe('escalate-architect strategy', () => {
  it('owns the expected reject reasons', () => {
    expect(strategy.reasonPatterns.some((p) => p.test('zero_diff_across_retries'))).toBe(true);
    expect(strategy.reasonPatterns.some((p) => p.test('retry_off_scope'))).toBe(true);
  });

  it('escalates from ollama to codex-spark when last attempt was on ollama', async () => {
    const workItem = baseWorkItem('zero_diff_across_retries', JSON.stringify({ last_used_provider: 'ollama' }));
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('escalated');
    expect(result.updates.constraints.architect_provider_override).toBe('codex-spark');
    expect(result.updates.constraints.execution_provider_override).toBe('codex-spark');
  });

  it('escalates from codex-spark to codex', async () => {
    const workItem = baseWorkItem('zero_diff_across_retries', JSON.stringify({ last_used_provider: 'codex-spark' }));
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('escalated');
    expect(result.updates.constraints.architect_provider_override).toBe('codex');
  });

  it('returns unrecoverable when already at the top of the chain', async () => {
    const workItem = baseWorkItem('zero_diff_across_retries', JSON.stringify({ last_used_provider: 'claude-cli' }));
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('unrecoverable');
    expect(result.reason).toMatch(/top of chain/i);
  });

  it('falls back to first chain entry when last_used_provider unknown', async () => {
    const workItem = baseWorkItem('retry_off_scope', null);
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth() },
    });
    expect(result.outcome).toBe('escalated');
    expect(result.updates.constraints.architect_provider_override).toBe('codex-spark');
  });

  it('returns unrecoverable when project chain is empty/missing', async () => {
    const workItem = baseWorkItem('zero_diff_across_retries', null);
    const result = await strategy.replan({
      workItem,
      history: { attempts: 0, recoveryRecords: [] },
      deps: { logger: noopLogger, factoryHealth: stubFactoryHealth([]) },
    });
    expect(result.outcome).toBe('unrecoverable');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/recovery-strategy-escalate.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the strategy**

Create `server/factory/recovery-strategies/escalate-architect.js`:

```js
'use strict';

const reasonPatterns = [
  /^zero_diff_across_retries$/i,
  /^retry_off_scope$/i,
];

function readProviderChain(factoryHealth, projectId) {
  if (!factoryHealth || typeof factoryHealth.getProject !== 'function') return [];
  const project = factoryHealth.getProject(projectId);
  if (!project) return [];
  const raw = project.provider_chain_json;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p) : [];
  } catch {
    return [];
  }
}

function readLastUsedProvider(workItem) {
  const raw = workItem.constraints_json;
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed.last_used_provider === 'string') {
      return parsed.last_used_provider;
    }
  } catch { /* ignore */ }
  return null;
}

async function replan({ workItem, deps }) {
  const { factoryHealth, logger } = deps;
  const chain = readProviderChain(factoryHealth, workItem.project_id);
  if (chain.length === 0) {
    return { outcome: 'unrecoverable', reason: 'escalate_refused: project provider_chain empty or missing' };
  }
  const lastUsed = readLastUsedProvider(workItem);
  let lastIdx = chain.indexOf(lastUsed);
  if (lastIdx < 0) lastIdx = 0;  // unknown -> assume bottom of ladder, climb one step
  const nextIdx = lastIdx + 1;
  if (nextIdx >= chain.length) {
    return { outcome: 'unrecoverable', reason: 'escalate_refused: already at top of chain' };
  }
  const nextProvider = chain[nextIdx];
  if (logger?.info) {
    logger.info('escalate-architect: bumping provider', {
      work_item_id: workItem.id,
      from: lastUsed,
      to: nextProvider,
    });
  }
  return {
    outcome: 'escalated',
    updates: {
      constraints: {
        architect_provider_override: nextProvider,
        execution_provider_override: nextProvider,
      },
    },
  };
}

module.exports = {
  name: 'escalate-architect',
  reasonPatterns,
  replan,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/recovery-strategy-escalate.test.js`
Expected: PASS — all 5 cases green.

- [ ] **Step 5: Commit**

```bash
git add server/factory/recovery-strategies/escalate-architect.js server/tests/recovery-strategy-escalate.test.js
git commit -m "feat(replan-recovery): escalate-architect strategy"
```

---

## Task 8: Architect-runner helpers (rewriteWorkItem + decomposeWorkItem)

**Files:**
- Modify: `server/factory/architect-runner.js` (add two methods)
- Test: `server/tests/architect-runner-recovery-helpers.test.js`

These are single-turn JSON-output helpers, not full plan cycles. They reuse the existing architect provider configuration but format their own prompts.

- [ ] **Step 1: Read the existing architect-runner file to find the provider-call helper**

Run: `grep -n "function .*Architect\|provider.*invoke\|callArchitect\|runArchitect" server/factory/architect-runner.js`

Expected: identify the existing single-turn provider call function (likely named something like `callArchitectProvider`, `runArchitectPrompt`, or similar). The two new helpers reuse this function. If the file doesn't have a single-turn helper, the new helpers should call into `server/providers/execution.js` directly. Note the chosen binding for the commit message.

- [ ] **Step 2: Write the failing test**

Create `server/tests/architect-runner-recovery-helpers.test.js`:

```js
'use strict';

const { describe, it, expect, vi } = require('vitest');

describe('architect-runner recovery helpers', () => {
  it('rewriteWorkItem returns parsed JSON from the underlying provider', async () => {
    const mockProvider = vi.fn().mockResolvedValue(JSON.stringify({
      title: 'New T',
      description: 'x'.repeat(150),
      acceptance_criteria: ['must X'],
    }));
    const runner = require('../factory/architect-runner');
    const result = await runner.rewriteWorkItem({
      workItem: { id: 1, title: 'old', description: 'old', reject_reason: 'cannot_generate_plan: x' },
      history: { attempts: 0, priorReason: 'cannot_generate_plan: x', priorDescription: 'old', recoveryRecords: [] },
      _testProviderCall: mockProvider,
    });
    expect(result.title).toBe('New T');
    expect(result.acceptance_criteria).toEqual(['must X']);
    expect(mockProvider).toHaveBeenCalledOnce();
    const promptArg = mockProvider.mock.calls[0][0];
    expect(promptArg).toMatch(/cannot_generate_plan: x/);
    expect(promptArg).toMatch(/strict JSON/i);
  });

  it('rewriteWorkItem throws on invalid JSON from provider', async () => {
    const mockProvider = vi.fn().mockResolvedValue('not json');
    const runner = require('../factory/architect-runner');
    await expect(runner.rewriteWorkItem({
      workItem: { id: 1, title: 't', description: 'd', reject_reason: 'cannot_generate_plan: x' },
      history: { attempts: 0, priorReason: 'cannot_generate_plan: x', priorDescription: 'd', recoveryRecords: [] },
      _testProviderCall: mockProvider,
    })).rejects.toThrow(/invalid|json/i);
  });

  it('decomposeWorkItem includes priorPlans in the prompt', async () => {
    const mockProvider = vi.fn().mockResolvedValue(JSON.stringify({
      children: [
        { title: 'A', description: 'x'.repeat(150), acceptance_criteria: ['x'] },
        { title: 'B', description: 'x'.repeat(150), acceptance_criteria: ['y'] },
      ],
    }));
    const runner = require('../factory/architect-runner');
    const result = await runner.decomposeWorkItem({
      workItem: { id: 1, title: 'parent', description: 'parent', reject_reason: 'plan_quality_gate_rejected_after_2_attempts' },
      history: { attempts: 1, recoveryRecords: [] },
      priorPlans: [{ attempt: 1, planMarkdown: '# Plan A', lintErrors: ['too vague'] }],
      _testProviderCall: mockProvider,
    });
    expect(result.children).toHaveLength(2);
    const promptArg = mockProvider.mock.calls[0][0];
    expect(promptArg).toMatch(/Plan A/);
    expect(promptArg).toMatch(/too vague/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/architect-runner-recovery-helpers.test.js`
Expected: FAIL — `rewriteWorkItem` not exported.

- [ ] **Step 4: Add the helpers to `architect-runner.js`**

Append the following just before the `module.exports = {...}` block. Replace `callArchitectProvider` with whatever single-turn helper Step 1 identified.

```js
function buildRewritePrompt({ workItem, history }) {
  const recoveryLog = (history.recoveryRecords || [])
    .map((r) => `  - attempt ${r.attempt}: strategy="${r.strategy}" outcome="${r.outcome}" at ${r.timestamp}`)
    .join('\n') || '  (none)';
  return [
    'You are reviewing a factory work item that failed to plan. Your job is to rewrite the title and description so the architect can produce a plannable, testable, atomic unit.',
    '',
    `Original title: ${workItem.title}`,
    `Original description:`,
    workItem.description || '(empty)',
    '',
    `Prior failure reason: ${history.priorReason || workItem.reject_reason || '(unknown)'}`,
    `Prior recovery attempts:`,
    recoveryLog,
    '',
    'Rewrite to be specific, scoped, and testable. Output strict JSON ONLY (no prose, no markdown fence) of the form:',
    '{ "title": "...", "description": "...", "acceptance_criteria": ["...", "..."] }',
    '',
    'The description must be at least 100 characters and describe what changes, where, and why.',
    'Acceptance criteria must be concrete, testable, and at least 1 entry.',
  ].join('\n');
}

function buildDecomposePrompt({ workItem, history, priorPlans }) {
  const planLog = (priorPlans || [])
    .map((p) => `### Attempt ${p.attempt}\n${p.planMarkdown || '(empty)'}\nLint errors: ${(p.lintErrors || []).join('; ') || '(none)'}`)
    .join('\n\n') || '(no prior plans)';
  return [
    'You are reviewing a factory work item whose plan failed quality checks twice. Your job is to split it into 2-4 atomic child items, each independently plannable.',
    '',
    `Parent title: ${workItem.title}`,
    `Parent description:`,
    workItem.description || '(empty)',
    '',
    'Prior plan attempts and lint failures:',
    planLog,
    '',
    'Split into 2-4 children. Each child must be independently plannable, declare its own acceptance criteria, and reference the parent context where useful.',
    'Output strict JSON ONLY of the form:',
    '{ "children": [ { "title": "...", "description": "...", "acceptance_criteria": ["..."], "depends_on_index": 0 } ] }',
    '',
    'depends_on_index is optional and refers to a sibling index (0-based). Do not create cycles.',
    'Each child description must be at least 100 characters.',
  ].join('\n');
}

function parseStrictJson(raw, label) {
  if (typeof raw !== 'string') {
    throw new Error(`${label}: provider response was not a string`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label}: provider returned invalid JSON: ${err.message}`);
  }
}

async function rewriteWorkItem({ workItem, history, _testProviderCall }) {
  const prompt = buildRewritePrompt({ workItem, history });
  const providerCall = _testProviderCall || callArchitectProvider;
  const raw = await providerCall(prompt, { mode: 'rewrite_work_item' });
  return parseStrictJson(raw, 'rewriteWorkItem');
}

async function decomposeWorkItem({ workItem, history, priorPlans, _testProviderCall }) {
  const prompt = buildDecomposePrompt({ workItem, history, priorPlans });
  const providerCall = _testProviderCall || callArchitectProvider;
  const raw = await providerCall(prompt, { mode: 'decompose_work_item' });
  return parseStrictJson(raw, 'decomposeWorkItem');
}
```

Add `rewriteWorkItem` and `decomposeWorkItem` to the `module.exports = {...}` block at the bottom.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/architect-runner-recovery-helpers.test.js`
Expected: PASS — all 3 cases green.

- [ ] **Step 6: Run the full architect-runner test suite for regressions**

Run: `cd server && npx vitest run tests/architect-runner.test.js tests/factory-architect-shared-learnings.test.js`
Expected: PASS — existing tests still green.

- [ ] **Step 7: Commit**

```bash
git add server/factory/architect-runner.js server/tests/architect-runner-recovery-helpers.test.js
git commit -m "feat(replan-recovery): architect-runner rewriteWorkItem and decomposeWorkItem helpers"
```

---

## Task 9: replan-recovery dispatcher (sweep + transactional dispatch)

**Files:**
- Create: `server/factory/replan-recovery.js`
- Test: `server/tests/replan-recovery.test.js`

This is the largest task. The dispatcher is the heart of the feature.

- [ ] **Step 1: Write the failing test (eligibility + cooldown ladder + outcomes)**

Create `server/tests/replan-recovery.test.js` with the following content. (Use the pattern from `server/tests/rejected-recovery.test.js` for setup/teardown.)

```js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const {
  createDispatcher,
  resetReplanRecoverySweepStateForTests,
} = require('../factory/replan-recovery');
const { createRegistry } = require('../factory/recovery-strategies/registry');

const noopLogger = { warn() {}, error() {}, info() {} };

function createDarkProject(testDir, status = 'running') {
  const suffix = Math.random().toString(16).slice(2);
  const project = factoryHealth.registerProject({
    name: `Replan Recovery ${suffix}`,
    path: `${testDir}/${suffix}`,
    trust_level: 'dark',
    config: { loop: { auto_continue: false } },
  });
  return factoryHealth.updateProject(project.id, { status });
}

function createRejectedItem(db, projectId, {
  rejectReason = 'cannot_generate_plan: too vague',
  status = 'rejected',
  recoveryAttempts = 0,
  lastRecoveryAt = null,
  updatedAtMsAgo = 2 * 60 * 60 * 1000,
} = {}) {
  const item = factoryIntake.createWorkItem({
    project_id: projectId,
    source: 'manual',
    title: `Replan target ${Math.random().toString(16).slice(2)}`,
    description: 'baseline',
    status,
  });
  db.prepare(`
    UPDATE factory_work_items
    SET reject_reason = ?, recovery_attempts = ?, last_recovery_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    rejectReason,
    recoveryAttempts,
    lastRecoveryAt,
    new Date(Date.now() - updatedAtMsAgo).toISOString(),
    item.id,
  );
  return factoryIntake.getWorkItem(item.id);
}

const stubStrategy = (overrides = {}) => ({
  name: overrides.name || 'stub',
  reasonPatterns: overrides.reasonPatterns || [/^cannot_generate_plan:/i],
  replan: overrides.replan || (async () => ({ outcome: 'rewrote', updates: { description: 'rewritten desc' } })),
});

const baseConfig = (over = {}) => ({
  enabled: true,
  sweepIntervalMs: 1000,
  hardCap: 3,
  maxPerProjectPerSweep: 1,
  maxGlobalPerSweep: 5,
  skipIfOpenCountGte: 3,
  cooldownMs: [3600000, 86400000, 259200000],
  strategyTimeoutMs: 5000,
  strategyTimeoutMsEscalate: 1000,
  historyMaxEntries: 10,
  splitMaxChildren: 5,
  splitMaxDepth: 2,
  ...over,
});

describe('replan-recovery dispatcher', () => {
  let db, testDir;
  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`replan-recovery-${Date.now()}`));
    db = rawDb();
    resetReplanRecoverySweepStateForTests();
  });
  afterEach(() => { teardownTestDb(); });

  it('skips when feature disabled', async () => {
    const project = createDarkProject(testDir);
    createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig({ enabled: false }) });
    expect(actions).toEqual([]);
  });

  it('reopens an eligible item via the strategy and increments attempts', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig() });
    expect(actions.find((a) => a.work_item_id === item.id)?.action).toBe('rewrote');
    const updated = factoryIntake.getWorkItem(item.id);
    expect(updated.status).toBe('pending');
    expect(updated.recovery_attempts).toBe(1);
    expect(updated.description).toBe('rewritten desc');
    expect(updated.reject_reason).toBeNull();
  });

  it('routes split outcomes: parent -> superseded, children created with recovery_split source', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id, { rejectReason: 'plan_quality_gate_rejected_after_2_attempts' });
    const registry = createRegistry();
    registry.register(stubStrategy({
      name: 'decompose-stub',
      reasonPatterns: [/^plan_quality_gate_rejected_after_2_attempts$/i],
      replan: async () => ({
        outcome: 'split',
        children: [
          { title: 'Child A', description: 'x'.repeat(150) },
          { title: 'Child B', description: 'x'.repeat(150) },
        ],
      }),
    }));
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const parent = factoryIntake.getWorkItem(item.id);
    expect(parent.status).toBe('superseded');
    const children = db.prepare(`
      SELECT id, title, source, linked_item_id, depth, status FROM factory_work_items
      WHERE linked_item_id = ?
    `).all(item.id);
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.source === 'recovery_split')).toBe(true);
    expect(children.every((c) => c.status === 'pending')).toBe(true);
    expect(children.every((c) => c.depth === 1)).toBe(true);
  });

  it('routes unrecoverable outcomes to needs_review (inbox)', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy({
      replan: async () => ({ outcome: 'unrecoverable', reason: 'rewrite_response_invalid' }),
    }));
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const updated = factoryIntake.getWorkItem(item.id);
    expect(updated.status).toBe('needs_review');
    expect(updated.recovery_attempts).toBe(1);
  });

  it('respects cooldown ladder: skips items whose last_recovery_at is too recent', async () => {
    const project = createDarkProject(testDir);
    const recentMs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    createRejectedItem(db, project.id, {
      recoveryAttempts: 1,
      lastRecoveryAt: recentMs,
    });
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig() });
    expect(actions.find((a) => a.action === 'rewrote')).toBeUndefined();
  });

  it('routes items at hard-cap to needs_review without invoking strategy', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id, { recoveryAttempts: 3 });
    const registry = createRegistry();
    let strategyInvoked = false;
    registry.register(stubStrategy({
      replan: async () => { strategyInvoked = true; return { outcome: 'rewrote', updates: {} }; },
    }));
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const updated = factoryIntake.getWorkItem(item.id);
    expect(updated.status).toBe('needs_review');
    expect(strategyInvoked).toBe(false);
  });

  it('respects per-project per-sweep throttle (1 by default)', async () => {
    const project = createDarkProject(testDir);
    createRejectedItem(db, project.id, { rejectReason: 'cannot_generate_plan: a' });
    createRejectedItem(db, project.id, { rejectReason: 'cannot_generate_plan: b' });
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig({ maxPerProjectPerSweep: 1 }) });
    const reopened = actions.filter((a) => a.action === 'rewrote');
    expect(reopened).toHaveLength(1);
  });

  it('respects global per-sweep cap', async () => {
    const projA = createDarkProject(testDir);
    const projB = createDarkProject(testDir);
    createRejectedItem(db, projA.id);
    createRejectedItem(db, projB.id);
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig({ maxGlobalPerSweep: 1 }) });
    const reopened = actions.filter((a) => a.action === 'rewrote');
    expect(reopened).toHaveLength(1);
  });

  it('skips projects with too many open items (backpressure)', async () => {
    const project = createDarkProject(testDir);
    createRejectedItem(db, project.id);
    factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'open A', description: 'x' });
    factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'open B', description: 'x' });
    factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'open C', description: 'x' });
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    const actions = await dispatcher.runSweep({ config: baseConfig({ skipIfOpenCountGte: 3 }) });
    expect(actions.find((a) => a.action === 'rewrote')).toBeUndefined();
    expect(actions.find((a) => a.action === 'skipped_project_backpressure')).toBeDefined();
  });

  it('on strategy failure: increments attempts but does not change status', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy({ replan: async () => { throw new Error('boom'); } }));
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const updated = factoryIntake.getWorkItem(item.id);
    expect(updated.status).toBe('rejected');
    expect(updated.recovery_attempts).toBe(1);
    expect(updated.last_recovery_at).not.toBeNull();
  });

  it('appends to recovery_history_json (capped at historyMaxEntries)', async () => {
    const project = createDarkProject(testDir);
    const item = createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const updated = factoryIntake.getWorkItem(item.id);
    const history = JSON.parse(updated.recovery_history_json || '[]');
    expect(history).toHaveLength(1);
    expect(history[0].strategy).toBe('stub');
    expect(history[0].outcome).toBe('rewrote');
  });

  it('logs a factory_decisions entry per dispatch', async () => {
    const project = createDarkProject(testDir);
    createRejectedItem(db, project.id);
    const registry = createRegistry();
    registry.register(stubStrategy());
    const dispatcher = createDispatcher({ db, logger: noopLogger, registry });
    await dispatcher.runSweep({ config: baseConfig() });
    const decisions = db.prepare(`
      SELECT action FROM factory_decisions WHERE action LIKE 'replan_recovery%'
    `).all();
    expect(decisions.find((d) => d.action === 'replan_recovery_attempted')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/replan-recovery.test.js`
Expected: FAIL — `replan-recovery.js` doesn't exist.

- [ ] **Step 3: Implement the dispatcher**

Create `server/factory/replan-recovery.js` (full source — see `replan-recovery-dispatcher.js.snippet` notes below). The dispatcher must implement these helpers and the `createDispatcher` / `runReplanRecoverySweep` / `cleanupStaleReplanClaims` exports:

Key implementation points:
- `RECOVERABLE_TERMINAL_STATUSES = ['rejected', 'unactionable']`
- `listEligible(db, ...)` — paginated SQL query; final reason match in JS via `strategyPatterns.some((p) => p.test(reason))`
- `isCooldownElapsed(row, cooldownMs, nowMs)` — reads `cooldownMs[Math.min(row.recovery_attempts, cooldownMs.length-1)]`
- `appendHistory(currentJson, entry, max)` — JSON parse + push + cap to last `max` entries
- `runStrategyWithTimeout(strategy, args, timeoutMs)` — wraps `strategy.replan(args)` in `Promise.race` with `setTimeout`
- Per-outcome appliers:
  - `applyRewrote`: `UPDATE factory_work_items SET status='pending', title=?, description=?, constraints_json=?, reject_reason=NULL, claimed_by_instance_id=NULL, recovery_attempts=?, recovery_history_json=?, last_recovery_at=?, updated_at=? WHERE id=?`
  - `applyEscalated`: same as rewrote but merges `updates.constraints` into existing `constraints_json`
  - `applySplit`: wraps in `db.transaction(() => {...})`. For each child, calls `factoryIntake.createWorkItem` with `source: 'recovery_split'`, then `UPDATE factory_work_items SET linked_item_id=?, depth=? WHERE id=?`. Finally marks parent `superseded` with `reject_reason='split_into_recovery_children'`.
  - `applyUnrecoverable`: `UPDATE` to `status='needs_review'`
  - `applyFailureNoStatusChange`: only updates counters and history, leaves status alone
- `claimItem(db, workItem, instanceClaim)`: writes `claimed_by_instance_id` and `last_recovery_at` BEFORE invoking strategy
- `createDispatcher` returns `{ runSweep }` — orchestrates the per-item loop:
  1. Hard-cap check (defensive — query should already filter)
  2. Cooldown check
  3. Per-project sweep throttle
  4. Global throttle
  5. Project backpressure check (`getOpenWorkItemCountForProject` via `factoryIntake.listOpenWorkItems`)
  6. Strategy lookup via `registry.findByReason`
  7. Claim
  8. Run with timeout
  9. Apply outcome in single transaction
  10. Write `factory_decisions` entry
  11. Emit event-bus event
- `runReplanRecoverySweep` is the throttled wrapper: returns `[]` if disabled or if last sweep was within `sweepIntervalMs`. Updates `lastSweepAtMs` module-level state (resettable via `resetReplanRecoverySweepStateForTests`).
- `cleanupStaleReplanClaims(db, currentInstanceId)`: `UPDATE factory_work_items SET claimed_by_instance_id=NULL WHERE claimed_by_instance_id LIKE '%:replan' AND claimed_by_instance_id NOT LIKE '<currentInstanceId>:replan'`. Returns count of cleared rows.

Constants exported: `DECISION_ACTION_ATTEMPTED = 'replan_recovery_attempted'`, `DECISION_ACTION_NO_STRATEGY = 'replan_recovery_no_strategy'`, `DECISION_ACTION_FAILED = 'replan_recovery_strategy_failed'`, `DECISION_ACTION_SPLIT = 'replan_recovery_split'`, `DECISION_ACTION_EXHAUSTED = 'replan_recovery_exhausted'`.

For the full reference implementation, mirror the structure of `server/factory/rejected-recovery.js` (similar shape: per-tick eligibility scan, decision logging, throttling). The only structural differences are: outcome-branched dispatch (rewrote/split/escalated/unrecoverable/failed), pre-strategy claim, and event-bus emission.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/replan-recovery.test.js`
Expected: PASS — all 11 cases green. If any fail, read the assertion and adjust the dispatcher logic; do not modify the test to match buggy behavior.

- [ ] **Step 5: Commit**

```bash
git add server/factory/replan-recovery.js server/tests/replan-recovery.test.js
git commit -m "feat(replan-recovery): dispatcher with cooldown ladder, hard-cap, throttling"
```

---

## Task 10: Wire dispatcher into factory-tick + register strategies + disjointness assertion

**Files:**
- Modify: `server/factory/factory-tick.js`
- Modify: `server/factory/rejected-recovery.js` (add `dismissed_from_inbox:*` to NON_RECOVERABLE patterns)
- Create: `server/factory/replan-recovery-bootstrap.js`
- Test: `server/tests/replan-recovery-tick-integration.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/replan-recovery-tick-integration.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

describe('factory-tick wires runReplanRecoverySweep', () => {
  beforeEach(() => { setupTestDbOnly(`replan-tick-${Date.now()}`); });
  afterEach(() => { teardownTestDb(); });

  it('CLOSED_FACTORY_WORK_ITEM_STATUSES includes needs_review and superseded', async () => {
    const factoryTick = require('../factory/factory-tick');
    expect(factoryTick.CLOSED_FACTORY_WORK_ITEM_STATUSES.has('needs_review')).toBe(true);
    expect(factoryTick.CLOSED_FACTORY_WORK_ITEM_STATUSES.has('superseded')).toBe(true);
  });
});

describe('rejected-recovery non-recoverable patterns', () => {
  it('treats dismissed_from_inbox as non-recoverable', () => {
    const { isAutoRejectedReason } = require('../factory/rejected-recovery');
    expect(isAutoRejectedReason('dismissed_from_inbox: user does not want this')).toBe(false);
  });
});

describe('startup disjointness assertion', () => {
  it('passes when replan reasons and rejected-recovery patterns are disjoint', () => {
    const { defaultRegistry } = require('../factory/recovery-strategies/registry');
    const rewriteStrategy = require('../factory/recovery-strategies/rewrite-description');
    const decomposeStrategy = require('../factory/recovery-strategies/decompose');
    const escalateStrategy = require('../factory/recovery-strategies/escalate-architect');
    defaultRegistry.clear();
    defaultRegistry.register(rewriteStrategy);
    defaultRegistry.register(decomposeStrategy);
    defaultRegistry.register(escalateStrategy);
    const { assertDisjointReasonPatterns } = require('../factory/replan-recovery-bootstrap');
    expect(() => assertDisjointReasonPatterns()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/replan-recovery-tick-integration.test.js`
Expected: FAIL — `replan-recovery-bootstrap` doesn't exist; `CLOSED_FACTORY_WORK_ITEM_STATUSES` may not be exported from factory-tick.

- [ ] **Step 3: Update `CLOSED_FACTORY_WORK_ITEM_STATUSES` in `factory-tick.js`**

Find the line `const CLOSED_FACTORY_WORK_ITEM_STATUSES = new Set([...])` (around line 51) and update:

```js
const CLOSED_FACTORY_WORK_ITEM_STATUSES = new Set([
  'completed', 'shipped', 'rejected', 'unactionable', 'needs_review', 'superseded',
]);
```

If `factory-tick.js` doesn't already export `CLOSED_FACTORY_WORK_ITEM_STATUSES`, add it to the `module.exports` block at the bottom.

- [ ] **Step 4: Add `dismissed_from_inbox:*` to `NON_RECOVERABLE_REJECT_REASON_PATTERNS` in `rejected-recovery.js`**

Find the constant (around line 47) and append a pattern:

```js
const NON_RECOVERABLE_REJECT_REASON_PATTERNS = Object.freeze([
  /^cannot_generate_plan:/i,
  /^replan_generation_failed$/i,
  /^plan_quality_gate_rejected_after_2_attempts$/i,
  /^dismissed_from_inbox:/i,
]);
```

- [ ] **Step 5: Create the disjointness assertion bootstrap module**

Create `server/factory/replan-recovery-bootstrap.js`:

```js
'use strict';

const { defaultRegistry } = require('./recovery-strategies/registry');

// Mirror of AUTO_REJECT_REASON_PATTERNS + AUTO_UNACTIONABLE_REASON_PATTERNS
// from rejected-recovery.js. Re-declared here as the canonical "what infra
// recovery owns" list for disjointness assertion. If those patterns drift,
// update both places — the regression test guards us.
const REJECTED_RECOVERY_PATTERNS = Object.freeze([
  /^auto_/i,
  /auto[-_ ]rejected/i,
  /^verify_failed_after_\d+_retries$/i,
  /^no_worktree_for_batch/i,
  /^consecutive_empty_executions$/i,
  /^stuck_executing_over_1h_no_progress/i,
  /^execute_spin_loop_\d+_starts_in_5min$/i,
  /^worktree_creation_failed:/i,
  /^execute_exception:/i,
  /^task_.+_failed$/i,
  /^worktree_and_branch_lost_during_verify$/i,
  /^dep_cascade_exhausted:/i,
  /^dep_resolver_unresolvable:/i,
  /^branch_stale_vs_base$/i,
  /^branch_stale_vs_master$/i,
]);

function patternStringsOverlap(a, b) {
  const sourceA = a.source.toLowerCase();
  const sourceB = b.source.toLowerCase();
  if (sourceA === sourceB) return true;
  return sourceA.includes(sourceB) || sourceB.includes(sourceA);
}

function assertDisjointReasonPatterns() {
  const replanPatterns = defaultRegistry.allReasonPatterns();
  for (const r of replanPatterns) {
    for (const j of REJECTED_RECOVERY_PATTERNS) {
      if (patternStringsOverlap(r, j)) {
        throw new Error(
          `replan-recovery / rejected-recovery pattern overlap: ${r} vs ${j}. ` +
          `One sweep would double-dispatch. Make patterns disjoint.`,
        );
      }
    }
  }
}

function bootstrapReplanRecovery() {
  const rewrite = require('./recovery-strategies/rewrite-description');
  const decompose = require('./recovery-strategies/decompose');
  const escalate = require('./recovery-strategies/escalate-architect');
  for (const s of [rewrite, decompose, escalate]) {
    const existing = defaultRegistry.list().find((x) => x.name === s.name);
    if (!existing) defaultRegistry.register(s);
  }
  assertDisjointReasonPatterns();
}

module.exports = {
  assertDisjointReasonPatterns,
  bootstrapReplanRecovery,
};
```

- [ ] **Step 6: Wire `runReplanRecoverySweep` into `factory-tick.js`**

In `server/factory/factory-tick.js`, find the existing `await runRejectedRecoverySweep({...})` call (around line 984) and add immediately after it:

```js
        // Replan-recovery: idea-side rejection sweep (off by default; enable per-environment)
        try {
          const { runReplanRecoverySweep } = require('./replan-recovery');
          const { bootstrapReplanRecovery } = require('./replan-recovery-bootstrap');
          const { getReplanRecoveryConfig } = require('../db/config-core');
          bootstrapReplanRecovery();
          await runReplanRecoverySweep({
            db,
            logger,
            config: getReplanRecoveryConfig(),
            eventBus,
            instanceId: process.env.TORQUE_INSTANCE_ID || 'default',
          });
        } catch (err) {
          logger.error('replan-recovery sweep threw', { err: err.message });
        }
```

(Adapt `db`, `logger`, `eventBus` to match the surrounding scope. Read the surrounding 20 lines first.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/replan-recovery-tick-integration.test.js`
Expected: PASS — all 3 cases green.

- [ ] **Step 8: Commit**

```bash
git add server/factory/factory-tick.js server/factory/rejected-recovery.js server/factory/replan-recovery-bootstrap.js server/tests/replan-recovery-tick-integration.test.js
git commit -m "feat(replan-recovery): wire dispatcher into factory-tick with disjointness guard"
```

---

## Task 11: Event-bus events for replan-recovery

**Files:**
- Modify: `server/event-bus.js`
- Test: `server/tests/replan-recovery-event-bus.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/replan-recovery-event-bus.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const eventBus = require('../event-bus');

describe('event-bus replan-recovery events', () => {
  it('exposes emitFactoryReplanRecoveryAttempted and onFactoryReplanRecoveryAttempted', () => {
    expect(typeof eventBus.emitFactoryReplanRecoveryAttempted).toBe('function');
    expect(typeof eventBus.onFactoryReplanRecoveryAttempted).toBe('function');
  });

  it('exposes emitFactoryReplanRecoveryExhausted and onFactoryReplanRecoveryExhausted', () => {
    expect(typeof eventBus.emitFactoryReplanRecoveryExhausted).toBe('function');
    expect(typeof eventBus.onFactoryReplanRecoveryExhausted).toBe('function');
  });

  it('attempted event delivers payload to subscribers', () => new Promise((resolve) => {
    eventBus.onFactoryReplanRecoveryAttempted((data) => {
      expect(data).toEqual({ work_item_id: 42, strategy: 'rewrite-description', outcome: 'rewrote' });
      resolve();
    });
    eventBus.emitFactoryReplanRecoveryAttempted({ work_item_id: 42, strategy: 'rewrite-description', outcome: 'rewrote' });
  }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/replan-recovery-event-bus.test.js`
Expected: FAIL — emitters don't exist.

- [ ] **Step 3: Add the emitters**

In `server/event-bus.js`, find the existing `emitFactoryPlanRejectedFinal`/`onFactoryPlanRejectedFinal` pair (around line 50) and add immediately after:

```js
    emitFactoryReplanRecoveryAttempted: (data) => emitter.emit('factory:replan_recovery_attempted', data),
    onFactoryReplanRecoveryAttempted: (fn) => emitter.on('factory:replan_recovery_attempted', fn),
    emitFactoryReplanRecoveryExhausted: (data) => emitter.emit('factory:replan_recovery_exhausted', data),
    onFactoryReplanRecoveryExhausted: (fn) => emitter.on('factory:replan_recovery_exhausted', fn),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/replan-recovery-event-bus.test.js`
Expected: PASS — all 3 cases green.

- [ ] **Step 5: Commit**

```bash
git add server/event-bus.js server/tests/replan-recovery-event-bus.test.js
git commit -m "feat(replan-recovery): event-bus emitters for attempted/exhausted"
```

---

## Task 12: Inbox MCP tool handlers

**Files:**
- Create: `server/handlers/recovery-inbox-handlers.js`
- Modify: `server/core-tools.js` (add 4 tool names)
- Modify: `server/index.js` (wire handlers — pattern depends on the file's existing dispatch shape)
- Test: `server/tests/recovery-inbox-handlers.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/recovery-inbox-handlers.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const handlers = require('../handlers/recovery-inbox-handlers');

const noopLogger = { warn() {}, error() {}, info() {} };

function createInboxItem(db, projectId, {
  attempts = 3,
  history = [{ attempt: 1, strategy: 'rewrite-description', outcome: 'failed', timestamp: '2026-04-29T00:00:00Z' }],
  rejectReason = 'plan_quality_gate_rejected_after_2_attempts',
} = {}) {
  const item = factoryIntake.createWorkItem({
    project_id: projectId,
    source: 'manual',
    title: `Inbox item ${Math.random().toString(16).slice(2)}`,
    description: 'desc',
    status: 'needs_review',
  });
  db.prepare(`
    UPDATE factory_work_items
    SET reject_reason = ?, recovery_attempts = ?, recovery_history_json = ?, last_recovery_at = ?
    WHERE id = ?
  `).run(rejectReason, attempts, JSON.stringify(history), new Date().toISOString(), item.id);
  return factoryIntake.getWorkItem(item.id);
}

function createDarkProject(testDir) {
  const suffix = Math.random().toString(16).slice(2);
  const project = factoryHealth.registerProject({
    name: `Inbox ${suffix}`,
    path: `${testDir}/${suffix}`,
    trust_level: 'dark',
    config: { loop: { auto_continue: false } },
  });
  return factoryHealth.updateProject(project.id, { status: 'running' });
}

describe('recovery-inbox handlers', () => {
  let db, testDir;
  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`recovery-inbox-${Date.now()}`));
    db = rawDb();
  });
  afterEach(() => { teardownTestDb(); });

  describe('list_recovery_inbox', () => {
    it('returns items with status needs_review only', async () => {
      const project = createDarkProject(testDir);
      createInboxItem(db, project.id);
      factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'open', description: 'd' });
      const result = await handlers.listRecoveryInbox({ logger: noopLogger });
      expect(result.items.length).toBe(1);
      expect(result.items[0].status).toBe('needs_review');
      expect(result.items[0].why_we_gave_up).toMatch(/rewrite-description/i);
    });

    it('filters by project_id', async () => {
      const projA = createDarkProject(testDir);
      const projB = createDarkProject(testDir);
      createInboxItem(db, projA.id);
      createInboxItem(db, projB.id);
      const result = await handlers.listRecoveryInbox({ project_id: projA.id, logger: noopLogger });
      expect(result.items.length).toBe(1);
      expect(result.items[0].project_id).toBe(projA.id);
    });
  });

  describe('inspect_recovery_item', () => {
    it('returns full detail with parsed history', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      const result = await handlers.inspectRecoveryItem({ id: item.id, logger: noopLogger });
      expect(result.item.id).toBe(item.id);
      expect(Array.isArray(result.history)).toBe(true);
      expect(result.history[0].strategy).toBe('rewrite-description');
    });

    it('throws when id not found', async () => {
      await expect(handlers.inspectRecoveryItem({ id: 999999, logger: noopLogger })).rejects.toThrow();
    });
  });

  describe('revive_recovery_item', () => {
    it('mode=retry resets attempts and sets status to pending', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await handlers.reviveRecoveryItem({ id: item.id, mode: 'retry', logger: noopLogger });
      const updated = factoryIntake.getWorkItem(item.id);
      expect(updated.status).toBe('pending');
      expect(updated.recovery_attempts).toBe(0);
      expect(updated.reject_reason).toBeNull();
    });

    it('mode=edit applies updates and resets attempts', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await handlers.reviveRecoveryItem({
        id: item.id,
        mode: 'edit',
        updates: { title: 'New title', description: 'New description '.repeat(20) },
        logger: noopLogger,
      });
      const updated = factoryIntake.getWorkItem(item.id);
      expect(updated.status).toBe('pending');
      expect(updated.title).toBe('New title');
      expect(updated.description).toMatch(/New description/);
      expect(updated.recovery_attempts).toBe(0);
    });

    it('mode=split creates children and marks parent superseded', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await handlers.reviveRecoveryItem({
        id: item.id,
        mode: 'split',
        children: [
          { title: 'Child A', description: 'a'.repeat(150) },
          { title: 'Child B', description: 'b'.repeat(150) },
        ],
        logger: noopLogger,
      });
      const parent = factoryIntake.getWorkItem(item.id);
      expect(parent.status).toBe('superseded');
      const children = db.prepare(`SELECT * FROM factory_work_items WHERE linked_item_id = ?`).all(item.id);
      expect(children.length).toBe(2);
    });

    it('throws on unknown mode', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await expect(handlers.reviveRecoveryItem({ id: item.id, mode: 'bogus', logger: noopLogger })).rejects.toThrow();
    });
  });

  describe('dismiss_recovery_item', () => {
    it('flips status to unactionable with dismissed_from_inbox reject_reason', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await handlers.dismissRecoveryItem({ id: item.id, reason: 'no longer needed', logger: noopLogger });
      const updated = factoryIntake.getWorkItem(item.id);
      expect(updated.status).toBe('unactionable');
      expect(updated.reject_reason).toMatch(/^dismissed_from_inbox: no longer needed$/);
    });

    it('writes a decision-log entry', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await handlers.dismissRecoveryItem({ id: item.id, reason: 'duplicate', logger: noopLogger });
      const decision = db.prepare(`
        SELECT * FROM factory_decisions WHERE action = 'recovery_inbox_dismissed' ORDER BY id DESC LIMIT 1
      `).get();
      expect(decision).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/recovery-inbox-handlers.test.js`
Expected: FAIL — handlers module doesn't exist.

- [ ] **Step 3: Implement the handlers**

Create `server/handlers/recovery-inbox-handlers.js`:

```js
'use strict';

const factoryIntake = require('../db/factory-intake');
const factoryDecisions = require('../db/factory-decisions');
const decisionLog = require('../factory/decision-log');
const { defaultContainer } = require('../container');

const DECISION_STAGE = 'recover';
const DECISION_ACTOR = 'inbox-operator';

function getDb() { return defaultContainer.get('db'); }

function deriveWhyWeGaveUp(historyJson) {
  let arr = [];
  try { arr = JSON.parse(historyJson || '[]'); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
  if (arr.length === 0) return 'no recovery attempts recorded';
  const last = arr[arr.length - 1];
  return `last attempt #${last.attempt}: strategy "${last.strategy}" -> ${last.outcome}${last.reason ? ` (${last.reason})` : ''}`;
}

async function listRecoveryInbox({ project_id = null } = {}) {
  const db = getDb();
  const params = ['needs_review'];
  let projectClause = '';
  if (project_id) {
    projectClause = ' AND project_id = ?';
    params.push(project_id);
  }
  const rows = db.prepare(`
    SELECT id, project_id, title, reject_reason, recovery_attempts, last_recovery_at, recovery_history_json, updated_at
    FROM factory_work_items
    WHERE status = ?${projectClause}
    ORDER BY recovery_attempts DESC, updated_at DESC
  `).all(...params);
  return {
    items: rows.map((r) => ({
      id: r.id,
      project_id: r.project_id,
      status: 'needs_review',
      title: r.title,
      original_reject_reason: r.reject_reason,
      recovery_attempts: r.recovery_attempts,
      last_recovery_at: r.last_recovery_at,
      why_we_gave_up: deriveWhyWeGaveUp(r.recovery_history_json),
    })),
  };
}

async function inspectRecoveryItem({ id }) {
  const db = getDb();
  factoryIntake.setDb(db);
  const item = factoryIntake.getWorkItem(id);
  if (!item) throw new Error(`recovery inbox item ${id} not found`);
  let history = [];
  try { history = JSON.parse(item.recovery_history_json || '[]'); if (!Array.isArray(history)) history = []; } catch { /* ignore */ }
  const decisions = db.prepare(`
    SELECT id, stage, actor, action, reasoning, inputs_json, outcome_json, created_at
    FROM factory_decisions
    WHERE batch_id = ?
    ORDER BY created_at ASC
  `).all(`replan-recovery:${id}`);
  return { item, history, decisions };
}

async function reviveRecoveryItem({ id, mode, updates = null, children = null }) {
  const db = getDb();
  factoryIntake.setDb(db);
  factoryDecisions.setDb(db);
  const item = factoryIntake.getWorkItem(id);
  if (!item) throw new Error(`recovery inbox item ${id} not found`);
  if (item.status !== 'needs_review') {
    throw new Error(`item ${id} is not in needs_review (status: ${item.status})`);
  }

  const now = new Date().toISOString();

  if (mode === 'retry') {
    db.prepare(`
      UPDATE factory_work_items
      SET status = 'pending',
          reject_reason = NULL,
          recovery_attempts = 0,
          claimed_by_instance_id = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
  } else if (mode === 'edit') {
    if (!updates || typeof updates !== 'object') throw new Error(`mode=edit requires updates object`);
    const title = updates.title != null ? updates.title : item.title;
    const description = updates.description != null ? updates.description : item.description;
    const constraintsJson = updates.constraints != null ? JSON.stringify(updates.constraints) : item.constraints_json;
    db.prepare(`
      UPDATE factory_work_items
      SET status = 'pending',
          title = ?,
          description = ?,
          constraints_json = ?,
          reject_reason = NULL,
          recovery_attempts = 0,
          claimed_by_instance_id = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(title, description, constraintsJson, now, id);
  } else if (mode === 'split') {
    if (!Array.isArray(children) || children.length < 2) {
      throw new Error(`mode=split requires children array of length >= 2`);
    }
    const tx = db.transaction(() => {
      for (const child of children) {
        const created = factoryIntake.createWorkItem({
          project_id: item.project_id,
          source: 'recovery_split',
          title: child.title,
          description: child.description,
          priority: Math.max(0, Number(item.priority || 50) - 1),
        });
        db.prepare(`UPDATE factory_work_items SET linked_item_id = ?, depth = ? WHERE id = ?`)
          .run(item.id, Number(item.depth || 0) + 1, created.id);
      }
      db.prepare(`
        UPDATE factory_work_items
        SET status = 'superseded',
            reject_reason = 'split_into_recovery_children',
            updated_at = ?
        WHERE id = ?
      `).run(now, id);
    });
    tx();
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }

  decisionLog.logDecision({
    project_id: item.project_id,
    stage: DECISION_STAGE,
    actor: DECISION_ACTOR,
    action: 'recovery_inbox_revived',
    reasoning: `Item ${id} revived from inbox via mode "${mode}".`,
    inputs: { work_item_id: id, mode, updates_summary: updates ? Object.keys(updates) : null, child_count: children?.length || 0 },
    outcome: { mode },
    confidence: 1,
    batch_id: `replan-recovery:${id}`,
  });

  return { ok: true, mode };
}

async function dismissRecoveryItem({ id, reason }) {
  const db = getDb();
  factoryIntake.setDb(db);
  factoryDecisions.setDb(db);
  const item = factoryIntake.getWorkItem(id);
  if (!item) throw new Error(`recovery inbox item ${id} not found`);
  if (item.status !== 'needs_review') {
    throw new Error(`item ${id} is not in needs_review (status: ${item.status})`);
  }
  const safeReason = String(reason || 'unspecified').replace(/[\n\r]/g, ' ').slice(0, 200);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE factory_work_items
    SET status = 'unactionable',
        reject_reason = ?,
        updated_at = ?
    WHERE id = ?
  `).run(`dismissed_from_inbox: ${safeReason}`, now, id);

  decisionLog.logDecision({
    project_id: item.project_id,
    stage: DECISION_STAGE,
    actor: DECISION_ACTOR,
    action: 'recovery_inbox_dismissed',
    reasoning: `Item ${id} dismissed from inbox: ${safeReason}`,
    inputs: { work_item_id: id, reason: safeReason },
    outcome: { status: 'unactionable' },
    confidence: 1,
    batch_id: `replan-recovery:${id}`,
  });

  return { ok: true, reason: safeReason };
}

module.exports = {
  listRecoveryInbox,
  inspectRecoveryItem,
  reviveRecoveryItem,
  dismissRecoveryItem,
};
```

- [ ] **Step 4: Register the four MCP tool names in `core-tools.js`**

Find line 74 (the existing `'create_work_item', 'list_work_items', ...` array) and append the four new names to the same array:

```js
  'create_work_item', 'list_work_items', 'update_work_item', 'reject_work_item', 'intake_from_findings', 'scan_plans_directory', 'execute_plan_file', 'get_plan_execution_status', 'list_plan_intake_items', 'poll_github_issues', 'architect_log',
  'list_recovery_inbox', 'inspect_recovery_item', 'revive_recovery_item', 'dismiss_recovery_item',
```

- [ ] **Step 5: Wire handlers into `server/index.js`**

Read `server/index.js` and find where `list_work_items` (or another factory-intake tool) is dispatched. Mirror that pattern. Typical:

```js
case 'list_recovery_inbox':
  return await require('./handlers/recovery-inbox-handlers').listRecoveryInbox(args);
case 'inspect_recovery_item':
  return await require('./handlers/recovery-inbox-handlers').inspectRecoveryItem(args);
case 'revive_recovery_item':
  return await require('./handlers/recovery-inbox-handlers').reviveRecoveryItem(args);
case 'dismiss_recovery_item':
  return await require('./handlers/recovery-inbox-handlers').dismissRecoveryItem(args);
```

(If `server/index.js` uses a tool-handler map rather than a switch, register into that map instead.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/recovery-inbox-handlers.test.js`
Expected: PASS — all 9 cases green.

- [ ] **Step 7: Commit**

```bash
git add server/handlers/recovery-inbox-handlers.js server/core-tools.js server/index.js server/tests/recovery-inbox-handlers.test.js
git commit -m "feat(replan-recovery): inbox MCP tools (list/inspect/revive/dismiss)"
```

---

## Task 13: Slash command — `/torque-recovery-inbox`

**Files:**
- Create: `.claude/commands/torque-recovery-inbox.md`

- [ ] **Step 1: Create the command file**

Create `.claude/commands/torque-recovery-inbox.md`:

```markdown
---
description: Triage rejected work items that exhausted auto-recovery
---

# /torque-recovery-inbox [project]

Surface and triage factory work items that were auto-rejected, attempted by replan-recovery up to the hard cap, and routed to the `needs_review` inbox.

## Workflow

1. Call `list_recovery_inbox` (optionally with `project_id` if the user gave one). Format the result as a table sorted by `recovery_attempts` descending — most-stuck first.

2. For each item the user wants to act on, call `inspect_recovery_item` to load full history (work item + recovery_history_json + factory_decisions entries).

3. Propose ONE of:
   - **retry as-is** — reset attempts, status -> pending. Use when codebase has clearly evolved since the original failure.
   - **edit and retry** — suggest a rewritten title/description based on the prior failure history; user confirms; call `revive_recovery_item` with `mode: 'edit'`.
   - **decompose** — suggest 2-3 child specs; user confirms; call `revive_recovery_item` with `mode: 'split'` and `children`.
   - **dismiss** — call `dismiss_recovery_item` with `reason`. The item flips to `unactionable` permanently and is excluded from future recovery sweeps.

4. After each action, summarize what changed and offer the next item.

## Notes

- The four MCP tools (`list_recovery_inbox`, `inspect_recovery_item`, `revive_recovery_item`, `dismiss_recovery_item`) are the only authoritative path. Do not modify items via raw SQL or `update_work_item`.
- Dismissals are logged to `factory_decisions` as `recovery_inbox_dismissed`. Revivals as `recovery_inbox_revived`. Both are auditable alongside auto-recovery decisions.
- The inbox is a human-in-the-loop surface — never claim items "automatically" without explicit user choice.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/torque-recovery-inbox.md
git commit -m "feat(replan-recovery): /torque-recovery-inbox slash command"
```

---

## Task 14: Startup hook — register strategies + cleanup stale claims

**Files:**
- Modify: `server/index.js` (add bootstrap call)
- Test: `server/tests/replan-recovery-startup.test.js`

- [ ] **Step 1: Write the test**

Create `server/tests/replan-recovery-startup.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const factoryIntake = require('../db/factory-intake');
const factoryHealth = require('../db/factory-health');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { cleanupStaleReplanClaims } = require('../factory/replan-recovery');

describe('cleanupStaleReplanClaims', () => {
  let db, testDir;
  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`replan-startup-${Date.now()}`));
    db = rawDb();
  });
  afterEach(() => { teardownTestDb(); });

  it('clears claims from prior instances; preserves current instance claims', () => {
    const project = factoryHealth.registerProject({
      name: 'startup test',
      path: testDir,
      trust_level: 'dark',
      config: { loop: { auto_continue: false } },
    });
    factoryHealth.updateProject(project.id, { status: 'running' });
    const itemA = factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'a', description: 'd' });
    const itemB = factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'b', description: 'd' });
    db.prepare(`UPDATE factory_work_items SET claimed_by_instance_id = 'old-uuid:replan' WHERE id = ?`).run(itemA.id);
    db.prepare(`UPDATE factory_work_items SET claimed_by_instance_id = 'current-uuid:replan' WHERE id = ?`).run(itemB.id);

    const cleared = cleanupStaleReplanClaims(db, 'current-uuid');
    expect(cleared).toBe(1);

    const a = factoryIntake.getWorkItem(itemA.id);
    const b = factoryIntake.getWorkItem(itemB.id);
    expect(a.claimed_by_instance_id).toBeNull();
    expect(b.claimed_by_instance_id).toBe('current-uuid:replan');
  });

  it('returns 0 when no stale claims exist', () => {
    expect(cleanupStaleReplanClaims(db, 'fresh-uuid')).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/replan-recovery-startup.test.js`
Expected: PASS — `cleanupStaleReplanClaims` was already implemented in Task 9.

- [ ] **Step 3: Wire the bootstrap + cleanup call into `server/index.js`**

Read `server/index.js` and find where `cleanupStaleRestartBarriers` is called on startup. Add immediately after that call:

```js
try {
  const { bootstrapReplanRecovery } = require('./factory/replan-recovery-bootstrap');
  const { cleanupStaleReplanClaims } = require('./factory/replan-recovery');
  bootstrapReplanRecovery();
  const instanceId = process.env.TORQUE_INSTANCE_ID || 'default';
  const cleared = cleanupStaleReplanClaims(db, instanceId);
  if (cleared > 0) {
    logger.info('cleanupStaleReplanClaims released stale claims', { count: cleared, instance_id: instanceId });
  }
} catch (err) {
  logger.error('replan-recovery startup hook failed', { err: err.message });
}
```

- [ ] **Step 4: Run the smoke test set**

Run: `cd server && npx vitest run tests/replan-recovery-startup.test.js tests/replan-recovery.test.js tests/replan-recovery-tick-integration.test.js`
Expected: PASS — all replan-recovery tests still green.

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/tests/replan-recovery-startup.test.js
git commit -m "feat(replan-recovery): startup bootstrap + stale-claim cleanup"
```

---

## Task 15: End-to-end integration test

**Files:**
- Create: `server/tests/replan-recovery-e2e.test.js`

- [ ] **Step 1: Write the e2e test**

Create `server/tests/replan-recovery-e2e.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const {
  runReplanRecoverySweep,
  resetReplanRecoverySweepStateForTests,
} = require('../factory/replan-recovery');
const { defaultRegistry } = require('../factory/recovery-strategies/registry');
const { bootstrapReplanRecovery } = require('../factory/replan-recovery-bootstrap');

const noopLogger = { warn() {}, error() {}, info() {} };

describe('replan-recovery end-to-end', () => {
  let db, testDir;
  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`replan-e2e-${Date.now()}`));
    db = rawDb();
    defaultRegistry.clear();
    bootstrapReplanRecovery();
    resetReplanRecoverySweepStateForTests();
  });
  afterEach(() => { teardownTestDb(); });

  it('decompose: rejected item with plan_quality_gate_rejected_after_2_attempts -> parent superseded, 2 children pending', async () => {
    const suffix = Math.random().toString(16).slice(2);
    const project = factoryHealth.registerProject({
      name: `E2E ${suffix}`,
      path: `${testDir}/${suffix}`,
      trust_level: 'dark',
      config: { loop: { auto_continue: false } },
    });
    factoryHealth.updateProject(project.id, { status: 'running' });

    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'Do an ambiguous thing across many files',
      description: 'This was too vague when first attempted; the plan-quality gate rejected it twice.',
    });
    db.prepare(`
      UPDATE factory_work_items
      SET reject_reason = 'plan_quality_gate_rejected_after_2_attempts',
          status = 'rejected',
          updated_at = ?
      WHERE id = ?
    `).run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), item.id);

    // Mock the architect: replace decomposeWorkItem with a canned response.
    const architectRunner = require('../factory/architect-runner');
    const originalDecompose = architectRunner.decomposeWorkItem;
    architectRunner.decomposeWorkItem = async () => ({
      children: [
        { title: 'Child 1: do part A', description: 'Specific child task 1 covering one aspect of the parent. '.repeat(5), acceptance_criteria: ['must X'] },
        { title: 'Child 2: do part B', description: 'Specific child task 2 covering another aspect of the parent. '.repeat(5), acceptance_criteria: ['must Y'] },
      ],
    });

    try {
      const actions = await runReplanRecoverySweep({
        db,
        logger: noopLogger,
        config: {
          enabled: true,
          sweepIntervalMs: 1,
          hardCap: 3,
          maxPerProjectPerSweep: 1,
          maxGlobalPerSweep: 5,
          skipIfOpenCountGte: 3,
          cooldownMs: [3600000, 86400000, 259200000],
          strategyTimeoutMs: 5000,
          strategyTimeoutMsEscalate: 1000,
          historyMaxEntries: 10,
          splitMaxChildren: 5,
          splitMaxDepth: 2,
        },
        instanceId: 'e2e-instance',
      });

      const splitAction = actions.find((a) => a.action === 'split');
      expect(splitAction).toBeDefined();

      const parent = factoryIntake.getWorkItem(item.id);
      expect(parent.status).toBe('superseded');
      expect(parent.reject_reason).toBe('split_into_recovery_children');

      const children = db.prepare(`
        SELECT id, title, status, source, depth, linked_item_id FROM factory_work_items
        WHERE linked_item_id = ?
        ORDER BY id ASC
      `).all(item.id);
      expect(children.length).toBe(2);
      expect(children.every((c) => c.status === 'pending')).toBe(true);
      expect(children.every((c) => c.source === 'recovery_split')).toBe(true);
      expect(children.every((c) => c.depth === 1)).toBe(true);

      const splitDecision = db.prepare(`
        SELECT * FROM factory_decisions WHERE action = 'replan_recovery_split' ORDER BY id DESC LIMIT 1
      `).get();
      expect(splitDecision).toBeDefined();

      const history = JSON.parse(parent.recovery_history_json || '[]');
      expect(history.length).toBe(1);
      expect(history[0].strategy).toBe('decompose');
      expect(history[0].outcome).toBe('split');
    } finally {
      architectRunner.decomposeWorkItem = originalDecompose;
    }
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `cd server && npx vitest run tests/replan-recovery-e2e.test.js`
Expected: PASS — full pipeline (bootstrap -> registry -> sweep -> strategy -> dispatcher -> DB updates -> decision log) green.

- [ ] **Step 3: Commit**

```bash
git add server/tests/replan-recovery-e2e.test.js
git commit -m "test(replan-recovery): e2e integration test for decompose path"
```

---

## Task 16: Run the full server test suite + final commit

- [ ] **Step 1: Run all server tests**

From the worktree root:

```bash
torque-remote npx vitest run --reporter=default
```

(Per CLAUDE.md, tests run on the remote workstation. If `torque-remote` is unavailable, fall back to `cd server && npx vitest run`.)

Expected: PASS for all replan-recovery tests AND existing tests. If any pre-existing test fails that you didn't touch, capture the failure but do NOT fix in this branch — flag it on the cutover summary.

- [ ] **Step 2: Verify the disjointness assertion fires when tampered**

Quick smoke test: open `server/factory/recovery-strategies/rewrite-description.js` and temporarily add `/^auto_/i` to `reasonPatterns`. Run:

```bash
cd server && npx vitest run tests/replan-recovery-tick-integration.test.js -t "passes when replan reasons"
```
Expected: FAIL — confirms the assertion catches drift. Then **revert the change** before committing.

- [ ] **Step 3: Verify total test counts**

```bash
cd server && npx vitest run tests/replan-recovery* tests/recovery-* tests/architect-runner-recovery-helpers.test.js --reporter=default 2>&1 | grep -E "Tests|Test Files"
```

Expected counts (approximate):
- replan-recovery-migration.test.js: 4
- replan-recovery-config.test.js: 2
- recovery-strategies-registry.test.js: 6
- recovery-strategy-rewrite-description.test.js: 6
- recovery-strategy-decompose.test.js: 8
- recovery-strategy-escalate.test.js: 5
- replan-recovery.test.js: 11
- replan-recovery-tick-integration.test.js: 3
- replan-recovery-event-bus.test.js: 3
- recovery-inbox-handlers.test.js: 9
- replan-recovery-startup.test.js: 2
- replan-recovery-e2e.test.js: 1
- architect-runner-recovery-helpers.test.js: 3

Total: ~63 tests across 13 files.

- [ ] **Step 4: Final cleanup (if any)**

```bash
git status
# (if anything to clean — lint, unused imports, etc.)
git add -p
git commit -m "chore(replan-recovery): final cleanup"
```

---

## Cutover (NOT part of plan execution — for the operator after merge approval)

When ready to land:

```bash
scripts/worktree-cutover.sh recover-rejected-replan
```

This merges to main, drains the queue, restarts TORQUE on the new code, cleans up the worktree.

After cutover:

1. **Verify disabled state.** Server starts, sweep is a no-op (`replan_recovery_enabled = '0'`).
2. **Pilot.** Set `replan_recovery_enabled = '1'` and `replan_recovery_max_global_per_sweep = '1'` via the dashboard config UI or `set_config` MCP tool. Watch for 30 minutes. Inspect `factory_decisions` for `replan_recovery_*` entries.
3. **Open the gate.** Restore `replan_recovery_max_global_per_sweep = '5'`.

Rollback: set `replan_recovery_enabled = '0'` and restart.

---

## Self-review against spec

| Spec section | Implementing tasks |
|---|---|
| Architecture overview | T9 (dispatcher), T10 (factory-tick wiring), T3 (registry) |
| Data model: needs_review, superseded, recovery_split, 4 columns | T1 |
| Strategy contract | T3, T5, T6, T7 |
| `rewrite-description` strategy | T5 |
| `decompose` strategy | T6 |
| `escalate-architect` strategy | T7 |
| Sweep eligibility / cooldown ladder / hard cap / throttling | T9 |
| Mutex with `rejected-recovery.js` | T10 (disjointness assertion) |
| Restart resilience (cleanupStaleReplanClaims) | T9 + T14 |
| Inbox MCP tools | T12 |
| Inbox slash command | T13 |
| Event-bus events | T11 |
| Configuration keys | T2 |
| Decision-log actions | T9 (replan_recovery_*), T12 (recovery_inbox_*) |
| Architect-runner helpers | T8 |
| Tests (unit + e2e) | T1-T15 |
| Rollout (disabled-by-default + pilot) | Cutover section + T2 (`replan_recovery_enabled: '0'`) |

No gaps. Plan covers the spec.

## Checklist for the executing agent

- [ ] Worktree is `feat/recover-rejected-replan` at `.worktrees/feat-recover-rejected-replan/`. Confirm with `git branch --show-current`.
- [ ] Run each task's failing test FIRST. Confirm it fails for the expected reason before implementing.
- [ ] Commit after each task. Atomic commits per `feedback_atomic_commits.md`.
- [ ] Run the full server test suite at Task 16 before considering the plan complete.
- [ ] Do NOT run `scripts/worktree-cutover.sh` — that's the operator's call after review.
- [ ] If a task's exact line number / function name in an existing file has drifted, read 20 lines around the target before editing. Do not retry the same edit twice — widen context first.
