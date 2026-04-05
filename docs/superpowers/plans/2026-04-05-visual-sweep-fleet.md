# Visual Sweep Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a three-phase visual audit system (discovery, capture, analysis) for deep per-app visual sweeps with peek manifest enforcement.

**Architecture:** A `/torque-visual-sweep` command orchestrates three agents — a discovery agent reads the peek manifest and walks the live UI to produce a sweep plan, a capture coordinator serializes `peek_diagnose` calls against the peek_server, and an analysis fleet of parallel Claude agents each inspect one section's capture bundle. Manifests enforce visual surface registration via pre-commit hooks and TORQUE post-task hooks.

**Tech Stack:** Claude agents (discovery, capture, analysis), TORQUE artifacts (capture storage), snapscope/peek_ui tools (capture), bash pre-commit hook (manifest enforcement), TORQUE post-tool-hooks (task_complete manifest check), TORQUE one-time scheduling.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `.claude/commands/torque-visual-sweep.md` | Create | Slash command — parses args, orchestrates 3 phases |
| `.claude/agents/visual-sweep-discovery.md` | Create | Discovery agent — reads manifest, enumerates sections, produces sweep plan |
| `.claude/agents/visual-sweep-capture.md` | Create | Capture coordinator — navigates + captures sequentially |
| `.claude/agents/visual-sweep-analyzer.md` | Create | Analysis scout template — inspects one section's capture bundle |
| `.claude/agents/visual-sweep-rollup.md` | Create | Rollup agent — merges per-section findings into summary |
| `scripts/peek-manifest-check.sh` | Create | Pre-commit hook — detects new visual surfaces not in manifest |
| `server/hooks/manifest-enforcement.js` | Create | Post-task hook — checks TORQUE task output for new visual surfaces |
| `server/hooks/manifest-patterns.js` | Create | Shared visual surface detection patterns (used by both hooks) |

---

### Task 1: Visual Surface Detection Patterns

Shared module that both the pre-commit hook and TORQUE post-task hook use to detect new visual surfaces by framework.

**Files:**
- Create: `server/hooks/manifest-patterns.js`
- Test: `server/tests/manifest-patterns.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/tests/manifest-patterns.test.js
'use strict';

const { describe, it, expect } = require('vitest');
const { detectVisualSurfaces, loadManifest, findUnregistered } = require('../hooks/manifest-patterns');

describe('manifest-patterns', () => {
  describe('detectVisualSurfaces', () => {
    it('detects WPF Window XAML files', () => {
      const files = ['src/Views/BudgetPage.xaml'];
      const contents = { 'src/Views/BudgetPage.xaml': '<Window x:Class="App.Views.BudgetPage">' };
      const result = detectVisualSurfaces(files, contents, 'wpf');
      expect(result).toEqual([
        { file: 'src/Views/BudgetPage.xaml', type: 'Window', id: 'BudgetPage' }
      ]);
    });

    it('detects WPF Page XAML files', () => {
      const files = ['src/Views/SettingsPage.xaml'];
      const contents = { 'src/Views/SettingsPage.xaml': '<Page x:Class="App.Views.SettingsPage">' };
      const result = detectVisualSurfaces(files, contents, 'wpf');
      expect(result).toEqual([
        { file: 'src/Views/SettingsPage.xaml', type: 'Page', id: 'SettingsPage' }
      ]);
    });

    it('detects WPF UserControl XAML files', () => {
      const files = ['src/Controls/FilterPanel.xaml'];
      const contents = { 'src/Controls/FilterPanel.xaml': '<UserControl x:Class="App.Controls.FilterPanel">' };
      const result = detectVisualSurfaces(files, contents, 'wpf');
      expect(result).toEqual([
        { file: 'src/Controls/FilterPanel.xaml', type: 'UserControl', id: 'FilterPanel' }
      ]);
    });

    it('detects React page files', () => {
      const files = ['pages/budget.tsx', 'app/settings/page.tsx'];
      const result = detectVisualSurfaces(files, {}, 'react');
      expect(result).toEqual([
        { file: 'pages/budget.tsx', type: 'page', id: 'budget' },
        { file: 'app/settings/page.tsx', type: 'page', id: 'settings' }
      ]);
    });

    it('detects Electron BrowserWindow creation', () => {
      const files = ['src/windows/preferences.js'];
      const contents = { 'src/windows/preferences.js': 'const win = new BrowserWindow({ width: 800 })' };
      const result = detectVisualSurfaces(files, contents, 'electron');
      expect(result).toEqual([
        { file: 'src/windows/preferences.js', type: 'BrowserWindow', id: 'preferences' }
      ]);
    });

    it('returns empty array for non-visual files', () => {
      const files = ['src/utils/math.js'];
      const contents = { 'src/utils/math.js': 'module.exports = { add: (a, b) => a + b }' };
      const result = detectVisualSurfaces(files, contents, 'react');
      expect(result).toEqual([]);
    });
  });

  describe('loadManifest', () => {
    it('returns null for missing manifest', () => {
      const result = loadManifest('/nonexistent/path');
      expect(result).toBeNull();
    });
  });

  describe('findUnregistered', () => {
    it('identifies surfaces not in manifest sections', () => {
      const surfaces = [
        { file: 'src/Views/BudgetPage.xaml', type: 'Window', id: 'BudgetPage' },
        { file: 'src/Views/Dashboard.xaml', type: 'Window', id: 'Dashboard' }
      ];
      const manifest = {
        sections: [
          { id: 'dashboard', label: 'Dashboard' }
        ]
      };
      const result = findUnregistered(surfaces, manifest);
      expect(result).toEqual([
        { file: 'src/Views/BudgetPage.xaml', type: 'Window', id: 'BudgetPage' }
      ]);
    });

    it('returns all surfaces when manifest is null', () => {
      const surfaces = [{ file: 'src/Views/X.xaml', type: 'Window', id: 'X' }];
      const result = findUnregistered(surfaces, null);
      expect(result).toEqual(surfaces);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/manifest-patterns.test.js`
