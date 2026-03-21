# MCP Ecosystem Review — Findings & Improvement Roadmap

**Date:** 2026-03-21
**Scope:** Official MCP reference servers, MCP spec 2025-06-18, notable community servers, best practices

## Where TORQUE Already Leads

| Area | TORQUE | Typical MCP Servers |
|------|--------|-------------------|
| **Multi-provider routing** | 13 providers with smart routing, fallback chains, routing templates | Most servers are single-purpose, zero routing |
| **Progressive tool disclosure** | 3-tier unlock (25→78→488) | Most dump all tools at once; only a few use progressive discovery |
| **Task orchestration** | DAG workflows, dependency graphs, parallel execution | Task Orchestrator (jpicklyk) is closest but simpler (no provider routing) |
| **Cost tracking** | Built-in budget tracking per provider/model | Only Ultimate MCP Server has comparable cost tracking |
| **Quality safeguards** | Baselines, stub detection, rollback, auto-verify-retry | Very few servers have any post-execution validation |
| **Push notifications** | SSE event bus, auto-subscribe, await_task/await_workflow | Most servers are request-response only |

## Improvement Recommendations (Prioritized)

### Priority 1: Tool Annotations (MCP Spec 2025-06-18)

**Effort:** Low | **Impact:** High

The MCP spec defines standardized annotations on tool definitions:
- `readOnlyHint` (boolean) — tool doesn't modify state
- `destructiveHint` (boolean) — tool may destroy data irreversibly
- `idempotentHint` (boolean) — safe to retry without side effects
- `openWorldHint` (boolean) — tool interacts with external entities

TORQUE's `catalog-v1.js` already tracks `mutation: true/false`. The ~30 tool-def files in `server/tool-defs/` define JSON schemas but lack annotations.

**Why it matters:** Clients like Claude Code use these hints to decide auto-approve vs. prompt-user. Read-only tools with `readOnlyHint: true` could skip user confirmation entirely, dramatically improving UX flow.

**Implementation:** Add `annotations` object to each tool definition in `tool-defs/*.js`. Surface them in `tools/list` responses via `mcp-protocol.js`.

### Priority 2: Structured Tool Outputs (`outputSchema`)

**Effort:** Medium | **Impact:** High

MCP 2025-06-18 supports declaring output schemas on tools with `structuredContent` in responses. TORQUE's `okEnvelope`/`errorEnvelope` pattern is already consistent but schemas aren't declared in tool definitions.

**Why it matters:** Clients can validate responses. LLMs parse structured data more reliably. Especially useful for `check_status`, `get_result`, `workflow_status` where output shape is well-known.

**Implementation:** Add `outputSchema` to tool definitions for tools with stable output shapes. Return `structuredContent` alongside existing `content` in responses.

### Priority 3: Compact Context Tool (`get_workflow_context`)

**Effort:** Medium | **Impact:** High

Inspired by Task Orchestrator's `get_context()` pattern — returns a 200-token curated summary instead of replaying full state. TORQUE's `workflow_status` returns everything; a curated view could save significant tokens on session resume.

**Why it matters:** Token savings compound across long workflows. Agents resuming sessions need just: what's done, what's running, what's next, any blockers.

**Implementation:** New tool `get_workflow_context` that returns compact summary: completed tasks (count + names), running tasks (provider + elapsed), next actionable tasks, blockers/failures, total cost so far.

### Priority 4: Elicitation for Approval Gates

**Effort:** Medium | **Impact:** Medium

MCP 2025-06-18 elicitation allows servers to pause mid-tool and ask the user a structured question via `elicitation/create`. Currently approval gates rely on the orchestrating LLM to relay questions.

**Why it matters:** Direct human-in-loop for approval decisions. More reliable than hoping the LLM correctly surfaces approval prompts.

**Implementation:** When a task hits an approval gate (>50% file size decrease, validation failure), use `elicitation/create` to ask "approve/reject/rollback" directly from the human. Requires client capability check.

### Priority 5: MCP Apps Dashboard

**Effort:** High | **Impact:** High (wow-factor)

MCP Apps allow servers to return interactive HTML interfaces that render in the chat. Bidirectional data flow — apps can call MCP tools and receive push updates.

**Why it matters:** TORQUE's dashboard is a separate web UI (port 3456). An MCP App version embeds a mini task-status dashboard, workflow progress view, or provider health panel directly in the conversation.

**Implementation:** Create MCP App resource (`ui://torque-dashboard`) with React-based mini dashboard. Wire to existing event bus for live updates. Return as tool result from `show_dashboard` tool.

### Lower Priority

| Item | Effort | Notes |
|------|--------|-------|
| **Streamable HTTP transport** | Medium | SSE deprecated in spec; migration needed eventually |
| **Namespaced tool names** | Low | catalog-v1.js already uses `torque.task.submit` style; migrate legacy names |
| **Server-enforced workflow gates** | Medium | Tasks can't advance phases until prerequisites pass verification |
| **Sampling for task decomposition** | Medium | Use host LLM for spec analysis instead of paid provider |
| **OAuth 2.1** | High | Enterprise auth; aligns with existing backlog item |
| **Tool search/semantic discovery** | Medium | Complement tier system with keyword search for 488 tools |
| **Cognitive memory / project intelligence** | Medium | Learn provider/model preferences from task history |

## Sources

- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) — Official reference servers
- [MCP Spec 2025-06-18 Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — Tool annotations, structured outputs
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) — Interactive HTML in chat
- [MCP Elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) — Server-requested user input
- [Task Orchestrator](https://github.com/jpicklyk/task-orchestrator) — Quality gates, compact context
- [Ultimate MCP Server](https://github.com/Dicklesworthstone/ultimate_mcp_server) — Multi-provider, cost tracking
- [Phil Schmid MCP Best Practices](https://www.philschmid.de/mcp-best-practices) — Tool design patterns
- [Speakeasy Progressive Discovery](https://www.speakeasy.com/blog/100x-token-reduction-dynamic-toolsets) — 100x token reduction
- [Progressive Tool Discovery](https://agentic-patterns.com/patterns/progressive-tool-discovery/) — Hierarchical tool navigation
