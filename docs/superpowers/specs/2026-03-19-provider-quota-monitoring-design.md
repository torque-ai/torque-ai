# Provider Quota Monitoring Design

**Date:** 2026-03-19
**Status:** Approved
**Scope:** Server quota store + dashboard provider cards + routing integration

## Problem

Cloud LLM providers (groq, cerebras, google-ai, openrouter, deepinfra, hyperbolic) have rate limits and daily quotas. TORQUE has no visibility into how much quota remains — tasks get submitted blindly and fail with 429 errors. The dashboard doesn't show quota status, and routing doesn't consider quota when selecting providers.

Live testing showed groq hitting Dev Tier quota limits mid-session with no warning. Tasks fail, get retried, waste time.

## Solution

A hybrid quota monitoring system with three data sources:

1. **Response headers** (real-time, zero cost) — capture `x-ratelimit-*` headers from every API response. Works for groq, cerebras, openrouter.
2. **Task history inference** (fallback) — derive usage from TORQUE's own task stats and token usage records for providers without header data. Works for google-ai, deepinfra, hyperbolic, ollama-cloud.

No separate quota polling APIs — Google AI has no queryable quota endpoint via API key, and other headerless providers don't either. We rely on headers where available and our own task records everywhere else.

The quota data feeds both the dashboard (visibility) and the router (smart provider selection).

## Data Model

Per-provider quota entry (in-memory, not persisted):

```js
{
  provider: 'cerebras',
  limits: {
    rpm: { limit: 200, remaining: 142, resetsAt: '2026-03-19T12:05:00Z' },
    tpm: { limit: 100000, remaining: 87500, resetsAt: '2026-03-19T12:05:00Z' },
    daily: { limit: 1000, remaining: 830, resetsAt: '2026-03-20T00:00:00Z' },
  },
  status: 'green',        // green (>50%), yellow (10-50%), red (<10% or 429)
  lastUpdated: '2026-03-19T12:01:23Z',
  source: 'headers',      // 'headers' | 'inference'
}
```

Fields are nullable. If a provider doesn't report TPM, `limits.tpm` is absent. Status is computed from the lowest remaining percentage across all limit types. Source indicates data freshness.

**Concurrency model:** Last-write-wins. `updateFromHeaders` always overwrites regardless of timestamp ordering. When a rate-limit window resets, the new `remaining` value will be higher than the old — this is expected and correct. JavaScript is single-threaded so individual property assignments are atomic. Status is recomputed on every update from the current snapshot of all limits.

## Provider Header Matrix

| Provider | RPM Headers | TPM Headers | Reset Format | Header Access |
|----------|------------|------------|-------------|---------------|
| groq | `x-ratelimit-remaining-requests` | `x-ratelimit-remaining-tokens` | Relative duration (`6s`, `1m30s`) | `fetch` Response.headers.get() |
| cerebras | `x-ratelimit-remaining-requests` | `x-ratelimit-remaining-tokens` | ISO timestamp | `fetch` Response.headers.get() |
| openrouter | `x-ratelimit-remaining-requests` | No | Unix epoch integer | `fetch` Response.headers.get() |
| google-ai | No (only 429 error body) | No | N/A | `http.request` res.headers[] |
| deepinfra | No | No | N/A | N/A |
| hyperbolic | No | No | N/A | N/A |
| ollama-cloud | No | No | N/A | N/A |

## Header Capture

Headers are captured in each provider's `submit()` and `submitStream()` methods — **not** in the chat adapters. The providers that return rate limit headers are:

- `server/providers/groq.js` — uses `fetch()`, headers via `response.headers.get()`
- `server/providers/cerebras.js` — uses `fetch()`, headers via `response.headers.get()`
- `server/providers/openrouter.js` — uses `fetch()`, headers via `response.headers.get()`

After each successful response, call `quotaStore.updateFromHeaders(provider, headers)`.

### Reset time normalization

The `updateFromHeaders` parser must normalize three different reset formats to ISO datetime:

- **Groq**: relative duration string (`6s`, `1m30s`, `2m`) → `new Date(Date.now() + parseDuration(value)).toISOString()`
- **Cerebras**: ISO timestamp string → store directly
- **OpenRouter**: Unix epoch integer → `new Date(value * 1000).toISOString()`

The parser detects the format from the value: if it contains letters (`s`, `m`), it's a relative duration; if it contains `T` or `-`, it's ISO; if it's all digits, it's epoch.

### Agentic path header capture

For agentic tasks (cerebras/groq/openrouter via the agentic loop), the chat adapters also make API calls. The `openai-chat.js` adapter should capture headers from its `fetch()` responses as well, passing the provider name from the adapter options.

## Task History Inference (5-minute cycle)

For providers with no external quota data (google-ai, deepinfra, hyperbolic, ollama-cloud), a background timer estimates usage from TORQUE's own records every 5 minutes:

- Query `provider_usage` table for tasks completed in the last hour
- Use existing `usage.tokens` from task results (already tracked), not chars/4 estimation
- Compare against known free-tier limits stored in a `KNOWN_FREE_TIER_LIMITS` config:
  ```js
  { 'groq': { rpm: 30, tpd: 6000 }, 'cerebras': { rpm: 30, tpd: 1000000 }, ... }
  ```
