# Routing Templates — Design Spec

**Date:** 2026-03-17
**Status:** Draft (post-review revision 1)
**Scope:** User-configurable routing templates that replace hardcoded provider-selection logic in `analyzeTaskForRouting()`. Dashboard UI on the renamed "Strategy" page. MCP tools for full LLM parity.

## Problem

TORQUE's task-to-provider routing is a ~500-line hardcoded if/else chain in `provider-routing-core.js`. Security tasks always go to Anthropic, docs always go to Groq, reasoning always goes to DeepInfra, etc. Users cannot customize these mappings without modifying server source code. A user who wants all reasoning tasks on their local Ollama or all code generation on Codex has no way to express that preference.

## Goals

1. Users define routing strategies as named templates — mapping task categories to providers
2. TORQUE ships with built-in presets covering common strategies (cost-saving, quality-first, all-local, cloud-sprint)
3. Users can create, save, duplicate, and delete custom templates
4. Optional per-complexity overrides within any category for power users
5. Dashboard UI as a new "Routing Templates" tab on the renamed "Strategy" page
6. Full MCP tool parity so LLMs can manage templates programmatically
7. System-level concerns (economy mode, health checks, fallbacks) remain system-managed
8. Zero behavior change for existing users until they opt in

## Non-Goals

- Per-project template selection (requires Project Catalogue spec — backlogged)
- User-defined categories or custom classification rules (categories are a fixed server-side enum)
- Visual flowchart editor with drag-and-drop nodes (the UI is a mapping table, not a graph editor)
- Modifying the task classification logic (regex patterns stay as-is)
- Replacing economy mode, health checks, or fallback chains (those remain system-managed layers)

## Related Specs

- **Strategic Brain Customization** (2026-03-17) — customizable decompose/diagnose/review on the same Strategy page. Separate concern from routing templates; both live as tabs. **Implementation ordering note:** This spec owns the Strategic → Strategy rename. If the Brain spec is implemented first, it should use the old name; this spec's rename step will catch it. If this spec goes first, the Brain spec should reference `Strategy.jsx`.
- **Dynamic Model & Provider Management** (2026-03-17) — model registry and provider CRUD. Routing templates reference providers; the model registry determines which models are available on those providers. **Shared migration target:** Both specs modify `server/db/schema-migrations.js` and `server/db/schema-seeds.js`. Migrations are order-independent (different tables), but implementers should be aware of merge conflicts in these files.
- **Economy Mode** (2026-03-16) — economy filtering runs before template lookup. Templates only operate within the provider set that economy allows. Economy mode "subsumes `preferFree`" per the economy spec — see Execution Flow for how `preferFree` interacts with templates.
- **Project Catalogue** (backlogged) — once landed, enables per-project template selection. Data model supports this via nullable `project_path` on active selection.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Customization scope | Category → provider mapping only | Users control where tasks go, not how they're classified. Prevents locked states from bad regex. |
| Category source | Fixed server-side enum | Classification logic is complex regex — exposing it to users creates footguns. New categories added in future versions get sensible defaults automatically. |
| Complexity axis | Optional per-category overrides | Primary view is 9 simple rows. Power users expand individual rows for complexity-specific routing. Avoids a 27-cell grid. |
| Template storage | DB table for user templates, JSON files for presets | Consistent with TORQUE's config patterns. Dashboard CRUD without filesystem concerns. |
| Active selection scope | Global (single active template for the instance) | Per-project requires the Project Catalogue spec. Data model supports future per-project via nullable project_path. |
| Presets | Read-only, user duplicates to customize | Prevents "I broke the default and can't get back." |
| No template active | Falls back to System Default preset | Zero behavior change on fresh install or template deletion. |
| Explicit provider override | Skips template entirely | User intent is sovereign — same principle as today. |
| Economy mode interaction | Economy filters run first, templates operate within filtered pool | Economy constraints take precedence over user routing preferences. |

---

## Task Categories

Categories are defined by the server's classification logic (existing regex patterns extracted into `category-classifier.js`). The set is fixed; users map them to providers but cannot add/remove categories.

