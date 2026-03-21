# MCP Apps Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed an interactive tabbed dashboard (Tasks, Providers, Workflow, Cost) directly in Claude Code chat via MCP Apps protocol.

**Architecture:** `show_dashboard` tool with `_meta.ui` → `resources/read` serves HTML → Claude Code renders iframe → app calls MCP tools via postMessage for data.

**Tech Stack:** Vanilla HTML/CSS/JS (no build), Node.js, MCP Apps protocol

**Spec:** `docs/superpowers/specs/2026-03-21-mcp-apps-dashboard-design.md`

**IMPORTANT:** Push to origin/main before running tests. Use `torque-remote` for test execution.

---

### Task 1: Protocol — resources/list + resources/read + Capability

**Files:**
- Create: `server/mcp-apps/resource-handler.js`
- Modify: `server/mcp-protocol.js` — add resources methods + capability
- Create: `server/tests/mcp-apps.test.js`

- [ ] **Step 1: Write tests**

Create `server/tests/mcp-apps.test.js`:

```js
'use strict';

describe('mcp-apps', () => {
  describe('resource handler', () => {
    it('listResources returns dashboard resource', () => {
      const { listResources } = require('../mcp-apps/resource-handler');
      const result = listResources();
      expect(result.resources).toBeDefined();
      expect(result.resources.length).toBeGreaterThan(0);
      const dashboard = result.resources.find(r => r.uri === 'ui://torque/dashboard');
      expect(dashboard).toBeDefined();
      expect(dashboard.mimeType).toBe('text/html');
      expect(dashboard.name).toBe('TORQUE Dashboard');
    });

    it('readResource returns HTML for dashboard URI', () => {
      const { readResource } = require('../mcp-apps/resource-handler');
      const result = readResource({ uri: 'ui://torque/dashboard' });
      expect(result.contents).toBeDefined();
      expect(result.contents.length).toBe(1);
      expect(result.contents[0].mimeType).toBe('text/html');
      expect(result.contents[0].text).toContain('<!DOCTYPE html>');
      expect(result.contents[0].text).toContain('tab-tasks');
      expect(result.contents[0].text).toContain('tab-providers');
    });

    it('readResource returns error for unknown URI', () => {
      const { readResource } = require('../mcp-apps/resource-handler');
      const result = readResource({ uri: 'ui://torque/nonexistent' });
      expect(result.isError).toBe(true);
    });
  });

  describe('protocol integration', () => {
    it('show_dashboard tool has _meta.ui.resourceUri', () => {
      const { TOOLS } = require('../tools');
      const tool = TOOLS.find(t => t.name === 'show_dashboard');
      expect(tool).toBeDefined();
      expect(tool._meta?.ui?.resourceUri).toBe('ui://torque/dashboard');
    });

    it('show_dashboard has annotations (readOnly + idempotent)', () => {
      const { TOOLS } = require('../tools');
      const tool = TOOLS.find(t => t.name === 'show_dashboard');
      expect(tool).toBeDefined();
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
    });

    it('show_dashboard is in Tier 1', () => {
      const { CORE_TOOL_NAMES } = require('../core-tools');
      expect(CORE_TOOL_NAMES).toContain('show_dashboard');
    });
  });
});
```

- [ ] **Step 2: Create resource handler**

Create `server/mcp-apps/resource-handler.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');

const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');

const RESOURCES = [
  {
    uri: 'ui://torque/dashboard',
    name: 'TORQUE Dashboard',
    description: 'Interactive task status, provider health, workflow progress, and cost tracking',
    mimeType: 'text/html',
  },
];

function listResources() {
  return { resources: RESOURCES };
}

function readResource(params) {
  const uri = params?.uri;

  if (uri === 'ui://torque/dashboard') {
    try {
      const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
      return {
        contents: [{
          uri,
          mimeType: 'text/html',
          text: html,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error reading dashboard: ${err.message}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown resource: ${uri}` }],
    isError: true,
  };
}

