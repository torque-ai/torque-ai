# Findings: LangMem

**Tagline:** Long-term memory library for LangGraph agents that learns facts, experiences, and better prompts.
**Stars:** 1.4k (GitHub, 2026-04-12)
**Language:** Python (99.4%)

## Feature 1: Semantic, Episodic, and Procedural Memory Model
**What it does:** LangMem organizes long-term memory by cognitive role rather than one generic bucket. Semantic memory can be stored as collections or current-state profiles, episodic memory captures successful interaction traces with context and rationale, and procedural memory treats system instructions as something that can evolve from feedback.
**Why distinctive:** Letta's core/recall/archival model is mainly about storage visibility and context placement, mem0 is centered more on scoped extraction and retrieval, and Zep is centered on temporal graph facts. LangMem is unusual because it frames memory around what the agent is learning: facts, reusable experiences, and behavior rules, with first-class support for procedural memory instead of treating prompts as fixed configuration.
**TORQUE relevance:** HIGH - TORQUE would benefit from splitting durable knowledge into project facts, successful remediation playbooks, and agent behavior rules rather than dumping everything into one history store. This model is a better fit for factory agents that need to remember not just what happened, but how to act next time.

## Feature 2: Active and Background Memory Formation
**What it does:** LangMem supports both hot-path memory tools that the agent calls during a live interaction and background reflection flows that extract and consolidate memory after the exchange. The background path can also be debounced with `ReflectionExecutor`, so memory work waits for a conversation to settle instead of firing on every turn.
**Why distinctive:** Letta also has background consolidation, but it is tied to Letta's own persistent agent runtime. mem0 leans more toward always-on extraction middleware, and Zep leans toward ingestion into a graph; LangMem makes the latency versus recall tradeoff explicit and exposes both modes on the same library surface.
**TORQUE relevance:** HIGH - TORQUE needs immediate writes for critical operator preferences and low-latency agent guidance, but it also needs slower reflective extraction from task transcripts, CI failures, and review comments. LangMem's dual-mode design maps cleanly onto that split.

## Feature 3: Prompt Optimization as Procedural Memory
**What it does:** `langmem.create_prompt_optimizer` updates prompts from trajectories, edits, scores, and free-form feedback, with multiple optimization strategies including `metaprompt`, `gradient`, and `prompt_memory`. LangMem also supports multi-prompt optimization that attributes team performance to individual prompts before recommending changes.
**Why distinctive:** Letta, mem0, and Zep mostly focus on storing and retrieving facts or interaction history. LangMem stands out because it uses memory to rewrite agent behavior itself, turning prompt maintenance into a learning loop instead of leaving prompts as static hand-authored text.
**TORQUE relevance:** HIGH - TORQUE already accumulates exactly the data this needs: failed runs, review comments, revised outputs, and operator feedback. A LangMem-style optimizer could continuously harden task prompts, reviewer prompts, and multi-agent role prompts instead of relying on manual prompt tuning.

## Feature 4: Functional Core with Optional LangGraph Store Integration
**What it does:** LangMem's core APIs transform memory state without depending on any particular database, while its higher-level store managers and tools plug into LangGraph's `BaseStore` for persistence, search, and updates. That gives developers a stateless extraction and optimization layer and a separate stateful integration layer.
**Why distinctive:** Letta, mem0, and Zep are more opinionated memory systems or services with their own durable runtime assumptions. LangMem is more library-shaped: memory logic is reusable without adopting a full memory backend, but LangGraph users still get a ready-made persistence path.
**TORQUE relevance:** MEDIUM - TORQUE does not use LangGraph's store directly, so the exact API is not portable as-is. The architectural split is still relevant because TORQUE could separate memory inference logic from persistence and orchestration instead of baking both into one subsystem.

## Feature 5: Namespace-Driven Multi-Tenancy and Shared Memory Layouts
**What it does:** LangMem stores memories in hierarchical namespaces, and those namespaces can include runtime template variables like `{user_id}` or `{org_id}`. The same pattern supports per-user isolation, organization-wide shared memory, and mixed layouts where one tool writes to a narrow namespace while another searches a broader shared scope.
**Why distinctive:** mem0 and Zep both support scoping, but LangMem exposes hierarchical namespace templates directly in the memory tools and store managers instead of centering everything on one fixed user or session abstraction. Compared with Letta's agent-centric persistence, this is a more explicit storage-topology model for multi-tenant apps.
**TORQUE relevance:** HIGH - TORQUE naturally has identities like project, workflow, task, operator, provider, and org. LangMem's namespace model is a strong reference for isolating workflow-local lessons while still letting project-wide or user-wide memories be shared intentionally.

## Verdict
LangMem is most interesting as a memory library for agents that need to learn different kinds of things, not just retrieve more context. Its biggest differentiators for TORQUE are procedural memory via prompt optimization, the explicit hot-path and background split, and namespace-driven tenancy on top of a storage-optional core. If Letta is a persistent agent runtime, mem0 is memory middleware, and Zep is temporal graph memory, LangMem is the clearest example of memory as an embeddable learning layer for LangGraph-style agents.