- Mark source as `'inference'` so dashboard shows reduced confidence

Also runs for header-capable providers as a supplemental daily-usage estimate (headers give per-window RPM/TPM but not daily totals).

## Routing Integration

Quota checking is added to the **template resolution chain iteration loops** in `analyzeTaskForRouting` (lines ~508-520 and ~552-574 of `provider-routing-core.js`), not in `maybeApplyFallback`. These loops already iterate the provider chain looking for an enabled provider — the quota check is an additional filter:

```js
for (let i = 0; i < chain.length; i++) {
  const entry = chain[i];
  const provConfig = getProvider(entry.provider);
  if (!provConfig || !provConfig.enabled) continue;

  // NEW: skip providers with exhausted quota
  const quota = quotaStore.getQuota(entry.provider);
  if (quota && quota.limits) {
    const anyExhausted = Object.values(quota.limits).some(l => l.remaining === 0);
    if (anyExhausted) {
      logger.info(`[SmartRouting] Skipping ${entry.provider} — quota exhausted`);
      continue;
    }
  }

  return maybeApplyFallback({ provider: entry.provider, ... });
}
```

Rules:
- `remaining === 0` on any limit → skip provider, try next in chain
- `status === 'red'` (< 10%) → log warning but still use (may have enough for this task)
- No quota data → treat as healthy (don't block on missing data)

## Dashboard UI

### Inline quota bars (Option A)

On each provider card, below existing stats:

```
┌─ cerebras ─────────────────────┐
│ ✓ 46 tasks  100% success       │
│ ██████████░░ 142/200 RPM       │
│ ████████████████░ 87K/100K TPM │
│ Updated 23s ago (headers)      │
└────────────────────────────────┘
```

- Progress bars colored: green >50%, yellow 10-50%, red <10%
- Only shows limit types with data
- "Updated Xs ago (headers/inference)" shows data freshness
- Providers with no data show nothing (no empty bars)

### Status badge (Option C)

Colored dot in top-right corner of each card:

- Green: all limits >50%
- Yellow: any limit 10-50%
- Red: any limit <10% or 429 received recently
- Gray: no quota data available

Tooltip on hover shows full breakdown:

```
● RPM: 142/200 (71%)
● TPM: 87,500/100,000 (88%)
● Resets in 3m 42s
```

### REST Endpoint

`GET /api/provider-quotas` returns all providers' quota data. Follows the same authentication model as existing `/api/providers` routes. Fetched by the dashboard as part of the existing `loadData` call in `Providers.jsx` (merged into the existing `Promise.all`, not a separate polling loop).

## Files

**New:**
- `server/db/provider-quotas.js` — in-memory quota store, header parser (with reset time normalization), inference timer
- `server/tests/provider-quotas.test.js` — unit tests

**Modified:**
- `server/providers/groq.js` — capture `x-ratelimit-*` headers from fetch response in `submit()`/`submitStream()`
- `server/providers/cerebras.js` — capture headers from fetch response
- `server/providers/openrouter.js` — capture headers from fetch response
- `server/providers/adapters/openai-chat.js` — capture headers from agentic path fetch responses
- `server/db/provider-routing-core.js` — add quota exhaustion check in template chain iteration loops
- `server/index.js` — init quota store, start inference timer
- `dashboard/src/views/Providers.jsx` — inline bars + status badge + tooltip, merged into existing loadData
- Dashboard API routes — add `GET /api/provider-quotas`

**Not modified:**
- No DB schema changes (in-memory only)
- No new dependencies
- `google-chat.js` unchanged (Google doesn't return quota headers; uses inference)
- `ollama-chat.js` unchanged (no quota headers from Ollama)

## Test Cases

### Quota Store
- `updateFromHeaders` correctly parses groq headers (relative duration reset)
- `updateFromHeaders` correctly parses cerebras headers (ISO reset)
- `updateFromHeaders` correctly parses openrouter headers (epoch reset)
- Last-write-wins: newer update always overwrites older data
- Missing headers don't overwrite existing data
- Status computation: green/yellow/red thresholds
- `getQuota(provider)` returns null for unknown providers
- Inference timer runs every 5 minutes and updates headerless providers

### Routing Integration
- Provider with 0 remaining requests is skipped in chain
- Provider at red status (<10%) logs warning but is still selectable
- Provider with no quota data is treated as healthy
- Quota check doesn't block when store is empty (first startup)
- Chain iteration skips exhausted provider and selects next

### Dashboard
- Quota bars render correctly with partial data (RPM only, no TPM)
- Status badge shows correct color based on worst limit
- Tooltip shows breakdown with reset countdown
- Graceful handling of providers with no quota info (gray dot)
- Quota data merged into existing loadData cycle

## Not In Scope

- Persisting quota data across restarts (ephemeral — headers repopulate on first request)
- Quota alerts/notifications (future: warn when approaching limits)
- Per-model quotas (most providers share quota across models)
- Cost tracking integration (separate existing system in `cost-tracking.js`)
- Google AI quota polling (no API-key-accessible endpoint exists)
