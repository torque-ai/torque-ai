# Workflows Guide

TORQUE workflows let you define task pipelines as directed acyclic graphs (DAGs), where tasks can depend on each other and execute in the correct order.

## Concepts

A **workflow** is a named collection of tasks with dependency relationships:

    ┌────────────┐     ┌────────────┐     ┌────────────┐
    │   Lint     │────▶│   Build    │────▶│   Deploy   │
    └────────────┘     └────────────┘     └────────────┘
           │                                    ▲
           │           ┌────────────┐           │
           └──────────▶│   Tests    │───────────┘
                       └────────────┘

- Tasks without dependencies start immediately when the workflow runs
- Tasks with dependencies wait until all dependencies complete successfully
- If a dependency fails, downstream tasks remain blocked

## Creating a Workflow

### Step 1: Create the Workflow

    create_workflow {
      name: "deploy-pipeline",
      description: "Build, test, and deploy the application"
    }

Returns a `workflow_id` for adding tasks.

### Step 2: Add Tasks

Tasks without dependencies start first:

    add_workflow_task {
      workflow_id: "<workflow-id>",
      task_description: "Run ESLint on all source files",
      working_directory: "/path/to/project"
    }

Tasks with dependencies wait for their prerequisites:

    add_workflow_task {
      workflow_id: "<workflow-id>",
      task_description: "Build the TypeScript project",
      working_directory: "/path/to/project",
      depends_on: ["<lint-task-id>"]
    }

    add_workflow_task {
      workflow_id: "<workflow-id>",
      task_description: "Run unit tests",
      working_directory: "/path/to/project",
      depends_on: ["<lint-task-id>"]
    }

    add_workflow_task {
      workflow_id: "<workflow-id>",
      task_description: "Deploy to staging",
      working_directory: "/path/to/project",
      depends_on: ["<build-task-id>", "<test-task-id>"]
    }

### Step 3: Run the Workflow

    run_workflow { workflow_id: "<workflow-id>" }

TORQUE automatically:
1. Starts tasks with no dependencies
2. Monitors completion of each task
3. Unblocks downstream tasks when dependencies complete
4. Marks the workflow as complete when all tasks finish

## Monitoring Workflows

### Status Overview

    workflow_status { workflow_id: "<workflow-id>" }

Shows each task's status (pending, blocked, running, completed, failed) and overall progress.

### Dependency Graph

    dependency_graph { workflow_id: "<workflow-id>" }

Produces a visual representation of the DAG showing task relationships.

### Critical Path

    critical_path { workflow_id: "<workflow-id>" }

Identifies the longest dependency chain — the sequence of tasks that determines the minimum total execution time.

### Blocked Tasks

    blocked_tasks { workflow_id: "<workflow-id>" }

Lists tasks that are waiting on incomplete dependencies, along with what they're waiting for.

### What-If Analysis

    what_if {
      workflow_id: "<workflow-id>",
      task_id: "<task-id>",
      simulated_status: "failed"
    }

Simulates what would happen if a task succeeds or fails, showing which downstream tasks would be affected.

## Handling Failures

When a task in a workflow fails:

1. **Downstream tasks remain blocked** — they won't start until the dependency is resolved
2. **The workflow enters a partial state** — some tasks complete, others stay blocked

### Skip a Failed Task

If the failed task isn't critical, skip it to unblock downstream:

    skip_task { task_id: "<failed-task-id>" }

Downstream tasks treat a skipped task as "completed" and proceed.

### Retry from a Failed Task

    retry_workflow_from {
      workflow_id: "<workflow-id>",
      task_id: "<failed-task-id>"
    }

Re-runs the failed task and all tasks downstream of it.

### Cancel an Entire Workflow

    cancel_workflow { workflow_id: "<workflow-id>" }

Cancels all running and queued tasks in the workflow.

### Pause

    pause_workflow { workflow_id: "<workflow-id>" }

Pauses all running tasks. Workflows cannot be resumed mid-run; if you cancel work with `cancel_task` or `cancel_workflow`, re-submit the cancelled tasks with `submit_task` or `smart_submit_task`.

