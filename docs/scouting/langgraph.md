# Findings: LangGraph

**Tagline:** Low-level orchestration framework for building stateful agents.
**Stars:** 23.3k
**Language:** Python

## Feature 1: StateGraph with typed shared state
**What it does:** LangGraph models workflows as nodes and edges operating on a shared typed state, with reducers controlling how updates merge. It supports loops, conditional routing, and parallel super-steps instead of only one-pass DAG execution.
**Why distinctive:** The workflow contract is the evolving state object, not just task inputs and outputs. That makes long-running agent behavior easier to express than ad hoc task chaining.
**TORQUE relevance:** HIGH - TORQUE already has DAG orchestration and unblocking logic, but a first-class workflow state model could simplify branching, retries, and richer node coordination.

## Feature 2: Per-step checkpointing and thread history
**What it does:** When compiled with a checkpointer, LangGraph saves a checkpoint after every super-step into a thread. The runtime can fetch current state, full state history, and resume from persisted execution state after interruption or failure.
**Why distinctive:** This is finer-grained than normal task logs or final artifacts. It preserves execution context plus the next scheduled work, which is a stronger base for durable automation.
**TORQUE relevance:** HIGH - TORQUE workflows, await surfaces, and long-running provider jobs would benefit from resumable state snapshots rather than mostly status-based recovery.

## Feature 3: Interrupt-based human-in-the-loop
**What it does:** LangGraph can pause inside a node with `interrupt`, surface a JSON payload for review, and resume with `Command(resume=...)`. The documented patterns include approve/reject, edit graph state, review tool calls, and validate human input.
**Why distinctive:** Human review is embedded into the runtime rather than bolted on as an external approval queue. Because interrupts ride on checkpoints, pauses can be indefinite without losing context.
**TORQUE relevance:** HIGH - this fits TORQUE's verify gates, dashboard interventions, and MCP/tool safety model very closely.

## Feature 4: Time-travel replay and forked debugging
**What it does:** LangGraph can resume from an older checkpoint, optionally edit state, replay prior steps, and then continue on a new branch. This gives operators a way to inspect or re-run non-deterministic workflows from a known historical point.
**Why distinctive:** It treats debugging as runtime navigation through execution history, not just log inspection. That is unusually strong for agent systems where model outputs and tool choices can diverge across runs.
**TORQUE relevance:** HIGH - TORQUE could use this for failed workflow triage, provider comparison, and safe re-execution without restarting an entire batch.

## Feature 5: `Command` and `Send` for dynamic control flow
**What it does:** LangGraph lets a node both update state and choose the next node via `Command`, and lets routing functions emit `Send` objects for dynamic fan-out with per-branch state. This supports patterns like map-reduce and multi-agent handoffs without predeclaring every edge.
**Why distinctive:** Many workflow systems separate routing from execution too rigidly. LangGraph gives controlled runtime dynamism while keeping it attached to an explicit graph model.
**TORQUE relevance:** MEDIUM - TORQUE already supports DAGs and diffusion workflows, but dynamic fan-out with per-branch state could make agentic subflows less awkward.

## Verdict
The top ideas worth porting are per-step checkpointing and interrupt-based human review, with time-travel replay as the next strongest extension. TORQUE already has solid workflow submission, routing, and dashboard surfaces; LangGraph's edge is the runtime memory around each workflow step, which would make TORQUE more recoverable, reviewable, and debuggable under long-running multi-provider automation.
