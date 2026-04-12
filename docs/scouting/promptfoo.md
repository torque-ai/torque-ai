# Findings: Promptfoo

**Tagline:** Developer-first CLI and config framework for LLM evals, assertions, red teaming, and CI checks.
**Stars:** 20.0k (GitHub, 2026-04-12)
**Language:** TypeScript (97.0%)

## Feature 1: Config-Driven Prompt/Model/Test Matrix
**What it does:** Promptfoo's core config runs each prompt against a set of providers and test cases, producing a prompt-model-test matrix in the CLI and web viewer. Suites can be defined in YAML, split across files, or generated in JavaScript and TypeScript, with prompts, vars, and tests loaded from local files, CSV, Google Sheets, or generated code.
**Why distinctive:** Many LLM eval products center on dashboards first and code second. Promptfoo makes the matrix itself the default abstraction, so cross-model and cross-prompt regression testing feels like normal fixture-driven development rather than a separate observability workflow.
**TORQUE relevance:** HIGH - TORQUE has no native eval framework yet, and Promptfoo's declarative matrix model is immediately relevant to prompt, provider, and workflow regression coverage. A similar config surface would let TORQUE compare task plans or model routes before rollout instead of relying on ad hoc manual checks.

## Feature 2: Broad Assertion Catalog Under One Schema
**What it does:** Promptfoo supports deterministic assertions like `contains`, regex, and JSON/XML/SQL validation, semantic similarity via embeddings, and custom JavaScript or Python assertions loaded inline or from files. It also supports negation, weighted assertions, named metrics, and custom scoring so one test case can express several quality dimensions at once.
**Why distinctive:** The value is the breadth of the catalog combined with one consistent config shape. Teams can mix cheap mechanical checks with semantic and custom logic without leaving the same evaluation format or building a separate harness for each assertion family.
**TORQUE relevance:** HIGH - TORQUE will need both cheap guards and task-specific quality checks if it adds evals for prompts, agents, and tool traces. Promptfoo shows a practical layering strategy: start with deterministic rules, then add embeddings and custom code only where simple checks are insufficient.

## Feature 3: First-Class Model-Graded Evals
**What it does:** Promptfoo exposes LLM-as-a-judge assertions such as `llm-rubric`, `search-rubric`, `model-graded-closedqa`, `factuality`, `g-eval`, and `select-best`. Graders can be overridden at the CLI, suite, or assertion level, and several checks expect structured outputs such as JSON score objects or factuality categories.
**Why distinctive:** Judge prompts are treated as first-class infrastructure instead of throwaway glue code. The framework also spans several judge modes, from general rubric scoring to web-assisted verification and reference-based factuality checks, which makes model-graded evals feel operational rather than experimental.
**TORQUE relevance:** HIGH - This is the clearest pattern TORQUE could reuse for scoring open-ended task outputs that cannot be verified with string matching alone. If TORQUE adds revision benchmarking or post-task quality gates, Promptfoo's judge model is a stronger starting point than inventing bespoke graders per workflow.

## Feature 4: Configurable Red-Team Scanning
**What it does:** Promptfoo's `redteam` config separates targets, plugins, strategies, purpose, contexts, and grading examples, then uses commands like `promptfoo redteam run` and `promptfoo redteam report` to generate adversarial inputs and score the results. The docs describe 131 plugins across risk categories plus strategy layers such as jailbreak, composite jailbreaks, hydra, encoding tricks, and framework filtering for OWASP, NIST, MITRE, GDPR, and related standards.
**Why distinctive:** This is much more systematic than collecting a few jailbreak prompts in a spreadsheet. Promptfoo decomposes adversarial testing into reusable generators, delivery strategies, and compliance/reporting structure, which makes red teaming repeatable and configurable.
**TORQUE relevance:** HIGH - TORQUE orchestrates agent and tool workflows that will eventually need adversarial and safety regression coverage, especially around MCP tools, remote agents, and prompt-driven actions. Promptfoo is a strong reference for how to represent attack packs, contexts, and standards-aligned findings in config rather than hard-coded one-off tests.

## Feature 5: Result Caching and CI-Native Execution
**What it does:** Promptfoo caches provider responses on disk by provider, prompt content, provider configuration, and context variables, with a default 14-day TTL, explicit cache clearing, and `--no-cache` cache busting. Its GitHub Action can run before-vs-after prompt evaluations on pull requests, reuse the cache directory, and post a link to the web viewer back on the PR.
**Why distinctive:** Evals are designed for repeated local iteration, not only occasional benchmark runs. Cost and latency controls are part of the normal workflow, which makes it realistic to run suites on every prompt edit instead of treating evals as a one-time exercise.
**TORQUE relevance:** HIGH - Any TORQUE eval layer will need caching or daily usage becomes too slow and expensive. Promptfoo also demonstrates a clean adoption path: use the same suites locally first, then promote them into PR-time CI checks without inventing a separate integration surface.

## Verdict
Promptfoo is one of the strongest reference points for a future TORQUE eval subsystem because it combines tests-as-code ergonomics with judge-based scoring, adversarial scanning, and CI integration in one workflow. The most transferable ideas are the declarative matrix config, the unified assertion catalog, and the clear separation between ordinary quality evals and red-team suites. If TORQUE wants native evals, Promptfoo is the closest existing model to copy structurally rather than just feature-by-feature.
