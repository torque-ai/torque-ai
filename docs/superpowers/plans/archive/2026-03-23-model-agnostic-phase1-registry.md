# Model-Agnostic Phase 1: Registry + Family Templates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing model registry and capabilities tables to support family classification, capability flags, role assignment, per-model tuning/prompts, and family-based templates — eliminating the need for hardcoded model names in config seeds.

**Architecture:** Add columns to existing `model_registry` and `model_capabilities` tables via schema migration. Create a new `model_family_templates` table. Build a family classifier that parses model names into families. Add a config-to-registry migration that runs at startup to bridge old hardcoded config values into the new system. All changes are additive and backwards compatible.

**Tech Stack:** Node.js, better-sqlite3 (synchronous), vitest, existing DI container

**Spec:** `docs/superpowers/specs/2026-03-23-model-agnostic-provider-adapters-design.md`

---

## Important Notes

**Column duplication on `model_capabilities`:** The table already has `is_agentic INTEGER` and `can_create_files INTEGER` columns (added in earlier migrations). This plan adds `cap_agentic` and `cap_file_creation` with the same semantics. The new `cap_*` columns are the canonical names going forward. The old columns (`is_agentic`, `can_create_files`, `can_edit_safely`, `max_safe_edit_lines`) are deprecated — Phase 4 cleanup will migrate consumers and drop them. For Phase 1, add the new columns and leave the old ones untouched. New code should query `cap_*` exclusively.

**Existing `model_capabilities.source` vs new `capability_source`:** The existing `source` column (default: `'benchmark'`) tracks where scored capability data came from. The new `capability_source` column (default: `'heuristic'`) tracks whether boolean capability flags were set by heuristic, probe, or user override. Both are retained — they serve different purposes.

**Existing model-name seeds are left unchanged:** `schema-seeds.js` seeds `model_capabilities` with hardcoded model names (lines ~589-652) and `config` with model-specific settings. These are intentionally not modified in Phase 1 — Phase 4 cleanup will remove or convert them to family-based seeds.

