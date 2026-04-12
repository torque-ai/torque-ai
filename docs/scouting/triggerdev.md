# Findings: Trigger.dev

**Tagline:** TypeScript-native workflow-as-code platform for durable background jobs, AI tasks, and realtime operations.
**Stars:** 14.5k (GitHub, 2026-04-11)
**Language:** TypeScript (98.4%)

## Feature 1: Plain async workflows with checkpoint-resume
**What it does:** Trigger.dev defines work as exported `task()` functions in your codebase, then composes longer flows with normal async control flow, `triggerAndWait`, waits, and waitpoints. When a run pauses for a subtask, delay, or external event, the runtime checkpoints state and resumes later instead of forcing users into a separate workflow DSL.
**Why distinctive:** Most workflow systems make you choose between plain code and durable orchestration. Trigger.dev keeps the developer experience close to ordinary TypeScript while still giving long-running tasks durable pause/resume behavior.
**TORQUE relevance:** HIGH - TORQUE already has explicit DAG workflows, but Trigger.dev suggests a complementary code-native lane for long-running jobs, human gates, and app-local orchestration. That could sit above or beside TORQUE's current workflow engine instead of replacing it.

## Feature 2: Queue-aware retries, idempotency, and concurrency keys
**What it does:** Retry behavior can be set per task, overridden per trigger, or applied to smaller blocks with helpers like `retry.onThrow()` and `retry.fetch()`. Queue selection, concurrency limits, and `concurrencyKey` make it possible to create per-tenant lanes, while checkpointed waits release concurrency slots until the run resumes.
**Why distinctive:** This is more than "retry the whole job on failure." Trigger.dev exposes retry scope, fairness, and queue topology as first-class programming primitives, which is especially useful for external APIs, rate limits, and noisy-neighbor control.
**TORQUE relevance:** HIGH - TORQUE already has provider routing and retries, but Trigger.dev's model is a sharper answer to per-project or per-user fairness, priority lanes, and retrying specific side effects instead of replaying an entire task. The `concurrencyKey` idea is particularly relevant for multi-tenant automation.

## Feature 3: Declarative and imperative schedules
**What it does:** Scheduled work can be declared directly in code with `cron` on `schedules.task()`, or created and managed imperatively from the dashboard and SDK. Imperative schedules support timezone, deduplication keys, and external IDs, which makes them suitable for user- or tenant-specific recurring jobs.
**Why distinctive:** Trigger.dev clearly separates version-controlled internal schedules from runtime-managed customer schedules. That split avoids forcing all scheduling through either deploy-time code sync or a pure admin/database surface.
**TORQUE relevance:** HIGH - TORQUE already supports scheduled automation, so the useful pattern here is the two-track model: code-owned schedules for repo automation, and API/dashboard-owned schedules for tenant automation. Deduplication keys and external IDs would also strengthen TORQUE's governance and schedule mutation story.

## Feature 4: OpenTelemetry-first observability and realtime
**What it does:** Every run is surfaced through logs, traces, spans, and metrics, with OpenTelemetry under the hood and dashboard support for alerts, dashboards, and TRQL queries. Trigger.dev also exposes Realtime APIs and React hooks so applications can subscribe to run status or live streams without polling.
**Why distinctive:** Observability is not bolted on as worker logs plus an admin page. Trigger.dev turns execution state into a shared control plane for debugging, analytics, alerts, and frontend UX.
**TORQUE relevance:** HIGH - TORQUE already has a dashboard, workflow status APIs, and MCP surfaces, so this maps directly to richer run introspection and live status delivery. The strongest ideas to borrow are unified traces/metrics per run and a first-class subscribe model instead of repeated polling.

## Feature 5: AI-agent infrastructure without a proprietary agent DSL
**What it does:** Trigger.dev is explicitly built to host AI workloads, with examples and guidance for Vercel AI SDK, OpenAI Agents SDK, Mastra, tool calling, streaming outputs, waitpoint tokens, and human-in-the-loop flows. The platform adds retries, queues, versioning, observability, and long-running execution around whichever AI libraries you already use.
**Why distinctive:** It does not try to replace the TypeScript AI ecosystem with its own agent language. That keeps framework choice loose while still standardizing the operational layer that agent teams usually end up rebuilding.
**TORQUE relevance:** MEDIUM - TORQUE is broader than an AI-agent runtime, but it already orchestrates providers, MCP tools, and remote agents. Trigger.dev's main lesson is architectural: keep AI library choice flexible, but make retries, streaming, human approval, and telemetry consistent across all agent workloads.

## Verdict
The two features most worth porting are the code-native checkpoint-resume model and the queue/concurrency primitives. Checkpointed async workflows would give TORQUE a durable execution layer that feels closer to normal application code, while concurrency keys and block-level retry controls would sharpen fairness and failure handling across providers, tools, and tenants. The observability and realtime layer is the next strongest idea because it ties dashboard, API, and frontend state back to the same run model.
