# Strategic Brain Customization — Design Spec

**Date:** 2026-03-17
**Status:** Draft (post-review revision 1)
**Scope:** Customizable prompts, steps, criteria, and templates for Strategic Brain's decompose/diagnose/review capabilities, with dashboard UI and project-level config.

## Problem

Strategic Brain's three capabilities (decompose, diagnose, review) use hardcoded prompt templates, fixed decomposition steps (types→data→events→system→tests→wire), fixed diagnosis actions, and generic review criteria. Users cannot tailor these to their project's domain, architecture, or coding standards. A game developer and a web API developer get identical decomposition strategies.

## Goals

1. Users customize decomposition steps, diagnosis patterns, and review criteria per project
2. Structured forms for common customizations + raw prompt editing for power users
3. Customizations affect both the LLM path and deterministic fallbacks (consistent behavior regardless of LLM availability)
4. Dashboard UI with card grid overview + drawer editor
5. Preset templates for common domains (game dev, web API, frontend, CLI, library)
6. Three-layer config: project overrides user overrides defaults

## Non-Goals

- Multi-user config (team-level config is a TORQUE Cloud feature, not self-hosted)
- Visual prompt builder / drag-and-drop prompt design
- Per-task config persistence (config applies globally to the capability, not per task)

---

## Configuration Schema

The config is a JSON object that drives both LLM prompts and deterministic fallbacks:

```json
{
  "template": "game-dev",
  "decompose": {
    "steps": ["types", "data", "events", "system", "tests", "wire"],
    "project_context": "TypeScript game project using Phaser 3. Systems follow the ECS pattern. Events go through EventSystem.",
    "coding_standards": "No default exports. Strict TypeScript. Vitest for tests.",
    "provider_hints": {
      "types": "ollama",
      "system": "codex",
      "tests": "codex"
    },
    "custom_prompt": null
  },
  "diagnose": {
    "recovery_actions": ["retry", "fix_task", "switch_provider", "switch_model", "redesign", "escalate"],
    "custom_patterns": [
      { "match": "ENOMEM", "action": "switch_provider", "reason": "OOM on local GPU" }
    ],
    "escalation_threshold": 3,
    "custom_prompt": null
  },
  "review": {
    "criteria": [
      "No stub implementations or TODO comments",
      "All public methods have JSDoc",
      "New systems must be wired into GameScene.ts"
    ],
    "auto_approve_threshold": 85,
    "strict_mode": false,
    "custom_prompt": null
  },
  "provider": "deepinfra",
  "model": "meta-llama/Llama-3.1-405B-Instruct",
  "confidence_threshold": 0.4,
  "temperature": 0.3
}
```

### Three-Layer Merge

| Layer | Location | Scope |
|-------|----------|-------|
| **Default** | `server/orchestrator/default-config.json` | Ships with TORQUE |
| **User** | `~/.torque/strategic.json` | All projects for this user |
| **Project** | `.torque/strategic.json` in project root | This project only |

Merge strategy: deep merge, project → user → default. Arrays are **replaced** (not concatenated) so users can fully redefine steps or criteria.

### Instance Lifecycle

The existing `StrategicBrain` is a module-level singleton in `orchestrator-handlers.js`. With per-project config, this singleton model breaks — different projects need different configs.

**Fix:** Construct a new `StrategicBrain` per call using the merged config for that call's `working_directory`. These objects are lightweight (no persistent state beyond usage counters). The constructor is cheap — it resolves a provider and stores config values.

**Usage tracking** moves out of the `StrategicBrain` instance and into a module-level accumulator (or DB table) keyed by working_directory. The `strategic_usage` tool reads from this accumulator, not from any instance. This decouples usage tracking from instance lifecycle.

```js
// Module-level usage accumulator (in orchestrator-handlers.js)
const usageByProject = new Map();  // working_directory → { total_calls, total_tokens, ... }

function getOrCreateUsage(workingDir) {
  const key = workingDir || '__global__';
  if (!usageByProject.has(key)) usageByProject.set(key, { total_calls: 0, ... });
  return usageByProject.get(key);
}
```

