# Codex Phantom Success Detector Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop TORQUE from marking Codex tasks `completed` when they exited 0 but produced nothing — the "phantom success" pattern caused by OpenAI overload that silently no-op'd 4 tasks during the starvation-detection batch on 2026-04-20.

**Architecture:** Add a post-task validator that runs in the close-handler pipeline. Tasks completing in less than N seconds with empty stdout AND zero file changes AND a known overload-signature in stderr should be reclassified from `completed` to `failed` with `error_output: "phantom completion: codex overload"`. Plumbs into the existing post-task validation framework in `server/validation/post-task.js`.

**Tech Stack:** Node.js, Vitest. New module under `server/validation/`.

**Context:** During the 2026-04-20 starvation-detection batch (3a2c727e merge), 4 Codex tasks (60be6ac4, 5c0ad54d, 0ec0db82, 0a6b2451) completed with `exit_code=0` in 60-72s with `(no output)`, zero file changes, and stderr ending:
```
ERROR: Reconnecting... 1/5 ... 5/5
ERROR: Reconnecting... 1/5 ... 5/5
ERROR: We're currently experiencing high demand, which may cause temporary errors.
```
QC and remediation each had to discover this independently and route around it. The cost: ~5 wasted task slots and ~30 minutes of orchestration churn.

---

## Task 1: Phantom-success classifier module

**Why:** Centralize the pattern recognition (exit 0 + empty stdout + zero diff + overload-stderr) in a single testable function before wiring it into the close handler.

**Files:**
- Create: `server/validation/phantom-success-detector.js`
- Test: `server/tests/phantom-success-detector.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { detectPhantomSuccess } = require('../validation/phantom-success-detector');

describe('detectPhantomSuccess', () => {
  it('flags exit 0 + empty stdout + zero diff + overload stderr as phantom', () => {
    const result = detectPhantomSuccess({
      exitCode: 0,
      stdout: '(no output)',
      stderr: 'ERROR: Reconnecting... 1/5\nERROR: We\'re currently experiencing high demand',
      diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
      durationMs: 65_000,
      provider: 'codex',
    });
    expect(result.isPhantom).toBe(true);
    expect(result.reason).toMatch(/overload|reconnecting/i);
  });

  it('does not flag a real completion that touched files', () => {
    const result = detectPhantomSuccess({
      exitCode: 0,
      stdout: 'Wrote docs/findings/foo.md',
      stderr: 'ERROR: Reconnecting... 1/5\nERROR: We\'re currently experiencing high demand',
      diffStat: { filesChanged: 1, insertions: 5, deletions: 0 },
      durationMs: 65_000,
      provider: 'codex',
    });
    expect(result.isPhantom).toBe(false);
  });

  it('does not flag a real no-op task that legitimately had nothing to do', () => {
    // No overload signature in stderr — legitimate clean exit
    const result = detectPhantomSuccess({
      exitCode: 0,
      stdout: 'No changes required.',
      stderr: '',
      diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
      durationMs: 12_000,
      provider: 'codex',
    });
    expect(result.isPhantom).toBe(false);
  });

  it('does not flag non-codex providers (out of scope for v1)', () => {
    const result = detectPhantomSuccess({
      exitCode: 0,
      stdout: '(no output)',
      stderr: 'Reconnecting...',
      diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
      durationMs: 65_000,
      provider: 'ollama',
    });
    expect(result.isPhantom).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd server && npx vitest run tests/phantom-success-detector.test.js
```

- [ ] **Step 3: Implement the detector**

```js
'use strict';

const OVERLOAD_PATTERNS = [
  /ERROR:\s*Reconnecting\.\.\./i,
  /currently experiencing high demand/i,
  /rate limit exceeded/i,
];

const PHANTOM_PROVIDERS = new Set(['codex', 'codex-spark']);

function hasOverloadSignature(stderr) {
  if (!stderr || typeof stderr !== 'string') return false;
  return OVERLOAD_PATTERNS.some((re) => re.test(stderr));
}

function isEmptyOutput(stdout) {
  if (!stdout || typeof stdout !== 'string') return true;
  const trimmed = stdout.trim();
  return trimmed.length === 0 || /^\(no output\)$/i.test(trimmed);
}

function detectPhantomSuccess({ exitCode, stdout, stderr, diffStat, durationMs, provider }) {
  if (exitCode !== 0) return { isPhantom: false };
  if (!PHANTOM_PROVIDERS.has(provider)) return { isPhantom: false };
  if (!isEmptyOutput(stdout)) return { isPhantom: false };
  if (diffStat && diffStat.filesChanged > 0) return { isPhantom: false };
  if (!hasOverloadSignature(stderr)) return { isPhantom: false };

  return {
    isPhantom: true,
    reason: 'codex exited 0 with empty output and overload signature in stderr (no work product)',
  };
}

module.exports = { detectPhantomSuccess, OVERLOAD_PATTERNS, PHANTOM_PROVIDERS };
```

