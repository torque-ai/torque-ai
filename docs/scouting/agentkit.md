# Findings: AgentKit (Inngest)

**Tagline:** Typed TypeScript agent framework for multi-agent networks backed by Inngest durability when deployed.
**Stars:** 836 (GitHub, 2026-04-12)
**Language:** TypeScript (99.8%)

## Feature 1: Typed Agents, Tools, and MCP Surfaces
**What it does:** `createAgent()` defines an agent's name, model, system prompt, tools, and lifecycle hooks in typed TypeScript. `createTool()` accepts either JSON Schema or Zod for parameters, validates model-selected inputs before execution, and can also mount MCP servers so remote MCP tools appear automatically inside the agent.
**Why distinctive:** AgentKit treats tool contracts as part of the framework surface, not just as loose prompt conventions. The combination of Zod/JSON-Schema validation, handler context, and MCP auto-discovery gives TypeScript teams a strongly typed way to expose rich tools without building a separate adapter layer first.
**TORQUE relevance:** HIGH - TORQUE already has a large tool and MCP surface in JavaScript, so AgentKit's approach maps directly onto existing architecture. The most relevant idea is making tool schemas and namespacing first-class at the agent boundary so model-selected actions stay easier to validate, audit, and dispatch safely.

## Feature 2: Networks as the Core Multi-Agent Runtime
**What it does:** `createNetwork()` composes multiple agents into a single execution loop with shared state and a router. A network runs until the router stops it, and each agent inside the same network can use a different model or inference provider.
**Why distinctive:** AgentKit does not model multi-agent behavior as an afterthought or a loose handoff prompt. The network is the primary runtime abstraction, which gives multi-agent collaboration an explicit container with shared context, bounded execution, and orchestration semantics.
**TORQUE relevance:** HIGH - TORQUE has workflows and queued tasks, but it does not yet have a compact runtime abstraction for bounded multi-agent collaboration inside one task. A network-like primitive would fit research, triage, or coding loops where several specialized agents need to cooperate without expanding the outer workflow DAG.

## Feature 3: Router as a First-Class Turn Selector
**What it does:** Routers run after each agent turn and decide whether to call another agent or stop the loop. AgentKit supports code-based routers, routing agents, and hybrid routers, with access to network state, call count, and the last agent result.
**Why distinctive:** Many agent frameworks hide turn selection inside prompts or a manager-agent pattern. AgentKit makes routing an explicit contract, which means developers can move between deterministic, autonomous, and mixed control styles without changing the underlying network model.
**TORQUE relevance:** HIGH - TORQUE already cares deeply about routing, retries, and explicit control flow, so this maps cleanly onto existing design values. Hybrid routers are especially relevant because they allow deterministic guards around LLM-driven delegation instead of forcing an all-or-nothing autonomy model.

## Feature 4: Shared Typed State with Pluggable History
**What it does:** Network state combines message history with fully typed structured data that agents, tools, prompts, and routers can all read and update. Short-term state lives for a single network run, while a history adapter can load and save conversation threads to any backing store so runs resume with prior context.
**Why distinctive:** This is more structured than a normal chat transcript and more flexible than a hardwired memory store. AgentKit separates typed in-run state from persisted history, which makes routing and tool coordination stateful without forcing every application into a single storage model.
**TORQUE relevance:** HIGH - TORQUE currently reconstructs context from task metadata, logs, and outputs, which is workable but coarse. A typed state plus pluggable history model would give TORQUE clearer execution-time state handoff semantics while still allowing durable session or task history to live in its own persistence layer.

## Feature 5: Durable Agent Execution Through Inngest
**What it does:** When an AgentKit network is executed through Inngest, it inherits retries, concurrency and throttling controls, LLM offloading, detailed traces, and support for multi-step tools implemented as Inngest functions. Those tools can use `step.run()`, `step.ai.infer()`, and `waitForEvent()` so agent work can pause, resume, and recover through the durable backend instead of inside ad hoc app code.
**Why distinctive:** AgentKit's agent layer is intentionally thin where durability matters most. Rather than reinventing workflow recovery inside the framework, it composes agents, routers, and tools with Inngest's execution engine so long-running and failure-prone agent operations inherit production-grade behavior.
**TORQUE relevance:** HIGH - This is the strongest lesson for TORQUE because it mirrors the platform's own durable-orchestration ambitions. AgentKit shows how to expose retries, waits, and traceability through agent primitives while leaving the heavy durability contract to the underlying execution runtime.

## Verdict
AgentKit is most interesting as an agent layer on top of durable orchestration, not as a generic chat-agent SDK. Its strongest ideas for TORQUE are typed tool and state contracts, first-class routing, and a network abstraction that can inherit durable execution semantics from the backend instead of reimplementing them inside the agent framework itself.
