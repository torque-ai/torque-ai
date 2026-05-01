# Remove Anthropic Provider — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully remove Anthropic as a TORQUE provider. No local/self-hosted option exists — it shouldn't be a default.

**Architecture:** Delete the provider class, remove from all registries/seeds/routing/fallback chains, update tests. Replace with `ollama-cloud` where Anthropic was used as a fallback.

**Tech Stack:** Node.js (CommonJS), SQLite, React + Tailwind, Vitest

---

## Task 1: Delete provider class + dedicated tests

**Files:**
- Delete: `server/providers/anthropic.js`
- Delete: `server/tests/anthropic-provider.test.js`

- [ ] Delete both files
- [ ] Commit: `refactor: delete Anthropic provider class and tests`

---

## Task 2: Remove from registries, seeds, config, constants

**Files:**
- Modify: `server/providers/registry.js` — remove `'anthropic'` from the `api` array (~line 27)
- Modify: `server/providers/adapter-registry.js` — remove `require('./anthropic')` import (~line 16) and `registerApiAdapter('anthropic', ...)` call (~line 215)
- Modify: `server/db/schema-seeds.js` — remove `insertProvider.run('anthropic', ...)` block (~line 141), remove from `provider_type` backfill map (~line 168), remove from capabilities seed (~line 184)
- Modify: `server/db/provider-capabilities.js` — remove `anthropic` entry (~line 9)
- Modify: `server/config.js` — remove `anthropic: 'ANTHROPIC_API_KEY'` from env map (~line 76)
- Modify: `server/constants.js` — remove `'anthropic': 15` from timeout map (~line 91)
- Modify: `server/task-manager.js` — remove `require('./providers/anthropic')` registration (~line 25), remove from `paidProviders` set (~line 1279), remove `ANTHROPIC_API_KEY` warning (~line 1208)
- Modify: `server/api-server.core.js` — remove `anthropic` from provider models map (~line 159), key mappings (~lines 225, 236)
- Modify: `server/api/v2-provider-registry.js` — remove `anthropic` metadata entry (~line 94)
- Modify: `server/free-quota-tracker.js` — remove `anthropic` entry (~line 25)
- Modify: `server/maintenance/orphan-cleanup.js` — remove `anthropic` from timeout/stall maps (~lines 72, 87)
- Modify: `server/db/config-keys.js` — remove `'anthropic_api_key'` (~line 12)
- Modify: `server/utils/safe-env.js` — remove `'anthropic'` env mapping (~line 41). Keep `'claude-cli': ['ANTHROPIC_API_KEY']` since Claude CLI actually uses that key.
- Modify: `server/utils/sensitive-keys.js` — remove `'anthropic_api_key'` (~line 22)
- Modify: `server/tool-defs/task-submission-defs.js` — remove `"anthropic"` from provider enum list (~line 50) and description text (~line 42)
- Modify: `server/providers/prompts.js` — remove `'anthropic'` from `isCloudProvider` list (~line 283)
- Modify: `server/types.js` — remove `anthropic` from JSDoc provider lists (~lines 14, 65)

- [ ] Make all edits
- [ ] Commit: `refactor: remove Anthropic from registries, seeds, config, and constants`

---

## Task 3: Remove from routing + fallback chains + economy

