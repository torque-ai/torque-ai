# Findings: BAML

**Tagline:** DSL-first prompt engineering with schema-aware parsing and generated clients.
**Stars:** 8k (GitHub, 2026-04-12)
**Language:** Rust (67.5%)

## Feature 1: Prompt-Native DSL and `baml_src` Boundary
**What it does:** BAML defines AI work in its own source layer: `class` and `enum` schemas, typed `function` declarations, `client` bindings, Jinja-templated prompts, and `test` blocks under `baml_src`. Application code stays in Python, TypeScript, or Ruby while the prompt contract lives in checked-in `.baml` files and compiles into a generated client.
**Why distinctive:** Many structured-output tools stop at runtime validation inside the host language. BAML instead gives prompts their own typed authoring surface and filesystem boundary, so prompt contracts, provider configuration, and tests become first-class source artifacts.
**TORQUE relevance:** HIGH - Plan 23 is already about typed task signatures, and BAML shows what that looks like when the signature is authored in a compact DSL instead of being buried in provider-specific code. A TORQUE layer with explicit input/output signatures, provider annotations, and checked-in prompt artifacts would be easier to diff, review, and govern.

## Feature 2: Schema-Aligned Parsing (SAP)
**What it does:** SAP is BAML's parser-centric structured-output algorithm. Instead of assuming perfect JSON or native tool-calling support, it uses the target schema to repair malformed outputs, strip extra prose, coerce near-miss values, and recover typed results from messy model text.
**Why distinctive:** The key move is to put robustness in the parser rather than in vendor-specific output modes. That lets BAML support structured outputs on day one of a new model release and tolerate errors like missing punctuation, wrong container shapes, or reasoning text wrapped around the answer.
**TORQUE relevance:** HIGH - Typed task signatures only help if the runtime can salvage near-valid outputs instead of failing every imperfect response. A SAP-like layer would make TORQUE's provider routing less dependent on whichever model currently has the cleanest native schema mode.

## Feature 3: Checked-In Test Blocks and Assertions
**What it does:** BAML lets developers add `test` blocks next to functions, pass realistic arguments or multimodal files from `baml_src`, and use `@@check` and `@@assert` predicates over the result, latency, and prior checks. The same tests run in the playground or via `baml-cli test`, and production generation can exclude them with `generate --no-tests`.
**Why distinctive:** This is more than unit tests around a wrapper. The prompt contract, example inputs, and behavioral assertions live in the same DSL artifact, which makes prompt regressions reviewable in git and keeps IDE experiments aligned with CLI execution.
**TORQUE relevance:** HIGH - TORQUE currently treats verification as a separate phase, while BAML suggests embedding expectations beside the signature itself. For Plan 23, task definitions that carry sample invocations and assertions would produce a much sharper review artifact than free-form prompt notes.

## Feature 4: IDE Playground with Prompt Transparency
**What it does:** The VSCode extension renders the fully expanded prompt, shows the raw cURL/API request, offers starter test snippets that match a function signature, saves regression cases, and can run tests in parallel. It gives developers an in-editor loop for inspecting prompt shape and output behavior without jumping into a separate web console.
**Why distinctive:** The important part is not just that a playground exists, but that it is attached directly to the checked-in DSL file. Developers can inspect exactly what `ctx.output_format` expands to and debug the real request shape from the same artifact that later generates production clients.
**TORQUE relevance:** MEDIUM - TORQUE has workflow and task introspection, but not a tight authoring loop for typed AI contracts. An editor-linked preview surface for task signatures, rendered prompts, and sample outputs would reduce trial-and-error when designing AI-backed nodes.

## Feature 5: Multi-Language Generated Clients on One Runtime Core
**What it does:** BAML supports multiple `generator` blocks and emits `baml_client` code for targets including Python/Pydantic, TypeScript, and Ruby/Sorbet. One BAML definition compiles into native-feeling functions and types, while SAP and core parsing logic live in a shared Rust runtime exposed to each language binding.
**Why distinctive:** This is not just SDK generation from an HTTP schema. BAML preserves one prompt-and-schema source of truth while projecting it into strongly typed clients for several host languages, keeping parsing semantics and function behavior aligned across stacks.
**TORQUE relevance:** HIGH - TORQUE already spans JavaScript runtime surfaces and could eventually expose typed task signatures to multiple consumers. BAML's split between one declarative source and many generated clients is a credible reference for serving the same task contract to Node, Python workers, and external integrations without rewriting validation logic.

## Verdict
BAML is most interesting where it stops treating structured output as a runtime helper and instead treats prompt contracts as a compiled source artifact. The highest-value ideas for TORQUE are the DSL boundary, checked-in signature tests, and a parser layer like SAP that makes typed task signatures resilient across providers. The IDE playground and multi-language client generation make that model practical for day-to-day engineering instead of just conceptually clean.
