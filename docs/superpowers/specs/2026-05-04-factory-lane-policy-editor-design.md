# Factory Lane Policy Editor — Design

**Date:** 2026-05-04
**Branch:** `feat/lane-policy-editor`
**Worktree:** `.worktrees/feat-lane-policy-editor`

## Background

The Project Settings view in the dashboard surfaces each project's
factory `provider_lane_policy` (the `by_kind` map plus
`expected_provider`, `allowed_providers`, `allowed_fallback_providers`,
and `enforce_handoffs`) in a read-only panel
(`dashboard/src/views/ProjectSettings.jsx:70-159`). Editing today
requires hitting `set_factory_trust_level` via MCP or
`PUT /api/v2/factory/projects/{id}/trust` directly. Operators
have no way to adjust per-kind provider routing without leaving the
dashboard.

This change makes the panel fully editable.

## Goals

- Operators can adjust every field of a project's `provider_lane_policy`
  from the dashboard.
- Edits save immediately (inline auto-save) with clear status feedback.
- The editor reflects the live provider list, not a stale hardcoded one.

## Non-goals

- Editing routing templates from this panel (those live elsewhere).
- Adding new factory kinds beyond the existing
  `scout / architect_cycle / plan_generation / verify_review / execute`.
- Server-side schema changes — `set_factory_trust_level` already
  accepts arbitrary `provider_lane_policy` payloads.

## User-facing behavior

### Fields and controls

| Field | Control |
|---|---|
| `expected_provider` | Single `<select>` with sentinel `— none —` (sets to `null`) plus one option per provider in the live list. |
| `enforce_handoffs` | Existing `ToggleSwitch` component (`ProjectSettings.jsx:25`). |
| `allowed_providers` | New `MultiSelectDropdown` — button shows count + chips, opens a panel of checkboxes (one per provider). Toggling a checkbox auto-saves. |
| `allowed_fallback_providers` | Same `MultiSelectDropdown` component. |
| `by_kind[<kind>]` (5 rows) | Per-row `<select>` with sentinel `— use default —` (deletes the key from `by_kind`) plus one option per provider. |

Status indicator near the panel header shows `Saving…`, `Saved ✓`
(auto-clears after 2s), or `Save failed — retry`.

### Empty / disabled states

- `factoryProjectId` missing → render the panel with all controls
  disabled and a hint: `Project not registered with the factory —
  register it to enable editing.`
- `lanePolicy === null` and `factoryProjectId` set → render an empty
  editor seeded with
  `{expected_provider: null, allowed_providers: [], allowed_fallback_providers: [], by_kind: {}, enforce_handoffs: false}`
  so operators can create a policy on a project that does not yet have
  one. This replaces the current
  `lanePolicy ? <Panel /> : null` guard at `ProjectSettings.jsx:823`.

## Architecture

### Component layout

`FactoryLanePolicyPanel` in `ProjectSettings.jsx` is replaced. No new
files. The component grows from ~90 lines to ~250 lines and remains
self-contained inside the existing view file. A `MultiSelectDropdown`
component is defined at the top of the same file alongside
`ToggleSwitch` and `FormField`.

### Provider list source

Parent (`ProjectSettings`) gains two new state slices:

- `providers` — loaded once on mount via `requestV2('/providers')`
  (mapping to the existing `list_providers` MCP tool — already wired
  at `routes.js:769-770` as `/api/v2/providers`). On error, the parent
  falls back to a hardcoded baseline list and shows a one-time toast:
  `Provider list unavailable, using defaults`.
- `trustLevel` — captured from the same factory project record that
  already populates `factoryProjectId` and `lanePolicy`
  (`ProjectSettings.jsx:444-459`). The factory project summary
  returned by `factoryApi.projects()` already exposes `trust_level`
  (see `summarizeBasicFactoryProject` in
  `server/handlers/factory-handlers.js:122-130`). We need it because
  `set_factory_trust_level` schema marks `trust_level` as required and
  the DB validator
  (`server/db/factory/health.js:159`) throws on `undefined`. Every
  save echoes the current `trustLevel` back unchanged so the API call
  is well-formed.

Baseline fallback list:

```
ollama, codex, codex-spark, claude-cli, claude-ollama,
anthropic, deepinfra, hyperbolic, groq, cerebras,
google-ai, openrouter, ollama-cloud
```

`providers` and a new `onLanePolicyChange(nextPolicy)` callback are
passed into `FactoryLanePolicyPanel`.

### Save mechanics

Every field change goes through one path:

1. Compute `nextPolicy` by cloning current `lanePolicy` and applying
   the change. For per-kind rows whose new value is the
   `— use default —` sentinel, **delete** the key from `by_kind`
   rather than storing an empty string.
