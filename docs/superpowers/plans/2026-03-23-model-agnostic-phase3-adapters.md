# Model-Agnostic Phase 3: Provider Adapter Enhancements + Registry-Based Routing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate tuning resolution, prompt resolution, and hashline capability checks from hardcoded config lookups to the model registry and family templates — completing the transition from "works with developer's models" to "works with any models."

**Architecture:** Add `getDefaultTuning()` and `getSystemPrompt()` to BaseProvider. Rewire `providers/config.js` to use family templates as a fallback layer. Rewire `isHashlineCapableModel()` to query `model_capabilities.cap_hashline` instead of the `hashline_capable_models` config string. Each change is backwards-compatible: the old config keys still work as a fallback layer until Phase 4 removes them.

**Tech Stack:** Node.js, better-sqlite3 (synchronous), vitest

**Spec:** `docs/superpowers/specs/2026-03-23-model-agnostic-provider-adapters-design.md` (Components 4, 5)

**Depends on:** Phase 1 (family templates, registry extensions) + Phase 2 (discovery engine, heuristic capabilities)

---

## Important Notes

**This phase does NOT rewrite execution logic.** The hashline and raw Ollama execution paths (`execute-hashline.js`, `execute-ollama.js`) stay as-is. We're changing how they get their configuration (tuning, prompts, capability checks), not how they execute.

**Backwards compatibility:** Every change falls back to the old config key if the new system has no data. This means the migration is safe — existing installs keep working during the transition.

**What we're NOT doing in Phase 3:**
- OllamaProvider/HashlineOllamaProvider unification (deferred — too risky for this phase, the format selection works fine as-is)
- Capability probes (deferred — heuristics from Phase 2 are sufficient for now)
- Removing old config keys (Phase 4)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `server/providers/base.js` | Add `getDefaultTuning()`, `getSystemPrompt()` |
| Modify | `server/providers/config.js` | Add family template fallback layer to tuning + prompt resolution |
| Modify | `server/execution/fallback-retry.js` | Replace `isHashlineCapableModel()` config lookup with registry query |
| Modify | `server/providers/v2-local-providers.js` | Replace `isHashlineCapableModelName()` config lookup with registry query |
| Create | `server/discovery/capability-lookup.js` | Centralized `isHashlineCapable(model)` that queries model_capabilities |
| Create | `server/tests/capability-lookup.test.js` | Tests for capability lookup |
| Create | `server/tests/config-family-fallback.test.js` | Tests for tuning/prompt resolution with family templates |
| Create | `server/tests/base-provider-tuning.test.js` | Tests for BaseProvider tuning/prompt methods |

---

### Task 1: Centralized Capability Lookup

**Files:**
- Create: `server/discovery/capability-lookup.js`
- Create: `server/tests/capability-lookup.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/capability-lookup.test.js`. Set up in-memory DB with `model_capabilities` table. Test:
- `isHashlineCapable(db, 'qwen3-coder:30b')` returns true when `cap_hashline=1` in DB
- `isHashlineCapable(db, 'llama3:8b')` returns false when `cap_hashline=0` in DB
- `isHashlineCapable(db, 'unknown-model')` returns false when model not in DB
- `isHashlineCapable(null, 'any-model')` returns false when db is null (graceful)
- `isAgenticCapable(db, 'qwen3-coder:30b')` returns true when `cap_agentic=1`
- `getModelCapabilities(db, 'qwen3-coder:30b')` returns all cap flags as an object
- Falls back to prefix matching: `isHashlineCapable(db, 'qwen3-coder:7b')` returns true if `qwen3-coder:30b` has `cap_hashline=1` (same base model family)

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement capability lookup**

Create `server/discovery/capability-lookup.js`:

```js
'use strict';

/**
 * Query model_capabilities for a specific capability flag.
 * Falls back to base model name matching (strips size tag).
 */
function hasCapability(db, modelName, capColumn) {
  if (!db || !modelName) return false;
  try {
    // Exact match first
    const exact = db.prepare(
      `SELECT ${capColumn} FROM model_capabilities WHERE model_name = ?`
    ).get(modelName);
    if (exact) return exact[capColumn] === 1;

    // Base name match (strip :tag)
    const baseName = modelName.split(':')[0];
    if (baseName !== modelName) {
      const base = db.prepare(
        `SELECT ${capColumn} FROM model_capabilities WHERE model_name LIKE ? AND ${capColumn} = 1 LIMIT 1`
      ).get(baseName + '%');
      if (base) return true;
    }

    return false;
  } catch { return false; }
}

function isHashlineCapable(db, modelName) {
  return hasCapability(db, modelName, 'cap_hashline');
}

function isAgenticCapable(db, modelName) {
  return hasCapability(db, modelName, 'cap_agentic');
}

function getModelCapabilities(db, modelName) {
  if (!db || !modelName) return null;
  try {
    return db.prepare(
      'SELECT cap_hashline, cap_agentic, cap_file_creation, cap_multi_file, capability_source FROM model_capabilities WHERE model_name = ?'
    ).get(modelName) || null;
  } catch { return null; }
}

module.exports = { isHashlineCapable, isAgenticCapable, getModelCapabilities, hasCapability };
```

