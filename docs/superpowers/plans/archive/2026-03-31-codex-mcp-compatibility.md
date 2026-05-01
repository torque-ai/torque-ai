# Codex MCP Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 issues preventing Codex from using TORQUE's MCP tools — inverted tier filter, plugin tool shadowing, plugin tier registration, stale config, and stale docs.

**Architecture:** Pure allowlist tier filtering in `mcp-protocol.js`, plugin tool dedup at merge time in `index.js`, optional `tierTools()` method in plugin contract for tier registration.

**Tech Stack:** Node.js, MCP SSE protocol

**Spec:** `docs/superpowers/specs/2026-03-31-codex-mcp-compatibility-design.md`

---

### Task 1: Fix tier filter logic in mcp-protocol.js (~3 min)

**Files:**
- Modify: `server/mcp-protocol.js:62-71` (tools/list filter)
- Modify: `server/mcp-protocol.js:107-114` (tools/call gate)

- [ ] **Step 1: Fix tools/list filter**

In `server/mcp-protocol.js`, find the `tools/list` case around line 62. Change the filter from the inverted logic to a pure allowlist:

```js
    case 'tools/list': {
      if (session.toolMode === 'core' || session.toolMode === 'extended') {
        const allowedNames = session.toolMode === 'core' ? _coreToolNames : _extendedToolNames;
        const allowedSet = new Set(allowedNames);
        const filtered = [];
        for (const tool of _tools) {
          if (allowedSet.has(tool.name)) {
            filtered.push(tool);
          }
        }
        return { tools: filtered };
      }
      return { tools: [..._tools] };
    }
```

The key change: remove `|| !_allTierNames.has(tool.name)` from line 68.

- [ ] **Step 2: Fix tools/call gate**

In the same file, find the `tools/call` enforcement around line 107. Change:

```js
  // Enforce tool mode at execution boundary
  if (session.toolMode !== 'full') {
    const allowedNames = session.toolMode === 'core' ? _coreToolNames : _extendedToolNames;
    if (!allowedNames.includes(name)) {
      return {
        content: [{ type: 'text', text: `Tool '${name}' is not available in ${session.toolMode} mode. Call 'unlock_tier' or 'unlock_all_tools' to access more tools.` }],
        isError: true,
      };
    }
  }
```

The key change: remove `&& _allTierNames.has(name)` from the condition. Also remove the stale comment about plugin tools.

- [ ] **Step 3: Remove unused _allTierNames**

The `_allTierNames` set is no longer needed. Remove it:

- Delete line 8: `let _allTierNames = new Set();`
- Delete the assignment in `init()` at line 26: `_allTierNames = new Set([..._coreToolNames, ..._extendedToolNames]);`

- [ ] **Step 4: Commit**

```bash
git add server/mcp-protocol.js
git commit -m "fix: pure allowlist tier filter in mcp-protocol — was showing 507/536 tools in core mode"
```

---

### Task 2: Add plugin tier registration to plugin contract (~3 min)

**Files:**
- Modify: `server/plugins/plugin-contract.js`

- [ ] **Step 1: Add tierTools to optional methods documentation**

In `server/plugins/plugin-contract.js`, add a comment and an `OPTIONAL_METHODS` list after `REQUIRED_FIELDS`:

```js
const REQUIRED_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'install', type: 'function' },
  { name: 'uninstall', type: 'function' },
  { name: 'middleware', type: 'function' },
  { name: 'mcpTools', type: 'function' },
  { name: 'eventHandlers', type: 'function' },
  { name: 'configSchema', type: 'function' },
];

/**
 * Optional plugin methods. Validated only when present.
 * - tierTools(): Returns { tier1: string[], tier2: string[] } mapping tool names to visibility tiers.
 *   Tools not listed are only visible after unlock_all_tools (Tier 3).
 */
const OPTIONAL_METHODS = [
  { name: 'tierTools', type: 'function' },
];

function validatePlugin(plugin) {
  const errors = [];
  if (!plugin || typeof plugin !== 'object') {
    return { valid: false, errors: ['plugin must be an object'] };
  }
  for (const { name, type } of REQUIRED_FIELDS) {
    if (!(name in plugin)) {
      errors.push(`missing required field: ${name}`);
    } else if (typeof plugin[name] !== type) {
      errors.push(`${name} must be a ${type}`);
    }
  }
  for (const { name, type } of OPTIONAL_METHODS) {
    if (name in plugin && typeof plugin[name] !== type) {
      errors.push(`optional method ${name} must be a ${type} when provided`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { validatePlugin, REQUIRED_FIELDS, OPTIONAL_METHODS };
```

