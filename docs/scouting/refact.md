# Findings: Refact

**Tagline:** Self-hosted coding assistant that combines local inference, repo-aware RAG, fine-tuning, and an IDE-native agent.
**Stars:** 3.5k (GitHub, 2026-04-11)
**Language:** Rust (47.0%)

## Feature 1: Self-Hosted Inference Hub
**What it does:** Refact can run as a self-hosted server in Docker with GPU support, exposing a web UI on port `8008` and persisting configuration, weights, and logs in a mounted volume. From that control plane, operators can choose local models, shard a model across `1`, `2`, or `4` GPUs, share a GPU across smaller models, or enable third-party APIs such as OpenAI and Anthropic.
**Why distinctive:** This is more than a plugin pointed at a model endpoint. Refact treats model hosting, deployment shape, and IDE connectivity as one product surface, so the same installation governs local models, external APIs, and plugin routing through a custom inference URL.
**TORQUE relevance:** HIGH - TORQUE already routes work across local Ollama hosts and cloud APIs, so Refact's model-hosting surface is directly relevant as a reference control plane. The useful idea is not just "self-hosting" but the explicit operator knobs for local-vs-external inference, GPU placement, and per-environment endpoint configuration.

## Feature 2: IDE-Resident AST and VecDB Indexing
**What it does:** Refact's IDE-side runtime keeps AST indexes and a vector database up to date as the developer edits code and switches branches. That index then powers symbol-aware tools such as `definition`, `references`, and `tree`, plus semantic `search` over the codebase.
**Why distinctive:** The retrieval layer is not described as a static server-side embedding job; it is a continuously refreshed code intelligence layer living close to the editor. That lets Refact combine exact structural lookups through AST with fuzzy semantic retrieval through VecDB, which is a stronger base for both answering questions and planning edits.
**TORQUE relevance:** HIGH - TORQUE's current repo intelligence is stronger at workflow/task routing than at live codebase retrieval. A similar split between structural lookup and semantic search could improve context stuffing, patch planning, and provider selection for code-heavy tasks.

## Feature 3: RAG-Backed Completion and Chat
**What it does:** Refact's completion path uses fill-in-the-middle prediction around the cursor, while RAG can be enabled by turning on syntax parsing and the embedded VecDB search path in the plugin. In enterprise/self-hosted setups, the docs pair this with `starcoder2` completion models and a separate embedding model such as `thenlper/gte-base` when VecDB search is enabled.
**Why distinctive:** Refact treats repo-aware completion as a configurable inference stack, not just a larger prompt window. The product explicitly distinguishes the generator model from the retrieval/indexing path, and it calls out the operational cost of indexing in GPU, RAM, and CPU terms.
**TORQUE relevance:** MEDIUM - TORQUE is not an inline completion product, so the editor UX itself is not portable. The architectural lesson is still useful: retrieval, embedding, and generation should be treated as separate subsystems with separate resource and routing decisions.

## Feature 4: Fine-Tune-to-Serve Loop
**What it does:** Refact lets operators create a project, ingest training data from Git repositories or uploaded files, scan and filter files, then launch fine-tuning jobs with GPU selection and optional embedding training for large codebases. After training, the resulting LoRA is attached back onto the matching base model in Model Hosting, and enterprise teams can assign different completion models per project.
**Why distinctive:** The loop covers curation, training, monitoring, checkpoint inspection, and deployment in one workflow instead of leaving those steps to separate MLOps systems. It is opinionated about code-specific dataset filtering and about keeping the fine-tuned artifact as a patch on top of a selected base model.
**TORQUE relevance:** HIGH - TORQUE's provider routing becomes more valuable if teams can cheaply specialize local models for their own repos or stacks. Refact's project-scoped fine-tune flow is a concrete example of how local model adaptation could feed back into routing policy and per-project defaults.

## Feature 5: Agent Mode vs Completion Mode
**What it does:** Refact separates lightweight completion from a heavier autonomous agent workflow. Completion is a fast FIM-style assist path with caching and manual force-trigger support, while Agent Mode runs through IDE chat, gathers context, proposes patches for approval, can execute shell commands, and can call integrations such as GitHub, GitLab, Docker, PostgreSQL, MySQL, Chrome, and Pdb.
**Why distinctive:** Many coding products blur "assistant" and "agent" together. Refact makes the operational boundary visible: low-latency inline prediction on one side, and tool-using, approval-gated, rollback-capable automation on the other.
**TORQUE relevance:** HIGH - This maps cleanly onto TORQUE's own need to separate cheap assistive behavior from task-executing orchestration. The strongest takeaway is the explicit mode boundary and approval model, which helps keep autonomous actions legible and governable instead of hiding them behind the same UI path as completion.

## Verdict
Refact is most interesting as an integrated stack: IDE-side code intelligence, a self-hosted inference control plane, and an agent layer that sits above plain completion rather than replacing it. For TORQUE, the biggest transferable ideas are the split between retrieval and generation, the operator-facing control plane for local and external models, and the explicit boundary between suggestion mode and action mode. The main difference is product center of gravity: Refact starts from the IDE and works outward, while TORQUE starts from orchestration and runtime routing.