| Category Key | Display Name | Detection Summary |
|-------------|-------------|-------------------|
| `security` | Security | auth, encrypt, vulnerability, injection, OWASP keywords |
| `xaml_wpf` | XAML / WPF | .xaml files, WPF/UWP/MAUI/Avalonia keywords |
| `architectural` | Architectural | architect, refactor, redesign, system design keywords |
| `reasoning` | Reasoning | analyze, debug complex, root cause, deep analysis keywords |
| `large_code_gen` | Large Code Gen | implement system, build feature, create module keywords |
| `documentation` | Documentation | document, explain, summarize, readme, jsdoc keywords |
| `simple_generation` | Simple Generation | commit message, boilerplate, scaffold, template keywords |
| `targeted_file_edit` | Targeted File Edits | file reference + edit-type verb patterns |
| `default` | Default (catch-all) | Everything that doesn't match above categories |

Classification priority follows the same order as the current if/else chain: first match wins. A task matching both "security" and "documentation" patterns is classified as "security."

---

## Routing Template Data Model

```json
{
  "name": "My Custom Routes",
  "description": "Cost-optimized with cloud for complex work",
  "preset": false,
  "rules": {
    "security": "anthropic",
    "xaml_wpf": "anthropic",
    "architectural": "deepinfra",
    "reasoning": "deepinfra",
    "large_code_gen": "codex",
    "documentation": "groq",
    "simple_generation": "ollama",
    "targeted_file_edit": "hashline-ollama",
    "default": "ollama"
  },
  "complexity_overrides": {
    "reasoning": {
      "simple": "ollama",
      "normal": "deepinfra",
      "complex": "codex"
    }
  }
}
```

### Rules

Every category key must have an entry in `rules`. The `default` key is mandatory and acts as the catch-all. Provider values must reference known provider IDs from `provider_config`.

### Complexity Overrides

Optional. Keys are category names; values are objects mapping complexity levels (`simple`, `normal`, `complex`) to provider IDs. When a category has a complexity override, the override is checked first. Missing complexity levels within an override fall back to the category's base rule.

Resolution order for a task classified as `reasoning` with complexity `simple`:
1. `complexity_overrides.reasoning.simple` → if present, use it
2. `rules.reasoning` → base mapping
3. `rules.default` → catch-all

### DB Schema

```sql
CREATE TABLE routing_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  rules_json TEXT NOT NULL,
  complexity_overrides_json TEXT,
  preset INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

- `id` is a UUID generated at creation time. Both `id` and `name` exist because `name` is user-facing and editable, while `id` is the stable reference used by `active_routing_template` in the config table. Renaming a template doesn't break the active selection.
- `preset=1` rows are seeded on migration and cannot be modified/deleted via API
- `rules_json` stores the `rules` object
- `complexity_overrides_json` stores the `complexity_overrides` object (nullable — most templates won't use it)

### Active Template Selection

Stored in `config` table:
- Key: `active_routing_template`
- Value: template ID (or null for System Default)

Future per-project support: add `active_routing_template` key to `project_tuning.settings_json`. Resolution: project → global → System Default.

---

## Built-in Presets

| Preset | Key Mappings | Complexity Overrides |
|--------|-------------|---------------------|
| **System Default** | security→anthropic, xaml_wpf→anthropic, architectural→deepinfra, reasoning→deepinfra, large_code_gen→codex, documentation→groq, simple_generation→ollama, targeted_file_edit→hashline-ollama, default→ollama | None (mirrors current hardcoded behavior) |
| **Cost Saver** | security→anthropic, everything else→ollama | large_code_gen: complex→codex (only complex code gen leaves local) |
| **Quality First** | reasoning→codex, large_code_gen→codex, architectural→codex, documentation→deepinfra, default→deepinfra | targeted_file_edit: simple→hashline-ollama (local precision for small edits) |
| **All Local** | Every category→ollama, except targeted_file_edit→hashline-ollama | None |
| **Cloud Sprint** | reasoning→codex, large_code_gen→codex, architectural→codex, security→anthropic, documentation→groq, targeted_file_edit→hashline-ollama, default→codex | None (everything cloud except local-optimal edits) |

Presets are stored as JSON files in `server/routing/templates/` and seeded into the DB on migration. Read-only — users duplicate to customize.

---

## Execution Flow

How the active routing template integrates into `analyzeTaskForRouting()`:

```
analyzeTaskForRouting(taskDescription, workingDirectory, files, options)
  │
  ├─ 1. Economy mode filter (system-managed, unchanged)
  │     └─ If economy active + non-exempt → filter to economy pool, return
  │
  ├─ 2. Explicit user provider override?
  │     └─ If options.provider set by user → skip template, use directly
  │
  ├─ 3. preferFree filter (system-managed, unchanged)
  │     └─ If preferFree → restrict to free providers, return
  │     (Note: runs after explicit override so user intent wins.
  │      Economy mode subsumes preferFree per the economy spec —
  │      when economy is active, preferFree is redundant.)
  │
  ├─ 4. Classify task → category
  │     └─ categoryClassifier.classify(taskDescription, files) → 'security' | 'reasoning' | ...
  │
  ├─ 5. Determine complexity
  │     └─ determineTaskComplexity(taskDescription, files) → 'simple' | 'normal' | 'complex'
  │
  ├─ 6. Look up active routing template
  │     └─ templateStore.getActiveTemplate() → template object (or System Default)
  │
  ├─ 7. Resolve provider from template
  │     ├─ Check complexity_overrides[category][complexity]
  │     ├─ Fall back to rules[category]
  │     └─ Fall back to rules.default
  │
  ├─ 8. Validate provider is available
  │     ├─ Provider enabled? Has credentials?
  │     ├─ If not → fall through to rules.default provider
  │     └─ If rules.default also unavailable → fall through to getDefaultProvider()
  │
  └─ 9. Health check / Ollama fallback (system-managed, unchanged)
        └─ If Ollama provider selected but unhealthy → apply ollamaFallbackProvider