**IMPORTANT:** The `capColumn` parameter is NOT user input — it's always a hardcoded string from the calling code. The SQL interpolation is safe because `capColumn` is one of a fixed set of column names. Do NOT pass user input as `capColumn`.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

Message: `feat: centralized capability lookup querying model_capabilities table`
Files: `server/discovery/capability-lookup.js`, `server/tests/capability-lookup.test.js`

---

### Task 2: Rewire `isHashlineCapableModel` in fallback-retry.js

**Files:**
- Modify: `server/execution/fallback-retry.js`

- [ ] **Step 1: Read the existing `isHashlineCapableModel` function**

In `server/execution/fallback-retry.js` around line 560-569. It reads `hashline_capable_models` from config, splits by comma, and does prefix matching.

- [ ] **Step 2: Add registry-first lookup with config fallback**

Replace the function body to try the registry first, fall back to config:

```js
function isHashlineCapableModel(model) {
  // Try model_capabilities registry first (populated by discovery + heuristics)
  try {
    const db = serverConfig.getDbInstance ? serverConfig.getDbInstance() : null;
    if (db) {
      const { isHashlineCapable } = require('../discovery/capability-lookup');
      const result = isHashlineCapable(db, model);
      if (result) return true;
    }
  } catch { /* registry not available — fall through to config */ }

  // Fallback: legacy config key
  const capableStr = serverConfig.get('hashline_capable_models') || '';
  if (!capableStr) return true; // No allowlist configured = allow all
  const capableModels = capableStr.split(',').map(m => m.trim().toLowerCase()).filter(Boolean);
  const modelLower = (model || '').toLowerCase();
  const baseModel = modelLower.split(':')[0];
  return capableModels.some(capable => {
    return modelLower === capable || modelLower.startsWith(capable + ':') || baseModel === capable;
  });
}
```

- [ ] **Step 3: Do the same in `server/providers/v2-local-providers.js`**

Find `isHashlineCapableModelName` (around line 84) and add the same registry-first lookup.

- [ ] **Step 4: Commit**

Message: `feat: isHashlineCapableModel queries model_capabilities with config fallback`
Files: `server/execution/fallback-retry.js`, `server/providers/v2-local-providers.js`

---

### Task 3: Add `getDefaultTuning()` and `getSystemPrompt()` to BaseProvider

**Files:**
- Modify: `server/providers/base.js`
- Create: `server/tests/base-provider-tuning.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/base-provider-tuning.test.js`. Test:
- `BaseProvider` has `getDefaultTuning(model)` method, returns `{}`
- `BaseProvider` has `getSystemPrompt(model, format)` method, returns `null`
- Subclass can override both methods

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Add methods to BaseProvider**

In `server/providers/base.js`:

