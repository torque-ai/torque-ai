# Model-Agnostic Phase 4: Cleanup — Remove Hardcoded Model Names

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all hardcoded model names from source and test files, replacing them with registry lookups (source) or fictional TEST_MODELS constants (tests). Complete the public-readiness migration.

**Architecture:** Source files get hardcoded model names replaced with registry queries or removed entirely. Test files get model name literals replaced with `TEST_MODELS.*` constants from `test-helpers.js`. Config seeds that reference specific models get converted to dynamic/family-based patterns.

**Tech Stack:** Node.js, better-sqlite3, vitest

**Spec:** `docs/superpowers/specs/2026-03-23-model-agnostic-provider-adapters-design.md` (Phase 4)

---

## File Map

**Source files (20):** Replace hardcoded model names with registry lookups or remove
**Test files (93):** Replace model name literals with `TEST_MODELS.*` constants

---

### Task 1: Remove MODEL_TIER_HINTS from host-selection.js

**Files:**
- Modify: `server/db/host-selection.js`

- [ ] **Step 1: Read the file and understand how MODEL_TIER_HINTS is used**

The hardcoded map at line 27-36 maps model names to tiers. It's used at line 94 to provide a tier hint during host selection. Replace with a registry lookup using `parameter_size_b` and `suggestRole()`.

- [ ] **Step 2: Replace the hardcoded map with a registry query**

Remove the `MODEL_TIER_HINTS` object. Replace the lookup at line 94 with:

```js
// Dynamic tier hint from registry (replaces hardcoded MODEL_TIER_HINTS)
let modelTier = null;
if (modelName) {
  try {
    const row = db.prepare(
      'SELECT parameter_size_b FROM model_registry WHERE model_name = ? LIMIT 1'
    ).get(modelName);
    if (row?.parameter_size_b) {
      const { suggestRole } = require('../discovery/family-classifier');
      modelTier = suggestRole(row.parameter_size_b);
    }
  } catch { /* registry not available */ }
}
```

Keep `setHostTierHint` and `HOST_TIER_HINTS` (per-host overrides) — those are user-configurable, not hardcoded model names.

- [ ] **Step 3: Commit**

Message: `refactor: replace MODEL_TIER_HINTS with dynamic registry lookup`
Files: `server/db/host-selection.js`

---

### Task 2: Clean hardcoded model names from source files

**Files:** 20 source files listed below. For each, replace hardcoded model names with dynamic lookups, constants, or remove them.

- [ ] **Step 1: Clean `server/constants.js`**

`DEFAULT_FALLBACK_MODEL = 'qwen3-coder:30b'` — this is already supplemented by `getDefaultFallbackModel(db)` from Phase 1. Change the static value to a generic placeholder: `'default-model'`. Callers should use `getDefaultFallbackModel(db)` instead.

- [ ] **Step 2: Clean `server/db/schema-seeds.js`**

