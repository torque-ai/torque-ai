# Findings: CrewAI

**Tagline:** Multi-agent framework that separates autonomous crews from event-driven flows for production automation.
**Stars:** 48.6k
**Language:** Python

## Feature 1: Crew/Flow split
**What it does:** CrewAI treats `Crews` as role-based agent teams and `Flows` as explicit workflow code with `@start`, `@listen`, and `@router` steps. A flow can call one or more crews as part of a larger process.
**Why distinctive:** Most agent frameworks blur autonomy and orchestration into one loop. CrewAI makes the boundary explicit, so you can keep deterministic control where needed and still drop in autonomous subteams.
**TORQUE relevance:** HIGH - TORQUE already has workflow orchestration; the missing piece is a clean way to embed agentic subroutines inside a controlled DAG/runtime.

## Feature 2: First-class hierarchical process
**What it does:** In addition to sequential execution, CrewAI supports a hierarchical process where a manager agent or manager LLM delegates tasks, validates outputs, and decides who should do what next.
**Why distinctive:** This is not a prompt pattern layered on top of tasks. It is a built-in execution mode that lets the same task system switch between fixed order and manager-driven delegation.
**TORQUE relevance:** HIGH - TORQUE could use this as an optional workflow mode for ambiguous research, triage, or decomposition work where static dependencies are too rigid.

## Feature 3: Task guardrails plus human gates
**What it does:** Tasks can declare guardrails, retries, callbacks, explicit context dependencies, async execution, and `human_input` review before final acceptance.
**Why distinctive:** Verification is attached to the task boundary itself, not left to an external test phase or ad hoc prompt instruction. That makes quality control part of orchestration instead of an afterthought.
**TORQUE relevance:** HIGH - This maps directly to TORQUE's verify gates and approval model, and suggests a more native task contract for validation, retry, and human escalation.

## Feature 4: Persistent stateful flows
**What it does:** Flows maintain typed state and support persistence/resume so long-running automations can survive restarts and continue from prior state instead of replaying everything.
**Why distinctive:** The workflow DSL assumes state, routing, and recovery are core runtime concerns. That is stronger than a stateless task queue with logs on the side.
**TORQUE relevance:** HIGH - TORQUE workflows, dashboards, and restart handling would benefit from a first-class persisted state model instead of reconstructing progress from task output and metadata.

## Feature 5: MCP-aware tool fabric
**What it does:** CrewAI ships a broad prebuilt tool library and can mount MCP servers as agent tools over stdio, HTTP, or SSE, with filtering and shared adapter lifecycle management.
**Why distinctive:** Tooling is not limited to a local Python wrapper set. CrewAI treats MCP as a native expansion path, so tool discovery and transport choice become part of agent composition.
**TORQUE relevance:** HIGH - TORQUE already leans on MCP heavily, so CrewAI's MCP-to-agent ergonomics are directly portable, especially tool filtering, shared connection management, and selective exposure by role.

## Verdict
The two features most worth porting are the Crew/Flow split and persistent stateful flows. The Crew/Flow split would let TORQUE preserve its deterministic workflow core while adding bounded autonomous subteams where they are actually useful, and persistent flows would strengthen resume, dashboard visibility, and restart safety across long-running automations. The hierarchical process is the next candidate, but only as an opt-in mode because TORQUE's current value comes from explicit control.