- [ ] **Step 2: Commit**

```bash
git add server/plugins/plugin-contract.js
git commit -m "feat: add optional tierTools method to plugin contract"
```

---

### Task 3: Add tierTools to snapscope and remote-agents plugins (~3 min)

**Files:**
- Modify: `server/plugins/snapscope/index.js`
- Modify: `server/plugins/remote-agents/index.js`

- [ ] **Step 1: Add tierTools to snapscope plugin**

In `server/plugins/snapscope/index.js`, add a `tierTools` function inside `createSnapScopePlugin()` (before the return statement around line 140):

```js
  function tierTools() {
    return {
      tier1: ['peek_ui'],
      tier2: [
        'peek_interact', 'peek_elements', 'peek_hit_test',
        'peek_launch', 'peek_discover', 'peek_health_all',
        'peek_build_and_open', 'peek_diagnose',
      ],
    };
  }
```

Add `tierTools` to the return object:

```js
  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    install,
    uninstall,
    middleware,
    mcpTools,
    eventHandlers,
    configSchema,
    tierTools,
  };
```

- [ ] **Step 2: Add tierTools to remote-agents plugin**

In `server/plugins/remote-agents/index.js`, add a `tierTools` function inside `createPlugin()` (before the return statement around line 93):

```js
  function tierTools() {
    return {
      tier1: [],
      tier2: ['register_remote_agent', 'list_remote_agents', 'check_remote_agent_health', 'run_remote_command'],
    };
  }
```

Add `tierTools` to the return object:

```js
  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    install,
    uninstall,
    mcpTools,
    middleware,
    eventHandlers,
    configSchema,
    getAgentRegistry: () => agentRegistry,
    tierTools,
  };
```

- [ ] **Step 3: Commit**

```bash
git add server/plugins/snapscope/index.js server/plugins/remote-agents/index.js
git commit -m "feat: add tierTools to snapscope and remote-agents plugins"
```

---

### Task 4: Wire plugin tier registration and dedup in index.js (~5 min)

**Files:**
- Modify: `server/index.js:1146-1168`

- [ ] **Step 1: Replace the plugin tool collection and MCP init block**

Find the block starting at line 1146 (`// Collect plugin MCP tools`). Replace the entire block through line 1168 with:

```js
  // Collect plugin MCP tools — dedup against built-ins
  const builtInTools = getTools();
  const builtInNames = new Set(builtInTools.map(t => t.name));
  const pluginTools = [];
  const pluginTier1 = [];
  const pluginTier2 = [];
  for (const plugin of loadedPlugins) {
    const tools = plugin.mcpTools();
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        if (builtInNames.has(tool.name)) {
          debugLog(`Plugin "${plugin.name}" tool "${tool.name}" shadows built-in — skipping`);
          continue;
        }
        pluginTools.push(tool);
      }
    }
    // Collect tier membership from plugins
    if (typeof plugin.tierTools === 'function') {
      const tiers = plugin.tierTools();
      if (tiers && Array.isArray(tiers.tier1)) pluginTier1.push(...tiers.tier1);
      if (tiers && Array.isArray(tiers.tier2)) pluginTier2.push(...tiers.tier2);
    }
  }

  // Merge plugin tier names into the shared tier arrays
  const mergedCoreTierNames = [...CORE_TOOL_NAMES, ...pluginTier1];
  const mergedExtendedTierNames = [...EXTENDED_TOOL_NAMES, ...pluginTier2, ...pluginTier1];

  // Initialize shared MCP protocol handler (used by both stdio and SSE transports)
  mcpProtocol.init({
    tools: [...builtInTools, ...pluginTools],
    coreToolNames: mergedCoreTierNames,
    extendedToolNames: mergedExtendedTierNames,
    handleToolCall: async (name, args, _session) => {
      // Check plugin tools first
      const pluginTool = pluginTools.find(t => t.name === name);
      if (pluginTool && typeof pluginTool.handler === 'function') {
        return pluginTool.handler(args);
      }
      return callTool(name, args);
    },
  });
```

