# Findings: MetaGPT

**Tagline:** Multi-agent software company framework that turns roles, SOPs, and shared context into a coordinated delivery team.
**Stars:** 66.9k
**Language:** Python

## Feature 1: SOP-Driven Role Orchestration
**What it does:** MetaGPT models delivery as a team of specialized roles such as product manager, architect, engineer, tester, and reviewer. Those roles collaborate through an explicit standard operating procedure instead of a single open-ended agent loop.
**Why distinctive:** The core idea is not just "multiple agents" but "multiple agents with a named operating procedure." That gives the system a process backbone closer to a real software organization than most agent frameworks.
**TORQUE relevance:** HIGH — TORQUE already has workflows and verify gates, so an SOP layer could make workflow templates more opinionated, reusable, and easier to reason about across providers.

## Feature 2: Typed Publish/Subscribe Handoffs
**What it does:** Roles subscribe to upstream events with `_watch(...)`, then publish their own outputs back into a shared environment as typed messages caused by specific actions. This creates explicit downstream triggers such as coder -> tester -> reviewer without hard-coding every handoff in prompts.
**Why distinctive:** The coordination model is event-driven and typed around action outputs, not just sequential prompt chaining. That makes collaboration extensible while keeping dependencies legible.
**TORQUE relevance:** HIGH — TORQUE workflows could benefit from typed task outputs and event subscriptions that trigger downstream work or tool calls more dynamically than fixed DAG edges alone.

## Feature 3: Role/Action Separation With Pluggable React Modes
**What it does:** MetaGPT separates agent identity (`Role`) from executable units (`Action`), then lets a role choose how to progress through actions, including ordered execution like `by_order`. A single role can therefore behave like a mini workflow, or multiple roles can compose into a larger team.
**Why distinctive:** This is a cleaner abstraction boundary than many frameworks that blur prompting, planning, and execution into one agent object. It supports both reusable role personas and reusable action implementations.
**TORQUE relevance:** HIGH — TORQUE already has tasks, tools, and providers; a Role/Action split could map well to higher-level task personas over lower-level execution primitives and make workflow templates more modular.

## Feature 4: First-Class Agent Memory In The Execution Loop
**What it does:** Each role stores observed messages in memory and can retrieve either recent or full history as context for later actions. The docs show the tester using all prior messages so feedback can revise the next output rather than starting fresh each round.
**Why distinctive:** Memory is not bolted on as an optional retrieval plugin; it is part of the role runtime and directly shapes observe-think-act behavior. That makes iterative improvement and review loops more natural.
**TORQUE relevance:** MEDIUM — TORQUE has task history and workflow state, but role-scoped working memory could improve retries, review/fix loops, and long-lived agent sessions without forcing every step to restate context.

## Feature 5: Team Runtime With Budget And Round Controls
**What it does:** MetaGPT exposes a team container that can hire roles, invest a budget, start a project, and run for a bounded number of rounds. Collaboration is treated as a managed simulation with explicit spending and iteration limits.
**Why distinctive:** Most agent systems stop at coordination; MetaGPT also frames execution as a constrained operating environment with runtime knobs for cost and iteration depth. That makes the system feel closer to a controllable delivery engine.
**TORQUE relevance:** MEDIUM — TORQUE already manages execution and providers, but explicit per-workflow collaboration budgets and round ceilings could strengthen cost governance and prevent runaway agent loops.

## Verdict
The two features most worth porting to TORQUE are SOP-driven role orchestration and typed publish/subscribe handoffs. TORQUE already has strong workflow execution, provider routing, and verification surfaces; adding an explicit process layer plus event-typed downstream triggers would strengthen its control plane without sacrificing determinism, and would make multi-step automation feel more like a structured software organization than a queue of isolated tasks.
