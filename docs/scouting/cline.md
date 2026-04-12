# Findings: Cline

**Tagline:** Autonomous coding agent right in your IDE.
**Stars:** 60.2k
**Language:** TypeScript

## Feature 1: Plan and Act split
**What it does:** Cline separates planning from execution. Plan mode can inspect the codebase and shape an approach without changing files or running commands, while Act mode carries that context forward and performs the work. Docs also describe `/deep-planning` and separate model selection for each mode.
**Why distinctive:** This is a real two-phase operating model, not just a prompt convention. It creates an explicit handoff from reasoning to execution and lets users pay for strong planning only when the task needs it.
**TORQUE relevance:** HIGH - TORQUE already has provider routing and workflow steps, so a first-class plan/apply split would fit naturally and make multi-provider orchestration more deliberate.

## Feature 2: Markdown workflows as reusable automation
**What it does:** Cline workflows are markdown files that define repeatable multi-step procedures and are invoked with slash commands like `/deploy.md`. The docs also note that Cline can generate a workflow from a completed task so one-off agent work becomes reusable automation.
**Why distinctive:** The workflow artifact is plain markdown stored either globally or in the repo, which keeps automation editable, reviewable, and close to the work instead of hiding it behind UI-only configuration.
**TORQUE relevance:** HIGH - TORQUE is already workflow-centric. The main takeaway is the lightweight authoring model: markdown-backed workflows as a fast intake layer for repeatable ops, checklists, and task templates.

## Feature 3: Hooks as deterministic lifecycle guardrails
**What it does:** Hooks run at defined lifecycle points such as `TaskStart`, `PreToolUse`, `PostToolUse`, `TaskComplete`, and `PreCompact`. They can block actions, inject context, trigger external systems, and log analytics or compliance data.
**Why distinctive:** Cline treats hooks as a way to impose deterministic controls on a non-deterministic agent loop. That is stronger than passive logging because the hook can actively shape or stop execution.
**TORQUE relevance:** HIGH - TORQUE already has verify gates and approval concepts. Hook-style lifecycle interception would strengthen policy enforcement, telemetry capture, and pre/post-tool governance across workflows.

## Feature 4: Checkpoints that preserve conversation while rolling back code
**What it does:** Cline saves a checkpoint after each tool use in a shadow Git repository, then lets users compare or restore files, task state, or both. The conversation context can survive even when code changes are reverted.
**Why distinctive:** It lowers the cost of autonomy. Instead of forcing users to review every intermediate step, it makes aggressive execution safer because rollback is built into the task loop itself.
**TORQUE relevance:** HIGH - TORQUE has verify gates, but checkpointed rollback would make longer autonomous runs safer, especially for auto-approved steps, retries, and experimental branches of a workflow.

## Feature 5: MCP-native tool expansion
**What it does:** Cline can use MCP servers, install them from a marketplace, and even help build new servers from natural-language requests. The README frames this as "add a tool that..." and the docs position MCP as a standard interface for external tools, resources, and prompts.
**Why distinctive:** Cline does not treat external integrations as fixed product features. It treats tool creation itself as part of the agent workflow, which turns missing capabilities into buildable surface area.
**TORQUE relevance:** MEDIUM - TORQUE already has strong MCP tooling, so this is less novel architecturally. The useful takeaway is product UX: make MCP discovery, setup, and custom tool creation feel like a normal workflow action instead of a separate integration project.

## Verdict
Cline is most interesting to TORQUE where it turns agent behavior into explicit workflow primitives: plan vs act, markdown workflows, hooks, and checkpoints. MCP support overlaps with TORQUE's existing strengths, but Cline shows a cleaner end-user packaging of extensibility and safety that would translate well to TORQUE's orchestration dashboard and verify-gated runtime.
