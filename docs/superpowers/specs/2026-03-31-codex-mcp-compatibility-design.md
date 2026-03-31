# Codex MCP Compatibility — Design Spec

## Problem

Codex cannot use TORQUE's MCP tools. Five issues block or degrade the experience:

1. **Codex config path mismatch** — config references `Torque` but repo is `torque-public`
2. **Tier filter is inverted** — `tools/list` shows 507/536 tools in "core" mode instead of ~30. The filter passes tools NOT in any tier, which is almost everything.
3. **Plugin tools shadow built-ins** — duplicate tool names between built-ins and plugins; plugin silently wins
4. **Docs are stale** — tool counts in CLAUDE.md, CODEX.md, and tool-reference.md are wrong
5. **`.mcp.json.example` has stale `?apiKey=`** — injector writes keyless URLs but example still has key param

## Fix 1: Tier Filter (Issue 2)

### Root cause

`server/mcp-protocol.js:68` uses an inverted filter:

```js
if (allowedSet.has(tool.name) || !_allTierNames.has(tool.name)) {
```

This says "include if in the allowed tier OR not in any tier." Since `_allTierNames` only contains TIER_1 + TIER_2 names (~56 tools), the remaining ~480 built-in tools all pass the `!_allTierNames.has()` check.

### Fix

Change to pure allowlist in both `tools/list` and `tools/call`:

**`tools/list` (line 68):**
```js
// Before:
if (allowedSet.has(tool.name) || !_allTierNames.has(tool.name)) {
// After:
if (allowedSet.has(tool.name)) {
```

**`tools/call` (line 109):**
```js
// Before:
if (!allowedNames.includes(name) && _allTierNames.has(name)) {
// After:
if (!allowedNames.includes(name)) {
```

In core mode, only TIER_1 tools are listed and callable. In extended mode, TIER_1 + TIER_2. In full mode, everything. Plugin tools must register into tiers to be visible (see Fix 4).

## Fix 2: Plugin Tool Dedup (Issue 3)

### Root cause

In `server/index.js`, plugin tools are appended to the built-in tool array without checking for name collisions. If a plugin defines a tool with the same name as a built-in, both appear in the list and the plugin version shadows the built-in during dispatch.

### Fix

At plugin tool merge time, filter out plugin tools whose names collide with built-ins. Built-ins take precedence. Log a warning on collision.

```js
const builtInNames = new Set(builtInTools.map(t => t.name));
const pluginTools = plugin.mcpTools()
  .filter(t => {
    if (builtInNames.has(t.name)) {
      logger.warn(`Plugin "${plugin.name}" tool "${t.name}" shadows built-in — skipping`);
      return false;
    }
    return true;
  });
```

## Fix 3: Config and Docs (Issues 1, 4, 5)

### `.mcp.json.example` (Issue 5)

Remove the `?apiKey=${TORQUE_API_KEY}` query parameter. The injector writes keyless URLs in local mode:

```json
{
  "mcpServers": {
    "torque": {
      "type": "sse",
      "url": "http://127.0.0.1:3458/sse"
    }
  }
}
```

### Codex config (Issue 1)

Ensure Codex points at the live SSE endpoint `http://127.0.0.1:3458/sse` rather than launching a process from the wrong disk path. This is a user-side config fix — document the correct Codex MCP setup in `CODEX.md`.

### Stale docs (Issue 4)

After the tier filter fix, count actual tools per tier from source and update:
- `CLAUDE.md` — correct tool counts and core tool number
- `CODEX.md` — verify listed tool names are current
- `server/docs/api/tool-reference.md` — correct total tool count

## Fix 4: Plugin Tier Registration

### Problem

After the tier filter fix, plugin tools are invisible in core/extended mode because they're not in any tier array. Plugins need a way to declare which tools should be visible in which tier.

### Design

Add an optional `tierTools()` method to the plugin contract. Plugins return which of their tools belong in which tier:

```js
function tierTools() {
  return {
    tier1: ['peek_ui'],
    tier2: [],
  };
}
```

During plugin installation in `server/index.js`:
1. Call `plugin.mcpTools()` — get tool definitions
2. Call `plugin.tierTools()` (if defined) — get tier membership
3. Merge tier names into TIER_1/TIER_2 arrays
4. Initialize `mcp-protocol.js` with the merged tier arrays

Plugins that don't implement `tierTools()` have their tools visible only after `unlock_all_tools` (Tier 3). This is the safe default for advanced tools.

### Plugin contract change

In `server/plugins/plugin-contract.js`, add `tierTools` as an optional method:

```js
const OPTIONAL_METHODS = ['tierTools'];
```

### Default plugin tier assignments

| Plugin | Tier 1 Tools | Tier 2 Tools |
|--------|-------------|-------------|
| snapscope | `peek_ui` | remaining snapscope tools |
| remote-agents | none | all 7 tools |
| version-control | none | none (tier 3 only) |

## Files Changed

| File | Change |
|------|--------|
| `server/mcp-protocol.js` | Fix `tools/list` and `tools/call` to pure allowlist |
| `server/index.js` | Dedup plugin tools; read `tierTools()` and merge into tier arrays |
| `server/plugins/plugin-contract.js` | Add optional `tierTools` to contract validation |
| `server/plugins/snapscope/index.js` | Add `tierTools()` returning `{ tier1: ['peek_ui'], tier2: [...] }` |
| `server/plugins/remote-agents/index.js` | Add `tierTools()` returning `{ tier2: [...] }` |
| `.mcp.json.example` | Remove `?apiKey=` param |
| `CLAUDE.md` | Fix tool counts |
| `CODEX.md` | Add MCP setup instructions, verify tool names |
| `server/docs/api/tool-reference.md` | Fix tool count |

## Out of Scope

- Codex-specific tool surface (compact catalog from `mcp/catalog-v1.js`) — the main SSE surface with proper tier filtering is sufficient
- Per-project or per-client tier customization — YAGNI
- Deprecated MCP gateway on port 3459 — remains opt-in behind `TORQUE_ENABLE_MCP_GATEWAY`
