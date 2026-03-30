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
  - mcp__torque__get_adversarial_reviews
  - mcp__torque__request_adversarial_review
  - mcp__torque__await_task
  - mcp__torque__submit_task
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

If task metadata includes `adversarial_review_pending: true`, warn the user that an adversarial review is still in progress and they should wait for it to complete before making a final approval or rejection decision.

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

    ## Review: [Task ID] - [Brief description]

    **Provider:** [local/cloud] | **Model:** [model] | **Quality:** [score]/100

    ### Output Summary
    [Summarize what the task produced - key changes, files modified]

    ### Validation
    [List any issues found, or "No issues detected"]

    ### Baseline Comparison
    [File size changes, truncation warnings, or "Within normal range"]

    ### Build Check
    [Pass/Fail/Skipped]

7. **Adversarial Review Check**:
   1. Call `get_adversarial_reviews` with the task ID.
   2. If task metadata has `adversarial_review_pending: true`, warn the user that the adversarial review is still in progress and they should wait for it to complete before making a final decision.
      - If `adversarial_review_task_id` exists, call `await_task` on that task ID, then re-run `get_adversarial_reviews`.
      - If no `adversarial_review_task_id` exists, report the review as blocked metadata and do not present the task as fully ready for approval.
   3. If reviews exist, present them in a structured format:
      - **Verdict:** `approve` / `concerns` / `reject`
      - **Confidence:** `high` / `medium` / `low`
      - **Issues found:** table with `file`, `line`, `severity`, `category`, `description`, `suggestion`

      Example format:

          - Verdict: approve | concerns | reject
          - Confidence: high | medium | low
          - Issues found:
          | file | line | severity | category | description | suggestion |
          | --- | --- | --- | --- | --- | --- |
          | [file] | [line] | [severity] | [category] | [description] | [suggestion] |

   4. If the verdict is `reject`, recommend rolling back with `rollback_task` or submitting a fix task before re-review.
   5. If the verdict is `concerns`, present the issues and ask the user whether to proceed.
   6. If no adversarial review exists but the task modified high-risk files, suggest running one and call `request_adversarial_review` with the `task_id` and `working_directory`.
   7. If no adversarial review exists and the task is not high-risk, continue to the final decision without adversarial feedback.

8. **Decision**: Ask user via AskUserQuestion:
   - **Approve** — accept the output, mark task approved
   - **Reject** — reject with reason, optionally rollback
   - **Retry** — reject and resubmit to a different provider
   - **Skip** — move to next task without deciding

9. Execute the decision:
   - Approve: call `approve_task`
   - Reject: call `reject_task` with the reason. If user wants rollback, call `rollback_task`.
   - Retry: call `reject_task`, then resubmit via `smart_submit_task` with `override_provider` set to an alternative

After writing, verify the file exists.
