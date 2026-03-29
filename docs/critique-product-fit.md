# TORQUE: Product-Fit Critique

*Through the lens of: "A tool for Claude Code users to expand their bandwidth."*

*Generated 2026-03-23. Companion to [critique-general.md](critique-general.md).*

---

## The Premise

TORQUE positions itself as a Claude Code bandwidth multiplier. The pitch: you're already in Claude Code doing development, but Claude can only do one thing at a time. TORQUE lets Claude dispatch work to other AI providers in parallel — Codex writes your tests while Ollama handles your types while Claude Code stays free for architecture decisions. You become the control tower, orchestrating work across every provider you have.

This is a real problem. Claude Code users *do* hit a throughput ceiling. The question is whether TORQUE is the right shape solution.

## What Works About This Framing

### The core loop is sound.

`/torque-submit "Write tests for auth.ts"` → TORQUE picks a provider → watches execution → validates output → notifies Claude Code when done. That's a genuine capability gap. Claude Code can't fork itself today. If TORQUE nailed just this — reliable task dispatch with provider fallback and output validation — it would be useful.

### The MCP integration is the right delivery mechanism.

As a Claude Code plugin, TORQUE lives inside the existing workflow. No context switch, no second terminal, no web UI required. The slash commands (`/torque-submit`, `/torque-status`, `/torque-review`) map to natural Claude Code interaction patterns. This is how you build tools for agents — you meet them where they already work.

### Smart routing solves a real decision fatigue problem.

Claude Code users who have Ollama, Codex, and cloud APIs available face a routing decision on every task. "Should I use the local model or burn tokens on Codex for this?" TORQUE making that decision automatically is genuinely valuable — *if* the routing is good.

## Where the Framing Breaks Down

### 1. The target user doesn't exist yet — or there are two incompatible targets.

TORQUE's README pitches to two audiences simultaneously:

- **Audience A:** A Claude Code power user who wants to parallelize their AI-assisted development. They need maybe 5-10 tools, slash commands, and a "fire and forget" workflow.
- **Audience B:** An infrastructure operator who wants policy engines, RBAC, audit trails, webhook integrations, budget controls, multi-host load balancing, and a 580-endpoint REST API.

Audience A is a solo developer or small team who hasn't thought about "shadow enforcement" or "slot-pull schedulers." Audience B is an engineering org that won't adopt a solo-authored, 9-day-old JavaScript project for critical infrastructure.

The product tries to serve both, and the result is that Audience A drowns in complexity while Audience B doesn't yet trust it.

### 2. The complexity tax on Claude Code is severe.

TORQUE's CLAUDE.md is 26KB of instructions that gets loaded into every Claude Code conversation. That's ~6,500 tokens of context consumed before the user says a word. The global CLAUDE.md adds another ~10KB. Combined, roughly 10,000 tokens of every context window are spent teaching Claude how to use TORQUE — context that could be spent on the user's actual code.

The 494 tools (even with progressive unlock starting at ~25) are registered in the MCP tool list. Claude Code must reason about which tools to use. Tool selection quality degrades as the tool count increases — this is a well-documented property of LLM tool use. The 25-tool Tier 1 is reasonable; the existence of 469 more tools behind `unlock_all_tools` is a liability, not a feature. Every tool is attack surface for confused tool selection.

### 3. 70% of this codebase doesn't serve the "bandwidth multiplier" mission.

A bandwidth multiplier for Claude Code needs:
- Task submission + routing (~5 provider adapters for the real ones people use)
- Queue management + concurrency
- Output validation + retry
- Notification back to Claude Code
- A few convenience workflows (feature pipeline, test generation)

