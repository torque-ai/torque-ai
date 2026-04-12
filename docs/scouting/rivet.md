# Findings: Rivet

**Tagline:** Desktop graph IDE that turns LLM workflows into callable TypeScript artifacts.
**Stars:** 4.5k (GitHub, 2026-04-12)
**Language:** TypeScript (82.4%)

## Feature 1: Graphs as Callable Functions
**What it does:** A Rivet project contains named graphs, and the docs explicitly frame each graph as analogous to a function. Graph Input nodes define arguments, Graph Output nodes define return values, and the same graph can be run in the IDE, invoked as a subgraph, or executed from Node.js.
**Why distinctive:** This is more program-shaped than the usual visual AI builder canvas. Rivet gives graphs stable call boundaries, named ports, and reusable invocation semantics, so the visual artifact behaves more like a typed internal module than a one-off workflow.
**TORQUE relevance:** HIGH - TORQUE already has workflow and handler abstractions, but a callable-graph model would give those units a cleaner authoring surface and stronger input/output contracts. That is especially relevant for a Node.js orchestrator that may want reusable orchestration components instead of only top-level flows.

## Feature 2: Unified LLM, Tool, and Control-Flow Node Runtime
**What it does:** Rivet's built-in nodes span Chat, prompt/text shaping, Code, External Call, Context, User Input, events, and control-flow primitives like Match, If/Else, Race Inputs, and Loop Controller. Under the hood, Rivet documents a two-pass runtime: one pass determines execution order, then a parallel execution pass runs ready nodes and propagates a special `control-flow-excluded` value through skipped branches.
**Why distinctive:** The important part is not just node breadth, but that LLM calls, tool calls, and control flow all share one explicit dataflow model. Rivet exposes enough of the execution semantics that branching, loops, exclusions, and waiting on events feel like first-class graph behavior rather than hidden engine magic.
**TORQUE relevance:** HIGH - TORQUE already coordinates tools, providers, and branching logic, but it does not yet present those pieces as one fine-grained graph runtime. Rivet is a strong reference for how a Node.js orchestrator could make orchestration logic more inspectable without collapsing everything into imperative code.

## Feature 3: Subgraphs as Hierarchical Composition
**What it does:** Any graph can call another graph through a Subgraph node, with the node's ports generated dynamically from Graph Input and Graph Output nodes in the target graph. Authors can also select an existing cluster of nodes and use Create Subgraph to extract it into a new reusable graph.
**Why distinctive:** Rivet treats reuse as graph composition instead of copy-paste. The model is also operationally clean: subgraphs can expose an optional error output, so composition is not only structural but also an explicit failure boundary.
**TORQUE relevance:** HIGH - This maps directly to TORQUE's need for reusable internal orchestration blocks. A subgraph-style abstraction would let TORQUE package recurring provider, tool, and policy sequences as callable modules instead of re-encoding the same flow in multiple workflows.

## Feature 4: Plugin-Defined Nodes and Project-Scoped Extension
**What it does:** Rivet plugins are JavaScript or TypeScript packages published to NPM and enabled per project; they can register new nodes, plugin configuration, and context-menu groups. Rivet also supports locally installed source plugins and ships built-in integration plugins for providers and services such as Anthropic, AssemblyAI, Autoevals, Gentrace, Google, Hugging Face, and Pinecone.
**Why distinctive:** The extension point is the graph language itself, not just a connector catalog. Because plugins add nodes that participate in the same editor and runtime contracts, Rivet can grow new model and tool capabilities without hardcoding every integration into the core application.
**TORQUE relevance:** MEDIUM - TORQUE already has mature tool and plugin surfaces, so the main lesson is not that plugins exist. The more relevant idea is letting extensions add authorable runtime primitives, which matters if TORQUE ever grows a first-class graph editor.

## Feature 5: Embed-as-Library API with Remote Debugging
**What it does:** `@ironclad/rivet-node` and `@ironclad/rivet-core` let a host Node.js app load a Rivet project and run a named graph with inputs, shared context, external functions, user-event callbacks, settings, and abort signals. That same app can start a debugger server so the desktop Rivet IDE can inspect or trigger graph execution remotely over WebSocket.
**Why distinctive:** Many visual builders stop at hosted execution or REST export. Rivet is designed so the authored graph becomes an in-process artifact that a TypeScript application can call like code while still keeping live IDE-grade debugging attached to the host runtime.
**TORQUE relevance:** HIGH - This is the most interesting pattern for TORQUE. TORQUE is already a Node.js orchestrator, so Rivet's embed-and-debug model is a credible blueprint for adding graph-authored orchestration without splitting execution into a separate platform.

## Verdict
Rivet is most compelling as a TypeScript-native graph programming environment, not just another drag-and-drop LLM builder. The ideas most relevant to TORQUE are callable graph contracts, subgraph extraction and reuse, and the embed-plus-remote-debugger loop that keeps authored graphs close to a host Node.js runtime. If TORQUE explores visual authoring, Rivet is a stronger reference than workflow SaaS builders for how to keep the graph layer portable, local, and library-friendly.
