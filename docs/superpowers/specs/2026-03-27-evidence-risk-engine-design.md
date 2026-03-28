# Evidence & Risk Engine — Design Spec

**Date:** 2026-03-27
**Inspiration:** Anvil (burkeholland/anvil) — evidence-first coding agent
**Approach:** Three independent modules with shared DB tables (Approach C)

## Overview

Three Anvil-inspired features, each shipping independently:

1. **Verification Ledger** — structured, queryable audit trail of every verification step
2. **Adversarial Review** — multi-provider code review where a different model attacks the output
3. **File-Level Risk Tagging** — automatic risk scoring that drives review depth

These modules share no code dependencies on each other but are designed to interoperate:
- File risk scores feed adversarial review trigger decisions
- Adversarial review results write to the verification ledger
- The ledger provides a unified query surface across all verification and review activity

## Module 1: Verification Ledger

### Problem

Today, verification outcomes are buried in `ctx.validationStages` — a JSON blob stored in `tasks.metadata.finalization.validation_stage_outcomes`. This is not queryable, not standardized, and not auditable. The existing `validation_results` table is sparsely used and schema-mismatched (has `rule_id` FK, no `exit_code`, no `command`).

### Design Principle

Borrowed from Anvil: "Every verification step must be an INSERT. If the INSERT didn't happen, the verification didn't happen."

### Table: `verification_checks`

```sql
CREATE TABLE verification_checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL,
  workflow_id     TEXT,
  phase           TEXT NOT NULL,        -- 'baseline' | 'after' | 'review'
  check_name      TEXT NOT NULL,        -- 'build' | 'test' | 'lint' | 'typecheck' | 'safeguard' | 'adversarial_review' | custom
  tool            TEXT,                 -- what ran it: 'tsc' | 'vitest' | 'eslint' | 'safeguard-gates' | provider name
  command         TEXT,                 -- actual command executed (if applicable)
  exit_code       INTEGER,             -- 0 = pass, non-zero = fail, NULL = not a command
  output_snippet  TEXT,                -- first ~2000 chars of relevant output
  passed          INTEGER NOT NULL,    -- 1 = pass, 0 = fail
  duration_ms     INTEGER,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX idx_verif_checks_task ON verification_checks(task_id);
CREATE INDEX idx_verif_checks_phase ON verification_checks(phase);
```

### Integration: Finalizer Stage

- **Stage name:** `verification_ledger`
- **Position:** After `auto_verify_retry` (stage 10), before `smart_diagnosis` (stage 11)
- **File:** `server/execution/verification-ledger-stage.js`
- **Pattern:** Injected via `deps` (Pattern A from task-finalizer)

The stage is a **read-only consumer** of pipeline state. It:

1. Iterates `ctx.validationStages` and converts each stage outcome into one or more `verification_checks` rows with `phase: 'after'`
2. Records the `verify_command` result (from auto-verify-retry) as a dedicated check: `check_name: 'verify_command'`, `tool: 'verify_command'`, `command: <actual command>`, `exit_code`, `output_snippet`
3. If `file_baselines` data exists for the task, writes a `phase: 'baseline'` row capturing the pre-change state
4. Never sets `ctx.earlyExit` or mutates `ctx.status` — purely observational

### DB Module

- **File:** `server/db/verification-ledger.js`
- **Exports:** `createVerificationLedger(deps)` factory for DI container
- **Functions:**
  - `insertCheck(check)` — single row insert
  - `insertChecks(checks)` — batch insert (transaction-wrapped)
  - `getChecksForTask(taskId, { phase?, checkName? })` — filtered query
  - `getCheckSummary(workflowId)` — aggregate pass/fail/total per check_name across a workflow
  - `pruneOldChecks(retentionDays)` — retention cleanup (default: 90 days, configurable)

### MCP Tools

| Tool | Purpose |
|------|---------|
| `get_verification_ledger` | Query checks for a task, optionally filtered by phase/check_name |
| `get_verification_summary` | Aggregate pass/fail counts across a workflow |

