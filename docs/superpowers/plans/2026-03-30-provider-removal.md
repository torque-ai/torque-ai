# Provider Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove hashline-ollama, hashline-openai, aider-ollama providers and the entire hashline format system from the codebase.

**Architecture:** Systematic removal in dependency order — delete dedicated files first, then strip references from provider lists, routing, validation, dashboard, docs, and tests. DB migration removes provider rows and stale config keys. Final grep verification ensures zero remaining references.

**Tech Stack:** Node.js, SQLite, Vitest, React (dashboard)

---

## File Structure

### Files to DELETE entirely
| File | Reason |
|------|--------|
| `server/providers/execute-hashline.js` | Hashline execution engine |
| `server/utils/hashline-parser.js` | Hashline format parser |
| `server/tests/hashline-fuzzy-fallback.test.js` | Hashline-only test |
| `server/tests/hashline-fuzzy-repair.test.js` | Hashline-only test |
| `server/tests/hashline-handlers.test.js` | Hashline-only test |
| `server/tests/hashline-lite.test.js` | Hashline-only test |
| `server/tests/hashline-local-fallback.test.js` | Hashline-only test |
| `server/tests/hashline-ollama.test.js` | Hashline-only test |
| `server/tests/hashline-parser.test.js` | Hashline-only test |
| `server/tests/hashline-verify.test.js` | Hashline-only test |
| `server/tests/e2e-hashline-ollama.test.js` | Hashline e2e test |
| `server/tests/execute-hashline.test.js` | Hashline executor test |

### Files to MODIFY (remove references)

**Tool definition schemas** (remove from provider enum arrays):
- `server/tool-defs/advanced-defs.js`
- `server/tool-defs/automation-defs.js`
- `server/tool-defs/experiment-defs.js`
- `server/tool-defs/integration-defs.js`
- `server/tool-defs/provider-defs.js`
- `server/tool-defs/task-submission-defs.js`
- `server/tool-defs/validation-defs.js`
- `server/tool-defs/workflow-defs.js`

**Provider infrastructure** (remove entries/branches):
- `server/providers/registry.js`
- `server/providers/adapter-registry.js`
- `server/providers/agentic-capability.js`
- `server/providers/v2-local-providers.js`
- `server/api/v2-provider-registry.js`

**Routing/scheduling** (remove from chains, templates, scheduling):
- `server/db/provider-routing-core.js` (fallback chains implied)
- `server/db/smart-routing.js`
- `server/db/provider-capabilities.js`
- `server/db/schema-seeds.js`
- `server/db/schema-migrations.js`
- `server/db/migrations.js`
- `server/db/host-management.js`
- `server/db/task-core.js`
- `server/db/file-quality.js`
- `server/execution/fallback-retry.js`
- `server/execution/queue-scheduler.js`
- `server/execution/slot-pull-scheduler.js`
- `server/execution/task-startup.js`

**Handlers** (remove from validation lists, provider checks):
- `server/handlers/automation-handlers.js`
- `server/handlers/diffusion-handlers.js`
- `server/handlers/experiment-handlers.js`
- `server/handlers/advanced/coordination.js`
- `server/handlers/integration/infra.js`
- `server/handlers/integration/routing.js`
- `server/handlers/provider-ollama-hosts.js`
- `server/handlers/provider-tuning.js`

**Validation** (remove provider-specific branches):
- `server/validation/auto-verify-retry.js`
- `server/validation/close-phases.js`
- `server/validation/completion-detection.js`
- `server/validation/output-safeguards.js`
- `server/validation/preflight-types.js`

**Other server** (remove references):
- `server/constants.js`
- `server/config.js`
- `server/task-manager.js`
- `server/discovery/discovery-engine.js`
- `server/maintenance/orphan-cleanup.js`
- `server/policy-engine/profile-loader.js`
- `server/utils/context-enrichment.js`
- `server/utils/host-monitoring.js`
- `server/workstation/routing.js`
- `server/dashboard/dashboard.js`

