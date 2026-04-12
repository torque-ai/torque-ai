# Findings: Inngest

**Tagline:** Event-driven durable execution for step-based serverless workflows.
**Stars:** 5.2k (GitHub, 2026-04-11)
**Language:** Go (57.9%)

## Feature 1: Durable `step.run()` boundaries
**What it does:** `step.run()` wraps synchronous or asynchronous code as a retriable step with its own retry counter, JSON-serialized output, and memoized state keyed by step ID. Once a step succeeds, its output is saved in run state so later executions can continue without rerunning completed work.
**Why distinctive:** Inngest turns the checkpoint boundary into a normal line of application code instead of pushing users into a separate workflow DSL or worker/activity split. The result is a code-first model where durability, retries, and resume behavior are attached directly to the function body.
**TORQUE relevance:** HIGH - TORQUE workflows already orchestrate provider calls, MCP tools, verify gates, and remote agents, but those side effects are still fairly coarse. A `step.run()`-style boundary would let TORQUE checkpoint and retry individual tool or provider actions inside a workflow node instead of replaying an entire task.

## Feature 2: Event-matched waits with `step.waitForEvent()`
**What it does:** `step.waitForEvent()` pauses a run until a matching event arrives or a timeout expires, returning either the received event payload or `null`. Matching can be simple field-based correlation or CEL expressions comparing the original trigger event to the incoming event.
**Why distinctive:** Inngest treats event waits as part of the execution model, not as an external callback table. The same event stream that starts functions can also resume many paused runs, which keeps waits decoupled, fan-out friendly, and auditable.
**TORQUE relevance:** HIGH - TORQUE already has an event bus plus operator- and tool-driven workflows, so this maps directly to approvals, webhook completions, MCP callbacks, and deferred task resumes. It would remove a lot of polling and special-case waiter logic from dashboard and control-plane flows.

## Feature 3: Parallel fan-out inside ordinary code
**What it does:** Inngest lets developers create multiple `step.run()` promises and await them with `Promise.all()`, causing the steps to execute in parallel while still preserving per-step retries and state. On serverless runtimes this becomes true parallel work rather than just asynchronous sequencing.
**Why distinctive:** Dynamic fan-out stays inside normal TypeScript control flow instead of forcing developers to switch to a separate map state, child workflow API, or visual fan-out primitive. That is especially useful when the amount of parallel work is only known at runtime.
**TORQUE relevance:** HIGH - TORQUE's DAG runtime handles planned parallelism well, but it is less natural for lightweight runtime fan-out inside a single handler. This pattern would fit provider races, per-tenant batch processing, or parallel MCP/tool calls without first expanding the whole plan into extra workflow nodes.

## Feature 4: Unified triggers with built-in debounce and throttling
**What it does:** `createFunction()` supports event triggers, cron triggers, multiple triggers, CEL-based event filtering, and timezone-aware schedules in the same function definition. The same definition can also attach debounce and throttling rules, with keys derived from event data so noisy inputs and rate-shaped workloads are controlled before execution starts.
**Why distinctive:** Inngest does not split "scheduled jobs," "event handlers," and "queue shaping" into unrelated products. One durable function model covers triggered work, scheduled work, and admission control, which keeps orchestration policy close to the handler it governs.
**TORQUE relevance:** HIGH - TORQUE already has scheduled tasks and event-triggered workflow starts, but they come through different abstractions. Inngest suggests a cleaner admission layer where cron schedules, event-bus triggers, debounce rules, and provider-protection throttles all feed the same workflow runtime.

## Feature 5: Dev Server and trace timeline for local-first debugging
**What it does:** The open-source Dev Server auto-discovers local function endpoints, polls for changed functions, exposes a browser UI at `localhost:8288`, and lets developers invoke functions or send test events directly from the interface. In both Dev Server and Cloud, traces show an interactive timeline with run bars for `step.run()`, waits, sleeps, retries, queue delays, and related details.
**Why distinctive:** Many workflow engines have strong production dashboards but a weaker local loop. Inngest ships a local control plane with production-parity execution patterns and a step-level trace waterfall, which makes durable workflows easier to iterate on and debug before deployment.
**TORQUE relevance:** HIGH - TORQUE already has a dashboard, scheduled tasks, and an event bus, but local reproduction is still more fragmented than it should be. A dev-server-style runtime plus waterfall traces would materially improve debugging of workflow stalls, MCP latency, provider retries, and scheduler behavior.

## Verdict
Inngest's strongest idea is that durable orchestration should feel like ordinary application code, with `step.run()` and `step.waitForEvent()` acting as explicit boundaries inside that code rather than as a separate workflow language. For TORQUE, the most portable lessons are durable per-step checkpoints, event-native pause/resume, and a unified trigger/admission layer covering schedules, events, debounce, and throttling. The Dev Server and trace timeline are also unusually relevant because they connect local debugging, dashboard visibility, and production-style execution into one loop.
