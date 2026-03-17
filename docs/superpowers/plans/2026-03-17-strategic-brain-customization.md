# Strategic Brain Customization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Strategic Brain's decompose/diagnose/review capabilities configurable per project — custom steps, criteria, patterns, prompts, and domain templates — with a Configuration tab on the Strategy dashboard page.

**Architecture:** New config-loader module handles three-layer merge (project → user → default). StrategicBrain constructed per-call with merged config. Prompt templates and deterministic fallbacks read from config instead of hardcoded values. Dashboard adds a Configuration tab with card grid + drawer editor. 4 new MCP tools + 6 REST endpoints.

**Tech Stack:** Node.js (CommonJS), React + Tailwind (Vite), Vitest, filesystem-based config (JSON)

**Spec:** `docs/superpowers/specs/2026-03-17-strategic-brain-customization-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/orchestrator/default-config.json` | Default config (ships with TORQUE) — the "base layer" |
| `server/orchestrator/templates/default.json` | Built-in template: standard decomposition |
| `server/orchestrator/templates/game-dev.json` | Built-in template: game dev workflow |
| `server/orchestrator/templates/web-api.json` | Built-in template: REST API workflow |
| `server/orchestrator/templates/frontend.json` | Built-in template: frontend workflow |
| `server/orchestrator/templates/cli-tool.json` | Built-in template: CLI tool workflow |
| `server/orchestrator/templates/library.json` | Built-in template: library workflow |
| `server/orchestrator/config-loader.js` | Three-layer config merge, validation, template resolution |
| `server/handlers/strategic-config-handlers.js` | MCP tool handlers + REST handlers for config CRUD |
| `server/tool-defs/strategic-config-defs.js` | 4 new MCP tool definitions |
| `server/tests/strategic-config-loader.test.js` | Unit tests for config loading and merge |
| `server/tests/strategic-config-handlers.test.js` | Integration tests for config CRUD |
| `dashboard/src/views/StrategicConfig.jsx` | Configuration tab component (card grid + drawer) |

---

### Task 1: Default Config + Templates

**Files:**
- Create: `server/orchestrator/default-config.json`
- Create: `server/orchestrator/templates/default.json`
- Create: `server/orchestrator/templates/game-dev.json`
- Create: `server/orchestrator/templates/web-api.json`
- Create: `server/orchestrator/templates/frontend.json`
- Create: `server/orchestrator/templates/cli-tool.json`
- Create: `server/orchestrator/templates/library.json`

- [ ] **Step 1: Create default-config.json**

This is the base config that ships with TORQUE. All fields must be present:

```json
{
  "template": "default",
  "decompose": {
    "steps": ["types", "data", "events", "system", "tests", "wire"],
    "project_context": "",
    "coding_standards": "",
    "provider_hints": {},
    "step_descriptions": {},
    "custom_prompt": null
  },
  "diagnose": {
    "recovery_actions": ["retry", "fix_task", "switch_provider", "switch_model", "redesign", "escalate"],
    "custom_patterns": [],
    "escalation_threshold": 3,
    "custom_prompt": null
  },
  "review": {
    "criteria": [
      "No stub implementations or TODO comments",
      "All files compile without errors",
      "No unused imports or dead code"
    ],
    "auto_approve_threshold": 85,
    "strict_mode": false,
    "custom_prompt": null
  },
  "provider": null,
  "model": null,
  "confidence_threshold": 0.4,
  "temperature": 0.3
}
```

- [ ] **Step 2: Create 6 template files**

Each template includes `decompose`, `diagnose`, `review` sections plus `test_samples`. Create in `server/orchestrator/templates/`:

**default.json:** Same as default-config values. Test samples: feature_name "UserProfile", error "Module not found", task_output "Added 3 files, all tests pass."

**game-dev.json:** Steps: types→data→events→system→tests→wire. Review criteria: "Systems wired into GameScene", "Events registered in EventSystem". Context: "Game project using ECS pattern."

**web-api.json:** Steps: schema→models→routes→middleware→tests→docs. Review criteria: "Endpoints documented", "Auth middleware applied", "Input validation present". Step descriptions for each step.

**frontend.json:** Steps: types→components→hooks→pages→tests→styles. Review criteria: "Components accessible (aria labels)", "Responsive layout", "No inline styles".

**cli-tool.json:** Steps: types→commands→parsers→output→tests→docs. Review criteria: "Help text for all commands", "Non-zero exit code on error", "Stderr for errors".

**library.json:** Steps: types→core→utils→tests→docs→exports. Review criteria: "Clean public exports", "No breaking changes", "JSDoc on public API".

- [ ] **Step 3: Commit**

```bash
git add server/orchestrator/default-config.json server/orchestrator/templates/
git commit -m "feat: add Strategic Brain default config and 6 domain templates"
```

