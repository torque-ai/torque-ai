# Per-Host Default Ollama Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-host `default_model` setting to Ollama hosts, exposed via the dashboard Hosts page, replacing all hardcoded model fallbacks with a dynamic resolution chain.

**Architecture:** New `default_model` column on `ollama_hosts` table. A shared `resolveOllamaModel(task, host)` helper in `ollama-shared.js` replaces duplicated fallback logic across 6+ provider files. Dashboard gets a dropdown per host card. New `PATCH /api/hosts/:id` endpoint for updates.

**Tech Stack:** Node.js, SQLite, React (dashboard), Vitest

**Spec:** `docs/superpowers/specs/2026-03-22-per-host-default-model-design.md`

**Verify command:** `torque-remote npx vitest run` (NEVER run locally)

---

## File Map

### New
- None (all changes are modifications to existing files)

### Modify
| File | Change |
|------|--------|
| `server/db/schema-tables.js:1843-1856` | Add `default_model TEXT` to base DDL |
| `server/db/schema-migrations.js` | Add migration v9 for ALTER TABLE |
| `server/db/host-management.js:202-204` | Add `'default_model'` to allowedFields |
| `server/providers/ollama-shared.js` | Add `resolveOllamaModel()` helper |
| `server/providers/execution.js:462,496,501` | Use `resolveOllamaModel()` |
| `server/providers/execute-ollama.js:194` | Use `resolveOllamaModel()` |
| `server/providers/execute-hashline.js:495` | Use `resolveOllamaModel()` |
| `server/execution/queue-scheduler.js:553,801` | Use `resolveOllamaModel()` |
| `server/execution/fallback-retry.js:648` | Use `resolveOllamaModel()` |
| `server/execution/strategic-hooks.js:10` | Replace hardcoded DEFAULT_MODEL |
| `server/db/host-complexity.js:198-200` | Replace hardcoded tier fallbacks |
| `server/db/smart-routing.js:826` | Replace hardcoded `qwen3-coder:30b` |
| `server/handlers/integration/routing.js:619,802` | Replace hardcoded model |
| `server/handlers/integration/index.js:907` | Replace hardcoded model |
| `server/orchestrator/strategic-brain.js:25` | Replace DEFAULT_MODELS.ollama |
| `server/providers/ollama-strategic.js:28` | Replace hardcoded defaultModel |
| `server/handlers/provider-ollama-hosts.js` | Add default_model to MCP tools |
| `server/dashboard/routes/infrastructure.js` | Add PATCH /hosts/:id endpoint |
| `server/api/v2-infrastructure-handlers.js` | Add PATCH handler for v2 |
| `dashboard/src/api.js:211-221` | Add `hosts.update()` method |
| `dashboard/src/views/Hosts.jsx` | Add model dropdown to host cards |

---

### Task 1: Database — Migration + Schema + Host Management

**Files:**
- Modify: `server/db/schema-tables.js:1843-1856`
- Modify: `server/db/schema-migrations.js`
- Modify: `server/db/host-management.js:202-204`
- Test: `server/tests/schema-migrations.test.js`
- Test: `server/tests/host-management.test.js`

- [ ] **Step 1: Write failing test for migration**

```js
// In schema-migrations.test.js, add:
test('migration v9 adds default_model to ollama_hosts', () => {
  const cols = db.pragma('table_info(ollama_hosts)').map(c => c.name);
  expect(cols).toContain('default_model');
});
```

- [ ] **Step 2: Write failing test for host management**