```

**When no template is active** (null in config), step 6 returns the System Default preset — identical to today's hardcoded behavior.

**Provider validation** (step 8): If the template maps a category to a provider that's disabled or missing credentials, TORQUE falls through to the `rules.default` provider. If `rules.default` is also unavailable, falls through to `getDefaultProvider()` (the system-level fallback). A validation warning is shown in the dashboard and logged server-side.

### Interaction with Existing Routing Systems

**Legacy `routing_rules` table:** The current code has a fallback path (lines 525-570 of `provider-routing-core.js`) that checks a `routing_rules` DB table for keyword/extension pattern matches. This legacy system is **replaced** by routing templates. The `routing_rules` table is not deleted (backward compatibility), but `analyzeTaskForRouting()` no longer queries it when a routing template is active. If no template is active, the System Default preset produces identical routing to the current hardcoded logic, making the legacy table redundant.

**Complexity-based host routing:** The current code uses `hostManagementFns.routeTask(complexity)` (lines 477-522) to route tasks to specific hosts based on complexity. This system selects both a provider AND a host within that provider. With routing templates, the **template selects the provider** and the **host routing selects the host within that provider**. Specifically: after step 7 resolves a provider, if that provider is an Ollama variant, the existing host routing logic picks the least-loaded host with the requested model. The template does not replace host selection — only provider selection.

**Hashline-ollama upgrade:** The current code upgrades `ollama`/`aider-ollama` to `hashline-ollama` for targeted file edits (lines 502-514). With routing templates, this upgrade is **no longer needed** — the user explicitly maps `targeted_file_edit` to `hashline-ollama` (or whatever they prefer) in their template. The System Default preset maps it to `hashline-ollama` to preserve current behavior.

---

## Dashboard UI

### Rename: Strategic → Strategy

- Nav item in `Layout.jsx`: "Strategic" → "Strategy"
- Route in `App.jsx`: `/strategic` → `/strategy`
- Redirect from `/strategic` → `/strategy` for bookmarks
- Page component: `Strategic.jsx` → `Strategy.jsx`
- `ROUTE_NAMES` map updated

### Routing Templates Tab

The current Strategic page has a flat layout: stat cards, config panel, fallback chain visualization, provider health grid, then a bottom tabbed section with "Decision History" and "Strategic Operations" tabs. There is no top-level tab system.

**This spec adds a top-level tab system** to the renamed Strategy page, restructuring the existing content into tabs:

| Tab | Content |
|-----|---------|
| **Overview** | Existing content: stat cards, config panel, fallback chain, provider health grid |
| **Decisions** | Existing "Decision History" content (moved from bottom tabs) |
| **Operations** | Existing "Strategic Operations" content (moved from bottom tabs) |
| **Routing Templates** | New — the routing template editor (this spec) |
| **Configuration** | Future — Strategic Brain customization (from the Brain spec) |

This restructuring reduces the page's vertical scroll and creates a clean home for both routing templates and the future Brain configuration tab.

**Layout (top to bottom):**

1. **Template selector bar** — dropdown showing all templates (presets labeled), with New / Duplicate / Save / Delete buttons
2. **Category → Provider mapping table** — one row per category, provider dropdown per row, expand arrow for complexity overrides
3. **Validation banner** — amber warnings when mapped providers are disabled/unhealthy

**Table columns:**
- Category (name + keyword hints)
- Provider (dropdown of enabled providers, colored dot for identity)
- Expand (arrow to toggle complexity overrides)

**Expanded complexity overrides** — nested sub-table within the row showing simple/normal/complex → provider dropdowns. Only visible when expanded.

**Validation rules (client-side):**
- Warn if any mapped provider is disabled
- Warn if any mapped provider has no credentials configured
- Warn if any mapped provider is unhealthy (via existing provider health data)
- `default` row cannot be removed

**Template CRUD:**
- **New** — creates blank template with all categories mapped to `ollama`
- **Duplicate** — copies current template (including presets) as a new user template
- **Save** — persists changes to current user template
- **Delete** — removes user template (not presets), switches to System Default if it was active

---

## API Endpoints

### REST (Dashboard)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/routing/templates` | GET | List all templates (presets + user-created) |
| `GET /api/routing/templates/:id` | GET | Get a specific template |
| `POST /api/routing/templates` | POST | Create new user template |
| `PUT /api/routing/templates/:id` | PUT | Update user template (rejects presets) |
| `DELETE /api/routing/templates/:id` | DELETE | Delete user template (rejects presets) |
| `GET /api/routing/active` | GET | Get active template with resolved mappings |
| `PUT /api/routing/active` | PUT | Set active template `{ template_id }` |
| `GET /api/routing/categories` | GET | List categories with display names, descriptions, keywords |

