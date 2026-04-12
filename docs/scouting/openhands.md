# Findings: OpenHands

**Tagline:** AI-Driven Development.
**Stars:** 68.9k
**Language:** Python

## Feature 1: Workspace-swappable execution
**What it does:** OpenHands lets the same agent code run against `LocalWorkspace`, Docker-backed workspaces, or remote API workspaces. The conversation and agent APIs stay the same while only the workspace type changes.
**Why distinctive:** It treats isolation as a first-class runtime choice instead of baking sandbox assumptions into the agent loop, which makes local prototyping and production deployment share one control surface.
**TORQUE relevance:** HIGH - TORQUE already routes work across providers; adding a first-class workspace layer would let workflows move between local runners, isolated containers, and remote agents without changing task logic.

## Feature 2: Typed append-only event backbone
**What it does:** OpenHands models execution as immutable typed events for messages, tool calls, observations, state updates, pauses, errors, and condensation summaries. That event log is both the agent's memory and the integration surface for persistence, visualization, stuck detection, and secret handling.
**Why distinctive:** The event stream is not just logging. It is the core orchestration boundary, so replay, resume, visualization, and sidecar services all compose cleanly without mutating runtime state.
**TORQUE relevance:** HIGH - TORQUE's dashboard, workflow runtime, postmortems, and verify gates would benefit from an immutable per-task event model instead of relying on scattered task output and ad hoc status metadata.

## Feature 3: Built-in context condenser
**What it does:** OpenHands can automatically condense older conversation history into summary events once the context exceeds a configured threshold, while preserving recent turns and key anchor messages. The default `LLMSummarizingCondenser` is designed to cut token cost and keep long-running sessions usable.
**Why distinctive:** Context compaction is part of the runtime model rather than a prompt hack. Condensation shows up in the event history, can use a separate cheaper LLM, and preserves continuity explicitly.
**TORQUE relevance:** HIGH - Long-running TORQUE tasks, scout sessions, and workflow handoffs would become cheaper and more stable if prior execution history could be summarized into durable machine-readable checkpoints before routing to the next model.

## Feature 4: Inline security risk classification with confirmation policies
**What it does:** OpenHands adds a `security_risk` field to tool schemas, has the LLM assign LOW/MEDIUM/HIGH/UNKNOWN risk during tool generation, and then applies policies such as `AlwaysConfirm`, `NeverConfirm`, or threshold-based `ConfirmRisky` before execution.
**Why distinctive:** It avoids a separate safety pass by folding risk annotation into normal tool generation, then turns that signal into explicit runtime approval behavior and audit-trail events.
**TORQUE relevance:** HIGH - TORQUE already has approval and verify concepts; risk-aware action confirmation would make autonomous workflows safer for shell, filesystem, network, and MCP actions without forcing blanket manual review.

## Feature 5: Provider-agnostic LLM layer with cost telemetry
**What it does:** OpenHands exposes one LLM interface over 100+ providers through LiteLLM, supports both Chat Completions and Responses APIs, and automatically records tokens, cost, latency, retries, and errors. Metrics can be inspected per LLM or aggregated at the conversation level.
**Why distinctive:** The LLM layer is not only an adapter. It is an observability surface that treats model choice, retries, and spend as runtime data that higher-level orchestration can use.
**TORQUE relevance:** MEDIUM - TORQUE already has multi-provider routing, but richer built-in token/cost telemetry would sharpen routing decisions, budget controls, and provider quality comparisons.

## Verdict
The two features most worth porting are the typed append-only event backbone and the inline security-risk confirmation model. The event backbone would give TORQUE a cleaner foundation for replay, resume, visualization, and workflow diagnostics, while the risk-aware confirmation layer would let TORQUE increase autonomy without losing control over dangerous actions. The context condenser is the next feature I would queue after those two because it directly improves long-running workflow reliability and cost.
