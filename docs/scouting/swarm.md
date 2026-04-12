# Findings: OpenAI Swarm

**Tagline:** Minimal client-side framework for prompt-native agent handoffs.
**Stars:** 21.3k (GitHub, 2026-04-12)
**Language:** Python (100.0%)

## Feature 1: Agents Double as Routines
**What it does:** In Swarm, an `Agent` is just `instructions`, `functions`, model settings, and the ability to hand off. The README explicitly notes that an agent can represent a role, a workflow, a retrieval step, or a single transformation, with only the active agent's system prompt present at any given time.
**Why distinctive:** Swarm collapses "agent", "workflow step", and "task" into one primitive instead of layering roles, planners, routers, and state machines. That makes the Agent + Routine model feel closer to programmable prompt modules than to a heavyweight multi-agent runtime.
**TORQUE relevance:** HIGH - TORQUE's Plan 26 crew work and Plan 88 router could benefit from a smaller abstraction for lightweight delegations. For bounded routing or specialist-step flows, a single prompt-plus-tools object is easier to reason about than a separate crew DSL plus router logic.

## Feature 2: Routines Are Plain Prompts with Soft Structure
**What it does:** The OpenAI cookbook defines a routine as a natural-language list of steps in a system prompt plus the tools needed to finish them. Swarm leans on the model to follow those steps, including conditionals, rather than forcing developers to encode every branch as rigid code.
**Why distinctive:** OpenAI explicitly frames the payoff as simplicity, robustness, and "soft" adherence: the model can steer through edge cases without getting trapped in a brittle graph. That is a different design center from frameworks that default to explicit planners, role chats, or workflow DAGs.
**TORQUE relevance:** MEDIUM - This is a strong fit for small operator assistants, triage flows, and prompt-first routers where hard durability is not the main concern. TORQUE should not replace durable workflows with this pattern, but it can use it as the minimal layer above Plan 88 routing decisions.

## Feature 3: Function Return Values Are the Handoff Mechanism
**What it does:** Swarm treats handoff as an ordinary function call: if a tool returns an `Agent`, `client.run()` switches the active agent and continues. A function can also return a `Result` object that combines a normal tool value with a new agent and context updates.
**Why distinctive:** There is no separate delegation protocol, router object, or graph edge type. Routing is collapsed into the same primitive as tool execution, which keeps the model surface tiny while still letting the LLM decide when to call `transfer_to_*` functions.
**TORQUE relevance:** HIGH - This is the cleanest Swarm idea for TORQUE. Plan 88 router behavior could be expressed as normal callable transitions instead of special orchestration machinery, and Plan 26 crew prototypes could adopt the same return-an-agent pattern for specialist escalation.

## Feature 4: `context_variables` Provide Shared, Hidden Working State
**What it does:** `client.run()` accepts a `context_variables` dict that is available both to instruction callables and to agent functions. Functions can update that dict via `Result`, and the runtime injects `context_variables` into Python callables while stripping it out of the tool schema shown to the model.
**Why distinctive:** This gives Swarm a lightweight shared memory channel without introducing hosted threads, retrieval layers, or a heavyweight state store. Because the values are passed out-of-band, agents can share structured context without forcing the model to emit or manage that state as part of the tool JSON.
**TORQUE relevance:** HIGH - TORQUE could use a similar scratchpad for short-lived routed sessions, especially where providers or tools need shared execution context but not full persisted workflow variables. It is a pragmatic middle ground between stateless prompts and database-backed workflow state.

## Feature 5: The Runtime Is Intentionally Tiny and Stateless
**What it does:** Swarm's core loop is explicit: get a completion, execute tool calls, switch agent if needed, update context variables, and stop when there are no more function calls. The project also emphasizes that Swarm runs almost entirely on the client and stores no state between calls; `swarm/core.py` is only 258 LOC, with the rest of the package split across tiny helper files.
**Why distinctive:** The point is educational transparency, not platform breadth. Swarm is small enough that you can inspect the whole orchestration kernel directly, which makes it easy to understand, fork, and test compared with framework-sized agent stacks.
**TORQUE relevance:** MEDIUM - TORQUE is a control plane with persistence, routing, retries, and audit concerns that Swarm does not try to solve. But as a minimal reference implementation, Swarm is useful pressure against over-design in Plan 26 and Plan 88 experiments: if a routing pattern needs pages of orchestration glue, it may be heavier than it needs to be.

## Verdict
Swarm is most valuable as a design reference for the smallest useful multi-agent runtime, not as a production orchestration layer. OpenAI now points production users to the Agents SDK, which reinforces that this repo should be read as an educational artifact. The key ideas worth borrowing into TORQUE are routine-as-prompt, function-as-handoff, and `context_variables` as a lightweight shared state channel. For Plan 26 crew and Plan 88 router work, Swarm is the minimal educational alternative: keep TORQUE's durability and scheduling, but simplify small agent flows until they look closer to Swarm than to a framework stack.
