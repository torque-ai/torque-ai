# MCP Tool Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) to all 553 TORQUE tools so clients can auto-approve read-only operations.

**Architecture:** New `server/tool-annotations.js` provides `getAnnotations(name)` using hybrid convention-based defaults + explicit overrides. `server/tools.js` merges annotations into tool objects at startup. No changes to `server/mcp-protocol.js` — it already passes tool objects through verbatim.

**Tech Stack:** Node.js, Vitest, MCP protocol (JSON-RPC 2.0)

**Spec:** `docs/superpowers/specs/2026-03-21-mcp-tool-annotations-design.md`

---

### Task 1: Create tool-annotations.js — Convention Rules

**Files:**
- Create: `server/tool-annotations.js`
- Test: `server/tests/tool-annotations.test.js`

- [ ] **Step 1: Write failing tests for convention prefix rules**

```js
// server/tests/tool-annotations.test.js
'use strict';

const { getAnnotations } = require('../tool-annotations');

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const DISPATCH = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LIFECYCLE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const ASYNC_RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };

describe('tool-annotations', () => {
  describe('prefix convention rules', () => {
    it.each([
      ['list_tasks', RO],
      ['get_result', RO],
      ['check_status', RO],
      ['find_similar_tasks', RO],
      ['search_nodes', RO],
      ['scan_project', RO],
      ['diff_task_runs', RO],
      ['export_report', RO],
      ['analyze_task', RO],
      ['validate_event_consistency', RO],
      ['detect_file_conflicts', RO],
      ['compare_providers', RO],
      ['predict_duration', RO],
      ['diagnose_ci_failure', RO],
      ['capture_screenshots', RO],
      ['suggest_provider', RO],
      ['compute_cost', RO],
      ['tsserver_diagnostics', RO],
      ['peek_ui', RO],
      ['peek_elements', RO],
    ])('%s → readOnly', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['delete_task', DESTRUCT],
      ['rollback_task', DESTRUCT],
      ['archive_task', DESTRUCT],
      ['remove_host', DESTRUCT],
      ['clear_notifications', DESTRUCT],
      ['revoke_api_key', DESTRUCT],
      ['cleanup_stale', DESTRUCT],
    ])('%s → destructive', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['cancel_task', DESTRUCT],
      ['cancel_workflow', DESTRUCT],
    ])('%s → cancel (destructive)', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['submit_task', DISPATCH],
      ['queue_task', DISPATCH],
      ['create_workflow', DISPATCH],
      ['run_workflow', DISPATCH],
      ['schedule_task', DISPATCH],
      ['generate_feature_tasks', DISPATCH],
      ['trigger_webhook', DISPATCH],
      ['clone_task', DISPATCH],
    ])('%s → dispatch/openWorld', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['set_project_defaults', IDEMPOTENT],
      ['configure_stall_detection', IDEMPOTENT],
      ['tag_task', IDEMPOTENT],
      ['manage_host', IDEMPOTENT],
      ['add_ts_interface_members', IDEMPOTENT],
      ['inject_class_dependency', IDEMPOTENT],
      ['wire_system_to_gamescene', IDEMPOTENT],
      ['normalize_interface_formatting', IDEMPOTENT],
      ['update_project_stats', IDEMPOTENT],
      ['register_agent', IDEMPOTENT],
      ['enable_provider', IDEMPOTENT],
      ['approve_task', IDEMPOTENT],
      ['record_metric', IDEMPOTENT],
      ['resolve_conflict', IDEMPOTENT],
    ])('%s → idempotent mutation', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['retry_task', LIFECYCLE],
      ['resume_task', LIFECYCLE],
      ['restore_task', LIFECYCLE],
      ['start_pending_task', LIFECYCLE],
      ['pause_task', LIFECYCLE],
      ['skip_task', LIFECYCLE],
      ['stop_ci_watch', LIFECYCLE],
      ['recover_host', LIFECYCLE],
      ['refresh_host_models', LIFECYCLE],
    ])('%s → lifecycle', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['await_workflow', ASYNC_RO],
      ['await_task', ASYNC_RO],
      ['wait_for_task', ASYNC_RO],
      ['poll_task_events', ASYNC_RO],
      ['stream_task_output', ASYNC_RO],
    ])('%s → async/blocking (readOnly, not idempotent)', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });
  });

  // NOTE: Tasks 2, 3, and 4 add more describe blocks HERE, inside this outer describe.
  // Do NOT close this describe block yet — leave it open for subsequent tasks.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tool-annotations.test.js --reporter verbose`
