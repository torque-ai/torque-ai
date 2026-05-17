# Adding a New Execution Provider

This guide walks maintainers through adding a new execution provider to TORQUE.
For user-facing provider configuration, see `docs/guides/providers.md`.

## Prerequisites

Before starting, familiarize yourself with:

- `server/providers/registry.js` — the provider category map (lines 22-36) that
  assigns every provider to exactly one category (`ollama`, `codex`, `api`, `system`).
- `server/providers/base.js` — the `BaseProvider` class every provider extends.
- `server/providers/builtin-providers.js` — where provider classes are registered
  at boot.

## Step 1: Create the Provider Module

Create `server/providers/<name>.js`. Your provider must extend `BaseProvider` and
implement at minimum `submit()` (the execute entry point), `checkHealth()`, and
`listModels()`.

    'use strict';

    const BaseProvider = require('./base');
    const logger = require('../logger').child({ component: 'provider-<name>' });

    class MyProvider extends BaseProvider {
      constructor(config = {}) {
        super({ name: '<name>', ...config });
        this.apiKey = config.apiKey || process.env.MY_PROVIDER_API_KEY;
        this.baseUrl = config.baseUrl || 'https://api.example.com';
      }

      async submit(task, model, options = {}) {
        // Call the provider API, return { output, status, usage }
      }

      async checkHealth() {
        // Return { available: boolean, models: string[], error?: string }
      }

      async listModels() {
        // Return string[] of available model IDs
      }
    }

    module.exports = MyProvider;

Key conventions:

- API key resolution order: constructor config > environment variable > encrypted
  DB value (via `serverConfig.getApiKey(name)` in the registry).
- Environment variable naming: `<PROVIDER_NAME>_API_KEY` (uppercase, underscores).
- Return `{ output, status, usage: { tokens, cost, duration_ms } }` from `submit()`.

## Step 2: Register in the Provider Registry

Edit `server/providers/registry.js` and add your provider name to the appropriate
category array in `PROVIDER_CATEGORIES` (line 22):

- `ollama` — local Ollama-protocol providers
- `codex` — CLI-based agentic providers (Codex, Claude Code, etc.)
- `api` — cloud API providers with API keys
- `system` — internal system providers

For example, to add an API provider:

    api: ['anthropic', 'groq', 'hyperbolic', 'deepinfra',
         'ollama-cloud', 'cerebras', 'google-ai', 'openrouter', '<name>'],

Then register the class in `server/providers/builtin-providers.js`:

    providerRegistry.registerProviderClass('<name>', require('./<name>'));

This wires lazy initialization — the instance is created on first use via
`getProviderInstance()`.

## Step 3: Add Configuration Keys

Providers that need persistent configuration (API keys, endpoint URLs, model
defaults) should use the config database. Add keys via `configure_provider`:

    configure_provider { provider: "<name>", enabled: true }

The runtime resolves API keys through three layers (checked in order):

1. Environment variable: `<PROVIDER_NAME>_API_KEY`
2. Encrypted DB storage (written via `configure_provider`)
3. Legacy config table fallback

No migration script is needed for new providers — `configure_provider` creates
the rows on first use.

## Step 4: Add Routing Template Category Mapping

If the provider should participate in smart routing, add it to the appropriate
fallback chains in `server/routing/templates/*.json`. The 10 task categories are:

    security, xaml_wpf, architectural, reasoning, large_code_gen,
    documentation, simple_generation, targeted_file_edit,
    plan_generation, default

Each template maps categories to ordered provider arrays. Add your provider where
it makes sense (e.g., a fast inference provider goes into `simple_generation` and
`documentation` chains).

After editing templates, run the regression tests:

    npx vitest run server/tests/routing-templates.test.js

These pin presets to the canonical category set and validate the schema.

## Step 5: Configure Stall Detection

Every provider should have stall-detection thresholds so TORQUE can auto-recover
stuck tasks. Configure via:

    configure_stall_detection {
      provider: "<name>",
      stall_threshold_seconds: 180,
      auto_resubmit: true
    }

Recommended thresholds:

- Fast inference APIs (Groq, Cerebras): 60-120 seconds
- Standard APIs (DeepInfra, Hyperbolic): 120-180 seconds
- CLI-based providers (Codex, Claude): 120-600 seconds

## Optional: Ship as a Plugin

Providers with additional lifecycle requirements (custom middleware, MCP tools,
event subscriptions) can ship as plugins instead of built-in providers. The plugin
contract is defined in `server/plugins/plugin-contract.js` and requires:

- `name` (string) — unique plugin identifier
- `version` (string) — semver
- `install(container)` — initialization hook (register with the DI container)
- `uninstall()` — teardown hook
- `middleware()` — Express middleware (return `null` if none)
- `mcpTools()` — additional MCP tool definitions (return `[]` if none)
- `eventHandlers()` — event subscriptions (return `{}`)
- `configSchema()` — JSON schema for plugin config (return `{}`)

Place plugins in `server/plugins/<name>/index.js`. See `docs/plugin-contract.md`
for the full contract reference.

## Real-World Example

The Claude Code SDK provider (`server/providers/claude-code-sdk.js`) was added
following this exact workflow. Its planning document at
`docs/superpowers/plans/archive/2026-04-11-fabro-84-claude-code-sdk-provider.md`
shows the full design including permission chains, session storage, and MCP tool
registration.

## Checklist

- [ ] Provider module created in `server/providers/<name>.js`
- [ ] Extends `BaseProvider`, implements `submit()`, `checkHealth()`, `listModels()`
- [ ] Added to `PROVIDER_CATEGORIES` in `server/providers/registry.js`
- [ ] Registered in `server/providers/builtin-providers.js`
- [ ] Environment variable documented (`<NAME>_API_KEY`)
- [ ] Routing template chains updated (if participating in smart routing)
- [ ] Stall detection configured via `configure_stall_detection`
- [ ] Fallback chain position defined via `configure_fallback_chain`
- [ ] Provider appears in `docs/guides/providers.md` user-facing reference