## Workflow Specs

Workflow specs let you keep workflow DAGs in version-controlled YAML files.

List available specs:

    list_workflow_specs {
      working_directory: "/path/to/project"
    }

Validate a specific spec before running it:

    validate_workflow_spec {
      spec_path: "workflows/deploy.yaml",
      working_directory: "/path/to/project"
    }

Create and run a workflow directly from a spec:

    run_workflow_spec {
      spec_path: "workflows/deploy.yaml",
      goal: "Ship the next release candidate",
      working_directory: "/path/to/project"
    }

## Workflow Benchmarking

Run the same goal against multiple workflow variants and produce a comparison report.

    bench_workflow_specs {
      goal: "Ship the next release candidate",
      specs: [
        "workflows/deploy-default.yaml",
        "workflows/deploy-fast.yaml"
      ],
      runs_per_variant: 3,
      working_directory: "/path/to/project"
    }

For each spec x run combo, TORQUE:
1. Creates a fresh workflow from the spec
2. Waits for completion
3. Collects metrics (status, task counts, verify pass rate, cost, duration)
4. Computes a composite score (0-100)

After all runs finish, a Markdown report ranks variants by average score.

### Composite score weights

- Verify pass rate: 60%
- Cost (normalized 0-$5): 25%
- Duration (normalized 0-600s): 15%
- Status=`failed` or `cancelled`: score = 0

### When to use

- Before promoting a workflow variant to default
- When tuning routing templates or model stylesheets
- For provider comparisons by running the same workflow with different stylesheets

### Caveats

- Bench runs sequentially. Parallel runs would race for slots and skew cost and duration metrics.
- Each variant should produce comparable artifacts. Wildly different DAGs are not comparable on cost alone.

## Workflow Templates

Save workflow structures for reuse.

### Create a Template

    create_workflow_template {
      name: "ci-pipeline",
      description: "Standard CI pipeline",
      template: {
        tasks: [
          { node_id: "lint", description: "Run linting", depends_on: [] },
          { node_id: "test", description: "Run tests", depends_on: ["lint"] },
          { node_id: "build", description: "Build project", depends_on: ["lint"] },
          { node_id: "deploy", description: "Deploy", depends_on: ["test", "build"] }
        ]
      }
    }

### Use a Template

    instantiate_template {
      template_id: "<template-id>",
      working_directory: "/path/to/project"
    }

Creates a new workflow instance from the template with all tasks and dependencies pre-configured.

### List Templates

    list_workflow_templates {}

### Delete a Template

    delete_workflow_template { template_id: "<template-id>" }

## Advanced Features

### Fork and Merge

Split a workflow into parallel branches:

    fork_workflow {
      workflow_id: "<workflow-id>",
      fork_point_task_id: "<task-id>",
      branches: [
        { description: "Branch A: frontend tests" },
        { description: "Branch B: backend tests" }
      ]
    }

Merge branches back:

    merge_workflows {
      workflow_id: "<workflow-id>",
      merge_task_description: "Integration tests",
      merge_from_task_ids: ["<branch-a-id>", "<branch-b-id>"]
    }

### Replay a Task

Re-run a completed task with the same inputs:

    replay_task { task_id: "<task-id>" }

### Compare Runs

Compare two executions of the same task:

    diff_task_runs {
      task_id_a: "<first-run>",
      task_id_b: "<second-run>"
    }

### Conditional Templates

Create templates with conditions:

    create_conditional_template {
      name: "conditional-deploy",
      conditions: [
        { if: "test_passed", then: "deploy", else: "notify_failure" }
      ]
    }

### Loop Templates

Iterate a template over a list of values:

    template_loop {
      template_id: "<template-id>",
      iterate_over: ["service-a", "service-b", "service-c"],
      variable_name: "service"
    }

## Listing Workflows

    list_workflows {}
    list_workflows { status: "running" }
    list_workflows { status: "completed" }