- [ ] **Step 4: Run test, confirm pass**

- [ ] **Step 5: Commit**

```bash
git add server/validation/phantom-success-detector.js server/tests/phantom-success-detector.test.js
git commit -m "feat(validation): detect Codex phantom-success pattern

New detector flags exit 0 + empty output + zero diff + overload-signature
stderr as phantom completion. Pattern observed during 2026-04-20
starvation-detection batch where OpenAI overload caused Codex CLI to
exhaust 5 reconnect retries then exit 0 silently."
```

---

## Task 2: Wire detector into close-handler pipeline

**Why:** The detector is dead weight without invocation. Insert it in `server/validation/post-task.js` between exit-code classification and the final status write.

**Files:**
- Modify: `server/validation/post-task.js`
- Test: `server/tests/post-task-phantom-reclassify.test.js` (new)

- [ ] **Step 1: Locate the integration point**

Use `search_files` to find where post-task hooks read exit_code and decide final status. Look for the function that takes a completed Codex task and writes its terminal status. Likely near `recordTaskOutcome` or `runPostTaskValidation`.

- [ ] **Step 2: Write the failing integration test**

```js
'use strict';

const { describe, it, expect, vi } = require('vitest');

describe('post-task phantom-success reclassification', () => {
  it('rewrites status from completed to failed when phantom detected', async () => {
    // Test that runPostTaskValidation, given a phantom-shaped task record,
    // returns { status: 'failed', error_output: /phantom completion/ }
    // and does not return { status: 'completed' }.
  });
});
```

(Fill in the spy/import details by reading post-task.js first.)

- [ ] **Step 3: Insert detector call**

In post-task.js, after the existing validation steps and BEFORE the final status write:

```js
const { detectPhantomSuccess } = require('./phantom-success-detector');

// ... existing validation ...

const phantom = detectPhantomSuccess({
  exitCode: task.exit_code,
  stdout: task.output,
  stderr: task.error_output,
  diffStat: validationResult.diffStat,
  durationMs: task.duration_ms,
  provider: task.provider,
});
if (phantom.isPhantom) {
  logger.warn('Phantom completion detected; reclassifying to failed', {
    task_id: task.id,
    reason: phantom.reason,
  });
  return {
    ...validationResult,
    status: 'failed',
    reason: phantom.reason,
    classification: 'phantom_completion',
  };
}
```

- [ ] **Step 4: Run integration test + suite**

```bash
cd server && npx vitest run tests/post-task-phantom-reclassify.test.js tests/post-task*.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/validation/post-task.js server/tests/post-task-phantom-reclassify.test.js
git commit -m "fix(validation): reclassify Codex phantom completions as failed

post-task pipeline now invokes detectPhantomSuccess after exit-code
classification. Phantom matches (exit 0 + empty output + zero diff +
codex overload stderr) get rewritten to status=failed with
classification=phantom_completion. Triggers normal retry/fallback
instead of silently shipping a no-op as success."
```

---

## Task 3: Decision-log surface

**Why:** When the detector fires, operators should see it in the factory decision log. Today phantom completions are invisible — they look identical to real completions in the dashboard.

**Files:**
- Modify: `server/validation/post-task.js` (call decision logger on phantom)
- Test: extend `server/tests/post-task-phantom-reclassify.test.js`

- [ ] **Step 1: Extend test to verify decision log entry**

- [ ] **Step 2: Add `safeLogDecision` call inside the phantom branch**

```js
const factoryDecisions = require('../db/factory-decisions');
factoryDecisions.logDecision({
  project_id: task.project_id,
  stage: 'execute',
  actor: 'validator',
  action: 'phantom_completion_detected',
  reasoning: phantom.reason,
  outcome: { task_id: task.id, exit_code: 0, duration_ms: task.duration_ms },
  confidence: 1,
});
```

- [ ] **Step 3: Run + commit**

---

## Self-Review

**Spec coverage:** detector module (Task 1), pipeline wiring (Task 2), operator visibility (Task 3) — all three needed.

**Placeholder scan:** Task 2 step 2 has a placeholder test body — fill it in by reading post-task.js first to identify the right entry point.

**Type consistency:** `diffStat.filesChanged` used identically across detector, pipeline call, and test fixtures. `phantom.isPhantom` boolean. `classification: 'phantom_completion'` string used identically in the reclassification path and decision log.

**Future extensions (not in this plan):**
- Apply the same detector to claude-cli (different overload-signature regex).
- Track phantom rates per provider as a health metric.
- Auto-pause a project after N phantom completions in a window.
