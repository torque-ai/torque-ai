# Findings: TensorZero

**Tagline:** Open-source LLMOps stack that turns one Rust gateway into the control plane for inference, traces, optimization, and evals.
**Stars:** 11.2k (GitHub, 2026-04-12)
**Language:** Rust (78.9%)

## Feature 1: Gateway + Observability in One Runtime
**What it does:** TensorZero’s Rust gateway is the serving path for inference and the collection point for observability data. The same runtime exposes a unified API for major model providers, records structured traces, and stores feedback and metrics so they are available programmatically or in the UI.
**Why distinctive:** Most products in this space split the gateway and the tracing system into separate components, which means application identity has to be stitched back together after the fact. TensorZero’s stronger idea is that the normalization layer and the observability dataset come from the same execution boundary, so routing, traces, feedback, and later optimization all speak the same function and variant vocabulary.
**TORQUE relevance:** HIGH - TORQUE already has plans around tracing and caching, but TensorZero shows the value of putting telemetry at the execution boundary rather than bolting it on later. If TORQUE ever expands from orchestration into a more opinionated inference control plane, this is the cleanest reference for making runtime data immediately usable for debugging, experiments, and optimization.

## Feature 2: Functions-and-Variants as Config
**What it does:** TensorZero models an application as functions and variants defined in `tensorzero.toml`. A function names the task or agent surface, while variants capture the concrete implementation details such as model, prompt templates, decoding strategy, inference-time optimization, and fallback or experiment behavior.
**Why distinctive:** This is more than prompt templating or model aliases. TensorZero treats the stable application contract as config, then lets prompts, models, and inference strategies vary beneath it, which keeps experiments and optimizations attached to a durable function identity instead of scattering them through SDK code.
**TORQUE relevance:** HIGH - TORQUE already has routing templates, workflow definitions, and task metadata, but it does not have an equally sharp abstraction for “one logical task, many competing implementations.” TensorZero’s function/variant split is a strong reference if TORQUE wants revisions, experiments, and provider strategy changes to stay legible and GitOps-friendly.

## Feature 3: Schema-Enforced Structured Inference
**What it does:** TensorZero supports `json` functions that enforce output schemas and can optionally constrain inputs and decoding behavior through modes like `strict` and `tool`. The gateway can keep a fixed schema in configuration or accept a dynamic schema at inference time, while still returning results through an OpenAI-compatible interface.
**Why distinctive:** Many tools offer structured output helpers at the SDK edge, but TensorZero pushes the contract into the gateway and ties it to the function definition. That means provider swaps, retries, and experiments can preserve a typed interface, and the resulting traces remain structured enough to feed later optimization workflows instead of collapsing into plain text logs.
**TORQUE relevance:** HIGH - TORQUE’s task execution and tool pipelines would benefit from stronger typed input and output contracts, especially anywhere caching, verification, or downstream automation depends on stable shapes. TensorZero is a useful reference for making structure a runtime guarantee instead of a best-effort parsing convention.

## Feature 4: Optimization Loops from Production Traces
**What it does:** TensorZero collects historical inferences plus downstream metrics and natural-language feedback, then uses that dataset to drive optimization recipes. Built-in flows include supervised fine-tuning, dynamic in-context learning, automated prompt optimization, and custom recipes that generate new variants from the accumulated trace data.
**Why distinctive:** The distinctive part is not “it can fine-tune models,” which overlaps with other tools. TensorZero’s differentiator is the closed loop from live traffic to curated training data to new deployed variants, with prompt templates and feedback already linked to the exact function and variant that produced them.
**TORQUE relevance:** HIGH - TORQUE already captures rich execution outcomes, so the natural next step is deciding how those outcomes improve future runs. TensorZero is one of the clearest examples of turning production traces into a learning flywheel for prompts, models, and inference strategy instead of treating logs as something operators only inspect manually.

## Feature 5: Episode-Level Workflow Evaluation
**What it does:** TensorZero groups multiple inference calls into episodes that share a common downstream outcome, and it lets feedback attach at either the individual inference or the episode level. Its evaluation model mirrors that split: inference evaluations benchmark one variant, while workflow evaluations assess multi-step systems that can include several TensorZero calls plus arbitrary application logic.
**Why distinctive:** This is a better fit for real LLM systems than request-by-request scoring alone. TensorZero explicitly models the unit that product teams usually care about, such as a resolved ticket or completed workflow, and uses that same episode identity to keep experiments consistent and optimization grounded in end-to-end outcomes.
**TORQUE relevance:** HIGH - TORQUE is fundamentally workflow-centric, so episode-level thinking maps directly onto its core model. TensorZero is a strong reference for how TORQUE could score, compare, and eventually optimize whole task or workflow runs instead of only evaluating isolated model invocations.

## Verdict
TensorZero is most interesting where Portkey, Langfuse, and Refact stop short: it binds gateway traffic, typed interfaces, observability, optimization, and workflow-level evaluation into one application model. The strongest ideas for TORQUE are the function/variant abstraction, schema-first inference, and the closed loop from production traces to better implementations. If TORQUE wants tracing and caching to become a broader runtime learning system rather than just operator tooling, TensorZero is a high-value reference.
