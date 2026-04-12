# Findings: TypeAgent

**Tagline:** Typed natural-language dispatch built around TypeScript action schemas.
**Stars:** 682 (GitHub, 2026-04-12)
**Language:** TypeScript (81.6%)

## Feature 1: TypeScript Action Schemas as the Dispatch Primitive
**What it does:** TypeAgent agents declare actions in TypeScript schema files, then reference those schemas from their manifests with a `schemaFile` and `schemaType`. The dispatcher uses those typed contracts to translate natural-language requests into concrete action objects with stable `actionName` values and structured parameters.
**Why distinctive:** In most agent stacks, schemas are added late as validation around loosely chosen tools. TypeAgent pushes the schema earlier and harder: the TypeScript action union is the dispatch vocabulary itself, so intent selection, validation, and handler routing all center on the same typed definition.
**TORQUE relevance:** HIGH - TORQUE Plan 23 already moves toward typed signatures, but TypeAgent shows what it looks like when types become the first dispatch abstraction instead of a wrapper around an existing tool layer. That is directly relevant to making TORQUE’s handler and MCP surfaces feel less like freeform tool catalogs and more like a typed action system.

## Feature 2: Translator and Explainer as Separate Stages
**What it does:** The dispatcher first asks the model to translate a request into an action using the registered schemas. After the user accepts that translation, an explainer stage can describe how the mapping worked and feed that explanation into construction-building logic.
**Why distinctive:** This splits stochastic language understanding into explicit phases instead of hiding everything inside one opaque tool-call prompt. The result is a system that is trying to distill model behavior into reusable logical structure, not just repeatedly ask the model to guess the right tool on every turn.
**TORQUE relevance:** HIGH - TORQUE’s Plan 61 SAP and Plan 71 FSM could benefit from a cleaner separation between “translate operator intent” and “execute validated system action.” A translator/explainer pattern would also make repeated workflow and ops requests easier to learn, inspect, and regression-test.

## Feature 3: Deterministic Dispatch to Typed Handlers
**What it does:** Once an action is translated and validated, TypeAgent routes it through `executeAction`, where the agent handles a typed object and switches on `actionName` to run concrete logic. The side-effecting runtime consumes structured data rather than an unbounded model stream.
**Why distinctive:** The probabilistic step ends before execution starts. That creates a harder boundary than token-loose tool calling, because handlers operate on validated objects with known fields instead of trusting ad hoc model text to directly drive runtime behavior.
**TORQUE relevance:** HIGH - TORQUE already needs strong control over workflow mutations, tool invocations, and state transitions. A TypeAgent-style typed execution boundary would fit especially well around Plan 71 FSM transitions and any future privileged actions where freeform tool invocation is too weak a safety model.

## Feature 4: Composable Multi-Agent Dispatcher
**What it does:** TypeAgent’s dispatcher can be hosted in different front ends, and agents plug in through manifests, handlers, and provider registration. The dispatcher can automatically find, switch between, and combine multiple agents whose typed contracts best fit the request.
**Why distinctive:** This is not a single monolithic assistant prompt with a bag of tools. It is a typed routing layer over many agents, with explicit composition points that let the system scale across domains while keeping each agent’s action surface isolated and declarative.
**TORQUE relevance:** HIGH - TORQUE already spans tools, handlers, workflow APIs, factory operations, and MCP transport. TypeAgent’s composition model suggests a cleaner way to group TORQUE capabilities into typed subsystems that can be routed intentionally instead of flattening everything into one global surface.

## Feature 5: Construction Cache and Learned Local Rules
**What it does:** TypeAgent can turn accepted translations plus explanations into cached constructions, which act like local parsing and transform rules. On cache hits, the dispatcher can route requests with near-zero cost and latency, and wildcard validation helps keep cached matches from over-generalizing.
**Why distinctive:** The system is explicitly trying to compile repeated language behavior into deterministic local logic. That makes the cache part of the dispatch architecture, not just a memoization layer bolted onto a generic LLM agent.
**TORQUE relevance:** MEDIUM - This matters after TORQUE has a stronger typed dispatch core, but the payoff could be large for repeated operator commands, workflow management phrases, and common factory actions. It is a credible path to lower latency and lower model spend without giving up natural-language entrypoints.

## Verdict
TypeAgent is most interesting where it treats TypeScript schemas as the actual dispatch substrate, not as optional validation around tool calls. The strongest idea for TORQUE is the combination of typed action unions, a separate translator stage, and a deterministic post-translation execution boundary. TORQUE already has adjacent work in Plan 23, Plan 61, and Plan 71, but TypeAgent pushes typed dispatch much further and shows a plausible architecture for making natural-language control feel more like a compiled protocol than a prompt trick.