**`server/discovery/` directory:** Not to be confused with `server/discovery.js` (mDNS/Bonjour LAN discovery). The new directory handles model/provider discovery.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/discovery/family-classifier.js` | Parse model names into family + parameter size |
| Create | `server/tests/family-classifier.test.js` | Tests for family classifier |
| Create | `server/db/family-templates.js` | CRUD for `model_family_templates` table |
| Create | `server/tests/family-templates.test.js` | Tests for family template CRUD |
| Create | `server/discovery/config-migrator.js` | Migrate old config keys to registry + model_roles at startup |
| Create | `server/tests/config-migrator.test.js` | Tests for config migration |
| Modify | `server/db/schema-migrations.js` | ALTER TABLE migrations for new columns |
| Modify | `server/db/schema-seeds.js` | Seed family templates |
| Modify | `server/models/registry.js` | Extend with family + parameter_size_b on register |
| Modify | `server/tests/test-helpers.js` | Replace real model names with fictional test constants |
| Modify | `server/constants.js` | Replace `DEFAULT_FALLBACK_MODEL` with dynamic lookup |
| Modify | `server/container.js` | Register new services |

---

### Task 1: Family Classifier

**Files:**
- Create: `server/discovery/family-classifier.js`
- Test: `server/tests/family-classifier.test.js`

- [ ] **Step 1: Write failing tests for family classifier**

Create `server/tests/family-classifier.test.js` with tests for:
- `classifyModel('qwen3-coder:30b')` returns `{family: 'qwen3', parameterSizeB: ~30}`
- `classifyModel('qwen2.5-coder:32b')` returns `{family: 'qwen2.5', parameterSizeB: ~32}`
- `classifyModel('llama3.1:70b')` returns `{family: 'llama', parameterSizeB: ~70}`
- `classifyModel('gemma3:4b')` returns `{family: 'gemma', parameterSizeB: ~4}`
- `classifyModel('codestral:22b')` returns `{family: 'codestral', parameterSizeB: ~22}`
- `classifyModel('deepseek-r1:14b')` returns `{family: 'deepseek', parameterSizeB: ~14}`
- `classifyModel('Qwen/Qwen3-235B-A22B')` returns `{family: 'qwen3', parameterSizeB: ~235}` (cloud-style)
- `classifyModel('meta-llama/Llama-3.1-70B-Instruct')` returns `{family: 'llama', parameterSizeB: ~70}` (cloud-style)
- `classifyModel('codellama')` returns `{family: 'codellama', parameterSizeB: null}` (no size tag)
- `classifyModel('some-custom-model:latest')` returns `{family: 'unknown'}`
- `classifyModel('qwen3-coder:latest', {sizeBytes: 18556700761})` estimates parameterSizeB from bytes
- `classifyModel('phi3:3.8b')` returns `{family: 'phi', parameterSizeB: ~3.8}`
- `classifyModel('mistral:7b')` returns `{family: 'mistral', parameterSizeB: ~7}`
- `classifyModel('devstral:24b')` returns `{family: 'devstral', parameterSizeB: ~24}`
- `getSizeBucket(7)` returns `'small'`, `getSizeBucket(14)` returns `'medium'`, `getSizeBucket(32)` returns `'large'`, `getSizeBucket(null)` returns `null`
- `suggestRole(4)` returns `'fast'`, `suggestRole(14)` returns `'balanced'`, `suggestRole(32)` returns `'quality'`, `suggestRole(null)` returns `'default'`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/family-classifier.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement family classifier**

Create `server/discovery/family-classifier.js` exporting:
- `classifyModel(modelName, options?)` — extracts base name (strips org prefix and Ollama tag), matches against ordered `FAMILY_PATTERNS` array (regex→family pairs, most specific first: qwen3, qwen2.5, qwen, devstral, codestral, codellama, deepseek, llama, gemma, mistral, phi, command-r, starcoder). Parses parameter size from name tag (`:30b`) or cloud-style (`-235B-`). Falls back to estimating from `options.sizeBytes` using Q4 quantization heuristic (~0.5625 bytes/param). Returns `{family, parameterSizeB, baseName}`.
- `getSizeBucket(parameterSizeB)` — `<10B` = small, `10-30B` = medium, `>30B` = large, `null` = null
- `suggestRole(parameterSizeB)` — `<10B` = fast, `10-30B` = balanced, `>30B` = quality, `null` = default
- Also export `extractBaseName`, `parseSizeFromName`, `estimateSizeFromBytes`, `FAMILY_PATTERNS`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/family-classifier.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

Message: `feat: add family classifier for model name → family + size parsing`
Files: `server/discovery/family-classifier.js`, `server/tests/family-classifier.test.js`

---

### Task 2: Schema Migration — Extend model_registry and model_capabilities

**Files:**
- Modify: `server/db/schema-migrations.js` (add new migration block at end)
- Test: `server/tests/schema-migrations-model-agnostic.test.js`

- [ ] **Step 1: Write failing test for new columns**

Create `server/tests/schema-migrations-model-agnostic.test.js`. Set up an in-memory DB with the existing `model_registry` schema (id, provider, host_id, model_name, size_bytes, status, first_seen_at, last_seen_at, approved_at, approved_by, UNIQUE constraint) and existing `model_capabilities` schema. Test that after calling `migrateModelAgnostic(db)`:
- `model_registry` has columns: family, parameter_size_b, quantization, role, tuning_json, prompt_template, probe_status, source
- `model_capabilities` has columns: cap_hashline, cap_agentic, cap_file_creation, cap_multi_file, capability_source
- `model_family_templates` table exists with columns: family, system_prompt, tuning_json, size_overrides
- Column defaults work: insert a minimal row into `model_registry` with only required fields, verify `probe_status = 'pending'` and `source = 'discovered'`
- Running twice doesn't error (idempotent)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/schema-migrations-model-agnostic.test.js`
Expected: FAIL — `migrateModelAgnostic` not exported

- [ ] **Step 3: Implement the migration**

Add a `migrateModelAgnostic(db)` function to `server/db/schema-migrations.js`. Uses a helper `safeAdd(table, colDef)` that wraps `ALTER TABLE` in try/catch. Adds all columns listed above. Creates `model_family_templates` table with `CREATE TABLE IF NOT EXISTS`. Export the function and call it from `runMigrations`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/schema-migrations-model-agnostic.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

Message: `feat: schema migration for model-agnostic columns + family templates table`
Files: `server/db/schema-migrations.js`, `server/tests/schema-migrations-model-agnostic.test.js`

---

### Task 3: Family Templates — CRUD + Seeds

**Files:**
- Create: `server/db/family-templates.js`
- Create: `server/tests/family-templates.test.js`
- Modify: `server/db/schema-seeds.js`

- [ ] **Step 1: Write failing tests for family template CRUD**

Create `server/tests/family-templates.test.js`. Set up in-memory DB with `model_family_templates` table. Test:
- `upsert('qwen3', {systemPrompt, tuning, sizeOverrides})` then `get('qwen3')` returns correct data
- `get('nonexistent')` returns null
- `list()` returns all inserted templates
- `resolvePrompt(family, modelOverride)`: model override wins > family template > universal fallback
- `resolveTuning({family, sizeBucket, role, modelTuning, taskTuning})`: correct merge order (task > model > family+size > role defaults)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/family-templates.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement family templates module**

