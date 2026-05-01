# Model-Agnostic Architecture + Provider Adapters

**Date:** 2026-03-23
**Status:** Approved (revised after spec review)
**Scope:** TORQUE server — extend model registry, evolve provider adapter system, add discovery engine, capability probing, family templates, eliminate hardcoded model names

## Problem

TORQUE has ~1,129 references to specific model names (e.g., `qwen2.5-coder:32b`, `codestral:22b`) across ~140 files. These appear in:

- **Config seeds** (`schema-seeds.js`): tier models, hashline-capable lists, per-model prompts, per-model tuning
- **Runtime logic** (`host-selection.js`, `agentic-capability.js`, `execute-hashline.js`): hardcoded model tier hints, capability whitelists
- **Test fixtures** (~120 test files): model names as fixture data

When a user installs TORQUE and connects an Ollama instance with different models, the system fails to find the hardcoded models, silently escalates everything to Codex (a paid provider), and provides no feedback about what went wrong.

TORQUE is being prepared for public release. The system must work with whatever models and providers the user brings — not fail because a developer's personal model setup isn't present.

## Design Decisions

1. **Auto-discover + auto-assign** — When TORQUE connects to a provider, it discovers available models and assigns them to roles (fast/balanced/quality) by parameter size. Zero manual config needed.
2. **Heuristic first, probe to confirm** — Model capabilities (hashline, agentic, context window) are initially guessed from model family, then confirmed by background micro-probes.
3. **Family-based templates** — System prompts and tuning presets are keyed to model families (qwen3, llama, gemma), not specific model names. Users can override per-model.
4. **Provider adapters** — Extend the existing `BaseProvider` class and `adapter-registry.js`. Add `discoverModels()` and tuning methods. New providers are a single file extending `OpenAICompatibleProvider`.
5. **Catalog discovery for cloud providers** — When a user enables a cloud provider, TORQUE queries `/v1/models` and shows available models. The user (or their LLM assistant) picks which to use.
6. **Routing templates unchanged** — Default routing templates ship as-is. They reference provider chains by task category, not specific models. Users can create custom templates.

## Existing Infrastructure (extend, don't replace)

The codebase already has partial implementations of several components this design requires. This spec extends them rather than creating parallel systems.

### Existing `model_registry` table
Created in `schema-migrations.js` (line 541):
```sql
model_registry (
  id TEXT PRIMARY KEY,       -- UUID
  provider TEXT NOT NULL,
  host_id TEXT,              -- supports multi-host Ollama
  model_name TEXT NOT NULL,
  size_bytes INTEGER,
  status TEXT DEFAULT 'pending',  -- 'pending', 'approved', 'denied', 'removed'
  first_seen_at TEXT,
  last_seen_at TEXT,
  approved_at TEXT,
  approved_by TEXT,
  UNIQUE(provider, host_id, model_name)
)
```
Managed by `server/models/registry.js` (512 lines): `registerModel`, `syncModelsFromHealthCheck`, `selectBestApprovedModel`, etc. Emits `model-discovered` and `model-removed` events.

**Decision:** Extend this table with new columns. Do NOT create a new table or change the primary key.

### Existing `model_capabilities` table
```sql
model_capabilities (
  model_name TEXT PRIMARY KEY,
  score_code_gen REAL, score_refactoring REAL, score_testing REAL,
  score_reasoning REAL, score_docs REAL,
  lang_typescript REAL, lang_javascript REAL, lang_python REAL,
  lang_csharp REAL, lang_go REAL, lang_rust REAL, lang_general REAL,
  context_window INTEGER, param_size_b REAL, is_thinking_model INTEGER,
  source TEXT, updated_at TEXT
)
```

**Decision:** Extend with boolean capability flags (`cap_hashline`, `cap_agentic`, `cap_file_creation`). Keep existing scored fields — they're useful for smart routing.

### Existing `model_roles` table
DB-backed `provider + role → model` lookup via `server/db/model-roles.js`. Has the right shape but is underutilized.

**Decision:** Keep and extend. Role lookups query `model_roles` first. Auto-assignment from discovery populates `model_roles`. Eventually, `model_roles` can be joined with `model_registry` for a unified view.