- [ ] **Step 2: Commit**

```bash
git add server/index.js
git commit -m "feat: dedup plugin tools against built-ins, merge plugin tier membership"
```

---

### Task 5: Fix config and docs (Issues 1, 4, 5) (~3 min)

**Files:**
- Modify: `.mcp.json.example`
- Modify: `CLAUDE.md`
- Modify: `CODEX.md`
- Modify: `server/docs/api/tool-reference.md`

- [ ] **Step 1: Fix .mcp.json.example**

Replace the contents of `.mcp.json.example` with:

```json
{
  "mcpServers": {
    "torque": {
      "type": "sse",
      "url": "http://127.0.0.1:3458/sse",
      "description": "TORQUE - Task Orchestration System with local LLM routing"
    }
  }
}
```

- [ ] **Step 2: Fix CLAUDE.md tool count**

In `CLAUDE.md` line 7, change:

```
1. **MCP server** — auto-configured on first startup (provides ~560 tools, 22 core + progressive unlock)
```

to:

```
1. **MCP server** — auto-configured on first startup (provides ~600 tools, ~30 core + progressive unlock)
```

(Exact counts should be verified after the tier fix is applied by counting `TIER_1` length + plugin tier1 tools. The ~600 total comes from 536 built-in + ~64 plugin tools after dedup.)

- [ ] **Step 3: Fix CODEX.md MCP setup section**

Add a setup section to the top of `CODEX.md` after the title on line 1:

```markdown
## Setup

TORQUE connects via MCP SSE. Point your Codex MCP config at the running TORQUE instance:

```toml
[mcp.torque]
type = "sse"
url = "http://127.0.0.1:3458/sse"
```

TORQUE must be running first. The MCP config injector auto-configures Claude Code on startup, but Codex requires manual config.
```

- [ ] **Step 4: Fix tool-reference.md counts**

In `server/docs/api/tool-reference.md`:
- Line 5: Change `462 tools total` to `~600 tools total` and `~61 tools` to `~30 core tools`
- Line 720: Change `462 tools` to `~600 tools` and `~64 core tools` to `~30 core tools`

- [ ] **Step 5: Commit**

```bash
git add .mcp.json.example CLAUDE.md CODEX.md server/docs/api/tool-reference.md
git commit -m "docs: fix stale tool counts, config examples, and Codex MCP setup"
```

---

### Task 6: Update test assertions (~3 min)

**Files:**
- Modify: `server/tests/core-tools.test.js` (if it checks tier counts)
- Modify: `server/tests/tools-aggregator.test.js` (if it checks tool list sizes)

- [ ] **Step 1: Search for affected assertions**

Search these test files for any hardcoded counts of core tools, tool list sizes, or tier membership assertions. The tier filter change means core mode now shows fewer tools (TIER_1 count + plugin tier1 tools instead of 507).

Check:
- `server/tests/core-tools.test.js` — look for `CORE_TOOL_NAMES` length checks
- `server/tests/tools-aggregator.test.js` — look for routeMap size checks or total tool counts
- `server/tests/mcp-protocol.test.js` — if it exists, check for tools/list count assertions

Update any hardcoded counts to match the new behavior.

- [ ] **Step 2: Run tests**

Run: `torque-remote npx vitest run server/tests/core-tools.test.js server/tests/tools-aggregator.test.js --reporter=verbose`

Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add server/tests/
git commit -m "test: update tool count assertions for pure allowlist tier filter"
```

---

### Task 7: Push and verify end-to-end (~2 min)

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Restart TORQUE**

Use `await_restart` to apply the changes:

```
await_restart({ reason: "Apply Codex MCP compatibility fixes", timeout_minutes: 30 })
```

- [ ] **Step 3: Verify tier filtering**

After reconnecting, check that core mode shows the expected ~30 tools (not 507).

- [ ] **Step 4: Verify plugin tools are visible**

Confirm `peek_ui` appears in core mode tools list.
Confirm remote-agents tools appear in extended mode but NOT core mode.
