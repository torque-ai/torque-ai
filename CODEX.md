# TORQUE + Codex

## Setup

TORQUE connects via MCP SSE. Point your Codex MCP config at the running TORQUE instance:

    [mcp.torque]
    type = "sse"
    url = "http://127.0.0.1:3458/sse"

TORQUE must be running first. The MCP config injector auto-configures Claude Code on startup, but Codex requires manual config.

TORQUE orchestrates AI work in Codex through multi-provider routing, queued execution, DAG workflows, and quality gates.

## MCP usage

All TORQUE tools are under the `mcp__torque__` prefix.

Core command names:
submit_task, smart_submit_task, check_status, await_task, create_workflow, add_workflow_task, run_workflow, await_workflow, list_tasks, task_info, set_project_defaults, workflow_status.

`check_status` maps to task status retrieval (`task_info` in current MCP builds).

Examples:

    mcp__torque__smart_submit_task { task: "Implement input validation in src/api/routes.ts" }
    mcp__torque__submit_task { task: "Refactor helper", provider: "ollama", working_directory: "C:\\Users\\<os-user>\\Projects\\torque-public" }
    mcp__torque__check_status { task_id: "task-id" }
    mcp__torque__task_info { task_id: "task-id" }
    mcp__torque__create_workflow { name: "feature-workflow", description: "Implement X" }
    mcp__torque__add_workflow_task { workflow_id: "wf-id", node_id: "types", task_description: "Define interfaces", provider: "hashline-ollama", depends_on: [] }
    mcp__torque__await_task { task_id: "task-id", heartbeat_minutes: 5 }
    mcp__torque__await_workflow { workflow_id: "wf-id", heartbeat_minutes: 5 }

## Remote workstation

Heavy commands must go through `torque-remote`.

    torque-remote npx vitest run tests/my-new-test.test.ts
    torque-remote npm run build
    torque-remote cargo build --release

## Workflow discipline

- Never manually implement what TORQUE should produce.
- If the work is non-trivial, submit as a workflow with typed nodes and explicit dependencies.
- Always use heartbeat awaits for long-running tasks/workflows.

## Available agents

See [AGENTS.md](/C:\Users\<user>\Projects\torque-public\AGENTS.md).

- task-reviewer: review completed outputs, return APPROVE/FLAG
- workflow-architect: decompose features into `create_workflow` + `add_workflow_task` DAGs
- batch-monitor: monitor running workflows, stalls, and failures

## Provider capability matrix

Use provider/model defaults by task type:

- New file creation / greenfield: `codex`
- Routine edits: `ollama`
- Precision edits / deterministic text work: `hashline-ollama`