# Three-Tier MCP Tool Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Reduce context token overhead by serving lightweight tool stubs (name + description only) by default, with full schemas fetched on demand when the agent decides to use a tool.

**Architecture:** Split tool registration into metadata (always served) and full schema (served on demand). Add a get_tool_schema MCP tool that returns the full inputSchema for a specific tool. The MCP SSE transport sends only metadata in tools/list responses; full schemas are lazy-loaded via get_tool_schema calls.

**Tech Stack:** Existing MCP SSE transport, existing tool registration system

**Inspired by:** Gobby's MCP proxy (list_tools returns names + 100-char descriptions, get_tool_schema fetches full schema on demand)

---

### Task 1: Separate metadata from full schemas in tool registration

**Files:**
- Modify: `server/mcp/index.js` -- split tool list into lightweight and full modes
- Test: `server/tests/lazy-tool-schemas.test.js`

- [ ] Step 1: In tools/list handler, add a `mode` parameter: "full" (default, backward compat) or "brief"
- [ ] Step 2: In "brief" mode, return only { name, description } per tool (truncate description to 120 chars)
- [ ] Step 3: Write test -- brief mode returns all tools with no inputSchema
- [ ] Step 4: Write test -- full mode returns tools with inputSchema (backward compat)
- [ ] Step 5: Run tests
- [ ] Step 6: Commit

---

### Task 2: Add get_tool_schema MCP tool

**Files:**
- Modify: `server/mcp/index.js` -- add get_tool_schema tool
- Modify: `server/tool-annotations.js`
- Test: `server/tests/lazy-tool-schemas.test.js`

- [ ] Step 1: Register get_tool_schema tool with input { tool_name: string }
- [ ] Step 2: Handler looks up full schema from the tool registry, returns the inputSchema JSON
- [ ] Step 3: Return error if tool_name not found
- [ ] Step 4: Write tests
- [ ] Step 5: Commit

---

### Task 3: Schema hash tracking for change detection

**Files:**
- Create: `server/mcp/schema-hash.js`
- Test: `server/tests/lazy-tool-schemas.test.js`

Track SHA-256 hashes of tool schemas in memory. On reconnect or server restart, compare hashes to detect which tools changed. Expose via `get_changed_tools(since_hash_map)`.

- [ ] Step 1: Implement hashToolSchemas() -- SHA-256 of each tool's inputSchema
- [ ] Step 2: Implement detectChangedTools(previousHashes, currentHashes)
- [ ] Step 3: Write tests
- [ ] Step 4: Commit

---

### Task 4: Documentation and integration notes

**Files:**
- Modify: `CLAUDE.md` -- document the brief mode and get_tool_schema pattern

- [ ] Step 1: Add brief documentation about lazy schema loading
- [ ] Step 2: Commit
