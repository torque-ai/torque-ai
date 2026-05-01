# Model-Agnostic Phase 2: Discovery Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic model discovery across all providers so that TORQUE populates its model registry from whatever models are actually available — with auto-role assignment and heuristic capability flags — instead of relying on hardcoded model names.

**Architecture:** Add `discoverModels()` method to `BaseProvider`. Implement it on cloud API providers using their existing `checkHealth()` data (which already queries `/v1/models`). Create a discovery orchestrator that iterates all enabled providers, feeds results into the existing `models/registry.js` `syncModelsFromHealthCheck()`, then runs auto-role assignment and heuristic capability classification. Wire into startup and health check cycles.

**Tech Stack:** Node.js, better-sqlite3 (synchronous), vitest, existing health-check infrastructure in `host-monitoring.js`

**Spec:** `docs/superpowers/specs/2026-03-23-model-agnostic-provider-adapters-design.md` (Component 3)

**Depends on:** Phase 1 complete (family classifier, registry extensions, family templates, model_roles)

---

## Important Notes

**Existing infrastructure to leverage:**
- `host-monitoring.js` already calls `registry.syncModelsFromHealthCheck('ollama', host.id, result.models)` for Ollama hosts during health checks. The health check flow already populates the registry. Phase 2 extends this to cloud providers and adds post-discovery processing (role assignment + capabilities).
- Cloud providers' `checkHealth()` methods already query `/v1/models` and return model IDs. We upgrade them to return richer metadata.
- `models/registry.js` `registerModelInternal()` (extended in Phase 1) already classifies family + parameter_size_b on insert.

**What we're NOT doing in Phase 2:**
- Capability probes (deferred to Phase 3 — they require GPU time). The spec lists probes in Phase 2 scope but heuristic capabilities provide an 80% solution, so we defer probes to Phase 3 alongside the provider adapter unification.
- `openai-compatible-mixin.js` shared discovery helper — deferred to Phase 3 when provider adapters are unified. For now, each cloud provider's `checkHealth()` is upgraded individually. The duplication is acceptable for 8 providers.
- Provider adapter unification (Phase 3)
- Removing hardcoded model names from source (Phase 4)

**`ollama-cloud` is treated as local Ollama** — per the spec, its models go through the same pending/approval flow as local Ollama (not auto-approved like other cloud providers), because `ollama-cloud` connects to a remote Ollama instance with the same model capability variance.

**Adapter registry wrapper must forward `discoverModels()`** — the `registerApiAdapter()` wrapper in `adapter-registry.js` only forwards `submit`, `stream`, `checkHealth`, `listModels`, etc. Task 1 must also add `discoverModels()` forwarding to the wrapper, or the discovery engine cannot call it through the adapter registry.

**`BaseProvider.discoverModels()` default calls `checkHealth()`** — since `checkHealth()` already queries `/v1/models` on cloud providers, the default implementation extracts rich model metadata from the health check result rather than calling `listModels()` (which returns static string arrays). This means Task 2's `checkHealth()` upgrades automatically feed into discovery.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/discovery/discovery-engine.js` | Orchestrates discovery across all providers, runs post-discovery processing |
| Create | `server/discovery/auto-role-assigner.js` | Assigns roles to newly discovered models based on parameter size |
| Create | `server/discovery/heuristic-capabilities.js` | Sets capability flags on models based on family |
| Create | `server/tests/discovery-engine.test.js` | Tests for discovery orchestration |
| Create | `server/tests/auto-role-assigner.test.js` | Tests for role assignment |
| Create | `server/tests/heuristic-capabilities.test.js` | Tests for capability heuristics |
| Modify | `server/providers/base.js` | Add `discoverModels()` default method |
| Modify | `server/providers/groq.js` | Return rich model metadata from `checkHealth()` |
| Modify | `server/providers/deepinfra.js` | Return rich model metadata from `checkHealth()` |
| Modify | `server/providers/cerebras.js` | Return rich model metadata from `checkHealth()` |
| Modify | `server/providers/hyperbolic.js` | Return rich model metadata from `checkHealth()` |
| Modify | `server/providers/openrouter.js` | Return rich model metadata from `checkHealth()` |
| Modify | `server/providers/ollama-cloud.js` | Return rich model metadata from `checkHealth()` |
| Modify | `server/providers/google-ai.js` | Return rich model metadata from `checkHealth()` |
| Modify | `server/providers/anthropic.js` | Return rich model metadata from `checkHealth()` |
| Modify | `server/providers/adapter-registry.js` | Add `discoverAllModels()` method |
| Modify | `server/utils/host-monitoring.js` | Call post-discovery processing after Ollama sync |
| Modify | `server/container.js` | Register new services |

