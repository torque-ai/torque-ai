# Findings: Inspect AI

**Tagline:** Safety-lab evaluation framework for composable, sandboxed, and oversight-aware LLM testing.
**Stars:** 1.9k (GitHub, 2026-04-12)
**Language:** Python (99.7%)

## Feature 1: Task / Solver / Scorer Primitives
**What it does:** Inspect centers evaluations on a `Task` that combines dataset, solver, scorer, and optional sandbox, approval, metrics, and execution limits. Solvers define the execution plan, can be chained or swapped independently, and range from prompt engineering to agent scaffolds; scorers then judge the resulting output with their own metrics.
**Why distinctive:** Compared with Promptfoo's config-first prompt matrix, DeepEval's metric and test-case focus, and Braintrust's experiment object, Inspect makes execution strategy and grading strategy separate first-class primitives. That gives it a sharper abstraction boundary for agentic evals, because you can vary elicitation or tooling behavior without redefining the benchmark itself.
**TORQUE relevance:** HIGH - This maps cleanly onto Plan 70 and Plan 79. TORQUE could treat `Task` as the experiment spec, `Solver` as the execution or autonomy policy, and `Scorer` as the judge layer, which is a stronger architecture than mixing workflow logic and evaluation logic in one object.

## Feature 2: Mixed Scorer Stack With Multiple Choice, Model Grading, and Expert Review
**What it does:** Inspect ships deterministic scorers such as `match()`, `exact()`, and `choice()`, plus model-graded scorers such as `model_graded_qa()` and `model_graded_fact()`, including multi-model voting. It also supports rescoring existing logs and audited score edits with provenance and history, so expert review can be layered on after automated grading.
**Why distinctive:** Promptfoo and DeepEval both support LLM judges, and Braintrust has reusable scorers, but Inspect is unusually strong at keeping extraction, grading, rescoring, and human correction inside one log-centric workflow. That matters for safety work, where the right answer is often partly rubric-based and partly dependent on later expert review rather than a single up-front assertion.
**TORQUE relevance:** HIGH - TORQUE needs a scorer mix, not one judge style. Inspect shows how deterministic checks, model graders, multiple-choice evaluation, and expert overrides can coexist in one auditable artifact instead of being split across scripts, dashboards, and manual review notes.

## Feature 3: Sandboxed Agent Evals and Cybersecurity Orientation
**What it does:** Inspect can run tool-using agents inside isolated sandboxes, with built-in Docker support and extension-backed environments including Kubernetes. Its standard tools include Bash, Python, browser, and computer-use surfaces, and the Inspect Cyber extension adds patterns for agentic cyber evaluations, adaptable sandboxing, evaluation variants, and solvability verification.
**Why distinctive:** This is the clearest place where Inspect separates itself from Promptfoo, DeepEval, and Braintrust. Those systems mainly score outputs or traces; Inspect is designed to let agents act inside controlled environments where side effects, host topology, and containment are part of the benchmark.
**TORQUE relevance:** HIGH - TORQUE already orchestrates agents that touch tools, shells, browsers, and remote systems. Inspect's sandbox model is directly relevant if TORQUE wants safety-lab-grade experiments rather than only passive output evaluation, especially for higher-risk MCP or autonomy scenarios.

## Feature 4: Approval Policies as a Runtime Primitive
**What it does:** Inspect supports human and custom approvers at the eval or task level, with policies mapped to tool names, globs, and even argument prefixes for specific tool actions. Approval decisions are richer than simple allow/deny: they can approve, modify, reject, escalate, or terminate a sample.
**Why distinctive:** Most eval frameworks treat oversight as external harness code or a product permission setting. Inspect instead makes operator governance part of the evaluation runtime, which is much closer to how safety teams study dangerous capability boundaries and supervised autonomy.
**TORQUE relevance:** HIGH - This is highly portable to TORQUE's eval plans. Approval policies would let TORQUE test different autonomy levels and intervention schemes explicitly, rather than forcing one global trust model for every workflow, tool, or provider.

## Feature 5: Transcript-First Log Viewer and Replay-Style Inspection
**What it does:** Inspect View gives a live view of running evaluations and a per-sample drill-down across messages, scoring, metadata, and a transcript tab that records model calls, tool calls, tool sub-transcripts, task-state patches, scorer interactions, and custom spans. The same structured logs can be streamed, rescored, edited, and published later.
**Why distinctive:** Braintrust is stronger on experiment management and comparison, but Inspect goes deeper on execution anatomy. Compared with Promptfoo and DeepEval, it feels more like a debugger for agent runs than a report generator, which is exactly what you need when evaluating tool use, failures, or unsafe action chains.
**TORQUE relevance:** HIGH - TORQUE has workflow/task telemetry, but not a unified eval transcript that merges model actions, tool events, and scoring decisions in one replayable artifact. Inspect's log viewer is one of the strongest references here for experiment forensics, postmortems, and operator trust.

## Verdict
Inspect AI stands out less as a generic eval dashboard and more as a safety-lab execution runtime for controlled, auditable agent evaluation. The most transferable ideas for TORQUE are the Task / Solver / Scorer split, the sandbox plus approval model for risky tool use, and the transcript-first log system that keeps automated scoring and expert review in one place. Compared with Promptfoo, DeepEval, and Braintrust, it is the strongest reference when the evaluation target is an acting agent rather than just a text response.