### Existing `BaseProvider` class + adapter registry
- `server/providers/base.js`: `BaseProvider` with `submit()`, `checkHealth()`, `listModels()`, `hasCapacity()`
- `server/providers/adapter-registry.js` (248 lines): v2 adapter registry with all 12+ providers registered
- Concrete providers: `OllamaProvider`, `HashlineOllamaProvider`, `CodexCliProvider`, `ClaudeCliProvider`, `AnthropicProvider`, `GroqProvider`, `DeepInfraProvider`, `CerebrasProvider`, `GoogleAIProvider`, `HyperbolicProvider`, `OllamaCloudProvider`, `OpenRouterProvider`, `OllamaStrategicProvider`

**Decision:** Extend `BaseProvider` with `discoverModels()`, `getDefaultTuning()`, `getSystemPrompt()`. Extend existing concrete providers. Do NOT create a new base class or new adapter registry.

## Architecture

### Component 1: Model Registry Extensions

Add columns to existing `model_registry` table via schema migration:

```sql
ALTER TABLE model_registry ADD COLUMN family TEXT;              -- "qwen3", "llama", "gemma", "unknown"
ALTER TABLE model_registry ADD COLUMN quantization TEXT;         -- "Q4_K_M", "fp16", null for cloud
ALTER TABLE model_registry ADD COLUMN parameter_size_b REAL;     -- billions (computed from size_bytes or parsed from name)
ALTER TABLE model_registry ADD COLUMN role TEXT;                 -- 'fast', 'balanced', 'quality', 'default', 'fallback'
ALTER TABLE model_registry ADD COLUMN tuning_json TEXT;          -- per-model tuning overrides
ALTER TABLE model_registry ADD COLUMN prompt_template TEXT;      -- per-model system prompt override
ALTER TABLE model_registry ADD COLUMN probe_status TEXT DEFAULT 'pending';  -- 'pending', 'running', 'complete', 'failed'
ALTER TABLE model_registry ADD COLUMN source TEXT DEFAULT 'discovered';     -- 'discovered', 'manual', 'seed'
```

Add columns to existing `model_capabilities` table:

```sql
ALTER TABLE model_capabilities ADD COLUMN cap_hashline INTEGER DEFAULT 0;
ALTER TABLE model_capabilities ADD COLUMN cap_agentic INTEGER DEFAULT 0;
ALTER TABLE model_capabilities ADD COLUMN cap_file_creation INTEGER DEFAULT 0;
ALTER TABLE model_capabilities ADD COLUMN cap_multi_file INTEGER DEFAULT 0;
ALTER TABLE model_capabilities ADD COLUMN capability_source TEXT DEFAULT 'heuristic';  -- 'heuristic', 'probed', 'user'
```

**Key behaviors:**
- The existing `UNIQUE(provider, host_id, model_name)` constraint stays — supports multi-host Ollama correctly
- `role` in `model_registry` is per-host-model; `model_roles` table is per-provider (global role assignment). Both are queryable. `model_roles` takes precedence for role lookups, registry `role` is the per-host hint.
- `parameter_size_b` is computed from `size_bytes` (existing column) when available, or parsed from model name tag
- `family` is populated by the family classifier during discovery

**Replaces:**
- `config.ollama_model`, `ollama_fast_model`, `ollama_balanced_model`, `ollama_quality_model` → `model_roles` lookups
- `config.hashline_capable_models` → `SELECT model_name FROM model_capabilities WHERE cap_hashline = 1`
- `config.ollama_model_settings` (JSON blob) → `tuning_json` per registry entry
- `config.ollama_model_prompts` (JSON blob) → `prompt_template` per registry entry
- `MODEL_TIER_HINTS` in `host-selection.js` → `parameter_size_b` + auto-role assignment
- `DEFAULT_FALLBACK_MODEL` in `constants.js` → dynamic lookup: best available model from registry

### Component 2: Provider Adapter Evolution

Extend `BaseProvider` with discovery and tuning methods:

```js
class BaseProvider {
  // Existing methods (unchanged):
  async submit(task, model, options)
  async checkHealth()
  async listModels()
  hasCapacity()

  // New methods:
  async discoverModels()          // → [{model_name, family, parameter_size_b, context_window, sizeBytes, ...}]
  getDefaultTuning(model)         // → {temperature, top_k, ...} based on model family/size
  getSystemPrompt(model, format)  // → system prompt string for this model+format combo
  get providerType()              // 'local', 'cloud-api', 'cloud-cli'
  get requiresApiKey()            // true/false
}
```

