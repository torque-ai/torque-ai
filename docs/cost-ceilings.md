# Cost Ceilings

Workflows support optional `cost_ceiling_usd` and `task_count_ceiling` parameters
that cap unattended spend. When either ceiling is breached after a task completes,
remaining queued and pending tasks are cancelled and the workflow is marked `failed`
with `failure_class: budget_exhausted`.

## Usage

Set ceilings when creating a workflow via the `create_workflow` MCP tool:

    create_workflow {
      name: "feature-x",
      cost_ceiling_usd: 5.00,
      task_count_ceiling: 20
    }

Both parameters are optional. When omitted, no ceiling is enforced for that
dimension. Values must be positive finite numbers; zero or negative values are
treated as absent.

Ceilings are stored as direct columns on the `workflows` table
(`cost_ceiling_usd`, `task_count_ceiling`). For backwards compatibility the
enforcement logic also checks the `context` JSON column as a fallback.

## How It Works

The enforcement point is `resumeWorkflow` in
`server/execution/workflow-resume.js`. After each task reaches a terminal
status, the resume loop calls `checkWorkflowCostCeiling` from
`server/execution/cost-ceiling.js` to evaluate whether either ceiling has been
breached.

If a ceiling is exceeded, `failWorkflowBudgetExhausted` (also in
`server/execution/cost-ceiling.js`) performs two operations:

1. Sets the workflow status to `failed` and writes `failure_class:
   budget_exhausted` into the workflow's `context` JSON, along with the reason
   and timestamp.
2. Cancels all remaining tasks with `status IN ('queued', 'pending')` belonging
   to that workflow, setting their result to `"Budget ceiling exceeded"`.

If the ceiling is not breached, the resume loop proceeds normally — unblocking
dependent tasks and finalizing the workflow when all tasks are terminal.

## Provider Cost Classification

TORQUE distinguishes two provider cost models, defined in
`server/execution/cost-ceiling.js`:

- **API-priced (metered)** — providers billed per token via cloud API pricing.
  Their accumulated USD cost from `token_usage` records is checked against
  `cost_ceiling_usd`.
- **Subscription** — providers charged via a flat monthly subscription (codex,
  codex-spark, claude-cli, claude-code-sdk, claude-ollama). Their per-token
  cost is effectively $0 so the USD ceiling is irrelevant, but each
  completed or failed task on a subscription provider counts against
  `task_count_ceiling`.

The `isSubscriptionProvider` function in `server/execution/cost-ceiling.js`
classifies a provider string. The `SUBSCRIPTION_PROVIDERS` set is the
authoritative list.

Factory-level cost metrics in `server/factory/cost-metrics.js` track per-project
spend across cycles, provider efficiency, and cost-per-health-point — these are
observability tools and do not enforce ceilings.

## Monitoring

The `workflow_status` tool returns current cost data alongside the workflow
state. The cost summary includes:

- `api_cost_usd` — accumulated API-priced provider cost in USD.
- `subscription_task_count` — count of completed/failed tasks on subscription
  providers.
- `cost_ceiling_usd` — the configured USD ceiling (or `null`).
- `task_count_ceiling` — the configured task-count ceiling (or `null`).
- `exceeded` — boolean indicating whether any ceiling was breached.

## Source Files

| File | Role |
|------|------|
| `server/execution/cost-ceiling.js` | Core logic — ceiling checks, provider classification, workflow failure |
| `server/execution/workflow-resume.js` | Enforcement point — calls ceiling check during task promotion |
| `server/factory/cost-metrics.js` | Factory cost observability — per-project spend tracking |
| `server/handlers/workflow/index.js` | MCP tool wiring — accepts ceiling params in `create_workflow` |