### MCP Tools

| Tool | Purpose |
|------|---------|
| `list_routing_templates` | List all templates (presets + user-created) |
| `get_routing_template` | Get template by ID or name |
| `set_routing_template` | Create or update a user template (upsert by name) |
| `delete_routing_template` | Delete a user template |
| `activate_routing_template` | Set active template by ID or name |
| `get_active_routing` | Get current active routing config with resolved category mappings |
| `list_routing_categories` | List available categories with descriptions and keywords |

All 7 tools provide full parity with the REST API. `get_active_routing` is particularly useful for LLM sessions — call before submitting batches to understand current routing strategy.

**Preset protection on MCP tools:** `set_routing_template` and `delete_routing_template` reject operations on preset templates (same guard as REST). Calling `set_routing_template` with a name that matches a preset returns an error: `"Cannot modify preset template 'System Default'. Duplicate it first."` The upsert-by-name behavior only applies to user-created templates.

---

## REST Error Responses

All REST endpoints return JSON. Error format:

```json
{ "error": "Human-readable message", "code": "MACHINE_CODE" }
```

| Scenario | Status | Code |
|----------|--------|------|
| Template not found | 404 | `TEMPLATE_NOT_FOUND` |
| Modify/delete a preset | 403 | `PRESET_PROTECTED` |
| Validation failure (missing default, bad provider) | 400 | `VALIDATION_ERROR` |
| Duplicate template name | 409 | `NAME_CONFLICT` |

---

## Validation

### Template Validation (on save/create)

- `name` must be non-empty, unique, max 100 characters
- `rules` must be an object with all category keys present
- `rules.default` is mandatory
- All provider values must be strings matching known provider IDs
- `complexity_overrides` (if present) must only reference valid category keys
- Complexity level keys must be `simple`, `normal`, or `complex`
- Unknown keys in `rules` or `complexity_overrides` are ignored (forward compatibility)

### Runtime Validation (during routing)

- If active template references a provider that no longer exists → fall through to `rules.default`
- If `rules.default` provider is unavailable → fall through to system default provider (`getDefaultProvider()`)
- Log warnings for template-to-unavailable-provider mappings (once per provider, not per task)

---

## Testing Strategy

### Unit Tests (~15)

