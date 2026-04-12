# Findings: DeepEval

**Tagline:** Python-native LLM evaluation framework built around typed test cases, judge metrics, tracing, and synthetic datasets.
**Stars:** 14.7k (GitHub, 2026-04-12)
**Language:** Python (100.0%)

## Feature 1: Metric Catalog by System Boundary
**What it does:** DeepEval documents 50+ research-backed metrics across custom, RAG, agentic, multi-turn, MCP, safety, and multimodal categories. The catalog spans G-Eval and DAG plus practical checks such as answer relevancy, faithfulness, hallucination, bias, toxicity, contextual precision, contextual recall, contextual relevancy, and tool correctness.
**Why distinctive:** Compared with Promptfoo's broad assertion schema, DeepEval organizes metrics around the boundary being evaluated: final answer, retriever, tool use, conversation, or component. That makes metric choice feel like selecting the right evaluator for a system slice, not just attaching another generic assertion.
**TORQUE relevance:** HIGH - TORQUE has no eval framework yet, so this taxonomy is a useful starting point for separating provider, agent, RAG, MCP, and safety concerns. It is a better reference for evaluator design than a single catch-all judge metric.

## Feature 2: G-Eval as a Reusable Judge Pattern
**What it does:** `GEval` lets developers define a metric with natural-language criteria, explicit `LLMTestCaseParams`, thresholds, optional rubrics, and custom models. The metric then scores outputs from 0 to 1 while preserving a reusable evaluator object instead of burying judge logic inside ad hoc prompts.
**Why distinctive:** The important pattern is not just "LLM as judge" but criteria turned into a named, versionable metric class. Promptfoo also supports model-graded checks, but DeepEval pushes harder on making subjective grading logic a first-class Python artifact that can be refined over time.
**TORQUE relevance:** HIGH - TORQUE will need custom judges for workflow quality, tool routing quality, and output correctness where deterministic assertions are weak. A G-Eval-style metric layer is one of the clearest ideas worth porting.

## Feature 3: `LLMTestCase` plus Component-Level Tracing
**What it does:** `LLMTestCase` is the atomic interaction model and carries fields such as `input`, `actual_output`, `expected_output`, `context`, `retrieval_context`, `tools_called`, `expected_tools`, `token_cost`, and `completion_time`. For complex apps, `@observe` and `update_current_span` let you create test cases at runtime inside retrievers, tool calls, and agent substeps, then run them through pytest-style tests and `deepeval test run` in CI.
**Why distinctive:** This is much more white-box than Promptfoo's prompt-model-test matrix. DeepEval lets teams decide which internal interaction is the actual unit under test, so debugging and regression analysis can happen at the component boundary instead of only at the final output.
**TORQUE relevance:** HIGH - TORQUE tasks, provider calls, tool invocations, and workflow steps already look like the kind of atomic interactions DeepEval models. A similar typed interaction object plus tracing hooks would let TORQUE score both whole runs and internal spans without inventing separate mechanisms.

## Feature 4: Synthetic Goldens and Conversation Simulation
**What it does:** DeepEval includes synthetic data generation for creating goldens from documents, contexts, scratch, or existing goldens, and the docs frame this around state-of-the-art evolution techniques. It also includes a conversation simulator that can turn goldens plus a model callback into multi-turn conversational test cases.
**Why distinctive:** Dataset creation is treated as part of the evaluation framework instead of an external prep step. Compared with Promptfoo's more config and file oriented workflow, DeepEval is notably stronger at bootstrapping Python-native eval suites when you do not already have a curated corpus.
**TORQUE relevance:** HIGH - TORQUE has no native eval corpus, so synthetic goldens are probably the fastest path to first coverage. This matters especially for planner prompts, tool orchestration flows, and support workflows where real labeled data may be thin.

## Feature 5: RAG-Specific Metrics and a Separate Red-Team Layer
**What it does:** DeepEval splits RAG evaluation into generator-facing metrics such as answer relevancy and faithfulness, and retriever-facing metrics such as contextual precision, contextual recall, and contextual relevancy, each requiring different `LLMTestCase` fields like `context` and `retrieval_context`. Its red-teaming docs now point to DeepTeam, a companion framework powered by DeepEval, so adversarial safety testing sits next to the core eval framework rather than inside the same API surface.
**Why distinctive:** This is a sharper RAG decomposition than generic "RAG score" tooling because it separates wrong answers, weak grounding, bad ranking, and noisy retrieval into different evaluators. It is also structurally different from Promptfoo, which keeps red-team features inside the same main product surface.
**TORQUE relevance:** HIGH - If TORQUE evaluates context-heavy agents or retrieval workflows, it will need this same split between retrieval quality and generation quality. The DeepTeam separation is also a useful design signal if TORQUE wants quality evals and adversarial testing to evolve as related but distinct subsystems.

## Verdict
DeepEval is a strong reference if TORQUE wants an in-code Python-style eval framework built around typed interactions, reusable judge metrics, and span-level tracing. The most transferable ideas are the `LLMTestCase` model, G-Eval-style custom metrics, synthetic golden generation, and the explicit RAG metric split. Its red-team story is less all-in-one than Promptfoo because safety testing now sits in DeepTeam, but that separation may actually be the cleaner architecture for TORQUE.
