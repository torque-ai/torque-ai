# Findings: Dust

**Tagline:** Team-shared AI workspace that organizes agents, knowledge, and permissions around spaces and synced connections.
**Stars:** 1.3k (GitHub, 2026-04-12)
**Language:** TypeScript (92.0%)

## Feature 1: Workspace + Spaces Access Model
**What it does:** Dust is built around a workspace that contains open or restricted spaces, with admins deciding what data lives in each space and who can access it. Agent visibility follows the spaces backing its tools and knowledge, while Members, Builders, and Admins get progressively broader powers for using agents, building them, managing folders/API access, and administering connections.
**Why distinctive:** Many agent products treat sharing as a thin layer on top of personal bots. Dust makes team scope, data placement, and agent visibility part of the same model, so access control is attached to the workspace graph itself instead of being bolted on later.
**TORQUE relevance:** HIGH - TORQUE has Plan 38 domains, but Dust is a stronger reference for a truly shared multi-user surface where permissions, knowledge, and reusable assistants live together. If TORQUE wants domain-scoped collaboration instead of mostly operator-centric execution, spaces are the design to study.

## Feature 2: Synced Data Source Registry
**What it does:** Dust exposes a registry of workspace data sources: managed connections such as Slack, Notion, Google Drive, GitHub, and Confluence, plus websites, folders, conversation files, custom connections, and MCP-backed tools. Connections sync automatically, admins pick the specific channels, pages, folders, or repositories to ingest, and spaces decide which subsets become usable by particular teams or agents.
**Why distinctive:** The distinctive part is not connector count alone. Dust treats integrations as governance objects with synchronization, scoped ingestion, and downstream sharing boundaries, which is much more structured than stuffing credentials directly into each assistant.
**TORQUE relevance:** HIGH - TORQUE already thinks in domains, but Dust shows what a richer shared knowledge plane looks like when connectors, sync state, and access policy are first-class. A similar registry would let TORQUE separate data onboarding from task authoring and make shared context less ad hoc.

## Feature 3: Retrieval Modes Over Chunked and Structured Data
**What it does:** Dust's Search tool does semantic retrieval over selected data sources, surfacing the most relevant documents or chunks before the model answers. It complements that with Include Data for reverse-chronological context stuffing, Extract Data for schema-driven passes over up to 500k tokens, and Table Queries for SQL over CSVs, sheets, and discovered tables.
**Why distinctive:** Dust does not pretend one retrieval path fits every question. Its product model explicitly separates chunk-based semantic search for unstructured text from exhaustive extraction and full-table querying, including a clear acknowledgment that chunk retrieval is a poor fit for quantitative questions.
**TORQUE relevance:** HIGH - TORQUE currently emphasizes orchestration more than a full shared knowledge layer. Dust is useful because it shows how retrieval choices become product primitives once domains accumulate documents, tables, and synced activity streams.

## Feature 4: Assistant Builder + Shared Agent Library
**What it does:** Agents in Dust are assembled through a builder pattern: instructions, model selection, tools, and selected knowledge sources. Builders can start from templates, publish agents to the workspace, keep drafts limited to editors, tag them for discovery, and invoke multiple specialized agents in the same conversation.
**Why distinctive:** The key idea is that assistants are treated as shared team assets rather than private prompt presets. Dust couples discoverability, reuse, and operational context so colleagues can inspect an agent's purpose, tools, and usage instead of copying hidden prompts between people.
**TORQUE relevance:** HIGH - TORQUE is stronger on workflow execution than on a shared assistant catalog. Dust is a strong reference if TORQUE wants domain-scoped expert agents, reusable assistant identities, or a workspace library of approved automations.

## Feature 5: Legacy Dust Apps DSL with Explicit Runs
**What it does:** Dust also shipped a declarative app layer where LLM applications are composed from blocks, and the developer API exposes app listing plus create/get run endpoints under workspace and space scopes. That gives apps an explicit execution object instead of burying all logic inside chat interactions.
**Why distinctive:** This is closer to a low-code LLM runtime than a prompt form builder, especially because runs are addressable and permission-scoped like other workspace resources. The caveat is that Dust Apps entered legacy status for new workspaces on October 16, 2025, while existing workspaces and APIs remain available.
**TORQUE relevance:** MEDIUM - The block DSL itself is a weaker long-term reference if Dust is moving away from it, but the explicit run object still matters. TORQUE should care about the way app executions are first-class, inspectable resources attached to workspace and permission boundaries.

## Verdict
Dust is most distinctive not on raw agent capability but on the fact that it treats assistants, knowledge, integrations, and permissions as shared workspace resources. The strongest ideas for TORQUE are spaces-based access control, the synced data-source catalog, and retrieval modes that distinguish chunk search from exhaustive extraction and structured querying. Dust Apps are now a legacy surface, but the run-scoped execution model is still worth studying.