Expected: FAIL — module `../hooks/manifest-patterns` not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/hooks/manifest-patterns.js
'use strict';

const fs = require('fs');
const path = require('path');

const WPF_SURFACE_REGEX = /<(Window|Page|UserControl)\s+x:Class="[^"]*\.(\w+)"/;
const REACT_PAGE_PATTERNS = [/^pages\/(.+?)\.\w+$/, /^app\/(.+?)\/page\.\w+$/];
const ELECTRON_WINDOW_REGEX = /new\s+BrowserWindow\s*\(/;

function detectVisualSurfaces(files, contents, framework) {
  const surfaces = [];

  for (const file of files) {
    const content = contents[file] || '';
    const basename = path.basename(file, path.extname(file));

    if (framework === 'wpf') {
      const match = content.match(WPF_SURFACE_REGEX);
      if (match) {
        surfaces.push({ file, type: match[1], id: match[2] });
      }
    } else if (framework === 'react') {
      for (const pattern of REACT_PAGE_PATTERNS) {
        const match = file.match(pattern);
        if (match) {
          const id = match[1].replace(/\/page$/, '').replace(/\//g, '-');
          surfaces.push({ file, type: 'page', id });
          break;
        }
      }
    } else if (framework === 'electron') {
      if (ELECTRON_WINDOW_REGEX.test(content)) {
        surfaces.push({ file, type: 'BrowserWindow', id: basename });
      }
    }
  }

  return surfaces;
}

function loadManifest(projectDir) {
  const manifestPath = path.join(projectDir, 'peek-manifest.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function findUnregistered(surfaces, manifest) {
  if (!manifest || !manifest.sections) return [...surfaces];

  const registeredIds = new Set();
  for (const section of manifest.sections) {
    registeredIds.add(section.id.toLowerCase());
    if (section.subsections) {
      for (const sub of section.subsections) {
        registeredIds.add(sub.id.toLowerCase());
      }
    }
  }

  return surfaces.filter(s => !registeredIds.has(s.id.toLowerCase()));
}

function suggestManifestEntry(surface) {
  return {
    id: surface.id.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label: surface.id.replace(/([A-Z])/g, ' $1').trim(),
    navigation: { type: 'nav_element', target: `${surface.id}NavItem` },
    depth: 'page'
  };
}

module.exports = { detectVisualSurfaces, loadManifest, findUnregistered, suggestManifestEntry };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/manifest-patterns.test.js`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/hooks/manifest-patterns.js server/tests/manifest-patterns.test.js
git commit -m "feat: add visual surface detection patterns for peek manifest enforcement"
```

---

### Task 2: Pre-Commit Hook for Manifest Enforcement

Bash script that scans staged files for new visual surfaces and blocks the commit if they're not in `peek-manifest.json`.

**Files:**
- Create: `scripts/peek-manifest-check.sh`
- Modify: `.git/hooks/pre-commit` (add hook call — local only, not tracked)

- [ ] **Step 1: Write the hook script**

```bash
#!/usr/bin/env bash
# scripts/peek-manifest-check.sh
# Pre-commit hook: blocks commits that add visual surfaces not registered in peek-manifest.json.
# Requires: node (for manifest-patterns.js)
# Exit 0 = pass, Exit 1 = block commit with message.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$PROJECT_ROOT/peek-manifest.json"

# Skip if no manifest exists (project doesn't use visual sweep)
if [ ! -f "$MANIFEST" ]; then
  exit 0
fi

# Get framework from manifest
FRAMEWORK=$(node -e "
  const m = require('$MANIFEST');
  process.stdout.write(m.framework || '');
")

if [ -z "$FRAMEWORK" ]; then
  exit 0
fi

# Get staged files (added or modified)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=AM)
if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

# Run detection via Node using the shared patterns module
RESULT=$(node -e "
  const { detectVisualSurfaces, loadManifest, findUnregistered } = require('$PROJECT_ROOT/server/hooks/manifest-patterns');
  const fs = require('fs');
  const files = process.argv.slice(1);
  const contents = {};
  for (const f of files) {
    try { contents[f] = fs.readFileSync(f, 'utf-8'); } catch {}
  }
  const surfaces = detectVisualSurfaces(files, contents, '$FRAMEWORK');
  const manifest = loadManifest('$PROJECT_ROOT');
  const unregistered = findUnregistered(surfaces, manifest);
  if (unregistered.length > 0) {
    for (const s of unregistered) {
      console.error('  ' + s.file + ' (' + s.type + ': ' + s.id + ')');
    }
    process.exit(1);
  }
" $STAGED_FILES 2>&1) || {
  echo ""
  echo "PEEK MANIFEST: New visual surface(s) detected but not registered in peek-manifest.json:"
  echo "$RESULT"
  echo ""
  echo "Add them to peek-manifest.json or mark skip_visual: true in the section entry."
  echo "To bypass: git commit --no-verify"
  exit 1
}

exit 0
```

- [ ] **Step 2: Test manually by running the script in a project without a manifest**

Run: `bash scripts/peek-manifest-check.sh && echo "PASS: exited 0"`
Expected: Exits 0 silently (no peek-manifest.json in this project yet).

- [ ] **Step 3: Wire into pre-commit hook**

Add this line to `.git/hooks/pre-commit` between the worktree guard and PII guard. The full file becomes:

```bash
#!/usr/bin/env bash

# === Worktree guard — must run FIRST (blocks direct main commits when worktrees exist) ===
bash "<project-root>/scripts/worktree-guard.sh" || exit 1

# === Peek manifest guard — blocks unregistered visual surfaces ===
bash "<project-root>/scripts/peek-manifest-check.sh" || exit 1

# === PII Guard — scans staged files for personal data ===
exec bash "<project-root>/scripts/pii-pre-commit.sh"
```

(Replace `<project-root>` with the actual absolute project path.)

- [ ] **Step 4: Commit**

```bash
git add scripts/peek-manifest-check.sh
git commit -m "feat: add pre-commit hook for peek manifest enforcement"
```

Note: `.git/hooks/pre-commit` is not tracked by git — it's a local hook modification.

---

### Task 3: TORQUE Post-Task Hook for Manifest Enforcement

Registers a `task_complete` hook that checks if the completed task touched visual files and flags unregistered surfaces.

**Files:**
- Create: `server/hooks/manifest-enforcement.js`
- Test: `server/tests/manifest-enforcement.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/tests/manifest-enforcement.test.js
'use strict';

const { describe, it, expect, vi, beforeEach } = require('vitest');

describe('manifest-enforcement hook', () => {
  let manifestEnforcement;
  let mockPatterns;

  beforeEach(() => {
    vi.resetModules();

    mockPatterns = {
      detectVisualSurfaces: vi.fn().mockReturnValue([]),
      loadManifest: vi.fn().mockReturnValue(null),
      findUnregistered: vi.fn().mockReturnValue([]),
      suggestManifestEntry: vi.fn().mockReturnValue({ id: 'test', label: 'Test' })
    };

    vi.doMock('../hooks/manifest-patterns', () => mockPatterns);
    manifestEnforcement = require('../hooks/manifest-enforcement');
  });

  it('exports a createHook factory', () => {
    expect(typeof manifestEnforcement.createHook).toBe('function');
  });

  it('hook returns null when task has no changed_files', async () => {
    const hook = manifestEnforcement.createHook();
    const result = await hook({ taskId: '1', task: { working_directory: '/proj' } });
    expect(result).toBeNull();
  });

  it('hook returns null when no manifest exists', async () => {
    mockPatterns.loadManifest.mockReturnValue(null);
    const hook = manifestEnforcement.createHook();
    const result = await hook({
      taskId: '1',
      task: { working_directory: '/proj' },
      changed_files: ['src/Views/New.xaml']
    });
    expect(result).toBeNull();
  });

  it('hook detects unregistered surfaces and returns approval gate info', async () => {
    const manifest = { framework: 'wpf', sections: [] };
    mockPatterns.loadManifest.mockReturnValue(manifest);
    mockPatterns.detectVisualSurfaces.mockReturnValue([
      { file: 'src/Views/New.xaml', type: 'Window', id: 'New' }
    ]);
    mockPatterns.findUnregistered.mockReturnValue([
      { file: 'src/Views/New.xaml', type: 'Window', id: 'New' }
    ]);

    const hook = manifestEnforcement.createHook();
    const result = await hook({
      taskId: 'task-1',
      task: { working_directory: '/proj' },
      changed_files: ['src/Views/New.xaml']
    });

    expect(result).toEqual({
      gate: 'manifest_update',
      task_id: 'task-1',
      unregistered: [{ file: 'src/Views/New.xaml', type: 'Window', id: 'New' }],
      suggested_entries: [{ id: 'test', label: 'Test' }],
      message: expect.stringContaining('New visual surface')
    });
  });

  it('hook returns null when all surfaces are registered', async () => {
    const manifest = { framework: 'wpf', sections: [{ id: 'new' }] };
    mockPatterns.loadManifest.mockReturnValue(manifest);
    mockPatterns.detectVisualSurfaces.mockReturnValue([
      { file: 'src/Views/New.xaml', type: 'Window', id: 'New' }
    ]);
    mockPatterns.findUnregistered.mockReturnValue([]);

    const hook = manifestEnforcement.createHook();
    const result = await hook({
      taskId: 'task-1',
      task: { working_directory: '/proj' },
      changed_files: ['src/Views/New.xaml']
    });

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/manifest-enforcement.test.js`
Expected: FAIL — module `../hooks/manifest-enforcement` not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/hooks/manifest-enforcement.js
'use strict';

const fs = require('fs');
const { detectVisualSurfaces, loadManifest, findUnregistered, suggestManifestEntry } = require('./manifest-patterns');
const logger = require('../logger').child({ component: 'manifest-enforcement' });

function createHook() {
  return async function checkManifest(context) {
    const { taskId, task, changed_files } = context;
    if (!changed_files || changed_files.length === 0) return null;

    const workDir = task && task.working_directory;
    if (!workDir) return null;

    const manifest = loadManifest(workDir);
    if (!manifest || !manifest.framework) return null;

    const contents = {};
    for (const file of changed_files) {
      try {
        const fullPath = require('path').resolve(workDir, file);
        contents[file] = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        // file may have been deleted
      }
    }

    const surfaces = detectVisualSurfaces(changed_files, contents, manifest.framework);
    if (surfaces.length === 0) return null;

    const unregistered = findUnregistered(surfaces, manifest);
    if (unregistered.length === 0) return null;

    const suggested = unregistered.map(s => suggestManifestEntry(s));
    const fileList = unregistered.map(s => `${s.file} (${s.type}: ${s.id})`).join(', ');

    logger.info(`[ManifestEnforcement] Task ${taskId}: ${unregistered.length} unregistered visual surface(s): ${fileList}`);

    return {
      gate: 'manifest_update',
      task_id: taskId,
      unregistered,
      suggested_entries: suggested,
      message: `New visual surface(s) detected but not in peek-manifest.json: ${fileList}. Add to manifest?`
    };
  };
}

module.exports = { createHook };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/manifest-enforcement.test.js`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/hooks/manifest-enforcement.js server/tests/manifest-enforcement.test.js
git commit -m "feat: add TORQUE post-task hook for peek manifest enforcement"
```

---

### Task 4: Discovery Agent

The discovery agent reads the peek manifest, ensures the app is running, validates sections against the live UI, detects unmanifested surfaces, and produces a sweep plan artifact.

**Files:**
- Create: `.claude/agents/visual-sweep-discovery.md`

- [ ] **Step 1: Write the agent definition**

```markdown
---
name: visual-sweep-discovery
description: Discovery phase of visual sweep — reads manifest, validates sections, produces sweep plan
tools: Read, Glob, Grep, Bash, Write, SendMessage, mcp__plugin_torque_torque__store_artifact, mcp__plugin_torque_torque__scan_project
model: opus
---

# Visual Sweep — Discovery Agent

You are the discovery phase of a visual sweep. Your job is to enumerate all visual sections of a single application and produce a sweep plan for the capture coordinator.

## Inputs

You receive a message with:
- `app` — project name or process name
- `working_directory` — project root directory
- `depth` — "page" (default) or "component"
- `section` — optional, sweep only this section ID

## Workflow

### 1. Load the peek manifest

Read `peek-manifest.json` from `working_directory`. If it doesn't exist, report failure to the orchestrator via SendMessage:

SendMessage({ to: "orchestrator", message: { type: "discovery_failed", reason: "No peek-manifest.json found" } })

Extract: `app`, `process`, `framework`, `sections`.

### 2. Ensure the app is running

Call `peek_ui({ list_windows: true })` to check if a window matching the manifest's `process` is visible.

- If running: proceed.
- If not running: call `peek_launch({ project: "<app>" })`. Wait 10 seconds, then re-check with `peek_ui({ list_windows: true })`. If still not running, report failure.

### 3. Validate manifest sections

For each section in the manifest:
1. Call `peek_elements({ process: "<process>", find: "<navigation.target>" })` to verify the navigation target exists.
2. If found: mark section as `"status": "pending"`.
3. If not found: mark as `"status": "unreachable"` with a warning.

### 4. Detect unmanifested surfaces

Call `peek_elements({ process: "<process>", types: "MenuItem,TabItem,ListItem,Button,Hyperlink", depth: 2 })` to walk the top-level navigation elements.

Compare found elements against manifest section navigation targets. For any unmatched nav-like element:
- Add it as a target with `"warning": "Not in peek-manifest.json"` and `"navigation": { "type": "discovered", "element": "<element_name>" }`.

### 5. Apply depth and section filters

- If `depth` is "component" and no `section` filter: expand all sections' `subsections` into individual targets.
- If `depth` is "component" and `section` is set: expand only that section's `subsections`.
- If `section` filter is set with depth "page": include only the matching section.

### 6. Build and store sweep plan

Write the sweep plan as JSON:

```json
{
  "app": "<app>",
  "process": "<process>",
  "host": "<peek host used>",
  "depth": "<page|component>",
  "framework": "<framework>",
  "working_directory": "<working_directory>",
  "created_at": "<ISO 8601>",
  "targets": [ ... ]
}
```

Save to `<working_directory>/docs/visual-sweep-plan.json`.

### 7. Notify orchestrator

SendMessage({
  to: "orchestrator",
  message: {
    type: "discovery_complete",
    plan_path: "<path to sweep plan>",
    target_count: <number>,
    unreachable_count: <number>,
    unmanifested_count: <number>
  }
})

## Rules

- Do NOT capture screenshots. That is the capture coordinator's job.
- Do NOT analyze visual quality. That is the analysis fleet's job.
- Minimize peek_server calls — use `peek_elements` for validation, not `peek_diagnose`.
- If the app crashes during discovery, attempt one restart via `peek_launch`.
```

- [ ] **Step 2: Verify the file is well-formed**

Run: `head -5 .claude/agents/visual-sweep-discovery.md`
Expected: frontmatter starts with `---`.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/visual-sweep-discovery.md
git commit -m "feat: add visual sweep discovery agent definition"
```

---

### Task 5: Capture Coordinator Agent

Walks the sweep plan sequentially, navigating to each section and calling `peek_diagnose`. Stores capture bundles as files.

**Files:**
- Create: `.claude/agents/visual-sweep-capture.md`

- [ ] **Step 1: Write the agent definition**

```markdown
---
name: visual-sweep-capture
description: Capture coordinator — navigates to each section sequentially and captures via peek_diagnose
tools: Read, Write, Bash, SendMessage, mcp__plugin_torque_torque__store_artifact
model: opus
---

# Visual Sweep — Capture Coordinator

You are the capture coordinator of a visual sweep. Your job is to walk the sweep plan sequentially, navigate to each section, wait for the UI to settle, and capture a full diagnostic bundle. You do NOT analyze anything.

## Inputs

You receive a message with:
- `plan_path` — path to the sweep plan JSON
- `process` — the app's process name

## Workflow

### 1. Load the sweep plan

Read the sweep plan JSON from `plan_path`. Parse the targets array.

### 2. For each target with status "pending" (in order):

#### a. Navigate to the section

Based on the target's `navigation.type`:

- **`nav_element`**: Call `peek_interact({ process: "<process>", action: "click", element: "<navigation.target>" })`.
- **`url`**: Call `peek_interact({ process: "<process>", action: "hotkey", keys: "ctrl+l" })`, then `peek_interact({ process: "<process>", action: "type", text: "<navigation.target>\n" })`.
- **`keyboard`**: Call `peek_interact({ process: "<process>", action: "hotkey", keys: "<navigation.target>" })`.
- **`menu`**: For each menu item in the path, call `peek_interact({ process: "<process>", action: "click", element: "<item>" })` sequentially.
- **`discovered`**: Call `peek_interact({ process: "<process>", action: "click", element: "<navigation.element>" })`.

#### b. Wait for UI to settle

Call `peek_wait({ process: "<process>", conditions: [{ "type": "element_exists", "name": "*" }], wait_timeout: 5 })`.

If the target has a known element (from subsection `element` field), wait for that specifically:
`peek_wait({ process: "<process>", conditions: [{ "type": "element_exists", "name": "<element>" }], wait_timeout: 10 })`.

#### c. Capture

Call `peek_diagnose({ process: "<process>", screenshot: true, annotated: true, elements: true, layout: true, text_content: true })`.

#### d. Store capture bundle

Save the full `peek_diagnose` response as JSON to:
`<working_directory>/docs/visual-sweep-captures/<target.id>.json`

Create the directory if it doesn't exist.

#### e. Update status

Update the target's status in the sweep plan: `"pending"` -> `"captured"`.
Write the updated sweep plan back to `plan_path`.

#### f. Handle failures

If navigation or capture fails:
1. Log the error.
2. If the error suggests the app crashed (window not found), attempt `peek_launch({ project: "<app>" })`, wait 10 seconds, retry once.
3. If retry fails, mark target as `"status": "failed"` with `"error": "<message>"`, continue to next target.

### 3. Store final sweep plan

Write the final sweep plan (all statuses updated) to `plan_path`.

### 4. Notify orchestrator

SendMessage({
  to: "orchestrator",
  message: {
    type: "capture_complete",
    plan_path: "<plan_path>",
    captured_count: <number of "captured" targets>,
    failed_count: <number of "failed" targets>,
    capture_dir: "<working_directory>/docs/visual-sweep-captures/"
  }
})

## Rules

- **Sequential only.** One capture at a time. Never call `peek_diagnose` in parallel.
- **Do NOT analyze.** Your job is capture, not judgment.
- **Persist after every capture.** Write the updated sweep plan and capture file before moving to the next target. This enables crash recovery.
- **Minimize UI interaction.** Navigate, wait, capture. Don't explore.
```

- [ ] **Step 2: Verify the file is well-formed**

Run: `head -5 .claude/agents/visual-sweep-capture.md`
Expected: frontmatter starts with `---`.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/visual-sweep-capture.md
git commit -m "feat: add visual sweep capture coordinator agent definition"
```

---

### Task 6: Analysis Scout Agent

Template for the analysis fleet. Each scout receives one capture bundle and writes findings for one section.

**Files:**
- Create: `.claude/agents/visual-sweep-analyzer.md`

- [ ] **Step 1: Write the agent definition**

```markdown
---
name: visual-sweep-analyzer
description: Analysis scout — inspects one section's capture bundle and writes findings
tools: Read, Glob, Grep, Write, SendMessage
model: opus
---

# Visual Sweep — Analysis Scout

You are an analysis scout in a visual sweep fleet. You receive the capture bundle for ONE section of an application. Your job is to thoroughly analyze it for visual issues and write findings.

## Inputs

You receive a message with:
- `app` — application name
- `section_id` — the section you are analyzing
- `section_label` — human-readable section name
- `capture_path` — path to the capture bundle JSON (peek_diagnose output)
- `working_directory` — project root (for source file access)
- `framework` — wpf, react, or electron
- `manifest_section` — the section entry from peek-manifest.json (may be null for unmanifested surfaces)

## Workflow

### 1. Read the capture bundle

Read the JSON file at `capture_path`. It contains:
- `screenshot` — base64 encoded screenshot image
- `annotated_screenshot` — screenshot with element overlays
- `elements` — UI Automation element tree (names, types, bounds, automation IDs)
- `layout` — spacing and alignment measurements between elements
- `text_content` — OCR/element text summary

### 2. Visual analysis

Examine the screenshot and annotated screenshot. Check for:

**Layout issues:**
- Elements overflowing their containers (bounds extend beyond parent bounds)
- Clipped text (text content present in elements tree but not visible in screenshot)
- Misaligned elements (elements that should share an edge but have offset bounds)
- Overlapping elements (bounds intersect but are not parent-child)

**Content issues:**
- Missing elements (manifest or element tree suggests elements should be present but aren't rendered)
- Empty data areas (list/grid elements with no children)
- Placeholder text still visible ("Lorem ipsum", "TODO", "Sample")
- Text truncation (element bounds too small for text content)

**Styling issues:**
- Inconsistent spacing (different gaps between similar element groups)
- Font size inconsistencies (same element type with different text sizes)
- Color inconsistencies (if color data available)

**Accessibility basics:**
- Elements without names in the automation tree (missing labels)
- Very small interactive elements (bounds width or height < 24px)
- Text too small to read (estimate from bounds vs content length)

### 3. Trace to source

For each issue found, use Grep and Read to find the likely source file:
- WPF: search for the element's `automation_id` or `x:Name` in `.xaml` files
- React: search for component names in `.tsx`/`.jsx` files
- Electron: search in `.html`/`.css`/`.js` files

Include the source file path and line number in the finding.

### 4. Write findings

Write to: `docs/findings/<date>-visual-sweep-<app>-<section_id>.md`

Use this format:

```
# Visual Sweep: <app> — <section_label>

**Date:** <YYYY-MM-DD>
**Scope:** <section_label> (<section_id>)
**Variant:** visual-sweep

## Summary

N findings: X critical, Y high, Z medium, W low.

## Findings

### [SEVERITY] Finding title
- **Window:** <process>
- **Section:** <section_label>
- **Expected:** What it should look like
- **Actual:** What was observed
- **Evidence:** Specific measurements or element data from capture bundle
- **Source file:** path/to/component.tsx:line (if identified)
- **Status:** NEW
- **Suggested fix:** Brief description
```

### 5. Notify orchestrator

SendMessage({
  to: "orchestrator",
  message: {
    type: "analysis_complete",
    section_id: "<section_id>",
    findings_path: "<path to findings file>",
    finding_count: <N>,
    severity_counts: { critical: X, high: Y, medium: Z, low: W }
  }
})

## Severity Guide

- **CRITICAL:** App crash, blank section, data not displayed, broken navigation
- **HIGH:** Major layout break, unusable UI element, wrong data shown, accessibility blocker
- **MEDIUM:** Misalignment, inconsistent styling, minor layout issue, missing labels
- **LOW:** Cosmetic imperfection, spacing nitpick, minor convention drift

## Rules

- **One section only.** Do not analyze other sections' captures.
- **Do NOT fix anything.** Discovery only.
- **Be specific.** Include element names, bounds, measurements. Vague findings are useless.
- **Trace to source.** Every finding should reference the source file if possible.
- **Zero findings is valid.** If the section looks correct, write "0 findings" with "None." under Findings.
```

- [ ] **Step 2: Verify the file is well-formed**

Run: `head -5 .claude/agents/visual-sweep-analyzer.md`
Expected: frontmatter starts with `---`.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/visual-sweep-analyzer.md
git commit -m "feat: add visual sweep analysis scout agent definition"
```

---

### Task 7: Rollup Agent

Merges per-section findings into a single summary file.

**Files:**
- Create: `.claude/agents/visual-sweep-rollup.md`

- [ ] **Step 1: Write the agent definition**

```markdown
---
name: visual-sweep-rollup
description: Rollup agent — merges per-section findings into a sweep summary
tools: Read, Glob, Write, SendMessage
model: sonnet
---

# Visual Sweep — Rollup Agent

You merge per-section findings files into a single sweep summary.

## Inputs

You receive a message with:
- `app` — application name
- `findings_dir` — directory containing per-section findings files (e.g., `docs/findings/`)
- `date` — sweep date (YYYY-MM-DD)
- `plan_path` — path to the sweep plan JSON
- `section_results` — array of `{ section_id, findings_path, finding_count, severity_counts }`

## Workflow

### 1. Read the sweep plan

Read `plan_path` to get the full target list, including unreachable and failed targets.

### 2. Read each findings file

For each entry in `section_results`, read the findings file. Parse the severity counts and individual findings.

### 3. Write summary

Write to: `docs/findings/<date>-visual-sweep-<app>-summary.md`

Format:

```
# Visual Sweep Summary: <app>

**Date:** <date>
**Sections scanned:** <N captured> / <N total targets>
**Total findings:** <sum of all findings>

## Severity Breakdown

| Severity | Count |
|----------|-------|
| Critical | X |
| High | Y |
| Medium | Z |
| Low | W |

## Per-Section Results

| Section | Findings | Critical | High | Medium | Low |
|---------|----------|----------|------|--------|-----|
| <label> | N | X | Y | Z | W |

## Unreachable Sections

<list sections with status "unreachable" and their warnings>

## Unmanifested Surfaces

<list targets with "Not in peek-manifest.json" warning>

## Failed Captures

<list targets with status "failed" and their errors>

## Cross-Section Issues

<any patterns noticed across multiple sections>

## Detailed Findings

<for each section, link to its findings file and list CRITICAL and HIGH findings inline>
```

### 4. Commit findings

```bash
git add docs/findings/<date>-visual-sweep-<app>-*.md
git commit -m "docs: visual sweep findings for <app> (<date>)"
```

### 5. Notify orchestrator

SendMessage({
  to: "orchestrator",
  message: {
    type: "rollup_complete",
    summary_path: "<path to summary>",
    total_findings: <N>,
    severity_counts: { critical: X, high: Y, medium: Z, low: W }
  }
})
```

- [ ] **Step 2: Verify the file is well-formed**

Run: `head -5 .claude/agents/visual-sweep-rollup.md`
Expected: frontmatter starts with `---`.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/visual-sweep-rollup.md
git commit -m "feat: add visual sweep rollup agent definition"
```

---

### Task 8: `/torque-visual-sweep` Command

The orchestrating slash command that ties all three phases together.

**Files:**
- Create: `.claude/commands/torque-visual-sweep.md`

- [ ] **Step 1: Write the command definition**

```markdown
---
name: torque-visual-sweep
description: Deep visual audit for a single application — discovery, capture, analysis fleet
argument-hint: "<app> [--depth page|component] [--section <id>] [--schedule <time>]"
allowed-tools:
  - Agent
  - Read
  - Write
  - Glob
  - Bash
  - AskUserQuestion
  - SendMessage
  - mcp__plugin_torque_torque__store_artifact
  - mcp__plugin_torque_torque__get_artifact
  - mcp__plugin_torque_torque__list_artifacts
  - mcp__plugin_torque_torque__create_one_time_schedule
---

# TORQUE Visual Sweep

Deep visual audit for a single application. Discovers all sections, captures each sequentially via peek_diagnose, then spins up a parallel analysis fleet — one scout per section.

## Arguments

Parse `$ARGUMENTS` into:
- `app` — first positional argument (required). Project name or process name.
- `--depth` — "page" (default) or "component".
- `--section` — optional section ID to sweep only one section.
- `--schedule` — optional time string. If present, submit as one-time schedule instead of running immediately.

If no `app` argument, ask via AskUserQuestion: "Which app should I sweep? (e.g., example-project, torque-dashboard)"

## Locate Project

1. Check if `app` matches a directory name in common project locations:
   - `~/Projects/<app>/`
   - Current working directory (if it contains `peek-manifest.json`)
2. Read `peek-manifest.json` from the project directory.
3. If no manifest found, report: "No peek-manifest.json found for <app>. Create one first, or run the discovery agent to generate a draft."

## Scheduled Mode

If `--schedule` is present:
1. Parse the time (ISO 8601 or natural language like "11pm", "2h").
2. Submit via `create_one_time_schedule`:

   create_one_time_schedule({
     name: "visual-sweep-<app>",
     run_at: "<parsed ISO time>" OR delay: "<relative time>",
     task: "Run /torque-visual-sweep <app> --depth <depth>",
     working_directory: "<project dir>",
     provider: "claude-cli",
     timeout_minutes: 120
   })

3. Report: "Visual sweep for <app> scheduled at <time>. Findings will be in docs/findings/ when it completes."
4. Stop. Do not run the sweep now.

## Immediate Mode

### Phase 1: Discovery

Read `.claude/agents/visual-sweep-discovery.md` and extract the markdown body (after frontmatter).

Spawn the discovery agent:

Agent({
  name: "sweep-discovery",
  prompt: "You are running a visual sweep discovery phase.\n\nApp: <app>\nWorking directory: <project dir>\nDepth: <depth>\nSection filter: <section or none>\n\n<discovery agent body>",
  model: "opus",
  mode: "auto"
})

Wait for completion. The discovery agent sends a message with `type: "discovery_complete"` containing `plan_path` and target count. If it sends `type: "discovery_failed"`, report the error and stop.

Report to user:

Phase 1 — Discovery complete:
  - <N> sections found (<M> from manifest, <K> discovered)
  - <U> unreachable sections
  - Sweep plan: <plan_path>

### Phase 2: Capture

Read `.claude/agents/visual-sweep-capture.md` and extract the body.

Spawn the capture coordinator:

Agent({
  name: "sweep-capture",
  prompt: "You are running a visual sweep capture phase.\n\nPlan path: <plan_path>\nProcess: <process from manifest>\n\n<capture agent body>",
  model: "opus",
  mode: "auto"
})

Wait for completion. The coordinator sends `type: "capture_complete"` with captured/failed counts.

Report to user:

Phase 2 — Capture complete:
  - <N> sections captured
  - <F> sections failed
  - Captures in: <capture_dir>

### Phase 3: Analysis Fleet

Read the sweep plan JSON to get all captured targets. Read `.claude/agents/visual-sweep-analyzer.md` and extract the body.

For each target with status "captured", spawn an analysis scout:

Agent({
  name: "sweep-analyzer-<section_id>",
  prompt: "You are an analysis scout in a visual sweep fleet.\n\nApp: <app>\nSection ID: <target.id>\nSection Label: <target.label>\nCapture path: <capture_dir>/<target.id>.json\nWorking directory: <project dir>\nFramework: <framework>\nManifest section: <JSON or null>\n\n<analyzer agent body>",
  model: "opus",
  mode: "auto",
  run_in_background: true
})

**All analysis scouts run in parallel** (run_in_background: true). Collect results as they complete. Each sends `type: "analysis_complete"` with finding counts.

### Phase 4: Rollup

Once all scouts complete, read `.claude/agents/visual-sweep-rollup.md` and extract the body.

Spawn the rollup agent:

Agent({
  name: "sweep-rollup",
  prompt: "You are the rollup agent for a visual sweep.\n\nApp: <app>\nFindings directory: docs/findings/\nDate: <today>\nPlan path: <plan_path>\nSection results: <JSON array of analysis results>\n\n<rollup agent body>",
  model: "sonnet",
  mode: "auto"
})

Wait for completion.

### Phase 5: Report

Present to user:

## Visual Sweep Complete: <app>

**Sections:** <captured>/<total> captured
**Findings:** <total> (<critical> critical, <high> high, <medium> medium, <low> low)

### Summary
See: <summary file path>

### Per-Section
<table: section | findings | top severity>

### Action Items
- <list CRITICAL and HIGH findings>
- To fix: /torque-team <summary file path>

### Cleanup

Remove temporary capture files:

rm -rf <working_directory>/docs/visual-sweep-captures/
rm -f <working_directory>/docs/visual-sweep-plan.json

Keep findings files — they are the permanent output.
```

- [ ] **Step 2: Verify the file is well-formed**

Run: `head -5 .claude/commands/torque-visual-sweep.md`
Expected: frontmatter starts with `---`.

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/torque-visual-sweep.md
git commit -m "feat: add /torque-visual-sweep command for deep visual audits"
```

---

### Task 9: Integration — Wire Post-Task Hook

Register the manifest enforcement hook in the TORQUE post-tool-hooks system so it fires on `task_complete`.

**Files:**
- Modify: `server/hooks/post-tool-hooks.js` (register built-in hook factory)
- Test: `server/tests/manifest-enforcement-integration.test.js`

- [ ] **Step 1: Write the failing integration test**

```js
// server/tests/manifest-enforcement-integration.test.js
'use strict';

const { describe, it, expect, beforeEach } = require('vitest');
const { registerBuiltInHook, listHooks, removeHook } = require('../hooks/post-tool-hooks');

describe('manifest-enforcement integration', () => {
  beforeEach(() => {
    // Clean up any previously registered hook
    const existing = listHooks('task_complete').find(h => h.hook_name === 'manifest_enforcement');
    if (existing) removeHook(existing.id);
  });

  it('can register the manifest_enforcement built-in hook', () => {
    const result = registerBuiltInHook('task_complete', 'manifest_enforcement');
    expect(result.hook_name).toBe('manifest_enforcement');
    expect(result.event_type).toBe('task_complete');
    expect(result.built_in).toBe(true);
  });

  it('appears in listHooks after registration', () => {
    registerBuiltInHook('task_complete', 'manifest_enforcement');
    const hooks = listHooks('task_complete');
    const found = hooks.find(h => h.hook_name === 'manifest_enforcement');
    expect(found).toBeDefined();
    expect(found.built_in).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/manifest-enforcement-integration.test.js`
Expected: FAIL — no built-in hook registered for `task_complete:manifest_enforcement`.

- [ ] **Step 3: Register the hook factory in post-tool-hooks.js**

Read `server/hooks/post-tool-hooks.js` to find the end of the file. Add before `module.exports`:

```js
// ─── Built-in hook: manifest enforcement ────────────────────────────────
(function registerManifestEnforcementFactory() {
  const factory = () => {
    const { createHook } = require('./manifest-enforcement');
    return createHook();
  };
  factory.description = 'Check completed tasks for new visual surfaces not in peek-manifest.json';
  builtInHookFactories.set('task_complete:manifest_enforcement', factory);
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/manifest-enforcement-integration.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Run all manifest-related tests together**

Run: `npx vitest run server/tests/manifest-patterns.test.js server/tests/manifest-enforcement.test.js server/tests/manifest-enforcement-integration.test.js`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add server/hooks/post-tool-hooks.js server/tests/manifest-enforcement-integration.test.js
git commit -m "feat: wire manifest enforcement hook into task_complete pipeline"
```

---

### Task 10: Documentation — Update CLAUDE.md and Scout Variant Table

Update project documentation to reference the new visual sweep system.

**Files:**
- Modify: `CLAUDE.md` (add visual sweep section and command to table)
- Modify: `.claude/commands/torque-scout.md` (update visual variant description)

- [ ] **Step 1: Add `/torque-visual-sweep` to the commands table in CLAUDE.md**

Find the commands table in `CLAUDE.md` and add this row after the `/torque-validate` entry:

```markdown
| `/torque-visual-sweep` | Deep visual audit — discovery, capture, analysis fleet for one app |
```

- [ ] **Step 2: Add visual sweep section to CLAUDE.md**

Add a new section after the "TORQUE Team Pipeline" section:

```markdown
## Visual Sweep

Deep visual audit for a single application. Runs on-demand or via one-time schedule.

### Usage

    /torque-visual-sweep <app>                                        # sweep all pages
    /torque-visual-sweep <app> --depth component --section dashboard  # deep dive one section
    /torque-visual-sweep <app> --schedule "11pm"                      # schedule for later

### Peek Manifest

Each project with UI declares its visual surfaces in `peek-manifest.json` at the project root. New visual surfaces are enforced by:
- **Pre-commit hook** — blocks commits with unregistered surfaces
- **TORQUE post-task hook** — flags unregistered surfaces after task completion

### Three Phases

1. **Discovery** — reads manifest, validates against live UI, detects unmanifested surfaces
2. **Capture** — navigates to each section sequentially, captures via `peek_diagnose`
3. **Analysis** — fleet of parallel Claude agents, one per section, writing findings

Findings output to `docs/findings/<date>-visual-sweep-<app>-summary.md`.
```

- [ ] **Step 3: Update the visual variant description in torque-scout.md**

Change the visual row in the variant table from:

```
| `visual` | UI layout, rendering, visual regressions via peek_ui | Claude Agent |
```

To:

```
| `visual` | UI layout, rendering, visual regressions via peek_ui (quick scan — use `/torque-visual-sweep` for deep audits) | Claude Agent |
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .claude/commands/torque-scout.md
git commit -m "docs: add visual sweep documentation and update scout variant table"
```

---

## Execution Order

Tasks 1-3 (patterns, pre-commit hook, post-task hook) must be sequential — each builds on the previous.

Tasks 4-7 (agent definitions) are independent of each other and can run in parallel.

Task 8 (command) depends on Tasks 4-7 being complete (references all agent files).

Task 9 (hook wiring) depends on Tasks 1 and 3.

Task 10 (docs) depends on Task 8.

```
Task 1 (patterns) --> Task 2 (pre-commit) --> Task 3 (post-task hook) --> Task 9 (hook wiring)
                                                                            ^
Tasks 4-7 (agents, parallel) --> Task 8 (command) --> Task 10 (docs) -------+
```