---

### Task 2: Config Loader — Tests + Implementation

**Files:**
- Create: `server/orchestrator/config-loader.js`
- Create: `server/tests/strategic-config-loader.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/strategic-config-loader.test.js`. Tests:

- `loadDefaultConfig()` returns a valid config with all required fields
- `loadTemplate(name)` loads a built-in template by name
- `listTemplates()` returns all 6 built-in templates
- `mergeConfig(project, user, defaults)` — project values override user, user overrides defaults
- `mergeConfig` — arrays are replaced, not concatenated (e.g., custom steps fully replace defaults)
- `mergeConfig` — null values in higher layers don't override lower layers
- `validateConfig(config)` — valid config passes
- `validateConfig` — invalid steps (non-array) fails
- `validateConfig` — invalid threshold (>100) fails
- `validateConfig` — unknown keys are ignored (forward compat)
- `loadProjectConfig(workingDirectory)` — reads `.torque/strategic.json` from dir
- `loadProjectConfig` — returns null for missing file
- `loadProjectConfig` — returns null for invalid JSON (logs warning)
- `loadUserConfig()` — reads `~/.torque/strategic.json`
- `resolveConfig(workingDirectory)` — full three-layer merge

Use `os.tmpdir()` and `fs.mkdirSync`/`fs.writeFileSync` to create temporary config files for the filesystem tests.

- [ ] **Step 2: Implement config-loader.js**

Key functions:

```js
function loadDefaultConfig() // reads default-config.json
function loadTemplate(name) // reads from templates/ dir, returns null if not found
function listTemplates()    // lists all .json files in templates/ + ~/.torque/templates/ + .torque/templates/
function loadProjectConfig(workingDir)  // reads .torque/strategic.json, validates, returns null on failure
function loadUserConfig()               // reads ~/.torque/strategic.json, validates, returns null on failure
function validateConfig(config)         // returns { valid, errors }
function mergeConfig(project, user, defaults) // deep merge with array replacement
function resolveConfig(workingDir)      // full chain: load all three layers + merge
function substituteVariables(template, vars)  // Mustache-style {{var}} substitution
```

The merge function uses a custom deep merge: objects are recursively merged, arrays are **replaced** (not concatenated), null/undefined values in higher layers are skipped.

`validateConfig` checks: steps is string array, recovery_actions is string array, criteria is string array, thresholds are in range, temperature 0-2, custom_prompt is string or null.

- [ ] **Step 3: Run tests**

Run: `cd server && npx vitest run tests/strategic-config-loader.test.js`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add server/orchestrator/config-loader.js server/tests/strategic-config-loader.test.js
git commit -m "feat: add config-loader with three-layer merge, validation, and templates"
```

---

### Task 3: Wire Config Into Strategic Brain

**Files:**
- Modify: `server/orchestrator/strategic-brain.js`
- Modify: `server/orchestrator/prompt-templates.js`
- Modify: `server/orchestrator/deterministic-fallbacks.js`
- Modify: `server/handlers/orchestrator-handlers.js`

- [ ] **Step 1: Update orchestrator-handlers.js**

Change `getBrain()` to accept `workingDirectory` and construct per-call with merged config:

```js
const configLoader = require('../orchestrator/config-loader');

// Module-level usage accumulator (decoupled from instance lifecycle)
const usageByProject = new Map();

function getOrCreateUsage(workingDir) {
  const key = workingDir || '__global__';
  if (!usageByProject.has(key)) {
    usageByProject.set(key, { total_calls: 0, total_tokens: 0, fallback_calls: 0 });
  }
  return usageByProject.get(key);
}

