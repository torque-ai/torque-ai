# Findings: Aider

**Tagline:** AI pair programming in your terminal.
**Stars:** 43.2k
**Language:** Python

## Feature 1: Repository Map
**What it does:** Aider sends a concise repo-wide map of files, key classes, functions, signatures, and other high-value symbols with each change request. It dynamically adjusts the map size to fit the active token budget and can expand it when no files are yet in context.
**Why distinctive:** This is more than generic context stuffing or vector search. Aider uses a dependency-aware graph ranking approach to decide which parts of the codebase deserve prompt budget, which is a pragmatic way to keep whole-repo awareness useful in large codebases.
**TORQUE relevance:** HIGH — TORQUE already routes tasks across multiple providers, so a repo-map layer would improve prompt quality, reduce wasted context, and make scout/worker runs more reliable on larger projects.

## Feature 2: Architect/Editor Dual-Model Mode
**What it does:** In architect mode, a main model proposes the solution and a second editor model turns that proposal into concrete file edits. Aider can also use the same model twice, effectively giving it a reasoning pass and an edit pass.
**Why distinctive:** It explicitly separates planning from patch generation inside one user interaction. That is stronger than basic model fallback because it treats reasoning quality and edit precision as different capabilities that can be composed on purpose.
**TORQUE relevance:** HIGH — this maps directly onto TORQUE’s multi-provider routing and compute/apply direction, and would let TORQUE pair strong planners with faster or cheaper code editors without forcing users to hand-build that workflow every time.

## Feature 3: In-File AI Comments with `--watch-files`
**What it does:** Aider can watch the repo for `AI`, `AI!`, and `AI?` comments embedded directly in source files, then gather those comments across one or many files to trigger edits or answer questions. The instructions stay attached to the exact code being discussed.
**Why distinctive:** It turns the codebase itself into an event-driven prompt surface. That is a notably lower-friction intake model than switching to a separate chat or dashboard every time, especially for multi-file refactors being sketched in an IDE.
**TORQUE relevance:** MEDIUM — this would be a strong IDE or local-intake feature for TORQUE, but it is less central than runtime/orchestration improvements like better context management or model composition.

## Feature 4: Prompt Caching with Keepalive Pings
**What it does:** Aider organizes prompts so stable layers like the system prompt, read-only files, repository map, and editable files can be cached by supported providers. It can also send periodic keepalive pings to stop the cache from expiring between turns.
**Why distinctive:** The cache strategy is explicit and context-aware rather than being left entirely to provider behavior. That makes long coding sessions faster and cheaper without changing the user workflow.
**TORQUE relevance:** HIGH — TORQUE workflows often revisit stable context across multiple steps or retries, so cache-aware orchestration could reduce cost and latency meaningfully for providers that expose prompt caching.

## Feature 5: Closed-Loop Lint/Test Remediation
**What it does:** Aider can automatically lint changed files, run tests or build commands after edits, and then try to fix failures from the command output. It also lets users run commands manually and feed runtime errors back into the chat for immediate repair.
**Why distinctive:** Many systems stop at verification. Aider closes the loop by making tool output part of the edit cycle so the agent can remediate issues before the user has to start a separate debugging round.
**TORQUE relevance:** HIGH — TORQUE already has verify gates, and this points to a strong extension: optional per-task auto-remediation before a task or workflow is marked failed.

## Verdict
The two features most worth porting into TORQUE are the repository map and the architect/editor split. The repository map would raise the quality of nearly every task by giving providers better whole-repo awareness at a controlled token cost, while the architect/editor split would turn TORQUE’s multi-provider routing into a more deliberate planner-plus-editor execution model instead of just a provider selection step. Prompt caching is the next most attractive follow-on because it compounds the value of both features by making repeated workflow steps cheaper.
