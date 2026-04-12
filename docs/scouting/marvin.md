# Findings: Marvin

**Tagline:** Thread-centric Python framework for typed AI tasks, agent handoffs, and event-driven execution.
**Stars:** 6.1k (GitHub, 2026-04-12)
**Language:** Python

## Feature 1: Tasks as Typed End-Turn Contracts
**What it does:** Marvin's `Task` model packages instructions, tools, agents, context, dependencies, and a declared `result_type` into one executable unit. Completion is explicit: tasks end when an end-turn action marks them successful, failed, or skipped, and results are validated against the declared type before the task is considered done.
**Why distinctive:** This is more than prompt-plus-schema wrapping. Marvin treats task completion as a runtime contract with explicit state transitions and typed validation, which makes agent work inspectable and programmatically safe instead of leaving success semantics buried in prompt text.
**TORQUE relevance:** HIGH - TORQUE already has task state, but Marvin's typed end-turn contract is a sharper model for AI work. It is especially relevant for provider outputs, tool-mediated steps, and any future task API that needs stronger success, skip, and failure boundaries than free-form text can provide.

## Feature 2: Threads as Persistent Conversation State
**What it does:** Marvin's `Thread` is a first-class conversation object with its own ID, message history, optional database persistence, and retrieval APIs. Tasks, `say`, agents, and function-style invocations can all share the same thread so context survives across turns and can be resumed later.
**Why distinctive:** Marvin separates conversation continuity from workflow structure. That gives it a reusable state container for AI interactions without conflating orchestration, dependency management, and transcript persistence into the same abstraction.
**TORQUE relevance:** HIGH - TORQUE has task and workflow state, but not a unified thread primitive that spans agent turns, operator interaction, and resumable context. A Marvin-style thread layer could simplify transcript storage, context reuse, and cross-step conversational continuity.

## Feature 3: Event-Driven Orchestration and Streaming Handlers
**What it does:** Marvin's orchestrator gathers ready tasks, runs actor turns, converts underlying PydanticAI activity into Marvin events, and dispatches them through handlers. The event surface includes orchestrator start and end, actor turn boundaries, streamed message deltas, tool calls, tool retries, and end-turn tool results, with `run_stream` and `run_tasks_stream` exposing that flow directly.
**Why distinctive:** The runtime is observable as an event stream rather than an opaque agent loop. That means the same engine can drive terminal rendering, custom monitoring, and programmatic control without inventing separate execution and telemetry layers.
**TORQUE relevance:** HIGH - This maps directly onto TORQUE's need for richer workflow visibility. An event model at this granularity would improve live monitoring, operator tooling, and postmortem evidence while keeping execution semantics consistent across providers and tools.

## Feature 4: In-Thread Agent Handoffs via Teams and Delegation
**What it does:** Marvin supports individual agents as well as `Team`, `RoundRobinTeam`, `RandomTeam`, and `Swarm`, plus explicit delegation through `DelegateToActor` end-turn tools. A swarm permits all agents to delegate to each other, allowing control to pass between specialists while they continue working inside the same thread and shared history.
**Why distinctive:** Handoffs are a native runtime action, not prompt theater or manual orchestration glue. Marvin preserves transcript continuity and turn semantics while letting responsibility move between agents, which makes multi-agent work feel like one coordinated conversation instead of a series of disconnected runs.
**TORQUE relevance:** HIGH - TORQUE already routes work between executors, but it does not yet model baton-passing inside a shared conversational runtime. Marvin's handoff model is a strong reference for multi-agent workflows that need continuity, specialization, and observable turn ownership.

## Feature 5: `marvin.run()` Versus Structured Invocation Layers
**What it does:** `marvin.run()` is the one-line entrypoint that creates and executes a task with optional `result_type`, tools, agents, thread, and handlers. Marvin also exposes more structured layers above and beside that convenience API: explicit `Task` objects, typed utilities like `cast` and `extract`, and `@marvin.fn`, which predicts a function's typed return from its signature, docstring, runtime arguments, and optional thread without executing the Python body.
**Why distinctive:** Marvin gives developers a smooth gradient from quick one-off prompting to typed, inspectable task execution. The `fn` layer is especially unusual because it treats a Python function signature as an invocation contract for AI prediction, while still allowing the wrapped function to surface its underlying task with `.as_task()`.
**TORQUE relevance:** MEDIUM - `marvin.run()` itself is mostly ergonomic sugar, but the layered invocation model is valuable. TORQUE could benefit from lightweight typed entrypoints that compile down to full tasks only when users need observability, dependency management, or richer control.

## Verdict
Marvin 3 is most interesting where it goes beyond a generic agent wrapper: threads are first-class state, orchestration is evented, and handoffs are explicit runtime actions. For TORQUE, the strongest ideas to borrow are the thread primitive, the event-handler surface, and end-turn-based multi-agent delegation inside a shared conversation. `marvin.run()` is useful, but the deeper value is that simple calls and fully structured execution live on the same underlying model.