**Routing templates** (JSON):
- `server/routing/templates/all-local.json`
- `server/routing/templates/cloud-sprint.json`
- `server/routing/templates/cost-saver.json`
- `server/routing/templates/free-agentic.json`
- `server/routing/templates/free-speed.json`
- `server/routing/templates/quality-first.json`
- `server/routing/templates/system-default.json`

**Dashboard React**:
- `dashboard/src/components/TaskDetailDrawer.jsx`
- `dashboard/src/components/TaskSubmitForm.jsx`
- `dashboard/src/views/History.jsx`
- `dashboard/src/views/Kanban.jsx`
- `dashboard/src/views/Providers.jsx`
- `dashboard/src/views/RoutingTemplates.jsx`
- `dashboard/src/views/Schedules.jsx`
- `dashboard/src/views/Strategy.jsx`

**Documentation**:
- `CLAUDE.md`
- `docs/architecture.md`
- `.claude/commands/torque-templates.md`

---

### Task 1: Delete hashline files and dedicated tests

**Files:**
- Delete: `server/providers/execute-hashline.js`
- Delete: `server/utils/hashline-parser.js`
- Delete: `server/tests/hashline-fuzzy-fallback.test.js`
- Delete: `server/tests/hashline-fuzzy-repair.test.js`
- Delete: `server/tests/hashline-handlers.test.js`
- Delete: `server/tests/hashline-lite.test.js`
- Delete: `server/tests/hashline-local-fallback.test.js`
- Delete: `server/tests/hashline-ollama.test.js`
- Delete: `server/tests/hashline-parser.test.js`
- Delete: `server/tests/hashline-verify.test.js`
- Delete: `server/tests/e2e-hashline-ollama.test.js`
- Delete: `server/tests/execute-hashline.test.js`

- [ ] **Step 1: Delete all hashline files**

```bash
git rm server/providers/execute-hashline.js server/utils/hashline-parser.js
git rm server/tests/hashline-fuzzy-fallback.test.js server/tests/hashline-fuzzy-repair.test.js
git rm server/tests/hashline-handlers.test.js server/tests/hashline-lite.test.js
git rm server/tests/hashline-local-fallback.test.js server/tests/hashline-ollama.test.js
git rm server/tests/hashline-parser.test.js server/tests/hashline-verify.test.js
git rm server/tests/e2e-hashline-ollama.test.js server/tests/execute-hashline.test.js
```

- [ ] **Step 2: Remove require/import references to deleted files**

Search all `.js` files in `server/` for `require` statements referencing the deleted modules and remove them:
- `require('./execute-hashline')` or `require('../providers/execute-hashline')`
- `require('./hashline-parser')` or `require('../utils/hashline-parser')`