Remove the hardcoded model name from `ollama_model` seed (line 208). Change to empty string or remove the line — discovery will populate it. Remove hardcoded model names from `hashline_capable_models` seed (line 213) — capability detection is now heuristic-based. Keep the `ollama_model_settings` and `ollama_model_prompts` JSON blobs for now (they're fallback data) but add a comment marking them as legacy.

- [ ] **Step 3: Clean `server/db/model-roles.js`**

Line 14 has a doc comment referencing `qwen2.5-coder:32b` as an example. Replace with a generic example: `setModelRole('ollama', 'default', 'my-model:14b')`.

- [ ] **Step 4: Clean `server/providers/agentic-capability.js`**

Line 14 has a doc comment referencing `qwen2.5-coder:32b`. Replace with generic example. The `WHITELIST_PREFIXES` array (line 31-50) is the heuristic layer — keep it for now as it's the fast-path check. Add a comment noting it will be superseded by `model_capabilities.cap_agentic` queries in a future phase.

- [ ] **Step 5: Clean remaining source files**

For each of: `benchmark.js`, `execution/strategic-hooks.js`, `handlers/provider-tuning.js`, `maintenance/orphan-cleanup.js`, `providers/execute-hashline.js`, `providers/execute-ollama.js`, `providers/execution.js`, `tool-defs/integration-defs.js`, `tool-defs/model-defs.js`, `tool-defs/task-submission-defs.js`, `utils/model.js`:

- Replace hardcoded model names in doc comments/examples with generic placeholders
- Replace hardcoded model names in default values with registry lookups or `getDefaultFallbackModel(db)`
- Leave model names in `schema-migrations.js` untouched (they're historical migration data)
- Leave model names in `discovery/` files untouched (family-classifier patterns, heuristic capabilities — these are the NEW system)

- [ ] **Step 6: Commit**

Message: `refactor: remove hardcoded model names from 20 source files`

---

### Task 3: Bulk test file migration — Batch 1 (30 files)

**Files:** First 30 test files alphabetically that reference hardcoded model names

- [ ] **Step 1: For each test file, replace model name string literals with `TEST_MODELS.*` constants**

Import pattern at top of each file:
```js
const { TEST_MODELS } = require('./test-helpers');
```

Replacement mapping:
- `'qwen2.5-coder:32b'` → `TEST_MODELS.LEGACY` or `TEST_MODELS.QUALITY`
- `'qwen3-coder:30b'` → `TEST_MODELS.DEFAULT`
- `'codestral:22b'` → `TEST_MODELS.BALANCED` or a new `TEST_MODELS.CODESTRAL` if needed
- `'qwen3:8b'` or similar small models → `TEST_MODELS.SMALL` or `TEST_MODELS.FAST`
- `'qwen3:32b'` or similar large models → `TEST_MODELS.QUALITY`
- Generic model names in mocks → `TEST_MODELS.DEFAULT`

**IMPORTANT:** Don't blindly find-replace. Some model names appear in:
- Mock return values (replace with TEST_MODELS)
- Assertion comparisons (replace with same TEST_MODELS constant)
- Config mock data (replace with TEST_MODELS)
- Inline model lists (replace each entry with appropriate TEST_MODELS constant)

Both sides of an assertion must use the same constant.

- [ ] **Step 2: Run the modified test files to check for failures**

- [ ] **Step 3: Commit**

Message: `refactor: migrate test files batch 1 to TEST_MODELS constants (30 files)`

---

### Task 4: Bulk test file migration — Batch 2 (30 files)

Same approach as Task 3, next 30 files alphabetically.

- [ ] **Step 1: Replace model name literals with TEST_MODELS constants**
- [ ] **Step 2: Run modified tests**
- [ ] **Step 3: Commit**

Message: `refactor: migrate test files batch 2 to TEST_MODELS constants (30 files)`

---

### Task 5: Bulk test file migration — Batch 3 (33 remaining files)

Same approach, remaining test files.

- [ ] **Step 1: Replace model name literals with TEST_MODELS constants**
- [ ] **Step 2: Run modified tests**
- [ ] **Step 3: Commit**

Message: `refactor: migrate test files batch 3 to TEST_MODELS constants (33 files)`

---

### Task 6: Final verification + documentation

**Files:**
- Run full grep to confirm no hardcoded model names remain outside of:
  - `schema-migrations.js` (historical)
  - `discovery/` (the new system's pattern data)
  - `schema-seeds.js` (marked as legacy fallback)

- [ ] **Step 1: Verify no remaining hardcoded model names**

Run: `grep -rn 'qwen2\.5-coder:32b\|codestral:22b' server/ --include='*.js' | grep -v node_modules | grep -v schema-migrations | grep -v discovery/ | grep -v schema-seeds`

Expected: Zero results (or only comments/docs)

- [ ] **Step 2: Run full test suite**

- [ ] **Step 3: Commit any final fixes**

---

## Phase 4 Completion Checklist

- [ ] `MODEL_TIER_HINTS` removed from `host-selection.js`, replaced with registry lookup
- [ ] `DEFAULT_FALLBACK_MODEL` changed to generic placeholder
- [ ] Hardcoded model names removed from 20 source files
- [ ] 93 test files migrated to `TEST_MODELS` constants
- [ ] No hardcoded model names remain (except historical migrations and discovery patterns)
- [ ] Full test suite passes

## Done

After Phase 4, TORQUE is model-agnostic and ready for public release. The system:
- Auto-discovers models from any connected provider
- Classifies them by family and size
- Assigns roles automatically
- Applies appropriate tuning and prompts via family templates
- Detects capabilities via heuristics
- Works with whatever models the user brings — zero manual configuration needed
