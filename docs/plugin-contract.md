# Plugin Contract + Lifecycle

> Canonical reference for the TORQUE plugin system: contract surface, loader behavior, integration points, per-plugin lifecycle. If you are about to add a new plugin, change the contract, or modify how the loader resolves plugins at boot, **start here** — the contract has six required + three optional methods, three different factory naming conventions, two distinct loader entry paths, and seven plugins each with their own lifecycle quirks.

---

## The contract

Defined by `server/plugins/plugin-contract.js` and enforced by `validatePlugin(instance)`.

### Required fields (8)

Every plugin must export an object — directly OR via a factory function (see "Factory dispatch" below) — with all of these:

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Stable plugin identifier; logged in `[plugin-loader]` output and used for tool deduplication |
| `version` | string | Free-form version string (no semver enforcement) |
| `install(container)` | function | Wire the plugin into the DI container at boot. Receives `defaultContainer`. |
| `uninstall()` | function | Tear down anything install registered. Rarely called outside tests. |
| `middleware()` | function | Returns Express-style middleware (or null/[]) for HTTP request interception |
| `mcpTools()` | function | Returns array of MCP tool definitions `{ name, description, inputSchema, handler }` |
| `eventHandlers()` | function | Returns object mapping event names to handler functions |
| `configSchema()` | function | Returns JSON-Schema-shaped config description (or null) |

### Optional methods (3)

Validated only when present:

| Method | Type | Purpose |
|--------|------|---------|
| `tierTools()` | function | Returns `{ tier1: string[], tier2: string[] }` — tool names mapped to visibility tiers (Tier 3 = unlock_all_tools-only) |
| `classifierRules` | array | Recovery-engine classifier rules (consumed by auto-recovery engine) |
| `recoveryStrategies` | array | Recovery-engine strategy modules (consumed by auto-recovery engine) |

`classifierRules` / `recoveryStrategies` are special: validated as both "optional method" (must be array) and "optional array field" (must be array). Both checks run, both errors emit if the type is wrong.

---

## The loader

Defined by `server/plugins/loader.js` (`loadPlugins(options)`).

### Inputs

```js
loadPlugins({
  plugins: ['snapscope', 'version-control', ...],  // explicit list
  authMode: 'local' | 'enterprise',                 // legacy auth-mode injection
  pluginDir: __dirname,                             // override for tests
  logger,                                           // optional; falls back to console
});
```

### Resolution sequence

1. **Build candidate list**: `[...plugins]` plus any plugin from `AUTH_MODE_PLUGIN_MAP[authMode]` not already in the list. Currently only `enterprise → 'auth'`.
2. **For each name**: `require(path.resolve(pluginDir, name, 'index.js'))` → `createPluginInstance(mod)` → `validatePlugin(instance)` → push to `loaded` if valid.
3. **Validation failures** are logged at `warn` level and the plugin is silently skipped — startup continues. A typo in `DEFAULT_PLUGIN_NAMES` produces only a warn line; nothing else fails.
4. **Require failures** (file not found, syntax error, throw during module load) are also logged at `warn` and skipped.

### Factory dispatch

`createPluginInstance(mod)` checks for three different factory function names in priority order:

1. `mod.createPlugin()` — the **canonical** convention (auth, codegraph, version-control all alias `createPlugin → createXxxPlugin`)
2. `mod.createSnapScopePlugin()` — historical fallback for snapscope's older shape
3. `mod.createAuthPlugin()` — historical fallback for auth's older shape
4. Otherwise: treat `mod` itself as the plugin instance (rare; only used by direct-export plugins)

**New plugins should always export `createPlugin`.** The other two exist only because snapscope and auth shipped before the convention was settled. Don't rely on the fallback path.

### What the loader does NOT do

- Does NOT call `install()` — that's the caller's responsibility (see "Boot integration" below)
- Does NOT register `mcpTools` — that happens in a separate pass in `server/index.js`
- Does NOT install `middleware` — same
- Does NOT install `eventHandlers` — same
- Does NOT validate `configSchema` against any actual config — it's a documentation surface