### Custom Prompts

Each capability has a `custom_prompt` field (null by default). When set, it replaces the generated prompt template entirely. Mustache-style variables (`{{feature_name}}`, `{{error_output}}`, etc.) are still substituted. This is the "Advanced" tab in the dashboard.

When `custom_prompt` is null, TORQUE builds the prompt from the structured fields (steps, context, standards, criteria) — this is the "Form" tab.

---

## Preset Templates

Built-in templates provide starting points for common project types:

| Template | Decomposition Steps | Review Focus |
|----------|-------------------|--------------|
| **default** | types → data → system → tests → wire | No stubs, no TODOs |
| **game-dev** | types → data → events → system → tests → wire | Systems wired, events registered |
| **web-api** | schema → models → routes → middleware → tests → docs | Endpoints documented, auth, validation |
| **frontend** | types → components → hooks → pages → tests → styles | Accessible, responsive |
| **cli-tool** | types → commands → parsers → output → tests → docs | Help text, exit codes |
| **library** | types → core → utils → tests → docs → exports | Clean exports, no breaking changes, JSDoc |

### Template Storage

- Built-in: `server/orchestrator/templates/*.json` (6 files)
- User-created: `~/.torque/templates/*.json`
- Project-specific: `.torque/templates/*.json`

### Template Precedence

Templates can exist at three locations. Name collisions are resolved by precedence: project > user > built-in. A user-created `~/.torque/templates/game-dev.json` overrides the built-in `game-dev` template. A project-level `.torque/templates/game-dev.json` overrides both.

### Fallback Step Descriptions

When the deterministic fallback generates task descriptions for custom steps (e.g., "schema", "routes" from web-api template), it uses a generic template: `"Implement the {step} step for {feature_name} in {working_directory}"`. Built-in templates include richer step-level descriptions. Users can optionally add `step_descriptions` to their config:

```json
{
  "decompose": {
    "steps": ["schema", "api", "tests"],
    "step_descriptions": {
      "schema": "Define the database schema and migrations for {{feature_name}}",
      "api": "Implement REST endpoints for {{feature_name}}",
      "tests": "Write integration tests for {{feature_name}} endpoints"
    }
  }
}
```

### Template Selection Flow

1. User picks a template from dashboard dropdown or via `strategic_config_apply_template`
2. Template values populate the config
3. User customizes (add/remove steps, edit context, add criteria)
4. Saves as project config — independent of the template from that point

---

## Dashboard UI

### Card Grid Overview

Three summary cards showing current config state for each capability:

- **Decompose** — step count, active template name
- **Diagnose** — recovery action count, escalation threshold
- **Review** — criteria count, strict mode status

Below the cards: template dropdown selector + global model settings (provider, model, confidence).

### Drawer Editor

Click a card to open a slide-in drawer from the right. Left side (cards) dims. Drawer contains:

**Form tab (default):**

For Decompose:
- Steps — pill tags with remove (×), add (+), drag to reorder
- Provider hints per step — dropdown per step (auto / specific provider)
- Project context — freeform textarea
- Coding standards — freeform textarea
- Model settings — provider, model, confidence dropdowns

For Diagnose:
- Recovery actions — pill tags (add/remove custom actions)
- Custom patterns — list of match/action/reason rules with add/remove
- Escalation threshold — number input

For Review:
- Criteria — list of rules with add/remove/edit
- Auto-approve threshold — slider (0-100)
- Strict mode — toggle

**Advanced tab:**
- Full prompt editor (monospace textarea)
- Variable reference sidebar showing available `{{variables}}`
- "Reset to generated" button (clears custom_prompt, reverts to Form-based generation)

**Footer:**
- Save button — writes to project config
- Reset button — clears project config, reverts to user/default
- Test button — dry-runs the capability with sample input and current config, shows preview output

---

