'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadPlugins } = require('../plugins/loader');

describe('plugin-loader', () => {
  let pluginDir;

  function writePluginModule(name, source) {
    const dir = path.join(pluginDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), source, 'utf8');
  }

  beforeEach(() => {
    pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-plugin-loader-'));
  });

  afterEach(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  it('returns empty array when auth_mode is local', () => {
    const plugins = loadPlugins({ authMode: 'local' });
    expect(plugins).toEqual([]);
  });

  it('returns empty array when auth_mode is not set', () => {
    const plugins = loadPlugins({});
    expect(plugins).toEqual([]);
  });

  it('returns empty array when plugin dir does not exist', () => {
    const plugins = loadPlugins({
      authMode: 'enterprise',
      pluginDir: path.join(__dirname, 'nonexistent-plugins'),
    });
    expect(plugins).toEqual([]);
  });

  it('logs warning on missing plugin', () => {
    const warnings = [];
    loadPlugins({
      authMode: 'enterprise',
      pluginDir: path.join(__dirname, 'nonexistent-plugins'),
      logger: { warn: (msg) => warnings.push(msg), info: () => {} },
    });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('test_loads_named_plugin', () => {
    writePluginModule('test', `
module.exports = {
  createPlugin() {
    return {
      name: 'test',
      version: '1.0.0',
      install() {},
      uninstall() {},
      middleware() { return []; },
      mcpTools() { return []; },
      eventHandlers() { return {}; },
      configSchema() { return {}; },
    };
  },
};
`);

    const plugins = loadPlugins({
      plugins: ['test'],
      pluginDir,
      logger: { warn: () => {}, info: () => {} },
    });

    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('test');
    expect(plugins[0].version).toBe('1.0.0');
  });

  it('test_auth_and_named_plugins_both_load', () => {
    writePluginModule('test', `
module.exports = {
  createPlugin() {
    return {
      name: 'test',
      version: '1.0.0',
      install() {},
      uninstall() {},
      middleware() { return []; },
      mcpTools() { return []; },
      eventHandlers() { return {}; },
      configSchema() { return {}; },
    };
  },
};
`);

    writePluginModule('auth', `
module.exports = {
  createAuthPlugin() {
    return {
      name: 'auth',
      version: '1.0.0',
      install() {},
      uninstall() {},
      middleware() { return []; },
      mcpTools() { return []; },
      eventHandlers() { return {}; },
      configSchema() { return {}; },
    };
  },
};
`);

    const plugins = loadPlugins({
      plugins: ['test'],
      authMode: 'enterprise',
      pluginDir,
      logger: { warn: () => {}, info: () => {} },
    });

    expect(plugins).toHaveLength(2);
    expect(plugins.map((plugin) => plugin.name)).toEqual(['test', 'auth']);
  });

  it('test_invalid_plugin_skipped', () => {
    const warnings = [];

    writePluginModule('invalid', `
module.exports = {
  createPlugin() {
    return {
      name: 'invalid',
      install() {},
      uninstall() {},
      middleware() { return []; },
      mcpTools() { return []; },
      eventHandlers() { return {}; },
      configSchema() { return {}; },
    };
  },
};
`);

    const plugins = loadPlugins({
      plugins: ['invalid'],
      pluginDir,
      logger: { warn: (msg) => warnings.push(msg), info: () => {} },
    });

    expect(plugins).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('failed validation');
  });

  // ── plugin-contract.md #7: loader-side enabled() gate ────────────────
  // When a plugin's optional enabled() method returns false, the loader
  // skips it entirely (no install/middleware/mcpTools/tierTools). When
  // enabled() returns true (or is absent), the plugin loads normally.
  describe('enabled() gate', () => {
    function writeStubPlugin(name, enabledReturns) {
      const enabledClause = enabledReturns === undefined
        ? ''
        : `enabled() { return ${JSON.stringify(enabledReturns)}; },`;
      writePluginModule(name, `
module.exports = {
  createPlugin() {
    return {
      name: ${JSON.stringify(name)},
      version: '1.0.0',
      install() {},
      uninstall() {},
      middleware() { return []; },
      mcpTools() { return []; },
      eventHandlers() { return {}; },
      configSchema() { return {}; },
      ${enabledClause}
    };
  },
};
`);
    }

    it('skips plugin when enabled() returns false', () => {
      writeStubPlugin('gated-off', false);
      const warnings = [];
      const infos = [];
      const loaded = loadPlugins({
        plugins: ['gated-off'],
        pluginDir,
        logger: { warn: (m) => warnings.push(m), info: (m) => infos.push(m) },
      });
      expect(loaded).toEqual([]);
      expect(warnings).toHaveLength(0);
      expect(infos.some((m) => m.includes('disabled by enabled() gate'))).toBe(true);
    });

    it('loads plugin when enabled() returns true', () => {
      writeStubPlugin('gated-on', true);
      const loaded = loadPlugins({
        plugins: ['gated-on'],
        pluginDir,
        logger: { warn: () => {}, info: () => {} },
      });
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('gated-on');
    });

    it('loads plugin when enabled() is absent (back-compat default-enabled)', () => {
      writeStubPlugin('no-gate', undefined);
      const loaded = loadPlugins({
        plugins: ['no-gate'],
        pluginDir,
        logger: { warn: () => {}, info: () => {} },
      });
      expect(loaded).toHaveLength(1);
    });

    it('treats throwing enabled() as disabled (defensive)', () => {
      writePluginModule('gated-throws', `
module.exports = {
  createPlugin() {
    return {
      name: 'gated-throws', version: '1.0.0',
      install() {}, uninstall() {},
      middleware() { return []; }, mcpTools() { return []; },
      eventHandlers() { return {}; }, configSchema() { return {}; },
      enabled() { throw new Error('boom'); },
    };
  },
};
`);
      const warnings = [];
      const loaded = loadPlugins({
        plugins: ['gated-throws'],
        pluginDir,
        logger: { warn: (m) => warnings.push(m), info: () => {} },
      });
      expect(loaded).toEqual([]);
      expect(warnings.some((m) => m.includes('enabled() threw') && m.includes('treating as disabled'))).toBe(true);
    });
  });

  // ── plugin-contract.md #2: createPlugin canonical factory dispatch ──
  describe('createPlugin canonical factory', () => {
    function writePluginWithFactory(name, factoryName) {
      writePluginModule(name, `
function makeIt() {
  return {
    name: ${JSON.stringify(name)},
    version: '1.0.0',
    install() {},
    uninstall() {},
    middleware() { return []; },
    mcpTools() { return []; },
    eventHandlers() { return {}; },
    configSchema() { return {}; },
  };
}
module.exports = { ${factoryName}: makeIt };
`);
    }

    it('uses createPlugin when present (canonical path)', () => {
      writePluginWithFactory('canon', 'createPlugin');
      const loaded = loadPlugins({
        plugins: ['canon'],
        pluginDir,
        logger: { warn: () => {}, info: () => {} },
      });
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('canon');
    });

    it('falls back to createSnapScopePlugin when createPlugin is absent (legacy)', () => {
      writePluginWithFactory('legacy-snap', 'createSnapScopePlugin');
      const loaded = loadPlugins({
        plugins: ['legacy-snap'],
        pluginDir,
        logger: { warn: () => {}, info: () => {} },
      });
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('legacy-snap');
    });

    it('falls back to createAuthPlugin when createPlugin is absent (legacy)', () => {
      writePluginWithFactory('legacy-auth', 'createAuthPlugin');
      const loaded = loadPlugins({
        plugins: ['legacy-auth'],
        pluginDir,
        logger: { warn: () => {}, info: () => {} },
      });
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('legacy-auth');
    });

    it('createPlugin wins when both canonical AND a legacy name are exported', () => {
      // Verifies the priority order: createPlugin always wins over the
      // legacy fallbacks even when both are present (the migration path
      // for snapscope/auth, which now export both names).
      writePluginModule('dual', `
function canonical() {
  return {
    name: 'dual-canon', version: '1.0.0',
    install() {}, uninstall() {},
    middleware() { return []; }, mcpTools() { return []; },
    eventHandlers() { return {}; }, configSchema() { return {}; },
  };
}
function legacy() {
  return {
    name: 'dual-legacy', version: '1.0.0',
    install() {}, uninstall() {},
    middleware() { return []; }, mcpTools() { return []; },
    eventHandlers() { return {}; }, configSchema() { return {}; },
  };
}
module.exports = { createPlugin: canonical, createSnapScopePlugin: legacy };
`);
      const loaded = loadPlugins({
        plugins: ['dual'],
        pluginDir,
        logger: { warn: () => {}, info: () => {} },
      });
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('dual-canon');
    });
  });
});
