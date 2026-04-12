# Findings: TaskWeaver

**Tagline:** The first "code-first" agent framework for seamlessly planning and executing data analytics tasks.
**Stars:** 6.1k (GitHub, 2026-04-11)
**Language:** Python (96.4%)

## Feature 1: Planner-Centered Role Topology
**What it does:** TaskWeaver runs roles in a star topology: the user talks to the Planner, and the Planner delegates to peripheral roles such as CodeInterpreter. Roles keep their own history, and new roles can be added by implementing a `Role` plus YAML config.
**Why distinctive:** It imposes a clear orchestration boundary between planning and specialist execution instead of relying on one monolithic agent loop.
**TORQUE relevance:** HIGH - TORQUE already has workflows and multi-provider routing; a planner-centered role layer could make reusable workflow templates and specialist agents easier to reason about.

## Feature 2: Code-First Stateful Execution
**What it does:** TaskWeaver always turns requests into code, executes that code through a Jupyter kernel, and preserves both chat history and execution history, including in-memory data such as DataFrames.
**Why distinctive:** The runtime is built around live program state rather than text-only tool outputs, which makes iterative analysis and multi-step automation more expressive.
**TORQUE relevance:** MEDIUM - TORQUE is broader than notebook-style automation, but stateful execution contexts could help longer technical workflows that need to carry structured artifacts across steps.

## Feature 3: Plugin Functions as Orchestratable Units
**What it does:** Plugins are Python functions with YAML schemas that the CodeInterpreter can call inside generated code. Plugins can also emit artifacts into the workspace for later use.
**Why distinctive:** This blends tool use and code generation in one execution surface, so the agent can compose domain functions inside a single stateful program instead of only issuing isolated tool calls.
**TORQUE relevance:** HIGH - TORQUE already has MCP tools; TaskWeaver's plugin model is a strong reference for schema-rich, artifact-producing worker capabilities inside a workflow run.

## Feature 4: Shared Memory and Experience Memory
**What it does:** TaskWeaver separates role-local conversation history from shared memory entries that can persist for a round or a whole conversation. It also lets users save successful chats into an experience pool and retrieve similar tips into future planning and code-generation prompts.
**Why distinctive:** It gives the system both controlled cross-role state and a lightweight long-term learning loop without fine-tuning.
**TORQUE relevance:** HIGH - TORQUE could use this pattern for workflow-scoped shared state plus reusable "what worked last time" guidance across providers, retries, and verify/fix loops.

## Feature 5: Guardrailed Execution With Tracing
**What it does:** TaskWeaver can verify generated code before execution using prompt rules plus AST checks for allowed modules and blocked functions. It defaults to containerized execution and exposes OpenTelemetry traces for role interactions, prompts, tokens, errors, and critical-path timing.
**Why distinctive:** Safety, verification, and observability are part of the runtime design, not afterthoughts bolted on around the agent.
**TORQUE relevance:** HIGH - This maps directly to TORQUE's verify gates, MCP/tool governance, and dashboard ambitions; the tracing model is especially relevant for diagnosing workflow bottlenecks and unsafe actions.

## Verdict
TaskWeaver is most valuable as a reference architecture, not as a drop-in model for TORQUE. Its strongest ideas for TORQUE are planner-centered role orchestration, shared/experience memory, and guardrailed execution with first-class tracing. The main mismatch is that TaskWeaver is centered on code-interpreter-style data workflows, while TORQUE is a broader software factory orchestrator. Also note the repo was archived and made read-only on March 23, 2026, so it is better treated as a design source than an active dependency target.
