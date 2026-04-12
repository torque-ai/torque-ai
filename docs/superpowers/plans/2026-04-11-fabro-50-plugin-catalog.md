# Fabro #50: Plugin Catalog + Runtime Loading (Kestra + Activepieces)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Formalize TORQUE's providers, tools, system tasks, and workflow hooks into a unified **plugin contract** with version pinning, a catalog, namespaced IDs (`torque.provider.codex@2.1.0`), `pluginDefaults` stamping, and runtime loading from npm packages. Makes community contribution, local development, and version-locked production all follow the same pattern. Inspired by Kestra + Activepieces.

**Architecture:** A `plugins/` directory at runtime with `package.json`-backed plugin modules. TORQUE scans registered plugin packages on startup, validates each against the `TORQUE_PLUGIN_V2` contract, and registers its capabilities (providers, tools, system tasks, hooks) under fully-qualified IDs. Workflows reference plugins by ID + optional semver range (`torque.system.inline@^1`). `pluginDefaults` stamps common config (API keys, retries) onto all invocations of a plugin.

**Tech Stack:** Node.js, semver, better-sqlite3. Builds on existing `server/plugins/` infrastructure (expands it from 3 built-ins to a general pattern).

---

## File Structure

**New files:**
- `server/migrations/0NN-plugin-catalog.sql`
- `server/plugins/catalog.js` — discovery + registration
- `server/plugins/plugin-contract-v2.js` — validator for new contract
- `server/plugins/plugin-defaults.js` — apply defaults stamping
- `server/plugins/loader-v2.js` — runtime require + validate
- `server/tests/catalog.test.js`
- `server/tests/plugin-defaults.test.js`
- `docs/plugin-contract-v2.md`

**Modified files:**
- `server/plugins/loader.js` — delegate to v2 loader for new-contract plugins
- `server/handlers/mcp-tools.js` — surface catalog listing
- `server/tool-defs/` — `list_plugins`, `install_plugin`, `set_plugin_defaults`

---

## Task 1: Contract v2 + validator

- [ ] **Step 1: Tests**

Create `server/tests/plugin-contract-v2.test.js` (or inline in catalog.test.js):

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { validatePluginV2 } = require('../plugins/plugin-contract-v2');