The loader's job is purely "load + validate + return the array."

---

## Boot integration (`server/index.js`)

Three distinct passes touch the plugins after `loadPlugins` returns.

### Pass 1 — install (line ~1369)

```js
const { loadPlugins } = require('./plugins/loader');
loadedPlugins = loadPlugins({ plugins: DEFAULT_PLUGIN_NAMES, authMode: runtimeMode, logger });
for (const plugin of loadedPlugins) {
  plugin.install(defaultContainer);
}
```

`DEFAULT_PLUGIN_NAMES` is frozen on `server/index.js:64`:

```js
['snapscope', 'version-control', 'remote-agents', 'model-freshness', 'auto-recovery-core', 'codegraph']
```

`auth` is **not** in this list — it's added by the loader's `AUTH_MODE_PLUGIN_MAP` only when `runtimeMode === 'enterprise'`.

Install failures are caught and logged but don't abort startup. A plugin with a broken `install()` will be loaded (in the `loadedPlugins` array) but its tools/middleware will fire from passes 2 and 3 even though install threw — this is a known sharp edge. See open questions.

### Pass 2 — middleware (line ~1809)

```js
for (const plugin of loadedPlugins) {
  const mw = plugin.middleware();
  if (Array.isArray(mw)) middlewares.push(...mw);
  else if (typeof mw === 'function') middlewares.push(mw);
  // null / undefined → skip
}
```

Throws are caught + logged; the plugin's middleware is silently skipped.

### Pass 3 — mcpTools + tierTools (line ~1909)

```js
const builtInNames = new Set(builtInTools.map(t => t.name));
const pluginTools = [];
const pluginTier1 = [];
const pluginTier2 = [];
for (const plugin of loadedPlugins) {
  const tools = plugin.mcpTools();
  for (const tool of tools) {
    if (builtInNames.has(tool.name)) continue;  // built-ins shadow plugins
    pluginTools.push(toolsModule.decorateToolDefinition(tool));
  }
  if (typeof plugin.tierTools === 'function') {
    const { tier1, tier2 } = plugin.tierTools();
    pluginTier1.push(...tier1);
    pluginTier2.push(...tier2);
  }
}
```

**Tool shadowing is asymmetric**: built-ins always win. A plugin can't redefine `submit_task` even if it tries. The reverse — a plugin tool name colliding with another plugin's tool name — is NOT checked; later loaders win silently.

Tier membership merges into shared arrays:
- `mergedCoreTierNames = [...CORE_TOOL_NAMES, ...pluginTier1]` (Tier 1, default-visible)
- `mergedExtendedTierNames = [...EXTENDED_TOOL_NAMES, ...pluginTier2, ...pluginTier1]` (Tier 2, after `unlock_tier`)
- Tools NOT in any tier list are Tier 3 — only visible after `unlock_all_tools`.

### Pass 4 — eventHandlers (NOT WIRED IN BOOT)

`eventHandlers()` is part of the contract and `validatePlugin` requires it as a function, but **`server/index.js` never calls it during boot**. Plugins that need event subscriptions register them inside `install()` directly via the container's eventBus. The `eventHandlers()` method exists in the contract but is purely documentary today. See open questions.

---

## Per-plugin catalog

Seven plugins ship with TORQUE. Six load by default; one (`auth`) is enterprise-mode-only.