---

### Task 1: Add `discoverModels()` to BaseProvider

**Files:**
- Modify: `server/providers/base.js`
- Create: `server/tests/base-provider-discover.test.js`

- [ ] **Step 1: Write failing test**

Create `server/tests/base-provider-discover.test.js`. Test:
- `BaseProvider` has a `discoverModels()` method
- Default implementation returns `{ models: [], provider: this.name }`
- It does not throw

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/base-provider-discover.test.js`
Expected: FAIL — `discoverModels` is not a function

- [ ] **Step 3: Add `discoverModels()` to BaseProvider**

In `server/providers/base.js`, add after `listModels()`:

```js
/**
 * Discover available models with rich metadata.
 * Default calls checkHealth() which already queries /v1/models on cloud providers.
 * Override in subclasses for provider-specific discovery.
 * @returns {Promise<{models: Array<{model_name: string, sizeBytes?: number}>, provider: string}>}
 */
async discoverModels() {
  try {
    const health = await this.checkHealth();
    const models = (health?.models || []).map(m =>
      typeof m === 'string' ? { model_name: m } : m
    );
    return { models, provider: this.name };
  } catch {
    return { models: [], provider: this.name };
  }
}
```

This default extracts rich model metadata from `checkHealth()` (which already queries `/v1/models` on cloud providers), so upgrading `checkHealth()` in Task 2 automatically feeds richer data into discovery.

Also in `server/providers/adapter-registry.js`, add `discoverModels()` to the wrapper object returned by `registerApiAdapter()` (inside the return block, alongside `checkHealth` and `listModels`):

```js
async discoverModels() {
  const providerInstance = resolveProvider();
  return providerInstance.discoverModels();
},
```

Without this, `getProviderAdapter(id).discoverModels()` would throw since the wrapper doesn't forward it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/base-provider-discover.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

Message: `feat: add discoverModels() default method to BaseProvider`
Files: `server/providers/base.js`, `server/tests/base-provider-discover.test.js`

---

### Task 2: Upgrade Cloud Provider `checkHealth()` to Return Rich Metadata

**Files:**
- Modify: `server/providers/groq.js`, `server/providers/deepinfra.js`, `server/providers/cerebras.js`, `server/providers/hyperbolic.js`, `server/providers/openrouter.js`, `server/providers/ollama-cloud.js`, `server/providers/google-ai.js`, `server/providers/anthropic.js`
- Create: `server/tests/cloud-provider-discovery.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/cloud-provider-discovery.test.js`. For each cloud provider that queries `/v1/models` in `checkHealth()`, test that the `models` array in the health check result contains objects with `{ model_name, id }` (not just strings). Use a mock HTTP server or mock `fetch` to simulate the API response.

Test cases:
- Groq `checkHealth()` returns `models` as objects with `model_name` field
- DeepInfra `checkHealth()` returns `models` as objects with `model_name` field
- Provider with no API key returns `{ available: false, models: [] }` (unchanged behavior)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/cloud-provider-discovery.test.js`
Expected: FAIL — `models` array contains strings, not objects

- [ ] **Step 3: Upgrade `checkHealth()` across cloud providers**

The current pattern in each cloud provider's `checkHealth()`:
```js
const models = Array.isArray(data?.data)
  ? data.data.map(m => m.id).filter(Boolean)
  : [this.defaultModel];
```

Change to preserve the full model object while remaining backwards-compatible:
```js
const models = Array.isArray(data?.data)
  ? data.data.map(m => ({
      model_name: m.id,
      id: m.id,
      owned_by: m.owned_by,
      context_window: m.context_length || m.context_window,
    })).filter(m => m.model_name)
  : [{ model_name: this.defaultModel }];
```

