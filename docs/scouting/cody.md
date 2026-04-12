# Findings: Cody

**Tagline:** Search-native coding assistant built on Sourcegraph's code graph and multi-repo search.
**Stars:** 3.8k (GitHub, checked 2026-04-12)
**Language:** TypeScript

## Feature 1: Code Graph-Backed Context Retrieval
**What it does:** Cody augments LLM prompts with Sourcegraph Search plus Code Graph data, which describes definitions, references, symbols, and doc comments. Instead of treating code as plain text, it uses indexed structural relationships and precise code navigation data to find relevant context across large codebases.
**Why distinctive:** This is the part most assistants do not have: a mature code intelligence backend already built to answer where something is defined, referenced, or documented. Cody is not adding code search as a side tool; the assistant is standing directly on Sourcegraph's existing graph and search substrate.
**TORQUE relevance:** HIGH - Plan 17 repo map and Plan 49 symbol search point in the same direction, but Cody shows how much stronger the result gets when chat and retrieval are built on symbol, reference, and definition data instead of file snippets alone. For TORQUE, this argues for making graph-backed context a default input to agent work rather than a separate utility.

## Feature 2: First-Class Context Providers
**What it does:** Cody documents multiple context sources: keyword search, the Sourcegraph Search API, Code Graph, and local workspace indexing via `symf`. Those providers are used together to retrieve context from both local and remote codebases, rather than hidden behind one opaque retriever.
**Why distinctive:** The important design choice is that retrieval is treated as a named system with different modes, costs, and strengths. Cody can use local indexing for workspace speed, remote search for organization-wide reach, and graph data when structural relationships matter.
**TORQUE relevance:** HIGH - TORQUE already has a split between local repo state, server-side repo map knowledge, and API-backed search. Cody is a concrete model for making those retrieval paths explicit and composable so tasks can choose the right context source instead of overusing one generic search pass.

## Feature 3: `@`-Mention Context as a Primary UX
**What it does:** Cody lets users `@`-mention files, symbols, repositories, directories, web URLs, and, for enterprise users, remote files or directories. The same mention model appears in chat and in prompt authoring, so users can deliberately scope what the assistant sees.
**Why distinctive:** Many assistants support attached files or broad repo context, but Cody turns context selection into a unified, object-level interaction model. Mentioning a symbol, repository, or remote directory is a cleaner interface to a code intelligence backend than pasting raw files into a prompt.
**TORQUE relevance:** HIGH - TORQUE could expose repos, symbols, plans, workflow artifacts, and remote resources through one consistent mention surface instead of separate flags and tool calls. That would make multi-repo and multi-artifact prompting much more controllable for both operators and agents.

## Feature 4: Prompt Library with Dynamic Context
**What it does:** Cody's Prompt Library stores built-in and organization-shared prompts, supports tagging and promotion, and lets prompt authors embed dynamic context like current selection, current file, current repository, current directory, and open tabs. Prompts can also include specific `@` mentions for symbols, files, repositories, and URLs.
**Why distinctive:** This is more than slash commands. Cody treats prompts as reusable organizational assets that can carry both fixed instructions and runtime-resolved context, which makes them closer to parameterized workflows than plain snippets.
**TORQUE relevance:** HIGH - TORQUE could turn recurring operator flows into shared prompt assets tied to current repo state, selected task, or artifact sets. That is especially relevant for scouting, review, and triage workflows where the instruction stays stable but the context must resolve at run time.

## Feature 5: Enterprise Multi-Repo Awareness
**What it does:** Cody supports repo-based context across multiple repositories on all major clients, can start from Sourcegraph code search results with repo or file context already attached, and lets admins apply context filters to include or exclude repositories. Enterprise users can also add remote repositories or directories as context.
**Why distinctive:** Cody assumes the real unit of work in large organizations is not a single checkout but a Sourcegraph instance spanning many repos, branches, and code hosts. The assistant is therefore built for cross-repo awareness, permissions, and governance from the start rather than as a repo-local tool that later bolted on remote context.
**TORQUE relevance:** HIGH - This maps directly to TORQUE's repo-map and symbol-search ambitions. If TORQUE wants to coordinate work across services, plugins, and infrastructure repos, Cody is a strong example of making cross-repo retrieval and repo-level policy part of the core product rather than an advanced add-on.

## Verdict
Cody's standout idea is not simply AI in the IDE; it is using Sourcegraph's search and code intelligence stack as the assistant's native context engine. The most valuable lessons for TORQUE are the graph-backed retrieval layer, a unified `@` context surface, and treating multi-repo enterprise context as a default operating mode. Compared with more config-centric assistants, Cody is strongest where code search, symbol and reference data, and organizational context need to scale together.