| Plugin | Version | Default? | Env gate | Role | Tier |
|--------|---------|----------|----------|------|------|
| **snapscope** | 1.0.0 | ✓ | none | ~35 `peek_*` / `capture_*` tools — visual verification, window capture, manifest validation, OCR, baselines | tier1 + tier2 |
| **version-control** | 2.0.0 | ✓ | none | ~13 `vc_*` tools — worktree lifecycle, commit/PR generation, changelog, release cutting | (none — Tier 3) |
| **remote-agents** | 1.0.0 | ✓ | none | `register_remote_agent`, `list_remote_agents`, `run_remote_command`, `run_tests`, plus `TestRunnerRegistry` route registration | tier2 |
| **model-freshness** | 1.0.0 | ✓ | none | Periodic scan for new model releases; auto-seed scheduled scans; `model_freshness_*` tools | (none — Tier 3) |
| **auto-recovery-core** | 1.0.0 | ✓ | none | `classifierRules` + `recoveryStrategies` arrays consumed by the factory's auto-recovery engine. **No tools, no middleware** — pure data plugin | n/a |
| **codegraph** | 0.1.0 | ✓ (default-on, opt-out) | `TORQUE_CODEGRAPH_ENABLED=0` to disable | 8 `cg_*` tools for symbol/reference queries (find-references, call-graph, impact-set, dead-symbols, resolve-tool, class-hierarchy) + `cg_index_status` + `cg_reindex` | (none — Tier 3) |
| **auth** | 1.0.0 | ✗ (enterprise only) | `TORQUE_AUTH_MODE=enterprise` to enable | `create_api_key`, `list_api_keys`, `revoke_api_key` + middleware enforcing API-key auth on REST/MCP requests | n/a |

### Notable shapes

- **auto-recovery-core** has empty `install`/`uninstall`/`middleware` (returns null), no `mcpTools`, no `tierTools`. Its entire value is the `classifierRules` + `recoveryStrategies` arrays. Consumers must iterate `loadedPlugins` looking for those properties — there's no central registry.
- **auth** is the only plugin with non-empty middleware; everything else returns `[]` or `null`.
- **codegraph** is in `DEFAULT_PLUGIN_NAMES` but the env-var opt-out is checked **inside** the plugin's factory: when `TORQUE_CODEGRAPH_ENABLED=0`, `createPlugin` returns a no-op stub with empty arrays. The loader still sees a "valid" plugin; the stub just contributes nothing.
- **snapscope** uses the legacy `createSnapScopePlugin` factory naming — the loader's fallback path catches it. New plugins should use `createPlugin` directly.
- **version-control** aliases `module.exports.createVersionControlPlugin = createVersionControlPlugin` AND `module.exports.createPlugin = createVersionControlPlugin`. Both names work; the canonical one is `createPlugin`.

---

## Lifecycle states

A plugin progresses through these states from boot to shutdown:

```
loadPlugins(names)
  ├─ require('plugins/<name>/index.js')
  ├─ createPluginInstance(mod)  → calls one of createPlugin / createSnapScopePlugin / createAuthPlugin
  ├─ validatePlugin(instance)   → all 8 required fields + optional checks
  └─ push to `loaded` array

server/index.js install pass:
  └─ for each loaded: plugin.install(defaultContainer)
     ├─ Wires services into container
     ├─ Subscribes to eventBus events directly
     ├─ Registers routes (TestRunnerRegistry for remote-agents)
     └─ Throws are caught + logged but plugin stays in array

server/index.js middleware pass:
  └─ for each loaded: plugin.middleware()
     └─ Returns Express middleware to be appended to the request chain

server/index.js mcpTools pass:
  └─ for each loaded: plugin.mcpTools() + plugin.tierTools()
     ├─ Tool dedup against built-ins (built-ins win)
     ├─ Plugin tools added to runtime tool def registry
     └─ Tier1/Tier2 names merged into shared tier arrays

(plugin runs for the lifetime of the process — install is once-only)

Shutdown:
  └─ plugin.uninstall() may be called by tests; production rarely invokes
```

---

## Configuration surface

### Env vars