Files likely affected: `server/providers/adapter-registry.js`, `server/providers/registry.js`, `server/task-manager.js`, `server/validation/close-phases.js`. Search for `hashline-parser` and `execute-hashline` in require statements and remove the lines.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "remove: delete hashline provider/parser files and dedicated tests"
```

---

### Task 2: Remove providers from all tool definition schemas

**Files:**
- Modify: `server/tool-defs/advanced-defs.js`
- Modify: `server/tool-defs/automation-defs.js`
- Modify: `server/tool-defs/experiment-defs.js`
- Modify: `server/tool-defs/integration-defs.js`
- Modify: `server/tool-defs/provider-defs.js`
- Modify: `server/tool-defs/task-submission-defs.js`
- Modify: `server/tool-defs/validation-defs.js`
- Modify: `server/tool-defs/workflow-defs.js`

- [ ] **Step 1: Remove from provider enum arrays**

In each file, search for `enum` arrays that list valid providers. These look like:
```js
enum: ['codex', 'claude-cli', 'ollama', 'ollama-cloud', 'hashline-ollama', ...]
```
or valid-provider arrays like:
```js
const validProviders = ['codex', 'claude-cli', 'ollama', 'hashline-ollama', ...];
```

Remove `'hashline-ollama'`, `'hashline-openai'`, and `'aider-ollama'` from every such array in all 8 files.

Also in `server/handlers/automation-handlers.js`, search for the `validProviders` array inside `handleSetProjectDefaults` and remove the three entries.

- [ ] **Step 2: Remove hashline_read and hashline_edit tool definitions**

In the tool-defs files, search for tool definitions with `name: 'hashline_read'` and `name: 'hashline_edit'`. Remove the entire tool definition objects (the `{ name: ..., description: ..., inputSchema: ... }` blocks).

- [ ] **Step 3: Commit**

```bash
git add server/tool-defs/ server/handlers/automation-handlers.js && git commit -m "remove: strip hashline/aider providers from all tool schemas and handler validation"
```

---

### Task 3: Remove from provider infrastructure

**Files:**
- Modify: `server/providers/registry.js`
- Modify: `server/providers/adapter-registry.js`
- Modify: `server/providers/agentic-capability.js`
- Modify: `server/providers/v2-local-providers.js`
- Modify: `server/api/v2-provider-registry.js`
- Modify: `server/db/provider-capabilities.js`

- [ ] **Step 1: Clean provider registry**

In `server/providers/registry.js`: remove any entries for `hashline-ollama`, `hashline-openai`, `aider-ollama` from the provider registry object/map.

In `server/providers/adapter-registry.js`: remove adapter registrations for the three providers. Also remove any `require('./execute-hashline')` that wasn't caught in Task 1.

In `server/providers/agentic-capability.js`: remove the three providers from any capability lists or provider checks.

In `server/providers/v2-local-providers.js`: remove entries for the three providers from local provider definitions.

In `server/api/v2-provider-registry.js`: remove entries from the PROVIDER_REGISTRY object for the three providers.

In `server/db/provider-capabilities.js`: remove capability entries for the three providers.

- [ ] **Step 2: Commit**

```bash
git add server/providers/ server/api/v2-provider-registry.js server/db/provider-capabilities.js && git commit -m "remove: strip hashline/aider from provider registry, adapters, and capabilities"
```

---

### Task 4: Remove from routing, fallback chains, and scheduling

**Files:**
- Modify: `server/db/smart-routing.js`
- Modify: `server/db/schema-seeds.js`
- Modify: `server/db/schema-migrations.js`
- Modify: `server/db/migrations.js`
- Modify: `server/db/host-management.js`
- Modify: `server/db/task-core.js`
- Modify: `server/db/file-quality.js`
- Modify: `server/execution/fallback-retry.js`
- Modify: `server/execution/queue-scheduler.js`
- Modify: `server/execution/slot-pull-scheduler.js`
- Modify: `server/execution/task-startup.js`

- [ ] **Step 1: Remove from smart routing**

In `server/db/smart-routing.js`: remove the three providers from routing rules, category-to-provider maps, and any default fallback chains.

- [ ] **Step 2: Remove from schema seeds**

In `server/db/schema-seeds.js`: remove the `insertProvider.run(...)` calls for `hashline-ollama`, `hashline-openai`, and `aider-ollama`. Also remove from the `providerTypes` object and `PROVIDER_CAPABILITIES` object.

- [ ] **Step 3: Remove from schema migrations**

In `server/db/schema-migrations.js` and `server/db/migrations.js`: remove any migration steps that reference the three providers. If a migration ADDS these providers, remove it. If a migration modifies them, remove the modification. Leave migrations that reference them in DELETE or cleanup operations.

- [ ] **Step 4: Remove from execution files**

In `server/execution/fallback-retry.js`: remove the three providers from fallback chain arrays.

In `server/execution/queue-scheduler.js`: remove from provider lists and scheduling logic.

In `server/execution/slot-pull-scheduler.js`: remove from provider slot tracking.

In `server/execution/task-startup.js`: remove from provider-specific startup branches.

In `server/db/host-management.js`: remove from host-to-provider mapping logic.

In `server/db/task-core.js`: remove from provider validation lists.

In `server/db/file-quality.js`: remove from provider-specific quality checks (e.g., `provider === 'ollama' || provider === 'hashline-ollama'` becomes `provider === 'ollama'`).

- [ ] **Step 5: Commit**

```bash
git add server/db/ server/execution/ && git commit -m "remove: strip hashline/aider from routing, seeds, migrations, scheduling, and fallback chains"
```

---

### Task 5: Remove from routing template JSON files

**Files:**
- Modify: `server/routing/templates/all-local.json`
- Modify: `server/routing/templates/cloud-sprint.json`
- Modify: `server/routing/templates/cost-saver.json`
- Modify: `server/routing/templates/free-agentic.json`
- Modify: `server/routing/templates/free-speed.json`
- Modify: `server/routing/templates/quality-first.json`
- Modify: `server/routing/templates/system-default.json`

- [ ] **Step 1: Remove from all template JSON files**

In each JSON file, search for `hashline-ollama`, `hashline-openai`, and `aider-ollama` in the provider arrays within the routing rules. Remove them. These appear in arrays like `["ollama", "hashline-ollama", "codex"]` — just remove the entry and keep the rest.

- [ ] **Step 2: Commit**

```bash
git add server/routing/templates/ && git commit -m "remove: strip hashline/aider from all routing template JSON files"
```

---

### Task 6: Remove from validation, handlers, and other server modules

**Files:**
- Modify: `server/validation/auto-verify-retry.js`
- Modify: `server/validation/close-phases.js`
- Modify: `server/validation/completion-detection.js`
- Modify: `server/validation/output-safeguards.js`
- Modify: `server/validation/preflight-types.js`
- Modify: `server/handlers/diffusion-handlers.js`
- Modify: `server/handlers/experiment-handlers.js`
- Modify: `server/handlers/advanced/coordination.js`
- Modify: `server/handlers/integration/infra.js`
- Modify: `server/handlers/integration/routing.js`
- Modify: `server/handlers/provider-ollama-hosts.js`
- Modify: `server/handlers/provider-tuning.js`
- Modify: `server/constants.js`
- Modify: `server/config.js`
- Modify: `server/task-manager.js`
- Modify: `server/discovery/discovery-engine.js`
- Modify: `server/maintenance/orphan-cleanup.js`
- Modify: `server/policy-engine/profile-loader.js`
- Modify: `server/utils/context-enrichment.js`
- Modify: `server/utils/host-monitoring.js`
- Modify: `server/workstation/routing.js`
- Modify: `server/dashboard/dashboard.js`

- [ ] **Step 1: Remove from validation files**

In each validation file, search for `hashline-ollama`, `hashline-openai`, `aider-ollama`, `hashline`, and `aider`. Remove:
- Provider-specific conditional branches (`if (provider === 'hashline-ollama')`)
- Entries in provider arrays
- Hashline-specific logic (hashline verification, hashline format detection)

In `server/validation/close-phases.js`: remove any hashline verification phase or hashline-specific output processing.

In `server/validation/output-safeguards.js`: remove the hashline verification section and the `_verifyHashlineReferences` dependency from init.

- [ ] **Step 2: Remove from handler files**

In each handler file, remove the three providers from provider arrays, validation checks, and conditional branches.

- [ ] **Step 3: Remove from other server modules**

In `server/constants.js`: remove hashline-related constants.

In `server/config.js`: remove hashline config key mappings if any exist.

In `server/task-manager.js`: remove hashline/aider require statements and any provider-specific wiring.

In `server/discovery/discovery-engine.js`: remove hashline-ollama from host-to-provider discovery mapping.

In `server/maintenance/orphan-cleanup.js`: remove from provider lists.

In `server/policy-engine/profile-loader.js`: remove from default policy profiles.

In `server/utils/context-enrichment.js`: remove hashline-specific context logic.

In `server/utils/host-monitoring.js`: remove hashline-specific monitoring.

In `server/workstation/routing.js`: remove from provider routing.

In `server/dashboard/dashboard.js`: remove from server-side dashboard provider lists.

- [ ] **Step 4: Commit**

```bash
git add server/ && git commit -m "remove: strip hashline/aider from validation, handlers, constants, discovery, and all remaining server modules"
```

---

### Task 7: Remove from dashboard React components

**Files:**
- Modify: `dashboard/src/components/TaskDetailDrawer.jsx`
- Modify: `dashboard/src/components/TaskSubmitForm.jsx`
- Modify: `dashboard/src/views/History.jsx`
- Modify: `dashboard/src/views/Kanban.jsx`
- Modify: `dashboard/src/views/Providers.jsx`
- Modify: `dashboard/src/views/RoutingTemplates.jsx`
- Modify: `dashboard/src/views/Schedules.jsx`
- Modify: `dashboard/src/views/Strategy.jsx`

- [ ] **Step 1: Remove from provider arrays and UI lists**

In each file, search for `hashline-ollama`, `hashline-openai`, `aider-ollama`, and `hashline` in:
- Provider dropdown option arrays
- Provider color/icon maps
- Provider filter lists
- Conditional rendering for specific providers

Remove the entries. The dashboard should show 11 providers instead of 14.

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/ && git commit -m "remove: strip hashline/aider from dashboard provider lists, dropdowns, and views"
```

