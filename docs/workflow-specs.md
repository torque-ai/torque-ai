# Workflow Specs

Workflow specs are version-controlled YAML files that define a TORQUE workflow as a DAG of tasks. Commit concrete specs in `<project>/workflows/`, keep reusable bases in `<project>/workflows/templates/`, and run them by name or path from your host or automation entrypoint.

## Quick start

1. Create `workflows/my-workflow.yaml`:

    version: 1
    name: my-workflow
    description: What this workflow does
    tasks:
      - node_id: plan
        task: Write a plan to docs/plans/foo.md
        provider: claude-cli
      - node_id: implement
        task: Read the plan and execute it
        provider: codex
        depends_on: [plan]

2. Run it:

    # via MCP (Claude Code, etc.)
    run_workflow_spec { spec_path: "workflows/my-workflow.yaml" }

    # via REST
    curl -X POST http://127.0.0.1:3457/api/v2/workflow-specs/run \
      -H 'Content-Type: application/json' \
      -d '{"spec_path": "workflows/my-workflow.yaml"}'

3. Browse the **Workflow Specs** page in the dashboard to see all discovered specs.

## Schema

| Field (top level) | Type | Required | Description |
|---|---|---|---|
| `version` | int | yes | Schema version. Always `1`. |
| `name` | string | yes | Workflow name (1-200 chars). |
| `description` | string | no | What the workflow does. |
| `project` | string | no | Project name. Tasks inherit it. |
| `working_directory` | string | no | Default working directory. |
| `routing_template` | string | no | Named routing template. |
| `version_intent` | enum | no | `feature` / `fix` / `breaking` / `internal`. |
| `priority` | number | no | Queue priority. |
| `extends` | string | no | Relative or absolute path to a base workflow spec. |
| `tasks` | array | yes | Task definitions (see below). |

| Field (per task) | Type | Required | Description |
|---|---|---|---|
| `node_id` | string | yes | Unique within the workflow. |
| `task` | string | yes, unless `kind: crew` or `__remove: true` | Task description / prompt. |
| `kind` | enum | no | `agent`, `parallel_fanout`, `merge`, or `crew`. |
| `crew` | object | yes, when `kind: crew` | Crew objective, roles, mode, rounds, and output schema. |
| `depends_on` | [string] | no | Node IDs this task depends on. |
| `context_from` | [string] | no | Node IDs whose outputs to inject. |
| `provider` | enum | no | Explicit provider override. |
| `model` | string | no | Model override. |
| `tags` | [string] | no | Free-form tags. |
| `timeout_minutes` | int | no | 1-480. |
| `auto_approve` | bool | no | Skip approval gates. |
| `version_intent` | enum | no | Override workflow-level intent. |
| `on_fail` | enum | no | `cancel` / `skip` / `continue` / `run_alternate`. |
| `alternate_node_id` | string | no | For `run_alternate`. |
| `condition` | string | no | Edge condition expression. |
| `goal_gate` | bool | no | Marks a non-bypassable quality gate for the workflow. |
| `__remove` | bool | no | Only used in child specs to remove an inherited task. |

## Why use specs instead of `create_workflow`?

- **Diffable** - `git diff workflows/deploy.yaml` shows exactly what changed.
- **Reviewable** - PR reviews catch workflow changes like any other code change.
- **Shareable** - Hand someone a spec, they get the same workflow you have.
- **Versioned** - Tag a release, the workflow as of that release is preserved.

Workflows built inline via `create_workflow` are ephemeral. They exist only in the DB. Specs are the right shape for workflows you want to keep.

## Templates and inheritance

A spec can `extends:` another spec, inheriting its tasks and top-level fields. This is useful for sharing factory pipelines such as plan -> implement -> verify -> ship across many concrete workflows.

### Merge semantics

- Top-level fields: child wins. The merge is shallow, so a child field replaces the base field.
- Tasks: merged by `node_id`. Child fields override base fields per task. New `node_id` values in the child are appended in child order.
- Remove a base task: include `node_id: x` with `__remove: true` in the child.

### Cycle detection and depth limit

Extends chains are limited to 8 levels deep. Cycles are detected and rejected with a clear error.

### Example

    # workflows/templates/feature-pipeline.yaml
    version: 1
    name: feature-pipeline-base
    description: Plan -> implement -> verify -> ship.
    project: torque
    version_intent: feature
    tasks:
      - node_id: plan
        task: Write a step-by-step plan to docs/plans/auto-plan.md.
        provider: claude-cli
      - node_id: implement
        task: Read the plan and execute it.
        provider: codex
        depends_on: [plan]
      - node_id: verify
        task: Run the project verify command and confirm everything passes.
        provider: codex
        depends_on: [implement]
        goal_gate: true
      - node_id: ship
        task: Push to origin/main and produce a one-line summary.
        provider: codex
        depends_on: [verify]

    # workflows/example-extends-feature.yaml
    version: 1
    name: example-extends-feature
    description: Concrete example showing how to extend the feature-pipeline template.
    extends: templates/feature-pipeline.yaml
    tasks:
      - node_id: plan
        task: |
          Implement a placeholder /api/v2/health endpoint that returns { status: "ok" }.
          Write a step-by-step plan to docs/plans/auto-plan.md.

All other tasks are inherited unchanged from the base template.

### Removing an inherited task

    version: 1
    name: feature-without-ship
    extends: templates/feature-pipeline.yaml
    tasks:
      - node_id: ship
        __remove: true
