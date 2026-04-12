# Findings: Argo Workflows

**Tagline:** Kubernetes-native workflow engine with YAML-defined DAGs, reusable templates, and first-class artifacts.
**Stars:** 16.6k (GitHub, 2026-04-11)
**Language:** Go (85.1%)

## Feature 1: Workflow vs WorkflowTemplate as YAML-Native Contracts
**What it does:** Argo models a `Workflow` as the live Kubernetes object that both defines execution and stores workflow state, while a `WorkflowTemplate` is a reusable cluster-scoped or namespace-scoped definition that can be referenced or submitted later. Both use the same YAML-first shape of `entrypoint` plus `templates`, so authors can describe either steps or DAGs declaratively.
**Why distinctive:** The distinction is cleaner than a generic "saved workflow" feature because Argo separates the running instance from the reusable definition without inventing a different authoring model for each. That makes GitOps, review, and promotion natural: a reusable template library still looks like the same contract as a submitted workflow.
**TORQUE relevance:** HIGH - TORQUE already has DAG execution, but its workflow definitions are more handler- and database-centric than author-facing. Argo's split between live `Workflow` instances and reusable `WorkflowTemplate` definitions suggests a practical path to add reviewable workflow specs and reuse without conflating runtime state with authored definitions.

## Feature 2: Parameter Substitution as the Wiring Language
**What it does:** Argo lets workflows provide `arguments`, templates declare `inputs`, and downstream steps or DAG tasks bind values using substitutions such as `{{inputs.parameters...}}`, `{{steps...}}`, `{{tasks...}}`, and `{{workflow.parameters...}}`. Output parameters can be emitted from files or standard output and then fed into later arguments, loops, or conditionals.
**Why distinctive:** Parameters are not just environment-variable sugar around containers; they are the native orchestration language for connecting nodes in YAML. This keeps data dependencies explicit in the spec instead of burying them in shell scripts or application code.
**TORQUE relevance:** HIGH - TORQUE passes strings and JSON between tasks, but it does not have a comparably uniform substitution model for authored DAGs. A first-class parameter wiring layer would make TORQUE workflows easier to read, safer to compose, and less dependent on per-handler conventions.

## Feature 3: Artifact Passing Between Steps
**What it does:** Steps and DAG tasks can emit named output artifacts and bind them as input artifacts for later nodes, with an artifact repository backing larger payloads. Argo treats files and directories as addressable workflow outputs, not just incidental pod filesystem state.
**Why distinctive:** Many orchestrators handle small parameters well but leave non-trivial file handoff to shared volumes, bespoke object-store code, or ad hoc conventions. Argo makes artifact lineage part of the contract, which is especially strong for ML, data, and build pipelines where intermediate files matter as much as scalar parameters.
**TORQUE relevance:** HIGH - TORQUE has no first-class artifact passing layer, so larger intermediate outputs require custom storage conventions and extra glue. Argo's artifact model points directly at a missing TORQUE primitive for durable file handoff, provenance, and downstream binding.

## Feature 4: Suspend/Resume Gates
**What it does:** Argo can suspend a workflow manually from the CLI or API, or through a `suspend` template embedded inside the workflow itself, then resume later manually or after a duration. This gives the workflow author a declarative way to represent approvals, wait windows, and external checkpoints.
**Why distinctive:** The pause is part of the workflow specification rather than an out-of-band operator trick. That means human approval steps and timed holds can live inside the same YAML contract as the rest of the DAG or step sequence.
**TORQUE relevance:** MEDIUM - TORQUE can block on awaits and operator actions, but it does not expose a built-in declarative gate node in workflow definitions. A suspend primitive would fit approval workflows, maintenance windows, and "pause until resumed" operational control more cleanly than bespoke handler logic.

## Feature 5: Exit Handlers with Success/Failure Branching
**What it does:** Argo's `onExit` hook runs a template after the main workflow completes regardless of outcome, and that handler can branch on `{{workflow.status}}` to run success-only or failure-only follow-up steps. Cleanup, notification, compensation, and resubmission logic can therefore live in the workflow definition instead of in an external wrapper.
**Why distinctive:** Exit handling is modeled as normal workflow structure, not as opaque controller callbacks. Because the exit logic is just another template graph, it is versioned, reviewable, and composable with the same parameter and template mechanisms as the main workflow.
**TORQUE relevance:** HIGH - TORQUE would benefit from a first-class finalization phase for cleanup, notifications, and failure-specific follow-up. Status-aware exit handlers would be a cleaner abstraction than scattering teardown logic across task implementations or await paths.

## Verdict
The strongest ideas for TORQUE are Argo's reusable `WorkflowTemplate` layer and its first-class artifact passing, because those map directly to current gaps in TORQUE's workflow model. Argo also shows that a YAML-first contract can stay expressive enough to cover parameter wiring, suspend/resume approvals, and end-of-run cleanup without pushing all orchestration into general-purpose code. The `Workflow` versus `WorkflowTemplate` split is especially worth copying: keep runtime state and reusable definitions separate, but structurally close enough that authors do not have to learn two different systems.
