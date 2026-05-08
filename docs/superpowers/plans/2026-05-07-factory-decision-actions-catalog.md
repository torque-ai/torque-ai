# Factory Decision-Actions Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish `server/factory/decision-actions.js` as the canonical catalog of valid `factory_decisions` actions, audit current emission sites against the catalog + classifier wiring, fix today's gaps, gate future drift via a vitest CI test, and emit `auto_recovery_unknown_action` as a production guard so dynamic-action sites and out-of-CI changes are observable.

**Architecture:** A new catalog file declares every valid action with stage, classifier kind, optional `rule_id`, and outcome key list. An audit script (regex-based, sub-second on the factory + recovery-core source tree) discovers emit sites + classifier rules + benign-skip patterns and reports four gap categories. A vitest test invokes the audit and asserts zero gaps. The recovery engine emits a tracked decision when classification routes to UNKNOWN. The doc table in `docs/factory-loop-states.md` becomes auto-generated from the catalog via a renderer script and snapshot test.

**Tech Stack:** Node.js 20+, vitest (server/), regex source parsing (no AST in v1).

**Spec:** `docs/superpowers/specs/2026-05-07-factory-decision-actions-catalog-design.md`

---

## File Structure

**New files:**
- `server/factory/decision-actions.js` — canonical catalog (single object export)
- `server/factory/scripts/audit-decision-actions.js` — discovery + cross-reference + report
- `server/factory/scripts/render-decision-actions-doc.js` — markdown renderer
- `server/tests/factory-decision-actions-catalog.test.js` — vitest CI gate
- `server/tests/audit-decision-actions.test.js` — unit tests for the audit script (synthetic fixtures)
- `server/tests/render-decision-actions-doc.test.js` — snapshot test for doc autogen

**Modified files:**
- `server/factory/auto-recovery/engine.js` — production guard emission + recursion defense
- `docs/factory-loop-states.md` — replace hand-written decision-action table with autogen block; add "Finding production drift" section; update "When changing the loop" pointers

**Function name reality check:** the spec refers to `safeLogDecision` (an abstraction in the doc). The actual function in code is `logDecision`. Two call signatures exist:
- `logDecision({ project_id, stage, action, ... })` — single-arg form, defined in `server/factory/decision-log.js:7`
- `logDecision(db, { project_id, stage, action, ... })` — db-prefix form, defined locally in `server/factory/auto-recovery/engine.js:55`

Both have the `action:` literal inside the object argument. The audit's emit-site regex must match both forms.

---

## Conventions

- Vitest tests live under `server/tests/`. Run via `npx vitest run <path>` or `npm test`.
- New scripts in `server/factory/scripts/` export programmatic functions and add a `if (require.main === module) { ... }` CLI block for ad-hoc operator use.
- Catalog entries are alphabetized within each stage block for diff stability.
- Audit script returns a structured report; CLI mode pretty-prints it; vitest test consumes the structured object directly.

---

### Task 1: Audit script — emit-site discovery

**Files:**
- Create: `server/factory/scripts/audit-decision-actions.js`
- Create: `server/tests/audit-decision-actions.test.js`

**Goal:** A function `discoverEmitSites(rootDir)` that scans `server/factory/**/*.js` and `server/plugins/auto-recovery-core/**/*.js` for `logDecision` calls, extracts literal action names, and records dynamic-action sites. Returns `{ literal_emissions: Map<action, [{file, line}]>, dynamic_action_sites: [{file, line, snippet}] }`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/audit-decision-actions.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { discoverEmitSites } = require('../factory/scripts/audit-decision-actions');

function makeFixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-decisions-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

