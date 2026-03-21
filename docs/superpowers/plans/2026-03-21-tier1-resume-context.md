# Structured Resume Context for Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** When a task fails and is retried, provide the retry agent with rich structured context from the failed attempt -- not just the error output.

**Architecture:** After task failure, extract structured context from the captured output: files modified, commands run, progress made, error details, and approach taken. Store as `resume_context` JSON on the task record. When retry tasks are created (by stall recovery, auto-verify-retry, or manual resubmit), inject this context into the retry prompt preamble.

**Tech Stack:** Existing task output capture, existing retry/resubmit flows

**Inspired by:** agent-orchestrator (buildResumeContext with last 20 structured messages), Gobby (TranscriptAnalyzer with goal/files/decisions extraction)

---

### Task 1: ResumeContextBuilder module

**Files:**
- Create: `server/utils/resume-context.js`
- Test: `server/tests/resume-context.test.js`

Functions:
- `buildResumeContext(taskOutput, errorOutput, metadata)` -- returns structured JSON:
  - `goal` -- original task description (from metadata)
  - `filesModified` -- extracted from output (Wrote, Created, Modified patterns)
  - `commandsRun` -- extracted from output ($ prefix, npx, git patterns)
  - `progressSummary` -- last 500 chars of stdout before error
  - `errorDetails` -- last 1000 chars of error output
  - `approachTaken` -- first 500 chars of output (usually shows the agent's plan)
  - `durationMs` -- how long the attempt ran
  - `provider` -- which provider attempted it

- `formatResumeContextForPrompt(resumeContext)` -- converts JSON to a markdown preamble:
  ```
  ## Previous Attempt (failed)
  **Provider:** codex | **Duration:** 45s
  **Files modified:** src/foo.ts, src/bar.ts
  **Progress:** [summary]
  **Error:** [details]
  **Approach taken:** [summary]
  Do not repeat the same approach. Fix the error and complete the task.
  ```

- [ ] Step 1: Write failing tests for buildResumeContext (parse files, commands, truncation)
- [ ] Step 2: Implement resume-context.js
- [ ] Step 3: Write failing tests for formatResumeContextForPrompt
- [ ] Step 4: Implement formatter
- [ ] Step 5: Run tests
- [ ] Step 6: Commit

---

### Task 2: Store resume_context on failed tasks

**Files:**
- Modify: `server/handlers/task/pipeline.js` -- compute and store resume_context on failure
- Modify: `server/db/schema-tables.js` -- add resume_context column to tasks table if not exists

- [ ] Step 1: Add resume_context TEXT column to tasks table
- [ ] Step 2: In task finalization, when status is failed, call buildResumeContext and store as JSON
- [ ] Step 3: Write test -- failed task has resume_context populated
- [ ] Step 4: Run tests
- [ ] Step 5: Commit

---

### Task 3: Inject resume context into retry prompts

**Files:**
- Modify: `server/validation/auto-verify-retry.js` -- prepend resume context to fix task prompt
- Modify: `server/db/provider-routing-core.js` -- prepend resume context on stall-recovery resubmit
- Modify: `server/handlers/task/operations.js` -- prepend resume context on manual resubmit

- [ ] Step 1: In auto-verify-retry fix task creation, read resume_context from failed task, format with formatResumeContextForPrompt, prepend to fix task description
- [ ] Step 2: In stall-recovery resubmit path, do the same
- [ ] Step 3: In manual resubmit (cancel + requeue), do the same
- [ ] Step 4: Write integration test -- retry task description starts with "## Previous Attempt"
- [ ] Step 5: Run tests
- [ ] Step 6: Commit
