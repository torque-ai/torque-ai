# Sub-Workflows as Callable Tools

A workflow spec can declare sub-workflows that become callable MCP tools inside parent tasks:

    version: 1
    name: parent-pipeline
    sub_workflows:
      run_lint: workflows/sub/lint.yaml
      run_security_scan: workflows/sub/security.yaml
    tasks:
      - node_id: implement
        task: |
          Implement the feature. After making changes, call_subworkflow_run_lint
          to lint, then call_subworkflow_run_security_scan to scan.
        provider: claude-cli

The sub-workflows are registered as `call_subworkflow_run_lint` and `call_subworkflow_run_security_scan` for the duration of the parent workflow.

## Calling from a task

The agent inside `implement` calls these tools the same way it calls any MCP tool. The call returns `{ workflow_id }`; the parent agent can then use `await_workflow` to wait for the sub-workflow to finish.

## Parameters

Sub-workflow specs can use `{{ params.KEY }}` in task descriptions. Pass them at call time:

    call_subworkflow_run_lint { params: { target_path: "src/" } }

## Isolation

Each sub-workflow runs as a separate workflow record with its own DAG, retries, and verify gates. The `parent_task_id` is stored in `workflow.context.parent_task_id` for traceability.

## Lifecycle

Sub-workflow tool registrations are cleaned up automatically when the parent workflow finalizes.
