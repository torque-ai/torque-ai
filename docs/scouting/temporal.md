# Findings: Temporal

**Tagline:** Durable execution platform.
**Stars:** 19.5k (GitHub, 2026-04-11)
**Language:** Go (99.5%)

## Feature 1: Event-History-Backed Replay
**What it does:** Temporal persists each Workflow Execution as an append-only Event History and uses that history to recover after crashes and continue making progress. The same log also serves as an audit trail of commands, activity state changes, and resets.
**Why distinctive:** Durability is not bolted on with ad hoc checkpoints. The execution model is explicitly built around replayable history, which makes recovery, debugging, and long-running coordination part of the core abstraction.
**TORQUE relevance:** HIGH - TORQUE workflows and tasks currently track status transitions and outputs, but a true event journal would enable deterministic resume, better postmortems, and safer recovery around provider/tool side effects.

## Feature 2: Signals, Queries, and Updates as Separate Contracts
**What it does:** Temporal splits live workflow interaction into Queries for read-only inspection, Signals for asynchronous writes, and Updates for synchronous tracked writes with completion or failure returned to the caller.
**Why distinctive:** This is a sharper control-plane model than a generic "send message" API. Reads stay cheap and history-free, async writes stay fire-and-forget, and synchronous mutations become explicitly acknowledged operations.
**TORQUE relevance:** HIGH - TORQUE could expose the same split across dashboard, MCP, and API surfaces: query running workflows cheaply, signal them to branch or cancel, and use tracked updates for blocking operator actions.

## Feature 3: Activities as Durable Side-Effect Boundaries
**What it does:** Activities are the boundary for external work. Temporal gives them service-level retries, timeouts, cancellation delivery via heartbeats, and async completion when an external system finishes later.
**Why distinctive:** Most orchestrators leave retry and cancellation semantics to each integration. Temporal turns side effects into a first-class runtime primitive with consistent failure handling.
**TORQUE relevance:** HIGH - Provider executions, MCP tools, verify gates, and remote-agent work are TORQUE's side effects. An Activity-like layer would unify retry, heartbeat, cancellation, and delayed completion semantics across those executors.

## Feature 4: Continue-As-New Execution Chains
**What it does:** A long-lived workflow can roll itself into a new run with the same Workflow ID, fresh Event History, and carried-forward state. This keeps entity-style workflows alive without letting history grow forever.
**Why distinctive:** It is a clean operational answer to long-running durable objects, history compaction, and code-version drift.
**TORQUE relevance:** MEDIUM - This fits recurring or always-on TORQUE workflows, but it becomes most valuable after TORQUE has stronger event-history and replay foundations.

## Verdict
The two ideas most worth porting are Event-History-Backed Replay and Durable Side-Effect Boundaries. Replay would give TORQUE a more trustworthy recovery model for long-running workflows, while Activity-like execution semantics would regularize provider calls, MCP tools, verify steps, and remote agents under one durable contract. Signals/Queries/Updates are also strong, but they become even more valuable once the underlying execution history is durable enough to treat live workflow control as a first-class API.
