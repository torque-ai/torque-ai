# Fabro #21: Pre-Commit AI Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Before a workflow's `auto_commit` step actually commits, run an AI reviewer over the staged diff (and related dependencies) to flag bugs, missing tests, or risky patterns. Workflow can be configured to fail-on-review-issues, warn-on-review-issues, or require human approval. Inspired by Sweep's pre-commit AI review.

**Architecture:** A new `server/review/pre-commit-reviewer.js` module gathers `git diff --staged` plus a small "context fan-out" of files that import what changed (using the repo map from Plan 17 if available). The reviewer dispatches a structured prompt to a configured `reviewer_provider` (default: claude-cli or anthropic). The reviewer returns JSON: `{ verdict: "pass"|"warn"|"block", issues: [...], suggestions: [...] }`. Triggered automatically when a workflow has `pre_commit_review.enabled: true` AND `auto_commit: true`. Insertion point: in the auto-commit batch path before the actual commit.

---

## File Structure

**New files:**
- `server/review/pre-commit-reviewer.js`
- `server/review/review-prompt.js`
- `server/handlers/review-handlers.js` (extend existing if present)
- `server/tests/pre-commit-reviewer.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `pre_commit_review` per workflow
- `server/tool-defs/workflow-defs.js`
- `server/db/auto-commit.js` (or wherever auto-commit logic lives) — invoke reviewer before commit
- `docs/pre-commit-review.md`

---

## Task 1: Reviewer module

- [ ] **Step 1: Tests**

Create `server/tests/pre-commit-reviewer.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { reviewDiff } = require('../review/pre-commit-reviewer');

describe('reviewDiff', () => {
  it('passes a clean diff with no issues', async () => {
    const runLLM = vi.fn().mockResolvedValue({ verdict: 'pass', issues: [], suggestions: [] });
    const result = await reviewDiff({
      diff: 'diff --git a/x.js b/x.js\n+ const safe = 1;\n',
      runLLM,
    });
    expect(result.verdict).toBe('pass');
    expect(result.issues).toEqual([]);
  });

  it('returns warn when reviewer flags non-blocking issues', async () => {
    const runLLM = vi.fn().mockResolvedValue({
      verdict: 'warn',
      issues: [{ severity: 'medium', file: 'x.js', line: 5, note: 'no error handling' }],
      suggestions: ['add try/catch'],
    });
    const result = await reviewDiff({ diff: '...', runLLM });
    expect(result.verdict).toBe('warn');
    expect(result.issues).toHaveLength(1);
  });

  it('falls back to "pass" with annotation when LLM throws', async () => {
    const runLLM = vi.fn().mockRejectedValue(new Error('llm down'));
    const result = await reviewDiff({ diff: '...', runLLM });
    expect(result.verdict).toBe('pass');
    expect(result.issues[0].note).toMatch(/reviewer unavailable/i);
  });

  it('falls back to "pass" when LLM returns malformed JSON', async () => {
    const runLLM = vi.fn().mockResolvedValue({ not_a_verdict: true });
    const result = await reviewDiff({ diff: '...', runLLM });
    expect(result.verdict).toBe('pass');
    expect(result.issues[0].note).toMatch(/schema|invalid|malformed/i);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/review/review-prompt.js`:

```js
'use strict';

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'warn', 'block'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'note'],
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          note: { type: 'string' },
        },
      },
    },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
};

function buildReviewPrompt(diff, contextFiles) {
  return `You are reviewing a code change before it is committed.

DIFF:
${diff.slice(0, 30000)}

${contextFiles?.length ? `RELATED FILES (callers / dependencies):\n${contextFiles.slice(0, 5).map(f => `--- ${f.path} ---\n${f.content.slice(0, 4000)}`).join('\n\n')}\n\n` : ''}Return a JSON object matching this schema EXACTLY:

{
  "verdict": "pass" | "warn" | "block",
  "issues": [
    { "severity": "low" | "medium" | "high" | "critical", "file": "path/to/file", "line": 42, "note": "what's wrong" }
  ],
  "suggestions": ["actionable improvements"]
}

Verdict guide:
- pass: no significant issues
- warn: minor issues — should ship but worth noting
- block: bugs, security holes, or missing tests that should prevent commit

Be specific. Cite exact lines. Do NOT invent issues — if the diff looks fine, return verdict="pass" with empty issues.`;
}

module.exports = { REVIEW_SCHEMA, buildReviewPrompt };
```

Create `server/review/pre-commit-reviewer.js`:

```js
'use strict';

const Ajv = require('ajv');
const { REVIEW_SCHEMA, buildReviewPrompt } = require('./review-prompt');
const logger = require('../logger').child({ component: 'pre-commit-review' });

const ajv = new Ajv({ strict: false });
const validateReview = ajv.compile(REVIEW_SCHEMA);

