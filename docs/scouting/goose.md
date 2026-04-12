# Findings: Goose

**Tagline:** your native open source AI agent - desktop app, CLI, and API - for code, workflows, and everything in between.
**Stars:** 41.2k
**Language:** Rust

## Feature 1: Recipes with automation contracts
**What it does:** Goose recipes are reusable YAML/JSON workflows bundling prompts, extensions, settings, parameters, and optional `response` JSON schema plus `retry` checks and `on_failure` commands.
**Why distinctive:** It treats reusable agent flows as versionable automation artifacts, not just saved prompts, so the same file can be shared, scheduled, validated, and consumed by tooling.
**TORQUE relevance:** HIGH - TORQUE already has verify gates and scheduled tasks; a recipe-like spec could make them easier to share, parameterize, and run outside the dashboard or API.

## Feature 2: Subrecipes become isolated callable tools
**What it does:** A main recipe registers subrecipes in `sub_recipes`; Goose turns each one into a callable tool, runs it in a separate session, and passes fixed or context-derived parameters back into the parent flow.
**Why distinctive:** This gives workflow decomposition without forcing a separate orchestration DSL. Isolation is explicit, but composition stays lightweight and prompt-friendly.
**TORQUE relevance:** HIGH - TORQUE workflows already decompose work into nodes, but "subworkflow as tool" semantics would make reusable expert steps easier to compose inside a larger routed run.

## Feature 3: Native parallel subrecipe fan-out
**What it does:** Goose can run repeated or explicitly requested subrecipes concurrently across up to 10 workers, with task IDs, per-run status, and live completed/running/failed counts in the CLI dashboard.
**Why distinctive:** Parallelism is embedded in recipe execution rather than bolted on through a separate queue, script, or CI wrapper.
**TORQUE relevance:** MEDIUM - TORQUE already supports workflows and parallel agents, but Goose's prompt-driven fan-out pattern could be a lighter-weight option for batchable substeps.

## Feature 4: Lead/worker multi-model handoff
**What it does:** Goose can start with a stronger lead model for planning, switch to a cheaper worker for execution, and automatically fall back to the lead when the worker produces broken code, hits permissions, or gets corrected.
**Why distinctive:** The routing policy reacts to observed task quality, not just provider availability or a static workflow assignment.
**TORQUE relevance:** MEDIUM - TORQUE already routes across providers, but a failure-aware planner/executor handoff could sharpen cost control inside long-running coding tasks.

## Feature 5: MCP extension platform with workspace and UI awareness
**What it does:** Goose treats extensions as MCP servers, supports MCP Roots so tools inherit the active workspace, can render MCP Apps inline, and malware-scans external extensions before activation.
**Why distinctive:** It combines tool ecosystem reach, workspace scoping, operator-facing UI, and a basic trust gate in one surface.
**TORQUE relevance:** MEDIUM - TORQUE already has MCP tools, but inline app rendering and extension trust checks could improve dashboard and operator UX more than core orchestration.

## Verdict
The two features most worth porting are recipe-level automation contracts and isolated subrecipes-as-tools. Recipes would give TORQUE a portable workflow spec with structured outputs plus retry and verification hooks, while subrecipes would make reusable expert subflows much easier to compose inside a larger routed run. Lead/worker handoff is useful, but it overlaps more with TORQUE's existing multi-provider routing than the first two features.