### Configuration

- **Toggle:** `set_project_defaults({ verification_ledger: true })` or per-task `metadata: { verification_ledger: true }`
- **Off by default** — existing behavior unchanged until opted in
- **Retention:** `set_project_defaults({ verification_ledger_retention_days: 90 })`

---

## Module 2: Adversarial Review

### Problem

Today's review mechanisms are either deterministic-only (`strategic-review-stage.js` — checks file size delta and validation failures) or single-model unstructured prose (`review-handler.js` — spawns one LLM review task with free-form markdown output). Neither uses cross-model adversarial validation.

### Design Principle

Borrowed from Anvil: use a *different* model family to attack code changes. Disagreements between the author-model and reviewer-model are high-signal.

### Table: `adversarial_reviews`

```sql
CREATE TABLE adversarial_reviews (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT NOT NULL,
  review_task_id    TEXT,               -- the spawned review task's ID (if LLM-based)
  reviewer_provider TEXT NOT NULL,      -- 'codex' | 'deepinfra' | 'claude-cli' | etc.
  reviewer_model    TEXT,               -- specific model used
  verdict           TEXT,               -- 'approve' | 'reject' | 'concerns'
  confidence        TEXT,               -- 'high' | 'medium' | 'low'
  issues            TEXT,               -- JSON array: [{ file, line, severity, category, description, suggestion }]
  diff_snippet      TEXT,               -- the diff that was reviewed (truncated)
  duration_ms       INTEGER,
  created_at        TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (review_task_id) REFERENCES tasks(id)
);
CREATE INDEX idx_adv_reviews_task ON adversarial_reviews(task_id);
CREATE INDEX idx_adv_reviews_verdict ON adversarial_reviews(verdict);
```

### Issue Schema (JSON in `issues` column)

```json
[
  {
    "file": "server/auth/session.js",
    "line": 42,
    "severity": "critical",
    "category": "security",
    "description": "Session token compared with == instead of timing-safe comparison",
    "suggestion": "Use crypto.timingSafeEqual() for token comparison"
  }
]
```

Severity values: `critical`, `warning`, `info`
Category values: `bug`, `security`, `logic`, `performance`, `style`

### Integration: Finalizer Stage

- **Stage name:** `adversarial_review`
- **Position:** After `verification_ledger`, before `smart_diagnosis`
- **File:** `server/execution/adversarial-review-stage.js`
- **Pattern:** Injected via `deps` (Pattern A)

### Trigger Conditions

Stage activates when ALL of:
1. `ctx.status === 'completed'`
2. `metadata.review_task !== true` (prevents infinite recursion)
3. `metadata.adversarial_review_task !== true` (prevents infinite recursion)
4. At least one of:
   - Task metadata: `adversarial_review: true`
   - Project defaults: `adversarial_review: 'always'`
   - Project defaults: `adversarial_review: 'auto'` AND any file in `ctx.filesModified` has `risk_level = 'high'` in `file_risk_scores`

### Provider Selection

The reviewer must differ from the original provider:

1. Explicit override: `metadata.adversarial_reviewer: "deepinfra"` → use that
2. Configurable fallback chain (skipping original provider):
   - Default: `['codex', 'deepinfra', 'claude-cli', 'ollama']`
   - Override: `set_project_defaults({ adversarial_review_chain: [...] })`
3. No available alternative → skip, log reason to `ctx.validationStages`

### Review Prompt

```
You are a hostile code reviewer. Your job is to FIND PROBLEMS, not approve.

Task description: {{task_description}}
Provider that wrote this: {{provider}}
{{#if high_risk_files}}
HIGH-RISK FILES (pay special attention):
{{#each high_risk_files}}
- {{file_path}}: {{risk_reasons}}
{{/each}}
{{/if}}

Diff:
{{diff}}

Respond with ONLY a JSON object:
{
  "verdict": "approve" | "reject" | "concerns",
  "confidence": "high" | "medium" | "low",
  "issues": [
    { "file": "...", "line": 42, "severity": "critical|warning|info",
      "category": "bug|security|logic|performance|style",
      "description": "...", "suggestion": "..." }
  ]
}

Rules:
- "approve" = no issues found worth flagging
- "concerns" = issues found but not blocking
- "reject" = critical issues that should block commit
- Only use "reject" for genuine bugs or security holes, not style preferences
```

