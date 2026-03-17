# Ollama Cloud Provider Promotion

**Date:** 2026-03-17
**Status:** Approved
**Problem:** ollama-cloud is a capable free provider (480B+ models on datacenter hardware) but is systematically deprioritized across TORQUE's routing, fallback, and orchestration systems.

## Current State

ollama-cloud already has:
- Provider class (`server/providers/ollama-cloud.js`) with submit, streaming, health checks
- Registration in provider registry (`server/providers/registry.js`) under `api` category
- Band B capabilities (`reasoning`, `large_context`, `code_review`) in `provider-capabilities.js`
- Routing block for reasoning/large-code/architectural tasks in `analyzeTaskForRouting()` (lines 392-405)
- Inclusion in fallback chains for groq, cerebras, google-ai, openrouter, deepinfra, hyperbolic, and local ollama providers
- Context-stuffing budget (200K tokens)
- Rate limits seeded (10 RPM, 500 RPD)
- v2-provider-registry metadata with `reasoning: true`

What's broken:
- Seeded `enabled=0` with `max_concurrent=2`
- Missing from codex/claude-cli/anthropic fallback chains
- Last in CLOUD_PROVIDERS priority list
- Last in cloudFreeOrder (prefer_free path)
- Blocked from code tasks by hardcoded `FREE_PROVIDER_SCAN_ONLY_TYPES` gate
- Not available as a strategic brain backend
- Not suggested as a fallback for OOM/connection errors
- Not tried before codex when local Ollama is down

## Changes

### 1. Schema & Seeds

**`server/db/schema-seeds.js`:**
- ollama-cloud seeded with `enabled=1` (was 0) and `max_concurrent=10` (was 2)
- New `scan_only` column on `provider_config` (integer/boolean, default 1)
- Seeds: `scan_only=0` for ollama-cloud and all non-free providers; `scan_only=1` for groq, cerebras, google-ai, openrouter

**`server/db/schema-migrations.js`:**
- Migration to add `scan_only INTEGER DEFAULT 1` to `provider_config`
- Backfill: set `scan_only=0` for ollama-cloud, codex, claude-cli, deepinfra, hyperbolic, anthropic, ollama, aider-ollama, hashline-ollama
- Update existing ollama-cloud row: `enabled=1`, `max_concurrent=10` (for existing DBs that already seeded the old values)

### 2. Free Quota Tracker — Per-Provider Scan-Only

**`server/free-quota-tracker.js`:**
- Remove hardcoded `FREE_PROVIDER_SCAN_ONLY_TYPES` gate from `getAvailableProvidersSmart()`
- Accept a `scanOnlyProviders` Set from the caller via `taskMeta.scanOnlyProviders`
- Skip provider only if it's in the scan-only set AND `taskType` is not in `['scan', 'reasoning', 'docs']`
- Providers with `scan_only=0` (ollama-cloud) pass through for all task types

**Callers that must pass `scanOnlyProviders`:**
- `server/execution/queue-scheduler.js` — reads `scan_only` from provider_config DB rows, builds Set, passes to `getAvailableProvidersSmart()`
- Any other callers of `getAvailableProvidersSmart()` (search for usage at implementation time)

### 3. Cloud Priority & Fallback Chains

**`server/db/provider-routing-core.js`:**

**CLOUD_PROVIDERS list** — move ollama-cloud from last to after anthropic:
```
['codex', 'claude-cli', 'deepinfra', 'hyperbolic', 'anthropic', 'ollama-cloud', 'groq', 'cerebras', 'google-ai', 'openrouter']
```

**Default fallback chains** — add ollama-cloud to the three chains that currently lack it:
- `codex`: `['claude-cli', 'deepinfra', 'ollama-cloud', 'aider-ollama', 'ollama', 'anthropic']`
- `claude-cli`: `['codex', 'deepinfra', 'ollama-cloud', 'aider-ollama', 'ollama', 'anthropic']`
- `anthropic`: `['deepinfra', 'ollama-cloud', 'claude-cli', 'codex', 'aider-ollama', 'ollama']`