module.exports = { listResources, readResource, RESOURCES };
```

- [ ] **Step 3: Create a placeholder dashboard.html**

Create `server/mcp-apps/dashboard.html` — a minimal placeholder that the tests can validate:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TORQUE Dashboard</title>
<style>
  body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, system-ui, sans-serif; font-size: 13px; }
</style>
</head>
<body>
<div id="app">
  <nav id="tabs"></nav>
  <div id="tab-tasks"></div>
  <div id="tab-providers"></div>
  <div id="tab-workflow"></div>
  <div id="tab-cost"></div>
</div>
<script>
// Placeholder — full implementation in Task 2
document.getElementById('tab-tasks').textContent = 'Loading...';
</script>
</body>
</html>
```

- [ ] **Step 4: Modify mcp-protocol.js**

In `server/mcp-protocol.js`, add resource methods in the switch statement (after `tools/call` case):

```js
    case 'resources/list': {
      const { listResources } = require('./mcp-apps/resource-handler');
      return listResources();
    }

    case 'resources/read': {
      const { readResource } = require('./mcp-apps/resource-handler');
      return readResource(params);
    }
```

Also in the `initialize` response, add resources capability:

```js
capabilities: { tools: {}, resources: {} }
```

- [ ] **Step 5: Wire tool definition + annotations + tier**

Create `server/tool-defs/dashboard-app-defs.js`:

```js
module.exports = [
  {
    name: 'show_dashboard',
    description: 'Show interactive TORQUE dashboard inline in chat. Displays real-time task status, provider health, workflow progress, and cost tracking in a tabbed interface.',
    _meta: {
      ui: { resourceUri: 'ui://torque/dashboard' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        tab: {
          type: 'string',
          enum: ['tasks', 'providers', 'workflow', 'cost'],
          description: 'Initial tab to show (default: tasks)',
        },
      },
    },
  },
];
```

Add to `server/tools.js` TOOLS array:
```js
  ...require('./tool-defs/dashboard-app-defs'),
```

Add to `server/core-tools.js` TIER_1:
```js
  'show_dashboard',
```

Add to `server/tool-annotations.js` OVERRIDES:
```js
  show_dashboard:                  Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
```

Add a handler stub in a new file or inline — `show_dashboard` returns the initial tab parameter as text content. The actual rendering is done by the MCP Apps iframe, not the tool result:

Create `server/handlers/dashboard-app-handler.js`:
```js
'use strict';

function handleShowDashboard(args) {
  const tab = args.tab || 'tasks';
  return {
    content: [{
      type: 'text',
      text: `TORQUE Dashboard opened (tab: ${tab}). The interactive dashboard is rendering above.`,
    }],
  };
}

module.exports = { handleShowDashboard };
```

Add to `server/tools.js` HANDLER_MODULES:
```js
  require('./handlers/dashboard-app-handler'),
```

- [ ] **Step 6: Commit and push**

```bash
git add server/mcp-apps/ server/mcp-protocol.js server/tool-defs/dashboard-app-defs.js server/handlers/dashboard-app-handler.js server/tools.js server/core-tools.js server/tool-annotations.js server/tests/mcp-apps.test.js
git commit -m "feat: MCP Apps protocol — resource handler, show_dashboard tool, placeholder HTML"
git push origin main
```

---

### Task 2: Build the Full Dashboard HTML App

**Files:**
- Modify: `server/mcp-apps/dashboard.html` — replace placeholder with full tabbed dashboard

This is the main creative task — building the interactive HTML/CSS/JS app.

- [ ] **Step 1: Build the complete dashboard.html**

Replace the placeholder with a full self-contained HTML file. Requirements:

**Structure:**
- Tab bar at top: Tasks | Providers | Workflow | Cost
- Tab content below (~300px height, scrollable)
- Dark theme matching Claude Code (#0d1117 background, #e6edf3 text)
- Compact layout for ~500x350px iframe

**Tasks Tab:**
- Stat row: Running (green), Queued (yellow), Done (blue), Failed (red) — big numbers
- Task list: rows showing id (truncated), provider, progress %, stall indicator, description
- Pressure level indicator

**Providers Tab:**
- Host cards: name, status icon (green/yellow/red), running tasks count, model count
- Grid layout (2-3 hosts per row)

**Workflow Tab:**
- Workflow name + status badge
- Progress bar (completed/total)
- Task node list: node_id, status icon, provider, progress %

**Cost Tab:**
- Total spend number
- Budget utilization bar (green/yellow/red based on percentage)
- Top cost drivers list

**Data fetching via postMessage:**
```js
function callTool(name, args = {}) {
  return new Promise((resolve) => {
    const id = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const handler = (event) => {
      if (event.data?.id === id) {
        window.removeEventListener('message', handler);
        resolve(event.data.result);
      }
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args }
    }, '*');
  });
}
```

**Tab data loading:**
```js
async function loadTasksTab() {
  const result = await callTool('check_status');
  const data = result?.structuredContent || {};
  // Render data.running_count, data.queued_count, data.running_tasks, etc.
}
```

**Auto-refresh:** `setInterval(() => loadActiveTab(), 10000);`

**Tab switching:** Click handler that shows/hides tab divs, updates active tab style, triggers data fetch.

**Initial tab:** Read from URL params or default to 'tasks'. The `show_dashboard` tool passes `tab` as a parameter — the tool result text mentions the tab, and the app reads it from the initial tool call context if available, otherwise defaults to tasks.

The full HTML should be ~400-500 lines. Write it as a complete, working, self-contained page.

- [ ] **Step 2: Verify HTML is valid**

```bash
cd server && node -e "
const fs = require('fs');
const html = fs.readFileSync('mcp-apps/dashboard.html', 'utf8');
console.log('Size:', html.length, 'bytes');
console.log('Has DOCTYPE:', html.includes('<!DOCTYPE'));
console.log('Has tabs:', html.includes('tab-tasks') && html.includes('tab-providers'));
console.log('Has postMessage:', html.includes('postMessage'));
console.log('Has auto-refresh:', html.includes('setInterval'));
"
```

- [ ] **Step 3: Commit and push**

```bash
git add server/mcp-apps/dashboard.html
git commit -m "feat: full interactive MCP Apps dashboard — Tasks/Providers/Workflow/Cost tabs"
git push origin main
```

---

### Task 3: Final Verification

- [ ] **Step 1: Run all tests on remote**

```bash
torque-remote "cd server && npx vitest run tests/mcp-apps.test.js tests/sampling.test.js tests/elicitation.test.js tests/tool-annotations.test.js tests/tool-output-schemas.test.js tests/context-handler.test.js --reporter verbose"
```

- [ ] **Step 2: Verify tool appears correctly**

```bash
cd server && node -e "
const { TOOLS } = require('./tools');
const tool = TOOLS.find(t => t.name === 'show_dashboard');
console.log('show_dashboard found:', !!tool);
console.log('  _meta.ui:', JSON.stringify(tool._meta?.ui));
console.log('  annotations:', JSON.stringify(tool.annotations));
console.log('  in TIER_1:', require('./core-tools').CORE_TOOL_NAMES.includes('show_dashboard'));
"
```

- [ ] **Step 3: Verify resource serving**

```bash
cd server && node -e "
const { readResource } = require('./mcp-apps/resource-handler');
const result = readResource({ uri: 'ui://torque/dashboard' });
console.log('Resource served:', !!result.contents);
console.log('HTML size:', result.contents[0].text.length, 'bytes');
console.log('Has tabs:', result.contents[0].text.includes('tab-tasks'));
"
```

- [ ] **Step 4: Commit completion**

```bash
git add docs/superpowers/plans/2026-03-21-mcp-apps-dashboard.md docs/superpowers/specs/2026-03-21-mcp-apps-dashboard-design.md
git commit -m "docs: MCP Apps dashboard spec + plan — complete"
git push origin main
```