### Execution Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `async` (default) | Spawns review task, original task completes normally. Review result written to `adversarial_reviews` when review task finishes. Original task metadata: `adversarial_review_pending: true` | Non-blocking; review results arrive later |
| `blocking` | Waits for review (timeout: 5 min configurable). `reject` + `confidence: high` → sets `ctx.status = 'failed'`. Supports MCP elicitation for human override. | Gate commits behind review |

### Ledger Integration

When a review completes, a `verification_checks` row is also written:
- `phase: 'review'`, `check_name: 'adversarial_review'`, `tool: <reviewer_provider>`
- `passed: verdict !== 'reject'`
- `output_snippet: JSON.stringify(issues)`

This happens automatically if the verification ledger is enabled. If not, the adversarial review still functions — it just doesn't write to the ledger.

### DB Module

- **File:** `server/db/adversarial-reviews.js`
- **Exports:** `createAdversarialReviews(deps)` factory
- **Functions:**
  - `insertReview(review)` — write review result
  - `getReviewsForTask(taskId)` — all reviews for a task
  - `getReviewByReviewTaskId(reviewTaskId)` — lookup by the spawned review task
  - `getReviewStats(since?)` — aggregate verdict/confidence distribution

### MCP Tools

| Tool | Purpose |
|------|---------|
| `get_adversarial_reviews` | All reviews for a task |
| `request_adversarial_review` | Manually trigger a review for any completed task |
| `configure_adversarial_review` | Set mode, chain, auto-trigger rules (wrapper around project defaults) |

### Configuration

- **Toggle:** `set_project_defaults({ adversarial_review: 'off' | 'auto' | 'always' })`
- **Off by default**
- **Mode:** `set_project_defaults({ adversarial_review_mode: 'async' | 'blocking' })`
- **Chain:** `set_project_defaults({ adversarial_review_chain: ['codex', 'deepinfra', 'claude-cli', 'ollama'] })`
- **Timeout (blocking mode):** `set_project_defaults({ adversarial_review_timeout_seconds: 300 })`

---

## Module 3: File-Level Risk Tagging

### Problem

TORQUE's existing file classification (`verification.js` adapter) categorizes files by type (code/test/schema/docs/config) but doesn't assess *risk*. A change to `auth/session.js` is treated the same as a change to `utils/format-date.js`. There's no signal to drive deeper review for sensitive files.

### Design Principle

Borrowed from Anvil: classify files as red/yellow/green based on what they touch (auth, deletion, schema, concurrency, public API = red). Risk drives review depth.

### Table: `file_risk_scores`

```sql
CREATE TABLE file_risk_scores (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path         TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  risk_level        TEXT NOT NULL,        -- 'high' | 'medium' | 'low'
  risk_reasons      TEXT NOT NULL,         -- JSON array: ["auth_module", "schema_change"]
  auto_scored       INTEGER NOT NULL DEFAULT 1,  -- 1 = pattern-matched, 0 = manual override
  scored_at         TEXT NOT NULL,
  scored_by         TEXT,                  -- 'pattern' | 'manual' | task_id
  UNIQUE(file_path, working_directory)
);
CREATE INDEX idx_risk_scores_level ON file_risk_scores(risk_level);
CREATE INDEX idx_risk_scores_path ON file_risk_scores(file_path);
```

Cache table with UNIQUE constraint — each file has one current score per project. Recomputed when tasks touch the file.

### Risk Classification Rules

#### Static Pattern Rules (path-based)

**High Risk:**