async function defaultRunLLM(prompt) {
  const providerRegistry = require('../providers/registry');
  const order = ['claude-cli', 'anthropic', 'codex'];
  for (const p of order) {
    const inst = providerRegistry.getProviderInstance(p);
    if (inst && typeof inst.runPrompt === 'function') {
      const out = await inst.runPrompt({ prompt, format: 'json', max_tokens: 2000 });
      return typeof out === 'string' ? JSON.parse(out) : out;
    }
  }
  throw new Error('No reviewer provider available');
}

async function reviewDiff({ diff, contextFiles = [], runLLM = defaultRunLLM }) {
  if (!diff || diff.trim() === '') {
    return { verdict: 'pass', issues: [], suggestions: [], note: 'empty diff' };
  }
  let raw;
  try {
    raw = await runLLM(buildReviewPrompt(diff, contextFiles));
  } catch (err) {
    logger.info(`[pre-commit-review] reviewer unavailable: ${err.message}`);
    return {
      verdict: 'pass',
      issues: [{ severity: 'low', note: `reviewer unavailable: ${err.message}` }],
      suggestions: [],
    };
  }
  if (!validateReview(raw)) {
    logger.info(`[pre-commit-review] reviewer returned malformed JSON`);
    return {
      verdict: 'pass',
      issues: [{ severity: 'low', note: 'reviewer schema invalid; treating as pass' }],
      suggestions: [],
    };
  }
  return raw;
}

module.exports = { reviewDiff };
```

Run tests → PASS. Commit: `feat(pre-commit-review): reviewer module + prompt + schema`.

---

## Task 2: Wire into auto-commit + workflow config

- [ ] **Step 1: Workflow tool def**

In `server/tool-defs/workflow-defs.js` `create_workflow` top-level properties:

```js
pre_commit_review: {
  type: 'object',
  description: 'Run an AI reviewer on staged changes before auto_commit fires.',
  properties: {
    enabled: { type: 'boolean', default: false },
    on_block: { type: 'string', enum: ['fail_workflow', 'require_approval', 'warn_only'], default: 'warn_only' },
    reviewer_provider: { type: 'string' },
  },
},
```

In `handleCreateWorkflow`, store in workflow context:

```js
if (args.pre_commit_review) workflowContext.pre_commit_review = args.pre_commit_review;
```

- [ ] **Step 2: Invoke reviewer in auto-commit path**

Find `server/db/auto-commit.js` (or wherever `auto_commit_batch` is implemented). Before the actual `git commit`, if `workflow.context.pre_commit_review.enabled`:

```js
const review = workflow.context?.pre_commit_review;
if (review?.enabled) {
  const { reviewDiff } = require('../review/pre-commit-reviewer');
  // Get the staged diff
  const diff = execFileSync('git', ['diff', '--cached'], { cwd: workingDir, encoding: 'utf8' });
  const result = await reviewDiff({ diff });
  // Persist verdict to workflow metadata
  // ... and act on it:
  if (result.verdict === 'block') {
    if (review.on_block === 'fail_workflow') {
      // Mark workflow failed, don't commit
      return { ok: false, reason: `pre-commit review blocked: ${result.issues.map(i => i.note).join('; ')}` };
    }
    if (review.on_block === 'require_approval') {
      // Set workflow to pending_approval, surface review verdict
      // ... approval flow ...
    }
    // warn_only: log + proceed
    logger.info(`[pre-commit-review] BLOCK verdict ignored (on_block=warn_only): ${JSON.stringify(result.issues)}`);
  }
  // Continue with commit; embed review summary in commit message trailer
}
```

- [ ] **Step 3: Commit**

`feat(pre-commit-review): hook into auto-commit batch path`.

---

## Task 3: Docs + restart + smoke

- [ ] **Step 1: Docs**

Create `docs/pre-commit-review.md`:

```markdown
# Pre-Commit AI Review

Workflows with `auto_commit: true` can request an AI reviewer to inspect the staged diff before committing.

```yaml
pre_commit_review:
  enabled: true
  on_block: fail_workflow   # fail_workflow | require_approval | warn_only
  reviewer_provider: claude-cli
```

## What the reviewer sees

- Full `git diff --cached`
- (Optional) related files (callers/dependencies of changed files) — uses repo map from Plan 17 when available

## Verdicts

| Verdict | Meaning |
|---|---|
| `pass` | No significant issues. Commit proceeds. |
| `warn` | Minor issues. Commit proceeds. Issues recorded in workflow metadata + commit trailer. |
| `block` | Bugs, security issues, or missing tests. Behavior depends on `on_block`. |

## `on_block` modes

| Mode | Behavior |
|---|---|
| `warn_only` (default) | Log the verdict but commit anyway |
| `fail_workflow` | Cancel the commit, mark workflow as failed with reason |
| `require_approval` | Hold the commit, surface verdict as a pending approval |

## Failure modes

If the reviewer LLM is unavailable or returns malformed JSON, the verdict defaults to `pass` with an annotation. Pre-commit review is best-effort — never blocks a workflow because the reviewer crashed.
```

`await_restart`. Smoke test: submit a workflow with `pre_commit_review.enabled: true` that produces a deliberately-buggy change. Confirm reviewer flags it and (depending on `on_block`) blocks or warns.

Commit: `docs(pre-commit-review): user guide`.
