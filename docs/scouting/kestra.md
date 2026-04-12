# Findings: Kestra

**Tagline:** YAML-first orchestration platform with pluggable triggers, tasks, and runners.
**Stars:** 26.7k (GitHub, 2026-04-11)
**Language:** Java (72.0%)

## Feature 1: Typed YAML Flows with Native Trigger Blocks
**What it does:** Kestra defines flows declaratively in YAML around `id`, `namespace`, and `tasks`, and it adds strongly typed inputs and outputs with validation rules. The same flow definition can also declare built-in trigger types including Schedule, Flow, Webhook, Polling, and Realtime triggers.
**Why distinctive:** This is closer to workflow-as-config than SDK-first orchestration. Kestra keeps the orchestration artifact, trigger entry points, and typed runtime contract in one document, and its UI/API preserve YAML as the source of truth rather than treating it as an export format.
**TORQUE relevance:** HIGH - TORQUE’s Plan 1 points in the same direction, so Kestra is directly relevant. The main idea to copy is keeping schedules, webhooks, and flow-to-flow triggers inside the workflow document with typed inputs/outputs, instead of scattering those concerns across separate control-plane objects.

## Feature 2: Plugins as the Universal Integration Layer
**What it does:** Kestra models tasks, triggers, and conditions as plugins referenced by fully qualified `type` names such as `io.kestra.plugin...`. In open source, plugins are individual JARs loaded at runtime, and the public catalog currently exposes 1200+ plugins and integrations; `pluginDefaults` let flows or instances stamp common config onto repeated plugin types.
**Why distinctive:** The same abstraction covers starting work, doing work, and gating work, which gives the platform a consistent extension model. Combined with runtime-loaded plugin JARs and a public catalog, Kestra feels more like a package ecosystem than a fixed list of built-ins.
**TORQUE relevance:** HIGH - TORQUE already has providers and tools, but Kestra shows a cleaner contract for naming, discovering, and configuring integrations from YAML. A similar model would let TORQUE flows target stable plugin or executor ids while centralizing defaults, compatibility rules, and future plugin discovery.

## Feature 3: Namespaces as the Shared Resource Boundary
**What it does:** Every flow belongs to a namespace, and namespaces support unlimited dot-separated nesting for teams, projects, and environments. They scope flows plus shared resources such as files, key-value pairs, variables, and plugin defaults, and namespace files can be synced from Git and read by any task or trigger in the same namespace.
**Why distinctive:** Kestra makes the project boundary a first-class runtime object rather than just a folder or label. The docs are also explicit that namespaces organize and scope resources within one instance, while tenants are the stronger isolation boundary when you need truly separate environments.
**TORQUE relevance:** HIGH - TORQUE needs a unit above individual workflows for shared assets, defaults, and access controls. Kestra’s namespace model is a strong template for that layer, especially if TORQUE preserves the same distinction between lightweight namespace scoping and harder tenant-style isolation.

## Feature 4: Split Scheduler/Executor/Worker Runtime
**What it does:** Kestra splits its runtime into independently scalable Webserver, Scheduler, Executor, and Worker services. The Scheduler evaluates most triggers, the Executor advances executions and handles flow triggers, and Workers execute runnable tasks and Polling Triggers; script tasks can then pick task runners such as Docker or Process for the actual execution backend.
**Why distinctive:** Many orchestrators stop at a broad control-plane versus worker split. Kestra separates trigger evaluation, orchestration progression, and side-effect execution, then adds a second runtime choice at the task level through task runners.
**TORQUE relevance:** MEDIUM - TORQUE already has some separation between orchestration and provider execution, so the fit is real but not a drop-in differentiator. The valuable lesson is architectural: as TORQUE’s event-driven YAML workflows grow, it will help to separate scheduling, orchestration state advancement, and execution backends more explicitly.

## Feature 5: Built-In Revisions and Rollback
**What it does:** Flows are versioned by default, so every change creates a new revision that can be inspected, compared side-by-side or line-by-line, and rolled back from the UI. Namespace files also carry revision history, so the code and assets around a flow can be restored with similar ergonomics.
**Why distinctive:** This is not as deep as Temporal-style deterministic replay, but it is much more operationally useful than relying on Git alone. Kestra treats revision history as a first-class product feature, which matters because flows can be changed from the UI, API, CI/CD, or Terraform.
**TORQUE relevance:** HIGH - If TORQUE adopts YAML workflows, Git diffs alone will not be enough for operational recovery and operator trust. Kestra’s model suggests a practical middle ground: keep external version control where available, but also store native workflow revisions with compare and restore semantics inside the orchestrator.

## Verdict
Kestra is one of the more useful comparables for TORQUE because it already treats YAML workflows as a real product surface rather than a thin export format. The most valuable ideas to borrow are typed YAML flow definitions, namespaces as a shared resource boundary, and built-in revisions, with the split Scheduler/Executor/Worker model as the next architectural step once TORQUE’s event and runtime surfaces expand. Compared with Temporal, Kestra is less about durable replay semantics and more about making a YAML-first orchestrator operationally usable at product scale.