| Pattern | Reason Tag |
|---------|------------|
| `**/auth/**`, `**/authentication/**`, `**/authorization/**` | `auth_module` |
| `**/*crypto*`, `**/*encrypt*`, `**/*decrypt*`, `**/*hash*` (excl. tests) | `crypto_module` |
| `**/*schema*`, `**/migration*`, `**/*.sql`, `**/*.prisma` | `schema_change` |
| `**/*secret*`, `**/.env*`, `**/*credential*`, `**/*token*` | `secrets_adjacent` |
| `**/api/routes*`, `**/controllers/**`, `**/endpoints/**` | `public_api` |
| `**/*payment*`, `**/*billing*`, `**/*subscription*` | `financial_module` |
| `**/*permission*`, `**/*rbac*`, `**/*acl*`, `**/*role*` | `access_control` |

**Medium Risk:**

| Pattern | Reason Tag |
|---------|------------|
| `**/middleware/**`, `**/hooks/**`, `**/interceptors/**` | `cross_cutting` |
| `**/*config*`, `**/settings*` (excl. lock files) | `configuration` |
| `**/*cache*`, `**/*session*`, `**/*state*` | `stateful_module` |
| `**/*queue*`, `**/*worker*`, `**/*job*` | `async_infra` |

**Low Risk:**

| Pattern | Reason Tag |
|---------|------------|
| `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**` | `test_file` |
| `**/*.md`, `**/docs/**`, `**/README*` | `documentation` |
| `**/*.css`, `**/*.scss`, `**/*.less` | `styling` |

Highest matching level wins. A file matching both high and medium patterns is scored high.

#### Change Signal Rules (overlay at task completion)

These can **escalate** risk but never reduce it. Computed from existing `task_file_changes` + `file_baselines` data.

| Signal | Detection | Escalation |
|--------|-----------|------------|
| Large deletion | `lines_removed > 50 AND lines_removed > lines_added * 2` | → medium minimum |
| File deletion | `change_type = 'deleted'` AND file was >100 lines | → medium minimum |
| Significant shrink | File size decreased >30% from baseline | → medium minimum |
| Concurrency touch | Diff contains concurrency keywords (`async/await/Promise/mutex/lock/atomic`) AND original file also contains them | → medium minimum |

### Integration: Policy Adapter

- **File:** `server/policy-engine/adapters/file-risk.js`
- **Pattern:** Same as `verification.js` and `architecture.js`
- **Registered** in the adapter list, called during `task_complete` policy evaluation

The adapter:
1. Reads `changed_files` from the policy evaluation context
2. Runs static pattern matching on each file path
3. Queries `task_file_changes` + `file_baselines` for change signals
4. Upserts results into `file_risk_scores`
5. Returns evidence: `{ type: 'file_risk_assessed', satisfied: true, high_risk_files: [...], medium_risk_files: [...], low_risk_files: [...] }`

### Integration: Finalizer Timing

Risk scoring must complete *before* the adversarial review stage checks scores. Two options:

**Option A (preferred):** Risk scoring runs as a pre-step inside the adversarial review stage. When that stage checks "should I activate?", it first triggers `scoreFiles(ctx.filesModified)` and then reads the results. This avoids adding a separate pipeline stage.

**Option B:** Separate finalizer stage before adversarial review. More explicit but adds another stage to an already long pipeline.

Going with **Option A** — the adversarial review stage calls `fileRisk.scoreFiles()` inline before making its trigger decision.

**Scoring guarantee regardless of adversarial review config:** The policy adapter (`file-risk.js`) runs at `task_complete` policy evaluation time for every task, regardless of whether adversarial review is enabled. This means `file_risk_scores` is always populated and `get_task_risk_summary` / `get_file_risk` always return current data — even when adversarial review is `'off'`. The adversarial review stage's inline call is an optimization (ensures scores exist before it checks them), not the only path.

### DB Module