```js
// In host-management.test.js, add:
test('updateOllamaHost accepts default_model', () => {
  hostManagement.updateOllamaHost(hostId, { default_model: 'qwen3-coder:30b' });
  const host = hostManagement.getOllamaHost(hostId);
  expect(host.default_model).toBe('qwen3-coder:30b');
});

test('updateOllamaHost clears default_model with null', () => {
  hostManagement.updateOllamaHost(hostId, { default_model: null });
  const host = hostManagement.getOllamaHost(hostId);
  expect(host.default_model).toBeNull();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `torque-remote npx vitest run server/tests/schema-migrations.test.js server/tests/host-management.test.js -t "default_model"`
Expected: FAIL

- [ ] **Step 4: Add migration v9 to schema-migrations.js**

```js
// Add after the last migration entry:
{
  version: 9,
  name: 'add_host_default_model',
  statements: [
    "ALTER TABLE ollama_hosts ADD COLUMN default_model TEXT",
  ]
}
```

- [ ] **Step 5: Update base DDL in schema-tables.js**

At line 1855 (before `created_at TEXT NOT NULL`), add:

```sql
default_model TEXT,
```

- [ ] **Step 6: Add `'default_model'` to allowedFields in host-management.js**

At line 202-204, add `'default_model'` to the allowedFields array:

```js
const allowedFields = ['name', 'url', 'enabled', 'status', 'consecutive_failures',
  'last_health_check', 'last_healthy', 'running_tasks', 'models_cache', 'models_updated_at',
  'memory_limit_mb', 'max_concurrent', 'priority', 'settings', 'gpu_metrics_port', 'vram_factor', 'default_model'];