---

### Task 8: Database migration

**Files:**
- Modify: `server/db/migrations.js`

- [ ] **Step 1: Add migration to remove providers and stale config**

Add a new migration at the end of the migrations array in `server/db/migrations.js`:

```js
{
  id: 'remove-hashline-aider-providers',
  description: 'Remove hashline-ollama, hashline-openai, aider-ollama providers and hashline config keys',
  up: (db) => {
    // Remove provider rows
    db.prepare("DELETE FROM provider_config WHERE provider IN ('hashline-ollama', 'hashline-openai', 'aider-ollama')").run();

    // Remove hashline config keys
    const hashlineKeys = [
      'hashline_capable_models',
      'hashline_format_auto_select',
      'hashline_model_formats',
      'hashline_lite_min_samples',
      'hashline_lite_threshold',
      'max_hashline_local_retries',
    ];
    const deleteConfig = db.prepare('DELETE FROM config WHERE key = ?');
    for (const key of hashlineKeys) {
      deleteConfig.run(key);
    }

    // Fix smart_routing_default_provider if it references a removed provider
    const defaultProvider = db.prepare("SELECT value FROM config WHERE key = 'smart_routing_default_provider'").get();
    if (defaultProvider && ['hashline-ollama', 'hashline-openai', 'aider-ollama'].includes(defaultProvider.value)) {
      db.prepare("UPDATE config SET value = 'ollama' WHERE key = 'smart_routing_default_provider'").run();
    }

    // Remove provider_task_stats for removed providers
    try {
      db.prepare("DELETE FROM provider_task_stats WHERE provider IN ('hashline-ollama', 'hashline-openai', 'aider-ollama')").run();
    } catch { /* table may not exist */ }

    // Remove from routing templates stored in DB (if any)
    try {
      const templates = db.prepare('SELECT id, rules FROM routing_templates').all();
      const updateTemplate = db.prepare('UPDATE routing_templates SET rules = ? WHERE id = ?');
      for (const t of templates) {
        try {
          const rules = JSON.parse(t.rules);
          let changed = false;
          for (const [category, chain] of Object.entries(rules)) {
            if (Array.isArray(chain)) {
              const filtered = chain.filter(p => !['hashline-ollama', 'hashline-openai', 'aider-ollama'].includes(p));
              if (filtered.length !== chain.length) {
                rules[category] = filtered;
                changed = true;
              }
            }
          }
          if (changed) {
            updateTemplate.run(JSON.stringify(rules), t.id);
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* table may not exist */ }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/db/migrations.js && git commit -m "migration: remove hashline/aider providers, config keys, and routing template entries"
```

