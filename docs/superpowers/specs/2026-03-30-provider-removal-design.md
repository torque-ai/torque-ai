# Provider Removal — hashline-ollama, hashline-openai, aider-ollama + Hashline Format System

**Date:** 2026-03-30
**Status:** Approved

## Problem

Three legacy providers and the hashline format system are dead weight:
- **hashline-ollama** — replaced by the agentic `ollama` provider with native tool calling (qwen3-coder:30b)
- **hashline-openai** — never used, disabled since creation
- **aider-ollama** — deprecated, replaced by agentic `ollama`
- **Hashline format system** — no remaining consumers after hashline-ollama removal

All three providers are disabled with zero tasks. They add complexity to routing, fallback chains, tool schemas, and validation without providing value.

## Scope

### Delete entirely (files removed)
- `server/providers/execute-hashline.js` — hashline execution engine
- `server/utils/hashline-parser.js` — hashline format parser
- All associated test files for deleted modules

### Remove from provider lists (~50 source files)
Every file containing a valid-provider array, enum, or object literal needs the three providers removed. Categories:
- **Tool definition schemas** — provider enum arrays in `tool-defs/*.js`
- **Handler validation** — provider validation in `handlers/automation-handlers.js` and others
- **Routing** — `db/provider-routing-core.js`, `db/smart-routing.js`, routing template JSONs
- **Seed data** — `db/schema-seeds.js` provider seeding
- **Registry** — `providers/registry.js`, `providers/adapter-registry.js`, `api/v2-provider-registry.js`
- **Capabilities** — `providers/agentic-capability.js`, `db/provider-capabilities.js`
- **Scheduling** — `execution/queue-scheduler.js`, `execution/slot-pull-scheduler.js`, `execution/task-startup.js`
- **Fallback** — `execution/fallback-retry.js` fallback chain entries
- **Validation** — `validation/*.js` provider-specific branches
- **Discovery** — `discovery/discovery-engine.js` host-to-provider mapping
- **Dashboard** — `dashboard/dashboard.js`, `server/dashboard/index.html` provider lists
- **Config** — `server/config.js` hashline-related config keys

### Remove conditional branches
Any `if (provider === 'hashline-ollama')` or `case 'aider-ollama':` logic blocks.

### Database migration
- Delete rows from `provider_config` for the three providers
- Delete hashline config keys: `hashline_capable_models`, `hashline_format_auto_select`, `hashline_model_formats`, `hashline_lite_min_samples`, `hashline_lite_threshold`, `max_hashline_local_retries`
- Delete `smart_routing_default_provider` if it references `aider-ollama`

### Routing templates (JSON files)
- `server/routing/templates/*.json` — remove the three providers from all template rules

### MCP tools removed
- `hashline_read` — hashline-annotated file reading
- `hashline_edit` — hashline-annotated file editing

### Documentation
- `CLAUDE.md` — remove hashline-ollama from provider tables and references
- `docs/guides/*.md` — remove hashline/aider references
- `.claude/commands/*.md` — remove from slash command provider lists

### Test files
- Delete test files that exist solely for removed providers/modules
- Update test files that include the removed providers in fixture data

## What stays unchanged
- `ollama` provider (plain agentic tool-calling)
- `codex`, `codex-spark`, `claude-cli`, and all cloud API providers
- Provider architecture (registry, routing, fallback system)
- All other config keys, tools, and features

## Verification
- `npx vitest run` passes with no new failures
- `node server/index.js` starts without errors
- `list_providers` MCP tool shows 11 providers (was 14)
- No references to `hashline-ollama`, `hashline-openai`, or `aider-ollama` in source files (grep clean)