Create `server/db/family-templates.js` exporting `createFamilyTemplates(deps)` factory. Constants: `UNIVERSAL_FALLBACK_PROMPT` (generic code-focused prompt), `ROLE_TUNING_DEFAULTS` (fast/balanced/quality/default/fallback tuning maps). Methods: `upsert`, `get`, `list`, `resolvePrompt`, `resolveTuning`. Tuning resolution merges: role defaults < family template + size overrides < model override < task override.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/family-templates.test.js`
Expected: All tests PASS

- [ ] **Step 5: Seed family templates in schema-seeds.js**

Add `seedFamilyTemplates(db)` function in `server/db/schema-seeds.js`. Uses `INSERT OR IGNORE` to seed 9 families: qwen3, qwen2.5, llama, gemma, deepseek, codestral, mistral, phi, unknown. Each has a family-specific system prompt, default tuning JSON, and size overrides. Call from `seedDefaults()`. The `unknown` family uses the universal fallback prompt.

- [ ] **Step 6: Commit**

Message: `feat: family templates CRUD + seed 9 model family templates`
Files: `server/db/family-templates.js`, `server/tests/family-templates.test.js`, `server/db/schema-seeds.js`

---

### Task 4: Extend models/registry.js — Family + Size on Registration

**Files:**
- Modify: `server/models/registry.js`
- Create: `server/tests/registry-family-extension.test.js`

- [ ] **Step 1: Write failing test**

Create `server/tests/registry-family-extension.test.js`. Set up in-memory DB with full `model_registry` schema (including new columns). Import and `setDb()` on `models/registry`. Test:
- `registerModel({provider: 'ollama', hostId: 'host-1', modelName: 'qwen3-coder:30b', sizeBytes: 18556700761})` → `model.family === 'qwen3'`, `model.parameter_size_b` close to 30
- `registerModel({provider: 'deepinfra', hostId: null, modelName: 'Qwen/Qwen3-235B-A22B'})` → `model.family === 'qwen3'`, `model.parameter_size_b` close to 235
- `registerModel({...modelName: 'my-custom-model:latest'})` → `model.family === 'unknown'`
- Backfill path: insert a model directly into DB with `family = NULL`, call `updateModelLastSeen`, verify `family` and `parameter_size_b` get populated (the `classifyModel()` call is pure string parsing — no I/O cost per health check cycle)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/registry-family-extension.test.js`
Expected: FAIL — `model.family` is undefined

- [ ] **Step 3: Modify `registerModelInternal` in `server/models/registry.js`**

After the INSERT succeeds (insertResult.changes > 0), call `classifyModel(modelName, {sizeBytes})` from `../discovery/family-classifier` and UPDATE the new columns. Also modify `updateModelLastSeen` to backfill `family` and `parameter_size_b` if they're NULL on existing rows (handles pre-migration data).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/registry-family-extension.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

Message: `feat: classify model family + parameter size on registration`
Files: `server/models/registry.js`, `server/tests/registry-family-extension.test.js`

---

### Task 5: Config-to-Registry Migration

**Files:**
- Create: `server/discovery/config-migrator.js`
- Create: `server/tests/config-migrator.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/config-migrator.test.js`. Set up in-memory DB with `config`, `model_roles`, `model_capabilities`, and `model_registry` tables. Test:
- `ollama_model` config → `model_roles` ollama/default
- `ollama_fast_model` config → `model_roles` ollama/fast
- `hashline_capable_models` (comma-separated) → `model_capabilities` rows with `cap_hashline=1`
- Idempotent — running twice doesn't error or duplicate
- Missing config keys → no error (graceful skip)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/config-migrator.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement config migrator**

Create `server/discovery/config-migrator.js` exporting `migrateConfigToRegistry(db)`. Reads `ollama_model`, `ollama_fast_model`, `ollama_balanced_model`, `ollama_quality_model` from config table → INSERT OR IGNORE into `model_roles`. Reads `hashline_capable_models` → split by comma → INSERT/UPDATE `model_capabilities` with `cap_hashline=1`. Reads `ollama_model_settings` JSON → UPDATE `model_registry.tuning_json`. Reads `ollama_model_prompts` JSON → UPDATE `model_registry.prompt_template`. All operations are idempotent.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/config-migrator.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

Message: `feat: config-to-registry migrator for legacy model config keys`
Files: `server/discovery/config-migrator.js`, `server/tests/config-migrator.test.js`

---

### Task 6: Replace DEFAULT_FALLBACK_MODEL with Dynamic Lookup

**Files:**
- Modify: `server/constants.js`
- Create: `server/tests/dynamic-fallback-model.test.js`

- [ ] **Step 1: Write failing test**