Expected: FAIL — `Cannot find module '../tool-annotations'`

- [ ] **Step 3: Implement convention prefix rules in tool-annotations.js**

```js
// server/tool-annotations.js
'use strict';

// ── Annotation shape ──
const READONLY    = Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false });
const DISPATCH    = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  });
const IDEMPOTENT  = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false });
const LIFECYCLE   = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const ASYNC_RO    = Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: false, openWorldHint: false });
const FALLBACK    = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

// ── Prefix rules (checked first, first match wins) ──
const PREFIX_RULES = [
  { prefixes: [
    'list_', 'get_', 'check_', 'find_', 'search_', 'scan_', 'diff_', 'export_',
    'analyze_', 'validate_', 'detect_', 'compare_', 'predict_', 'estimate_', 'forecast_',
    'verify_', 'view_', 'explain_', 'inspect_', 'preview_', 'diagnose_', 'capture_',
    'lookup_', 'query_', 'suggest_', 'compute_', 'calculate_', 'calibrate_', 'tsserver_',
    'peek_',
  ], annotation: READONLY },
  { prefixes: [
    'delete_', 'rollback_', 'archive_', 'remove_', 'clear_', 'revoke_', 'cleanup_',
  ], annotation: DESTRUCTIVE },
  { prefixes: [
    'cancel_',
  ], annotation: DESTRUCTIVE },
  { prefixes: [
    'submit_', 'queue_', 'create_', 'run_', 'schedule_', 'fork_', 'clone_',
    'import_', 'bulk_import_', 'notify_', 'send_', 'test_', 'trigger_',
    'generate_', 'backup_', 'sync_',
  ], annotation: DISPATCH },
  { prefixes: [
    'set_', 'configure_', 'tag_', 'untag_', 'manage_', 'add_', 'inject_', 'wire_',
    'normalize_', 'update_', 'replace_', 'register_', 'unregister_', 'enable_',
    'disable_', 'activate_', 'toggle_', 'approve_', 'reject_', 'deny_', 'apply_',
    'learn_', 'save_', 'setup_', 'record_', 'resolve_',
  ], annotation: IDEMPOTENT },
  { prefixes: [
    'retry_', 'resume_', 'restore_', 'start_', 'pause_', 'skip_', 'stop_',
    'release_', 'claim_', 'steal_', 'recover_', 'refresh_',
  ], annotation: LIFECYCLE },
  { prefixes: [
    'await_', 'wait_', 'poll_', 'stream_',
  ], annotation: ASYNC_RO },
];

// ── Suffix rules (checked second, only if no prefix matched) ──
const SUFFIX_RULES = [
  { suffixes: [
    '_status', '_info', '_summary', '_history', '_timeline', '_graph', '_path',
    '_stats', '_report', '_dashboard', '_health', '_insights', '_changes', '_quotas',
  ], annotation: READONLY },
];

// ── Exact matches (checked after overrides, before prefix/suffix) ──
const EXACT_MATCHES = Object.freeze({
  ping:             READONLY,
  blocked_tasks:    READONLY,
  critical_path:    READONLY,
  what_if:          READONLY,
  dependency_graph: READONLY,
  batch_cancel:     DESTRUCTIVE,
});

// ── Explicit overrides (checked first — full 4-field objects) ──
const OVERRIDES = Object.freeze({
  peek_interact:                   Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  peek_launch:                     Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  peek_build_and_open:             Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  restart_server:                  Object.freeze({ readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }),
  unlock_all_tools:                Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  unlock_tier:                     Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  commit_task:                     Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  auto_commit_batch:               Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  smart_submit_task:               Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  configure:                       Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  stash_changes:                   Object.freeze({ readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }),
  hashline_read:                   Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  hashline_edit:                   Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  auto_verify_and_fix:             Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  optimize_database:               Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_config_get:            Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_config_set:            Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_config_apply_template: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_config_templates:      Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_usage:                 Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
  strategic_decompose:             Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  strategic_diagnose:              Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  strategic_review:                Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  strategic_benchmark:             Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  audit_codebase:                  Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }),
  batch_retry:                     Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  batch_tag:                       Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
});

/**
 * Get MCP annotations for a tool by name.
 * Resolution order: explicit overrides → exact matches → prefix rules → suffix rules → fallback.
 * @param {string} name - Tool name
 * @returns {{ readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean }}
 */
function getAnnotations(name) {
  // 1. Explicit overrides
  if (OVERRIDES[name]) return OVERRIDES[name];

  // 2. Exact matches
  if (EXACT_MATCHES[name]) return EXACT_MATCHES[name];

  // 3. Prefix rules (first match wins)
  for (const rule of PREFIX_RULES) {
    for (const prefix of rule.prefixes) {
      if (name.startsWith(prefix)) return rule.annotation;
    }
  }

  // 4. Suffix rules (first match wins)
  for (const rule of SUFFIX_RULES) {
    for (const suffix of rule.suffixes) {
      if (name.endsWith(suffix)) return rule.annotation;
    }
  }

  // 5. Fallback
  return FALLBACK;
}

module.exports = {
  getAnnotations,
  OVERRIDES,
  EXACT_MATCHES,
  PREFIX_RULES,
  SUFFIX_RULES,
  FALLBACK,
  // Named annotation constants (for tests and future consumers)
  READONLY, DESTRUCTIVE, DISPATCH, IDEMPOTENT, LIFECYCLE, ASYNC_RO,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tool-annotations.test.js --reporter verbose`
