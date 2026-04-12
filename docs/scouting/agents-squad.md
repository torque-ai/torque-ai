# Findings: Agents Squad

**Tagline:** Classifier-first framework for routing user turns into specialist agents.
**Stars:** 7.6k (GitHub, 2026-04-12)
**Language:** Python (63.8%)

## Feature 1: Classifier-First Turn Routing
**What it does:** Agent Squad puts an intent classifier in front of every user turn. The classifier inspects the current input plus conversation history across all agents and the agents' descriptions/capabilities, then selects the specialist agent that should handle the turn; built-ins include Bedrock, Anthropic, and OpenAI classifiers.
**Why distinctive:** The routing primitive is not "who speaks next inside a crew" but "which specialist owns this end-user turn." Versus TORQUE's Plan 88 code/llm/hybrid router, Agent Squad treats routing as a dedicated front-door classification stage that is tightly coupled to agent descriptions and follow-up detection.
**TORQUE relevance:** HIGH - This is a strong complement to Plan 88 rather than a replacement. TORQUE could use a classifier-first entry router for chat, support, or onboarding surfaces, then hand the selected specialist into a crew, workflow, or provider path only after ownership is clear.

## Feature 2: Unified Agent Abstraction
**What it does:** All agents implement a shared `processRequest` or `process_request` contract that receives `userId`, `sessionId`, `chatHistory`, and `additionalParams`, and returns either a normal message or a streaming iterable. That lets Bedrock LLMs, Lex bots, Bedrock Agents, Lambda functions, OpenAI or Anthropic agents, local processing, and custom integrations plug into the same orchestrator surface.
**Why distinctive:** This is broader than a model adapter layer: the abstraction wraps whole conversational endpoints, not just prompt calls. Compared with Plan 88 roles, an Agent Squad "agent" can be an external bot or API-backed specialist with its own execution semantics while still looking identical to the router.
**TORQUE relevance:** HIGH - TORQUE already normalizes providers at the execution layer, but not as a first-class conversational specialist interface. Borrowing this pattern would make it easier to expose Bedrock, remote agents, MCP-backed tools, or internal services as interchangeable routed assistants above the existing runtime.

## Feature 3: Pluggable ChatStorage and Scoped Session Memory
**What it does:** Conversation storage is explicit orchestration infrastructure, with in-memory, DynamoDB, SQL, and custom backends. History is keyed by `userId`, `sessionId`, and `agentId`, so each specialist keeps its own transcript while the classifier can still assemble a cross-agent view for the current user/session.
**Why distinctive:** This is a sharper memory model than a single shared transcript. Versus Plan 88's shared turn history, Agent Squad preserves specialist-local memory and global routing context at the same time, which helps with short follow-ups like "again" or "tell me more" without leaking all context into every agent prompt.
**TORQUE relevance:** HIGH - TORQUE could use the same split for routed assistant sessions: classifier/global view for ownership, per-specialist windows for cleaner prompts and lower token cost. The backend-swappable storage layer also maps well to local development versus durable production deployments.

## Feature 4: Orchestrator-Level Streaming and Fallback
**What it does:** The orchestrator owns `routeRequest` or `route_request`, dispatches to the selected agent, saves user and assistant messages, and can return either standard responses or streaming output. It also supports retries, configurable routing/classification error messages, and a default agent fallback when no specialist is selected.
**Why distinctive:** Streaming, fallback, and memory writes live in the orchestration kernel instead of being reimplemented per agent. Plan 88 decides the next speaker inside a crew, but Agent Squad packages the front-door UX behavior around routing itself: choose, stream, persist, and recover.
**TORQUE relevance:** HIGH - This is directly relevant for any TORQUE chat surface or MCP-style conversational endpoint. A small orchestration layer above provider routing could centralize default-handler behavior, response streaming, and persistence instead of scattering them across agent or tool implementations.

## Feature 5: AWS-First Defaults, Not AWS-Only
**What it does:** The quickstart assumes AWS authentication and defaults to Bedrock for both classification and agent responses, which makes the project feel native to AWS shops. At the same time, the docs ship OpenAI and Anthropic classifiers and agents, local or Ollama examples, Lex or Lambda integrations, and custom extension points.
**Why distinctive:** Many AWS Labs projects are effectively tied to Bedrock end to end; Agent Squad is opinionated toward AWS but structurally open to non-AWS model and execution backends. Relative to Plan 88, this is less about provider scoring and more about giving one routed multi-agent API surface to mixed backends.
**TORQUE relevance:** MEDIUM - TORQUE is already provider-flexible, so this is not a gap in principle. The useful lesson is product shape: AWS-native defaults can coexist with real escape hatches, which matters if TORQUE ever wants a packaged enterprise or AWS-first routed assistant stack.

## Verdict
Agent Squad's most distinctive idea is the classifier-first architecture that routes end-user turns using cross-agent conversation history, not just a next-speaker policy inside a crew. The two best takeaways for TORQUE are the front-door classifier plus per-specialist memory split, and the way the orchestration kernel centralizes streaming, fallback, and storage semantics. Plan 88 and Agent Squad solve adjacent problems: Plan 88 is a crew-turn router, while Agent Squad is a conversational specialist router with session memory.