Create `server/tests/dynamic-fallback-model.test.js`. Test `getDefaultFallbackModel(db)`:
- With mock db having `model_roles` entry → returns that model name
- With null db → returns a non-empty string (static fallback)
- With mock db having no entries in `model_roles` → returns static fallback
- With mock db having no `model_roles` entries but an approved model in `model_registry` → returns that model (second fallback path)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/dynamic-fallback-model.test.js`
Expected: FAIL — `getDefaultFallbackModel` not exported

- [ ] **Step 3: Implement in constants.js**

Add `getDefaultFallbackModel(db)` function to `server/constants.js`. Tries: (1) `model_roles` for ollama default, (2) any approved model in `model_registry`, (3) static `DEFAULT_FALLBACK_MODEL` constant. Export both the function and the constant.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/dynamic-fallback-model.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

Message: `feat: add getDefaultFallbackModel dynamic lookup alongside static constant`
Files: `server/constants.js`, `server/tests/dynamic-fallback-model.test.js`

---

### Task 7: Register New Services in DI Container

**Files:**
- Modify: `server/container.js`

- [ ] **Step 1: Register familyTemplates in container.js**

Add registration for `familyTemplates` using `createFamilyTemplates` factory with `['db']` dependency. Import `migrateConfigToRegistry` and call it in the post-boot section (after migrations have run, after `db` is available).

- [ ] **Step 2: Verify server starts without errors**

Start the server briefly and check for startup errors. Verify the migration runs (check logs for `config-migrator` messages).

- [ ] **Step 3: Commit**

Message: `feat: register familyTemplates in DI container + run config migration at startup`
Files: `server/container.js`

---

### Task 8: Update test-helpers.js — Fictional Test Model Constants

**Files:**
- Modify: `server/tests/test-helpers.js`

- [ ] **Step 1: Replace real model names with fictional ones**

Update `TEST_MODELS` in `server/tests/test-helpers.js` to use fictional names that don't match any real model:

```js
const TEST_MODELS = {
  DEFAULT: 'test-model:14b',
  FALLBACK: 'test-fallback:7b',
  FAST: 'test-fast:4b',
  BALANCED: 'test-balanced:14b',
  QUALITY: 'test-quality:32b',
  HASHLINE: 'test-hashline:14b',
  CLOUD: 'test-cloud-model',
  LEGACY: 'test-legacy:32b',
  SMALL: 'test-small:7b',
};
```

Update `TEST_CONFIG_DEFAULTS` to reference `TEST_MODELS.*` instead of real model names.

- [ ] **Step 2: Run full test suite to identify blast radius**

Run: `npx vitest run 2>&1 | tail -100`
Expected: Some tests will fail due to model name changes. Record the failing test files — these are tracked for Phase 4 resolution.

**Known state:** Phase 1 intentionally ends with some test failures in files that import `TEST_MODELS`/`TEST_CONFIG_DEFAULTS` and compare against inline hardcoded model names. This is expected. The fictional constants establish the pattern; Phase 4 migrates ~120 test files to use them consistently. Do not attempt to fix all test files here — that is a bulk operation better suited to Phase 4.

- [ ] **Step 3: Commit**

Message: `feat: replace real model names with fictional TEST_MODELS constants in test-helpers`
Files: `server/tests/test-helpers.js`

---

## Phase 1 Completion Checklist

After all 8 tasks are done, verify:

- [ ] `model_registry` table has new columns: `family`, `parameter_size_b`, `quantization`, `role`, `tuning_json`, `prompt_template`, `probe_status`, `source`
- [ ] `model_capabilities` table has new columns: `cap_hashline`, `cap_agentic`, `cap_file_creation`, `cap_multi_file`, `capability_source`
- [ ] `model_family_templates` table exists with 9 seeded families
- [ ] Family classifier correctly parses Ollama and cloud-style model names
- [ ] New models registered via `registerModel()` get `family` and `parameter_size_b` auto-populated
- [ ] Legacy config values are migrated to `model_roles` and `model_capabilities` on startup
- [ ] `getDefaultFallbackModel(db)` provides dynamic lookup with static fallback
- [ ] `TEST_MODELS` constants use fictional names
- [ ] Server starts without errors
- [ ] All new code has test coverage

## Next Phase

Phase 2 (Discovery Engine) builds on this foundation:
- `OllamaProvider.discoverModels()` calls `/api/tags` and feeds results into `registerModel()` (auto-classifies family + size)
- Auto-role assignment using `suggestRole()` from family classifier
- Heuristic capability flags from `FAMILY_CAPABILITIES`
- Deferred capability probes

See spec: `docs/superpowers/specs/2026-03-23-model-agnostic-provider-adapters-design.md`, Component 3.