- **File:** `server/db/file-risk.js`
- **Exports:** `createFileRisk(deps)` factory
- **Functions:**
  - `scoreFile(filePath, workingDirectory, taskId?)` — compute and upsert score
  - `scoreFiles(files[], workingDirectory, taskId?)` — batch score
  - `getFileRisk(filePath, workingDirectory)` — single file lookup
  - `getFilesAtRisk(workingDirectory, minLevel?)` — all files at or above a risk level
  - `getTaskRiskSummary(taskId)` — risk breakdown for files touched by a task
  - `setManualOverride(filePath, workingDirectory, riskLevel, reason)` — manual override

### MCP Tools

| Tool | Purpose |
|------|---------|
| `get_file_risk` | Score for a single file |
| `get_task_risk_summary` | All file scores for files touched by a task |
| `set_file_risk_override` | Manual override (sets `auto_scored = 0`) |
| `get_high_risk_files` | List all high-risk files in a project |

### Configuration

- **Always on** — scoring is cheap (pattern matching + DB lookups), non-blocking
- **Custom patterns:** `set_project_defaults({ file_risk_patterns: { high: [...], medium: [...] } })` to extend/override built-in rules per project
- Effects controlled by other modules (adversarial review `'auto'` mode, verification ledger)

---

## Cross-Module Data Flow

```
Task Completes
    │
    ▼
[verification_ledger stage]  ──→  INSERT verification_checks (phase: 'after')
    │                              (records all pipeline stage outcomes synchronously)
    ▼
[adversarial_review stage]
    │
    ├──→ scoreFiles() ──→ UPSERT file_risk_scores
    │
    ├──→ check risk_level for trigger decision
    │
    ├──→ (if triggered) spawn review task with risk context in prompt
    │     │
    │     └──→ [async — when review task completes, its own finalizer writes:]
    │            INSERT adversarial_reviews
    │            INSERT verification_checks (phase: 'review')  [if ledger enabled]
    │
    │     [blocking mode — waits inline, writes immediately, can fail the task]
    │
    ▼
[policy adapter: file-risk]  ──→  UPSERT file_risk_scores (runs at task_complete policy eval)
                                   return evidence for policy engine
                                   (this is the GUARANTEED scoring path — runs regardless of
                                    whether adversarial review is enabled)
```

## Ship Order

Each module can land independently. Recommended order:

1. **File Risk Tagging** — no dependencies, enables the other two
2. **Verification Ledger** — no dependencies, provides audit foundation
3. **Adversarial Review** — benefits from both (risk-based triggers, ledger integration) but works without them

## New Files Summary

| File | Module | Type |
|------|--------|------|
| `server/db/verification-ledger.js` | Ledger | DB module |
| `server/db/adversarial-reviews.js` | Adversarial | DB module |
| `server/db/file-risk.js` | Risk | DB module |
| `server/execution/verification-ledger-stage.js` | Ledger | Finalizer stage |
| `server/execution/adversarial-review-stage.js` | Adversarial | Finalizer stage |
| `server/policy-engine/adapters/file-risk.js` | Risk | Policy adapter |
| `server/tool-defs/evidence-risk-defs.js` | All | Tool definitions |
| `server/handlers/evidence-risk-handlers.js` | All | Tool handlers |

## Registration Checklist

For each module:
- [ ] DB module: export `create*` factory, register in `container.js`
- [ ] Schema: add CREATE TABLE + indexes to `schema-tables.js`
- [ ] Finalizer stage (if applicable): wire into `task-finalizer.js` via `deps`
- [ ] Policy adapter (if applicable): register in adapter list
- [ ] Tool defs: add to `tool-defs/`, spread into `tools.js` TOOLS array
- [ ] Handlers: add to `handlers/`, spread into `tools.js` HANDLER_MODULES
- [ ] Tool annotations: add entries to `tool-annotations.js`
- [ ] Cascade delete: add new tables to task delete cascade in `task-core.js`
- [ ] Retention: add to pruning schedule if applicable
- [ ] Project defaults: extend `set_project_defaults` / `get_project_defaults` for new config keys
