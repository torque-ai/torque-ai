'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { validatePlugin } = require('./plugin-contract');
const { loadPlugins } = require('./loader');

describe('plugin-contract', () => {
  it('accepts a valid plugin with all required fields', () => {
    const plugin = {
      name: 'test-plugin',
      version: '1.0.0',
      install: () => {},
      uninstall: () => {},
      middleware: () => [],
      mcpTools: () => [],
      eventHandlers: () => ({}),
      configSchema: () => ({ type: 'object', properties: {} }),
    };

    const result = validatePlugin(plugin);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects plugin missing required fields', () => {
    const result = validatePlugin({ name: 'bad-plugin' });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors).toContain('missing required field: version');
  });

  it('rejects plugin with non-function lifecycle methods', () => {
    const plugin = {
      name: 'bad-plugin',
      version: '1.0.0',
      install: 'not-a-function',
      uninstall: () => {},
      middleware: [],
      mcpTools: () => [],
      eventHandlers: () => ({}),
      configSchema: () => ({}),
    };

    const result = validatePlugin(plugin);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('install must be a function');
    expect(result.errors).toContain('middleware must be a function');
  });
});

describe('loadPlugins', () => {
  function createLoggerWarnings() {
    const warnings = [];
    return {
      warnings,
      logger: {
        warn(message) {
          warnings.push(message);
        },
        info() {},
      },
    };
  }

  it('returns empty array when authMode is local', () => {
    expect(loadPlugins({ authMode: 'local' })).toEqual([]);
  });

  it('returns empty array when authMode is undefined', () => {
    expect(loadPlugins({ authMode: undefined })).toEqual([]);
  });

  it('logs warning on invalid plugin and falls back to empty', () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-loader-invalid-'));
    const authDir = path.join(pluginDir, 'auth');
    const { warnings, logger } = createLoggerWarnings();

    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'index.js'), `
module.exports = {
  createAuthPlugin() {
    return {
      name: 'auth',
      install() {},
      uninstall() {},
      middleware() { return []; },
      mcpTools() { return []; },
      eventHandlers() { return {}; },
      configSchema() { return {}; },
    };
  },
};
`, 'utf8');

    try {
      expect(loadPlugins({ authMode: 'enterprise', pluginDir, logger })).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('failed validation');
    } finally {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('logs warning when plugin directory does not exist', () => {
    const pluginDir = path.join(os.tmpdir(), `torque-loader-missing-${Date.now()}`);
    const { warnings, logger } = createLoggerWarnings();

    expect(loadPlugins({ authMode: 'enterprise', pluginDir, logger })).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Failed to load plugin "auth"');
  });
});
