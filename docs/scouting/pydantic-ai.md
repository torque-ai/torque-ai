# Findings: Pydantic AI

**Tagline:** Typed Python agent framework that validates LLM outputs and reprompts on schema or semantic failures.
**Stars:** 14.2k (GitHub, 2026-04-12)
**Language:** Python

## Feature 1: Model-Agnostic Agent Surface
**What it does:** Pydantic AI exposes one `Agent` surface across many providers and OpenAI-compatible endpoints instead of making the application code speak each vendor's dialect directly. Its structured output layer can use tool-output mode, native JSON-schema mode, or prompted schema mode depending on what the target model supports.
**Why distinctive:** The portability story is not just "swap one client for another." It separates the typed contract you want from the provider-specific mechanism used to enforce it, which makes structured-output behavior more adaptable across heterogeneous model fleets.
**TORQUE relevance:** HIGH - TORQUE already routes across multiple providers, so a similar abstraction could keep typed task/result contracts stable while the underlying provider, transport, or fallback path changes. The output-mode split is especially relevant for preserving reliability when one provider supports tool calling and another only supports schema-prompted JSON.

## Feature 2: Pydantic-Validated Response Contracts
**What it does:** The `output_type` can be a Pydantic model, dataclass, `TypedDict`, scalar, collection, or union, and Pydantic AI generates schema plus validates the model's returned data against that type. The same mechanism also preserves typing on the result object, so downstream code consumes structured values instead of reparsing strings.
**Why distinctive:** This makes validation the primary boundary of an agent run rather than a best-effort parser bolted on afterward. Compared with DSPy-style typed signatures, the emphasis here is runtime enforcement of real Python validation rules and schema constraints, not just declaration of the contract.
**TORQUE relevance:** HIGH - Plan 23 already points toward typed task signatures, and Pydantic AI suggests how to make those signatures operationally meaningful at runtime. TORQUE could validate agent outputs into concrete objects before handing them to workflow state, review steps, or follow-on tools.

## Feature 3: Validator-Driven Retry Loop
**What it does:** If structured output validation fails, Pydantic AI feeds the error back to the model and asks it to try again. It also lets output validators raise `ModelRetry` after semantic or IO-backed checks, and tool argument validation errors are returned to the model so the call can be corrected instead of immediately failing the run.
**Why distinctive:** The important idea is that validators are not passive gatekeepers. They participate in an active repair loop, so schema violations, bad SQL, or malformed tool arguments can become precise corrective feedback rather than terminal errors.
**TORQUE relevance:** HIGH - This is the clearest idea TORQUE does not already get from DSPy-style signatures alone. Validator-driven retries could improve task-result repair, tool-call correction, and verify-gate remediation before a node is marked failed or escalated to a human.

## Feature 4: Typed Dependency Injection via RunContext
**What it does:** `deps_type` declares a typed dependency container that is passed at run time and surfaced through `RunContext` inside instructions, tools, and output validators. The same dependency channel can be overridden in tests, which makes agent behavior easier to stub without rewriting application code.
**Why distinctive:** Dependencies are explicit Python values, not hidden framework state or prompt-time magic. That gives the model-facing parts of the system access to databases, clients, and config through one typed path that remains inspectable and testable.
**TORQUE relevance:** HIGH - TORQUE workers, tool wrappers, and verification steps often need structured access to runtime context such as DB handles, credentials, or tenant settings. A `RunContext`-style dependency channel would make those inputs explicit across prompts, tools, and validators while staying easier to mock in tests.

## Feature 5: Structured Streaming and Typed Graph Runtime
**What it does:** Pydantic AI can stream partially validated structured outputs as they arrive, with validators able to distinguish partial from final output via `RunContext.partial_output`. For more explicit orchestration, its graph APIs add typed state, typed deps, and typed return values, and the beta graph builder supports branching, parallel execution, joins, and reducers.
**Why distinctive:** Many frameworks stream only raw tokens, or they bolt on a separate workflow engine with a different programming model. Pydantic AI keeps incremental structured data and typed control flow in the same family of abstractions, which makes it easier to grow from a single validated agent to richer typed subflows.
**TORQUE relevance:** HIGH - Partial structured streaming maps cleanly to live task status, incremental machine-readable results, and richer operator UIs in TORQUE. The graph APIs are also a useful reference for typed in-process orchestration patterns when TORQUE needs finer-grained AI substeps than a coarse workflow node.

## Verdict
Pydantic AI is not a workflow scheduler replacement for TORQUE, but it is a strong reference for making LLM steps runtime-safe instead of merely type-annotated. The most transferable idea is the validator-driven retry loop: validate with Pydantic and domain logic, feed precise failures back to the model, and only surface a final object once it passes. Typed dependencies and structured streaming strengthen that same pattern, while the graph APIs show how richer typed AI subflows could fit beside TORQUE's broader workflow engine.
