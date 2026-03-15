---
name: torque-review
description: Review completed TORQUE task output — validate, approve, or reject
argument-hint: "[task-id | 'all']"
allowed-tools:
  - mcp__torque__get_result
  - mcp__torque__list_tasks
  - mcp__torque__validate_task_output
  - mcp__torque__get_validation_results
  - mcp__torque__get_quality_score
  - mcp__torque__run_build_check
  - mcp__torque__run_syntax_check
  - mcp__torque__approve_task
  - mcp__torque__reject_task
  - mcp__torque__list_pending_approvals
  - mcp__torque__compare_file_baseline
  - mcp__torque__rollback_task
  - Read
  - Glob
  - AskUserQuestion
---

# TORQUE Review

Review completed task output with validation, quality scoring, and approval.

## Instructions

### Determine which tasks to review

- If task ID provided ($ARGUMENTS): review that single task
- If "all": call `list_tasks` with `status="completed"` and review each unreviewed task
- If no argument: call `list_pending_approvals` first, then `list_tasks` with `status="completed"` to find unreviewed work

### For each task to review:

1. **Get output**: Call `get_result` with the task ID. Read the full output.

2. **Validate**: Call `validate_task_output` with the task ID. This checks for stub implementations, empty methods, truncated files, and other quality issues.

3. **Quality score**: Call `get_quality_score` with the task ID.

4. **Baseline comparison**: Call `compare_file_baseline` for files the task modified to detect truncation or unexpected size changes.

5. **Build check** (if task produced code): Call `run_build_check` to verify the output compiles.

6. **Present findings**:

```
## Review: [Task ID] — [Brief description]

**Provider:** [local/cloud] | **Model:** [model] | **Quality:** [score]/100

### Output Summary
[Summarize what the task produced — key changes, files modified]

### Validation
[List any issues found, or "No issues detected"]

### Baseline Comparison
[File size changes, truncation warnings, or "Within normal range"]

### Build Check
[Pass/Fail/Skipped]
```

7. **Decision**: Ask user via AskUserQuestion:
   - **Approve** — accept the output, mark task approved
   - **Reject** — reject with reason, optionally rollback
   - **Retry** — reject and resubmit to a different provider
   - **Skip** — move to next task without deciding

8. Execute the decision:
   - Approve: call `approve_task`
   - Reject: call `reject_task` with the reason. If user wants rollback, call `rollback_task`.
   - Retry: call `reject_task`, then resubmit via `smart_submit_task` with `override_provider` set to an alternative

After writing, verify the file exists.