| Var | Plugin | Effect |
|-----|--------|--------|
| `TORQUE_AUTH_MODE` | (loader) | `enterprise` injects `auth` plugin into load list; `local` (default) skips |
| `TORQUE_CODEGRAPH_ENABLED` | codegraph | `0` makes the plugin's `enabled()` gate return false; the loader skips it entirely (no install/middleware/mcpTools registration). See #7 below for the migration story |
| `TORQUE_AUTH_BOOTSTRAP_ADMIN_KEY_NAME` | auth | Override default bootstrap admin key name |

### `configSchema()`

Each plugin's `configSchema()` returns a JSON-schema-shaped object describing its configuration knobs. **No code reads these schemas at runtime today** — they're documentation surface only. They appear in the plugin contract but no validator currently enforces them against actual config values. The intent (per the contract) is for a future config UI to render forms from these schemas; for now they're aspirational.

---

## Test coverage map

| Concern | Test file |
|---------|-----------|
| Plugin contract validation | `server/plugins/loader.test.js` |
| Per-plugin behavior — auth | `server/plugins/auth/tests/` (multiple test files) |
| Per-plugin behavior — codegraph | `server/plugins/codegraph/tests/` |
| Per-plugin behavior — model-freshness | `server/plugins/model-freshness/tests/` |
| auto-recovery-core integration | scattered across `server/tests/auto-recovery-*.test.js`, `tests/recovery-*.test.js` |
| snapscope behavior | `server/tests/snapscope-*.test.js`, plugin-internal tests |
| version-control behavior | `server/tests/vc-*.test.js`, `tests/version-control-*.test.js` |
| remote-agents behavior | `server/tests/remote-agents-*.test.js`, `tests/test-runner-registry-*.test.js` |
| Loader fault tolerance | `server/plugins/loader.test.js` |

Plugin tests do NOT cover the plugin → loader → install → mcpTools/middleware/tierTools end-to-end pipeline as a single integration. Each pass is tested in isolation.

---

## Open questions / risks

> **All 12 questions resolved as of 2026-05-08.** This section is now a historical record of the audit drainage. Future work in this surface should append new questions below the existing 12 with their own dated resolution notes — preserve the full trail so the next operator can see the whole arc.

These are the known soft spots — addressing them before adding the next plugin or changing the contract.

### 1. ✅ ~~`eventHandlers()` is contract-required but unused~~ RESOLVED 2026-05-08

`server/plugins/boot-helpers.js` exports `wirePluginEventHandlers(plugins, eventBus, logger)`. After the install pass in `server/index.js`, each plugin's `eventHandlers()` return map is subscribed to the eventBus via `eventBus.on(eventName, fn)`. Plugins can now declare:

```js
eventHandlers() {
  return {
    'task-event': (data) => { ... },
    'queue-changed': () => { ... },
  };
}
```

instead of subscribing manually inside `install()`. The two patterns are additive — install-side subscription remains supported for back-compat, so existing plugins that use it continue working without changes.

Defensive: missing/throwing `eventHandlers()`, non-object returns, and non-function values in the map are all logged at warn level and skipped. Successful subscriptions log `[plugin-loader] <plugin>: subscribed to events: ev1, ev2` so operators can verify wiring.

6 unit tests in `tests/plugin-boot-helpers.test.js` (`wirePluginEventHandlers` describe block).

### 2. ✅ ~~Three different factory naming conventions in `createPluginInstance`~~ RESOLVED 2026-05-08

snapscope and auth both now export `createPlugin` aliased to their original factory function (`createSnapScopePlugin` / `createAuthPlugin`). The loader's `createPluginInstance` priority order is unchanged — `createPlugin` first, legacy fallbacks second — so the canonical path always wins for the migrated plugins. Loader comment now marks the legacy fallbacks as a deprecation cycle for any external consumer.

4 unit tests in `loader.test.js` (`createPlugin canonical factory` describe block):
1. Uses createPlugin when present (canonical path)
2. Falls back to createSnapScopePlugin when createPlugin absent (legacy)
3. Falls back to createAuthPlugin when createPlugin absent (legacy)
4. createPlugin wins when both canonical AND a legacy name are exported (priority verification — pins the migration path)

