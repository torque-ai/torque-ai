# Dashboard Fallback Chain Editor

**Date:** 2026-03-18
**Status:** Approved
**Scope:** Update RoutingTemplates.jsx to display and edit fallback chains alongside legacy single-provider rules

## Problem

The routing template system now supports fallback chains (`[{provider, model}, ...]`), but the dashboard UI only renders single-provider dropdowns. Users can't see or edit chains in the Routing Templates page. Chain-format presets (Free Agentic, Free Speed) show incorrectly.

## Solution

Extend `RoutingTemplates.jsx` with auto-detecting chain editing. Legacy string rules keep the existing dropdown. Chain array rules show an inline summary with an expandable editor. A "Convert to chain" button lets users upgrade individual categories.

## Design

### Main Row — Auto-Detect per Category

**Single-provider (string rule):**
```
[▶] Security    [cerebras ▾]              [+ Chain]
```
- Same as current behavior
- `[+ Chain]` button wraps the string as `[{provider: currentValue}]` and switches to chain view
- Editing the dropdown works as before (sets `rules[category]` to a string)

**Chain (array rule):**
```
[▶] Security    cerebras → groq → google-ai    [3]
```
- Provider names joined by ` → ` arrows, colored dots per provider
- `[3]` badge shows chain length
- Clicking the row expands the chain editor (same expand behavior as complexity overrides)

### Expanded Panel — Chain Editor

```
↳ Fallback chain:
  1. [cerebras ▾]   / [qwen-3-235b-a22b... ]    [↑] [↓] [✕]
  2. [groq ▾]       / [qwen3-32b ]               [↑] [↓] [✕]
  3. [google-ai ▾]  / [gemini-2.5-flash ]        [↑] [↓] [✕]
  [+ Add fallback]

Complexity overrides:
  simple   (inherit from above)
  normal   (inherit from above)
  complex  ollama-cloud → cerebras    [2]
```

Each chain entry has:
- **Provider dropdown** — same `<ProviderSelect>` component as current
- **Model field** — text input with suggestion dropdown on focus
- **[↑] [↓]** — reorder buttons (swap with adjacent entry)
- **[✕]** — remove entry (minimum 1 entry, button disabled when only 1 left)
- **[+ Add fallback]** — adds a new entry at the end (default: first available provider not already in chain)

Maximum 7 entries per chain (enforced by `validateTemplate`).

### Converting Between Formats

**String → Chain:** `[+ Chain]` button on single-provider rows. Wraps `"cerebras"` as `[{"provider": "cerebras"}]`. The row switches to chain view.

**Chain → String:** When a chain has exactly 1 entry with no model specified, it can be stored as either format. The "back to simple" conversion is implicit — removing all entries except one and clearing its model field triggers auto-simplification on save.

### Model Suggestions

Text input with dropdown on focus. Suggestions are static per provider:

```js
const MODEL_SUGGESTIONS = {
  cerebras: ['qwen-3-235b-a22b-instruct-2507'],
  groq: ['qwen/qwen3-32b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile',
         'moonshotai/kimi-k2-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct',
         'llama-3.1-8b-instant'],
  'google-ai': ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
  'ollama-cloud': ['kimi-k2:1t', 'mistral-large-3:675b', 'qwen3-coder:480b',
                   'deepseek-v3.2', 'devstral-2:123b', 'gpt-oss:120b'],
  openrouter: ['nvidia/nemotron-3-nano-30b-a3b:free', 'google/gemma-3-27b-it:free'],
  ollama: ['qwen2.5-coder:32b', 'codestral:22b'],
  'hashline-ollama': ['qwen2.5-coder:32b'],
  'aider-ollama': ['qwen2.5-coder:32b'],
};
```

When model is empty, placeholder shows the provider's default model name. Leaving model blank on save means "use provider default" (model field omitted from the JSON).

### Complexity Overrides with Chains

Complexity overrides already expand below each category. They currently show a provider dropdown per complexity level. With chains:

- Override values can be strings or arrays (same auto-detect as main rules)
- Each complexity level shows `(inherit from above)` when no override set
- Chain editing for overrides uses the same chain editor component

### State Management

Current state: `editingRules` is `{ category: providerString }`.
New state: `editingRules` is `{ category: providerString | [{provider, model?}, ...] }`.

The `setRule` function needs to handle both:
```js
function setRule(categoryKey, value) {
  // value is either a string (from dropdown) or an array (from chain editor)
  setEditingRules((prev) => ({ ...prev, [categoryKey]: value }));
  setHasChanges(true);
}
```

Chain-specific mutations:
```js
function addChainEntry(categoryKey) { ... }
function removeChainEntry(categoryKey, index) { ... }
function moveChainEntry(categoryKey, index, direction) { ... }  // direction: -1 or +1
function updateChainEntry(categoryKey, index, field, value) { ... }  // field: 'provider' or 'model'
function convertToChain(categoryKey) { ... }
```

### Save Behavior

On save, `editingRules` is sent directly to the API. The backend `validateTemplate` already accepts both string and array formats. No transformation needed.

## Components

### New: `ChainSummary` — inline chain display for main row
- Props: `chain` (array of `{provider, model?}`)
- Renders: colored dots + provider names joined by ` → `, badge with count
- Read-only (click row to expand editor)

### New: `ChainEditor` — expanded chain editing panel
- Props: `chain`, `onChange`, `maxEntries`
- Renders: ordered list of entries with provider dropdown, model input, reorder/remove buttons
- Manages add/remove/reorder/update internally, calls `onChange` with new chain array

### New: `ModelInput` — text input with suggestion dropdown
- Props: `provider`, `value`, `onChange`, `placeholder`
- Renders: text input, dropdown appears on focus with `MODEL_SUGGESTIONS[provider]`
- Filters suggestions as user types

### Modified: `RoutingTemplates` — main component
- Auto-detects string vs array per category
- Renders `<ProviderSelect>` for strings, `<ChainSummary>` for arrays in main row
- Renders `<ChainEditor>` in expanded panel when chain is active
- Shows `[+ Chain]` button for string rules
- Chain mutation functions in state management

## File Structure

| File | Change |
|------|--------|
| `dashboard/src/views/RoutingTemplates.jsx` | Modify — add chain detection, ChainSummary, ChainEditor, ModelInput, chain state management |

All new components are defined in the same file (following the existing pattern — `ProviderSelect` is already inline). If the file grows past ~600 lines, extract `ChainEditor` and `ModelInput` to `dashboard/src/components/`.

## What Doesn't Change

- Backend API — already accepts chain format
- `template-store.js` — already validates both formats
- Other dashboard views — no changes
- Existing preset templates with string rules — render identically to current behavior
