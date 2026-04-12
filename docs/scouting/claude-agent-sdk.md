# Findings: Claude Agent SDK

**Tagline:** Claude Code turned into an embeddable agent runtime with streaming, tools, and resumable sessions.
**Stars:** 6.3k (GitHub, 2026-04-12)
**Language:** Python (99.5%)

## Feature 1: Claude Code as a Bundled Streaming Runtime
**What it does:** The Python package bundles the Claude Code CLI, and the SDK talks to that runtime through streamed message APIs such as `query()` and the longer-lived `ClaudeSDKClient`. It can run with the default Claude Code toolset, attach external MCP servers, and in Python also mount in-process SDK MCP servers so custom tools live inside the host app instead of a separate tool daemon.
**Why distinctive:** Most agent SDKs are thin wrappers over a model API; this one embeds Anthropic's own coding-agent harness, with its tool loop, context compaction, and session handling already baked in. The result is closer to "spawn Claude Code inside your app" than "rebuild an agent framework on top of messages."
**TORQUE relevance:** HIGH - TORQUE already uses Claude Code sessions, so this is directly on-brand rather than adjacent inspiration. The process-backed streaming model is a strong reference for exposing TORQUE runs as durable, tool-rich conversations instead of one-shot control-plane calls.

## Feature 2: Subagent Dispatch with Real Isolation
**What it does:** The SDK lets you define subagents programmatically with `agents` or load them from `.claude/agents/`, then Claude decides when to delegate through the `Agent` tool. Each subagent gets a fresh conversation, optional model override, scoped tools, optional Skills and MCP servers, and returns only its final message to the parent; multiple subagents can run concurrently.
**Why distinctive:** This is not just prompt-level delegation. Anthropic makes subagents a first-class runtime boundary with context isolation, tool restriction, and parallel execution, which is a much sharper contract than "call another helper prompt with the same context."
**TORQUE relevance:** HIGH - TORQUE already has a strong need for safe delegation and parallel specialist work. Claude's subagent model is a useful blueprint for scoped reviewer, researcher, and executor agents that can see less, do less, and still report back cleanly.

## Feature 3: A Layered Permission Model Instead of a Simple Allowlist
**What it does:** Tool permission decisions flow through hooks first, then declarative rules in `settings.json`, then the active permission mode, and finally the runtime `canUseTool` callback. The SDK separates auto-approval (`allowed_tools`), outright blocking (`disallowed_tools`), and coarse operating modes such as `acceptEdits`, `plan`, and `bypassPermissions`, with mode changes also possible during streaming.
**Why distinctive:** Many agent SDKs stop at "which tools are enabled." Anthropic treats permissions as a real control plane, with static rules, dynamic approval, and global execution modes composed into one evaluation order.
**TORQUE relevance:** HIGH - TORQUE's tool catalog, MCP surface, and remote execution paths would benefit from exactly this kind of layered policy model. It is especially relevant for keeping exploratory agents useful while still putting harder boundaries around shell, filesystem, and remote side effects.

## Feature 4: Hooks as Deterministic Runtime Middleware
**What it does:** Hooks fire on session lifecycle, prompt submission, tool calls, permission requests, subagent start and stop, compaction, notifications, and more. Hook handlers can inspect runtime JSON, then allow, deny, retry, validate, or annotate behavior before Claude continues.
**Why distinctive:** Hooks run inside the Claude Code execution loop rather than as after-the-fact observability. That makes them suitable for hard guarantees such as blocking destructive Bash, requiring validation, or logging precise lifecycle events without depending on the model to follow instructions.
**TORQUE relevance:** HIGH - TORQUE already has hook-like surfaces around tool dispatch and completion. Claude's hook system is a strong reference for turning those surfaces into a more formal middleware layer for guardrails, audits, and automatic post-tool enforcement.

## Feature 5: Filesystem-Native Skills, Slash Commands, and Session Resumption
**What it does:** Skills are loaded from `.claude/skills/*/SKILL.md` when filesystem settings are enabled and the `Skill` tool is allowed, and Claude can invoke them autonomously when the request matches their description. Slash commands are surfaced in the init message, support built-ins like `/compact` and `/clear`, and custom command files still work from `.claude/commands/`, but Anthropic now recommends Skills because they support the same `/name` invocation plus autonomous use; meanwhile sessions are written to disk automatically and can be continued, resumed by ID, or forked into a new history branch.
**Why distinctive:** Anthropic is converging reusable behaviors and long-lived state on the filesystem instead of inventing a separate hosted registry or workflow layer. The most interesting detail is that the recommended Skill format subsumes legacy slash commands, so one artifact can serve both explicit user invocation and autonomous agent behavior.
**TORQUE relevance:** HIGH - TORQUE already leans on local files, local sessions, and repo-scoped agent conventions. This is a close fit for how TORQUE could unify commands, reusable skills, and resumable agent transcripts into one coherent extension model.

## Verdict
The Claude Agent SDK is most interesting as an embeddable Claude Code runtime, not as a generic wrapper library. The strongest ideas for TORQUE are the subprocess-backed streaming session model, the layered permission and hook stack, and the filesystem-native convergence of Skills, slash commands, and session persistence. Because TORQUE already works in a Claude Code-shaped world, these patterns feel directly portable rather than merely inspirational.
