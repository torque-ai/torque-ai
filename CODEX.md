# TORQUE + Codex

This is the Codex-session companion to `CLAUDE.md`. Read `CLAUDE.md` first if you have time — it has the full operating doctrine (worktree workflow, restart barriers, routing templates, factory loop, governance, harness discipline). This file covers what Codex sessions need to know on top of that.

## MCP setup

Codex connects to TORQUE through the streamable HTTP MCP endpoint:

    [mcp_servers.torque]
    url = "http://127.0.0.1:3458/mcp"

TORQUE must already be running. The legacy `/sse` endpoint is still available for older MCP clients, but current Codex builds want a streamable HTTP `url` server, not `type = "sse"`.

## First action after connecting

Run `mcp__torque__unlock_all_tools {}` as your first TORQUE call so Codex sees the full catalog (~600 tools). Without it Codex starts in Tier 1 and tools like `smart_submit_task`, `task_info`, and the factory/workflow surface stay hidden. If you want a smaller set first, use `mcp__torque__unlock_tier { tier: 2 }`.

## Tool prefix and core surface

All TORQUE tools live under the `mcp__torque__` prefix. The names below are the most commonly used; everything else is discoverable via `mcp__torque__get_tool_schema`.

| Category | Tools |
|----------|-------|
| **Core** | `ping`, `restart_server`, `await_restart`, `unlock_tier`, `unlock_all_tools` |
| **Task** | `submit_task`, `smart_submit_task`, `task_info`, `await_task`, `cancel_task`, `list_tasks` |
| **Workflow** | `create_workflow`, `add_workflow_task`, `run_workflow`, `workflow_status`, `await_workflow` |
| **Automation** | `set_project_defaults`, `get_project_defaults`, `scan_project`, `submit_scout`, `create_diffusion_plan` |
| **Team / Factory** | `start_factory_loop`, `factory_status`, `approve_factory_gate`, `reject_factory_gate`, `trigger_architect` |

`task_info` is the canonical task-state read. Older Codex builds learned a `check_status` alias; current builds expose it as `task_info`. Use whichever your Codex resolves.

Examples:

    mcp__torque__smart_submit_task { task: "Implement input validation in src/api/routes.ts" }
    mcp__torque__submit_task { task: "Refactor helper", provider: "ollama", working_directory: "C:\\Users\\<os-user>\\Projects\\torque-public" }
    mcp__torque__task_info { task_id: "task-id" }
    mcp__torque__await_task { task_id: "task-id", heartbeat_minutes: 5 }
    mcp__torque__create_workflow { name: "feature-workflow", description: "Implement X" }
    mcp__torque__add_workflow_task { workflow_id: "wf-id", node_id: "types", task_description: "Define interfaces", provider: "codex-spark", depends_on: [] }
    mcp__torque__await_workflow { workflow_id: "wf-id", heartbeat_minutes: 5 }

## Restart barriers (do not kill processes)

TORQUE restart is a first-class queue primitive, not an external process kill. Use `restart_server` or `await_restart` to drain the queue, restart on updated code, and resume. Do **not** use `taskkill`, `Stop-Process`, PID-file kills, or any ad-hoc node termination — those bypass the drain and can corrupt in-flight task state.

Restart barriers can hold for a while: Codex/factory tasks routinely run 30-60 minutes, and `await_restart` is patient by design. Watch the heartbeat output; don't cancel or declare the barrier stuck unless task status shows a real stall or the user explicitly approves an override.

## Worktree workflow (mandatory for changes to TORQUE)

Never edit `main` directly. For any change to TORQUE itself — features, fixes, docs, config — create a feature worktree first:

    scripts/worktree-create.sh <feature-name>

Work inside `.worktrees/feat-<name>/` on branch `feat/<name>`. When done, merge through:

    scripts/worktree-cutover.sh <feature-name>

This merges to main, holds a restart barrier while the queue drains, restarts TORQUE on the new code, and cleans up the worktree. Docs-only changes can skip the restart but should still go through a worktree. A `PreToolUse` hook (`.claude/hooks/block-main-edit.js`) enforces this for Claude; Codex sessions should follow the same rule by convention.

Operations that mutate shared `main`/worktree state (cutovers, pre-push gates, apply-mode pruning) must hold the lease from `scripts/repo-coordination-lock.sh`. The standard scripts already do this; only relevant if you write new automation that touches branch refs.

## Remote workstation

Heavy commands (builds, tests, compilation) go through `torque-remote`:

    torque-remote npx vitest run tests/my-new-test.test.ts
    torque-remote npm run build
    torque-remote cargo build --release

`torque-remote` syncs the current worktree state to the remote, runs the command there, and cleans up. If the remote is unreachable it falls back to local execution. See `docs/torque-remote.md` for lane semantics, config layering, and exit codes.

## Provider selection

13 providers are wired. Smart routing picks the right one automatically; override with `provider: "<name>"` only when you know better than the router.

| Profile | Pick |
|---------|------|
| New file / greenfield code | `codex` |
| Precision single-file edits | `codex-spark` |
| Routine local edits, docs, config | `ollama` |
| Architectural decisions, complex debugging | `claude-cli` |
| Large-model reasoning, high concurrency | `deepinfra` or `hyperbolic` |
| Low-latency batch | `groq`, `cerebras` |
| Large context (>96K tokens) | `google-ai` |

`hashline-ollama` no longer exists — it was consolidated into `ollama` for routine edits and `codex-spark` for precision work. Update any old prompts you carry.

For the full provider table, routing templates (11 presets), task categories (10), and cloud-API setup, see `CLAUDE.md` "Providers" and `docs/routing-templates.md`.

## Workflow discipline

- Never manually implement what TORQUE should produce. Plan, submit, verify, integrate.
- For non-trivial work, submit a workflow with typed nodes and explicit `depends_on`, not a single fire-and-forget task.
- Always use heartbeat `await_task` / `await_workflow` for long-running work. Do not poll `task_info` in a loop.
- On TORQUE failure: diagnose → fix root cause → resubmit. Do not bypass by writing the feature work by hand.

## Available agent profiles

See `AGENTS.md` for the full agent surface. Quick reference:

- **task-reviewer** — review completed outputs, return APPROVE/FLAG verdicts
- **workflow-architect** — decompose features into `create_workflow` + `add_workflow_task` DAGs
- **batch-monitor** — monitor running workflows, stalls, failures

## Where to look next

- `CLAUDE.md` — full operating doctrine and reference
- `AGENTS.md` — agent profiles and durable change rules
- `docs/factory.md` — factory auto-pilot runbook
- `docs/routing-templates.md` — 11 routing presets and resolver precedence
- `docs/torque-remote.md` — remote-execution boundary, lanes, exit codes
- `docs/stall-and-retry.md` — stall detection, retry framework, fallback chains
- `docs/plugin-contract.md` — plugin contract surface and boot integration
