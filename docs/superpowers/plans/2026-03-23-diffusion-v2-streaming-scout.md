# Diffusion v2: Streaming Scout & Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the diffusion engine with streaming scout signals (two-phase discovery/classification), complete exemplar embedding in fan-out prompts, and mandatory verify_command on diffusion workflows.

**Architecture:** The scout emits structured markers mid-execution (`__PATTERNS_READY__`, `__SCOUT_DISCOVERY__`, `__SCOUT_COMPLETE__`) via stdout. A signal detection callback in `process-streams.js` parses these in real time and pushes notifications to Claude's session. The planner embeds full before/after exemplar file content in fan-out task prompts. `create_diffusion_plan` requires a verify_command and sets `auto_verify_on_completion: true` on all fan-out tasks.

**Tech Stack:** Node.js, Vitest, existing TORQUE infrastructure (process-streams, event-dispatch, auto-verify-retry)

**Spec:** `docs/superpowers/specs/2026-03-23-diffusion-v2-streaming-scout-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/diffusion/stream-signal-parser.js` | **NEW** — Stateful streaming parser for scout signal markers. Buffers chunks, detects marker pairs, extracts + validates JSON. |
| `server/diffusion/signal-parser.js` | **MODIFY** — Add validation functions for `__PATTERNS_READY__` and `__SCOUT_DISCOVERY__` payloads (reused by stream parser) |
| `server/diffusion/plan-schema.js` | **MODIFY** — Add `exemplar_before` and `exemplar_after` as optional pattern fields |
| `server/diffusion/planner.js` | **MODIFY** — Update `expandTaskDescription` to embed full before/after exemplar content |
| `server/execution/process-streams.js` | **MODIFY** — Hook scout signal detection into `stdout.on('data')` before truncation |
| `server/handlers/diffusion-handlers.js` | **MODIFY** — Update `submit_scout` timeout, update `create_diffusion_plan` to require verify_command and set `auto_verify_on_completion` |
| `server/orchestrator/prompt-templates.js` | **MODIFY** — Update scout template with two-phase instructions + few-shot example |
| `server/tool-defs/diffusion-defs.js` | **MODIFY** — Add `verify_command` to `create_diffusion_plan` schema |
| `server/tests/diffusion-stream-signal-parser.test.js` | **NEW** — Tests for streaming parser |
| `server/tests/diffusion-planner.test.js` | **MODIFY** — Add tests for v2 exemplar embedding |
| `server/tests/diffusion-handlers.test.js` | **MODIFY** — Add tests for mandatory verify_command |

---

## Task 1: Streaming Signal Parser

**Files:**
- Create: `server/diffusion/stream-signal-parser.js`
- Modify: `server/diffusion/signal-parser.js`
- Test: `server/tests/diffusion-stream-signal-parser.test.js`

- [ ] **Step 1: Write failing tests for the streaming parser**