### Workflow History

    workflow_history { workflow_id: "<workflow-id>" }

Shows the complete execution timeline with timestamps for each task.

## Using the Slash Command

The `/torque-workflow` command provides a convenient interface:

    /torque-workflow create deploy-pipeline
    /torque-workflow status <workflow-id>
    /torque-workflow list

## Patterns

### Sequential Pipeline

Tasks run one after another:

    A → B → C → D

Add each task with `depends_on` pointing to the previous task.

### Fan-Out / Fan-In

Multiple tasks run in parallel, then converge:

        ┌─ B ─┐
    A ──┤     ├── D
        └─ C ─┘

- B and C both depend on A
- D depends on both B and C

### Diamond

        ┌─ B ─┐
    A ──┤     ├── D
        └─ C ─┘

Same as fan-out/fan-in. TORQUE handles this naturally — D starts only when both B and C complete.

### Independent Parallel

Tasks with no dependencies all start simultaneously:

    A    B    C    D

Add all tasks without `depends_on` — they run in parallel up to the concurrency limit.

## Tools Reference

| Tool | Description |
|------|-------------|
| `create_workflow` | Create a new workflow |
| `add_workflow_task` | Add task with dependencies |
| `run_workflow` | Start workflow execution |
| `workflow_status` | Get workflow progress |
| `cancel_workflow` | Cancel all workflow tasks |
| `pause_workflow` | Pause workflow |
| `list_workflows` | List workflows |
| `workflow_history` | Execution timeline |
| `dependency_graph` | Visualize DAG |
| `critical_path` | Find longest path |
| `what_if` | Simulate scenarios |
| `blocked_tasks` | List blocked tasks |
| `skip_task` | Skip a task |
| `retry_workflow_from` | Retry from failure |
| `list_workflow_specs` | Discover workflow specs |
| `validate_workflow_spec` | Validate a workflow spec |
| `run_workflow_spec` | Create and run a spec-backed workflow |
| `bench_workflow_specs` | Benchmark multiple workflow specs |
| `create_workflow_template` | Create template |
| `instantiate_template` | Use template |
| `fork_workflow` | Branch into parallel |
| `merge_workflows` | Merge branches |
| `replay_task` | Re-run task |
| `diff_task_runs` | Compare runs |

## Resume / replay

If TORQUE restarts mid-workflow, all running workflows are automatically re-evaluated on startup:
- Tasks that are `blocked` and now have all dependencies satisfied → moved to `queued`
- Workflows where every task is terminal → finalized as `completed` or `failed`

To manually re-evaluate a stuck workflow:

    resume_workflow { workflow_id: "<workflow-id>" }

To re-evaluate every running workflow at once (e.g., after a long DB outage):

    resume_all_workflows {}

This is safe to call repeatedly — re-evaluation is idempotent.

## Conditional edges

Each dependency edge can have a `condition` — a boolean expression evaluated against the parent task's outcome and metadata. If the condition is false, the edge does not fire (the dependent task does not unblock via this edge).

If a dependent has multiple `depends_on` and all their conditions evaluate to false, the dependent is auto-`skipped`.

### Available context

| Key | Resolves to |
|---|---|
| `outcome` | `success` / `fail` / `cancelled` / `skipped` |
| `exit_code` | Process exit code (number) |
| `failure_class` | From Plan 4 — `transient_infra` / `deterministic` / etc. |
| `provider` | Provider that ran the parent task |
| `context.KEY` | Parent task's `metadata.KEY` (or `tags`, an array) |
| Bare key | Truthiness check |

### Operators

`=` `!=` `>` `<` `>=` `<=` `contains` `matches` `&&` `||` `!`

### Examples

    task: Run security scan

    task: Ship to staging
    depends_on: [scan]
    condition: "outcome=success"

    task: Notify human
    depends_on: [scan]
    condition: "outcome=fail"

### Error handling

A condition that fails to parse is treated as `false` (the edge doesn't fire) and a warning is logged. The workflow engine never crashes on a bad expression.
