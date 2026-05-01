# Dashboard Sidebar UX Redesign

## Problem

The sidebar has usability issues:

1. **Collapse button buried at bottom** — requires scrolling past all nav items to reach it
2. **Connected indicator buried at bottom** — same scrolling problem, hard to notice connection state
3. **Provider health indicator (HealthDots) in sidebar** — belongs with task context on the Kanban page, not in global navigation
4. **HealthDots only checks quota-tracked providers** — uses `/api/provider-quotas` which only covers providers with rate-limit headers (groq, cerebras, openrouter), missing codex, claude-cli, ollama variants, etc.

## Design

### 1. Sidebar Header Reorganization

**Move collapse button and connection indicator into the header row**, next to the logo. Remove all bottom-section content.

**Expanded sidebar header:**
```
┌──────────────────────────────┐
│ TORQUE              ● «      │
│ Task Orchestration           │
└──────────────────────────────┘
```
- `●` = connection status dot (green/yellow/red), clickable to expand the existing status panel
- `«` = collapse button

**Collapsed sidebar header:**
```
┌──────┐
│  T   │
│ ● »  │
└──────┘
```
- Connection dot and expand button stacked below the "T" logo

**What gets removed from the sidebar bottom:**
- Collapse button (moved to header)
- Connected/disconnected indicator + status panel (moved to header)
- HealthDots component (removed entirely — replaced by HealthBar on Kanban)

### 2. Kanban HealthBar — All-Provider Status

**Replace HealthBar's data source** from `/api/provider-quotas` to `/api/v2/providers`. Use `requestV2('/providers')` (not `request()`), which auto-unwraps the V2 envelope to return `{ providers: [{ id, name, enabled, status, ... }] }`. The endpoint returns every registered provider with a computed `status` field: `healthy`, `degraded`, `unavailable`, or `disabled`.

**Compact bar (default):**
```
┌─────────────────────────────────────────┐
│ Providers: 9/13 healthy ▾  Queue: 2    │
└─────────────────────────────────────────┘
```
- Clickable — toggling expansion
- `▾` / `▴` chevron indicates expandability
- "X/Y healthy" counts providers with status `healthy` out of total provider count

**Expanded popover (clicked):**
```
┌─────────────────────────────────────────┐
│ Providers: 9/13 healthy ▴  Queue: 2    │
├─────────────────────────────────────────┤
│ ● codex              ● groq            │
│ ● codex-spark        ● cerebras        │
│ ● claude-cli         ● deepinfra  deg. │
│ ● ollama             ● hyperbolic unav.│
│ ● hashline-ollama    ○ google-ai  dis. │
│ ● aider-ollama       ○ openrouter dis. │
│                      ○ anthropic  dis. │
└─────────────────────────────────────────┘
```
- Two-column grid of all providers
- Status dot colors: green (healthy), yellow (degraded), red (unavailable), gray (disabled)
- Non-healthy providers show a short status label
- Disabled providers use dimmed text
- No controls — view-only; the Providers page handles management
- Clicking outside the popover closes it
- Popover expands downward; scrollable if >20 providers

**Edge cases:**
- **Zero providers:** Show "Providers: none" in the compact bar, empty popover
- **API failure:** Show "Providers: err" (matching existing error pattern), popover disabled
- **Polling:** Refresh every 30 seconds (carried over from current HealthBar)

## Files to Modify

### Dashboard Components

| File | Change |
|------|--------|
| `dashboard/src/components/Layout.jsx` | Move collapse button + connection indicator into header div. Remove HealthDots import and usage. Remove bottom status section. |
| `dashboard/src/components/HealthDots.jsx` | Delete file (no longer used) |
| `dashboard/src/components/HealthBar.jsx` | Rewrite: fetch from `/api/v2/providers` instead of `/api/provider-quotas`. Add click-to-expand state. Render provider grid popover. |

### Tests

| File | Change |
|------|--------|
| `dashboard/src/components/Layout.test.jsx` | Update assertions for new header layout (collapse button, connection dot position) |
| `dashboard/src/components/HealthBar.test.jsx` | New test file — verify collapsed/expanded states, provider status rendering, data source |

### Unaffected Files

| File | Notes |
|------|-------|
| `dashboard/src/views/Providers.jsx` | Also calls `/api/provider-quotas` (line 432) for rate-limit detail. This is intentionally preserved — the Providers page shows quota-specific data that the V2 endpoint doesn't replicate. |

### No Backend Changes

The `/api/v2/providers` endpoint already returns all providers with `id`, `enabled`, `status` (healthy/degraded/unavailable/disabled), and all other metadata needed. No server changes required.

## Status Mapping

The `getV2ProviderStatus()` function in `server/api/v2-router.js` (line 201) computes status. The same logic also exists in `server/api-server.core.js`.

| Status | Condition | Dot Color | Text Color |
|--------|-----------|-----------|------------|
| `healthy` | Enabled, no significant failures | `bg-green-500` | `text-slate-200` |
| `degraded` | Enabled, has failures but `isProviderHealthy()` still true | `bg-yellow-500` | `text-slate-200` |
| `unavailable` | Enabled, 3+ total tasks AND `isProviderHealthy()` returns false | `bg-red-500` | `text-slate-200` |
| `disabled` | `enabled: false` | `bg-slate-600` | `text-slate-500` |

## Summary Counting

- **Healthy count** = providers where `status === 'healthy'`
- **Total count** = all providers returned by the endpoint (enabled + disabled)
- **Queue count** = unchanged, still fetched from `/api/tasks?status=running`