function getBrain(workingDirectory, providerOverride, modelOverride) {
  const resolvedConfig = configLoader.resolveConfig(workingDirectory);

  if (providerOverride) resolvedConfig.provider = providerOverride;
  if (modelOverride) resolvedConfig.model = modelOverride;

  return new StrategicBrain(resolvedConfig);
}
```

Update all handler functions (`handleDecompose`, `handleDiagnose`, `handleReview`) to:
1. Extract `working_directory` from args
2. Pass it to `getBrain(working_directory, ...)`
3. Support new `config_override` parameter (deep merge on top of resolved config)
4. Update usage accumulator after each call

- [ ] **Step 2: Update strategic-brain.js**

Modify the constructor to accept the full config object and store it:

```js
constructor(config = {}) {
  // config now includes decompose, diagnose, review, provider, model, etc.
  this.config = config;
  this.confidenceThreshold = config.confidence_threshold ?? CONFIDENCE_THRESHOLD;
  this.temperature = config.temperature ?? 0.3;
  // ... existing provider resolution logic using config.provider
}
```

Pass `this.config` to `buildPrompt()` and fallback functions.

- [ ] **Step 3: Update prompt-templates.js**

Modify `buildPrompt(capability, vars)` to accept config and use it:

- If `config.decompose.custom_prompt` is set for decompose → use it (substitute variables)
- Otherwise → build from template, injecting `config.decompose.project_context`, `config.decompose.coding_standards`, custom steps list
- Same pattern for diagnose and review custom_prompts
- Add `substituteVariables()` for Mustache-style `{{var}}` replacement

- [ ] **Step 4: Update deterministic-fallbacks.js**

Modify `fallbackDecompose` to accept config:

```js
function fallbackDecompose({ feature_name, working_directory, config }) {
  const steps = config?.decompose?.steps || STANDARD_STEPS;
  const stepDescriptions = config?.decompose?.step_descriptions || {};
  const providerHints = config?.decompose?.provider_hints || {};

  return {
    tasks: steps.map(step => ({
      step,
      description: stepDescriptions[step]
        ? substituteVariables(stepDescriptions[step], { feature_name, working_directory })
        : (STEP_TEMPLATES[step] || genericTemplate)(feature_name, working_directory),
      depends_on: STEP_DEPS[step] || [],
      provider_hint: providerHints[step] || null,
    })),
    source: 'deterministic',
    confidence: 0.6,
  };
}
```

Similar changes for `fallbackDiagnose` (use `config.diagnose.custom_patterns` and `escalation_threshold`) and `fallbackReview` (use `config.review.criteria`, `auto_approve_threshold`, `strict_mode`).

- [ ] **Step 5: Run existing orchestrator tests**

Run: `cd server && npx vitest run tests/orchestrator-handlers.test.js tests/deterministic-fallbacks.test.js tests/prompt-templates.test.js`
Expected: All tests PASS (existing behavior unchanged with default config)

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/strategic-brain.js server/orchestrator/prompt-templates.js server/orchestrator/deterministic-fallbacks.js server/handlers/orchestrator-handlers.js
git commit -m "feat: wire config-loader into Strategic Brain, prompts, and fallbacks"
```

---

### Task 4: MCP Tools + REST Endpoints

**Files:**
- Create: `server/tool-defs/strategic-config-defs.js`
- Create: `server/handlers/strategic-config-handlers.js`
- Modify: `server/tools.js`
- Modify: `server/api/routes.js`
- Modify: `server/api/v2-dispatch.js`

- [ ] **Step 1: Create tool definitions**

Create `server/tool-defs/strategic-config-defs.js` with 4 tools:

- `strategic_config_get` — args: `{ working_directory }`. Returns merged config with `_sources`.
- `strategic_config_set` — args: `{ working_directory, config }`. Writes project-level `.torque/strategic.json`.
- `strategic_config_templates` — args: none. Lists available templates.
- `strategic_config_apply_template` — args: `{ working_directory, template_name }`. Applies template as starting point for project config.

- [ ] **Step 2: Create handlers**

Create `server/handlers/strategic-config-handlers.js`. Follow economy-handlers pattern:

- `handleConfigGet(args)` — resolve config, add `_sources` annotations showing where each value came from
- `handleConfigSet(args)` — validate config, write to `.torque/strategic.json` in the working_directory
- `handleConfigReset(args)` — delete `.torque/strategic.json`, revert to user/default
- `handleConfigTemplates()` — list all templates (built-in + user)
- `handleConfigApplyTemplate(args)` — load template, write as project config

Export `toolDefs`, `toolHandlers`, and named REST functions.

- [ ] **Step 3: Register tools + add routes**

In `server/tools.js`, add `require('./handlers/strategic-config-handlers')` to handler modules.

In `server/api/routes.js`, add 6 routes under `/api/v2/strategic/config*`:
```
GET  /api/v2/strategic/config
PUT  /api/v2/strategic/config
POST /api/v2/strategic/config/reset
GET  /api/v2/strategic/templates
GET  /api/v2/strategic/templates/:name
POST /api/v2/strategic/test/:capability
```

In `server/api/v2-dispatch.js`, add dispatch handlers following the existing pattern (use `throwToolResultError`/`unwrapToolResult`).

- [ ] **Step 4: Commit**

```bash
git add server/tool-defs/strategic-config-defs.js server/handlers/strategic-config-handlers.js server/tools.js server/api/routes.js server/api/v2-dispatch.js
git commit -m "feat: add Strategic Brain config MCP tools and REST endpoints"
```

---

### Task 5: Update Existing MCP Tools with config_override

**Files:**
- Modify: `server/tool-defs/orchestrator-defs.js` (or wherever `strategic_decompose`, `strategic_diagnose`, `strategic_review` are defined)

- [ ] **Step 1: Find and update tool definitions**