What TORQUE *also* has:
- **SnapScope/Peek** — 15 handler files, 7K lines, 25+ MCP tools for visual UI capture and analysis. This is a separate product that happens to be bolted on.
- **TypeScript structural editing tools** — `add_ts_interface_members`, `inject_class_dependency`, `add_ts_enum_members`. These are code transformation tools. A different product.
- **Headwaters-specific wiring** — `wire_system_to_gamescene`, `wire_events_to_eventsystem`. These are wrappers for one specific project (the developer's own game) baked into a general-purpose orchestration tool.
- **Policy engine with shadow enforcement** — 8 modules, adapters, evaluation caching. For a tool that currently has one user.
- **CI watcher** — `watch_ci_repo`, `await_ci_run`, `diagnose_ci_failure`. Useful, but a different product.
- **Remote agent deployment** — `deploy-remote-agent.sh`, agent definitions. A different product.
- **Tree-sitter integration, tsserver client, symbol indexer** — language intelligence. A different product.
- **Peek federation, peek compliance, peek onboarding, peek accessibility-diff** — at least 4 sub-products within the peek subsystem alone.

The result: a user who wanted a task dispatcher gets a kitchen sink. Each additional subsystem is more documentation to read, more tools to filter, more code to load, more surface area for bugs.

### 4. ~~The pricing model conflicts with the open-source positioning.~~ (RESOLVED)

*Pricing tiers have been removed. TORQUE is fully unlocked for all users under the MIT license. No artificial limits on concurrent tasks, hosts, or workflow nodes.*

### 5. The "never write code directly" philosophy is anti-adoption.

The CLAUDE.md instructs Claude Code: "NEVER manually implement what TORQUE should produce." This makes sense for the author's workflow but is hostile to new users. A Claude Code user trying TORQUE for the first time needs to see it work once, verify the output, and build trust incrementally. Telling Claude to refuse to write code and instead submit everything through TORQUE means the first failure (wrong provider, stalled task, bad output) breaks the user's flow with no easy fallback.

New users should be able to opt into TORQUE for specific tasks while Claude Code still works normally for everything else. The current posture is all-or-nothing.

### 6. The bootstrapping problem: you need TORQUE to understand TORQUE.

TORQUE's CLAUDE.md documents 22+ core MCP tools, 6 automation tools, 4 batch lifecycle tools, 5 TypeScript structural tools, 3 Headwaters wrappers, 4 validation tools, plus the routing template system, the policy engine, the stall recovery system, the push notification system, and the heartbeat protocol.

A new Claude Code user installing TORQUE doesn't need to know any of this. They need:
1. How to submit a task.
2. How to check if it's done.
3. How to see the result.

Everything else should be discoverable through use, not front-loaded as 26KB of instructions.

### 7. Provider support is wide but shallow where it matters.

12 providers looks impressive, but the practical reality (from the project's own CLAUDE.md and provider quality matrix):
- **Codex**: 97%+ success rate, but sandbox contamination at 100% reproduction rate
- **Ollama**: Can't create new files, degrades above 250 lines, context limit issues
- **DeepInfra/Hyperbolic**: Cloud API wrappers that format prompts and parse responses
- **Claude CLI**: Works but opens visible windows that steal focus
- **Groq/Cerebras**: Rate limits make them unreliable for burst work

The honest story is: Codex is the only reliably good provider, Ollama works for small edits, and everything else is a fallback. A bandwidth multiplier that routes 80% of complex work to Codex is really a "Codex wrapper with retry logic." That's fine — but own it.

### 8. No competitive moat in the MCP era.

Claude Code's plugin/MCP ecosystem is young. Right now, TORQUE has the field mostly to itself for task orchestration. But:
- Anthropic could build native task parallelism into Claude Code (they control the agent loop)
- OpenAI could make Codex directly addressable from Claude Code via MCP
- A simpler project could implement `submit_task` + `await_task` + `get_result` with one provider and steal the 90% use case in 500 lines instead of 500,000

TORQUE's moat is complexity, and complexity is not a moat — it's a liability. The moat should be the quality of routing decisions, the reliability of output validation, and the smoothness of the UX. Those things don't require 494 tools.

## The Core Tension

TORQUE is a tool that got large because it could, not because it needed to. The AI-assisted development loop (plan → generate → validate) has near-zero marginal cost for adding features, so features accumulated. Each one was individually justified — of course you need cost tracking, of course you need policy engines, of course you need visual UI testing — but collectively they transformed a task dispatcher into an enterprise platform with one user.

The Claude Code bandwidth multiplier that developers actually want is probably 10% of what TORQUE is today. It's:
- `submit_task` with auto-routing to 2-3 providers
- `await_task` with push notifications
- Output validation (stub detection, build check)
- Auto-retry with fallback
- A Kanban dashboard

Everything else is either a separate product (Peek, CI, TypeScript tools), premature scaling (policy engine, multi-host LB, RBAC), or one developer's personal workflow codified as a feature (Headwaters wiring, agentic worker, strategic brain).

## Recommendation

If TORQUE wants to be the "bandwidth multiplier for Claude Code," it needs to do *less*, not more:

1. **Extract Peek/SnapScope** into its own plugin/product. It's independently useful and muddies the orchestration story.
2. **Remove project-specific tools** (Headwaters wiring) from the core distribution.
3. **Collapse the CLAUDE.md** to ~3KB: here's how to submit, here's how to wait, here's how to review. Put everything else in docs/.
4. **Default to 3 providers**: Ollama (free/local), Codex (reliable cloud), one API provider (user's choice). Others are opt-in and undocumented in the core instructions.
5. **Kill the tier system** — ship 20 well-designed tools, not 494 with progressive unlock.
6. ~~**Make the free tier generous enough to demonstrate value**~~ — RESOLVED: no tiers, everything unlocked.
7. **Remove the "never write code directly" posture** from CLAUDE.md — let TORQUE be additive, not exclusive.

The best version of TORQUE is a small, fast, reliable task dispatcher that Claude Code users install in 30 seconds and never think about again. The current version is a fascinating piece of infrastructure that only its creator can operate.