---

### Task 9: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`
- Modify: `.claude/commands/torque-templates.md`

- [ ] **Step 1: Update CLAUDE.md**

Remove all references to `hashline-ollama`, `hashline-openai`, `aider-ollama` from:
- Provider tables
- Routing template examples
- Hashline-related instructions (hashline_read, hashline_edit tools)
- Edit discipline section referencing hashline tools

- [ ] **Step 2: Update docs/architecture.md**

Remove the three providers from architecture documentation, provider diagrams, and any hashline format descriptions.

- [ ] **Step 3: Update .claude/commands/torque-templates.md**

Remove the three providers from template examples in slash command documentation.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/architecture.md .claude/commands/torque-templates.md && git commit -m "docs: remove hashline/aider references from CLAUDE.md, architecture, and commands"
```

NOTE: Do NOT modify files in `docs/superpowers/plans/` or `docs/superpowers/specs/` — those are historical records.

---

### Task 10: Update test files

**Files:**
- Modify: ~80 test files in `server/tests/` that reference the removed providers
- Delete: test files listed in Task 1 (already handled)

- [ ] **Step 1: Update test fixture provider lists**

In every test file that references `hashline-ollama`, `hashline-openai`, or `aider-ollama`:
- Remove from mock provider arrays and fixture data
- Remove test cases specific to these providers
- Update expected counts (e.g., if a test expects 14 providers, change to 11)
- Update fallback chain test expectations

The pattern is consistent: search for the three provider strings and remove them from arrays, objects, and assertions. If an entire `describe` or `it` block tests exclusively a removed provider, delete the block.

Also update `server/tests/test-helpers.js` and `server/tests/test-providers.js` — these are shared fixtures used by many tests.

Also update dashboard test files:
- `dashboard/src/components/TaskSubmitForm.test.jsx`
- `dashboard/src/views/RoutingTemplates.test.jsx`
- `dashboard/src/views/Strategy.test.jsx`

- [ ] **Step 2: Commit**

```bash
git add server/tests/ dashboard/src/ && git commit -m "test: remove hashline/aider from all test fixtures, mocks, and assertions"
```

---

### Task 11: Final verification

- [ ] **Step 1: Grep verification — zero remaining references**

```bash
grep -r "hashline-ollama\|hashline-openai\|aider-ollama" server/ dashboard/ --include="*.js" --include="*.jsx" --include="*.json" | grep -v node_modules | grep -v "docs/superpowers"
```

Expected: zero matches (only historical docs/superpowers files may match).

- [ ] **Step 2: Grep for orphaned hashline references**

```bash
grep -r "hashline_read\|hashline_edit\|execute-hashline\|hashline-parser\|hashline_capable\|hashline_format\|hashline_lite\|hashline_model_formats\|max_hashline" server/ dashboard/ --include="*.js" --include="*.jsx" | grep -v node_modules | grep -v "docs/superpowers"
```

Expected: zero matches.

- [ ] **Step 3: Server starts clean**

```bash
node server/index.js
```

Verify: server starts without `MODULE_NOT_FOUND` errors for deleted files.

- [ ] **Step 4: Run test suite**

```bash
cd server && npx vitest run
```

Expected: all tests pass. Some test files may fail if they imported deleted modules — fix any remaining references.

- [ ] **Step 5: Verify provider count**

After starting the server, call `list_providers`. Expected: 11 providers (was 14).

- [ ] **Step 6: Final commit**

```bash
git add -A && git commit -m "verify: provider removal complete — 11 providers, zero hashline/aider references"
```
