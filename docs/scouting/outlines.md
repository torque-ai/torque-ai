# Findings: Outlines

**Tagline:** Pre-hoc structured generation by constraining token emission.
**Stars:** 13.7k (GitHub, 2026-04-12)
**Language:** Python

## Feature 1: FSM-Guided Decoding at Generation Time
**What it does:** For steerable models, Outlines converts the requested `output_type` into a reusable logits processor and applies it during decoding. Instead of generating text freely and repairing it later, the processor masks invalid next tokens so malformed outputs become unproducible at the token step where they would have occurred.
**Why distinctive:** This is the core architectural bet: structure is enforced pre-hoc, not checked post-hoc. Outlines-core explicitly compiles regex and JSON-schema-style constraints into finite-state machinery, while the generator caches the processor so repeated calls reuse the expensive constraint build step.
**TORQUE relevance:** HIGH - Plan 61's Schema-Aligned Parsing is a post-hoc recovery layer, while Outlines is a pre-hoc constraint layer. The two complement each other well: constrain outputs when TORQUE has decoding control, then let Plan 61 verify, normalize, or salvage outputs from providers that remain black boxes.

## Feature 2: Python Types and JSON Schema Compilation as a Common Constraint IR
**What it does:** Outlines maps Python-native types, `Literal`, `Enum`, Pydantic models, dataclasses, `TypedDict`, callables, and explicit JSON Schema objects into a shared `Term` system. Structured types become `JsonSchema` terms, other terms lower through `to_regex()`, and backends compile them either via `build_regex_from_schema` or native schema compilers such as XGrammar's `compile_json_schema`.
**Why distinctive:** The important abstraction is not just "JSON mode"; it is a host-language type system that compiles into decoding constraints. That keeps application code close to ordinary Python typing while still targeting regex, JSON Schema, and grammar backends with one conceptual pipeline.
**TORQUE relevance:** HIGH - TORQUE already thinks in typed task inputs and outputs, and Plan 61 adds schema-aware parsing after the model responds. Outlines suggests a stronger shared-schema design: one contract IR could drive both pre-hoc constrained decoding and post-hoc schema-aligned parsing instead of maintaining separate validation paths.

## Feature 3: Pluggable Structured-Generation Backends for Regex and CFG
**What it does:** Outlines exposes multiple decoding backends: `outlines_core`, `llguidance`, and `xgrammar`. By default JSON Schema and regex route through `outlines_core`, CFG routes through `llguidance`, and callers can override the backend per generation call when they need a different capability set.
**Why distinctive:** Many libraries ship one constrained-decoding engine and make its limitations your problem. Outlines treats the constraint language and the backend implementation as separate concerns, which lets grammar-heavy use cases, regex-heavy use cases, and tokenizer-specific optimizations evolve independently.
**TORQUE relevance:** MEDIUM - TORQUE is not currently a local-model decoding library, so this is not a direct drop-in. The design lesson is still useful: keep task signatures independent from the enforcement backend so future local inference, server-side guidance, and parser-only fallback can coexist behind one contract.

## Feature 4: Multiple-Choice Constraints as First-Class Output Types
**What it does:** Outlines handles closed label sets through `Literal`, `Enum`, and dynamic `Choice(list)` output types. That means classification and routing decisions are expressed through the same constrained-generation pipeline as JSON and regex, rather than as special-case prompt templates plus string matching.
**Why distinctive:** Multiple choice is treated as a genuine decoding constraint, not a convention. The dynamic `Choice` type is especially practical because runtime-generated label sets can still be hard-constrained without abandoning the main type system.
**TORQUE relevance:** HIGH - TORQUE has many enum-like decisions: route selection, approval verdicts, retry categories, severity levels, action kinds. Pre-hoc label constraints would reduce downstream ambiguity, while Plan 61 remains useful as the parser-side safety net when a provider cannot enforce the label set natively.

## Feature 5: Integration Layer Across Transformers, llama.cpp, and vLLM
**What it does:** Outlines presents one `model(prompt, output_type)` interface across local steerable integrations like Transformers and llama.cpp and server-side integrations like vLLM. Under the hood it splits execution cleanly: steerable models receive logits processors directly, while vLLM adapters translate the same output type into request fields such as `guided_json`, `guided_regex`, or `guided_grammar`.
**Why distinctive:** The API is unified without pretending the execution model is unified. Outlines hides heterogeneity behind model-specific type adapters, which makes provider switching cheaper while preserving structured-output intent and backend-specific capabilities.
**TORQUE relevance:** HIGH - TORQUE already spans heterogeneous providers, runtimes, and control levels. Outlines offers a concrete pattern for exposing one typed contract surface while routing execution to local token-level control, provider-native structured generation, or post-hoc parsing depending on what each backend can actually do.

## Verdict
Outlines is most compelling as the pre-hoc half of a structured-output stack: it compiles schemas, regexes, grammars, and finite label spaces into decoding-time constraints instead of hoping a parser can clean things up later. For TORQUE, the highest-value ideas are the shared type-to-constraint pipeline and the adapter split between local steering and provider-native structured generation. Plan 61 still matters because many TORQUE providers will remain partially constrained or fully black-box, so the strongest combined design is pre-hoc constraint where possible and schema-aligned parsing as the universal fallback and normalizer.