```js
// server/tests/diffusion-stream-signal-parser.test.js
import { describe, it, expect, beforeEach } from 'vitest';
const { StreamSignalParser } = require('../diffusion/stream-signal-parser');

describe('StreamSignalParser', () => {
  let parser;
  let signals;

  beforeEach(() => {
    signals = [];
    parser = new StreamSignalParser((type, data) => signals.push({ type, data }));
  });

  it('detects a complete __PATTERNS_READY__ signal in one chunk', () => {
    const payload = JSON.stringify({
      patterns: [{ id: 'a', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', exemplar_before: 'before', exemplar_after: 'after', file_count: 5 }],
      shared_dependencies: [],
      total_candidates: 50,
      scanned_so_far: 10,
    });
    parser.feed(`some output\n__PATTERNS_READY__\n${payload}\n__PATTERNS_READY_END__\nmore output`);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('patterns_ready');
    expect(signals[0].data.patterns).toHaveLength(1);
  });

  it('detects __SCOUT_DISCOVERY__ signals', () => {
    const payload = JSON.stringify({
      manifest_chunk: [{ file: 'a.cs', pattern: 'p1' }],
      scanned_so_far: 30,
      total_candidates: 100,
    });
    parser.feed(`__SCOUT_DISCOVERY__\n${payload}\n__SCOUT_DISCOVERY_END__`);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('scout_discovery');
    expect(signals[0].data.manifest_chunk).toHaveLength(1);
  });

  it('detects __SCOUT_COMPLETE__ signals', () => {
    const payload = JSON.stringify({
      total_classified: 26,
      total_skipped: 89,
      scanned_so_far: 115,
      total_candidates: 115,
    });
    parser.feed(`__SCOUT_COMPLETE__\n${payload}\n__SCOUT_COMPLETE_END__`);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('scout_complete');
  });

  it('handles JSON split across multiple chunks', () => {
    const payload = JSON.stringify({
      manifest_chunk: [{ file: 'a.cs', pattern: 'p1' }],
      scanned_so_far: 30,
      total_candidates: 100,
    });
    const full = `__SCOUT_DISCOVERY__\n${payload}\n__SCOUT_DISCOVERY_END__`;
    const mid = Math.floor(full.length / 2);
    parser.feed(full.slice(0, mid));
    expect(signals).toHaveLength(0);
    parser.feed(full.slice(mid));
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('scout_discovery');
  });

  it('handles multiple signals in one chunk', () => {
    const d1 = JSON.stringify({ manifest_chunk: [{ file: 'a.cs', pattern: 'p1' }], scanned_so_far: 30, total_candidates: 100 });
    const d2 = JSON.stringify({ manifest_chunk: [{ file: 'b.cs', pattern: 'p1' }], scanned_so_far: 40, total_candidates: 100 });
    parser.feed(`__SCOUT_DISCOVERY__\n${d1}\n__SCOUT_DISCOVERY_END__\nother stuff\n__SCOUT_DISCOVERY__\n${d2}\n__SCOUT_DISCOVERY_END__`);
    expect(signals).toHaveLength(2);
  });

  it('ignores malformed JSON in signals', () => {
    parser.feed('__SCOUT_DISCOVERY__\n{not valid json\n__SCOUT_DISCOVERY_END__');
    expect(signals).toHaveLength(0);
  });

  it('ignores non-signal output', () => {
    parser.feed('just regular task output here\nno markers at all');
    expect(signals).toHaveLength(0);
  });

  it('clears buffer on destroy', () => {
    parser.feed('__SCOUT_DISCOVERY__\n{"partial":');
    parser.destroy();
    parser.feed('"data"}\n__SCOUT_DISCOVERY_END__');
    expect(signals).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/diffusion-stream-signal-parser.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement stream-signal-parser.js**

```js
// server/diffusion/stream-signal-parser.js
'use strict';

const logger = require('../logger').child({ component: 'stream-signal-parser' });

const MARKER_TYPES = {
  '__PATTERNS_READY__': { end: '__PATTERNS_READY_END__', type: 'patterns_ready' },
  '__SCOUT_DISCOVERY__': { end: '__SCOUT_DISCOVERY_END__', type: 'scout_discovery' },
  '__SCOUT_COMPLETE__': { end: '__SCOUT_COMPLETE_END__', type: 'scout_complete' },
};

const MARKER_STARTS = Object.keys(MARKER_TYPES);

class StreamSignalParser {
  constructor(onSignal) {
    this._onSignal = onSignal;
    this._buffer = '';
    this._destroyed = false;
  }

  feed(chunk) {
    if (this._destroyed) return;
    this._buffer += chunk;
    this._scan();
  }

  _scan() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const startMarker of MARKER_STARTS) {
        const startIdx = this._buffer.indexOf(startMarker);
        if (startIdx === -1) continue;

        const { end: endMarker, type } = MARKER_TYPES[startMarker];
        const endIdx = this._buffer.indexOf(endMarker, startIdx + startMarker.length);
        if (endIdx === -1) continue; // incomplete — wait for more data

        const jsonStr = this._buffer.slice(startIdx + startMarker.length, endIdx).trim();
        this._buffer = this._buffer.slice(endIdx + endMarker.length);
        changed = true;

        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (err) {
          logger.info(`[StreamSignalParser] Malformed JSON in ${type}: ${err.message}`);
          continue;
        }

        try {
          this._onSignal(type, parsed);
        } catch (err) {
          logger.info(`[StreamSignalParser] Signal callback error for ${type}: ${err.message}`);
        }
      }
    }

    // Prevent unbounded buffer growth — keep only the last 16KB
    // (enough to hold any incomplete marker + JSON payload)
    if (this._buffer.length > 16384) {
      this._buffer = this._buffer.slice(-16384);
    }
  }

  destroy() {
    this._destroyed = true;
    this._buffer = '';
  }
}