**Provider-specific notes:**
- **Groq, Cerebras, DeepInfra, Hyperbolic:** Standard OpenAI `/v1/models` response with `data.data[].id`
- **OpenRouter:** `/v1/models` returns richer metadata including `context_length` and `pricing`
- **Ollama-cloud:** Uses `/api/tags` (Ollama API), response has `models[].name` and `models[].details.parameter_size`
- **Google-AI:** Different API shape — adjust accordingly
- **Anthropic:** Different API shape — adjust accordingly

Also update each provider's `listModels()` to call `discoverModels()` internally for consistency, OR keep `listModels()` as the simple string-array API and let `discoverModels()` be the rich version.

**Decision:** Keep `listModels()` returning string arrays (backwards compat). Override `discoverModels()` on each cloud provider to call `checkHealth()` and extract the rich model metadata. This is the cleanest split — `listModels()` = simple, `discoverModels()` = rich.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/cloud-provider-discovery.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

Message: `feat: upgrade cloud provider checkHealth to return rich model metadata`
Files: All modified provider files, test file

---

### Task 3: Heuristic Capabilities Module

**Files:**
- Create: `server/discovery/heuristic-capabilities.js`
- Create: `server/tests/heuristic-capabilities.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/heuristic-capabilities.test.js`. Test:
- `getHeuristicCapabilities('qwen3')` returns `{ hashline: true, agentic: true, file_creation: true, multi_file: false, reasoning: true }`
- `getHeuristicCapabilities('llama')` returns `{ hashline: false, agentic: true, ... }`
- `getHeuristicCapabilities('unknown')` returns all false
- `applyHeuristicCapabilities(db, 'qwen3-coder:30b', 'qwen3')` inserts/updates `model_capabilities` with correct flags
- `applyHeuristicCapabilities` does NOT overwrite if `capability_source` is `'probed'` or `'user'` (only overwrites `'heuristic'`)

- [ ] **Step 2: Run test to verify they fail**

Run: `npx vitest run server/tests/heuristic-capabilities.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement heuristic capabilities**

Create `server/discovery/heuristic-capabilities.js`:

```js
'use strict';

const FAMILY_CAPABILITIES = {
  'qwen3':     { hashline: true,  agentic: true,  file_creation: true,  multi_file: false, reasoning: true },
  'qwen2.5':   { hashline: true,  agentic: true,  file_creation: true,  multi_file: false, reasoning: true },
  'codestral': { hashline: true,  agentic: false, file_creation: false, multi_file: false, reasoning: false },
  'devstral':  { hashline: true,  agentic: true,  file_creation: true,  multi_file: false, reasoning: true },
  'deepseek':  { hashline: true,  agentic: true,  file_creation: false, multi_file: false, reasoning: true },
  'llama':     { hashline: false, agentic: true,  file_creation: false, multi_file: false, reasoning: true },
  'gemma':     { hashline: true,  agentic: true,  file_creation: false, multi_file: false, reasoning: false },
  'mistral':   { hashline: false, agentic: true,  file_creation: false, multi_file: false, reasoning: false },
  'phi':       { hashline: false, agentic: false, file_creation: false, multi_file: false, reasoning: false },
  'command-r': { hashline: false, agentic: true,  file_creation: false, multi_file: false, reasoning: true },
  'codellama': { hashline: true,  agentic: false, file_creation: false, multi_file: false, reasoning: false },
};

const DEFAULT_CAPABILITIES = { hashline: false, agentic: false, file_creation: false, multi_file: false, reasoning: false };

function getHeuristicCapabilities(family) {
  return FAMILY_CAPABILITIES[family] || DEFAULT_CAPABILITIES;
}

