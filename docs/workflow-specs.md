# Workflow Specs

Workflow specs are version-controlled YAML files that define a TORQUE workflow as a DAG of tasks. Keep concrete specs in `workflows/` and reusable bases in `workflows/templates/`.

## Quick start

1. Create `workflows/my-workflow.yaml`:

    version: 1
    name: my-workflow
    description: What this workflow does
    project: torque
    tasks:
      - node_id: plan
        task: Write a plan to docs/superpowers/plans/foo.md
        provider: claude-cli
      - node_id: implement
        task: Read the plan and execute it
        provider: codex
        depends_on: [plan]

2. Validate the spec with the workflow-spec tooling used by your host or automation entrypoint.

3. Keep shared pipeline shapes in `workflows/templates/` and extend them from concrete specs.

## Schema

| Field (top level) | Type | Required | Description |
|---|---|---|---|
| `version` | int | yes | Schema version. Always `1`. |
| `name` | string | yes | Workflow name (1-200 chars). |
| `description` | string | no | What the workflow does. |
| `project` | string | no | Project name inherited by tasks. |
| `working_directory` | string | no | Default working directory for tasks. |
| `routing_template` | string | no | Named routing template to apply by default. |
| `version_intent` | enum | no | `feature` / `fix` / `breaking` / `internal`. |
| `priority` | number | no | Queue priority for the workflow. |
| `extends` | string | no | Relative or absolute path to a base workflow spec. |
| `tasks` | array | yes | Task definitions (see below). |

| Field (per task) | Type | Required | Description |
|---|---|---|---|
| `node_id` | string | yes | Unique task identifier within the workflow. |
| `task` | string | yes, unless `__remove: true` | Task prompt / description. |
| `depends_on` | [string] | no | Node IDs this task depends on. |
| `context_from` | [string] | no | Node IDs whose outputs should be injected as context. |
| `provider` | enum | no | Explicit provider override. |
| `model` | string | no | Model override. |
| `tags` | [string] | no | Free-form tags. |
| `timeout_minutes` | int | no | Timeout from 1 to 480 minutes. |
| `auto_approve` | bool | no | Skip approval gates. |
| `version_intent` | enum | no | Override workflow-level intent for this task. |
| `on_fail` | enum | no | `cancel` / `skip` / `continue` / `run_alternate`. |
| `alternate_node_id` | string | no | Alternate node to run when `on_fail: run_alternate`. |
| `condition` | string | no | Dependency condition expression. |
| `goal_gate` | bool | no | Marks a non-bypassable quality gate for the workflow. |
| `__remove` | bool | no | Only used in child specs to remove an inherited task. |

## Why use specs instead of inline workflows?

- `git diff` shows workflow changes directly.
- Specs can be reviewed in pull requests like application code.
- Shared templates reduce copy-paste across similar factories.
- Releases preserve the exact workflow shape that shipped.

Workflows built inline through runtime-only APIs are ephemeral. Specs are the right shape for workflows you want to keep, review, and reuse.

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
        task: Write a step-by-step plan to docs/superpowers/plans/auto-plan.md.
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
          Write a step-by-step plan to docs/superpowers/plans/auto-plan.md.

All other tasks are inherited unchanged from the base template.

### Removing an inherited task

    version: 1
    name: feature-without-ship
    extends: templates/feature-pipeline.yaml
    tasks:
      - node_id: ship
        __remove: true
