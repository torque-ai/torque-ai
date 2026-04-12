# Findings: Burr

**Tagline:** Action-first Python framework for stateful AI apps that can be traced, persisted, and resumed.
**Stars:** 2k (GitHub, 2026-04-12)
**Language:** Python (61.3%)

## Feature 1: Action-First Composition
**What it does:** Burr models an application as named actions that declare what state they read, what state they write, and how they update it. Those actions can be simple decorated functions or class-based objects, then composed into an application with `ApplicationBuilder`.
**Why distinctive:** Burr treats the action as the primary unit of composition, not the graph node. Compared with LangGraph's node-plus-edge framing over shared state, Burr makes state access and update behavior part of the action contract itself, which gives the system a more reducer-like, application-code-first feel.
**TORQUE relevance:** HIGH - TORQUE already centers work around concrete execution units with explicit side effects. Burr's action contract is a strong reference for packaging provider calls, verification passes, and operator inputs as small stateful steps with clearer boundaries than ad hoc handler logic.

## Feature 2: Ordered Conditional Transitions
**What it does:** Burr wires actions together with explicit transitions that can use `when(...)`, `expr(...)`, inversion, and a catch-all `default` branch. Conditions are checked in declaration order, and the first true condition wins; if none match, execution stops.
**Why distinctive:** This is a very literal state-machine model rather than a general graph runtime with many routing primitives. Versus LangGraph's richer node control mechanisms, Burr's routing is easier to read as business logic because every branch is just a condition over current state and a next action.
**TORQUE relevance:** HIGH - TORQUE workflows already depend on readable branching and operator trust. Burr's transition style is a useful model for surfacing workflow branch logic, pause conditions, and explicit stop states without hiding decisions inside task implementations.

## Feature 3: Per-Step Persistence With `StatePersister`
**What it does:** Burr can save state after each action through `with_state_persister(...)` and reload it with `initialize_from(...)`, using identifiers like `app_id`, `partition_key`, and `sequence_id`. It supports custom persisters plus built-in database integrations, and the builder exposes resume behavior directly.
**Why distinctive:** Burr does not treat persistence as a bolt-on logging layer; it is part of the application lifecycle API. LangGraph also checkpoints, but Burr's loader/saver model is more explicit about durable application identity, step-by-step save points, and how a restarted app should resume.
**TORQUE relevance:** HIGH - This maps directly to TORQUE's need for safer restart and recovery across long-running tasks and workflows. A Burr-like persister contract would make it easier to resume work after crashes, preserve step context, and reason about where execution should continue.

## Feature 4: Built-In Tracker UI
**What it does:** Burr ships with a local tracking client and UI that log the static state machine plus per-step inputs, state snapshots, timestamps, and results. Running `burr` launches a local server so developers can inspect executions and watch decisions in real time.
**Why distinctive:** The debugging surface is included in the open-source runtime instead of being pushed into a separate hosted observability product. That is a sharper developer loop than LangGraph's core runtime alone because the same framework that runs the state machine also exposes a first-party trace viewer for it.
**TORQUE relevance:** HIGH - TORQUE already values auditability and operator visibility, but its execution story is split across logs, DB state, and dashboard surfaces. Burr is a strong reference for a local-first execution viewer that shows branch decisions and state evolution step by step.

## Feature 5: Recoverable And Forkable Agent Runs
**What it does:** Burr can restart from persisted state, resume at the next action, or fork from a prior `app_id` and even a specific `sequence_id`. The local tracker can also serve as the loader, which makes it possible to rewind a run, branch from a known point, and continue with new choices.
**Why distinctive:** This creates a practical recoverable-agent pattern without inventing a separate agent abstraction: recovery is just rebuilding the app from a prior state snapshot and choosing whether to resume or fork. Compared with LangGraph's checkpoint-centric story, Burr makes recovery feel like an explicit application construction pattern that is easy to reason about in local development and debugging.
**TORQUE relevance:** HIGH - TORQUE would benefit from this exact restart/fork model for failed provider runs, operator-led replay, and branch-from-here diagnostics. It would also give postmortems a concrete path from "find the bad step" to "resume from the last good point" instead of forcing a full rerun.

## Verdict
Burr is worth studying less as a general-purpose graph runtime and more as a very opinionated state-machine toolkit with a tight developer loop. The most portable ideas for TORQUE are the action-first mental model, explicit per-step persistence and resume semantics, and the built-in tracker UI that makes stateful executions inspectable without extra infrastructure. Relative to LangGraph, Burr's edge is not broader control flow power but a simpler, more application-shaped model for durable, debuggable stateful automation.