```

- [ ] **Step 7: Run tests**

Run: `torque-remote npx vitest run server/tests/schema-migrations.test.js server/tests/host-management.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/db/schema-tables.js server/db/schema-migrations.js server/db/host-management.js server/tests/schema-migrations.test.js server/tests/host-management.test.js
git commit -m "feat(db): add default_model column to ollama_hosts"
```

---

### Task 2: Shared Helper — resolveOllamaModel()

**Files:**
- Modify: `server/providers/ollama-shared.js`
- Test: `server/tests/ollama-shared.test.js`

- [ ] **Step 1: Write failing tests for resolveOllamaModel**

```js
// In ollama-shared.test.js, add describe block:
describe('resolveOllamaModel', () => {
  test('returns task.model when set', () => {
    expect(resolveOllamaModel({ model: 'custom:7b' }, null)).toBe('custom:7b');
  });

  test('returns host.default_model when task has no model', () => {
    expect(resolveOllamaModel({}, { default_model: 'qwen3-coder:30b' })).toBe('qwen3-coder:30b');
  });

  test('falls back to global config when no host default', () => {
    // Mock serverConfig.get('ollama_model') to return 'global-model'
    expect(resolveOllamaModel({}, null)).toBe('global-model');
  });

  test('falls back to first cached model when no config', () => {
    expect(resolveOllamaModel({}, { models: [{ name: 'cached:7b' }] })).toBe('cached:7b');
  });

  test('returns null when nothing available', () => {
    expect(resolveOllamaModel({}, null)).toBeNull();
  });

  test('handles null task and host', () => {
    expect(resolveOllamaModel(null, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `torque-remote npx vitest run server/tests/ollama-shared.test.js -t "resolveOllamaModel"`
Expected: FAIL

- [ ] **Step 3: Implement resolveOllamaModel in ollama-shared.js**

Add after the existing imports/init section:

```js
const serverConfig = require('../config');

/**
 * Resolve the Ollama model for a task, checking (in order):
 * 1. task.model (explicit)
 * 2. host.default_model (per-host setting)
 * 3. serverConfig 'ollama_model' (global config)
 * 4. First model in host's models cache (dynamic fallback)
 *
 * @param {object|null} task - Task object (needs .model)
 * @param {object|null} host - Host object (needs .default_model, .models)
 * @returns {string|null} Model name or null if nothing available
 */
function resolveOllamaModel(task, host) {
  if (task?.model) return task.model;
  if (host?.default_model) return host.default_model;
  const globalDefault = serverConfig.get('ollama_model');
  if (globalDefault) return globalDefault;
  if (host?.models?.length) {
    const first = host.models[0];
    return typeof first === 'string' ? first : first?.name || null;
  }
  return null;
}
```

Export it in `module.exports`.

- [ ] **Step 4: Run tests**

Run: `torque-remote npx vitest run server/tests/ollama-shared.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/providers/ollama-shared.js server/tests/ollama-shared.test.js
git commit -m "feat: add resolveOllamaModel() shared helper"
```

---

### Task 3: Replace Hardcoded Models in Provider Files

**Files:**
- Modify: `server/providers/execution.js:462,496,501`
- Modify: `server/providers/execute-ollama.js:194`
- Modify: `server/providers/execute-hashline.js:495`
- Modify: `server/execution/queue-scheduler.js:553,801`
- Modify: `server/execution/fallback-retry.js:648`
- Modify: `server/constants.js:162`

- [ ] **Step 1: Import resolveOllamaModel in each provider file**

In each file, add near the top:
```js
const { resolveOllamaModel } = require('./ollama-shared'); // or '../providers/ollama-shared' depending on relative path
```

- [ ] **Step 2: Replace model resolution in execution.js**

Line 462: Replace `task.model || serverConfig.get('ollama_model') || ''` with `resolveOllamaModel(task, null) || ''`

Line 496: Replace `serverConfig.get('ollama_model') || ''` with `resolveOllamaModel(task, null) || ''`

Line 501: Replace `resolvedModel = 'qwen3-coder:30b'` with `resolvedModel = resolveOllamaModel(null, null) || 'qwen3-coder:30b'` (keep ultimate fallback for safety)

- [ ] **Step 3: Replace model resolution in execute-ollama.js**

Line 194: Replace `serverConfig.get('ollama_model') || ''` with `resolveOllamaModel(task, null) || ''`

Note: Host context isn't available yet at this point. The host gets selected later via `selectOllamaHostForModel`. The helper still helps by checking global config and cached models.

- [ ] **Step 4: Replace model resolution in execute-hashline.js**

Line 495: Same pattern as execute-ollama.js.

- [ ] **Step 5: Replace model resolution in queue-scheduler.js**

Line 801: Replace `serverConfig.get('ollama_model') || 'qwen2.5-coder:32b'` with `resolveOllamaModel(task, null) || DEFAULT_FALLBACK_MODEL`

Line 553: Replace `serverConfig.get(\`ollama_${tierName}_model\`) || 'qwen2.5-coder:32b'` with `serverConfig.get(\`ollama_${tierName}_model\`) || resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL` (tier-specific config takes priority)

- [ ] **Step 6: Replace model resolution in fallback-retry.js**

Line 648: Replace `task.model || serverConfig.get('ollama_model') || DEFAULT_FALLBACK_MODEL` with `resolveOllamaModel(task, null) || DEFAULT_FALLBACK_MODEL`

- [ ] **Step 7: Run affected tests**

Run: `torque-remote npx vitest run server/tests/execute-cli.test.js server/tests/queue-scheduler.test.js server/tests/fallback-retry.test.js server/tests/ollama-shared.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/providers/execution.js server/providers/execute-ollama.js server/providers/execute-hashline.js server/execution/queue-scheduler.js server/execution/fallback-retry.js
git commit -m "refactor: replace hardcoded model fallbacks with resolveOllamaModel()"
```

---

### Task 4: Replace Hardcoded Models in Remaining Runtime Files

**Files:**
- Modify: `server/execution/strategic-hooks.js:10`
- Modify: `server/db/host-complexity.js:198-200`
- Modify: `server/db/smart-routing.js:826`
- Modify: `server/handlers/integration/routing.js:619,802`
- Modify: `server/handlers/integration/index.js:907`
- Modify: `server/orchestrator/strategic-brain.js:25`
- Modify: `server/providers/ollama-strategic.js:28`

- [ ] **Step 1: Replace in strategic-hooks.js**

Line 10: Replace `const DEFAULT_MODEL = 'qwen2.5-coder:32b'` with:
```js
const { resolveOllamaModel } = require('../providers/ollama-shared');
const { DEFAULT_FALLBACK_MODEL } = require('../constants');
```
Then at usage sites, replace `DEFAULT_MODEL` with `resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL`.

- [ ] **Step 2: Replace in host-complexity.js**

Lines 198-200: Replace the three hardcoded fallbacks:
```js
const { resolveOllamaModel } = require('../providers/ollama-shared');
const fallback = resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL;
const fastModel = getConfig('ollama_fast_model') || fallback;
const balancedModel = getConfig('ollama_balanced_model') || fallback;
const qualityModel = getConfig('ollama_quality_model') || fallback;
```

- [ ] **Step 3: Replace in smart-routing.js**

Line 826: Replace `'qwen3-coder:30b'` with:
```js
const { resolveOllamaModel } = require('../providers/ollama-shared');
// ... at usage:
const ollamaModel = task.model || resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL;
```

- [ ] **Step 4: Replace in integration/routing.js**

Lines 619, 802: Replace `'qwen2.5-coder:32b'` with `resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL`

- [ ] **Step 5: Replace in integration/index.js**

Line 907: Replace `model || 'qwen2.5-coder:32b'` with `model || resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL`

- [ ] **Step 6: Replace in strategic-brain.js**

Line 25: Replace `ollama: 'qwen2.5-coder:32b'` in DEFAULT_MODELS with a dynamic getter or import from resolveOllamaModel.

- [ ] **Step 7: Replace in ollama-strategic.js**

Line 28: Replace `config.defaultModel || 'qwen2.5-coder:32b'` with `config.defaultModel || resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL`

- [ ] **Step 8: Run tests**

Run: `torque-remote npx vitest run`
Expected: PASS (full suite minus known DI failures)

- [ ] **Step 9: Commit**

```bash
git add server/execution/strategic-hooks.js server/db/host-complexity.js server/db/smart-routing.js server/handlers/integration/routing.js server/handlers/integration/index.js server/orchestrator/strategic-brain.js server/providers/ollama-strategic.js
git commit -m "refactor: replace all remaining hardcoded model names with resolveOllamaModel()"
```

---

### Task 5: REST API — PATCH /hosts/:id Endpoint

**Files:**
- Modify: `server/dashboard/routes/infrastructure.js`
- Modify: `server/api/v2-infrastructure-handlers.js`
- Test: `server/tests/api-server.test.js` (or appropriate API test file)

- [ ] **Step 1: Add PATCH route to dashboard/routes/infrastructure.js**

Find the existing `router.delete('/:id', ...)` for host removal and add before it:

```js
router.patch('/:id', (req, res) => {
  const hostId = req.params.id;
  const updates = {};
  if (req.body.default_model !== undefined) updates.default_model = req.body.default_model;
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  hostManagement.updateOllamaHost(hostId, updates);
  const host = hostManagement.getOllamaHost(hostId);
  res.json({ success: true, host });
});
```

- [ ] **Step 2: Add PATCH handler to v2-infrastructure-handlers.js**

Add a `handleUpdateHost` function following the same pattern as the dashboard route.

- [ ] **Step 3: Register routes**

Ensure the PATCH route is registered in the router files.

- [ ] **Step 4: Write API test**

```js
test('PATCH /api/hosts/:id sets default_model', async () => {
  const res = await request.patch(`/api/hosts/${hostId}`)
    .send({ default_model: 'qwen3-coder:30b' });
  expect(res.status).toBe(200);
  expect(res.body.host.default_model).toBe('qwen3-coder:30b');
});
```

- [ ] **Step 5: Run tests**

Run: `torque-remote npx vitest run server/tests/api-server.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/dashboard/routes/infrastructure.js server/api/v2-infrastructure-handlers.js server/tests/
git commit -m "feat(api): add PATCH /hosts/:id endpoint for default_model"
```

---

### Task 6: MCP Tools — Add default_model to Host Management

**Files:**
- Modify: `server/handlers/provider-ollama-hosts.js`

- [ ] **Step 1: Add default_model to handleAddOllamaHost**

In the function that handles `add_ollama_host`, accept an optional `default_model` parameter and pass it through to the host creation.

- [ ] **Step 2: Add default_model to handleSetHostSettings**

In `handleSetHostSettings`, check for `args.default_model` and call `updateOllamaHost(hostId, { default_model: args.default_model })`.

- [ ] **Step 3: Commit**

```bash
git add server/handlers/provider-ollama-hosts.js
git commit -m "feat(mcp): add default_model to host management tools"
```

---

### Task 7: Dashboard — Model Dropdown on Host Cards

**Files:**
- Modify: `dashboard/src/api.js:211-221`
- Modify: `dashboard/src/views/Hosts.jsx`

- [ ] **Step 1: Add hosts.update() to api.js**

In `dashboard/src/api.js`, add to the `hosts` object at line 220 (before the closing `}`):

```js
update: (id, data) => requestV2(`/hosts/${id}`, {
  method: 'PATCH',
  body: JSON.stringify(data),
}),
```

- [ ] **Step 2: Add DefaultModelDropdown component to Hosts.jsx**

Create an inline component that renders a `<select>` dropdown populated from the host's models list:

```jsx
function DefaultModelDropdown({ host, onUpdate }) {
  const models = safeParseJson(host.models_cache || host.models, []);
  const modelNames = models.map(m => typeof m === 'string' ? m : m.name).filter(Boolean);
  const [value, setValue] = useState(host.default_model || '');

  const handleChange = async (e) => {
    const newModel = e.target.value || null;
    setValue(e.target.value);
    await hostsApi.update(host.id, { default_model: newModel });
    onUpdate?.();
  };

  if (modelNames.length === 0) return null;

  return (
    <div className="mt-2">
      <label className="text-xs text-slate-400 block mb-1">Default Model</label>
      <select
        value={value}
        onChange={handleChange}
        className="w-full bg-slate-700 text-slate-200 text-xs rounded px-2 py-1 border border-slate-600"
      >
        <option value="">None (use global default)</option>
        {modelNames.map(name => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 3: Add the dropdown to the host card JSX**

Find where models are rendered in the host card (around the `models.slice(0, 8).map` block) and add `<DefaultModelDropdown>` below it:

```jsx
<DefaultModelDropdown host={host} onUpdate={refetchHosts} />
```

- [ ] **Step 4: Verify build**

Run: `torque-remote npm run build --prefix dashboard`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/api.js dashboard/src/views/Hosts.jsx
git commit -m "feat(dashboard): add per-host default model dropdown on Hosts page"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Grep for remaining hardcoded model names**

```bash
grep -rn "qwen2\.5-coder:32b" server/ --include="*.js" | grep -v test | grep -v benchmark | grep -v node_modules
```

Should only return `constants.js` (DEFAULT_FALLBACK_MODEL) and comments/docs.

- [ ] **Step 2: Run full test suite**

Run: `torque-remote npx vitest run`
Expected: PASS

- [ ] **Step 3: Integration test — restart TORQUE and submit task**

Restart TORQUE, set a host's default_model via the new PATCH endpoint, submit a task without a model, verify it uses the host's default.

- [ ] **Step 4: Commit any stragglers**

---

## Execution Notes

- **Task 1 must go first** (DB column needed by everything else)
- **Task 2 must come before Tasks 3-4** (helper needed by replacements)
- **Tasks 3 and 4 can run sequentially** (both replace hardcoded models but in different file groups)
- **Task 5 must come before Task 7** (API endpoint needed by dashboard)
- **Task 6 is independent** of Tasks 5 and 7
- **Task 7 depends on Task 5** (needs the PATCH endpoint)
- **Task 8 is last** (verification)
- **Another session may be committing** — check `git status` before each task
- **Test files** referencing `'qwen2.5-coder:32b'` in fixtures may need updating if they assert on model names — handle as they break