2. Optimistically `setLanePolicy(nextPolicy)`.
3. Fire
   `PUT /api/v2/factory/projects/{factoryProjectId}/trust`
   with body
   `{trust_level: <current trustLevel>, config: {provider_lane_policy: nextPolicy}}`.
   `trust_level` is echoed unchanged on every save (see Architecture →
   Provider list source for why).
4. On 2xx → status `Saved ✓` for 2s.
5. On error → revert to the pre-change snapshot, status
   `Save failed — retry`, toast the error message.

We always send the full `provider_lane_policy` object (not a partial
delta). Rationale: `set_factory_trust_level` shallow-merges `config`
into `factory_projects.config_json`. A partial would risk wiping
sibling fields inside `provider_lane_policy`.

### Concurrency: debounce-and-collapse

If a save is in flight when a second change arrives, queue **only the
latest** state. When the in-flight save resolves, fire one more PUT
with the queued state if it differs from what was just persisted.
Discard intermediate states. This avoids racing PUTs writing stale
data and avoids a chain of redundant requests when an operator clicks
quickly through several checkboxes.

### Provider validation

None in the UI. The runtime
`specializePolicyForKind(policy, kind)` in
`server/factory/provider-lane-policy.js:142-169` already auto-includes
a `by_kind` override provider in `allowed_providers` at routing time.
The UI does not need to mirror that — whatever the operator picks, we
save.

## Data flow

```
operator clicks dropdown
  → panel computes nextPolicy
  → setLanePolicy(nextPolicy)            (optimistic)
  → onLanePolicyChange(nextPolicy)
       → parent fires PUT /trust with {config: {provider_lane_policy: nextPolicy}}
       → parent updates save status
            → on 2xx: status = "Saved ✓" (clears after 2s)
            → on error: setLanePolicy(previousSnapshot); status = "Save failed — retry"; toast
```

## Error handling

- **Provider list fetch fails** — fall back to hardcoded baseline,
  one-time warning toast. Editor remains functional.
- **Save fails** — revert optimistic state, toast the API error,
  status indicator shows `Save failed — retry`. No automatic retry;
  the next field change retries naturally.
- **No `factoryProjectId`** — controls disabled with a hint. Reads of
  `lanePolicy` still work for visibility.
- **Concurrent edits across sessions** — out of scope. Last write
  wins, same as today's read-only-panel-plus-API workflow.

## Testing

Add `dashboard/src/views/ProjectSettings.test.jsx` (file does not
exist yet).

Cases:

1. Renders all five per-kind rows and the four top-level fields when
   `lanePolicy` is provided.
2. Changing a per-kind dropdown to a real provider fires
   `PUT /api/v2/factory/projects/{id}/trust` with the expected body
   shape (full `provider_lane_policy`, with the new key in `by_kind`).
3. Selecting `— use default —` in a per-kind row produces a PUT body
   whose `by_kind` does **not** contain the key (verifies key
   deletion, not empty-string storage).
4. Toggling a checkbox in the multi-select dropdown adds and removes
   the provider from `allowed_providers` across two consecutive PUTs.
5. Save failure reverts the optimistic local state and surfaces the
   error indicator.
6. Empty initial policy (`lanePolicy === null`, `factoryProjectId`
   set) renders an editable empty form, and a first edit produces a
   PUT with the seeded structure.

No server-side tests are required. `set_factory_trust_level` already
covers `config_json` merge behavior, and the runtime policy
specialization (`specializePolicyForKind`) is unchanged.

## Files affected

- `dashboard/src/views/ProjectSettings.jsx` — replace
  `FactoryLanePolicyPanel`, add `MultiSelectDropdown`, add provider
  list fetch + `onLanePolicyChange` plumbing in the parent component,
  loosen the `lanePolicy ? <Panel /> : null` render guard.
- `dashboard/src/views/ProjectSettings.test.jsx` — new file with the
  six test cases above.

## Out of scope follow-ups

- Surfacing kind-family inheritance (the `KIND_FAMILY` map in
  `provider-lane-policy.js:122-131`) — operators today set
  `architect_cycle` and trust the family fallback for
  `architect_json / replan_rewrite / replan_decompose`. Showing this
  inheritance graph in the UI would be useful but is not blocking.
- Editing the same data via CLI — the existing
  `set_factory_trust_level` MCP tool already covers that surface.
- Bulk-editing across projects — single-project scope only.
- Make `trust_level` optional on `set_factory_trust_level`. The
  tool's description says "Change the trust level **and/or** config"
  but the schema requires `trust_level`, so config-only edits force
  callers to echo the current value. A small follow-up would mark
  `trust_level` optional in `factory-defs.js:92` and gate the
  validator branch in `factory-handlers.js:1223` on
  `args.trust_level !== undefined`.
