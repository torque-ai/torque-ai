# MCP Apps Dashboard — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Motivation:** TORQUE has a full web dashboard at port 3456, but LLMs working in Claude Code must call multiple tools to get task status, provider health, and workflow progress. MCP Apps lets the server embed an interactive HTML dashboard directly in the chat — one tool call shows a live tabbed interface with real-time data.

## Approach

**Full MCP Apps implementation** with a self-contained HTML dashboard served as a `ui://` resource. Four tabs (Tasks, Providers, Workflow, Cost) fetch data via MCP tool calls from within the iframe. No build step — vanilla HTML/CSS/JS.

## Dashboard Layout

**Tabbed interface (~350px height):**

| Tab | Data Source (MCP Tool) | Shows |
|-----|----------------------|-------|
| Tasks | `check_status` | Running/queued/failed counts, task list with provider + progress + stall status |
| Providers | `list_ollama_hosts` | Host health grid, running tasks, model counts, status indicators |
| Workflow | `workflow_status` | Active workflow progress bar, task nodes with status icons |
| Cost | `get_cost_summary` + `get_budget_status` | Spend by provider, budget utilization, warnings |

**Data flow:**
1. App loads → calls tools via postMessage to populate all tabs
2. Active tab auto-refreshes every 10 seconds
3. Tab switch shows cached data instantly, triggers background refresh
4. All data from `structuredContent` (schemas built in Phases 1-3)

**Styling:** Dark theme (matches Claude Code), monospace for data, compact layout for ~500x350px iframe.

## MCP Apps Protocol

### Tool Definition

```js
{
  name: 'show_dashboard',
  description: 'Show interactive TORQUE dashboard inline in chat. Displays real-time task status, provider health, workflow progress, and cost tracking in a tabbed interface.',
  _meta: {
    ui: { resourceUri: 'ui://torque/dashboard' }
  },
  inputSchema: {
    type: 'object',
    properties: {
      tab: {
        type: 'string',
        enum: ['tasks', 'providers', 'workflow', 'cost'],
        description: 'Initial tab to show (default: tasks)'
      }
    }
  }
}
```

### Resource Serving

New MCP method handlers in `mcp-protocol.js`:

```js
case 'resources/list':
  return { resources: [{ uri: 'ui://torque/dashboard', name: 'TORQUE Dashboard', mimeType: 'text/html' }] };

case 'resources/read':
  // Read params.uri, return { contents: [{ uri, mimeType, text: htmlString }] }
```

Server declares `resources` capability in initialize response:
```js
capabilities: { tools: {}, resources: {} }
```

### App Communication

The HTML app uses postMessage to call MCP tools through the host:
```js
// App sends:
window.parent.postMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_status', arguments: {} } }, '*');

// Host relays to MCP server, returns result to app via postMessage
```

For v1, we use the vanilla postMessage protocol. The `@modelcontextprotocol/ext-apps` App class is optional — we can adopt it later for cleaner API.

## Architecture

### Files

| File | Action | Purpose |
|------|--------|---------|
| `server/mcp-apps/dashboard.html` | **New** | Self-contained HTML/CSS/JS tabbed dashboard |
| `server/mcp-apps/resource-handler.js` | **New** | Serves `ui://` resources via MCP `resources/read` |
| `server/tool-defs/dashboard-app-defs.js` | **New** | `show_dashboard` tool definition with `_meta.ui` |
| `server/mcp-protocol.js` | **Modify** | Add `resources/list` + `resources/read`, declare `resources` capability |
| `server/tools.js` | **Modify** | Add dashboard-app-defs to TOOLS, resource-handler to initialization |
| `server/tool-annotations.js` | **Modify** | Add `show_dashboard` override (readOnly, idempotent) |
| `server/core-tools.js` | **Modify** | Add `show_dashboard` to TIER_1 |
| `server/tests/mcp-apps.test.js` | **New** | Resource handler + protocol tests |

### Dashboard HTML App Structure

Single file, ~400 lines, no build:

```
<!DOCTYPE html>
<html>
<head>
  <style>/* Dark theme, compact layout, tab styles */</style>
</head>
<body>
  <div id="app">
    <nav id="tabs"><!-- Tasks | Providers | Workflow | Cost --></nav>
    <div id="tab-tasks"><!-- task cards --></div>
    <div id="tab-providers"><!-- host grid --></div>
    <div id="tab-workflow"><!-- progress bar + nodes --></div>
    <div id="tab-cost"><!-- spend chart + budget bar --></div>
  </div>
  <script>
    // Tab switching
    // MCP tool calls via postMessage
    // Data rendering per tab
    // Auto-refresh interval
  </script>
</body>
</html>
```

## Testing

### Unit Tests
- `resources/list` returns dashboard resource with correct URI and mimeType
- `resources/read` for `ui://torque/dashboard` returns HTML containing expected markers
- `resources/read` for unknown URI returns error
- `show_dashboard` tool has `_meta.ui.resourceUri`
- `show_dashboard` has annotations (readOnly, idempotent)
- Dashboard HTML file exists and contains DOCTYPE, script, tab elements

### Manual Verification
- Call `show_dashboard` in Claude Code, verify iframe renders
- Verify tabs switch and data loads
- Verify auto-refresh updates data

## Non-Goals

- No React or build pipeline (vanilla HTML/CSS/JS)
- No WebSocket live push in v1 (poll via tool calls every 10s)
- No task actions from dashboard (view-only in v1 — cancel/approve actions can be added later)
- No persistence of tab state between tool calls