Expected: All prefix convention tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/tool-annotations.js server/tests/tool-annotations.test.js
git commit -m "feat: tool-annotations.js with convention prefix rules and tests"
```

---

### Task 2: Add Override, Exact Match, Suffix, Ordering, and Shape Tests

**Files:**
- Modify: `server/tests/tool-annotations.test.js`

- [ ] **Step 1: Add tests for overrides, suffix, exact match, ordering, fallback, shape, and semantic validity**

Insert the following describe blocks inside the outer `describe('tool-annotations', ...)` block in `server/tests/tool-annotations.test.js`, replacing the `// NOTE: Tasks 2, 3, and 4 add more describe blocks HERE` comment:

```js
  describe('explicit overrides', () => {
    it('peek_interact overrides peek_* readOnly convention', () => {
      expect(getAnnotations('peek_interact')).toEqual(LIFECYCLE); // all false
    });

    it('restart_server is destructive', () => {
      expect(getAnnotations('restart_server')).toEqual({
        readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
      });
    });

    it('smart_submit_task dispatches (not matched by submit_* prefix)', () => {
      expect(getAnnotations('smart_submit_task')).toEqual(DISPATCH);
    });

    it('hashline_read is readOnly despite hashline_edit being mutable', () => {
      expect(getAnnotations('hashline_read')).toEqual(RO);
    });

    it('hashline_edit is all-false (mutable, not destructive, not idempotent)', () => {
      expect(getAnnotations('hashline_edit')).toEqual(LIFECYCLE); // all false
    });

    it('stash_changes is destructive despite *_changes suffix', () => {
      expect(getAnnotations('stash_changes')).toEqual(DESTRUCT);
    });

    it('configure (bare name) is idempotent', () => {
      expect(getAnnotations('configure')).toEqual(IDEMPOTENT);
    });

    it('strategic_decompose dispatches to external LLM', () => {
      expect(getAnnotations('strategic_decompose')).toEqual(DISPATCH);
    });
  });

  describe('exact matches', () => {
    it.each([
      ['ping', RO],
      ['blocked_tasks', RO],
      ['critical_path', RO],
      ['what_if', RO],
      ['dependency_graph', RO],
      ['batch_cancel', DESTRUCT],
    ])('%s → exact match', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });
  });

  describe('suffix rules', () => {
    it('tool ending in _status with no prefix match uses suffix rule', () => {
      expect(getAnnotations('ci_run_status')).toEqual(RO);
    });

    it('tool ending in _dashboard with no prefix match uses suffix rule', () => {
      expect(getAnnotations('coordination_dashboard')).toEqual(RO);
    });

    it('tool ending in _health with no prefix match uses suffix rule', () => {
      expect(getAnnotations('integration_health')).toEqual(RO);
    });
  });

  describe('prefix-before-suffix ordering', () => {
    it('set_task_review_status matches set_* prefix, NOT *_status suffix', () => {
      expect(getAnnotations('set_task_review_status')).toEqual(IDEMPOTENT);
    });

    it('cancel_workflow matches cancel_* prefix (destructive)', () => {
      expect(getAnnotations('cancel_workflow')).toEqual(DESTRUCT);
    });

    it('list_paused_tasks matches list_* prefix (readOnly)', () => {
      expect(getAnnotations('list_paused_tasks')).toEqual(RO);
    });

    it('get_batch_summary matches get_* prefix, not *_summary suffix', () => {
      expect(getAnnotations('get_batch_summary')).toEqual(RO);
    });
  });

  describe('fallback', () => {
    it('unknown tool returns all-false', () => {
      expect(getAnnotations('some_unknown_tool_xyz')).toEqual(LIFECYCLE); // all false
    });
  });

  describe('shape validation', () => {
    it('every annotation has exactly 4 boolean fields', () => {
      const names = ['list_tasks', 'delete_task', 'submit_task', 'set_project_defaults',
        'retry_task', 'await_workflow', 'ping', 'peek_interact', 'some_unknown'];
      const expectedKeys = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
      for (const name of names) {
        const ann = getAnnotations(name);
        expect(Object.keys(ann).sort()).toEqual(expectedKeys.sort());
        for (const key of expectedKeys) {
          expect(typeof ann[key]).toBe('boolean');
        }
      }
    });
  });

  describe('semantic validity', () => {
    it('no annotation is both readOnly and destructive', () => {
      // Test across all convention constants and overrides
      const { OVERRIDES, EXACT_MATCHES, PREFIX_RULES, SUFFIX_RULES } = require('../tool-annotations');
      const allAnnotations = [
        ...Object.values(OVERRIDES),
        ...Object.values(EXACT_MATCHES),
        ...PREFIX_RULES.map(r => r.annotation),
        ...SUFFIX_RULES.map(r => r.annotation),
      ];
      for (const ann of allAnnotations) {
        expect(ann.readOnlyHint && ann.destructiveHint).toBe(false);
      }
    });
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tool-annotations.test.js --reporter verbose`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add server/tests/tool-annotations.test.js
git commit -m "test: override, suffix, ordering, shape, and semantic tests for tool annotations"
```

---

### Task 3: Add validateCoverage Function and Tests

**Files:**
- Modify: `server/tool-annotations.js`
- Modify: `server/tests/tool-annotations.test.js`

- [ ] **Step 1: Write failing tests for validateCoverage**

Insert inside the outer `describe('tool-annotations', ...)` block in `server/tests/tool-annotations.test.js`, before the closing `});`:

```js
  describe('validateCoverage', () => {
    const { validateCoverage, FALLBACK } = require('../tool-annotations');

    it('returns empty uncovered list when all tools are covered', () => {
      const names = ['list_tasks', 'delete_task', 'ping', 'peek_interact'];
      const result = validateCoverage(names);
      expect(result.uncovered).toEqual([]);
    });

    it('detects uncovered tools (hit fallback)', () => {
      const names = ['list_tasks', 'zzz_mystery_tool'];
      const result = validateCoverage(names);
      expect(result.uncovered).toContain('zzz_mystery_tool');
    });

    it('detects stale overrides (override references nonexistent tool)', () => {
      // Add a fake override, then validate against a list that doesn't include it
      const result = validateCoverage(['list_tasks']);
      // stale = overrides that aren't in the provided tool list
      expect(result.stale.length).toBeGreaterThan(0); // many overrides won't be in ['list_tasks']
    });

    it('returns stale list containing override names not in provided tool list', () => {
      const result = validateCoverage([]);
      // All overrides should be stale since no tools provided
      expect(result.stale).toContain('peek_interact');
      expect(result.stale).toContain('restart_server');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tool-annotations.test.js --reporter verbose`
Expected: FAIL — `validateCoverage is not a function`

- [ ] **Step 3: Implement validateCoverage in tool-annotations.js**

Add to `server/tool-annotations.js` before `module.exports`:

```js
/**
 * Validate annotation coverage for a list of tool names.
 * @param {string[]} toolNames - All registered tool names
 * @returns {{ uncovered: string[], stale: string[] }}
 *   uncovered: tools that hit the fallback (no convention, no override, no exact match)
 *   stale: override keys that don't appear in toolNames
 */
function validateCoverage(toolNames) {
  const nameSet = new Set(toolNames);

  const uncovered = [];
  for (const name of toolNames) {
    const ann = getAnnotations(name);
    if (ann === FALLBACK) {
      uncovered.push(name);
    }
  }

  const stale = [];
  for (const name of Object.keys(OVERRIDES)) {
    if (!nameSet.has(name)) {
      stale.push(name);
    }
  }

  return { uncovered, stale };
}
```

Add `validateCoverage` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tool-annotations.test.js --reporter verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/tool-annotations.js server/tests/tool-annotations.test.js
git commit -m "feat: validateCoverage for annotation coverage auditing"
```

---

### Task 4: Integrate into tools.js — Merge Annotations at Startup

**Files:**
- Modify: `server/tools.js` (lines 14-47 and 462-469)
- Modify: `server/tests/tool-annotations.test.js`

- [ ] **Step 1: Write integration tests (shape and semantic only — coverage test added in Task 5)**

Insert inside the outer `describe('tool-annotations', ...)` block in `server/tests/tool-annotations.test.js`, before the closing `});`:

```js
  describe('integration — real TOOLS array', () => {
    it('every tool in TOOLS has annotations after merge', () => {
      const { TOOLS } = require('../tools');
      const expectedKeys = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
      for (const tool of TOOLS) {
        expect(tool.annotations).toBeDefined();
        expect(Object.keys(tool.annotations).sort()).toEqual(expectedKeys.sort());
        for (const key of expectedKeys) {
          expect(typeof tool.annotations[key]).toBe('boolean');
        }
      }
    });

    it('no tool has both readOnly and destructive annotations', () => {
      const { TOOLS } = require('../tools');
      for (const tool of TOOLS) {
        if (tool.annotations.readOnlyHint && tool.annotations.destructiveHint) {
          throw new Error(`Tool "${tool.name}" is both readOnly and destructive`);
        }
      }
    });
  });
```

- [ ] **Step 2: Run integration test to verify it fails**

Run: `cd server && npx vitest run tests/tool-annotations.test.js --reporter verbose -t "integration"`
Expected: FAIL — `tool.annotations` is undefined

- [ ] **Step 3: Modify tools.js to merge annotations at startup**

In `server/tools.js`, after line 47 (after TOOLS array is built from all tool-defs), add:

```js
// ── Merge MCP tool annotations (Phase: MCP ecosystem improvements) ──
const { getAnnotations, validateCoverage } = require('./tool-annotations');

for (const tool of TOOLS) {
  if (tool && tool.name) {
    tool.annotations = getAnnotations(tool.name);
  }
}

// Startup validator: warn on uncovered tools and stale overrides
const _allToolNames = TOOLS.filter(t => t && t.name).map(t => t.name);
const _coverage = validateCoverage(_allToolNames);
if (_coverage.uncovered.length > 0) {
  logger.warn(`[tool-annotations] ${_coverage.uncovered.length} tool(s) have no annotation coverage (fallback used): ${_coverage.uncovered.join(', ')}`);
}
if (_coverage.stale.length > 0) {
  logger.warn(`[tool-annotations] ${_coverage.stale.length} stale override(s) reference nonexistent tools: ${_coverage.stale.join(', ')}`);
}
```

- [ ] **Step 4: Run integration test to verify it passes**

Run: `cd server && npx vitest run tests/tool-annotations.test.js --reporter verbose`
Expected: All tests PASS (including integration tests)

If the "zero uncovered tools" test fails, it will list the uncovered tool names. Add them as explicit overrides in `server/tool-annotations.js` OVERRIDES map or add new convention patterns, then re-run.

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `cd server && npx vitest run --reporter verbose`
Expected: No regressions — all existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add server/tools.js server/tests/tool-annotations.test.js
git commit -m "feat: merge MCP tool annotations into TOOLS at startup with coverage validation"
```

---

### Task 5: Coverage Gap Closure

**Files:**
- Modify: `server/tool-annotations.js`

This task closes coverage gaps and adds the zero-coverage assertion test.

- [ ] **Step 1: Add zero-coverage test and run it to discover uncovered tools**

Insert inside the `describe('integration — real TOOLS array', ...)` block in `server/tests/tool-annotations.test.js`:

```js
    it('validateCoverage reports zero uncovered tools', () => {
      const { TOOLS } = require('../tools');
      const { validateCoverage } = require('../tool-annotations');
      const names = TOOLS.map(t => t.name);
      const result = validateCoverage(names);
      if (result.uncovered.length > 0) {
        throw new Error(
          `${result.uncovered.length} uncovered tools need annotations:\n` +
          result.uncovered.map(n => `  - ${n}`).join('\n')
        );
      }
    });
```

Run: `cd server && npx vitest run tests/tool-annotations.test.js --reporter verbose -t "zero uncovered"`
Expected: FAIL — lists all uncovered tool names. This is the input for the next step.

- [ ] **Step 2: Classify each uncovered tool**

For each uncovered tool name:
1. Read its definition in the relevant `server/tool-defs/*.js` file
2. Read its handler in `server/handlers/*.js` to understand what it does
3. Classify as: readOnly, destructive, dispatch/openWorld, idempotent, lifecycle, or async
4. Decide: add a new prefix convention pattern OR add an explicit override

- [ ] **Step 3: Add overrides or convention patterns**

Add to `OVERRIDES` or `PREFIX_RULES` in `server/tool-annotations.js` as determined in Step 2.

- [ ] **Step 4: Re-run integration test to confirm zero uncovered**

Run: `cd server && npx vitest run tests/tool-annotations.test.js --reporter verbose`
Expected: All tests PASS, including "zero uncovered tools"

- [ ] **Step 5: Run full test suite**

Run: `cd server && npx vitest run --reporter verbose`
Expected: No regressions

- [ ] **Step 6: Commit**

```bash
git add server/tool-annotations.js
git commit -m "feat: close annotation coverage gaps — all tools classified"
```

---

### Task 6: Final Verification

**Files:** None modified — verification only

- [ ] **Step 1: Run full test suite**

Run: `cd server && npx vitest run --reporter verbose`
Expected: All tests PASS

- [ ] **Step 2: Verify annotations appear in MCP tools/list response**

Start TORQUE, connect via MCP, and verify the `tools/list` response includes annotations. This can be done by reading the protocol response or inspecting with:

```bash
# Quick verification: grep for readOnlyHint in a tools/list response
curl -s http://127.0.0.1:3457/api/v2/infrastructure/tools 2>/dev/null | grep -c readOnlyHint
```

Expected: Non-zero count (annotations present on tools)

If no REST endpoint exists for listing tools, verify by inspecting `TOOLS[0].annotations` in a test:

```js
const { TOOLS } = require('../tools');
console.log(JSON.stringify(TOOLS[0].annotations, null, 2));
```

- [ ] **Step 3: Commit plan completion**

```bash
git add docs/superpowers/plans/2026-03-21-mcp-tool-annotations.md
git commit -m "docs: MCP tool annotations implementation plan — complete"
```