Default implementations in `BaseProvider`:
- `discoverModels()` → calls `this.listModels()` and wraps results (backwards compatible)
- `getDefaultTuning()` → returns `{}` (no overrides)
- `getSystemPrompt()` → returns `null` (use family template)

**Concrete providers — what changes:**

| Provider | Changes |
|----------|---------|
| `OllamaProvider` | Add `discoverModels()` calling `/api/tags` with full metadata parsing. Add `getDefaultTuning()` looking up family templates. |
| `HashlineOllamaProvider` | Stays separate for backwards compatibility, but delegates to `OllamaProvider.discoverModels()`. Format selection driven by `cap_hashline` from registry. |
| `OllamaStrategicProvider` | Stays. Uses registry for model selection. |
| Cloud API providers (6) | Add `discoverModels()` calling `/v1/models`. Base implementation in a shared mixin or utility since they all extend `BaseProvider` independently today. |
| `GoogleAIProvider` | Custom `discoverModels()` for Google's API shape. |
| `AnthropicProvider` | Custom `discoverModels()` for Anthropic's API shape. |
| `CodexCliProvider` | `discoverModels()` returns static model list. |
| `ClaudeCliProvider` | `discoverModels()` returns static model list. |
| `CodexSparkProvider` | Listed in provider registry. Gets `discoverModels()`. |
| `AiderOllamaProvider` | Listed in provider registry. Delegates discovery to Ollama host. |

**New: `OpenAICompatibleMixin`** — shared discovery logic for the 6 cloud API providers that all use `/v1/chat/completions`:
```js
// server/providers/openai-compatible-mixin.js
const openAICompatibleMixin = {
  async discoverModelsFromAPI(baseUrl, apiKey) {
    // GET /v1/models, parse response, normalize into registry format
  },
  parseModelMetadata(model) {
    // Extract family, parameter_size_b, context_window from model metadata
  }
};
```

Each cloud provider calls `openAICompatibleMixin.discoverModelsFromAPI()` from its `discoverModels()` method.

**Adapter registry changes:**
- `adapter-registry.js` already has all providers registered with explicit `registerProviderAdapter()` calls
- Add a `discoverAllModels()` method that iterates registered adapters and calls `discoverModels()` on each enabled one
- No auto-loading scanner needed — explicit registration is fine and avoids the security concern of auto-requiring arbitrary files

**Adding a new provider (the user/LLM experience):**
1. Create a new provider file in `server/providers/` extending `BaseProvider`
2. Use `openAICompatibleMixin` for standard OpenAI-compatible APIs
3. Register in `adapter-registry.js` (one line)
4. Restart — provider appears, discovery runs, models populate registry

For runtime registration without restart, the `register_provider` MCP tool creates a `provider_config` DB entry (not a file) with `api_base_url`, `api_key_env`, and provider type. The existing generic cloud provider execution path handles it using the mixin. No code generation needed.

### Component 3: Discovery & Capability Probing

**Discovery flow (runs at startup + on-demand):**

1. For each enabled adapter in the registry: `adapter.checkHealth()` → `adapter.discoverModels()`
2. Results fed to existing `server/models/registry.js` `syncModelsFromHealthCheck()` (already handles insert/update/status)
3. New models get: `family` from classifier, `parameter_size_b` from metadata or name parsing
4. Auto-role assignment via `model_roles` table: if provider has no model for a role, assign by parameter size
5. Heuristic capability flags written to `model_capabilities`
6. Queue background probes for local Ollama models (cloud models skip probing)

**Auto-role assignment by parameter size:**

| Size | Role | Rationale |
|------|------|-----------|
| < 10B | fast | Quick tasks, low VRAM |
| 10-30B | balanced | General purpose |
| > 30B | quality | Complex reasoning |

If a role is already filled by another model on the same provider in `model_roles`, the new model is left unassigned. The user can reassign via tools. If the existing role holder is no longer present in the registry (removed/stale), the new model replaces it.

**Family classifier** (`server/discovery/family-classifier.js`):

Parses model names into families using prefix matching with normalization:
- `qwen3-coder:30b` → family `qwen3`, size parsed from tag `30b`
- `Qwen/Qwen3-235B-A22B` (deepinfra) → family `qwen3`, size from metadata
- `meta-llama/Llama-3.1-70B-Instruct` → family `llama`, size `70`
- Unknown patterns → family `unknown`

