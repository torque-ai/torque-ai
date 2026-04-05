# Visual Sweep Hybrid Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize the visual sweep by automating capture (no agent), adding mechanical pre-analysis, and deduplicating cross-section findings before spawning LLM agents — targeting 55% token reduction.

**Architecture:** The sweep command replaces the capture agent with a direct `peek_action_sequence` loop, adds a new `peek_pre_analyze` MCP tool for mechanical element tree checks, deduplicates findings across sections, and gates LLM agents to only sections needing visual reasoning.

**Tech Stack:** Node.js (snapscope plugin), vitest (tests), MCP tool protocol, peek_action_sequence API.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/plugins/snapscope/handlers/pre-analyze.js` | Create | peek_pre_analyze handler — mechanical element tree checks |
| `server/tests/peek-pre-analyze.test.js` | Create | Tests for pre-analyze handler |
| `server/plugins/snapscope/tool-defs.js` | Modify | Add peek_pre_analyze tool definition |
| `server/plugins/snapscope/handlers/analysis.js` | Modify | Export pre-analyze handler |
| `server/plugins/snapscope/index.js` | Modify | Add peek_pre_analyze to tier 1 |
| `.claude/commands/torque-visual-sweep.md` | Modify | Rewrite Phase 2, add Phases 3a/3b, update 3c/4 |
| `.claude/agents/visual-sweep-analyzer.md` | Modify | Accept pre-analysis context, skip mechanical checks |
| `.claude/agents/visual-sweep-rollup.md` | Modify | Merge pre-analysis + LLM findings |

---

### Task 1: Step Builder and Validator

Utility functions that translate manifest navigation specs into `peek_action_sequence` steps and validate the output. These are pure functions — no MCP, no I/O.

**Files:**
- Create: `server/plugins/snapscope/capture-steps.js`
- Test: `server/tests/capture-steps.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// server/tests/capture-steps.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildCaptureSteps, validateSteps, VALID_NAV_TYPES, VALID_ACTIONS } = require('../plugins/snapscope/capture-steps');

describe('buildCaptureSteps', () => {
  it('builds steps for nav_element type', () => {
    const target = { navigation: { type: 'nav_element', target: 'DashboardNavItem' } };
    const result = buildCaptureSteps(target);
    expect(result.steps).toEqual([
      { action: 'click', element: 'DashboardNavItem' },
      { action: 'sleep', ms: 1000 },
      { action: 'capture' }
    ]);
  });

  it('builds steps for url type', () => {
    const target = { navigation: { type: 'url', target: 'http://localhost:3000/dashboard' } };
    const result = buildCaptureSteps(target);
    expect(result.steps).toEqual([
      { action: 'hotkey', keys: 'ctrl+l' },
      { action: 'type', text: 'http://localhost:3000/dashboard' },
      { action: 'hotkey', keys: 'Enter' },
      { action: 'sleep', ms: 1000 },
      { action: 'capture' }
    ]);
  });

  it('builds steps for keyboard type', () => {
    const target = { navigation: { type: 'keyboard', target: 'F1' } };
    const result = buildCaptureSteps(target);
    expect(result.steps).toEqual([
      { action: 'hotkey', keys: 'F1' },
      { action: 'sleep', ms: 1000 },
      { action: 'capture' }
    ]);
  });

  it('builds steps for menu type', () => {
    const target = { navigation: { type: 'menu', target: ['File', 'Preferences'] } };
    const result = buildCaptureSteps(target);
    expect(result.steps).toEqual([
      { action: 'click', element: 'File' },
      { action: 'click', element: 'Preferences' },
      { action: 'sleep', ms: 1000 },
      { action: 'capture' }
    ]);
  });

  it('builds steps for discovered type', () => {
    const target = { navigation: { type: 'discovered', element: 'SettingsGear' } };
    const result = buildCaptureSteps(target);
    expect(result.steps).toEqual([
      { action: 'click', element: 'SettingsGear' },
      { action: 'sleep', ms: 1000 },
      { action: 'capture' }
    ]);
  });

  it('uses custom settle_ms', () => {
    const target = { navigation: { type: 'nav_element', target: 'SlowPage' }, settle_ms: 3000 };
    const result = buildCaptureSteps(target);
    expect(result.steps[1]).toEqual({ action: 'sleep', ms: 3000 });
  });

  it('returns error for unknown nav type', () => {
    const target = { navigation: { type: 'swipe', target: 'x' } };
    const result = buildCaptureSteps(target);
    expect(result.error).toContain('Unknown navigation type');
    expect(result.error).toContain('swipe');
  });

  it('returns error for missing navigation', () => {
    const result = buildCaptureSteps({});
    expect(result.error).toBeDefined();
  });

  it('returns error for nav_element with no target', () => {
    const target = { navigation: { type: 'nav_element' } };
    const result = buildCaptureSteps(target);
    expect(result.error).toContain('target');
  });

  it('returns error for menu with empty path', () => {
    const target = { navigation: { type: 'menu', target: [] } };
    const result = buildCaptureSteps(target);
    expect(result.error).toContain('menu');
  });
});