```js
/**
 * Get default tuning parameters for a model.
 * Override in subclasses for provider-specific tuning.
 * @param {string} model - Model name
 * @returns {object} Tuning parameters (empty = use system defaults)
 */
getDefaultTuning(_model) {
  return {};
}

/**
 * Get system prompt for a model.
 * Override in subclasses for provider-specific prompts.
 * @param {string} model - Model name
 * @param {string} format - Edit format ('hashline', 'raw', 'agentic')
 * @returns {string|null} System prompt, or null to use system default
 */
getSystemPrompt(_model, _format) {
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

Message: `feat: add getDefaultTuning and getSystemPrompt to BaseProvider`
Files: `server/providers/base.js`, `server/tests/base-provider-tuning.test.js`

---

### Task 4: Wire Family Templates into Tuning Resolution

**Files:**
- Modify: `server/providers/config.js`
- Create: `server/tests/config-family-fallback.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/config-family-fallback.test.js`. Set up in-memory DB with `config`, `model_family_templates`, `model_registry`, and `model_capabilities` tables. Seed a family template for 'qwen3'. Test:

- `resolveOllamaSettings()` with a qwen3 model uses family template tuning when `ollama_model_settings` config has no entry for that model
- Family template `size_overrides` are applied based on model size (small/medium/large)
- Per-model `tuning_json` in `model_registry` overrides family template values
- Legacy `ollama_model_settings` config still works as fallback
- Per-task tuning overrides still win over everything

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Add family template layer to `resolveOllamaSettings()`**

In `server/providers/config.js`, find `resolveOllamaSettings()`. Between the preset layer (Layer 2) and the model-specific layer (Layer 3, ~line 179), add a new layer that queries family templates:

```js
// Layer 2.5: Family template tuning (between preset and per-model config)
if (model) {
  try {
    const { createFamilyTemplates } = require('../db/family-templates');
    const rawDb = db.getDbInstance ? db.getDbInstance() : null;
    if (rawDb) {
      const templates = createFamilyTemplates({ db: rawDb });
      // Look up model's family from registry
      const regRow = rawDb.prepare(
        'SELECT family, parameter_size_b FROM model_registry WHERE model_name = ? LIMIT 1'
      ).get(model);
      if (regRow?.family) {
        const { getSizeBucket } = require('../discovery/family-classifier');
        const familyTuning = templates.resolveTuning({
          family: regRow.family,
          sizeBucket: getSizeBucket(regRow.parameter_size_b),
          role: 'default',
          modelTuning: null,
          taskTuning: null,
        });
        // Apply family tuning as defaults (lower priority than model-specific)
        if (familyTuning.temperature !== undefined && temperature === defaultTemp) temperature = familyTuning.temperature;
        if (familyTuning.num_ctx !== undefined && numCtx === defaultCtx) numCtx = familyTuning.num_ctx;
        if (familyTuning.top_k !== undefined) topK = familyTuning.top_k;
        if (familyTuning.repeat_penalty !== undefined) repeatPenalty = familyTuning.repeat_penalty;
      }
    }
  } catch { /* family templates not available */ }
}
```

Also add the same pattern to `resolveSystemPrompt()` — look up family template prompt when model-specific prompt is not configured:

```js
// After checking model-specific prompts, before returning default:
if (model && systemPrompt === DEFAULT_SYSTEM_PROMPT) {
  try {
    const { createFamilyTemplates } = require('../db/family-templates');
    const rawDb = db.getDbInstance ? db.getDbInstance() : null;
    if (rawDb) {
      const templates = createFamilyTemplates({ db: rawDb });
      const regRow = rawDb.prepare(
        'SELECT family FROM model_registry WHERE model_name = ? LIMIT 1'
      ).get(model);
      if (regRow?.family) {
        const familyPrompt = templates.resolvePrompt(regRow.family, null);
        if (familyPrompt) systemPrompt = familyPrompt;
      }
    }
  } catch { /* family templates not available */ }
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

Message: `feat: wire family template tuning + prompts into Ollama config resolution`
Files: `server/providers/config.js`, `server/tests/config-family-fallback.test.js`

---

### Task 5: Wire `getDefaultTuning()` on Adapter Wrapper

**Files:**
- Modify: `server/providers/adapter-registry.js`

- [ ] **Step 1: Add forwarding to adapter wrapper**

In `server/providers/adapter-registry.js`, inside the `registerApiAdapter()` wrapper return block, add:

```js
getDefaultTuning(model) {
  const providerInstance = resolveProvider();
  return providerInstance.getDefaultTuning(model);
},

getSystemPrompt(model, format) {
  const providerInstance = resolveProvider();
  return providerInstance.getSystemPrompt(model, format);
},
```

- [ ] **Step 2: Commit**

Message: `feat: forward getDefaultTuning and getSystemPrompt through adapter wrapper`
Files: `server/providers/adapter-registry.js`

---

### Task 6: MCP Tools — `list_models` and `assign_model_role`

**Files:**
- Create: `server/handlers/model-registry-handlers.js`
- Modify: `server/tool-defs/discovery-defs.js` (add tool definitions)
- Modify: `server/tools.js` (wire handlers)
- Modify: `server/tool-annotations.js` (add annotations)

- [ ] **Step 1: Create handlers**

Create `server/handlers/model-registry-handlers.js` with:

`handleListModels(args)` — queries `model_registry` joined with `model_capabilities`, groups by provider. Returns markdown table with model_name, family, size, role, capabilities, status, last_seen.

`handleAssignModelRole(args)` — takes `{provider, role, model_name}`, validates, writes to `model_roles` table. Returns confirmation.

- [ ] **Step 2: Add tool definitions**

In `server/tool-defs/discovery-defs.js`, add `list_models` and `assign_model_role` tool definitions.

- [ ] **Step 3: Wire handlers + annotations**

- [ ] **Step 4: Commit**

Message: `feat: add list_models and assign_model_role MCP tools`
Files: `server/handlers/model-registry-handlers.js`, `server/tool-defs/discovery-defs.js`, `server/tools.js`, `server/tool-annotations.js`

---

## Phase 3 Completion Checklist

After all 6 tasks are done, verify:

- [ ] `isHashlineCapableModel()` queries `model_capabilities.cap_hashline` first, falls back to config
- [ ] `resolveOllamaSettings()` uses family templates for tuning when model-specific config is absent
- [ ] `resolveSystemPrompt()` uses family templates for prompts when model-specific config is absent
- [ ] `BaseProvider` has `getDefaultTuning()` and `getSystemPrompt()` methods
- [ ] Adapter wrapper forwards both new methods
- [ ] `list_models` MCP tool shows all registered models with capabilities and roles
- [ ] `assign_model_role` MCP tool lets users assign models to roles
- [ ] All changes are backwards-compatible (old config keys still work as fallback)
- [ ] Server starts without errors

## Next Phase

Phase 4 (Cleanup) removes the legacy:
- Drop deprecated config keys (`ollama_model`, `ollama_fast_model`, `hashline_capable_models`, etc.)
- Remove `MODEL_TIER_HINTS` from `host-selection.js`
- Remove hardcoded model names from source files
- Migrate ~120 test files to `TEST_MODELS` constants
- Update CLAUDE.md documentation