**Files:**
- Modify: `server/db/provider-routing-core.js` — remove the entire Anthropic routing block (lines ~353-370: `anthropicApiKey` check, `isSecurityTask || isXamlTask || isArchitecturalTask` → anthropic). Remove `'anthropic'` from CLOUD_PROVIDERS list (~line 709). Remove `'anthropic'` from ALL fallback chains (~lines 737-746) — it appears in codex, claude-cli, groq, ollama-cloud, cerebras, google-ai, openrouter, hyperbolic, deepinfra chains. Remove the dedicated `'anthropic'` fallback chain entry (~line 739).
- Modify: `server/economy/policy.js` — remove `'anthropic'` from `blocked` list (~line 23)
- Modify: `server/execution/queue-scheduler.js` — replace `'anthropic'` fallback reference with `'ollama-cloud'` (~line 928). Remove from comment (~line 823).
- Modify: `server/remote/remote-test-routing.js` — remove `ANTHROPIC_API_KEY` from env key regex (~line 8)
- Modify: `server/logger.js` — keep `ANTHROPIC_API_KEY` in redaction regex (it's a security measure for claude-cli which uses the same key)
- Modify: `server/api/v2-inference.js` — remove anthropic provider detection (~line 47)

- [ ] Make all edits
- [ ] Commit: `refactor: remove Anthropic from routing, fallback chains, and economy policy`

---

## Task 4: Update dashboard

**Files:**
- Modify: `dashboard/src/views/Providers.jsx` — remove `anthropic` from PROVIDER_COLORS (~line 17)
- Modify: `dashboard/src/views/Strategy.jsx` — remove `anthropic` from PROVIDER_COLORS (~line 15)
- Modify: `dashboard/src/views/Kanban.jsx` — remove `'anthropic'` from provider list (~line 25)
- Modify: `dashboard/src/views/History.jsx` — remove `'anthropic'` from provider list (~line 23)
- Modify: `dashboard/src/components/TaskDetailDrawer.jsx` — remove `'anthropic'` from provider list (~line 36)
- Modify: `dashboard/src/components/TaskSubmitForm.jsx` — remove `anthropic` model list (~line 11) and from provider dropdown (~line 131)
- Modify: `dashboard/src/utils/providerModels.js` — remove `anthropic` regex (~line 5)
- Modify: `dashboard/src/views/RoutingTemplates.test.jsx` — remove `anthropic` from mock data (~line 9)

- [ ] Make all edits
- [ ] Build dashboard: `cd dashboard && npm run build`
- [ ] Commit: `refactor: remove Anthropic from dashboard components`

---

## Task 5: Update tests

Many test files reference `anthropic` in assertions, mock data, or provider lists. For each file, the anthropic references need to be either removed or replaced with another provider (typically `ollama-cloud` or `deepinfra`).

**Files:**
- Modify: `server/tests/adapter-registry.test.js` — remove anthropic from mock providers, update assertions
- Modify: `server/tests/cloud-providers.test.js` — remove Anthropic provider test entry
- Modify: `server/tests/cloud-providers-e2e.test.js` — remove entire `E2E: Anthropic provider` describe block, remove from multi-provider tests
- Modify: `server/tests/api-server.test.js` — remove anthropic from model maps, provider lists, mock data
- Modify: `server/tests/config.test.js` — remove anthropic API key tests (keep as reference for other providers if pattern is used)
- Modify: `server/tests/constants.test.js` — remove `'anthropic'` from provider lists
- Modify: `server/tests/db-provider-routing-core.test.js` — remove anthropic routing test (~line 305), update provider references
- Modify: `server/tests/close-phases.test.js` — replace `'anthropic'` with `'ollama-cloud'` in mock data
- Modify: `server/tests/dashboard-infrastructure-routes.test.js` — replace `'anthropic'` with another provider in seed/assertion data
- Modify: `server/tests/db-provider-health-history.test.js` — replace `'anthropic'` with another provider
- Modify: `server/tests/schema-seeds.test.js` — remove anthropic from expected provider list
- Modify: `server/tests/provider-registry.test.js` — remove anthropic from expected registrations
- Modify: `server/tests/v2-provider-registry.test.js` — remove anthropic from expected metadata
- Modify: `server/tests/fallback-retry.test.js` — remove anthropic from fallback chains
- Modify: `server/tests/provider-routing.test.js` — remove anthropic references
- Modify: `server/tests/provider-routing-core.test.js` — remove anthropic references
- Modify: `server/tests/provider-routing-config.test.js` — remove anthropic references
- Modify: `server/tests/provider-adapter-registry.test.js` — remove anthropic references
- Modify: `server/tests/prefer-free-routing.test.js` — remove anthropic from chains
- Modify: `server/tests/slot-pull-routing.test.js` — remove anthropic references
- Modify: `server/tests/queue-scheduler.test.js` — remove anthropic references
- Modify: `server/tests/smart-routing-integration.test.js` — remove anthropic routing expectations
- Modify: `server/tests/economy-integration.test.js` — remove anthropic from blocked list assertions
- Modify: `server/tests/free-tier-overflow-integration.test.js` — remove anthropic references
- Modify: `server/tests/resource-gating.test.js` — remove anthropic references
- Modify: `server/tests/per-provider-concurrency.test.js` — remove anthropic references
- Modify: `server/tests/queue-helpers.test.js` — remove anthropic references
- Modify: `server/tests/deferred-provider-assignment.test.js` — remove anthropic references
- Modify: `server/tests/exp1-codex-provider-routing-core.test.js` — remove anthropic references
- Modify: `server/tests/routing-templates.test.js` — remove any anthropic references in template rules

- [ ] Make all edits
- [ ] Run: `cd server && npx vitest run` — all tests PASS
- [ ] Commit: `test: update all tests for Anthropic provider removal`

---

## Task 6: Final verification

- [ ] Run full server tests: `cd server && npx vitest run`
- [ ] Run full dashboard tests: `cd dashboard && npx vitest run`
- [ ] Grep for remaining references: `grep -ri anthropic server/ dashboard/src/ --include="*.js" --include="*.jsx" --include="*.json" | grep -v node_modules | grep -v ANTHROPIC_API_KEY` (ANTHROPIC_API_KEY may remain in logger redaction and claude-cli env — that's OK)
- [ ] Restart TORQUE, verify dashboard loads, verify Providers page has no Anthropic entry
- [ ] Commit any stragglers