describe('validatePluginV2', () => {
  it('accepts a minimal valid plugin', () => {
    const p = {
      id: 'torque.provider.example',
      version: '1.0.0',
      contract: 'TORQUE_PLUGIN_V2',
      provides: { providers: { example: { runPrompt: async () => 'ok' } } },
    };
    const r = validatePluginV2(p);
    expect(r.ok).toBe(true);
  });

  it('rejects plugin with bad id format', () => {
    const r = validatePluginV2({ id: 'bad id', version: '1.0.0', contract: 'TORQUE_PLUGIN_V2', provides: {} });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/id/i);
  });

  it('rejects plugin with bad semver', () => {
    const r = validatePluginV2({ id: 'torque.x.y', version: 'not-a-version', contract: 'TORQUE_PLUGIN_V2', provides: {} });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/version/i);
  });

  it('rejects unknown contract', () => {
    const r = validatePluginV2({ id: 'torque.x.y', version: '1.0.0', contract: 'OTHER', provides: {} });
    expect(r.ok).toBe(false);
  });

  it('validates provides shapes: providers/tools/systemTasks/hooks', () => {
    const p = {
      id: 'torque.x.y', version: '1.0.0', contract: 'TORQUE_PLUGIN_V2',
      provides: {
        providers: { a: { runPrompt: async () => '' } },
        tools: { myTool: { description: 'x', inputSchema: {}, handler: async () => ({}) } },
        systemTasks: { myKind: { run: async () => ({}) } },
        hooks: { onTaskComplete: async () => {} },
      },
    };
    expect(validatePluginV2(p).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/plugins/plugin-contract-v2.js`:

```js
'use strict';
const semver = require('semver');

const ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/;

function validatePluginV2(plugin) {
  const errors = [];
  if (plugin?.contract !== 'TORQUE_PLUGIN_V2') errors.push('contract must be "TORQUE_PLUGIN_V2"');
  if (typeof plugin?.id !== 'string' || !ID_RE.test(plugin.id)) errors.push(`id must match ${ID_RE}`);
  if (typeof plugin?.version !== 'string' || !semver.valid(plugin.version)) errors.push('version must be valid semver');
  if (!plugin?.provides || typeof plugin.provides !== 'object') errors.push('provides must be an object');

  if (plugin?.provides?.providers) {
    for (const [name, impl] of Object.entries(plugin.provides.providers)) {
      if (typeof impl.runPrompt !== 'function') errors.push(`provider '${name}' missing runPrompt`);
    }
  }
  if (plugin?.provides?.tools) {
    for (const [name, def] of Object.entries(plugin.provides.tools)) {
      if (!def.inputSchema || typeof def.handler !== 'function') errors.push(`tool '${name}' needs inputSchema + handler`);
    }
  }
  if (plugin?.provides?.systemTasks) {
    for (const [name, def] of Object.entries(plugin.provides.systemTasks)) {
      if (typeof def.run !== 'function') errors.push(`systemTask '${name}' missing run()`);
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validatePluginV2 };
```

Commit: `feat(plugins): contract v2 validator for namespaced plugins`.

---

## Task 2: Catalog + loader

- [ ] **Step 1: Migration**

`server/migrations/0NN-plugin-catalog.sql`:

```sql
CREATE TABLE IF NOT EXISTS installed_plugins (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT,                          -- 'builtin' | 'npm' | 'local' | URL
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_id, version)
);

CREATE TABLE IF NOT EXISTS plugin_defaults (
  plugin_id TEXT PRIMARY KEY,
  defaults_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Catalog tests**

Create `server/tests/catalog.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createCatalog } = require('../plugins/catalog');

describe('pluginCatalog', () => {
  let db, catalog;
  beforeEach(() => {
    db = setupTestDb();
    catalog = createCatalog({ db });
  });

  it('register records the plugin in installed_plugins', () => {
    catalog.register({
      id: 'torque.provider.example', version: '1.0.0', contract: 'TORQUE_PLUGIN_V2',
      provides: { providers: { example: { runPrompt: async () => '' } } },
    }, { source: 'builtin' });
    const r = db.prepare('SELECT * FROM installed_plugins WHERE plugin_id = ?').get('torque.provider.example');
    expect(r.version).toBe('1.0.0');
  });

  it('resolve honors semver ranges', () => {
    catalog.register({ id: 'p.x', version: '1.0.0', contract: 'TORQUE_PLUGIN_V2', provides: {} }, { source: 'builtin' });
    catalog.register({ id: 'p.x', version: '1.2.0', contract: 'TORQUE_PLUGIN_V2', provides: {} }, { source: 'builtin' });
    catalog.register({ id: 'p.x', version: '2.0.0', contract: 'TORQUE_PLUGIN_V2', provides: {} }, { source: 'builtin' });
    expect(catalog.resolve('p.x', '^1')).toBe('1.2.0');
    expect(catalog.resolve('p.x', '^2')).toBe('2.0.0');
    expect(catalog.resolve('p.x', '1.0.x')).toBe('1.0.0');
  });

  it('getProviders returns merged provider map across installed plugins', () => {
    catalog.register({ id: 'p.a', version: '1.0.0', contract: 'TORQUE_PLUGIN_V2',
      provides: { providers: { a: { runPrompt: async () => '' } } } }, { source: 'builtin' });
    catalog.register({ id: 'p.b', version: '1.0.0', contract: 'TORQUE_PLUGIN_V2',
      provides: { providers: { b: { runPrompt: async () => '' } } } }, { source: 'builtin' });
    const providers = catalog.getProviders();
    expect(Object.keys(providers).sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/plugins/catalog.js`:

```js
'use strict';
const semver = require('semver');
const { validatePluginV2 } = require('./plugin-contract-v2');

function createCatalog({ db, logger = console }) {
  const loaded = new Map(); // `${id}@${version}` -> plugin

  function register(plugin, { source = 'unknown' } = {}) {
    const r = validatePluginV2(plugin);
    if (!r.ok) throw new Error(`Invalid plugin: ${r.errors.join('; ')}`);
    db.prepare(`
      INSERT OR REPLACE INTO installed_plugins (plugin_id, version, source, enabled)
      VALUES (?, ?, ?, 1)
    `).run(plugin.id, plugin.version, source);
    loaded.set(`${plugin.id}@${plugin.version}`, plugin);
    logger.info('plugin registered', { id: plugin.id, version: plugin.version });
  }

  function resolve(id, range = '*') {
    const versions = db.prepare(`SELECT version FROM installed_plugins WHERE plugin_id = ? AND enabled = 1`).all(id).map(r => r.version);
    const match = semver.maxSatisfying(versions, range);
    return match;
  }

  function getPlugin(id, range = '*') {
    const version = resolve(id, range);
    if (!version) return null;
    return loaded.get(`${id}@${version}`);
  }

  function listInstalled({ enabledOnly = false } = {}) {
    const sql = `SELECT * FROM installed_plugins ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY plugin_id, version`;
    return db.prepare(sql).all();
  }

  function getProviders() {
    const out = {};
    for (const p of loaded.values()) {
      for (const [name, impl] of Object.entries(p.provides?.providers || {})) out[name] = impl;
    }
    return out;
  }

  function getTools() {
    const out = {};
    for (const p of loaded.values()) {
      for (const [name, def] of Object.entries(p.provides?.tools || {})) out[name] = def;
    }
    return out;
  }

  function getSystemTasks() {
    const out = {};
    for (const p of loaded.values()) {
      for (const [kind, def] of Object.entries(p.provides?.systemTasks || {})) out[kind] = def;
    }
    return out;
  }

  return { register, resolve, getPlugin, listInstalled, getProviders, getTools, getSystemTasks };
}

module.exports = { createCatalog };
```

Run tests → PASS. Commit: `feat(plugins): catalog with semver-range resolution`.

---

## Task 3: Plugin defaults stamping

- [ ] **Step 1: Tests**

Create `server/tests/plugin-defaults.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createPluginDefaults } = require('../plugins/plugin-defaults');

describe('pluginDefaults', () => {
  let db, pd;
  beforeEach(() => {
    db = setupTestDb();
    pd = createPluginDefaults({ db });
  });

  it('set stores defaults; stamp merges with per-call input', () => {
    pd.set('torque.provider.codex', { temperature: 0.2, max_tokens: 2000 });
    const stamped = pd.stamp('torque.provider.codex', { prompt: 'hi', max_tokens: 500 });
    expect(stamped).toEqual({ temperature: 0.2, max_tokens: 500, prompt: 'hi' });
  });

  it('stamp returns input unchanged when no defaults set', () => {
    expect(pd.stamp('nope', { a: 1 })).toEqual({ a: 1 });
  });

  it('set is idempotent and overwrites', () => {
    pd.set('p.x', { a: 1 });
    pd.set('p.x', { b: 2 });
    expect(pd.stamp('p.x', {})).toEqual({ b: 2 });
  });

  it('remove clears defaults', () => {
    pd.set('p.x', { a: 1 });
    pd.remove('p.x');
    expect(pd.stamp('p.x', {})).toEqual({});
  });
});
```

- [ ] **Step 2: Implement**

Create `server/plugins/plugin-defaults.js`:

```js
'use strict';

function createPluginDefaults({ db }) {
  function set(pluginId, defaults) {
    db.prepare(`INSERT OR REPLACE INTO plugin_defaults (plugin_id, defaults_json, updated_at) VALUES (?, ?, datetime('now'))`)
      .run(pluginId, JSON.stringify(defaults));
  }

  function get(pluginId) {
    const row = db.prepare(`SELECT defaults_json FROM plugin_defaults WHERE plugin_id = ?`).get(pluginId);
    if (!row) return {};
    try { return JSON.parse(row.defaults_json); } catch { return {}; }
  }

  function stamp(pluginId, input) {
    const defaults = get(pluginId);
    return { ...defaults, ...input };
  }

  function remove(pluginId) {
    db.prepare(`DELETE FROM plugin_defaults WHERE plugin_id = ?`).run(pluginId);
  }

  return { set, get, stamp, remove };
}

module.exports = { createPluginDefaults };
```

Run tests → PASS. Commit: `feat(plugins): defaults stamping with last-write-wins`.

---

## Task 4: Loader + MCP tools

- [ ] **Step 1: Runtime loader**

Create `server/plugins/loader-v2.js`:

```js
'use strict';
const path = require('path');

function loadFromNpm({ packageName, catalog, source = 'npm' }) {
  const mod = require(packageName);
  if (!mod || !mod.default) throw new Error(`Package ${packageName} has no default export`);
  const plugin = mod.default;
  catalog.register(plugin, { source });
  return plugin;
}

function loadFromPath({ pluginPath, catalog, source = 'local' }) {
  const abs = path.resolve(pluginPath);
  const mod = require(abs);
  const plugin = mod.default || mod;
  catalog.register(plugin, { source });
  return plugin;
}

module.exports = { loadFromNpm, loadFromPath };
```

- [ ] **Step 2: MCP tools**

In `server/tool-defs/`:

```js
list_plugins: { description: 'List installed plugins with version + capabilities.', inputSchema: { type: 'object', properties: {} } },
install_plugin: {
  description: 'Install a plugin from an npm package or local path. Not permitted in production without admin approval.',
  inputSchema: { type: 'object', required: ['source'], properties: { source: { type: 'string' }, kind: { type: 'string', enum: ['npm', 'local'], default: 'npm' } } },
},
set_plugin_defaults: {
  description: 'Stamp default parameters onto all invocations of a plugin.',
  inputSchema: { type: 'object', required: ['plugin_id', 'defaults'], properties: { plugin_id: { type: 'string' }, defaults: { type: 'object' } } },
},
```

- [ ] **Step 3: Container wiring**

```js
container.factory('pluginCatalog', (c) => require('./plugins/catalog').createCatalog({ db: c.get('db'), logger: c.get('logger') }));
container.factory('pluginDefaults', (c) => require('./plugins/plugin-defaults').createPluginDefaults({ db: c.get('db') }));
```

At startup, load any plugins listed in `server/config/plugins.json` (a user-maintained registry of enabled plugin packages).

`await_restart`. Smoke: `list_plugins()` → confirm built-in providers and tools show up as a v1 plugin. `set_plugin_defaults({plugin_id: 'torque.provider.codex', defaults: {temperature: 0.1}})` → confirm subsequent codex tasks run at temp 0.1.

Commit: `feat(plugins): catalog + loader-v2 + MCP tools for install/list/defaults`.
