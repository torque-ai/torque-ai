# Findings: Letta

**Tagline:** Stateful agent platform with self-editing long-term memory and persistent agents.
**Stars:** 22k (GitHub, 2026-04-11)
**Language:** Python (99.5%)

## Feature 1: Core, Recall, and Archival Memory Hierarchy
**What it does:** Letta splits memory into core memory blocks that stay in context, recall memory for older conversation history, and archival memory for semantically searchable long-term knowledge. Agents can update pinned memory directly and query older material through `conversation_search` and `archival_memory_search` when needed.
**Why distinctive:** This is more explicit than a generic "chat history plus RAG" design. Letta gives the agent separate storage tiers with different visibility and retrieval semantics, then lets the agent decide how to use them through tool calls.
**TORQUE relevance:** HIGH - TORQUE persists workflow and task state, but it does not expose a memory model that long-running agents can actively manage. A similar split could let factory agents keep current decisions in pinned memory, search prior run history as recall memory, and retain durable project lessons in archival memory.

## Feature 2: Sleep-Time Memory Consolidation
**What it does:** Letta can attach a background sleep-time agent that shares memory blocks with a primary agent and asynchronously updates those blocks from conversation history or other data sources. The background agent runs every N steps, so learned context can be refreshed without requiring the foreground interaction loop to stop and summarize.
**Why distinctive:** Memory consolidation becomes its own runtime behavior rather than a manual summarization trick. That gives Letta a built-in path for reflection and memory curation between active interactions, which is unusual in open-source agent stacks.
**TORQUE relevance:** HIGH - TORQUE workflows often span long periods, retries, and operator interventions, so background consolidation is directly useful. A sleep-time pattern could turn completed runs, failures, and approvals into reusable memory without bloating the live workflow context.

## Feature 3: Persistence-by-Default Agent State
**What it does:** Letta persists memories, messages, reasoning, tool calls, and agent state in a database, and checkpoints agent state at each step of the reasoning loop. The same agent can then be retrieved by ID and resumed across REST, ADE, Python, and TypeScript interfaces.
**Why distinctive:** Letta treats agents as long-lived services instead of in-process objects that disappear with the client. Recovery, pause/resume, and cross-interface continuity are part of the platform model, not an afterthought.
**TORQUE relevance:** HIGH - TORQUE already has durable workflow metadata, so Letta is relevant as a richer agent-state layer on top of that foundation. Persistent agents could remember architecture choices, prior failures, and operator preferences across separate factory runs instead of relearning them from scratch.

## Feature 4: Memory-Aware Context Management
**What it does:** Letta explicitly manages scarce context by pinning core memory, tracking external memory outside the context window, and maintaining a recursive summary as message history grows. Older messages can be evicted from active context while still remaining searchable through tools and APIs.
**Why distinctive:** The framework exposes context composition and compaction as first-class behavior rather than hiding truncation behind opaque middleware. That makes it easier to reason about what the model currently sees and how continuity is preserved over long interactions.
**TORQUE relevance:** HIGH - TORQUE accumulates logs, outputs, and decisions quickly, but it does not yet compile that history into a disciplined working set for agents. Letta's approach is a strong reference for keeping workflow context small while preserving a searchable history and a continuously updated summary.

## Feature 5: Tools-as-Functions for Memory Access
**What it does:** Letta represents tools as JSON-schema functions and gives agents built-in memory tools such as `memory_insert`, `memory_replace`, `memory_rethink`, `conversation_search`, and `archival_memory_search`. Server-side tools can execute sandboxed code, while MCP and client-side tools still present the same callable schema to the model.
**Why distinctive:** Memory is not hidden behind framework internals or client code. The agent accesses and edits memory through the same first-class function-calling interface it uses for other actions, so memory management becomes part of the reasoning loop itself.
**TORQUE relevance:** HIGH - TORQUE already has strong tool dispatch and MCP surfaces, so this pattern maps cleanly onto the existing control plane. Memory-aware tools would let TORQUE agents read prior decisions, write new lessons, and query historical workflow context using the same invocation model as other orchestrated actions.

## Verdict
Letta is most relevant to TORQUE as a reference architecture for durable agent memory, not just as another agent framework. The three ideas worth borrowing first are the explicit memory hierarchy, per-step persistence, and background sleep-time consolidation. Together they suggest a credible path for giving TORQUE factory workflows memory across sessions without replacing TORQUE's existing workflow engine.