The classifier handles both Ollama-style names (`model:tag`) and cloud-style names (`org/Model-Name`).

**Family-based capability heuristics (initial guess):**

```js
const FAMILY_CAPABILITIES = {
  'qwen3':     { hashline: true,  agentic: true,  reasoning: true },
  'qwen2.5':   { hashline: true,  agentic: true,  reasoning: true },
  'codestral':  { hashline: true,  agentic: false, reasoning: false },
  'devstral':   { hashline: true,  agentic: true,  reasoning: true },
  'deepseek':   { hashline: true,  agentic: true,  reasoning: true },
  'llama':      { hashline: false, agentic: true,  reasoning: true },
  'gemma':      { hashline: true,  agentic: true,  reasoning: false },
  'mistral':    { hashline: false, agentic: true,  reasoning: false },
  'phi':        { hashline: false, agentic: false, reasoning: false },
  'command-r':  { hashline: false, agentic: true,  reasoning: true },
  // Unknown family → all false, probe determines
};
```

This replaces `WHITELIST_PREFIXES` in `agentic-capability.js` and `hashline_capable_models` config key.

**Capability probes (background, deferred until first use):**

Probes are **deferred** — they run when a model is first selected for a task, not at discovery time. This avoids GPU contention during startup on single-GPU setups. Probes respect the existing host slot system (they consume a slot).

Three micro-tests per model:

1. **Hashline probe** — 10-line file with hashline annotations, ask for single-line edit. Valid SEARCH/REPLACE → `cap_hashline = 1`.
2. **Agentic probe** — Simple tool definition, check for tool call response → `cap_agentic = 1`.
3. **Context window probe** — Send a ~16K token prompt and check for coherent response. If coherent → `context_window >= 16384`. (Skip the incremental 4K→32K approach to minimize GPU time.)

After probes: `probe_status = 'complete'`, `capability_source = 'probed'` in `model_capabilities`.

**Cloud provider behavior:**
- Standard cloud API providers: probing skipped, capabilities inferred from provider type (all support agentic)
- **`ollama-cloud`**: treated like local Ollama — probed for hashline/agentic since it's a remote Ollama endpoint with the same model variance

**Re-discovery triggers:** Server startup, health check cycle detects host recovery, `discover_models` MCP tool, provider enabled.

### Component 4: Family Templates & Tuning

New `model_family_templates` table:

```sql
model_family_templates (
  family          TEXT PRIMARY KEY,
  system_prompt   TEXT NOT NULL,
  tuning_json     TEXT NOT NULL,
  size_overrides  TEXT  -- JSON: {"small": {...}, "medium": {...}, "large": {...}}
)
```

**Prompt resolution (priority order):**
1. Model's `prompt_template` in `model_registry` (user override) — highest
2. Family template from `model_family_templates`
3. Universal fallback prompt — lowest

**Tuning resolution (merge order):**
1. Per-task tuning overrides from `submit_task`
2. Model's `tuning_json` in `model_registry` (user override)
3. Family template's `tuning_json` with size bucket applied
4. Role-based defaults (fast: `{temp: 0.3, num_ctx: 4096}`, quality: `{temp: 0.15, num_ctx: 16384}`)
5. Provider-level defaults (`PROVIDER_DEFAULTS.OLLAMA_DEFAULT_CONTEXT`)

**Size buckets within families:**
- small (<10B), medium (10-30B), large (>30B)
- Determined from `parameter_size_b` in registry

**Seeded families:** ~8 templates (qwen3, llama, gemma, deepseek, codestral, mistral, phi, unknown). The `unknown` family has a generic code-focused prompt:

```
You are a code-focused AI assistant. When editing code:
- Make ONLY the changes requested
- Preserve existing code style and conventions
- Include complete, working implementations
- Focus on correctness over cleverness
```

**Existing task-type presets** (code/precise/creative/balanced/fast) are orthogonal — they're about task intent, not model identity. They stay unchanged and merge at the role-based defaults layer.

### Component 5: OllamaAdapter Unification Detail

The `OllamaProvider` and `HashlineOllamaProvider` currently exist as separate classes. The unification does NOT rewrite the execution logic — it reorganizes how the format decision is made:

**Current flow:**
```
smart_routing decides "hashline-ollama" or "ollama" → different provider class → different execution path
```