- `categoryClassifier.classify()` — all 9 categories with representative task descriptions
- `categoryClassifier.classify()` — priority order (security+docs task → security wins)
- Template resolution — base rules, complexity overrides, missing overrides fall to base
- Template resolution — missing category falls to default
- Template validation — rejects missing default, unknown providers, empty name
- Template CRUD — create, read, update, delete, list, preset protection
- Active template — set, get, null falls to System Default
- Provider availability fallthrough — disabled provider falls to default

### Integration Tests (~10)

- `analyzeTaskForRouting()` with active template — routes security task per template
- `analyzeTaskForRouting()` with complexity override — simple reasoning → ollama, complex → codex
- `analyzeTaskForRouting()` with economy mode active — economy overrides template
- `analyzeTaskForRouting()` with explicit provider — template skipped
- `analyzeTaskForRouting()` with no active template — System Default behavior
- MCP tool round-trip — create template → activate → get_active_routing → verify
- REST round-trip — CRUD via API, verify routing changes
- Preset protection — cannot modify/delete preset via API

### Dashboard Tests (~3)

- Template selector shows presets and user templates
- Category table renders all categories with dropdowns
- Save creates/updates template via API

---

## Files to Create

| File | Purpose |
|------|---------|
| `server/routing/templates/system-default.json` | System Default preset |
| `server/routing/templates/cost-saver.json` | Cost Saver preset |
| `server/routing/templates/quality-first.json` | Quality First preset |
| `server/routing/templates/all-local.json` | All Local preset |
| `server/routing/templates/cloud-sprint.json` | Cloud Sprint preset |
| `server/routing/template-store.js` | Template CRUD, preset loading, active resolution, validation |
| `server/routing/category-classifier.js` | Extracted task classification logic (regex patterns). API: `classify(taskDescription, files) → string` returns a single category key (first match wins, same priority as current if/else chain). Returns `'default'` when no patterns match. |
| `server/handlers/routing-template-handlers.js` | REST + MCP tool handlers |
| `server/tool-defs/routing-template-defs.js` | MCP tool definitions (7 tools) |
| `server/tests/routing-templates.test.js` | Unit tests |
| `server/tests/routing-templates-integration.test.js` | Integration tests |
| `dashboard/src/views/RoutingTemplates.jsx` | Routing Templates tab component |
| `dashboard/src/views/RoutingTemplates.test.jsx` | Dashboard tests |

## Files to Modify

| File | Change |
|------|--------|
| `server/db/provider-routing-core.js` | Refactor `analyzeTaskForRouting()` — extract classification to `category-classifier.js`, replace hardcoded if/else with template lookup |
| `server/db/schema-migrations.js` | Create `routing_templates` table |
| `server/db/schema-seeds.js` | Seed preset templates from JSON files |
| `server/tools.js` | Register routing template handler module |
| `server/api/routes.js` | Add `/api/routing/*` route definitions (pattern: route defs here, dispatch in v2-dispatch) |
| `server/api/v2-dispatch.js` | Add dispatch cases for `/api/routing/*` routes to routing-template-handlers |
| `dashboard/src/views/Strategic.jsx` | Rename to Strategy.jsx, restructure into top-level tab system, add Routing Templates tab |
| `dashboard/src/components/Layout.jsx` | Rename nav item Strategic → Strategy, update route |
| `dashboard/src/App.jsx` | Rename route `/strategic` → `/strategy`, add redirect, update import |
| `dashboard/src/api.js` | Add routing template API client functions |
| `dashboard/e2e/strategic.spec.js` | Update for renamed route (create file if it doesn't exist yet — may be created by the Strategic Brain spec first) |

---

## Success Criteria

1. User selects "Cost Saver" preset — all non-security tasks route to Ollama
2. User creates custom template mapping reasoning→codex — reasoning tasks go to Codex
3. User expands reasoning row, sets simple→ollama, complex→codex — routing respects complexity
4. User deletes custom template — falls back to System Default, routing matches current behavior
5. Economy mode active — economy constraints override template mappings
6. Explicit `provider: "codex"` on task submission — template skipped, Codex used directly
7. Template maps to disabled provider — validation warning in dashboard, runtime falls to default
8. LLM calls `get_active_routing` — receives complete routing config for informed task submission
9. Fresh TORQUE install with no template selected — routing identical to current hardcoded behavior