## Config Validation

User-edited JSON files require validation. Invalid config should not crash the server.

**Validation rules:**
- JSON must parse cleanly — syntax errors reject the file with a clear error message
- Unknown keys are **ignored** (forward compatibility — new TORQUE versions may add fields)
- `steps` must be an array of non-empty strings
- `recovery_actions` must be an array of strings from a known set + any custom strings
- `criteria` must be an array of non-empty strings
- `auto_approve_threshold` must be a number 0-100
- `confidence_threshold` must be a number 0-1
- `temperature` must be a number 0-2
- `provider` must be a known strategic provider (`deepinfra`, `hyperbolic`, `ollama`) or null
- `custom_prompt` must be a string or null

**On validation failure:** Reject the invalid layer, log a warning, fall through to the next layer. A broken project config falls back to user + default. A broken user config falls back to default. The server never crashes over a config file.

## Working Directory Resolution

Strategic Brain calls need a `working_directory` to find project config. Resolution chain:

1. If `working_directory` is in the tool call args → use it
2. If `task_id` is provided → look up the task's `working_directory` from the database
3. If neither → use the project default working directory from `get_project_defaults`
4. If none of the above → user + default config only (no project layer)

For the dashboard REST endpoints, `working_directory` comes from the stored project default (the same `project_config` table that `set_project_defaults` writes to). The dashboard does not need to pass `working_directory` explicitly — it reads the active project from the existing project config system.

## Config File Caching

Config files are read fresh on every strategic call. These calls are infrequent (decompose/diagnose/review are not hot-path operations), so filesystem reads are acceptable. No caching, no file watching, no invalidation complexity.

---

## How Config Flows Into Prompts

### LLM Path

```
1. Load config (config-loader merges project → user → default)
2. Select prompt:
   - custom_prompt set → use directly (substitute variables)
   - custom_prompt null → build from template + inject config fields
3. Inject config into template variables:
   - {{project_context}} ← config.decompose.project_context
   - {{coding_standards}} ← config.decompose.coding_standards
   - {{steps}} ← config.decompose.steps.join(', ')
   - {{criteria}} ← config.review.criteria.join('\n')
4. Call LLM (config.provider, config.model, config.temperature)
5. Parse response, check config.confidence_threshold
6. Below threshold → fall through to deterministic path
```

### Deterministic Fallback Path

Uses the same config — no separate configuration needed:

- **Decompose fallback:** Uses `config.decompose.steps` as the ordered step list and `config.decompose.provider_hints` for routing (replaces hardcoded step ordering)
- **Diagnose fallback:** Checks `config.diagnose.custom_patterns` first (user-defined match rules), then built-in patterns. Respects `config.diagnose.escalation_threshold` for retry-to-escalate transition.
- **Review fallback:** Evaluates `config.review.criteria` as a checklist. Scores against `config.review.auto_approve_threshold`. Applies `config.review.strict_mode` (reject on any criteria failure vs. threshold-based).

---

## API Endpoints

### REST (Dashboard)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/strategic/config` | GET | Get merged config with `_sources` showing origin of each value |
| `/api/strategic/config` | PUT | Save project-level config (`.torque/strategic.json`) |
| `/api/strategic/config/reset` | POST | Delete project config, revert to user/default |
| `/api/strategic/templates` | GET | List available templates (built-in + user) |
| `/api/strategic/templates/:name` | GET | Get a specific template |
| `/api/strategic/test/:capability` | POST | Dry-run with current config (see Test Dry-Run below) |

The GET config endpoint returns a `_sources` map showing where each value came from:

```json
{
  "decompose": {
    "steps": ["schema", "models", "routes", "tests"],
    "_sources": {
      "steps": "project:.torque/strategic.json",
      "project_context": "user:~/.torque/strategic.json",
      "coding_standards": "default"
    }
  }
}
```

### MCP Tools