**New flow:**
```
smart_routing decides "ollama" → OllamaProvider.submit() checks cap_hashline for selected model
  → cap_hashline=1: delegates to executeHashlineOllamaTask() (existing code from execute-hashline.js)
  → cap_hashline=0: delegates to executeOllamaTask() (existing code from execute-ollama.js)
```

`execute-hashline.js` and `execute-ollama.js` remain as modules — their functions are called by the adapter, not inlined into it. The adapter is a thin dispatcher, not a 2000-line monolith.

`hashline-ollama` stays as a routing alias in smart routing and routing templates for backwards compatibility. At the adapter registry level, it resolves to the same `OllamaProvider` instance.

### Component 6: User-Facing API

**New MCP tools:**

| Tool | Purpose |
|------|---------|
| `list_models` | All models in registry, grouped by provider. Role, capabilities, probe status, last seen. |
| `assign_model_role` | Assign a model to a role for its provider (writes to `model_roles`). |
| `discover_models` | Trigger discovery on one or all providers. Returns newly found models. |
| `probe_model` | Manually trigger capability probes on a specific model. |
| `set_model_tuning` | Override tuning for a specific model (writes to `model_registry.tuning_json`). |
| `set_model_prompt` | Override system prompt for a specific model (writes to `model_registry.prompt_template`). |
| `register_provider` | Register a new OpenAI-compatible provider via DB config entry (name + base URL + API key env var). No file generation. |
| `list_providers` | All providers with health, model count, type, enabled status. |

**Updated tools:**
- `submit_task` / `smart_submit_task` — `model` accepts any model in registry
- `configure_provider` — stays for enable/disable/API key, no longer handles model assignment

**Deprecated tools (with backwards-compatible shims):**
- `set_llm_tuning` / `get_llm_tuning` → `set_model_tuning`
- `set_hardware_tuning` / `get_hardware_tuning` → OllamaProvider config
- `configure_model_roles` → `assign_model_role`
- Existing `model-roles.js` functions (`getModelForRole`, `setModelRole`, etc.) get deprecation warnings pointing to new tools

## Migration Plan

### Phase 1: Registry + Family Templates (data layer)

- Schema migration: add columns to `model_registry` and `model_capabilities` tables
- Create `model_family_templates` table, seed with 8 families + unknown
- Extend `server/models/registry.js` with family classification and `parameter_size_b` computation
- At startup, migrate existing config values into registry + model_roles:
  - Read `ollama_model`, `ollama_fast_model`, etc. → insert into `model_roles`
  - Read `hashline_capable_models` → set `cap_hashline` flags in `model_capabilities`
  - Read `ollama_model_settings` JSON → populate `tuning_json` per registry entry
  - Read `ollama_model_prompts` JSON → populate `prompt_template` per registry entry
- Replace `DEFAULT_FALLBACK_MODEL` constant in `constants.js` with a dynamic registry lookup function
- Old config keys remain readable as fallback. Writes go to registry/model_roles.
- **Backwards compatible** — if registry is empty, system falls back to reading old config keys

### Phase 2: Discovery Engine

- Add `discoverModels()` to `BaseProvider` (default: wraps `listModels()`)
- Implement full `discoverModels()` on `OllamaProvider` (via `/api/tags` with metadata)
- Create `openai-compatible-mixin.js` for cloud API discovery (via `/v1/models`)
- Wire discovery into `adapter-registry.js` `discoverAllModels()`
- Hook into startup and health check cycle (via existing health check infrastructure)
- Implement auto-role assignment in `model_roles` based on parameter size
- Implement family classifier (`server/discovery/family-classifier.js`)
- Implement heuristic capability flags
- Implement deferred capability probes (run on first task use, respect host slots)
- Fresh installs auto-populate registry from available models
- `ollama-cloud` provider probed like local Ollama

### Phase 3: Provider Adapter Enhancements

- Add `getDefaultTuning()` and `getSystemPrompt()` to `BaseProvider`
- Implement on each concrete provider (family template lookup + size bucket)
- Migrate prompt/tuning resolution in execution paths to use the new methods
- Unify `OllamaProvider` / `HashlineOllamaProvider` dispatch: single entry point, format selection by `cap_hashline`
- Register `hashline-ollama` as alias in adapter registry
- Cloud providers get `discoverModels()` via mixin
- **Each provider migrated independently** — adapter-or-fallback pattern, half-migrated state is valid