module.exports = { StreamSignalParser, MARKER_TYPES, MARKER_STARTS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/diffusion-stream-signal-parser.test.js`
Expected: PASS — all 8 tests green

- [ ] **Step 5: Commit**

```bash
git add server/diffusion/stream-signal-parser.js server/tests/diffusion-stream-signal-parser.test.js
git commit -m "feat(diffusion): add streaming signal parser for two-phase scout"
```

---

## Task 2: Update Plan Schema for v2 Exemplar Fields

**Files:**
- Modify: `server/diffusion/plan-schema.js`
- Modify: `server/tests/diffusion-plan-schema.test.js`

- [ ] **Step 1: Add test for v2 exemplar fields**

Add to `server/tests/diffusion-plan-schema.test.js`:

```js
  it('accepts patterns with v2 exemplar_before and exemplar_after fields', () => {
    const plan = {
      summary: 'test',
      patterns: [{
        id: 'a',
        description: 'd',
        transformation: 't',
        exemplar_files: ['f.cs'],
        exemplar_diff: 'diff text',
        exemplar_before: 'using System;\nclass Foo {}',
        exemplar_after: 'using System;\nusing Shared;\nclass Foo {}',
        file_count: 1,
      }],
      manifest: [{ file: 'x.cs', pattern: 'a' }],
      shared_dependencies: [],
      estimated_subtasks: 1,
      isolation_confidence: 0.9,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(true);
  });

  it('still accepts v1 patterns without exemplar_before/after', () => {
    const plan = {
      summary: 'test',
      patterns: [{
        id: 'a', description: 'd', transformation: 't',
        exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1,
      }],
      manifest: [{ file: 'x.js', pattern: 'a' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.9,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(true);
  });
```

- [ ] **Step 2: Run tests — should pass (v2 fields are optional, schema doesn't reject extra fields)**

Run: `npx vitest run server/tests/diffusion-plan-schema.test.js`
Expected: PASS — v2 fields are not validated against, they pass through

- [ ] **Step 3: Commit**

```bash
git add server/diffusion/plan-schema.js server/tests/diffusion-plan-schema.test.js
git commit -m "test(diffusion): add v2 exemplar field tests to plan schema"
```

---

## Task 3: Update Planner with v2 Exemplar Embedding

**Files:**
- Modify: `server/diffusion/planner.js`
- Modify: `server/tests/diffusion-planner.test.js`

- [ ] **Step 1: Write failing test for v2 exemplar embedding**

Add to `server/tests/diffusion-planner.test.js`:

```js
describe('expandTaskDescription v2 (exemplar embedding)', () => {
  it('embeds full before/after content when available', () => {
    const pattern = {
      id: 'p1',
      description: 'Direct DB import files',
      transformation: 'Replace require(db) with container.get()',
      exemplar_before: 'using System;\nclass OldCode { void Save() { db.Save(); } }',
      exemplar_after: 'using System;\nusing Shared;\nclass NewCode { void Save() { svc.Save(); } }',
    };
    const files = ['a.cs', 'b.cs'];
    const desc = expandTaskDescription(pattern, files, '/project');
    expect(desc).toContain('Exemplar — BEFORE');
    expect(desc).toContain('class OldCode');
    expect(desc).toContain('Exemplar — AFTER');
    expect(desc).toContain('class NewCode');
    expect(desc).toContain('Do NOT deviate');
  });

  it('falls back to v1 format when exemplar_before/after not present', () => {
    const pattern = {
      id: 'p1',
      description: 'Direct DB import files',
      transformation: 'Replace require(db) with container.get()',
    };
    const files = ['a.cs'];
    const desc = expandTaskDescription(pattern, files, '/project');
    expect(desc).not.toContain('Exemplar — BEFORE');
    expect(desc).toContain('Direct DB import files');
    expect(desc).toContain('Replace require(db)');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/diffusion-planner.test.js`
Expected: FAIL — `expandTaskDescription` doesn't produce v2 format yet

- [ ] **Step 3: Update expandTaskDescription in planner.js**

Replace the `expandTaskDescription` function in `server/diffusion/planner.js`:

```js
function expandTaskDescription(pattern, files, workingDirectory) {
  const fileList = files.map(f => `- ${f}`).join('\n');

  // v2: embed full before/after exemplar content for unambiguous pattern matching
  if (pattern.exemplar_before && pattern.exemplar_after) {
    return `Apply the following transformation to the files listed below.

## Pattern
${pattern.description}

## Exemplar — BEFORE (exact file content)
\`\`\`
${pattern.exemplar_before}
\`\`\`

## Exemplar — AFTER (exact file content)
\`\`\`
${pattern.exemplar_after}
\`\`\`

## Your files to modify
${fileList}

Match the exemplar's exact calling conventions, parameter order,
import statements, and code style. Do NOT deviate from the pattern
shown in the exemplar.

Working directory: ${workingDirectory}`;
  }

  // v1 fallback: description + transformation only
  return `Apply the following transformation to the file(s) listed below.

Pattern: ${pattern.description}
Transformation: ${pattern.transformation}

Files to modify:
${fileList}

Reference: see exemplar diff for pattern "${pattern.id}" for the exact before/after.

Working directory: ${workingDirectory}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/diffusion-planner.test.js`
Expected: PASS — all tests green (v1 tests still pass, v2 tests now pass)

- [ ] **Step 5: Commit**

```bash
git add server/diffusion/planner.js server/tests/diffusion-planner.test.js
git commit -m "feat(diffusion): embed full before/after exemplar content in fan-out prompts"
```

---

## Task 4: Mandatory verify_command on create_diffusion_plan

**Files:**
- Modify: `server/handlers/diffusion-handlers.js`
- Modify: `server/tool-defs/diffusion-defs.js`
- Modify: `server/tests/diffusion-handlers.test.js`

- [ ] **Step 1: Write failing tests for verify_command requirement**

Add to `server/tests/diffusion-handlers.test.js`:

```js
describe('mandatory verify_command', () => {
  it('rejects create_diffusion_plan without verify_command when no project defaults', () => {
    const plan = {
      summary: 'Test',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.9,
    };
    const result = handlers.handleCreateDiffusionPlan({
      plan,
      working_directory: '/proj',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('verify_command');
  });

  it('accepts create_diffusion_plan with explicit verify_command', () => {
    const plan = {
      summary: 'Test',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.9,
    };
    const result = handlers.handleCreateDiffusionPlan({
      plan,
      working_directory: '/proj',
      verify_command: 'dotnet build',
    });
    expect(result.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests to verify the first test fails**

Run: `npx vitest run server/tests/diffusion-handlers.test.js`
Expected: First new test fails (currently `create_diffusion_plan` doesn't check for verify_command)

- [ ] **Step 3: Add verify_command to tool schema**

In `server/tool-defs/diffusion-defs.js`, add to the `create_diffusion_plan` inputSchema properties:

```js
        verify_command: { type: 'string', description: 'Build/compile command to verify fan-out task output (e.g., "dotnet build", "npx tsc --noEmit"). Required — falls back to project defaults if not provided.' },
```

- [ ] **Step 4: Update handleCreateDiffusionPlan in handlers**

In `server/handlers/diffusion-handlers.js`, add verify_command resolution after the depth check in `handleCreateDiffusionPlan`. Read the current file first. The changes are:

1. Add `verify_command` to the destructured args
2. After the depth check, resolve verify_command: explicit param → project defaults → error
3. Pass verify_command into `buildWorkflowTasks` options
4. In the task metadata for each fan-out task, set `auto_verify_on_completion: true` and `verify_command`

Add after the `validateDiffusionPlan` check:

```js
  // Resolve verify_command: explicit param → project defaults → error
  let resolvedVerifyCommand = verify_command;
  if (!resolvedVerifyCommand) {
    try {
      const projectConfigCore = require('../db/project-config-core');
      const defaults = projectConfigCore.getProjectDefaults(working_directory);
      resolvedVerifyCommand = defaults?.verify_command;
    } catch (_e) { /* project config not available */ }
  }
  if (!resolvedVerifyCommand) {
    return makeError(
      ErrorCodes.MISSING_REQUIRED_PARAM,
      'Diffusion workflows require a verify_command (e.g., "dotnet build", "npx tsc --noEmit"). Set one via the parameter or via set_project_defaults.'
    );
  }
```

Then when creating fan-out tasks, merge `auto_verify_on_completion: true` and `verify_command: resolvedVerifyCommand` into each task's metadata.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/tests/diffusion-handlers.test.js`
Expected: PASS — all tests green

- [ ] **Step 6: Commit**

```bash
git add server/handlers/diffusion-handlers.js server/tool-defs/diffusion-defs.js server/tests/diffusion-handlers.test.js
git commit -m "feat(diffusion): require verify_command on diffusion workflows"
```

---

## Task 5: Hook Scout Signal Detection into process-streams.js

**Files:**
- Modify: `server/execution/process-streams.js:77-96`
- Test: `server/tests/diffusion-stream-signal-parser.test.js` (already has unit tests; this is integration wiring)

- [ ] **Step 1: Read process-streams.js to understand the stdout handler**

Read `server/execution/process-streams.js` lines 48-100. The `stdout.on('data')` handler at line 77 is where we inject. The signal detection must run BEFORE the truncation at lines 88-89.

- [ ] **Step 2: Add scout signal detection to setupStdoutHandler**

In `server/execution/process-streams.js`, inside the `stdout.on('data')` handler, add after line 87 (`proc.lastOutputAt = Date.now();`) and BEFORE line 88 (`if (proc.output.length > deps.MAX_OUTPUT_BUFFER)`):

```js
    // Scout signal detection — parse streaming markers before truncation
    if (proc._scoutSignalParser) {
      try {
        proc._scoutSignalParser.feed(text);
      } catch (err) {
        logger.info(`[Streams] Scout signal parser error for task ${taskId}: ${err.message}`);
      }
    }
```

- [ ] **Step 3: Add scout parser attachment in setupStdoutHandler setup**

Near the top of `setupStdoutHandler` (after line 72, `if (proc) { proc._outputBuffer = outputBuffer; }`), add:

```js
  // Attach scout signal parser for streaming scout tasks
  if (proc && !proc._scoutSignalParser) {
    try {
      const task = deps.db.getTask(taskId);
      const meta = task?.metadata ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata) : {};
      if (meta.mode === 'scout') {
        const { StreamSignalParser } = require('../diffusion/stream-signal-parser');
        const { dispatchTaskEvent } = require('../hooks/event-dispatch');
        proc._scoutSignalParser = new StreamSignalParser((type, data) => {
          logger.info(`[Streams] Scout signal detected for task ${taskId}: ${type}`);
          try {
            dispatchTaskEvent(taskId, 'scout_signal', { signal_type: type, ...data });
          } catch (err) {
            logger.info(`[Streams] Scout signal dispatch error: ${err.message}`);
          }
        });
      }
    } catch (err) {
      logger.info(`[Streams] Scout parser setup error for task ${taskId}: ${err.message}`);
    }
  }
```

- [ ] **Step 4: Clean up parser on process exit**

In `process-streams.js`, find the `child.on('close')` or `child.on('exit')` handler (or in `process-lifecycle.js` where cleanup happens). Add:

```js
if (proc._scoutSignalParser) {
  proc._scoutSignalParser.destroy();
  proc._scoutSignalParser = null;
}
```

If there's no direct close handler in process-streams.js, add cleanup to the output buffer flush call that already runs on close (search for `_outputBuffer.flush()`).

- [ ] **Step 5: Verify TORQUE server loads without errors**

Run: `node -e "require('./server/execution/process-streams'); console.log('process-streams loaded OK')"`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add server/execution/process-streams.js
git commit -m "feat(diffusion): hook scout signal parser into stdout pipeline"
```

---

## Task 6: Update Scout Prompt Template

**Files:**
- Modify: `server/orchestrator/prompt-templates.js`

- [ ] **Step 1: Read current scout template**

Read `server/orchestrator/prompt-templates.js` and find the `scout` template entry.

- [ ] **Step 2: Replace the scout template with v2 two-phase instructions**

Replace the `scout` entry in the `TEMPLATES` object with:

```js
  scout: {
    system: `You are a codebase analyst performing reconnaissance for an automated task distribution system.
Your job is to analyze a working directory, classify files by transformation pattern, and produce structured signals that allow work to begin BEFORE your analysis is complete.
Do NOT modify any files. Your output is analysis only.
You MUST output signals in two phases — pattern discovery first, then file classification in batches.`,

    user: `Analyze the following scope in two phases.

**Scope:** {{scope}}
**Working Directory:** {{working_directory}}
**File List:** {{file_list}}

## Phase 1: Pattern Discovery
1. Read 10-20 candidate files to understand the transformation scope
2. Group files by the transformation they need (same change = same pattern)
3. For EACH pattern, pick one representative file and produce BOTH the complete file content BEFORE transformation and the complete file content AFTER transformation
4. Identify any shared files that multiple patterns depend on (e.g., a helper class that needs to be created first)
5. Output a __PATTERNS_READY__ signal with your findings

## Phase 2: File Classification
6. Continue scanning the remaining candidate files
7. For every 5-10 files classified, output a __SCOUT_DISCOVERY__ signal with the batch
8. When all files are scanned, output a __SCOUT_COMPLETE__ signal

## CRITICAL: Output signals as you go, NOT all at the end.

### Example output format:

Analyzing files in src/App/Sections...
Found 3 patterns across first 15 files.

__PATTERNS_READY__
{
  "patterns": [
    {
      "id": "single-field-validation",
      "description": "Dialog with one required TextBox check",
      "transformation": "Replace inline check with ValidationHelper.ValidateRequired()",
      "exemplar_files": ["src/App/ExampleDialog.xaml.cs"],
      "exemplar_diff": "- old code\\n+ new code",
      "exemplar_before": "using System.Windows;\\n\\npublic partial class ExampleDialog : Window\\n{\\n    public ExampleDialog() { InitializeComponent(); }\\n\\n    private void OnSave(object sender, RoutedEventArgs e)\\n    {\\n        if (string.IsNullOrWhiteSpace(NameBox.Text))\\n        {\\n            ErrorMessage.Text = \\"Name is required.\\";\\n            ErrorMessage.Visibility = Visibility.Visible;\\n            return;\\n        }\\n        ErrorMessage.Visibility = Visibility.Collapsed;\\n        DialogResult = true;\\n    }\\n}",
      "exemplar_after": "using System.Windows;\\nusing App.Shared;\\n\\npublic partial class ExampleDialog : Window\\n{\\n    public ExampleDialog() { InitializeComponent(); }\\n\\n    private void OnSave(object sender, RoutedEventArgs e)\\n    {\\n        if (!ValidationHelper.ValidateRequired(ErrorMessage, NameBox, \\"Name is required.\\")) return;\\n        ValidationHelper.ClearError(ErrorMessage);\\n        DialogResult = true;\\n    }\\n}",
      "file_count": 15
    }
  ],
  "shared_dependencies": [
    { "file": "src/App/Shared/ValidationHelper.cs", "change": "Create static helper class" }
  ],
  "total_candidates": 50,
  "scanned_so_far": 15
}
__PATTERNS_READY_END__

Continuing classification... scanning files 16-30.

__SCOUT_DISCOVERY__
{
  "manifest_chunk": [
    { "file": "src/App/Sections/FooDialog.xaml.cs", "pattern": "single-field-validation" },
    { "file": "src/App/Sections/BarDialog.xaml.cs", "pattern": "single-field-validation" }
  ],
  "scanned_so_far": 30,
  "total_candidates": 50
}
__SCOUT_DISCOVERY_END__

Scanning files 31-50...

__SCOUT_DISCOVERY__
{
  "manifest_chunk": [
    { "file": "src/App/Sections/BazDialog.xaml.cs", "pattern": "single-field-validation" }
  ],
  "scanned_so_far": 50,
  "total_candidates": 50
}
__SCOUT_DISCOVERY_END__

__SCOUT_COMPLETE__
{
  "total_classified": 18,
  "total_skipped": 32,
  "scanned_so_far": 50,
  "total_candidates": 50
}
__SCOUT_COMPLETE_END__

Output the signal blocks directly with no markdown fences around them.`,

    schema: {
      type: 'object',
      required: ['patterns'],
      properties: {
        patterns: { type: 'array', items: { type: 'object', required: ['id', 'description', 'transformation', 'exemplar_files', 'exemplar_diff', 'file_count'] } },
        shared_dependencies: { type: 'array' },
        total_candidates: { type: 'number' },
        scanned_so_far: { type: 'number' },
      },
    },
  },
```

- [ ] **Step 3: Verify template loads**

Run: `node -e "const { buildPrompt } = require('./server/orchestrator/prompt-templates'); const r = buildPrompt('scout', { scope: 'test', working_directory: '/tmp', file_list: 'a.js' }); console.log('OK:', r.system.substring(0, 50)); console.log('Has phases:', r.user.includes('Phase 1') && r.user.includes('Phase 2'));"`
Expected: `OK: You are a codebase analyst...` and `Has phases: true`

- [ ] **Step 4: Commit**

```bash
git add server/orchestrator/prompt-templates.js
git commit -m "feat(diffusion): update scout prompt with two-phase streaming instructions"
```

---

## Task 7: Update submit_scout Timeout

**Files:**
- Modify: `server/handlers/diffusion-handlers.js`

- [ ] **Step 1: Read the current submit_scout handler**

Read `server/handlers/diffusion-handlers.js` and find `DEFAULT_SCOUT_TIMEOUT`.

- [ ] **Step 2: Increase the default timeout**

Change `const DEFAULT_SCOUT_TIMEOUT = 10;` to `const DEFAULT_SCOUT_TIMEOUT = 30;` and change the timeout cap from `Math.min(timeout_minutes || DEFAULT_SCOUT_TIMEOUT, 30)` to `Math.min(timeout_minutes || DEFAULT_SCOUT_TIMEOUT, 60)`.

The spec says "no arbitrary timeout" — the scout runs until completion or stall detection. A 30-minute default with 60-minute cap gives the scout plenty of room for large codebases while stall detection (configurable, default 600s for Codex) provides the real safety net.

- [ ] **Step 3: Commit**

```bash
git add server/handlers/diffusion-handlers.js
git commit -m "feat(diffusion): increase scout timeout to 30min default, 60min cap"
```

---

## Task 8: Final Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Run all diffusion tests together**

Run: `npx vitest run server/tests/diffusion-*.test.js`
Expected: All test files pass

- [ ] **Step 2: Verify TORQUE server starts with the updated code**

Run: `node -e "require('./server/tools'); require('./server/execution/process-streams'); console.log('All modules loaded OK')"`
Expected: No errors

- [ ] **Step 3: Verify scout prompt has two-phase instructions**

Run: `node -e "const { buildPrompt } = require('./server/orchestrator/prompt-templates'); const r = buildPrompt('scout', { scope: 'test', working_directory: '/tmp', file_list: '' }); console.log('Has PATTERNS_READY:', r.user.includes('__PATTERNS_READY__')); console.log('Has SCOUT_DISCOVERY:', r.user.includes('__SCOUT_DISCOVERY__')); console.log('Has exemplar_before:', r.user.includes('exemplar_before'));"`
Expected: All three true

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A && git commit -m "chore(diffusion): v2 final verification and cleanup"
```