| Tool | Purpose |
|------|---------|
| `strategic_config_get` | Read current merged config |
| `strategic_config_set` | Write project-level config fields |
| `strategic_config_templates` | List available templates |
| `strategic_config_apply_template` | Apply a template as starting point |

Existing tools (`strategic_decompose`, `strategic_diagnose`, `strategic_review`) gain an optional `config_override` parameter — a partial config object that deep-merges on top of the final merged config (default → user → project → config_override). Any field in the config schema can be overridden. Overrides are ephemeral and do not persist.

Example: `strategic_decompose { feature_name: "Auth", config_override: { decompose: { steps: ["schema", "api", "tests"] } } }` uses custom steps for this call only.

---

## Test Dry-Run

The dashboard Test button (`POST /api/strategic/test/:capability`) runs a preview without creating real tasks:

- **Decompose:** User provides a feature name (or uses a canned sample from the template). Returns the generated task list. No tasks created.
- **Diagnose:** Uses a canned error output sample from the template (e.g., "Module not found" for default, "ECONNREFUSED on Ollama host" for game-dev). Returns diagnosis and recommended action.
- **Review:** Uses a canned task output sample. Returns review decision and score.

Each built-in template ships with sample inputs for all three capabilities. User templates can optionally include `test_samples`:

```json
{
  "test_samples": {
    "decompose": { "feature_name": "UserProfile", "feature_description": "CRUD user profiles with avatar upload" },
    "diagnose": { "error_output": "TypeError: Cannot read properties of undefined", "provider": "codex" },
    "review": { "task_output": "Added 3 files, modified 2. All tests pass." }
  }
}
```

## Provider Note

The config-level `provider` field accepts `deepinfra`, `hyperbolic`, or `ollama`. The `ollama` provider is the auto-detected fallback (always available if an Ollama host is reachable). It is a valid explicit choice for users who want to ensure Strategic Brain uses their local GPU rather than a cloud API.

---

## File Changes

### New Files

| File | Purpose |
|------|---------|
| `server/orchestrator/default-config.json` | Default config (ships with TORQUE) |
| `server/orchestrator/templates/*.json` | 6 built-in template files |
| `server/orchestrator/config-loader.js` | Three-layer config merge logic |
| `server/handlers/strategic-config-handlers.js` | REST + MCP handlers for config CRUD |
| `server/tool-defs/strategic-config-defs.js` | Tool definitions for 4 new config tools |
| `dashboard/src/views/StrategicBrain.jsx` | Configuration tab added to the existing `Strategic.jsx` view (which already has provider health, fallback chain, decision history). New tab: "Configuration" alongside existing tabs. |

### Modified Files

| File | Change |
|------|--------|
| `server/orchestrator/strategic-brain.js` | Load config from config-loader, pass to prompts |
| `server/orchestrator/prompt-templates.js` | Accept injected context/standards/steps, support custom_prompt |
| `server/orchestrator/deterministic-fallbacks.js` | Read steps/patterns/criteria from config |
| `server/tools.js` | Register strategic-config handler module |
| `server/dashboard/router.js` | Add `/api/strategic/*` routes |
| `dashboard/src/views/Strategic.jsx` | Add "Configuration" tab alongside existing tabs |

### User Files (not in repo)

| File | Purpose |
|------|---------|
| `~/.torque/strategic.json` | User-level config defaults |
| `~/.torque/templates/*.json` | User-created templates |
| `.torque/strategic.json` | Project-level config |

---

## Success Criteria

1. User applies "web-api" template, customizes steps to `schema → api → middleware → tests`, saves — `strategic_decompose` uses those steps for both LLM and fallback paths
2. User adds custom review criteria via dashboard — `strategic_review` evaluates those criteria
3. User writes a custom diagnosis prompt in Advanced tab — `strategic_diagnose` uses it verbatim
4. Config merges correctly: project overrides user overrides default
5. Dashboard card grid shows current config summary, drawer editor saves changes
6. Test button produces a preview without creating real tasks
7. Deterministic fallbacks use the same custom config as the LLM path