### Phase 4: Cleanup

- Remove deprecated config keys (`ollama_model`, `ollama_fast_model`, `hashline_capable_models`, `ollama_model_settings`, `ollama_model_prompts`)
- Remove `MODEL_TIER_HINTS` from `host-selection.js`
- Remove hardcoded model names from source files (excluding test fixtures)
- Remove `WHITELIST_PREFIXES` from `agentic-capability.js` (replaced by registry + family heuristics)
- Add deprecation shims for old MCP tools
- Introduce `server/tests/test-models.js` with `TEST_MODELS` constants
- Migrate test files to `TEST_MODELS` — incremental, can be a TORQUE batch job
- Update MCP tool definitions in `tools.js` and `tool-annotations.js`
- Update dashboard

## Test Strategy

- `server/tests/test-models.js` exports fictional model constants:
  ```js
  TEST_MODELS = {
    FAST: 'test-fast:7b',
    BALANCED: 'test-balanced:14b',
    QUALITY: 'test-quality:32b',
    HASHLINE: 'test-hashline:14b',
    CLOUD: 'test-cloud-model'
  }
  ```
- Test files migrate incrementally from real model names to these constants
- Tests that assert on model names in response objects use the constants
- Each phase has its own test coverage before moving to the next
- Discovery tests use mock HTTP servers for provider API simulation
- Probe tests use mock Ollama responses
- Existing `test-helpers.js` already has `TEST_MODELS` — extend it

## Files Affected (Key)

**New files:**
- `server/discovery/family-classifier.js` — model name → family parsing
- `server/discovery/capability-prober.js` — deferred probe system
- `server/discovery/auto-role-assigner.js` — parameter size → role assignment
- `server/providers/openai-compatible-mixin.js` — shared `/v1/models` discovery
- `server/db/family-templates.js` — family template CRUD
- `server/tests/test-models.js` — test constants (or extend existing `test-helpers.js`)

**Modified files (key ones):**
- `server/db/schema-migrations.js` — ALTER TABLE migrations for registry + capabilities
- `server/db/schema-tables.js` — `model_family_templates` table
- `server/db/schema-seeds.js` — family template seeds, remove model-name-keyed seeds
- `server/models/registry.js` — extend with family classification, parameter_size_b
- `server/providers/base.js` — add `discoverModels()`, `getDefaultTuning()`, `getSystemPrompt()`
- `server/providers/adapter-registry.js` — add `discoverAllModels()`, alias support
- `server/providers/v2-local-providers.js` — OllamaProvider discovery + format unification
- `server/providers/ollama-cloud.js` — discovery via mixin, probe support
- `server/providers/groq.js`, `deepinfra.js`, `cerebras.js`, `hyperbolic.js`, `openrouter.js`, `google-ai.js`, `anthropic.js` — add `discoverModels()`
- `server/db/host-selection.js` — remove `MODEL_TIER_HINTS`, query registry
- `server/providers/agentic-capability.js` — query `model_capabilities` instead of `WHITELIST_PREFIXES`
- `server/db/model-roles.js` — extend with auto-assignment, deprecation warnings
- `server/constants.js` — replace `DEFAULT_FALLBACK_MODEL` with dynamic lookup
- `server/execution/provider-router.js` — use registry for model resolution
- `server/db/smart-routing.js` — query registry for capabilities
- `server/container.js` — register new services
- `server/tools.js` — new MCP tool definitions
- `server/tool-annotations.js` — annotations for new tools
- `~120 test files` — migrate to `TEST_MODELS` constants

## What Stays Unchanged

- Routing templates (task category → provider chain mapping)
- Task-type tuning presets (code/precise/creative/balanced/fast)
- Smart routing algorithm (complexity detection, category classification)
- Fallback chain logic (provider A fails → try provider B)
- Task lifecycle (submit → queue → execute → complete)
- Authentication system
- Dashboard framework (content changes, structure stays)
- `execute-hashline.js` and `execute-ollama.js` internal logic (reorganized, not rewritten)
- `model_task_outcomes` table (empirical success/failure tracking)
- Existing `BaseProvider` class and concrete provider implementations (extended, not replaced)
- Existing `adapter-registry.js` registration pattern (extended, not replaced)