Search for where `strategic_decompose`, `strategic_diagnose`, `strategic_review` tool schemas are defined. Add an optional `config_override` parameter to each:

```json
"config_override": {
  "type": "object",
  "description": "Optional partial config to deep-merge on top of the resolved config for this call only. Example: { decompose: { steps: ['schema', 'api', 'tests'] } }"
}
```

- [ ] **Step 2: Commit**

```bash
git add server/tool-defs/orchestrator-defs.js
git commit -m "feat: add config_override parameter to strategic decompose/diagnose/review tools"
```

---

### Task 6: Integration Tests

**Files:**
- Create: `server/tests/strategic-config-handlers.test.js`

- [ ] **Step 1: Write integration tests**

Using `setupTestDb`:

- `strategic_config_get` — returns default config when no project config exists
- `strategic_config_set` — writes project config, subsequent get returns merged values
- `strategic_config_templates` — lists 6+ built-in templates
- `strategic_config_apply_template` — applies web-api template, config shows web-api steps
- `strategic_decompose` with `config_override` — uses override steps for this call only
- `strategic_config_set` then reset — reset clears project config
- Config validation — rejects invalid threshold values
- Three-layer merge — project overrides user overrides default

- [ ] **Step 2: Run tests**

Run: `cd server && npx vitest run tests/strategic-config-handlers.test.js`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add server/tests/strategic-config-handlers.test.js
git commit -m "test: add Strategic Brain configuration integration tests"
```

---

### Task 7: Dashboard — Configuration Tab

**Files:**
- Create: `dashboard/src/views/StrategicConfig.jsx`
- Modify: `dashboard/src/views/Strategy.jsx`
- Modify: `dashboard/src/api.js`

- [ ] **Step 1: Add API client functions**

In `dashboard/src/api.js`, add to the `strategic` export (or create a new `strategicConfig` export):

```js
  getConfig: (opts = {}) => requestV2('/strategic/config', opts),
  setConfig: (data, opts = {}) => requestV2('/strategic/config', { method: 'PUT', body: JSON.stringify(data), ...opts }),
  resetConfig: (opts = {}) => requestV2('/strategic/config/reset', { method: 'POST', ...opts }),
  listConfigTemplates: (opts = {}) => requestV2('/strategic/templates', opts),
  getConfigTemplate: (name, opts = {}) => requestV2(`/strategic/templates/${name}`, opts),
  testCapability: (capability, data, opts = {}) => requestV2(`/strategic/test/${capability}`, { method: 'POST', body: JSON.stringify(data), ...opts }),
```

- [ ] **Step 2: Create StrategicConfig.jsx**

The Configuration tab component. Key features:

**Card grid (top):** Three summary cards for Decompose, Diagnose, Review. Each shows current config summary (step count, criteria count, etc.). Click to open drawer.

**Template selector:** Below cards. Dropdown of all templates + "Apply" button.

**Global settings:** Provider, model, confidence threshold, temperature — inline controls.

**Drawer editor:** Slides in from the right when a card is clicked.
- Two tabs: "Form" and "Advanced"
- Form tab: structured controls per capability (steps pills, criteria list, textareas)
- Advanced tab: monospace textarea for custom_prompt, variable reference sidebar
- Footer: Save, Reset, Test buttons

Follow existing dashboard patterns: `useToast`, Tailwind classes, `glass-card`, `useCallback`.

- [ ] **Step 3: Add Configuration tab to Strategy.jsx**

In `dashboard/src/views/Strategy.jsx`:
1. Import: `import StrategicConfig from './StrategicConfig';`
2. Add to `TOP_TABS`: `{ id: 'config', label: 'Configuration' }`
3. Add render: `{topTab === 'config' && <StrategicConfig />}`

- [ ] **Step 4: Build dashboard**

Run: `cd dashboard && npm run build`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/views/StrategicConfig.jsx dashboard/src/views/Strategy.jsx dashboard/src/api.js
git commit -m "feat: add Configuration tab to Strategy page — card grid, drawer editor, templates"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full server test suite**

Run: `cd server && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run full dashboard test suite**

Run: `cd dashboard && npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Manual smoke test**

1. Restart TORQUE
2. Navigate to Strategy → Configuration tab
3. Verify 3 summary cards render (Decompose, Diagnose, Review)
4. Apply "web-api" template → verify steps change to schema→models→routes→middleware→tests→docs
5. Click Decompose card → drawer opens with form editor
6. Modify steps, click Save
7. Via MCP: `strategic_config_get` → verify saved config
8. Via MCP: `strategic_decompose { feature_name: "Auth" }` → verify custom steps used
9. Click Reset → config reverts to defaults
10. Test button → preview output appears

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete Strategic Brain customization — configurable decompose, diagnose, review"
```