function applyHeuristicCapabilities(db, modelName, family) {
  const caps = getHeuristicCapabilities(family);
  // Only insert/update if source is 'heuristic' or row doesn't exist
  db.prepare(`
    INSERT INTO model_capabilities (model_name, cap_hashline, cap_agentic, cap_file_creation, cap_multi_file, capability_source, updated_at)
    VALUES (?, ?, ?, ?, ?, 'heuristic', datetime('now'))
    ON CONFLICT(model_name) DO UPDATE SET
      cap_hashline = CASE WHEN capability_source = 'heuristic' THEN excluded.cap_hashline ELSE cap_hashline END,
      cap_agentic = CASE WHEN capability_source = 'heuristic' THEN excluded.cap_agentic ELSE cap_agentic END,
      cap_file_creation = CASE WHEN capability_source = 'heuristic' THEN excluded.cap_file_creation ELSE cap_file_creation END,
      cap_multi_file = CASE WHEN capability_source = 'heuristic' THEN excluded.cap_multi_file ELSE cap_multi_file END,
      updated_at = CASE WHEN capability_source = 'heuristic' THEN datetime('now') ELSE updated_at END
  `).run(
    modelName,
    caps.hashline ? 1 : 0,
    caps.agentic ? 1 : 0,
    caps.file_creation ? 1 : 0,
    caps.multi_file ? 1 : 0
  );
}

module.exports = { getHeuristicCapabilities, applyHeuristicCapabilities, FAMILY_CAPABILITIES };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/heuristic-capabilities.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

Message: `feat: heuristic capability classification by model family`
Files: `server/discovery/heuristic-capabilities.js`, `server/tests/heuristic-capabilities.test.js`

---

### Task 4: Auto-Role Assigner

**Files:**
- Create: `server/discovery/auto-role-assigner.js`
- Create: `server/tests/auto-role-assigner.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/auto-role-assigner.test.js`. Set up in-memory DB with `model_roles` and `model_registry` tables. Test:
- `assignRolesForProvider(db, 'ollama')` assigns `fast` to a 4B model, `balanced` to a 14B model, `quality` to a 32B model
- Does NOT overwrite an existing role assignment (role already occupied → skip)
- Does replace a role if the existing model is no longer in the registry (status = 'removed')
- Assigns `default` role to the best available model if no default exists
- Returns a summary of assignments made

- [ ] **Step 2: Run test to verify they fail**

Run: `npx vitest run server/tests/auto-role-assigner.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement auto-role assigner**

Create `server/discovery/auto-role-assigner.js`:

```js
'use strict';

const { suggestRole } = require('./family-classifier');

function assignRolesForProvider(db, provider) {
  const assignments = [];

  // Get all approved models for this provider with parameter size
  const models = db.prepare(`
    SELECT DISTINCT model_name, parameter_size_b
    FROM model_registry
    WHERE provider = ? AND status = 'approved' AND parameter_size_b IS NOT NULL
    ORDER BY parameter_size_b DESC
  `).all(provider);

  if (models.length === 0) return assignments;

  const roles = ['fast', 'balanced', 'quality', 'default'];

  for (const role of roles) {
    // Check if role is already assigned to a live model
    const existing = db.prepare(
      "SELECT model_name FROM model_roles WHERE provider = ? AND role = ?"
    ).get(provider, role);

    if (existing) {
      // Check if the assigned model still exists and is approved
      const stillAlive = db.prepare(
        "SELECT 1 FROM model_registry WHERE provider = ? AND model_name = ? AND status = 'approved'"
      ).get(provider, existing.model_name);

      if (stillAlive) continue; // Role is filled by a live model — skip
    }

    // Find best candidate for this role
    let candidate;
    if (role === 'default') {
      // Default = largest available model
      candidate = models[0];
    } else {
      // Find a model whose suggested role matches
      candidate = models.find(m => suggestRole(m.parameter_size_b) === role);
    }

    if (candidate) {
      db.prepare(`
        INSERT OR REPLACE INTO model_roles (provider, role, model_name, updated_at)
        VALUES (?, ?, ?, datetime('now'))
      `).run(provider, role, candidate.model_name);
      assignments.push({ role, model: candidate.model_name, size: candidate.parameter_size_b });
    }
  }

  return assignments;
}

module.exports = { assignRolesForProvider };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/auto-role-assigner.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

Message: `feat: auto-role assignment for discovered models by parameter size`
Files: `server/discovery/auto-role-assigner.js`, `server/tests/auto-role-assigner.test.js`

---

### Task 5: Discovery Engine — Orchestrator

