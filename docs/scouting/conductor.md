# Findings: Conductor

**Tagline:** Durable JSON-defined orchestration with poll-based workers and rich server-side system tasks.
**Stars:** 31.6k (GitHub, 2026-04-11)
**Language:** Java (49.5%)

## Feature 1: JSON Workflow DSL
**What it does:** Conductor stores and executes workflows as JSON definitions, whether they were authored through code, API calls, or the UI. The definition captures task order, branching, inputs and outputs, schema versioning, and other runtime metadata as a portable document.
**Why distinctive:** The workflow contract is a data model first, not a framework-specific code artifact. That makes definitions easier to diff, version, generate, review, and manipulate from external tooling across polyglot stacks.
**TORQUE relevance:** HIGH - TORQUE is currently centered on imperative Node.js orchestration and handler code. A richer JSON DSL would make workflows easier to persist, inspect, synthesize, and exchange across MCP, CLI, and external automation without binding authorship to one runtime.

## Feature 2: Poll-Based Worker Pull Model
**What it does:** Custom work is executed by external workers that poll Conductor over HTTP or gRPC for task types they can handle, run the task logic, and report status and outputs back. Conductor’s own docs describe this as a worker-task queue architecture, with workers polling by default every 100ms and the server maintaining workflow state between polls.
**Why distinctive:** Execution is deliberately decoupled from orchestration. Workers stay stateless, language-agnostic, and deployable anywhere, while the server handles queueing, retries, and durable progress instead of embedding workflow code inside worker processes.
**TORQUE relevance:** HIGH - TORQUE could borrow this boundary for remote agents, isolated executors, or customer-hosted workers. The tradeoff is that pull-based queues add latency and operational complexity compared with TORQUE’s current more direct provider and tool dispatch path.

## Feature 3: FORK_JOIN and SWITCH Control Flow
**What it does:** `FORK_JOIN` lets a workflow fan out into parallel branches, while `JOIN` can wait on selected branch references before proceeding. `SWITCH` evaluates either an input value or a GraalJS expression and then routes execution into the matching case branch or a default path.
**Why distinctive:** Parallelism and branching live in the orchestration layer as first-class runtime operators instead of being rebuilt inside application code. That keeps worker services focused on business logic while making fan-out, joins, and branch selection visible and uniform at the workflow level.
**TORQUE relevance:** HIGH - TORQUE already has DAG semantics, but not this same catalog of reusable declarative control-flow nodes. Conductor’s model suggests a cleaner path for expressing branches, conditional routing, and structured fan-out without encoding those behaviors ad hoc in handlers.

## Feature 4: INLINE and JQ Transform for Glue Logic
**What it does:** `INLINE` executes small JavaScript expressions during workflow runtime, and `JSON_JQ_TRANSFORM` applies jq expressions to reshape JSON payloads. Together they cover a large class of routing, mapping, filtering, and response-shaping work without requiring a separate worker service.
**Why distinctive:** Many orchestration systems force even trivial dataflow logic into custom activities or helper services. Conductor instead treats lightweight compute and payload transformation as native workflow steps, which reduces the number of tiny “glue microservices” teams need to own.
**TORQUE relevance:** MEDIUM - TORQUE often needs lightweight post-processing between tools, providers, and verification steps, so a small transform layer could reduce custom code. The caution is that embedded scripting increases the surface area for debugging, sandboxing, and operational review.

## Feature 5: HUMAN Tasks and Durable Waiting
**What it does:** `HUMAN` tasks assign forms to users or groups, pause the workflow until the form is completed, record the submitted input, and then resume execution. This sits on top of Conductor’s durable state model, where the platform persists workflow metadata, task state, queues, and execution history in backing stores while the state machine keeps long-running flows moving.
**Why distinctive:** Human approval is not bolted on as an external exception path. It is treated as a normal workflow step inside the same durable execution model as machine tasks, which is important for long-lived approvals, intake forms, and other wait-heavy business processes.
**TORQUE relevance:** MEDIUM - TORQUE has obvious use cases for manual approvals, operator gates, and deferred resumes, especially around governance and high-risk actions. Conductor shows how those can live inside the workflow runtime instead of being handled as out-of-band control messages.

## Verdict
Conductor’s clearest contrast with Temporal is that it centers orchestration on versioned JSON definitions plus a poll-based worker fleet, rather than on code-as-the-workflow abstraction. For TORQUE, the most reusable ideas are first-class declarative control-flow and transform tasks, plus a stricter separation between durable orchestration state and worker execution. The main caution is that Conductor’s polling model is powerful for polyglot distributed estates, but it brings queueing and worker-management overhead that TORQUE may only want in selected execution paths.
