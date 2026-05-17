# Adding a New Plugin

This guide walks maintainers through adding a new plugin to TORQUE.
For the full contract specification, see `docs/plugin-contract.md`.

## Prerequisites

Before starting, familiarize yourself with:

- `server/plugins/plugin-contract.js` — defines the 8 required fields and validates
  plugin instances at load time.
- `server/plugins/loader.js` — the loader that resolves, instantiates, validates, and
  returns plugin instances. Uses a 3-way factory dispatch: `createPlugin` (canonical) /
  `createSnapScopePlugin` (legacy) / `createAuthPlugin` (legacy).
- `server/index.js` line 64 — the `DEFAULT_PLUGIN_NAMES` array that controls which
  plugins load at startup.

## Step 1: Create the Plugin Module

Create `server/plugins/<name>/index.js`. Export a `createPlugin` factory function that
returns a plugin instance conforming to the contract.

    'use strict';

    function createPlugin() {
      return {
        name: '<your-plugin-name>',
        version: '1.0.0',

        install(container) {
          // Wire into the DI container. Subscribe to events via:
          //   const eventBus = container.get('eventBus');
          //   eventBus.on('task:completed', handler);
        },

        uninstall() {
          // Tear down anything install() registered.
          // Called in tests and during plugin hot-reload.
        },

        middleware() {
          // Return Express middleware (function or array), or null to skip.
          return null;
        },

        mcpTools() {
          // Return array of MCP tool definitions:
          // [{ name, description, inputSchema, handler }]
          return [];
        },

        eventHandlers() {
          // IMPORTANT: This method is required by the contract validator but
          // is NOT called during boot. It exists as a documentary surface.
          // Register actual event subscriptions inside install() via the
          // container's eventBus instead.
          return {};
        },

        configSchema() {
          // Return a JSON-Schema-shaped config description, or null.
          // Like eventHandlers(), this is required by the validator but not
          // consumed by any boot pass today.
          return null;
        },
      };
    }

    module.exports = { createPlugin };

**Always export `createPlugin`.** The loader also checks for `createSnapScopePlugin` and
`createAuthPlugin` as legacy fallbacks, but new plugins must use the canonical name.

## Step 2: Implement the Contract Methods

### Required fields (8)

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Stable plugin identifier; logged and used for tool deduplication |
| `version` | string | Free-form version string (no semver enforcement) |
| `install(container)` | function | Wire into the DI container at boot |
| `uninstall()` | function | Tear down registrations (used in tests) |
| `middleware()` | function | Return Express middleware or null |
| `mcpTools()` | function | Return array of MCP tool definitions |
| `eventHandlers()` | function | Return event-handler map (stub — see warning below) |
| `configSchema()` | function | Return JSON Schema for config (stub — see warning below) |

> **Warning — `eventHandlers()` and `configSchema()` stubs:**
> Both methods are required by `validatePlugin()` in `server/plugins/plugin-contract.js`,
> but neither is consumed by any boot integration pass in `server/index.js` today. Every
> existing plugin ships empty stubs (`return {}` / `return null`) to pass validation.
> Do NOT rely on these methods being called at boot. Subscribe to events directly inside
> `install()` via the container's eventBus — the same pattern used by all 7 existing
> plugins.

### Optional methods

| Method | Type | Purpose |
|--------|------|---------|
| `tierTools()` | function | Map tool names to visibility tiers (Tier 1/2/3) |
| `enabled()` | function | Return `false` to skip loading entirely (env-var gates) |
| `health()` | function | Return `{ status, details? }` for `/healthz` aggregation |
| `migrate(prev, curr)` | function | Run once per version pair for state migration |

## Step 3: Add MCP Tools with Tier Classification

Tools returned by `mcpTools()` follow this shape:

    mcpTools() {
      return [
        {
          name: 'my_tool',
          description: 'Does something useful',
          inputSchema: {
            type: 'object',
            properties: { param: { type: 'string' } },
            required: ['param'],
          },
          handler: async (args) => {
            // Tool implementation
            return { content: [{ type: 'text', text: 'result' }] };
          },
        },
      ];
    }

Control tool visibility with `tierTools()`:

    tierTools() {
      return {
        tier1: ['my_important_tool'],  // visible by default (core)
        tier2: ['my_extended_tool'],   // visible after unlock_tier
        // Tools not listed here are Tier 3 (unlock_all_tools only)
      };
    }

Built-in tools always shadow plugin tools with the same name. Plugin-to-plugin name
collisions are NOT checked — later-loaded plugins win silently.

## Step 4: Register as a Default Plugin

Add the plugin name to `DEFAULT_PLUGIN_NAMES` in `server/index.js` (line 64):

    const DEFAULT_PLUGIN_NAMES = Object.freeze([
      'snapscope', 'version-control', 'remote-agents',
      'model-freshness', 'auto-recovery-core', 'codegraph',
      '<your-plugin-name>',
    ]);

If the plugin should only load conditionally (like `auth` for enterprise mode), do NOT
add it to `DEFAULT_PLUGIN_NAMES`. Instead, use the `enabled()` gate or the
`AUTH_MODE_PLUGIN_MAP` pattern in `server/plugins/loader.js`.

## Step 5: Validate

Run the plugin contract validator to confirm your plugin passes:

    node -e "
      const { validatePlugin } = require('./server/plugins/plugin-contract');
      const { createPlugin } = require('./server/plugins/<name>');
      const result = validatePlugin(createPlugin());
      if (!result.valid) { console.error(result.errors); process.exit(1); }
      console.log('Plugin contract: PASS');
    "

## Boot Integration Order

The loader and `server/index.js` process plugins in four passes:

1. **Pass 1 — install:** `plugin.install(container)` wires services into the DI container.
2. **Pass 2 — middleware:** `plugin.middleware()` returns Express middleware for HTTP interception.
3. **Pass 3 — mcpTools + tierTools:** Tool definitions are collected and classified into tiers.
4. **Pass 4 — eventHandlers:** NOT wired in boot (see warning above).

Install failures are caught and logged but do not abort startup.

## Checklist

- [ ] `server/plugins/<name>/index.js` exports `createPlugin`
- [ ] All 8 required contract fields are implemented
- [ ] `eventHandlers()` returns `{}` (stub — events registered in `install()`)
- [ ] `configSchema()` returns `null` or a schema object (stub is fine)
- [ ] Plugin added to `DEFAULT_PLUGIN_NAMES` if it should auto-load
- [ ] `tierTools()` defined if your tools need Tier 1/2 visibility
- [ ] `validatePlugin(createPlugin())` passes with zero errors