**Files:**
- Create: `server/discovery/discovery-engine.js`
- Create: `server/tests/discovery-engine.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/discovery-engine.test.js`. Test:
- `runPostDiscovery(db, provider)` calls auto-role assignment and heuristic capabilities for each newly registered model
- `discoverFromProvider(db, adapter, provider)` calls `adapter.discoverModels()`, feeds results into `registry.syncModelsFromHealthCheck()`, then runs post-discovery
- Returns summary with counts: `{ discovered, new, updated, removed, roles_assigned, capabilities_set }`

- [ ] **Step 2: Run test to verify they fail**

Run: `npx vitest run server/tests/discovery-engine.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement discovery engine**

Create `server/discovery/discovery-engine.js`:

```js
'use strict';

const logger = require('../logger').child({ component: 'discovery-engine' });
const { assignRolesForProvider } = require('./auto-role-assigner');
const { applyHeuristicCapabilities } = require('./heuristic-capabilities');

/**
 * Post-discovery processing: apply heuristic capabilities + auto-assign roles.
 * Called after models are synced into the registry.
 */
function runPostDiscovery(db, provider, syncResult) {
  let capabilitiesSet = 0;

  // Apply heuristic capabilities for new models
  for (const model of (syncResult?.new || [])) {
    if (model.family) {
      try {
        applyHeuristicCapabilities(db, model.model_name, model.family);
        capabilitiesSet++;
      } catch (err) {
        logger.warn(`Failed to apply capabilities for ${model.model_name}: ${err.message}`);
      }
    }
  }

  // Auto-assign roles
  let rolesAssigned = [];
  try {
    rolesAssigned = assignRolesForProvider(db, provider);
    if (rolesAssigned.length > 0) {
      logger.info(`Auto-assigned roles for ${provider}: ${rolesAssigned.map(r => `${r.role}=${r.model}`).join(', ')}`);
    }
  } catch (err) {
    logger.warn(`Failed to auto-assign roles for ${provider}: ${err.message}`);
  }

  return { capabilities_set: capabilitiesSet, roles_assigned: rolesAssigned };
}

/**
 * Run discovery for a specific provider via its adapter.
 * Calls adapter.discoverModels(), syncs into registry, runs post-discovery.
 */
async function discoverFromAdapter(db, adapter, provider, hostId) {
  const registry = require('../models/registry');

  let discoveryResult;
  try {
    discoveryResult = await adapter.discoverModels();
  } catch (err) {
    logger.warn(`Discovery failed for ${provider}: ${err.message}`);
    return { discovered: 0, new: 0, updated: 0, removed: 0, roles_assigned: [], capabilities_set: 0 };
  }

  const models = discoveryResult?.models || [];
  if (models.length === 0) {
    return { discovered: 0, new: 0, updated: 0, removed: 0, roles_assigned: [], capabilities_set: 0 };
  }

  // Feed into registry
  const syncResult = registry.syncModelsFromHealthCheck(provider, hostId || null, models);

  // Auto-approve new models from cloud providers (Ollama-family models stay pending for user review)
  // ollama-cloud is treated as local per spec — same model capability variance as local Ollama
  const isCloudProvider = !['ollama', 'hashline-ollama', 'ollama-cloud'].includes(provider);
  if (isCloudProvider) {
    for (const model of syncResult.new) {
      try {
        registry.approveModel(provider, model.model_name, hostId || null);
      } catch { /* already approved */ }
    }
  }

  // Post-discovery processing
  const postResult = runPostDiscovery(db, provider, syncResult);

  return {
    discovered: models.length,
    new: syncResult.new.length,
    updated: syncResult.updated.length,
    removed: syncResult.removed.length,
    roles_assigned: postResult.roles_assigned,
    capabilities_set: postResult.capabilities_set,
  };
}

