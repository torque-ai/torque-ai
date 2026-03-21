# Active Policy Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Extend the policy engine beyond blocking/rerouting to support active effects: triggering MCP tool calls, rewriting task inputs, and compressing outputs as side-effects of policy evaluation.

**Architecture:** Add three new effect types to the policy engine evaluation loop: `trigger_tool` (call an MCP tool as a side-effect), `rewrite_description` (modify task description before execution), and `compress_output` (transform task output after completion). Effects execute in the existing policy evaluation pipeline.

**Tech Stack:** Existing policy engine (server/policy-engine/), existing MCP tool dispatch

**Inspired by:** Gobby's rule engine (mcp_call, rewrite_input, compress_output effect types)

---

### Task 1: Define new effect types

**Files:**
- Modify: `server/policy-engine/engine.js` -- add effect type handling
- Modify: `server/policy-engine/matchers.js` -- if new matchers needed
- Test: `server/tests/policy-active-effects.test.js`

New effect types in profile definitions:
```json
{
  "effect": "trigger_tool",
  "tool_name": "validate_event_consistency",
  "tool_args": { "working_directory": "{{task.working_directory}}" },
  "background": true,
  "block_on_failure": false
}
```
```json
{
  "effect": "rewrite_description",
  "prepend": "IMPORTANT: This project uses strict TypeScript. Enable strict mode.",
  "append": "Run tsc --noEmit before marking complete."
}
```
```json
{
  "effect": "compress_output",
  "max_lines": 500,
  "keep": "last",
  "summary_header": "[Output truncated to last 500 lines]"
}
```

- [ ] Step 1: Write failing tests for each effect type evaluation
- [ ] Step 2: Implement trigger_tool effect (calls MCP tool dispatch, optionally blocks task on failure)
- [ ] Step 3: Implement rewrite_description effect (prepend/append to task description)
- [ ] Step 4: Implement compress_output effect (truncate output with configurable strategy)
- [ ] Step 5: Run tests
- [ ] Step 6: Commit

---

### Task 2: Wire trigger_tool into task lifecycle

**Files:**
- Modify: `server/policy-engine/task-hooks.js` -- execute trigger_tool effects
- Modify: `server/policy-engine/task-execution-hooks.js` -- execute post-completion effects

- [ ] Step 1: In pre-submission hooks, execute trigger_tool effects with background=false (blocking)
- [ ] Step 2: In post-completion hooks, execute trigger_tool effects (e.g., "run security scanner after auth file changes")
- [ ] Step 3: Template variable interpolation in tool_args (task.working_directory, task.provider, etc.)
- [ ] Step 4: Write integration tests
- [ ] Step 5: Run tests
- [ ] Step 6: Commit

---

### Task 3: Built-in policy profiles using new effects

**Files:**
- Modify: `server/policy-engine/profile-loader.js` -- add default profiles

Example profiles:
- "security-scan-on-auth": triggers validate_event_consistency when task description mentions auth/security
- "strict-typescript": prepends strict mode reminder for TypeScript projects
- "output-cap": compresses output to 500 lines for free providers (saves DB space)

- [ ] Step 1: Create 2-3 built-in profiles demonstrating new effect types
- [ ] Step 2: Write tests
- [ ] Step 3: Commit