describe('validateSteps', () => {
  it('returns null for valid steps', () => {
    const steps = [
      { action: 'click', element: 'Btn' },
      { action: 'sleep', ms: 1000 },
      { action: 'capture' }
    ];
    expect(validateSteps(steps)).toBeNull();
  });

  it('rejects empty array', () => {
    expect(validateSteps([])).toContain('Empty');
  });

  it('rejects non-array', () => {
    expect(validateSteps('not an array')).toContain('Empty');
  });

  it('rejects unknown action', () => {
    expect(validateSteps([{ action: 'clck' }])).toContain('Invalid action');
  });

  it('rejects click without element or coordinates', () => {
    expect(validateSteps([{ action: 'click' }])).toContain('element or coordinates');
  });

  it('rejects type without text', () => {
    expect(validateSteps([{ action: 'type' }])).toContain('text');
  });

  it('rejects hotkey without keys', () => {
    expect(validateSteps([{ action: 'hotkey' }])).toContain('keys');
  });

  it('accepts click with coordinates', () => {
    expect(validateSteps([{ action: 'click', x: 100, y: 200 }])).toBeNull();
  });

  it('accepts all valid action types', () => {
    for (const action of VALID_ACTIONS) {
      const step = { action };
      if (action === 'click') step.element = 'X';
      if (action === 'type') step.text = 'X';
      if (action === 'hotkey') step.keys = 'X';
      expect(validateSteps([step])).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/capture-steps.test.js`
Expected: FAIL — module `../plugins/snapscope/capture-steps` not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/plugins/snapscope/capture-steps.js
'use strict';

const VALID_NAV_TYPES = new Set(['nav_element', 'url', 'keyboard', 'menu', 'discovered']);
const VALID_ACTIONS = new Set(['click', 'type', 'hotkey', 'scroll', 'wait', 'sleep', 'capture', 'focus']);
const DEFAULT_SETTLE_MS = 1000;

function buildCaptureSteps(target) {
  const nav = target && target.navigation;
  if (!nav || !nav.type) {
    return { error: 'Target missing navigation or navigation.type' };
  }

  if (!VALID_NAV_TYPES.has(nav.type)) {
    return { error: `Unknown navigation type: "${nav.type}". Valid: ${[...VALID_NAV_TYPES].join(', ')}` };
  }

  const settleMs = target.settle_ms || DEFAULT_SETTLE_MS;
  let navSteps;

  switch (nav.type) {
    case 'nav_element':
      if (!nav.target) return { error: 'nav_element requires navigation.target' };
      navSteps = [{ action: 'click', element: nav.target }];
      break;

    case 'url':
      if (!nav.target) return { error: 'url requires navigation.target' };
      navSteps = [
        { action: 'hotkey', keys: 'ctrl+l' },
        { action: 'type', text: nav.target },
        { action: 'hotkey', keys: 'Enter' },
      ];
      break;

    case 'keyboard':
      if (!nav.target) return { error: 'keyboard requires navigation.target' };
      navSteps = [{ action: 'hotkey', keys: nav.target }];
      break;

    case 'menu':
      if (!Array.isArray(nav.target) || nav.target.length === 0) {
        return { error: 'menu requires navigation.target as a non-empty array of menu item names' };
      }
      navSteps = nav.target.map(item => ({ action: 'click', element: item }));
      break;

    case 'discovered':
      if (!nav.element) return { error: 'discovered requires navigation.element' };
      navSteps = [{ action: 'click', element: nav.element }];
      break;
  }

  const steps = [...navSteps, { action: 'sleep', ms: settleMs }, { action: 'capture' }];
  return { steps };
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 'Empty steps array';
  for (const step of steps) {
    if (!step.action || !VALID_ACTIONS.has(step.action)) {
      return `Invalid action: "${step.action}". Valid: ${[...VALID_ACTIONS].join(', ')}`;
    }
    if (step.action === 'click' && !step.element && step.x == null) {
      return 'Click requires element or coordinates (x, y)';
    }
    if (step.action === 'type' && !step.text) {
      return 'Type requires text';
    }
    if (step.action === 'hotkey' && !step.keys) {
      return 'Hotkey requires keys';
    }
  }
  return null;
}

module.exports = { buildCaptureSteps, validateSteps, VALID_NAV_TYPES, VALID_ACTIONS, DEFAULT_SETTLE_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/capture-steps.test.js`
Expected: PASS (all 16 tests).

- [ ] **Step 5: Commit**

```bash
git add server/plugins/snapscope/capture-steps.js server/tests/capture-steps.test.js
git commit -m "feat: add step builder and validator for automated visual sweep capture"
```

---

### Task 2: peek_pre_analyze MCP Tool

New handler that runs mechanical checks on a capture bundle's element tree. Pure JSON traversal — no network, no LLM.

**Files:**
- Create: `server/plugins/snapscope/handlers/pre-analyze.js`
- Test: `server/tests/peek-pre-analyze.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// server/tests/peek-pre-analyze.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { analyzeElementTree } = require('../plugins/snapscope/handlers/pre-analyze');

const INTERACTIVE_TYPES = ['Button', 'Edit', 'ComboBox', 'RadioButton', 'MenuItem', 'CheckBox', 'Hyperlink', 'Slider', 'TabItem'];

describe('analyzeElementTree', () => {
  it('detects missing accessible names on interactive elements', () => {
    const tree = [
      { name: '', type: 'Button', automation_id: 'SaveBtn', bounds: { x: 0, y: 0, w: 80, h: 30 }, children: [] },
      { name: 'Cancel', type: 'Button', automation_id: 'CancelBtn', bounds: { x: 100, y: 0, w: 80, h: 30 }, children: [] }
    ];
    const result = analyzeElementTree(tree, 'test-section');
    const nameFindings = result.findings.filter(f => f.check === 'missing_name');
    expect(nameFindings).toHaveLength(1);
    expect(nameFindings[0].automation_id).toBe('SaveBtn');
    expect(nameFindings[0].severity).toBe('HIGH');
  });

  it('ignores missing names on non-interactive elements', () => {
    const tree = [
      { name: '', type: 'Text', automation_id: '', bounds: { x: 0, y: 0, w: 100, h: 20 }, children: [] }
    ];
    const result = analyzeElementTree(tree, 'test-section');
    const nameFindings = result.findings.filter(f => f.check === 'missing_name');
    expect(nameFindings).toHaveLength(0);
  });

  it('detects bounds overflow', () => {
    const tree = [
      {
        name: 'Container', type: 'Group', bounds: { x: 0, y: 0, w: 200, h: 100 },
        children: [
          { name: 'Overflow', type: 'Button', bounds: { x: 180, y: 0, w: 50, h: 30 }, children: [] }
        ]
      }
    ];
    const result = analyzeElementTree(tree, 'test-section');
    const overflows = result.findings.filter(f => f.check === 'bounds_overflow');
    expect(overflows).toHaveLength(1);
    expect(overflows[0].element_name).toBe('Overflow');
    expect(overflows[0].severity).toBe('MEDIUM');
  });

  it('detects empty containers', () => {
    const tree = [
      { name: 'ItemList', type: 'List', automation_id: 'MainList', bounds: { x: 0, y: 0, w: 300, h: 400 }, children: [] }
    ];
    const result = analyzeElementTree(tree, 'test-section');
    const empties = result.findings.filter(f => f.check === 'empty_container');
    expect(empties).toHaveLength(1);
    expect(empties[0].element_name).toBe('ItemList');
    expect(empties[0].severity).toBe('MEDIUM');
  });

  it('does not flag non-container empty elements', () => {
    const tree = [
      { name: 'Label', type: 'Text', bounds: { x: 0, y: 0, w: 100, h: 20 }, children: [] }
    ];
    const result = analyzeElementTree(tree, 'test-section');
    const empties = result.findings.filter(f => f.check === 'empty_container');
    expect(empties).toHaveLength(0);
  });

  it('detects small interactive elements', () => {
    const tree = [
      { name: 'Tiny', type: 'Button', bounds: { x: 0, y: 0, w: 16, h: 16 }, children: [] }
    ];
    const result = analyzeElementTree(tree, 'test-section');
    const smalls = result.findings.filter(f => f.check === 'small_interactive');
    expect(smalls).toHaveLength(1);
    expect(smalls[0].severity).toBe('LOW');
  });

  it('detects duplicate automation IDs', () => {
    const tree = [
      { name: 'A', type: 'Button', automation_id: 'DupeId', bounds: { x: 0, y: 0, w: 80, h: 30 }, children: [] },
      { name: 'B', type: 'Button', automation_id: 'DupeId', bounds: { x: 100, y: 0, w: 80, h: 30 }, children: [] }
    ];
    const result = analyzeElementTree(tree, 'test-section');
    const dupes = result.findings.filter(f => f.check === 'duplicate_automation_id');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].automation_id).toBe('DupeId');
    expect(dupes[0].severity).toBe('MEDIUM');
  });

  it('walks nested children', () => {
    const tree = [
      {
        name: 'Panel', type: 'Group', bounds: { x: 0, y: 0, w: 500, h: 500 },
        children: [
          {
            name: 'SubPanel', type: 'Group', bounds: { x: 10, y: 10, w: 200, h: 200 },
            children: [
              { name: '', type: 'Edit', automation_id: 'DeepInput', bounds: { x: 20, y: 20, w: 100, h: 30 }, children: [] }
            ]
          }
        ]
      }
    ];
    const result = analyzeElementTree(tree, 'test-section');
    const nameFindings = result.findings.filter(f => f.check === 'missing_name');
    expect(nameFindings).toHaveLength(1);
    expect(nameFindings[0].automation_id).toBe('DeepInput');
  });

  it('returns stats', () => {
    const tree = [
      { name: 'Btn', type: 'Button', bounds: { x: 0, y: 0, w: 80, h: 30 }, children: [] },
      { name: 'Lbl', type: 'Text', bounds: { x: 0, y: 40, w: 100, h: 20 }, children: [] }
    ];
    const result = analyzeElementTree(tree, 'test-section');
    expect(result.stats.total_elements).toBe(2);
    expect(result.stats.interactive).toBe(1);
    expect(result.stats.checks_run).toBe(5);
  });

  it('returns empty findings for clean tree', () => {
    const tree = [
      { name: 'OK', type: 'Button', automation_id: 'OkBtn', bounds: { x: 0, y: 0, w: 80, h: 30 }, children: [] }
    ];
    const result = analyzeElementTree(tree, 'test-section');
    expect(result.findings).toHaveLength(0);
    expect(result.flagged_elements).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/peek-pre-analyze.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/plugins/snapscope/handlers/pre-analyze.js
'use strict';

const INTERACTIVE_TYPES = new Set([
  'Button', 'Edit', 'ComboBox', 'RadioButton', 'MenuItem',
  'CheckBox', 'Hyperlink', 'Slider', 'TabItem',
]);

const CONTAINER_TYPES = new Set([
  'List', 'DataGrid', 'TreeView', 'Tree', 'Table', 'Custom',
]);

const MIN_INTERACTIVE_SIZE = 24;

function analyzeElementTree(tree, sectionId) {
  const findings = [];
  const flaggedElements = new Set();
  const automationIdCounts = new Map();
  let totalElements = 0;
  let interactiveCount = 0;

  function walk(nodes, parent) {
    for (const node of (nodes || [])) {
      if (!node || typeof node !== 'object') continue;
      totalElements++;

      const isInteractive = INTERACTIVE_TYPES.has(node.type);
      if (isInteractive) interactiveCount++;

      // Check 1: Missing accessible names on interactive elements
      if (isInteractive && (!node.name || node.name.trim() === '')) {
        findings.push({
          check: 'missing_name',
          severity: 'HIGH',
          section_id: sectionId,
          element_type: node.type,
          element_name: node.name || '',
          automation_id: node.automation_id || '',
          bounds: node.bounds || {},
          parent: parent ? (parent.name || parent.type) : null,
        });
        flaggedElements.add(node.automation_id || node.type + ':unnamed');
      }

      // Check 2: Bounds overflow (child exceeds parent)
      if (parent && parent.bounds && node.bounds) {
        const pb = parent.bounds;
        const cb = node.bounds;
        if (pb.w > 0 && pb.h > 0 && cb.w > 0 && cb.h > 0) {
          const overflowX = (cb.x + cb.w) > (pb.x + pb.w);
          const overflowY = (cb.y + cb.h) > (pb.y + pb.h);
          if (overflowX || overflowY) {
            findings.push({
              check: 'bounds_overflow',
              severity: 'MEDIUM',
              section_id: sectionId,
              element_type: node.type,
              element_name: node.name || '',
              automation_id: node.automation_id || '',
              bounds: cb,
              parent_bounds: pb,
              parent: parent.name || parent.type,
              overflow_x: overflowX,
              overflow_y: overflowY,
            });
            flaggedElements.add(node.automation_id || node.name || node.type);
          }
        }
      }

      // Check 3: Empty containers
      if (CONTAINER_TYPES.has(node.type) && (!node.children || node.children.length === 0)) {
        findings.push({
          check: 'empty_container',
          severity: 'MEDIUM',
          section_id: sectionId,
          element_type: node.type,
          element_name: node.name || '',
          automation_id: node.automation_id || '',
          bounds: node.bounds || {},
          parent: parent ? (parent.name || parent.type) : null,
        });
        flaggedElements.add(node.automation_id || node.name || node.type);
      }

      // Check 4: Small interactive elements
      if (isInteractive && node.bounds) {
        if (node.bounds.w < MIN_INTERACTIVE_SIZE || node.bounds.h < MIN_INTERACTIVE_SIZE) {
          findings.push({
            check: 'small_interactive',
            severity: 'LOW',
            section_id: sectionId,
            element_type: node.type,
            element_name: node.name || '',
            automation_id: node.automation_id || '',
            bounds: node.bounds,
            parent: parent ? (parent.name || parent.type) : null,
          });
          flaggedElements.add(node.automation_id || node.name || node.type);
        }
      }

      // Collect automation IDs for duplicate check
      if (node.automation_id) {
        automationIdCounts.set(node.automation_id, (automationIdCounts.get(node.automation_id) || 0) + 1);
      }

      // Recurse into children
      if (Array.isArray(node.children)) {
        walk(node.children, node);
      }
    }
  }

  walk(tree, null);

  // Check 5: Duplicate automation IDs
  for (const [id, count] of automationIdCounts) {
    if (count > 1) {
      findings.push({
        check: 'duplicate_automation_id',
        severity: 'MEDIUM',
        section_id: sectionId,
        automation_id: id,
        count,
      });
      flaggedElements.add(id);
    }
  }

  return {
    findings,
    flagged_elements: [...flaggedElements],
    stats: {
      total_elements: totalElements,
      interactive: interactiveCount,
      checks_run: 5,
      findings: findings.length,
    },
  };
}

module.exports = { analyzeElementTree, INTERACTIVE_TYPES, CONTAINER_TYPES, MIN_INTERACTIVE_SIZE };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/peek-pre-analyze.test.js`
Expected: PASS (all 10 tests).

- [ ] **Step 5: Commit**

```bash
git add server/plugins/snapscope/handlers/pre-analyze.js server/tests/peek-pre-analyze.test.js
git commit -m "feat: add peek_pre_analyze element tree analysis engine"
```

---

### Task 3: Wire peek_pre_analyze as MCP Tool

Register the pre-analyze handler as an MCP tool so the sweep command can call it.

**Files:**
- Modify: `server/plugins/snapscope/tool-defs.js` (add tool definition)
- Modify: `server/plugins/snapscope/handlers/analysis.js` (export handler)
- Modify: `server/plugins/snapscope/index.js` (add to tier 1)
- Test: `server/tests/peek-pre-analyze-mcp.test.js`

- [ ] **Step 1: Write the MCP handler wrapper**

Add to `server/plugins/snapscope/handlers/analysis.js` before the `module.exports`:

```js
async function handlePeekPreAnalyze(args) {
  try {
    const { analyzeElementTree } = require('./pre-analyze');
    const fs = require('fs');

    if (!args.capture_path) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'capture_path is required');
    }

    let bundle;
    try {
      const raw = fs.readFileSync(args.capture_path, 'utf-8');
      bundle = JSON.parse(raw);
    } catch (err) {
      return makeError(ErrorCodes.INVALID_PARAM, `Cannot read capture bundle: ${err.message}`);
    }

    const elements = bundle.elements || bundle.bundle?.elements || [];
    if (!Array.isArray(elements) || elements.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          findings: [],
          flagged_elements: [],
          stats: { total_elements: 0, interactive: 0, checks_run: 5, findings: 0 }
        }) }]
      };
    }

    const sectionId = args.section_id || 'unknown';
    const result = analyzeElementTree(elements, sectionId);

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}
```

- [ ] **Step 2: Add to module.exports in analysis.js**

Add `handlePeekPreAnalyze` to the `module.exports` object in `server/plugins/snapscope/handlers/analysis.js`:

```js
module.exports = {
  handlePeekElements,
  handlePeekWait,
  handlePeekOcr,
  handlePeekAssert,
  handlePeekHitTest,
  handlePeekColor,
  handlePeekTable,
  handlePeekSummary,
  handlePeekCdp,
  handlePeekRegression,
  handlePeekDiagnose,
  handlePeekSemanticDiff,
  handlePeekActionSequence,
  handlePeekPreAnalyze,
};
```

- [ ] **Step 3: Add tool definition to tool-defs.js**

Add to the end of the tools array in `server/plugins/snapscope/tool-defs.js`:

```js
  {
    name: 'peek_pre_analyze',
    description: 'Run mechanical accessibility and layout checks on a capture bundle element tree. Returns findings for missing accessible names, bounds overflow, empty containers, small interactive elements, and duplicate automation IDs. No network calls — pure JSON analysis. Use before spawning LLM analysis agents to pre-filter mechanical issues.',
    inputSchema: {
      type: 'object',
      properties: {
        capture_path: {
          type: 'string',
          description: 'Absolute path to the capture bundle JSON file (from peek_diagnose output)'
        },
        section_id: {
          type: 'string',
          description: 'Section identifier for findings attribution'
        },
        section_label: {
          type: 'string',
          description: 'Human-readable section name'
        }
      },
      required: ['capture_path']
    }
  },
```

- [ ] **Step 4: Add peek_pre_analyze to tier 1 in index.js**

In `server/plugins/snapscope/index.js`, add `'peek_pre_analyze'` to the tier1 array:

```js
      tier1: [
        'peek_ui', 'peek_interact', 'peek_elements', 'peek_diagnose',
        'peek_wait', 'peek_launch', 'peek_action_sequence', 'peek_pre_analyze',
      ],
```

- [ ] **Step 5: Commit**

```bash
git add server/plugins/snapscope/handlers/analysis.js server/plugins/snapscope/tool-defs.js server/plugins/snapscope/index.js
git commit -m "feat: wire peek_pre_analyze as tier 1 MCP tool"
```

---

### Task 4: Cross-Section Dedup Logic

Utility that takes pre-analysis results from all sections and produces a dedup context with global findings and per-section flags.

**Files:**
- Create: `server/plugins/snapscope/sweep-dedup.js`
- Test: `server/tests/sweep-dedup.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// server/tests/sweep-dedup.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { deduplicateFindings, buildFindingSignature } = require('../plugins/snapscope/sweep-dedup');

describe('buildFindingSignature', () => {
  it('builds signature from check + type + automation_id + name', () => {
    const finding = { check: 'missing_name', element_type: 'Button', automation_id: 'SaveBtn', element_name: '' };
    expect(buildFindingSignature(finding)).toBe('missing_name:Button:SaveBtn:');
  });

  it('handles missing fields', () => {
    const finding = { check: 'empty_container', element_type: 'List' };
    expect(buildFindingSignature(finding)).toBe('empty_container:List::');
  });
});

describe('deduplicateFindings', () => {
  it('identifies global findings appearing in 3+ sections', () => {
    const perSection = {
      dashboard: {
        findings: [
          { check: 'missing_name', element_type: 'Button', automation_id: 'SearchBtn', element_name: '', severity: 'HIGH' }
        ],
        flagged_elements: ['SearchBtn'],
        stats: { total_elements: 50, interactive: 10, checks_run: 5, findings: 1 }
      },
      sales: {
        findings: [
          { check: 'missing_name', element_type: 'Button', automation_id: 'SearchBtn', element_name: '', severity: 'HIGH' }
        ],
        flagged_elements: ['SearchBtn'],
        stats: { total_elements: 60, interactive: 12, checks_run: 5, findings: 1 }
      },
      purchasing: {
        findings: [
          { check: 'missing_name', element_type: 'Button', automation_id: 'SearchBtn', element_name: '', severity: 'HIGH' }
        ],
        flagged_elements: ['SearchBtn'],
        stats: { total_elements: 45, interactive: 8, checks_run: 5, findings: 1 }
      }
    };

    const result = deduplicateFindings(perSection);
    expect(result.global_findings).toHaveLength(1);
    expect(result.global_findings[0].sections_affected).toBe(3);
    expect(result.global_findings[0].signature).toContain('SearchBtn');
  });

  it('keeps unique findings per section', () => {
    const perSection = {
      dashboard: {
        findings: [
          { check: 'empty_container', element_type: 'List', automation_id: 'WidgetGrid', element_name: 'Widgets', severity: 'MEDIUM' }
        ],
        flagged_elements: ['WidgetGrid'],
        stats: { total_elements: 50, interactive: 10, checks_run: 5, findings: 1 }
      },
      sales: {
        findings: [
          { check: 'bounds_overflow', element_type: 'Button', automation_id: 'ExportBtn', element_name: 'Export', severity: 'MEDIUM' }
        ],
        flagged_elements: ['ExportBtn'],
        stats: { total_elements: 60, interactive: 12, checks_run: 5, findings: 1 }
      }
    };

    const result = deduplicateFindings(perSection);
    expect(result.global_findings).toHaveLength(0);
    expect(result.per_section.dashboard.unique_findings).toBe(1);
    expect(result.per_section.sales.unique_findings).toBe(1);
  });

  it('sets needs_llm based on unique findings', () => {
    const perSection = {
      clean: { findings: [], flagged_elements: [], stats: { total_elements: 20, interactive: 5, checks_run: 5, findings: 0 } },
      dirty: {
        findings: [{ check: 'empty_container', element_type: 'List', automation_id: 'X', element_name: 'X', severity: 'MEDIUM' }],
        flagged_elements: ['X'],
        stats: { total_elements: 30, interactive: 8, checks_run: 5, findings: 1 }
      }
    };

    const result = deduplicateFindings(perSection);
    expect(result.per_section.clean.needs_llm).toBe(false);
    expect(result.per_section.dirty.needs_llm).toBe(true);
  });

  it('returns empty global_findings when no duplicates', () => {
    const perSection = {
      a: { findings: [], flagged_elements: [], stats: { total_elements: 10, interactive: 2, checks_run: 5, findings: 0 } }
    };
    const result = deduplicateFindings(perSection);
    expect(result.global_findings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/sweep-dedup.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/plugins/snapscope/sweep-dedup.js
'use strict';

const GLOBAL_THRESHOLD = 3;

function buildFindingSignature(finding) {
  return [
    finding.check || '',
    finding.element_type || '',
    finding.automation_id || '',
    finding.element_name || '',
  ].join(':');
}

function deduplicateFindings(perSection) {
  // Count how many sections each finding signature appears in
  const signatureSections = new Map();

  for (const [sectionId, result] of Object.entries(perSection)) {
    for (const finding of (result.findings || [])) {
      const sig = buildFindingSignature(finding);
      if (!signatureSections.has(sig)) {
        signatureSections.set(sig, { finding, sections: new Set() });
      }
      signatureSections.get(sig).sections.add(sectionId);
    }
  }

  // Global findings: signature appears in 3+ sections
  const globalSignatures = new Set();
  const globalFindings = [];
  for (const [sig, data] of signatureSections) {
    if (data.sections.size >= GLOBAL_THRESHOLD) {
      globalSignatures.add(sig);
      globalFindings.push({
        signature: sig,
        sections_affected: data.sections.size,
        finding: data.finding,
      });
    }
  }

  // Per-section: remove global findings, compute unique counts
  const perSectionResult = {};
  for (const [sectionId, result] of Object.entries(perSection)) {
    const uniqueFindings = (result.findings || []).filter(
      f => !globalSignatures.has(buildFindingSignature(f))
    );
    const uniqueFlagged = (result.flagged_elements || []).filter(
      el => !globalFindings.some(g => g.finding.automation_id === el)
    );

    perSectionResult[sectionId] = {
      unique_findings: uniqueFindings.length,
      unique_finding_list: uniqueFindings,
      flagged_elements: uniqueFlagged,
      needs_llm: uniqueFindings.length > 0 || uniqueFlagged.length > 0,
    };
  }

  return {
    global_findings: globalFindings,
    per_section: perSectionResult,
  };
}

module.exports = { deduplicateFindings, buildFindingSignature, GLOBAL_THRESHOLD };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/sweep-dedup.test.js`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/plugins/snapscope/sweep-dedup.js server/tests/sweep-dedup.test.js
git commit -m "feat: add cross-section finding deduplication for visual sweep"
```

---

### Task 5: Update Sweep Command (Phases 2, 3a, 3b, 3c, 4)

Rewrite the `/torque-visual-sweep` command to use automated capture, pre-analysis, dedup, and optimized LLM fleet.

**Files:**
- Modify: `.claude/commands/torque-visual-sweep.md`
- Modify: `~/.claude/plugins/marketplaces/local-plugins/plugins/torque/commands/torque-visual-sweep.md` (sync)
- Modify: `~/.claude/plugins/cache/local-plugins/torque/2.0.0/commands/torque-visual-sweep.md` (sync)

- [ ] **Step 1: Rewrite the command**

Replace the content of `.claude/commands/torque-visual-sweep.md` starting from `## Immediate Mode` with the updated phases. Keep everything above (frontmatter, Arguments, Locate Project, Scheduled Mode) unchanged.

New `## Immediate Mode` section:

```markdown
## Immediate Mode

### Phase 1: Discovery (unchanged)

Read `.claude/agents/visual-sweep-discovery.md` and extract the markdown body (after frontmatter).

Spawn the discovery agent:

    Agent({
      name: "sweep-discovery",
      prompt: "You are running a visual sweep discovery phase.\n\nApp: <app>\nWorking directory: <project dir>\nDepth: <depth>\nSection filter: <section or none>\n\n<discovery agent body>",
      model: "opus",
      mode: "auto"
    })

Wait for completion. If discovery fails, report the error and stop.

Report to user:

    Phase 1 — Discovery complete:
      - <N> sections found (<M> from manifest, <K> discovered)
      - <U> unreachable sections
      - Sweep plan: <plan_path>

### Phase 2: Capture (automated — no agent)

Read the sweep plan JSON. For each target with status "pending":

1. **Build steps** using the navigation spec:
   - `nav_element`: `[{action:"click", element:"<target>"}, {action:"sleep", ms:<settle_ms>}, {action:"capture"}]`
   - `url`: `[{action:"hotkey", keys:"ctrl+l"}, {action:"type", text:"<target>"}, {action:"hotkey", keys:"Enter"}, {action:"sleep", ms:<settle_ms>}, {action:"capture"}]`
   - `keyboard`: `[{action:"hotkey", keys:"<target>"}, {action:"sleep", ms:<settle_ms>}, {action:"capture"}]`
   - `menu`: `[{action:"click", element:"<item1>"}, {action:"click", element:"<item2>"}, ..., {action:"sleep", ms:<settle_ms>}, {action:"capture"}]`
   - `discovered`: `[{action:"click", element:"<element>"}, {action:"sleep", ms:<settle_ms>}, {action:"capture"}]`
   - Default `settle_ms`: 1000. Override per-section in manifest with `"settle_ms": N`.

2. **Validate steps** — check each step has a valid action and required fields. If invalid, mark target as `"status": "invalid"` and skip.

3. **Execute** via `peek_action_sequence({ process: "<process>", steps: <built steps> })`.

4. **Save** the capture result to `<working_directory>/docs/visual-sweep-captures/<target.id>.json`.

5. **Update** target status to `"captured"`. On failure, retry once. If app crashed (window not found), attempt `peek_launch`, wait 10s, retry. On second failure, mark `"status": "failed"` and continue.

Report to user:

    Phase 2 — Capture complete:
      - <N> sections captured, <F> failed, <I> invalid
      - Captures in: <capture_dir>

**Fallback:** If the manifest has `"capture_mode": "agent"`, spawn the capture coordinator agent instead (original Phase 2 behavior). Read `.claude/agents/visual-sweep-capture.md` and spawn as before.

### Phase 3a: Pre-Analysis (mechanical checks)

For each captured target, call:

    peek_pre_analyze({ capture_path: "<capture_dir>/<target.id>.json", section_id: "<target.id>", section_label: "<target.label>" })

Collect results into a `pre_analysis` map keyed by section ID.

Report to user:

    Phase 3a — Pre-analysis complete:
      - <N> sections analyzed
      - <F> total mechanical findings
      - Top issues: <list top 3 by frequency>

### Phase 3b: Dedup (cross-section filtering)

Build finding signatures from all pre-analysis results. A finding appearing in 3+ sections is "global" — report once, don't send to individual scouts.

For each section, compute:
- `unique_findings`: findings not in the global set
- `flagged_elements`: elements with issues not covered by global dedup
- `needs_llm`: true if unique_findings > 0 OR flagged_elements > 0

Report to user:

    Phase 3b — Dedup complete:
      - <G> global findings (will report once)
      - <L> sections need LLM analysis, <S> sections skip LLM

### Phase 3c: Analysis Fleet (optimized)

Read `.claude/agents/visual-sweep-analyzer.md` and extract the body.

**For sections where `needs_llm` is true**, spawn a full analysis scout:

    Agent({
      name: "sweep-analyzer-<section_id>",
      prompt: "You are an analysis scout in a visual sweep fleet.\n\nApp: <app>\nSection ID: <target.id>\nSection Label: <target.label>\nCapture path: <capture_dir>/<target.id>.json\nWorking directory: <project dir>\nFramework: <framework>\nManifest section: <JSON or null>\n\n## Pre-Analysis Context\nThe following mechanical issues were already found by automated pre-analysis. Do NOT re-report these — focus on visual issues, stale content, novel problems, and source tracing.\n\nGlobal findings (reported separately): <JSON list of global finding signatures>\nThis section's automated findings: <JSON list of unique findings for this section>\n\n<analyzer agent body>",
      model: "opus",
      mode: "auto",
      run_in_background: true
    })

**For sections where `needs_llm` is false**, spawn a lightweight screenshot-only scout:

    Agent({
      name: "sweep-lite-<section_id>",
      prompt: "You are a lightweight visual scout. Check this screenshot for visual-only issues (wrong colors, misaligned images, stale content, broken layouts) that automated element tree analysis cannot detect. The element tree was already checked mechanically — only report issues visible in the screenshot.\n\nApp: <app>\nSection: <target.label>\nCapture path: <capture_dir>/<target.id>.json\nWorking directory: <project dir>\n\nRead the capture bundle. Look ONLY at the screenshot and annotated screenshot. If you find visual issues, write findings to docs/findings/<date>-visual-sweep-<app>-<section_id>.md. If the section looks clean, report 0 findings.\n\nAfter writing (or deciding 0 findings), send:\nSendMessage({ to: 'orchestrator', message: { type: 'analysis_complete', section_id: '<id>', findings_path: '<path or null>', finding_count: N, severity_counts: {critical:0,high:0,medium:0,low:0} } })",
      model: "sonnet",
      mode: "auto",
      run_in_background: true
    })

Note: lightweight scouts use **sonnet** (cheaper, sufficient for visual-only checks).

Collect all results as agents complete.

### Phase 4: Rollup (updated — merges both sources)

Read `.claude/agents/visual-sweep-rollup.md` and extract the body.

Spawn the rollup agent with combined context:

    Agent({
      name: "sweep-rollup",
      prompt: "You are the rollup agent for a visual sweep.\n\nApp: <app>\nFindings directory: docs/findings/\nDate: <today>\nPlan path: <plan_path>\n\n## Pre-Analysis Findings\nGlobal findings (cross-section, reported once):\n<JSON of global_findings>\n\nPer-section automated findings (sections that skipped LLM):\n<JSON of pre-analysis findings for non-LLM sections>\n\n## LLM Analysis Results\n<JSON array of analysis scout results>\n\nMerge ALL finding sources into a single summary. Include pre-analysis findings alongside LLM findings. Mark pre-analysis findings with source: 'automated' and LLM findings with source: 'visual-analysis'.\n\n<rollup agent body>",
      model: "sonnet",
      mode: "auto"
    })

Wait for completion.

### Phase 5: Report + Cleanup (unchanged)

Present to user:

    ## Visual Sweep Complete: <app>

    **Mode:** hybrid (automated capture + pre-analysis + LLM fleet)
    **Sections:** <captured>/<total> captured
    **Findings:** <total> (<automated> automated, <llm> visual analysis)
      - <critical> critical, <high> high, <medium> medium, <low> low

    ### Pre-Analysis (mechanical)
    - <G> global findings, <S> section-specific
    - Top: <list top 3>

    ### LLM Analysis
    - <L> sections analyzed by LLM, <K> sections skipped (clean)
    - <F> additional findings from visual reasoning

    ### Summary
    See: <summary file path>

    ### Action Items
    - <list CRITICAL and HIGH findings>
    - To fix: /torque-team <summary file path>

Remove temporary capture files. Keep findings files.

### Mode Flag

If the user passes `--mode full`, skip Phases 3a and 3b entirely. Run the original Phase 3 (all-LLM fleet, no pre-analysis, no dedup). This is the Take 5 behavior.

Default is `--mode hybrid`.
```

- [ ] **Step 2: Update argument parsing to include --mode**

In the Arguments section of the command, add:

```markdown
- `--mode` — "hybrid" (default) or "full". Hybrid uses automated capture + pre-analysis + dedup. Full uses original all-agent approach.
```

- [ ] **Step 3: Sync to plugin directories**

```bash
SRC=".claude/commands/torque-visual-sweep.md"
cp "$SRC" ~/.claude/plugins/marketplaces/local-plugins/plugins/torque/commands/torque-visual-sweep.md
cp "$SRC" ~/.claude/plugins/cache/local-plugins/torque/2.0.0/commands/torque-visual-sweep.md
```

- [ ] **Step 4: Commit**

```bash
git add .claude/commands/torque-visual-sweep.md
git commit -m "feat: rewrite visual sweep command with hybrid capture + pre-analysis + dedup"
```

---

### Task 6: Update Agent Definitions

Update the analyzer and rollup agents to work with the hybrid architecture.

**Files:**
- Modify: `.claude/agents/visual-sweep-analyzer.md`
- Modify: `.claude/agents/visual-sweep-rollup.md`

- [ ] **Step 1: Update visual-sweep-analyzer.md**

Add a new section after "## Inputs" called "## Pre-Analysis Context":

```markdown
## Pre-Analysis Context

In hybrid mode, you receive additional context from automated pre-analysis:

- **Global findings** — mechanical issues found across 3+ sections. These are reported separately in the rollup. Do NOT re-report them.
- **This section's automated findings** — mechanical issues specific to this section (missing names, bounds overflow, empty containers, small elements, duplicate IDs). These are already documented. Do NOT re-report them.

Your job in hybrid mode is to find issues that automated analysis CANNOT detect:
- Visual interpretation (screenshot anomalies, wrong colors, stale content, loading indicators)
- Contextual judgment (severity classification, novel patterns, unexpected duplicates)
- Source file tracing (XAML/C# root cause identification for both automated and visual findings)

If you receive pre-analysis context, trace the automated findings to source files as well — the pre-analysis identifies WHAT is wrong but not WHERE in the code to fix it.
```

- [ ] **Step 2: Update visual-sweep-rollup.md**

Add a new section after "## Inputs" called "## Finding Sources":

```markdown
## Finding Sources

In hybrid mode, you receive findings from three sources:

1. **Global findings** (from pre-analysis dedup) — mechanical issues appearing across 3+ sections. Report once with the list of affected sections.
2. **Section-specific automated findings** — mechanical issues for sections that skipped LLM analysis. Include as-is with `source: automated`.
3. **LLM analysis findings** — visual and contextual issues from Claude agents. Include with `source: visual-analysis`.

Merge all three sources into a single summary. In the per-section table, show finding counts from both automated and LLM sources. In the detailed findings section, group by severity regardless of source.
```

- [ ] **Step 3: Sync agents to global directory**

```bash
cp .claude/agents/visual-sweep-analyzer.md ~/.claude/agents/visual-sweep-analyzer.md
cp .claude/agents/visual-sweep-rollup.md ~/.claude/agents/visual-sweep-rollup.md
```

- [ ] **Step 4: Commit**

```bash
git add .claude/agents/visual-sweep-analyzer.md .claude/agents/visual-sweep-rollup.md
git commit -m "feat: update analyzer and rollup agents for hybrid mode pre-analysis context"
```

---

## Execution Order

Tasks 1-2 are independent (step builder and pre-analyze engine). Task 3 depends on Task 2 (wires the handler). Task 4 is independent. Task 5 depends on all prior tasks (references everything). Task 6 depends on nothing but should follow Task 5.

```
Task 1 (step builder + validator) ─────────────────────┐
Task 2 (pre-analyze engine) → Task 3 (MCP wiring) ─────┤
Task 4 (dedup logic) ──────────────────────────────────┤
                                                        ↓
                                                   Task 5 (sweep command rewrite)
                                                        ↓
                                                   Task 6 (agent definition updates)
```