module.exports = {
  runPostDiscovery,
  discoverFromAdapter,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/discovery-engine.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

Message: `feat: discovery engine orchestrates model discovery + post-processing`
Files: `server/discovery/discovery-engine.js`, `server/tests/discovery-engine.test.js`

---

### Task 6: Add `discoverAllModels()` to Adapter Registry

**Files:**
- Modify: `server/providers/adapter-registry.js`
- Create: `server/tests/adapter-registry-discover.test.js`

- [ ] **Step 1: Write failing test**

Create `server/tests/adapter-registry-discover.test.js`. Test:
- `discoverAllModels(db)` iterates all registered adapters
- Calls `discoverModels()` on each enabled adapter that has an API key configured
- Returns a summary per provider
- Skips providers that throw errors (graceful degradation)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/adapter-registry-discover.test.js`
Expected: FAIL — `discoverAllModels` not exported

- [ ] **Step 3: Add `discoverAllModels()` to adapter-registry.js**

Add a function that iterates registered adapters:

```js
async function discoverAllModels(db) {
  const { discoverFromAdapter } = require('../discovery/discovery-engine');
  const serverConfig = require('../config');
  const results = {};

  for (const providerId of getRegisteredProviderIds()) {
    const adapter = getProviderAdapter(providerId);
    if (!adapter) continue;

    // Skip providers without API keys (except local Ollama variants)
    const isLocal = ['ollama', 'hashline-ollama', 'ollama-strategic'].includes(providerId);
    if (!isLocal) {
      const hasKey = serverConfig.getApiKey(providerId);
      if (!hasKey) continue;
    }

    try {
      results[providerId] = await discoverFromAdapter(db, adapter, providerId, null);
    } catch (err) {
      results[providerId] = { error: err.message };
    }
  }

  return results;
}
```

Export `discoverAllModels` from the module.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/adapter-registry-discover.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

Message: `feat: add discoverAllModels to adapter registry for bulk provider discovery`
Files: `server/providers/adapter-registry.js`, `server/tests/adapter-registry-discover.test.js`

---

### Task 7: Wire Post-Discovery into Ollama Health Check Cycle

**Files:**
- Modify: `server/utils/host-monitoring.js`

- [ ] **Step 1: Read `server/utils/host-monitoring.js`**

Find the existing block (around line 182-192) where `syncModelsFromHealthCheck` is called. This already feeds Ollama models into the registry.

- [ ] **Step 2: Add post-discovery processing after the sync**

After the `syncModelsFromHealthCheck` call in the health check loop, add:

```js
// Post-discovery: apply heuristic capabilities + auto-assign roles for new models
if (sync.new.length > 0) {
  try {
    const { runPostDiscovery } = require('../discovery/discovery-engine');
    const rawDb = db.getDbInstance ? db.getDbInstance() : db;
    runPostDiscovery(rawDb, provider, sync);
  } catch (_err) { void _err; }
}
```

This ensures that every time Ollama health checks discover new models, they automatically get capability flags and role assignments.

- [ ] **Step 3: Commit**

Message: `feat: wire post-discovery processing into Ollama health check cycle`
Files: `server/utils/host-monitoring.js`

---

### Task 8: Wire Discovery into Startup + Register in DI Container

**Files:**
- Modify: `server/container.js` or `server/index.js`

- [ ] **Step 1: Add startup discovery call**

In `server/index.js`, after the config migration call (added in Phase 1), add a deferred discovery call. It should run after the server is fully started (non-blocking):

```js
// Run initial cloud provider discovery after a short delay (non-blocking).
// Ollama models are discovered by the health check cycle (first check at ~15s).
// This 10s delay discovers cloud provider models (groq, deepinfra, etc.).
setTimeout(async () => {
  try {
    const { discoverAllModels } = require('./providers/adapter-registry');
    const rawDb = db.getDbInstance();
    const results = await discoverAllModels(rawDb);
    const totalNew = Object.values(results).reduce((sum, r) => sum + (r.new || 0), 0);
    if (totalNew > 0) {
      logger.info(`Initial discovery: found ${totalNew} new model(s) across ${Object.keys(results).length} provider(s)`);
    }
  } catch (err) {
    logger.warn(`Initial model discovery: ${err.message}`);
  }
}, 10000); // 10 seconds after startup
```

The 10-second delay allows health checks to complete first (they discover Ollama models). The `discoverAllModels()` call then discovers cloud provider models.

- [ ] **Step 2: Commit**

Message: `feat: run initial model discovery 10s after server startup`
Files: `server/index.js`

---

### Task 9: MCP Tool — `discover_models`

**Files:**
- Modify: `server/tools.js` (add tool definition)
- Create: `server/handlers/discovery-handlers.js` (handler)
- Modify: `server/tool-annotations.js` (add annotation)

- [ ] **Step 1: Create the handler**

Create `server/handlers/discovery-handlers.js`:

```js
'use strict';

async function handleDiscoverModels(args) {
  const { discoverAllModels } = require('../providers/adapter-registry');
  const db = require('../database').getDbInstance();

  const provider = args?.provider;

  if (provider) {
    const { discoverFromAdapter } = require('../discovery/discovery-engine');
    const { getProviderAdapter } = require('../providers/adapter-registry');
    const adapter = getProviderAdapter(provider);
    if (!adapter) return { error: `Unknown provider: ${provider}` };
    const result = await discoverFromAdapter(db, adapter, provider, null);
    return formatDiscoveryResult(provider, result);
  }

  const results = await discoverAllModels(db);
  return formatAllResults(results);
}

function formatDiscoveryResult(provider, result) {
  if (result.error) return `## Discovery: ${provider}\n\nError: ${result.error}`;
  return `## Discovery: ${provider}\n\n` +
    `| Metric | Count |\n|--------|-------|\n` +
    `| Discovered | ${result.discovered} |\n` +
    `| New | ${result.new} |\n` +
    `| Updated | ${result.updated} |\n` +
    `| Removed | ${result.removed} |\n` +
    `| Capabilities set | ${result.capabilities_set} |\n` +
    (result.roles_assigned.length > 0
      ? `\n**Roles assigned:** ${result.roles_assigned.map(r => `${r.role}=${r.model}`).join(', ')}`
      : '');
}

function formatAllResults(results) {
  let out = '## Model Discovery Results\n\n';
  for (const [provider, result] of Object.entries(results)) {
    out += formatDiscoveryResult(provider, result) + '\n\n';
  }
  return out;
}

module.exports = { handleDiscoverModels };
```

- [ ] **Step 2: Add tool definition to tools.js**

In `server/tools.js`, find the tool definitions array and add:

```js
{
  name: 'discover_models',
  description: 'Trigger model discovery on one or all providers. Queries provider APIs for available models, registers them in the model registry, applies capability heuristics, and auto-assigns roles.',
  inputSchema: {
    type: 'object',
    properties: {
      provider: {
        type: 'string',
        description: 'Optional: discover models from a specific provider only. Omit to discover from all enabled providers.',
      },
    },
  },
}
```

Wire the handler in the tool dispatch section.

- [ ] **Step 3: Add tool annotation to tool-annotations.js**

Add entry for `discover_models` with appropriate annotation (readOnlyHint: false, destructiveHint: false).

- [ ] **Step 4: Commit**

Message: `feat: add discover_models MCP tool for on-demand model discovery`
Files: `server/handlers/discovery-handlers.js`, `server/tools.js`, `server/tool-annotations.js`

---

## Phase 2 Completion Checklist

After all 9 tasks are done, verify:

- [ ] `BaseProvider` has `discoverModels()` method
- [ ] Cloud providers' `checkHealth()` returns rich model metadata (objects, not just strings)
- [ ] Heuristic capabilities module correctly maps families to cap_hashline/cap_agentic/etc.
- [ ] Auto-role assigner fills fast/balanced/quality/default roles from discovered models
- [ ] Discovery engine orchestrates discovery → registry sync → post-processing
- [ ] Adapter registry has `discoverAllModels(db)` for bulk discovery
- [ ] Ollama health check cycle runs post-discovery processing for new models
- [ ] Initial discovery runs 10s after server startup
- [ ] `discover_models` MCP tool works for on-demand discovery
- [ ] All new code has test coverage

## Next Phase

Phase 3 (Provider Adapter Enhancements) builds on this:
- Add `getDefaultTuning()` and `getSystemPrompt()` to BaseProvider
- Implement on each concrete provider (family template lookup + size bucket)
- Unify OllamaProvider / HashlineOllamaProvider dispatch
- Deferred capability probes

See spec: `docs/superpowers/specs/2026-03-23-model-agnostic-provider-adapters-design.md`, Components 3+5.