Other fallback chains already include ollama-cloud and need no changes.

**`cloudFreeOrder`** (prefer_free path) — ollama-cloud first:
```
['ollama-cloud', 'google-ai', 'groq', 'openrouter', 'cerebras']
```

### 4. Strategic Brain

**`server/orchestrator/strategic-brain.js`:**

- Add to `PROVIDER_MAP`: `'ollama-cloud': '../providers/ollama-cloud'`
- Add to `DEFAULT_MODELS`: `'ollama-cloud': 'qwen3-coder:480b'`
- Insert into `PROVIDER_CHAIN` after hyperbolic: `['deepinfra', 'hyperbolic', 'ollama-cloud', 'ollama']`
- Add `hasProviderCredentials` case: `case 'ollama-cloud': return !!process.env.OLLAMA_CLOUD_API_KEY;`
- Add to `providerEnvFallbacks`: `'ollama-cloud': process.env.OLLAMA_CLOUD_API_KEY`

### 5. Deterministic Fallbacks

**`server/orchestrator/deterministic-fallbacks.js`:**

- OOM error pattern: change `suggested_provider` from `'deepinfra'` to `'ollama-cloud'`
- Connection refused pattern: change `suggested_provider` from `'deepinfra'` to `'ollama-cloud'`

Note: ollama-cloud has rate limits (10 RPM, 500 RPD). If fallback traffic exceeds these, the existing fallback chain mechanism will cascade to the next provider (deepinfra/codex). This is acceptable — free-first is the right default.

### 6. Complexity Routing — Ollama-Cloud Escape Hatch

**`server/db/provider-routing-core.js` — `maybeApplyFallback()`:**

When Ollama is unhealthy and user didn't explicitly request an Ollama provider, try ollama-cloud (free) before falling back to the paid `ollamaFallbackProvider` (codex):

```js
// Try ollama-cloud first (free, capable)
const ocKey = serverConfig.getApiKey('ollama-cloud');
const ocConfig = getProvider('ollama-cloud');
if (ocKey && ocConfig && ocConfig.enabled) {
  return { ...result, provider: 'ollama-cloud',
    reason: `${result.reason} [Ollama unavailable - falling back to ollama-cloud (free)]`,
    originalProvider: result.provider, fallbackApplied: true };
}
// Then paid fallback
```

## Files Changed

| File | Change Type |
|------|------------|
| `server/db/schema-seeds.js` | Enable ollama-cloud, add scan_only column + seeds |
| `server/db/schema-migrations.js` | Migration for scan_only column + enable ollama-cloud on existing DBs |
| `server/free-quota-tracker.js` | Per-provider scan-only via caller-supplied set |
| `server/execution/queue-scheduler.js` | Pass scanOnlyProviders to getAvailableProvidersSmart |
| `server/db/provider-routing-core.js` | Cloud priority, fallback chains, maybeApplyFallback |
| `server/orchestrator/strategic-brain.js` | Add ollama-cloud to provider map/chain/env fallbacks |
| `server/orchestrator/deterministic-fallbacks.js` | Change suggested fallback provider |

## Test Updates Required

- `server/tests/free-quota-tracker.test.js` — Update scan-only enforcement tests to use new `scanOnlyProviders` parameter
- `server/tests/deterministic-fallbacks.test.js` (if exists) — Update expected suggested_provider values
- `server/tests/local-first-fallback.test.js` — Verify ollama-cloud fallback before codex
- `server/tests/fallback-retry.test.js` — Verify new fallback chain entries

## Non-Goals

- Changing ollama-cloud's Band (stays B — correct for 480B+ reasoning models)
- Changing context-stuffing budgets (200K is already appropriate)
- Modifying the provider executor (`execute-api.js` already handles it via registry)
- Changing the v2-provider-registry metadata (already correct)
- Adding `file_creation` or `file_edit` capabilities (ollama-cloud uses chat API, not file-editing format — code output comes as text in responses, which is appropriate for its Band B role)
