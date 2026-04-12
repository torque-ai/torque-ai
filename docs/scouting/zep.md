# Findings: Zep

**Tagline:** Graph-first memory layer that turns changing user context into a temporal knowledge graph.
**Stars:** 4.4k (GitHub, 2026-04-12)
**Language:** Python (69.6%)

## Feature 1: Graphiti Temporal Fact Model
**What it does:** Zep is powered by Graphiti, which stores facts as graph edges with lifecycle timestamps such as `created_at`, `valid_at`, `invalid_at`, and `expired_at`. Its memory context and graph APIs can surface not just what is true, but when a fact became true and when it stopped being true.
**Why distinctive:** This is the clearest difference versus Letta and mem0: Zep is not primarily a memory hierarchy or a vector-backed recall service with graph extras. The temporal graph is the core data model, so history, state changes, and point-in-time reasoning are first-class rather than inferred after the fact.
**TORQUE relevance:** HIGH - TORQUE deals with state that changes over time: task ownership, workflow status, provider health, retry outcomes, approvals, and incident facts. A Graphiti-style edge model would let TORQUE ask what was true at a given moment instead of flattening everything into the latest summary.

## Feature 2: Contradiction-Aware Fact Invalidation
**What it does:** When new data contradicts an older fact, Zep attempts to invalidate the prior edge instead of simply overwriting or deleting it. The old fact remains in history with an `invalid_at` timestamp, while new facts are added to reflect the updated state.
**Why distinctive:** Letta emphasizes self-editing agent memory, and mem0 emphasizes extracted memories plus retrieval, but neither centers contradiction handling as a graph primitive in the same way. Zep's model is closer to a durable fact timeline, where superseded truth is preserved and explicitly marked rather than silently replaced.
**TORQUE relevance:** HIGH - TORQUE frequently sees facts change: blockers resolve, fixes get reverted, ownership moves, incidents reopen, and recommendations are superseded. Preserving those reversals explicitly would improve postmortems, operator trust, and any future memory layer that needs to reason about stale versus current guidance.

## Feature 3: Episode-Based Entity and Fact Extraction
**What it does:** Zep ingests chat messages, text, and JSON as episodes, then extracts entities and relationships into the graph while preserving episode provenance. In Graphiti, episodes are nodes too, which means facts can be traced back to the source interaction or business event that introduced them.
**Why distinctive:** This is more graph-native than "save a memory string" or "embed a summary." Compared with Letta's agent-managed memory tools and mem0's memory middleware, Zep treats extraction, provenance, and later retrieval as parts of one graph pipeline instead of separate layers.
**TORQUE relevance:** HIGH - TORQUE already produces rich episodes in the form of task transcripts, reviews, CI failures, workflow events, and operator actions. Converting those into sourced entities and edges would support better traceability than today's mostly document- and log-shaped history.

## Feature 4: User-Level Graphs with Session and Namespace Scoping
**What it does:** Zep keeps a unified graph per user across all of that user's sessions, while sessions remain the conversation boundary used for message history and relevance. It also supports non-user group graphs and Graphiti-style `group_id` namespaces for shared or isolated memory spaces.
**Why distinctive:** Mem0 also has strong identifier scoping, but Zep's version is more opinionated around a longitudinal user graph that integrates evidence across sessions and then uses the current session only to decide what to retrieve. That makes it less agent-centric than Letta and more graph-centric than mem0's mainly storage-and-retrieval framing.
**TORQUE relevance:** HIGH - TORQUE needs both durable identity memory and isolated working context: operator-level preferences, project-level shared knowledge, and run-level temporary state. Zep's split between user graph, session relevance, and namespaced shared graphs maps cleanly onto those layers.

## Feature 5: Custom Ontologies for Typed Extraction and Retrieval
**What it does:** Zep lets developers define custom entity and edge types with Pydantic-like models, assign those as project ontology, constrain valid source and target types, and then search or filter on those types later. The result is a graph whose extraction and retrieval behavior can be shaped around domain concepts rather than generic nodes and edges.
**Why distinctive:** This goes beyond metadata tags. Compared with Letta and mem0, Zep offers a stronger path to domain-shaped memory where schema influences what gets extracted, how relationships are typed, and how retrieval can be filtered back down to the exact class of fact you care about.
**TORQUE relevance:** HIGH - TORQUE could define typed entities such as Task, Workflow, Provider, Incident, Review, or VerificationGate and typed edges such as blocks, approved_by, failed_on, or supersedes. That would make memory retrieval more actionable and safer than generic semantic recall over free-form notes.

## Verdict
Zep is most interesting to TORQUE not as another generic memory API, but as a reference for temporal, contradiction-aware graph memory. The strongest ideas to borrow are Graphiti's time-aware edges, explicit fact invalidation, and ontology-shaped extraction, because those create a more reliable model of changing operational truth than either Letta's agent-state focus or mem0's retrieval-centric memory layer. If TORQUE ever moves toward durable memory, Zep is the clearest example of a graph-first design that treats time and contradiction as core semantics rather than cleanup problems.