Future cleanup: once external consumers (if any) confirm migration, the loader's two fallback branches can be removed and `createPluginInstance` simplified to a single check.

### 3. ✅ ~~Install failures don't unload the plugin~~ RESOLVED 2026-05-08

`server/plugins/boot-helpers.js` exports `installPluginsWithUnloadOnError(plugins, container, logger)`. Iterates loadedPlugins in reverse and splices out any plugin whose `install()` throws. Subsequent passes (eventHandlers wiring, mcpTools collection, tierTools merge) only see successful plugins. The error log carries an explicit `REMOVING` marker so operators see the unload happen:

> `[plugin-loader] Plugin install FAILED: <name> — <error> — REMOVING from loaded set so its tools/middleware/events do not register`

Returns a `failures` array (`{ name, error }[]`) for callers that want to expose the count or surface to telemetry. Reverse iteration is intentional — splicing during forward iteration would skip elements.

4 unit tests in `tests/plugin-boot-helpers.test.js` (`installPluginsWithUnloadOnError` describe block).

### 4. ✅ ~~`classifierRules` / `recoveryStrategies` consumers are scattered~~ RESOLVED 2026-05-08

`server/plugins/boot-helpers.js` exports `getAllClassifierRules(plugins)` and `getAllRecoveryStrategies(plugins)`. After the install + eventHandlers passes complete, `server/index.js` calls these helpers and registers the merged arrays as container values `pluginClassifierRules` and `pluginRecoveryStrategies`. The autoRecoveryEngine container factory now prefers these merged values over its direct require of `auto-recovery-core` (back-compat: when the boot pass hasn't run, e.g. in tests that construct the engine directly, the factory falls back to the per-plugin direct-import).

Merge contract: stable plugin-load order, first-plugin-wins on duplicate `name`/`id` field. Rules without a stable identifier just get appended (no dedup). Mirrors `dedupPluginTools`' first-wins rule.

6 unit tests in `tests/plugin-boot-helpers.test.js` (`getAllClassifierRules` + `getAllRecoveryStrategies` describe blocks).

Today only `auto-recovery-core` contributes — but the path is now open for future plugins to extend the recovery surface without forking `server/factory/auto-recovery`.

### 5. ✅ ~~Tool-name dedup is asymmetric (built-ins win, plugins fight silently)~~ RESOLVED 2026-05-08

`server/plugins/boot-helpers.js` exports `dedupPluginTools(plugins, builtInNames, logger, decorateFn)`. The helper tracks plugin tool ownership in a `Map<toolName, pluginName>`. First-plugin-wins; second plugin contributing a duplicate name gets a warn log naming both:

> `[plugin-tools] DUPLICATE: tool "X" from plugin "B" already registered by plugin "A" — skipping`

Replaces the previous silent-last-loaded-wins behavior in `server/index.js` pass 3. Returns both the deduped tool array and the ownership map so callers can audit who owns what.

7 unit tests in `tests/plugin-boot-helpers.test.js` (`dedupPluginTools` describe block) cover collection, built-in shadowing, plugin-vs-plugin dedup with warn log, exception swallowing, optional decorate, non-array returns, and skipping invalid tool definitions.

### 6. ✅ ~~`configSchema()` surfaces are documentation-only~~ RESOLVED 2026-05-08

`server/plugins/boot-helpers.js` exports `validatePluginConfigSchemas(plugins, configReader, logger)`. After install pass, `server/index.js` invokes it with `db.getConfig` as the configReader. For each plugin's `configSchema()`, it checks the schema's `required` array against actual config values and warns when any required field is unset/null/empty:

> `[plugin-loader] <name>: configSchema requires fields not set in config: api_key, secret`

Defensive: throwing `configSchema()` returns are logged at warn and skipped. Plugins without `configSchema` or with empty-required schemas contribute nothing.

This is the lightweight Phase 1 implementation — Phase 2 (full JSON-schema validation against actual values, type coercion, default fill-in) is a future batch. Today's bar is "operators see a clear log when a plugin requires config they haven't set yet."

6 unit tests in `tests/plugin-boot-helpers.test.js` (`validatePluginConfigSchemas` describe block).

### 7. ✅ ~~`codegraph` env-var opt-out is checked inside the plugin, not in the loader~~ RESOLVED 2026-05-08

The plugin contract gains an optional `enabled()` method. When present and returning false, the loader skips the plugin entirely (no install/middleware/mcpTools/tierTools registration); when absent, the plugin is treated as always-enabled (back-compat with all 6 prior default plugins).

`codegraph/index.js` now exposes `enabled: isFeatureEnabled` so the env-var check (`TORQUE_CODEGRAPH_ENABLED !== '0'`) lives in the loader gate instead of returning a no-op stub from the factory. Operators see `[plugin-loader] Plugin "codegraph" disabled by enabled() gate — skipping` in `torque.log` instead of a silently-loaded inert plugin.

The defensive check inside `install()` (`if (!isFeatureEnabled()) return`) remains as belt-and-suspenders for callers that bypass the loader (test fixtures that construct plugins directly).

4 unit tests in `loader.test.js` (`enabled() gate` describe block):
1. Skips plugin when enabled() returns false
2. Loads plugin when enabled() returns true
3. Loads plugin when enabled() is absent (back-compat default-enabled)
4. Treats throwing enabled() as disabled (defensive)

Forward-looking: same pattern can migrate auth's enterprise gate out of `AUTH_MODE_PLUGIN_MAP` (`enabled: () => process.env.TORQUE_AUTH_MODE === 'enterprise'`) — left for a future batch.

### 8. ✅ ~~`uninstall()` is contract-required but not exercised in production~~ RESOLVED 2026-05-08

`server/plugins/boot-helpers.js` exports `uninstallAllPlugins(plugins, logger)`. `server/index.js` subscribes it to `eventBus.onShutdown` so each plugin's `uninstall()` runs before the process exits. Reverse plugin-load order so dependents tear down before dependencies (mirrors the install-forward / uninstall-reverse convention).

Best-effort: throws are logged at warn but don't block shutdown of other plugins. Plugins still implementing only an empty `uninstall()` continue to work; the wire-up just makes the existing implementations actually fire.

3 unit tests in `tests/plugin-boot-helpers.test.js` (`uninstallAllPlugins` describe block).

### 9. ✅ ~~No plugin-level health endpoint~~ RESOLVED 2026-05-08

The plugin contract gains an optional `health()` method returning `{ status: 'ok'|'degraded'|'down', details?: string }`. `server/plugins/boot-helpers.js` exports `aggregatePluginHealth(plugins)` returning `{ overall, perPlugin }` where `overall` is the worst-case status across reporting plugins. Plugins without `health()` don't contribute (no signal != bad signal).

`server/api/health-probes.js` includes the aggregated result in `/healthz` responses under the `plugins` key. Any plugin reporting `down` downgrades the overall HTTP status to 503; `degraded` downgrades from 200 healthy to 200 degraded. `loadedPlugins` is registered as a container value at boot so the healthz route can read it via `defaultContainer.peek('loadedPlugins')`.

Defensive: missing/throwing health() is treated as `unknown` so a broken plugin can't poison /healthz.

7 unit tests in `tests/plugin-boot-helpers.test.js` (`aggregatePluginHealth` describe block).

### 10. ✅ ~~`validatePlugin` returns errors as a flat array~~ RESOLVED 2026-05-08

`validatePlugin(plugin)` now returns `{ valid, errors: [{ field, expected, actual, kind, message }] }` where `kind` is one of `'missing'`, `'type-mismatch'`, `'required-array'`, `'malformed-input'`. Tests and dashboards can triage by `kind` programmatically.

`formatValidationErrors(errors)` is a back-compat helper that flattens the structured array into the prior comma-joined string format. The loader uses it to keep its existing warn-log line shape:
> `[plugin-loader] Plugin "<name>" failed validation: missing required field: version, install must be a function`

The formatter accepts mixed input — legacy string entries pass through unchanged — so any external consumer that hand-builds error arrays continues to work.

6 unit tests in `tests/plugin-boot-helpers.test.js` (`validatePlugin (structured errors)` describe block).

### 11. ✅ ~~`model-freshness` schedules persist across restarts but plugin reload doesn't migrate them~~ RESOLVED 2026-05-08

The plugin contract gains an optional `migrate(prevVersion, currVersion)` method. Migration v59 adds a `plugin_migrations` table (`plugin_name PRIMARY KEY`, `applied_version`, `applied_at`). `server/plugins/boot-helpers.js` exports `applyPluginMigrations(plugins, dbReader, logger)` which:

1. Looks up the plugin's last applied version from `plugin_migrations`
2. Skips if `applied_version === plugin.version` (already migrated)
3. Calls `plugin.migrate(prevVersion, currVersion)` (prevVersion is `null` on first install)
4. On success, upserts the new version row
5. **On throw, leaves the prior version in place** — next boot retries

`server/index.js` calls the helper after the install pass with `db.getDbInstance()` as the dbReader.

Use case: model-freshness can ship a `migrate()` that re-arms scheduled scans when the schedule schema changes between versions. Codegraph would benefit similarly.

6 unit tests in `tests/plugin-boot-helpers.test.js` (`applyPluginMigrations` describe block) cover first-install, no-op-on-same-version, version-change, throw-no-record-update, missing-migrate-skip, db-unavailable.

### 12. ✅ ~~No way to add plugins without forking `DEFAULT_PLUGIN_NAMES`~~ RESOLVED 2026-05-08

`server/plugins/boot-helpers.js` exports `mergeExtraPluginNames(defaultNames, env)`. `server/index.js` calls it with `DEFAULT_PLUGIN_NAMES` and `process.env`; the result is appended to the loader's plugin list. Operators set:

```bash
TORQUE_EXTRA_PLUGINS=my-plugin,another-plugin
```

Each name is looked up in `pluginDir` (default: `server/plugins/`) and goes through the same load + validate + `enabled()` gate as built-ins. The loader's existing fault tolerance (warn-and-skip on missing/broken plugins) handles operator typos.

The parser handles whitespace, deduplicates against `DEFAULT_PLUGIN_NAMES` (so an operator listing an already-built-in name doesn't break anything), dedupes within the env var itself, skips empty entries from trailing commas, and treats non-string env values as unset.

8 unit tests in `tests/plugin-boot-helpers.test.js` (`mergeExtraPluginNames` describe block).

This was the single biggest lift for plugin authorship. With it, "extensible via plugins" is no longer aspirational — operators can ship private plugins without forking core source.

---

## Recently shipped fixes touching this surface

These memory-resident fixes are why this audit exists. Each one was a single-shape bug in a 7-plugin architecture that nobody had a unified picture of:

- Plugin contract initially shipped with `name`/`version`/`install`/`uninstall` only; expanded to include `middleware`/`mcpTools`/`eventHandlers`/`configSchema` over time. The pre-snapscope days had no MCP tool registration via plugins at all.
- `tierTools` added when the progressive tool-unlock system shipped (~600 tools total) so plugins could opt their tools into Tier 1 / Tier 2 visibility instead of always-Tier-3.
- `classifierRules` / `recoveryStrategies` added when `auto-recovery-core` extracted from the factory engine to make the rule set unit-testable in isolation.
- Loader's factory dispatch (`createPlugin` / `createSnapScopePlugin` / `createAuthPlugin`) accumulated organically as each plugin's older shape needed back-compat.

Future fixes in this surface should land in this section so the next audit doesn't have to reconstruct the timeline from `git log`.
