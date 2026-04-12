# Findings: Windmill

**Tagline:** Polyglot script-to-workflow platform that turns code into UIs, webhooks, and composable internal apps.
**Stars:** 16.2k (GitHub, 2026-04-12)
**Language:** HTML (30.9%)

## Feature 1: Multi-Language Scripts as Workflow Primitives
**What it does:** Windmill treats scripts as the core runnable unit. A script can run standalone, on a schedule, through a webhook, inside a flow, or behind an app, and the platform supports a broad runtime mix including TypeScript, Python, Go, Bash, SQL, GraphQL, PowerShell, Rust, and more.
**Why distinctive:** This is more code-first than node-catalog tools and less YAML-first than config orchestrators. Windmill keeps extending the same primitive with script kinds such as action, trigger, approval, and error handler, so the model stays centered on executable code rather than separate plugin classes.
**TORQUE relevance:** HIGH - TORQUE already orchestrates heterogeneous work, but Windmill is a strong reference for making one executable contract do more jobs: ad hoc run, schedule, webhook target, approval hook, and workflow step. That could simplify TORQUE's surface area while preserving polyglot execution behind a single orchestration model.

## Feature 2: Auto-Generated Input UIs from Function Signatures
**What it does:** Windmill parses a script or flow's inputs from the `main` function and generates JSON Schema plus a runnable input form automatically. Authors can then refine titles, descriptions, enums, regex rules, resource types, and other field behavior without hand-building the UI.
**Why distinctive:** The important part is not just "there is a form builder," but that the form contract is derived directly from the code signature and stays tied to it. The same inferred schema also helps with validation, testing in the editor, and wiring scripts together inside flows.
**TORQUE relevance:** HIGH - TORQUE already exposes tools and workflows through structured schemas, so signature-first UI generation is a natural fit. It would reduce boilerplate for operator-facing tasks and make it easier to promote plain functions or scripts into usable internal tooling without a second UI-definition step.

## Feature 3: Immutable Hash-Based Versioning
**What it does:** Scripts, flows, and apps get unique deployed versions, and scripts are never overwritten; a new deployment creates a child version with a new hash while the previous head remains archived and still deployed. Windmill exposes that history directly in-product so users can inspect, fork, or return to older versions.
**Why distinctive:** Windmill bakes operational traceability into the artifact model itself instead of assuming Git will cover every edit path. Its version lineage is intentionally simpler than full Git branching, but that simplicity makes platform-native history and rollback easier to reason about.
**TORQUE relevance:** HIGH - TORQUE would benefit from immutable workflow and task-definition history, especially as edits can come from CLI, MCP, or generated automation rather than a single repo commit path. A linear deployed-history model is a practical middle ground between mutable configs and full durable-replay engines.

## Feature 4: Hub-Centered Reuse and Distribution
**What it does:** Windmill Hub is a community catalog for sharing scripts, flows, apps, and resource types, and enterprise users can run a Private Hub with their own approved assets. Those Hub assets are not just examples to copy; they can show up directly in the product and be referenced from flows.
**Why distinctive:** Reuse is treated as a first-class distribution channel rather than an afterthought. That makes shared automation feel closer to an installable internal ecosystem than to a loose pile of snippets, and it gives teams a governance story for curating what gets reused.
**TORQUE relevance:** MEDIUM - TORQUE has workflows and tools, but not yet a strong packaging and discovery layer for reusable automation assets. A hub model could bridge the gap between local one-off tasks and a durable catalog of approved workflow building blocks for teams or organizations.

## Feature 5: Flows as Code-Centric DAGs
**What it does:** Windmill flows are DAGs whose steps can reference workspace scripts, Hub scripts, inline code, trigger scripts, loops, branches, approvals, and inner flows. Input transforms let any step read flow input, resources, variables, or the result of any previous step, so composition is genuinely graph-based rather than simple chaining.
**Why distinctive:** Windmill's flow editor stays close to code: each node is still fundamentally a script-shaped unit with typed inputs and outputs. That keeps low-code orchestration from drifting into opaque proprietary node behavior and makes reuse across languages and shared assets much cleaner.
**TORQUE relevance:** HIGH - This is the most directly transferable idea for TORQUE's future workflow model. TORQUE could adopt the same "code step plus explicit data mapping plus DAG dependencies" pattern to compose provider work, tool calls, and reusable modules without locking itself into a visual-only abstraction.

## Verdict
Windmill is most interesting where it collapses authoring, operator UX, reuse, and orchestration into one script-first model. The strongest ideas for TORQUE are signature-derived UIs, immutable deployed-history for runnable artifacts, and DAG composition built from reusable code steps rather than provider-specific task types. Compared with n8n and Kestra, Windmill's differentiator is less about integrations or YAML and more about treating ordinary scripts as the product surface.