describe('discoverEmitSites', () => {
  it('extracts literal action from single-arg logDecision({ ... })', () => {
    const dir = makeFixtureDir({
      'foo.js': `logDecision({ project_id: 1, stage: 'PLAN', action: 'generated_plan', outcome: {} });`,
    });
    const { literal_emissions, dynamic_action_sites } = discoverEmitSites(dir);
    expect([...literal_emissions.keys()]).toEqual(['generated_plan']);
    expect(dynamic_action_sites).toEqual([]);
  });

  it('extracts literal action from db-prefix logDecision(db, { ... })', () => {
    const dir = makeFixtureDir({
      'foo.js': `logDecision(db, { project_id, stage: 'verify', action: 'auto_recovery_classified', outcome: {} });`,
    });
    const { literal_emissions } = discoverEmitSites(dir);
    expect([...literal_emissions.keys()]).toEqual(['auto_recovery_classified']);
  });

  it('records dynamic-action sites where action is not a literal', () => {
    const dir = makeFixtureDir({
      'foo.js': `logDecision({ project_id: 1, action: \`prefix_\${stage}\`, outcome: {} });`,
    });
    const { literal_emissions, dynamic_action_sites } = discoverEmitSites(dir);
    expect([...literal_emissions.keys()]).toEqual([]);
    expect(dynamic_action_sites.length).toBe(1);
    expect(dynamic_action_sites[0].snippet).toContain('prefix_');
  });

  it('records the same action multiple times when emitted from multiple sites', () => {
    const dir = makeFixtureDir({
      'a.js': `logDecision({ action: 'verified_batch', outcome: {} });`,
      'b.js': `logDecision({ action: 'verified_batch', outcome: {} });`,
    });
    const { literal_emissions } = discoverEmitSites(dir);
    expect(literal_emissions.get('verified_batch').length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd server && npx vitest run tests/audit-decision-actions.test.js`
Expected: FAIL with "Cannot find module '../factory/scripts/audit-decision-actions'"

- [ ] **Step 3: Implement discoverEmitSites**

Create `server/factory/scripts/audit-decision-actions.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_GLOBS = [
  'server/factory',
  'server/plugins/auto-recovery-core',
];

// Match logDecision({ ... action: 'X' ... }) and logDecision(db, { ... action: 'X' ... }).
const EMIT_LITERAL_RE = /logDecision\s*\(\s*(?:[a-zA-Z_$][\w$]*\s*,\s*)?\{[^}]*\baction\s*:\s*['"]([\w-]+)['"]/g;

// Match logDecision call where action: is followed by a non-string-literal expression.
const EMIT_DYNAMIC_RE = /logDecision\s*\(\s*(?:[a-zA-Z_$][\w$]*\s*,\s*)?\{[^}]*\baction\s*:\s*(?!['"])([^,}\n]+)/g;

function* walkJsFiles(rootDir) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        stack.push(abs);
      } else if (ent.isFile() && ent.name.endsWith('.js') && !ent.name.endsWith('.test.js')) {
        yield abs;
      }
    }
  }
}

function fileLineFromIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function discoverEmitSites(rootDir, sourceGlobs = SOURCE_GLOBS) {
  const literal_emissions = new Map();
  const dynamic_action_sites = [];

  const resolvedRoots = sourceGlobs
    .map((g) => path.join(rootDir, g))
    .filter((p) => fs.existsSync(p));
  const rootsToWalk = resolvedRoots.length > 0 ? resolvedRoots : [rootDir];

  for (const root of rootsToWalk) {
    for (const file of walkJsFiles(root)) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        continue;
      }

      EMIT_LITERAL_RE.lastIndex = 0;
      let m;
      while ((m = EMIT_LITERAL_RE.exec(text)) !== null) {
        const action = m[1];
        const line = fileLineFromIndex(text, m.index);
        const arr = literal_emissions.get(action) || [];
        arr.push({ file: path.relative(rootDir, file), line });
        literal_emissions.set(action, arr);
      }

      EMIT_DYNAMIC_RE.lastIndex = 0;
      while ((m = EMIT_DYNAMIC_RE.exec(text)) !== null) {
        const slice = text.slice(m.index, m.index + 200);
        if (/action\s*:\s*['"]/.test(slice)) continue;

        const line = fileLineFromIndex(text, m.index);
        const snippet = m[1].trim().slice(0, 80);
        dynamic_action_sites.push({ file: path.relative(rootDir, file), line, snippet });
      }
    }
  }

  return { literal_emissions, dynamic_action_sites };
}

module.exports = {
  discoverEmitSites,
  __internals: { walkJsFiles, fileLineFromIndex },
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/audit-decision-actions.test.js`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/scripts/audit-decision-actions.js server/tests/audit-decision-actions.test.js
git commit -m "feat(factory): audit-decision-actions emit-site discovery"
```

---

### Task 2: Audit script — classifier rule + benign-skip discovery

**Files:**
- Modify: `server/factory/scripts/audit-decision-actions.js`
- Modify: `server/tests/audit-decision-actions.test.js`

**Goal:** Two new functions: `discoverClassifierRules(rootDir)` returns `{ rule_ids: Set<string>, action_matchers: Map<action, rule_id> }` from `server/plugins/auto-recovery-core/rules.js`. `discoverBenignPatterns(rootDir)` returns `{ exact: Set<string>, prefixes: Set<string> }` from `server/factory/auto-recovery/engine.js`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/audit-decision-actions.test.js`:

```js
const { discoverClassifierRules, discoverBenignPatterns } = require('../factory/scripts/audit-decision-actions');

describe('discoverClassifierRules', () => {
  it('extracts rule ids and action matchers from rules.js', () => {
    const dir = makeFixtureDir({
      'server/plugins/auto-recovery-core/rules.js': `
        module.exports = [
          {
            id: 'execute_zero_diff_short_circuit',
            match: (decision) => decision.action === 'execute_zero_diff_short_circuit',
            classify: () => ({ category: 'transient' }),
          },
          {
            id: 'phantom_completion_detected',
            match: (decision) => decision.action === 'phantom_completion_detected',
            classify: () => ({ category: 'phantom' }),
          },
        ];
      `,
    });
    const { rule_ids, action_matchers } = discoverClassifierRules(dir);
    expect(rule_ids.has('execute_zero_diff_short_circuit')).toBe(true);
    expect(rule_ids.has('phantom_completion_detected')).toBe(true);
    expect(action_matchers.get('execute_zero_diff_short_circuit')).toBe('execute_zero_diff_short_circuit');
    expect(action_matchers.get('phantom_completion_detected')).toBe('phantom_completion_detected');
  });
});

describe('discoverBenignPatterns', () => {
  it('extracts exact action names and prefixes from isBenignFlowDecision', () => {
    const dir = makeFixtureDir({
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([
          'scanned_plans',
          'verified_batch',
          'gate_approved',
        ]);
        const BENIGN_FLOW_ACTION_PREFIXES = ['started_', 'completed_'];
        function isBenignFlowDecision(decision) { /* ... */ }
      `,
    });
    const { exact, prefixes } = discoverBenignPatterns(dir);
    expect(exact.has('scanned_plans')).toBe(true);
    expect(exact.has('verified_batch')).toBe(true);
    expect(exact.has('gate_approved')).toBe(true);
    expect(prefixes.has('started_')).toBe(true);
    expect(prefixes.has('completed_')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd server && npx vitest run tests/audit-decision-actions.test.js`
Expected: 2 new tests FAIL.

- [ ] **Step 3: Implement discoverClassifierRules and discoverBenignPatterns**

Append to `server/factory/scripts/audit-decision-actions.js`:

```js
function discoverClassifierRules(rootDir) {
  const rule_ids = new Set();
  const action_matchers = new Map();

  const rulesFile = path.join(rootDir, 'server/plugins/auto-recovery-core/rules.js');
  if (!fs.existsSync(rulesFile)) {
    return { rule_ids, action_matchers };
  }

  const text = fs.readFileSync(rulesFile, 'utf8');

  const ruleBlockRe = /\bid\s*:\s*['"]([\w-]+)['"][\s\S]*?(?=\bid\s*:\s*['"]|$)/g;
  let bm;
  ruleBlockRe.lastIndex = 0;
  while ((bm = ruleBlockRe.exec(text)) !== null) {
    const ruleId = bm[1];
    rule_ids.add(ruleId);
    const block = bm[0];

    block.replace(/\.action\s*===\s*['"]([\w-]+)['"]/g, (_, action) => {
      action_matchers.set(action, ruleId);
      return '';
    });
  }

  return { rule_ids, action_matchers };
}

const BENIGN_EXACT_BLOCK_RE = /BENIGN_FLOW_ACTION_EXACT\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]/;
const BENIGN_PREFIX_BLOCK_RE = /BENIGN_FLOW_ACTION_PREFIXES\s*=\s*\[([^\]]*)\]/;

function discoverBenignPatterns(rootDir) {
  const exact = new Set();
  const prefixes = new Set();

  const engineFile = path.join(rootDir, 'server/factory/auto-recovery/engine.js');
  if (!fs.existsSync(engineFile)) {
    return { exact, prefixes };
  }

  const text = fs.readFileSync(engineFile, 'utf8');

  const exactMatch = text.match(BENIGN_EXACT_BLOCK_RE);
  if (exactMatch) {
    const items = exactMatch[1].matchAll(/['"]([\w-]+)['"]/g);
    for (const m of items) exact.add(m[1]);
  }

  const prefixMatch = text.match(BENIGN_PREFIX_BLOCK_RE);
  if (prefixMatch) {
    const items = prefixMatch[1].matchAll(/['"]([\w-]+)['"]/g);
    for (const m of items) prefixes.add(m[1]);
  }

  return { exact, prefixes };
}

module.exports = {
  discoverEmitSites,
  discoverClassifierRules,
  discoverBenignPatterns,
  __internals: { walkJsFiles, fileLineFromIndex },
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/audit-decision-actions.test.js`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/scripts/audit-decision-actions.js server/tests/audit-decision-actions.test.js
git commit -m "feat(factory): audit script discovers classifier rules and benign patterns"
```

---

### Task 3: Audit script — cross-reference and gap report

**Files:**
- Modify: `server/factory/scripts/audit-decision-actions.js`
- Modify: `server/tests/audit-decision-actions.test.js`

**Goal:** A function `runDecisionActionsAudit({ rootDir, catalog })` that combines `discoverEmitSites`, `discoverClassifierRules`, `discoverBenignPatterns`, and the catalog to produce the four-category gap report. Returns `{ emitted_not_in_catalog, emitted_no_classifier, catalog_not_emitted, rule_id_mismatch, dynamic_action_sites, hasGaps }`.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/audit-decision-actions.test.js`:

```js
const { runDecisionActionsAudit } = require('../factory/scripts/audit-decision-actions');

describe('runDecisionActionsAudit', () => {
  it('reports emitted_not_in_catalog when emit site uses an action not in the catalog', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `logDecision({ action: 'undocumented_action', outcome: {} });`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = {};
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.emitted_not_in_catalog).toContain('undocumented_action');
    expect(report.hasGaps).toBe(true);
  });

  it('reports emitted_no_classifier when emit site is in catalog but lacks classifier wiring', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `logDecision({ action: 'orphan_in_catalog', outcome: {} });`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = { orphan_in_catalog: { stage: 'EXECUTE', classifier: 'recovery-rule', rule_id: 'missing_rule' } };
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.emitted_no_classifier).toContain('orphan_in_catalog');
    expect(report.hasGaps).toBe(true);
  });

  it('reports rule_id_mismatch when catalog references a rule_id not in rules.js', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `logDecision({ action: 'foo_failed', outcome: {} });`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [{ id: 'real_rule', match: () => false }];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = { foo_failed: { stage: 'EXECUTE', classifier: 'recovery-rule', rule_id: 'phantom_rule' } };
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.rule_id_mismatch).toEqual([
      expect.objectContaining({ action: 'foo_failed', catalog_rule_id: 'phantom_rule' }),
    ]);
  });

  it('reports catalog_not_emitted when catalog has an entry with no emit site', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `// no logDecision calls`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = { dead_doc: { stage: 'EXECUTE', classifier: 'benign' } };
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.catalog_not_emitted).toContain('dead_doc');
  });

  it('hasGaps is false when all four categories are empty', () => {
    const dir = makeFixtureDir({
      'server/factory/foo.js': `logDecision({ action: 'good_action', outcome: {} });`,
      'server/plugins/auto-recovery-core/rules.js': `module.exports = [{ id: 'good_rule', match: (d) => d.action === 'good_action' }];`,
      'server/factory/auto-recovery/engine.js': `
        const BENIGN_FLOW_ACTION_EXACT = new Set([]);
        const BENIGN_FLOW_ACTION_PREFIXES = [];
      `,
    });
    const catalog = { good_action: { stage: 'EXECUTE', classifier: 'recovery-rule', rule_id: 'good_rule' } };
    const report = runDecisionActionsAudit({ rootDir: dir, catalog });
    expect(report.emitted_not_in_catalog).toEqual([]);
    expect(report.emitted_no_classifier).toEqual([]);
    expect(report.rule_id_mismatch).toEqual([]);
    expect(report.catalog_not_emitted).toEqual([]);
    expect(report.hasGaps).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd server && npx vitest run tests/audit-decision-actions.test.js`
Expected: 5 new tests FAIL ("runDecisionActionsAudit is not a function").

- [ ] **Step 3: Implement runDecisionActionsAudit**

Append to `server/factory/scripts/audit-decision-actions.js`:

```js
function actionMatchedByBenign(action, benign) {
  if (benign.exact.has(action)) return true;
  for (const prefix of benign.prefixes) {
    if (action.startsWith(prefix)) return true;
  }
  return false;
}

function actionMatchedByClassifier(action, classifier_rules) {
  return classifier_rules.action_matchers.has(action);
}

function runDecisionActionsAudit({ rootDir, catalog }) {
  const emit = discoverEmitSites(rootDir);
  const classifier_rules = discoverClassifierRules(rootDir);
  const benign = discoverBenignPatterns(rootDir);

  const emittedSet = new Set(emit.literal_emissions.keys());
  const catalogSet = new Set(Object.keys(catalog));

  const emitted_not_in_catalog = [];
  const emitted_no_classifier = [];
  const rule_id_mismatch = [];
  const catalog_not_emitted = [];

  for (const action of emittedSet) {
    if (!catalogSet.has(action)) emitted_not_in_catalog.push(action);
  }

  for (const action of emittedSet) {
    const entry = catalog[action];
    if (!entry) continue;
    const kind = entry.classifier;
    if (kind === 'benign') {
      if (!actionMatchedByBenign(action, benign)) emitted_no_classifier.push(action);
    } else if (kind === 'recovery-rule') {
      if (!actionMatchedByClassifier(action, classifier_rules)) emitted_no_classifier.push(action);
    } else if (kind === 'b-side-reject' || kind === 'terminal' || kind === 'engine') {
      // No runtime classifier check required for these kinds — the catalog
      // entry IS the contract.
    } else {
      emitted_no_classifier.push(action);
    }
  }

  for (const [action, entry] of Object.entries(catalog)) {
    if (entry.classifier === 'recovery-rule' && entry.rule_id) {
      if (!classifier_rules.rule_ids.has(entry.rule_id)) {
        rule_id_mismatch.push({ action, catalog_rule_id: entry.rule_id });
      }
    }
  }

  for (const action of catalogSet) {
    if (!emittedSet.has(action)) catalog_not_emitted.push(action);
  }

  const hasGaps =
    emitted_not_in_catalog.length > 0
    || emitted_no_classifier.length > 0
    || rule_id_mismatch.length > 0
    || catalog_not_emitted.length > 0;

  return {
    emitted_not_in_catalog,
    emitted_no_classifier,
    rule_id_mismatch,
    catalog_not_emitted,
    dynamic_action_sites: emit.dynamic_action_sites,
    literal_emissions: emit.literal_emissions,
    hasGaps,
  };
}

module.exports = {
  discoverEmitSites,
  discoverClassifierRules,
  discoverBenignPatterns,
  runDecisionActionsAudit,
  __internals: { walkJsFiles, fileLineFromIndex },
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/audit-decision-actions.test.js`
Expected: 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/scripts/audit-decision-actions.js server/tests/audit-decision-actions.test.js
git commit -m "feat(factory): audit script cross-references and reports gaps"
```

---

### Task 4: Audit script — CLI mode

**Files:**
- Modify: `server/factory/scripts/audit-decision-actions.js`
- Modify: `server/tests/audit-decision-actions.test.js`

**Goal:** When invoked as a script, the script loads the catalog from `server/factory/decision-actions.js`, runs the audit against the repo root, pretty-prints the report, and exits non-zero if `hasGaps` is true. Supports `--gap-detail` for per-gap context. Tested via the programmatic `prettyPrintReport` export rather than spawning a subprocess.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/audit-decision-actions.test.js`:

```js
const { prettyPrintReport } = require('../factory/scripts/audit-decision-actions');

describe('prettyPrintReport', () => {
  it('summarizes a report with no gaps', () => {
    const report = {
      emitted_not_in_catalog: [],
      emitted_no_classifier: [],
      rule_id_mismatch: [],
      catalog_not_emitted: [],
      dynamic_action_sites: [],
      literal_emissions: new Map([['scanned_plans', [{ file: 'foo.js', line: 10 }]]]),
      hasGaps: false,
    };
    const out = prettyPrintReport(report);
    expect(out).toMatch(/All gap categories empty/);
    expect(out).toMatch(/Total literal emit sites: 1/);
  });

  it('lists gaps and hides per-site detail by default', () => {
    const report = {
      emitted_not_in_catalog: ['undocumented_x'],
      emitted_no_classifier: [],
      rule_id_mismatch: [],
      catalog_not_emitted: [],
      dynamic_action_sites: [],
      literal_emissions: new Map([['undocumented_x', [{ file: 'foo.js', line: 42 }]]]),
      hasGaps: true,
    };
    const out = prettyPrintReport(report);
    expect(out).toMatch(/emitted_not_in_catalog \(1\):/);
    expect(out).toMatch(/  - undocumented_x/);
    expect(out).not.toMatch(/foo\.js:42/);
  });

  it('shows per-site detail when opts.detail is true', () => {
    const report = {
      emitted_not_in_catalog: ['undocumented_x'],
      emitted_no_classifier: [],
      rule_id_mismatch: [],
      catalog_not_emitted: [],
      dynamic_action_sites: [],
      literal_emissions: new Map([['undocumented_x', [{ file: 'foo.js', line: 42 }]]]),
      hasGaps: true,
    };
    const out = prettyPrintReport(report, { detail: true });
    expect(out).toMatch(/foo\.js:42/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd server && npx vitest run tests/audit-decision-actions.test.js`
Expected: 3 new tests FAIL ("prettyPrintReport is not a function").

- [ ] **Step 3: Implement prettyPrintReport and CLI block**

Append to `server/factory/scripts/audit-decision-actions.js`:

```js
function prettyPrintReport(report, opts = {}) {
  const lines = [];
  lines.push('=== factory_decisions audit ===');
  lines.push('');
  lines.push(`Total literal emit sites: ${report.literal_emissions.size}`);
  lines.push(`Dynamic-action sites: ${report.dynamic_action_sites.length}`);
  lines.push('');

  if (report.emitted_not_in_catalog.length > 0) {
    lines.push(`emitted_not_in_catalog (${report.emitted_not_in_catalog.length}):`);
    for (const action of report.emitted_not_in_catalog) {
      lines.push(`  - ${action}`);
      if (opts.detail) {
        const sites = report.literal_emissions.get(action) || [];
        for (const s of sites) lines.push(`      ${s.file}:${s.line}`);
      }
    }
    lines.push('');
  }

  if (report.emitted_no_classifier.length > 0) {
    lines.push(`emitted_no_classifier (${report.emitted_no_classifier.length}):`);
    for (const action of report.emitted_no_classifier) {
      lines.push(`  - ${action}`);
      if (opts.detail) {
        const sites = report.literal_emissions.get(action) || [];
        for (const s of sites) lines.push(`      ${s.file}:${s.line}`);
      }
    }
    lines.push('');
  }

  if (report.rule_id_mismatch.length > 0) {
    lines.push(`rule_id_mismatch (${report.rule_id_mismatch.length}):`);
    for (const { action, catalog_rule_id } of report.rule_id_mismatch) {
      lines.push(`  - ${action} -> rule_id "${catalog_rule_id}" not found in rules.js`);
    }
    lines.push('');
  }

  if (report.catalog_not_emitted.length > 0) {
    lines.push(`catalog_not_emitted (${report.catalog_not_emitted.length}):`);
    for (const action of report.catalog_not_emitted) {
      lines.push(`  - ${action}`);
    }
    lines.push('');
  }

  if (report.dynamic_action_sites.length > 0 && opts.detail) {
    lines.push(`dynamic_action_sites (${report.dynamic_action_sites.length}):`);
    for (const site of report.dynamic_action_sites) {
      lines.push(`  - ${site.file}:${site.line}  ${site.snippet}`);
    }
    lines.push('');
  }

  if (!report.hasGaps) {
    lines.push('All gap categories empty.');
  }

  return lines.join('\n');
}

if (require.main === module) {
  const detail = process.argv.includes('--gap-detail');
  const rootDir = process.cwd();
  const catalogPath = path.join(rootDir, 'server/factory/decision-actions.js');
  let catalog = {};
  if (fs.existsSync(catalogPath)) {
    // eslint-disable-next-line global-require
    catalog = require(catalogPath).DECISION_ACTIONS || {};
  }
  const report = runDecisionActionsAudit({ rootDir, catalog });
  process.stdout.write(prettyPrintReport(report, { detail }) + '\n');
  process.exit(report.hasGaps ? 1 : 0);
}

module.exports.prettyPrintReport = prettyPrintReport;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/audit-decision-actions.test.js`
Expected: 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/scripts/audit-decision-actions.js server/tests/audit-decision-actions.test.js
git commit -m "feat(factory): audit script CLI mode with gap-detail"
```

---

### Task 5: Add empty catalog file + capture initial gap report

**Files:**
- Create: `server/factory/decision-actions.js`

**Goal:** Add a minimal catalog file that exports an empty `DECISION_ACTIONS` object. Run the audit script against the real repo and capture the initial gap report. The next task populates the catalog from that report.

- [ ] **Step 1: Create the empty catalog file**

```js
'use strict';

// Catalog of valid factory_decisions actions.
//
// Source of truth for action shape, classifier kind, and outcome key list.
// New emission sites must add a corresponding entry; the audit at
// server/tests/factory-decision-actions-catalog.test.js enforces this.
//
// Schema per entry:
//   stage: SENSE | PRIORITIZE | PLAN | EXECUTE | VERIFY | LEARN | IDLE | PAUSED | STARVED | ANY
//   classifier: 'benign' | 'recovery-rule' | 'b-side-reject' | 'terminal' | 'engine'
//   rule_id: required when classifier === 'recovery-rule'
//   outcome: array of documented outcome keys (informational only in v1)
//
// See docs/factory-loop-states.md for the loop's state machine and
// docs/recovery-decisions.md for the recovery subsystems consuming these.

const DECISION_ACTIONS = {
  // Populated in subsequent commits.
};

module.exports = { DECISION_ACTIONS };
```

- [ ] **Step 2: Run the audit script against the real repo to capture the initial gap report**

```bash
cd <repo-root>
node server/factory/scripts/audit-decision-actions.js --gap-detail > /tmp/audit-initial.txt
cat /tmp/audit-initial.txt | head -30
```

Expected: list of every literal emit-site action in the repo, all flagged as `emitted_not_in_catalog`. Total count should be in the 30-60 range based on `docs/factory-loop-states.md`'s catalog.

- [ ] **Step 3: Save the gap report as a reference artifact**

```bash
mkdir -p /tmp/decision-actions-audit
cp /tmp/audit-initial.txt /tmp/decision-actions-audit/initial-gap-report.txt
```

- [ ] **Step 4: Commit the empty catalog**

```bash
git add server/factory/decision-actions.js
git commit -m "feat(factory): add empty decision-actions catalog scaffold"
```

---

### Task 6: Populate catalog from current emissions

**Files:**
- Modify: `server/factory/decision-actions.js`

**Goal:** Add an entry to `DECISION_ACTIONS` for every action in `/tmp/audit-initial.txt`'s `emitted_not_in_catalog` list. Use the doc table at `docs/factory-loop-states.md` lines 144-188 as the classification reference. Where the existing `rules.js` has a matching rule, use `classifier: 'recovery-rule'` with `rule_id`. Where `isBenignFlowDecision` already covers it, use `classifier: 'benign'`. Unknowns get a placeholder entry that will fail the audit, surfacing them for triage in Task 7.

- [ ] **Step 1: Read the existing classification sources**

Open three files for reference:
- `docs/factory-loop-states.md` lines 144-188 (decision-action emission map)
- `server/plugins/auto-recovery-core/rules.js` (full file; ~427 lines)
- `server/factory/auto-recovery/engine.js` lines ~150-195 (`BENIGN_FLOW_ACTION_EXACT`, `BENIGN_FLOW_ACTION_PREFIXES`, `isBenignFlowDecision`)

- [ ] **Step 2: Populate the catalog**

For each action in the initial gap report, decide its `classifier` kind by reading the existing wiring:

- Action appears in `BENIGN_FLOW_ACTION_EXACT` literal list, OR matches any `BENIGN_FLOW_ACTION_PREFIXES` entry → `classifier: 'benign'`.
- Action has a `decision.action === 'X'` matcher in `rules.js` → `classifier: 'recovery-rule'`, `rule_id: <the rule's id>`.
- Action is documented as terminal-success or auto-shipped in the doc table (e.g., `shipped_work_item`, `auto_shipped_at_prioritize`, `learned`) → `classifier: 'terminal'`.
- Action is emitted by the recovery engine itself for diagnostic logging (e.g., `auto_recovery_classified`, `auto_recovery_strategy_selected`, `auto_recovery_no_strategy`, `auto_recovery_skipped_benign`, `auto_recovery_exhausted`, `auto_recovery_rearmed`, `auto_recovery_all_strategies_exhausted`) → `classifier: 'engine'`.
- Action is a B-side replan/reject path (e.g., `plan_lint_rejected`, `plan_description_quality_rejected`, `auto_rejected_verify_fail`, `worktree_merge_failed`) → `classifier: 'b-side-reject'`.
- Anything else → `classifier: 'recovery-rule'`, `rule_id: 'TODO_TRIAGE'`. The audit will flag this as `rule_id_mismatch`, surfacing it for Task 7.

Example populated catalog (representative — fill in every action found in the initial gap report):

```js
const DECISION_ACTIONS = {
  // SENSE
  scanned_plans: {
    stage: 'SENSE',
    classifier: 'benign',
    outcome: ['plans_dir', 'scanned', 'created_count', 'shipped_count'],
  },

  // PRIORITIZE
  selected_work_item: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_id', 'priority', 'status', 'source', 'batch_id'],
  },
  no_selected_work_item: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_status'],
  },
  auto_shipped_at_prioritize: {
    stage: 'PRIORITIZE',
    classifier: 'terminal',
    outcome: ['work_item_id', 'status'],
  },
  stale_probe_starvation: {
    stage: 'PRIORITIZE',
    classifier: 'recovery-rule',
    rule_id: 'starvation_recovery',
    outcome: ['scan_count'],
  },

  // PLAN
  generated_plan: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'plan_path', 'task_count', 'description_quality'],
  },
  cannot_generate_plan: {
    stage: 'PLAN',
    classifier: 'recovery-rule',
    rule_id: 'plan_generation_failed',
    outcome: ['work_item_id', 'error', 'attempt'],
  },
  plan_lint_rejected: {
    stage: 'PLAN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'reason', 'lint_errors'],
  },

  // EXECUTE
  started_execution: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'batch_id', 'trust_level'],
  },
  completed_execution: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'task_count', 'execution_time_ms'],
  },
  execute_zero_diff_short_circuit: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'execute_zero_diff_short_circuit',
    outcome: ['work_item_id', 'reason'],
  },
  execute_exception: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'execute_exception_unclassified',
    outcome: ['work_item_id', 'error'],
  },
  phantom_completion_detected: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'phantom_completion_detected',
    outcome: ['task_id', 'final_status', 'raw_exit_code'],
  },

  // VERIFY
  verified_batch: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'batch_id', 'verification_result'],
  },
  verify_failed: {
    stage: 'VERIFY',
    classifier: 'recovery-rule',
    rule_id: 'verify_fail_unclassified',
    outcome: ['work_item_id', 'error', 'retry_count'],
  },
  verify_retry_submitted: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'retry_count', 'feedback'],
  },
  auto_rejected_verify_fail: {
    stage: 'VERIFY',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'retry_count'],
  },

  // LEARN
  learned: {
    stage: 'LEARN',
    classifier: 'terminal',
    outcome: ['work_item_id', 'batch_id', 'merge_status', 'commit_sha'],
  },
  shipped_work_item: {
    stage: 'LEARN',
    classifier: 'terminal',
    outcome: ['work_item_id', 'commit_sha'],
  },
  merge_target_dirty: {
    stage: 'LEARN',
    classifier: 'recovery-rule',
    rule_id: 'learn_merge_target_dirty',
    outcome: ['paused_at_stage', 'dirty_files', 'untracked_files'],
  },

  // ANY-stage / engine-emitted
  auto_recovery_classified: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['category', 'matched_rule', 'suggested_strategies'],
  },
  auto_recovery_strategy_selected: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['strategy', 'classification'],
  },
  auto_recovery_no_strategy: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['category', 'matched_rule', 'suggested', 'strategy_attempts'],
  },
  auto_recovery_skipped_benign: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['latest_decision_action', 'latest_decision_stage'],
  },
  auto_recovery_exhausted: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['reason', 'max_attempts'],
  },

  paused_at_gate: {
    stage: 'ANY',
    classifier: 'recovery-rule',
    rule_id: 'paused_at_gate_dispatcher',
    outcome: ['from_state', 'to_state', 'gate_stage', 'trust_level'],
  },
  gate_approved: {
    stage: 'ANY',
    classifier: 'benign',
    outcome: ['approved_stage', 'from_state', 'to_state'],
  },
};

module.exports = { DECISION_ACTIONS };
```

Add every action from the initial gap report — the example above is non-exhaustive. For unknown classifications, use `rule_id: 'TODO_TRIAGE'` (Task 7 fixes these).

- [ ] **Step 3: Re-run audit to capture remaining gaps**

```bash
node server/factory/scripts/audit-decision-actions.js --gap-detail > /tmp/decision-actions-audit/post-populate-gap-report.txt
cat /tmp/decision-actions-audit/post-populate-gap-report.txt | head -50
```

Expected: substantially fewer gaps. Remaining items will be:
- `rule_id_mismatch` for any `TODO_TRIAGE` placeholders (intentional — surfaces them for Task 7).
- `emitted_no_classifier` for any actions where the catalog says `recovery-rule` but `rules.js` doesn't have a matcher yet (also intentional — Task 7 work).
- `dynamic_action_sites` warnings (non-fatal, listed for manual review).

- [ ] **Step 4: Commit**

```bash
git add server/factory/decision-actions.js
git commit -m "feat(factory): populate decision-actions catalog from current emissions

Best-effort classification per docs/factory-loop-states.md and the
existing wiring in rules.js + isBenignFlowDecision. Gaps surface as
rule_id_mismatch (TODO_TRIAGE placeholders) and emitted_no_classifier
for the next commit to triage."
```

---

### Task 7: Triage and gap-fix (process task)

**Files:** Variable per gap. Possible:
- Modify: `server/factory/decision-actions.js` (catalog cleanup)
- Modify: `server/plugins/auto-recovery-core/rules.js` (new classifier rules)
- Modify: `server/factory/auto-recovery/engine.js` (benign-skip pattern additions)
- Modify: emission-site files (rare — refactoring dynamic-action sites to literals)

**Goal:** Drive `runDecisionActionsAudit().hasGaps` to `false` by closing every remaining gap. This is judgment work and intentionally NOT TDD-shaped — each gap requires reading the emit context, deciding the right classifier kind, and either adding a rule, updating the benign-skip set, or correcting the catalog entry.

- [ ] **Step 1: Re-read the report from Task 6**

```bash
cat /tmp/decision-actions-audit/post-populate-gap-report.txt
```

For each item in `emitted_no_classifier` and `rule_id_mismatch`, follow the per-gap procedure below.

- [ ] **Step 2: Per-gap fix procedure**

For **each** action in `emitted_no_classifier` and **each** entry in `rule_id_mismatch`:

1. **Read the emit site.** Use the file:line from the audit's gap-detail to locate the call. Read 30 lines around it to understand what triggered the emission.
2. **Decide the classifier kind:**
   - **Forward-progress, informational only** → `benign`. Add the action to `BENIGN_FLOW_ACTION_EXACT` (or extend a prefix) in `server/factory/auto-recovery/engine.js`. Update the catalog entry.
   - **Failure / stuck-state requiring recovery** → `recovery-rule`. Add a rule to `server/plugins/auto-recovery-core/rules.js` with the appropriate strategy chain. Use existing rules as templates: `phantom_completion_detected`, `execute_zero_diff_short_circuit`, `learn_merge_target_dirty`. Catalog `rule_id` to match.
   - **Reject-then-replan** → `b-side-reject`. Add a pattern to `server/factory/replan-recovery.js` or `server/factory/rejected-recovery.js` per the existing patterns. Catalog entry only — no `rule_id`.
   - **Terminal success/failure (no recovery needed)** → `terminal`. Catalog entry only.
   - **Engine internal** → `engine`. Catalog entry only.
3. **When ambiguous:** default to `classifier: 'recovery-rule'` with a strategy chain of just `['retry']` (single attempt then escalate via the engine's default `escalate` fallback). False-retry adds at most one extra attempt before escalation. False-benign hides bugs silently.
4. **Re-run audit between gap fixes:**
   ```bash
   node server/factory/scripts/audit-decision-actions.js
   ```
   Watch the gap counts shrink.
5. **Commit each gap fix as its own commit** with a message like `fix(factory): pair <action> with <classifier-kind>`.

- [ ] **Step 3: Address `dynamic_action_sites` (manual triage, non-fatal)**

For each entry in `dynamic_action_sites`:

1. Read the emit site.
2. Decide:
   - **Refactor to literal:** if the dynamic value is enumerable (e.g., a stage name), inline the literal call sites. Adds catalog entries for each. Preferred — improves auditability.
   - **Document as intentional dynamic:** if the value is genuinely runtime-derived (e.g., includes a task id), leave the dynamic call. Add a comment at the call site explaining why and pointing at the production guard from Task 8 as the safety net.
3. The `dynamic_action_sites` list is non-fatal — the audit doesn't fail on these, but they bypass static lint and rely on the production guard.

- [ ] **Step 4: Run audit until clean**

```bash
node server/factory/scripts/audit-decision-actions.js
```

Expected output:
```
=== factory_decisions audit ===
Total literal emit sites: <some N>
Dynamic-action sites: <some M>

All gap categories empty.
```

Exit code: 0.

- [ ] **Step 5: Commit any remaining catalog cleanup**

If the iteration produced trailing catalog edits, commit:

```bash
git add server/factory/decision-actions.js server/plugins/auto-recovery-core/rules.js server/factory/auto-recovery/engine.js
git commit -m "fix(factory): close remaining decision-action gaps; audit clean"
```

---

### Task 8: Production guard — auto_recovery_unknown_action emission

**Files:**
- Modify: `server/factory/auto-recovery/engine.js`
- Modify: `server/factory/decision-actions.js`
- Create: `server/tests/auto-recovery-unknown-action.test.js`

**Goal:** When `classifier.classify(decision)` returns `{ matched_rule: null, category: 'unknown' }`, the engine emits `auto_recovery_unknown_action` with the original decision's metadata before falling through to the default `['retry', 'escalate']` chain. The catalog declares this action with `classifier: 'engine'`. A recursion-defense short-circuit ensures classifying `auto_recovery_unknown_action` itself never re-enters the unknown path.

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-unknown-action.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const Database = require('better-sqlite3');
const { createAutoRecoveryEngine } = require('../factory/auto-recovery/engine');

function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_projects (
      id INTEGER PRIMARY KEY,
      name TEXT,
      status TEXT,
      loop_state TEXT,
      loop_batch_id TEXT,
      loop_paused_at_stage TEXT,
      auto_recovery_exhausted INTEGER DEFAULT 0,
      auto_recovery_attempts INTEGER DEFAULT 0,
      auto_recovery_last_action_at TEXT,
      auto_recovery_last_strategy TEXT
    );
    CREATE TABLE factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      stage TEXT,
      action TEXT,
      reasoning TEXT,
      outcome TEXT,
      confidence REAL,
      batch_id TEXT,
      created_at TEXT
    );
  `);
  db.prepare(`INSERT INTO factory_projects (id, name, status, loop_state) VALUES (1, 'p', 'running', 'PAUSED')`).run();
  return db;
}

describe('auto_recovery_unknown_action production guard', () => {
  it('emits auto_recovery_unknown_action when classifier returns unknown matched_rule', () => {
    const db = setupDb();
    const engine = createAutoRecoveryEngine({
      db,
      logger: { info() {}, warn() {}, error() {} },
      eventBus: null,
      rules: [],
      strategies: [],
    });

    db.prepare(`INSERT INTO factory_decisions (project_id, stage, action, outcome, created_at) VALUES (1, 'execute', 'novel_failure_action', '{"work_item_id": 7, "error": "boom"}', datetime('now'))`).run();

    engine.recoverOne({ id: 1 });

    const guardRow = db.prepare(`SELECT action, outcome FROM factory_decisions WHERE action = 'auto_recovery_unknown_action'`).get();
    expect(guardRow).toBeDefined();
    const outcome = JSON.parse(guardRow.outcome);
    expect(outcome.original_action).toBe('novel_failure_action');
    expect(outcome.original_stage).toBe('execute');
    expect(outcome.outcome_keys).toEqual(expect.arrayContaining(['work_item_id', 'error']));
  });

  it('does NOT emit auto_recovery_unknown_action when classifier returns a real matched_rule', () => {
    const db = setupDb();
    const engine = createAutoRecoveryEngine({
      db,
      logger: { info() {}, warn() {}, error() {} },
      eventBus: null,
      rules: [{
        id: 'always_matches',
        match: () => true,
        classify: () => ({ category: 'transient', matched_rule: 'always_matches', suggested_strategies: ['retry'], confidence: 1 }),
      }],
      strategies: [],
    });

    db.prepare(`INSERT INTO factory_decisions (project_id, stage, action, outcome, created_at) VALUES (1, 'execute', 'matched_action', '{}', datetime('now'))`).run();

    engine.recoverOne({ id: 1 });

    const guardRow = db.prepare(`SELECT action FROM factory_decisions WHERE action = 'auto_recovery_unknown_action'`).get();
    expect(guardRow).toBeUndefined();
  });

  it('does NOT recurse on auto_recovery_unknown_action itself (classifier short-circuit)', () => {
    const db = setupDb();
    const engine = createAutoRecoveryEngine({
      db,
      logger: { info() {}, warn() {}, error() {} },
      eventBus: null,
      rules: [],
      strategies: [],
    });

    db.prepare(`INSERT INTO factory_decisions (project_id, stage, action, outcome, created_at) VALUES (1, 'execute', 'auto_recovery_unknown_action', '{}', datetime('now'))`).run();

    engine.recoverOne({ id: 1 });

    const rows = db.prepare(`SELECT id FROM factory_decisions WHERE action = 'auto_recovery_unknown_action'`).all();
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd server && npx vitest run tests/auto-recovery-unknown-action.test.js`
Expected: FAIL — guard not yet emitted.

- [ ] **Step 3: Add the production guard emission and recursion defense**

In `server/factory/auto-recovery/engine.js`, locate the `recoverOne` function and the classifier call at line ~364: `const classification = classifier.classify(classifyInput);`.

Find:
```js
const classifyInput = decision
  ? decision
  : { action: 'never_started', stage: 'plan', outcome: {} };
const classification = classifier.classify(classifyInput);

logDecision(db, {
  project_id: project.id, stage: decision?.stage || 'verify',
  action: 'auto_recovery_classified',
  reasoning: `Classified as ${classification.category} (rule: ${classification.matched_rule || 'none'})`,
  outcome: classification,
  confidence: classification.confidence,
  batch_id: decision?.batch_id || null,
});

const recentAttempts = recentStrategyAttemptsForRule(db, project.id, classification.matched_rule);
```

Replace with:
```js
const classifyInput = decision
  ? decision
  : { action: 'never_started', stage: 'plan', outcome: {} };

// Recursion defense: classifying auto_recovery_unknown_action itself
// would loop endlessly through the unknown-action emission. Short-circuit
// before classify() runs.
if (classifyInput.action === 'auto_recovery_unknown_action') {
  return { attempted: false, strategy: null, skipped: 'guard_self_reference' };
}

const classification = classifier.classify(classifyInput);

logDecision(db, {
  project_id: project.id, stage: decision?.stage || 'verify',
  action: 'auto_recovery_classified',
  reasoning: `Classified as ${classification.category} (rule: ${classification.matched_rule || 'none'})`,
  outcome: classification,
  confidence: classification.confidence,
  batch_id: decision?.batch_id || null,
});

// Production guard: when the classifier returns unknown (matched_rule === null),
// emit auto_recovery_unknown_action so operators can grep factory_decisions
// for drift the static CI gate didn't catch (dynamic action names, etc.).
if (classification.matched_rule == null) {
  logDecision(db, {
    project_id: project.id,
    stage: decision?.stage || 'verify',
    action: 'auto_recovery_unknown_action',
    reasoning: `Classifier returned unknown for action "${classifyInput.action}"; engine will fall back to default chain`,
    outcome: {
      original_action: classifyInput.action,
      original_stage: decision?.stage || null,
      outcome_keys: Object.keys(decision?.outcome || {}),
      work_item_id: decision?.outcome?.work_item_id ?? null,
      task_id: decision?.outcome?.task_id ?? null,
      engine_decided_strategies: classification.suggested_strategies || ['retry', 'escalate'],
    },
    confidence: 1,
    batch_id: decision?.batch_id || null,
  });
}

const recentAttempts = recentStrategyAttemptsForRule(db, project.id, classification.matched_rule);
```

- [ ] **Step 4: Add the catalog entry**

In `server/factory/decision-actions.js`, add to `DECISION_ACTIONS`:

```js
auto_recovery_unknown_action: {
  stage: 'ANY',
  classifier: 'engine',
  outcome: ['original_action', 'original_stage', 'outcome_keys', 'work_item_id', 'task_id', 'engine_decided_strategies'],
},
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd server && npx vitest run tests/auto-recovery-unknown-action.test.js`
Expected: 3 tests PASS.

- [ ] **Step 6: Run audit to confirm catalog still clean**

```bash
node server/factory/scripts/audit-decision-actions.js
```

Expected: exit 0, "All gap categories empty."

- [ ] **Step 7: Commit**

```bash
git add server/factory/auto-recovery/engine.js server/factory/decision-actions.js server/tests/auto-recovery-unknown-action.test.js
git commit -m "feat(factory): production guard emits auto_recovery_unknown_action

When the classifier returns matched_rule=null, the engine emits a
tracked decision action with the original action, stage, outcome
keys, and the default strategy chain it fell back to. Operators
query factory_decisions WHERE action='auto_recovery_unknown_action'
to see drift the CI gate's static analysis missed (dynamic action
names, out-of-CI changes).

Recursion defense: classifying auto_recovery_unknown_action itself
short-circuits before classify() runs."
```

---

### Task 9: CI gate — vitest test

**Files:**
- Create: `server/tests/factory-decision-actions-catalog.test.js`

**Goal:** A vitest test that invokes `runDecisionActionsAudit` against the real repo + catalog and asserts `hasGaps === false`. Becomes the future-drift CI gate.

- [ ] **Step 1: Write the test**

Create `server/tests/factory-decision-actions-catalog.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll } = require('vitest');
const path = require('node:path');
const { runDecisionActionsAudit } = require('../factory/scripts/audit-decision-actions');
const { DECISION_ACTIONS } = require('../factory/decision-actions');

describe('factory decision-actions catalog', () => {
  let report;

  beforeAll(() => {
    const rootDir = path.resolve(__dirname, '../../');
    report = runDecisionActionsAudit({ rootDir, catalog: DECISION_ACTIONS });
  });

  it('every emitted action is in the catalog', () => {
    expect(report.emitted_not_in_catalog).toEqual([]);
  });

  it('every emitted action has a classifier (rule, benign-skip, terminal, or engine)', () => {
    expect(report.emitted_no_classifier).toEqual([]);
  });

  it('every catalog rule_id reference matches a real rule in rules.js', () => {
    expect(report.rule_id_mismatch).toEqual([]);
  });

  it('catalog has no orphan entries (dead documentation)', () => {
    expect(report.catalog_not_emitted).toEqual([]);
  });

  it('reports dynamic-action sites for manual review (non-fatal)', () => {
    if (report.dynamic_action_sites.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`Dynamic action sites (manual review): ${report.dynamic_action_sites.length}`);
    }
    expect(Array.isArray(report.dynamic_action_sites)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (it should — Task 7 closed the gaps)**

Run: `cd server && npx vitest run tests/factory-decision-actions-catalog.test.js`
Expected: 5 tests PASS.

- [ ] **Step 3: Verify the test fails when a gap is reintroduced**

Manual sanity check (don't commit this state):
1. Add a temporary `logDecision({ action: 'temp_drift_action', outcome: {} });` somewhere in `server/factory/`.
2. Re-run the test.
3. Expected: `emitted_not_in_catalog` test FAILS with `temp_drift_action` listed.
4. Remove the temporary line. Re-run. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/tests/factory-decision-actions-catalog.test.js
git commit -m "feat(factory): CI gate fails when decision-action catalog drifts"
```

---

### Task 10: Doc autogen — renderer script

**Files:**
- Create: `server/factory/scripts/render-decision-actions-doc.js`
- Create: `server/tests/render-decision-actions-doc.test.js`

**Goal:** A script that reads `DECISION_ACTIONS` and renders a markdown table. CLI mode prints to stdout; `--write` flag updates the doc in place. Programmatic export `renderTable()` is consumed by the snapshot test in Task 11.

- [ ] **Step 1: Write the failing test**

Create `server/tests/render-decision-actions-doc.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { renderTable } = require('../factory/scripts/render-decision-actions-doc');

describe('renderTable', () => {
  it('renders a markdown table with stage / action / classifier / outcome columns', () => {
    const catalog = {
      scanned_plans: { stage: 'SENSE', classifier: 'benign', outcome: ['plans_dir', 'scanned'] },
      execute_zero_diff_short_circuit: {
        stage: 'EXECUTE', classifier: 'recovery-rule', rule_id: 'execute_zero_diff_short_circuit',
        outcome: ['work_item_id', 'reason'],
      },
    };
    const md = renderTable(catalog);
    expect(md).toMatch(/\| Stage \| Action \| Classifier \| Outcome shape \|/);
    expect(md).toMatch(/\| SENSE \| `scanned_plans` \| `benign` \| `plans_dir`, `scanned` \|/);
    expect(md).toMatch(/\| EXECUTE \| `execute_zero_diff_short_circuit` \| `recovery-rule` \(rule: `execute_zero_diff_short_circuit`\) \| `work_item_id`, `reason` \|/);
  });

  it('preserves catalog declaration order in the rendered table', () => {
    const catalog = {
      a: { stage: 'EXECUTE', classifier: 'benign', outcome: [] },
      b: { stage: 'SENSE', classifier: 'benign', outcome: [] },
      c: { stage: 'EXECUTE', classifier: 'benign', outcome: [] },
    };
    const md = renderTable(catalog);
    const linesIdx = (s) => md.indexOf(s);
    expect(linesIdx('| EXECUTE | `a`')).toBeLessThan(linesIdx('| SENSE | `b`'));
    expect(linesIdx('| SENSE | `b`')).toBeLessThan(linesIdx('| EXECUTE | `c`'));
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd server && npx vitest run tests/render-decision-actions-doc.test.js`
Expected: FAIL ("Cannot find module '../factory/scripts/render-decision-actions-doc'").

- [ ] **Step 3: Implement the renderer**

Create `server/factory/scripts/render-decision-actions-doc.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BEGIN_MARKER = '<!-- BEGIN AUTOGEN: decision-actions-table -->';
const END_MARKER = '<!-- END AUTOGEN: decision-actions-table -->';

function formatClassifier(entry) {
  if (entry.classifier === 'recovery-rule' && entry.rule_id) {
    return `\`recovery-rule\` (rule: \`${entry.rule_id}\`)`;
  }
  return `\`${entry.classifier}\``;
}

function formatOutcome(entry) {
  const keys = Array.isArray(entry.outcome) ? entry.outcome : [];
  if (keys.length === 0) return '_(none)_';
  return keys.map((k) => `\`${k}\``).join(', ');
}

function renderTable(catalog) {
  const lines = [];
  lines.push('| Stage | Action | Classifier | Outcome shape |');
  lines.push('|---|---|---|---|');

  for (const [action, entry] of Object.entries(catalog)) {
    const stage = entry.stage || '?';
    lines.push(`| ${stage} | \`${action}\` | ${formatClassifier(entry)} | ${formatOutcome(entry)} |`);
  }

  return lines.join('\n') + '\n';
}

function spliceIntoDoc(docPath, table) {
  const text = fs.readFileSync(docPath, 'utf8');
  const beginIdx = text.indexOf(BEGIN_MARKER);
  const endIdx = text.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(`Autogen markers not found in ${docPath}. Add ${BEGIN_MARKER} and ${END_MARKER}.`);
  }
  const before = text.slice(0, beginIdx + BEGIN_MARKER.length);
  const after = text.slice(endIdx);
  return `${before}\n${table}${after}`;
}

if (require.main === module) {
  const write = process.argv.includes('--write');
  const rootDir = process.cwd();
  const { DECISION_ACTIONS } = require(path.join(rootDir, 'server/factory/decision-actions'));
  const table = renderTable(DECISION_ACTIONS);

  if (write) {
    const docPath = path.join(rootDir, 'docs/factory-loop-states.md');
    const updated = spliceIntoDoc(docPath, table);
    fs.writeFileSync(docPath, updated, 'utf8');
    process.stdout.write(`Wrote autogen table to ${docPath}\n`);
  } else {
    process.stdout.write(table);
  }
}

module.exports = { renderTable, spliceIntoDoc, BEGIN_MARKER, END_MARKER };
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run tests/render-decision-actions-doc.test.js`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/scripts/render-decision-actions-doc.js server/tests/render-decision-actions-doc.test.js
git commit -m "feat(factory): renderer script for decision-actions doc table"
```

---

### Task 11: Doc autogen — wire into doc + snapshot test

**Files:**
- Modify: `docs/factory-loop-states.md`
- Modify: `server/tests/render-decision-actions-doc.test.js`

**Goal:** Replace the hand-written decision-action emission table in `docs/factory-loop-states.md` with the autogen block. Snapshot test asserts the doc's autogen content matches `renderTable(DECISION_ACTIONS)`.

- [ ] **Step 1: Read the current decision-action emission map in the doc**

Open `docs/factory-loop-states.md` and locate the section starting around line 144: "## Decision-action emission map" with the table starting around line 148 (`| Stage | Action | Approx outcome shape | Matched by recovery rule? |`).

- [ ] **Step 2: Replace the table with autogen markers**

Edit `docs/factory-loop-states.md`. Replace the existing table (lines 148-187, roughly) with:

```markdown
<!-- BEGIN AUTOGEN: decision-actions-table -->
<!-- END AUTOGEN: decision-actions-table -->
```

Keep the prose around the table intact (the section header, the introduction paragraph at line 144, the "Frequently-emitted actions, by stage:" lead-in, and the "When adding a new decision action:" warning at line 188).

- [ ] **Step 3: Run the renderer with --write to populate the autogen block**

```bash
node server/factory/scripts/render-decision-actions-doc.js --write
```

Expected: the autogen block now contains the rendered table. Verify by running:

```bash
git diff docs/factory-loop-states.md | head -50
```

The diff should show the old hand-written table replaced by the renderer's output.

- [ ] **Step 4: Add the snapshot test**

Append to `server/tests/render-decision-actions-doc.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const { spliceIntoDoc, BEGIN_MARKER, END_MARKER } = require('../factory/scripts/render-decision-actions-doc');
const { DECISION_ACTIONS } = require('../factory/decision-actions');

describe('docs/factory-loop-states.md autogen sync', () => {
  it('the autogen block content matches renderTable(DECISION_ACTIONS)', () => {
    const docPath = path.resolve(__dirname, '../../docs/factory-loop-states.md');
    const text = fs.readFileSync(docPath, 'utf8');

    const beginIdx = text.indexOf(BEGIN_MARKER);
    const endIdx = text.indexOf(END_MARKER);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(-1);

    const expected = renderTable(DECISION_ACTIONS);
    const actualBlock = text.slice(beginIdx + BEGIN_MARKER.length, endIdx).trim();
    const expectedBlock = expected.trim();

    if (actualBlock !== expectedBlock) {
      throw new Error(
        `docs/factory-loop-states.md autogen block is stale. Run:\n  node server/factory/scripts/render-decision-actions-doc.js --write\n  git add docs/factory-loop-states.md`,
      );
    }
  });
});
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd server && npx vitest run tests/render-decision-actions-doc.test.js`
Expected: 3 tests PASS (2 from Task 10 + 1 new snapshot test).

- [ ] **Step 6: Commit**

```bash
git add docs/factory-loop-states.md server/tests/render-decision-actions-doc.test.js
git commit -m "docs(factory): autogen decision-action emission table

Replaces the hand-written table with content rendered from
server/factory/decision-actions.js. Snapshot test asserts the doc's
autogen block matches renderTable(DECISION_ACTIONS); regenerate via
node server/factory/scripts/render-decision-actions-doc.js --write."
```

---

### Task 12: Operator docs

**Files:**
- Modify: `docs/factory-loop-states.md`

**Goal:** Add operator-runbook content covering (a) the SQL queries for finding production drift via `auto_recovery_unknown_action`, and (b) updates to "When changing the loop" pointing at the catalog as canonical.

- [ ] **Step 1: Add the "Finding production drift" section**

In `docs/factory-loop-states.md`, after the autogen-block section (after line ~190 in the current state), insert:

```markdown
## Finding production drift

The CI gate at `server/tests/factory-decision-actions-catalog.test.js` catches static-analysis-detectable drift. For dynamic action names and any change that landed without going through CI, the recovery engine emits `auto_recovery_unknown_action` whenever the classifier returns `matched_rule = null`. Query `factory_decisions` for these:

```sql
-- Anything that slipped past CI in the last 24h
SELECT created_at,
       json_extract(outcome, '$.original_action') AS original_action,
       json_extract(outcome, '$.original_stage') AS original_stage
FROM factory_decisions
WHERE action = 'auto_recovery_unknown_action'
  AND created_at > datetime('now', '-1 day')
ORDER BY created_at DESC;

-- Frequency by original_action — find the recurring offenders
SELECT json_extract(outcome, '$.original_action') AS original_action,
       COUNT(*) AS hits
FROM factory_decisions
WHERE action = 'auto_recovery_unknown_action'
GROUP BY original_action
ORDER BY hits DESC;
```

When you find a hit:
1. Confirm the `original_action` is still emitted (search the codebase for `action: '<name>'`).
2. If the action is real and frequent: add it to `server/factory/decision-actions.js` with the appropriate classifier kind.
3. Pair the catalog entry with classifier wiring per the catalog's `classifier` enum (see "When changing the loop" below).
4. The CI gate will pass once the catalog and wiring agree.
```

- [ ] **Step 2: Update "When changing the loop" — step 3 (decision actions)**

Locate the existing "When changing the loop" section (around line 229 in the current doc). Replace the existing step 3 (`New decision action — emit via safeLogDecision...`) with:

```markdown
3. **New decision action** — three-step contract:
   1. Add an entry to `server/factory/decision-actions.js` (the canonical catalog) with `stage`, `classifier`, optional `rule_id`, and `outcome` keys.
   2. Wire the classifier:
      - `classifier: 'benign'` → add the action to `BENIGN_FLOW_ACTION_EXACT` or extend a prefix in `server/factory/auto-recovery/engine.js`.
      - `classifier: 'recovery-rule'` → add a rule to `server/plugins/auto-recovery-core/rules.js` with the appropriate strategy chain. Set the catalog `rule_id` to match.
      - `classifier: 'b-side-reject'` → add a pattern in `server/factory/replan-recovery.js` or `rejected-recovery.js`.
      - `classifier: 'terminal'` or `'engine'` → no further wiring; the catalog entry is the contract.
   3. Emit at the call site via `logDecision({ ..., action: 'X' })`. The audit at `server/tests/factory-decision-actions-catalog.test.js` will fail if any of the three steps is missing.

   The doc table at the top of this section is auto-generated from the catalog. Regenerate after adding entries:
   ```
   node server/factory/scripts/render-decision-actions-doc.js --write
   ```
```

- [ ] **Step 3: Verify**

Run all four vitest test files:

```bash
cd server && npx vitest run tests/factory-decision-actions-catalog.test.js tests/render-decision-actions-doc.test.js tests/audit-decision-actions.test.js tests/auto-recovery-unknown-action.test.js
```

Expected: every test passes. Total: ~25 tests across 4 files.

- [ ] **Step 4: Commit**

```bash
git add docs/factory-loop-states.md
git commit -m "docs(factory): operator queries + catalog-first decision-action contract

Adds 'Finding production drift' section with SQL queries against the
auto_recovery_unknown_action production guard. Updates the 'When
changing the loop' section's decision-action step to point at
server/factory/decision-actions.js as canonical and codify the
three-step contract (catalog entry → wire classifier → emit)."
```

---

## Self-Review

1. **Spec coverage:** Each spec section maps to:
   - Catalog file shape → Task 5 (scaffold), Task 6 (populate)
   - Audit script discovery + cross-reference → Tasks 1, 2, 3
   - Audit script CLI → Task 4
   - Gap-fixing strategy → Task 7
   - CI gate (vitest) → Task 9
   - Production guard → Task 8
   - Doc table autogen → Tasks 10, 11
   - Operator docs / "When changing the loop" → Task 12

2. **Placeholder scan:** No `TBD`, no vague phrases like "implement appropriate error handling." The `TODO_TRIAGE` placeholder in Task 6 is intentional and explicitly handed off to Task 7.

3. **Type / name consistency:** Function names used consistently across tasks: `discoverEmitSites`, `discoverClassifierRules`, `discoverBenignPatterns`, `runDecisionActionsAudit`, `prettyPrintReport` (audit script), `renderTable`, `spliceIntoDoc` (renderer), `DECISION_ACTIONS` (catalog export). The canonical emit function is `logDecision` (single-arg from decision-log.js + db-prefix from engine.js); the spec's `safeLogDecision` reference was a doc-level abstraction and is called out at the top of the plan.

4. **Gaps to flag:**
   - Task 7 is intentionally non-TDD (judgment work). Each gap fix is its own commit with a concrete classifier kind decision; the task structure documents the procedure rather than a single test/commit pair.
   - The audit's regex parser may miss exotic emit sites (e.g., a `logDecision` call constructed via a wrapper function). The production guard from Task 8 catches misses in operation; AST upgrade is a follow-up.
   - The `outcome` field on catalog entries is documentation-only in v1. Strict validation against actual emit-site shapes is out of scope.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-07-factory-decision-actions-catalog.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for plans with ~10+ tasks where context churn would otherwise dominate.

**2. Inline Execution** — Execute tasks in this session using the executing-plans skill, batch with checkpoints for review.

Which approach?
