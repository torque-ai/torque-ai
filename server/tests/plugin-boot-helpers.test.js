'use strict';

const {
  mergeExtraPluginNames,
  wirePluginEventHandlers,
  dedupPluginTools,
  installPluginsWithUnloadOnError,
  getAllClassifierRules,
  getAllRecoveryStrategies,
  validatePluginConfigSchemas,
} = require('../plugins/boot-helpers');

// ── plugin-contract.md #12: TORQUE_EXTRA_PLUGINS parser ──────────────
describe('mergeExtraPluginNames', () => {
  const DEFAULTS = ['snapscope', 'version-control', 'codegraph'];

  it('returns empty array when env var unset', () => {
    expect(mergeExtraPluginNames(DEFAULTS, {})).toEqual([]);
  });

  it('returns empty array when env var is empty string', () => {
    expect(mergeExtraPluginNames(DEFAULTS, { TORQUE_EXTRA_PLUGINS: '' })).toEqual([]);
  });

  it('parses single name', () => {
    expect(mergeExtraPluginNames(DEFAULTS, { TORQUE_EXTRA_PLUGINS: 'my-plugin' })).toEqual(['my-plugin']);
  });

  it('parses comma-separated names + trims whitespace', () => {
    expect(mergeExtraPluginNames(DEFAULTS, { TORQUE_EXTRA_PLUGINS: ' my-plugin , another-plugin ' }))
      .toEqual(['my-plugin', 'another-plugin']);
  });

  it('skips defaults that operator already named', () => {
    expect(mergeExtraPluginNames(DEFAULTS, { TORQUE_EXTRA_PLUGINS: 'codegraph,my-plugin' }))
      .toEqual(['my-plugin']);
  });

  it('dedupes within the env var', () => {
    expect(mergeExtraPluginNames(DEFAULTS, { TORQUE_EXTRA_PLUGINS: 'a,b,a,c,b' }))
      .toEqual(['a', 'b', 'c']);
  });

  it('skips empty entries from trailing commas', () => {
    expect(mergeExtraPluginNames(DEFAULTS, { TORQUE_EXTRA_PLUGINS: 'a,,b,,' }))
      .toEqual(['a', 'b']);
  });

  it('treats non-string env values as unset', () => {
    expect(mergeExtraPluginNames(DEFAULTS, { TORQUE_EXTRA_PLUGINS: 42 })).toEqual([]);
    expect(mergeExtraPluginNames(DEFAULTS, { TORQUE_EXTRA_PLUGINS: null })).toEqual([]);
  });
});

// ── plugin-contract.md #1: eventHandlers wiring ──────────────────────
describe('wirePluginEventHandlers', () => {
  function makeBus() {
    const calls = [];
    return {
      bus: { on: (event, fn) => calls.push({ event, fn }) },
      calls,
    };
  }
  function makeLogger() {
    const lines = { info: [], warn: [] };
    return {
      logger: {
        info: (m) => lines.info.push(m),
        warn: (m) => lines.warn.push(m),
      },
      lines,
    };
  }

  it('subscribes each event/handler entry to the bus', () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const plugins = [{
      name: 'p1',
      eventHandlers: () => ({ 'task-event': handlerA, 'queue-changed': handlerB }),
    }];
    const { bus, calls } = makeBus();
    const { logger, lines } = makeLogger();

    const summary = wirePluginEventHandlers(plugins, bus, logger);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ event: 'task-event', fn: handlerA });
    expect(calls[1]).toEqual({ event: 'queue-changed', fn: handlerB });
    expect(summary).toEqual([{ plugin: 'p1', events: ['task-event', 'queue-changed'] }]);
    expect(lines.info.some((m) => m.includes('p1: subscribed to events: task-event, queue-changed'))).toBe(true);
  });

  it('skips plugin when eventHandlers() returns null/empty', () => {
    const plugins = [
      { name: 'p1', eventHandlers: () => null },
      { name: 'p2', eventHandlers: () => ({}) },
    ];
    const { bus, calls } = makeBus();
    const { logger } = makeLogger();

    const summary = wirePluginEventHandlers(plugins, bus, logger);
    expect(calls).toHaveLength(0);
    expect(summary).toEqual([]);
  });

  it('catches eventHandlers() throw without bailing the loop', () => {
    const goodHandler = vi.fn();
    const plugins = [
      { name: 'broken', eventHandlers: () => { throw new Error('boom'); } },
      { name: 'good', eventHandlers: () => ({ ev: goodHandler }) },
    ];
    const { bus, calls } = makeBus();
    const { logger, lines } = makeLogger();

    wirePluginEventHandlers(plugins, bus, logger);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ event: 'ev', fn: goodHandler });
    expect(lines.warn.some((m) => m.includes('broken: eventHandlers() threw: boom'))).toBe(true);
  });

  it('skips non-function values in the returned map', () => {
    const plugins = [{
      name: 'p1',
      eventHandlers: () => ({ 'good-event': () => {}, 'bad-event': 'not-a-function' }),
    }];
    const { bus, calls } = makeBus();
    const { logger, lines } = makeLogger();

    wirePluginEventHandlers(plugins, bus, logger);
    expect(calls).toHaveLength(1);
    expect(calls[0].event).toBe('good-event');
    expect(lines.warn.some((m) => m.includes("'bad-event'") && m.includes('not a function'))).toBe(true);
  });

  it('handles plugin without eventHandlers() (back-compat)', () => {
    const plugins = [{ name: 'no-handlers' }]; // no eventHandlers at all
    const { bus, calls } = makeBus();
    const { logger } = makeLogger();
    expect(() => wirePluginEventHandlers(plugins, bus, logger)).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('catches bus.on() throw with warning', () => {
    const handler = vi.fn();
    const plugins = [{ name: 'p1', eventHandlers: () => ({ ev: handler }) }];
    const bus = { on: () => { throw new Error('bus is dead'); } };
    const { logger, lines } = makeLogger();

    wirePluginEventHandlers(plugins, bus, logger);
    expect(lines.warn.some((m) => m.includes("p1: failed to subscribe to 'ev'") && m.includes('bus is dead'))).toBe(true);
  });
});

// ── plugin-contract.md #5: plugin-vs-plugin tool dedup ───────────────
describe('dedupPluginTools', () => {
  function makeLogger() {
    const lines = { info: [], warn: [], error: [] };
    return {
      logger: {
        info: (m) => lines.info.push(m),
        warn: (m) => lines.warn.push(m),
        error: (m) => lines.error.push(m),
      },
      lines,
    };
  }

  it('collects tools from each plugin', () => {
    const plugins = [
      { name: 'p1', mcpTools: () => [{ name: 'a' }, { name: 'b' }] },
      { name: 'p2', mcpTools: () => [{ name: 'c' }] },
    ];
    const { logger } = makeLogger();
    const { tools, ownership } = dedupPluginTools(plugins, new Set(), logger);
    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(ownership.get('a')).toBe('p1');
    expect(ownership.get('c')).toBe('p2');
  });

  it('skips tools shadowing built-in names', () => {
    const plugins = [{ name: 'p1', mcpTools: () => [{ name: 'submit_task' }, { name: 'plugin_only' }] }];
    const builtIns = new Set(['submit_task', 'cancel_task']);
    const { logger } = makeLogger();
    const { tools, ownership } = dedupPluginTools(plugins, builtIns, logger);
    expect(tools.map((t) => t.name)).toEqual(['plugin_only']);
    expect(ownership.has('submit_task')).toBe(false);
  });

  it('logs warn + skips when two plugins claim the same tool name (first wins)', () => {
    const plugins = [
      { name: 'p1', mcpTools: () => [{ name: 'shared' }] },
      { name: 'p2', mcpTools: () => [{ name: 'shared' }, { name: 'p2-only' }] },
    ];
    const { logger, lines } = makeLogger();
    const { tools, ownership } = dedupPluginTools(plugins, new Set(), logger);
    expect(tools.map((t) => t.name)).toEqual(['shared', 'p2-only']);
    expect(ownership.get('shared')).toBe('p1'); // first wins
    expect(lines.warn.some((m) => m.includes('DUPLICATE: tool "shared" from plugin "p2"') && m.includes('plugin "p1"'))).toBe(true);
  });

  it('catches mcpTools() throw without bailing the loop', () => {
    const plugins = [
      { name: 'broken', mcpTools: () => { throw new Error('boom'); } },
      { name: 'good', mcpTools: () => [{ name: 'g' }] },
    ];
    const { logger, lines } = makeLogger();
    const { tools } = dedupPluginTools(plugins, new Set(), logger);
    expect(tools.map((t) => t.name)).toEqual(['g']);
    expect(lines.error.some((m) => m.includes('broken: mcpTools() threw: boom'))).toBe(true);
  });

  it('applies the optional decorate function', () => {
    const plugins = [{ name: 'p1', mcpTools: () => [{ name: 'a' }] }];
    const { logger } = makeLogger();
    const decorate = (t) => ({ ...t, decorated: true });
    const { tools } = dedupPluginTools(plugins, new Set(), logger, decorate);
    expect(tools[0].decorated).toBe(true);
  });

  it('treats non-array mcpTools() return as no contribution', () => {
    const plugins = [{ name: 'p1', mcpTools: () => null }];
    const { logger } = makeLogger();
    const { tools } = dedupPluginTools(plugins, new Set(), logger);
    expect(tools).toEqual([]);
  });

  it('skips tools without a string name', () => {
    const plugins = [{
      name: 'p1',
      mcpTools: () => [{ name: 'good' }, { name: 42 }, null, { description: 'no name' }],
    }];
    const { logger } = makeLogger();
    const { tools } = dedupPluginTools(plugins, new Set(), logger);
    expect(tools.map((t) => t.name)).toEqual(['good']);
  });
});

// ── plugin-contract.md #3: install-failure unload ──────────────────────
describe('installPluginsWithUnloadOnError', () => {
  function makeLogger() {
    const lines = { info: [], error: [] };
    return {
      logger: {
        info: (m) => lines.info.push(m),
        error: (m) => lines.error.push(m),
      },
      lines,
    };
  }

  it('keeps successfully-installed plugins in the array', () => {
    const installed = [];
    const plugins = [
      { name: 'a', version: '1.0', install: () => installed.push('a') },
      { name: 'b', version: '1.0', install: () => installed.push('b') },
    ];
    const { logger } = makeLogger();
    const { failures } = installPluginsWithUnloadOnError(plugins, {}, logger);

    expect(installed).toEqual(['a', 'b']);
    expect(plugins.map((p) => p.name)).toEqual(['a', 'b']);
    expect(failures).toEqual([]);
  });

  it('splices out plugins whose install() throws', () => {
    const plugins = [
      { name: 'good', version: '1.0', install: () => {} },
      { name: 'bad', version: '1.0', install: () => { throw new Error('boom'); } },
      { name: 'also-good', version: '1.0', install: () => {} },
    ];
    const { logger, lines } = makeLogger();
    const { failures } = installPluginsWithUnloadOnError(plugins, {}, logger);

    expect(plugins.map((p) => p.name)).toEqual(['good', 'also-good']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({ name: 'bad', error: 'boom' });
    expect(lines.error.some((m) => m.includes('Plugin install FAILED: bad') && m.includes('REMOVING'))).toBe(true);
  });

  it('passes container to install()', () => {
    const captured = [];
    const plugins = [{ name: 'p', version: '1.0', install: (c) => captured.push(c) }];
    const fakeContainer = { sentinel: true };
    const { logger } = makeLogger();
    installPluginsWithUnloadOnError(plugins, fakeContainer, logger);
    expect(captured).toEqual([fakeContainer]);
  });

  it('handles all-fail without bailing', () => {
    const plugins = [
      { name: 'a', version: '1.0', install: () => { throw new Error('a-err'); } },
      { name: 'b', version: '1.0', install: () => { throw new Error('b-err'); } },
    ];
    const { logger } = makeLogger();
    const { failures } = installPluginsWithUnloadOnError(plugins, {}, logger);
    expect(plugins).toEqual([]);
    expect(failures.map((f) => f.name).sort()).toEqual(['a', 'b']);
  });
});

// ── plugin-contract.md #4: central registry helpers ────────────────────
describe('getAllClassifierRules', () => {
  it('merges rules across plugins in plugin-load order', () => {
    const plugins = [
      { name: 'a', classifierRules: [{ name: 'r1' }, { name: 'r2' }] },
      { name: 'b', classifierRules: [{ name: 'r3' }] },
    ];
    expect(getAllClassifierRules(plugins).map((r) => r.name)).toEqual(['r1', 'r2', 'r3']);
  });

  it('first-plugin-wins on duplicate rule name', () => {
    const plugins = [
      { name: 'a', classifierRules: [{ name: 'shared', tag: 'a' }] },
      { name: 'b', classifierRules: [{ name: 'shared', tag: 'b' }] },
    ];
    const merged = getAllClassifierRules(plugins);
    expect(merged).toHaveLength(1);
    expect(merged[0].tag).toBe('a');
  });

  it('dedupe also keys on `id` field', () => {
    const plugins = [
      { name: 'a', classifierRules: [{ id: 'shared' }] },
      { name: 'b', classifierRules: [{ id: 'shared' }] },
    ];
    expect(getAllClassifierRules(plugins)).toHaveLength(1);
  });

  it('rules without name/id just get appended', () => {
    const plugins = [
      { name: 'a', classifierRules: [{ pattern: 'x' }, { pattern: 'y' }] },
    ];
    expect(getAllClassifierRules(plugins)).toHaveLength(2);
  });

  it('skips plugins without classifierRules array', () => {
    const plugins = [
      { name: 'a' },
      { name: 'b', classifierRules: 'not-an-array' },
      { name: 'c', classifierRules: [{ name: 'r' }] },
    ];
    expect(getAllClassifierRules(plugins).map((r) => r.name)).toEqual(['r']);
  });
});

describe('getAllRecoveryStrategies', () => {
  it('merges strategies across plugins, first-plugin-wins on dupes', () => {
    const plugins = [
      { name: 'a', recoveryStrategies: [{ name: 'retry' }, { name: 'fallback' }] },
      { name: 'b', recoveryStrategies: [{ name: 'retry', tag: 'b' }, { name: 'escalate' }] },
    ];
    const merged = getAllRecoveryStrategies(plugins);
    expect(merged.map((s) => s.name)).toEqual(['retry', 'fallback', 'escalate']);
    expect(merged[0].tag).toBeUndefined();
  });
});

// ── plugin-contract.md #6: configSchema runtime validation ─────────────
describe('validatePluginConfigSchemas', () => {
  function makeLogger() {
    const lines = { warn: [], info: [] };
    return {
      logger: {
        warn: (m) => lines.warn.push(m),
        info: (m) => lines.info.push(m),
      },
      lines,
    };
  }

  it('warns when schema requires unset config field', () => {
    const plugins = [{
      name: 'p',
      configSchema: () => ({ type: 'object', required: ['api_key'], properties: {} }),
    }];
    const { logger, lines } = makeLogger();
    const { warnings } = validatePluginConfigSchemas(
      plugins,
      { get: () => null },
      logger,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({ plugin: 'p', missing: ['api_key'] });
    expect(lines.warn.some((m) => m.includes('p: configSchema requires fields not set in config: api_key'))).toBe(true);
  });

  it('does not warn when required fields are present', () => {
    const plugins = [{
      name: 'p',
      configSchema: () => ({ required: ['api_key'] }),
    }];
    const { logger } = makeLogger();
    const { warnings } = validatePluginConfigSchemas(
      plugins,
      { get: (key) => (key === 'api_key' ? 'sk-secret' : null) },
      logger,
    );
    expect(warnings).toEqual([]);
  });

  it('treats empty string as missing', () => {
    const plugins = [{
      name: 'p',
      configSchema: () => ({ required: ['api_key'] }),
    }];
    const { logger } = makeLogger();
    const { warnings } = validatePluginConfigSchemas(
      plugins,
      { get: () => '' },
      logger,
    );
    expect(warnings).toHaveLength(1);
  });

  it('skips plugins without configSchema or empty schema', () => {
    const plugins = [
      { name: 'a' },
      { name: 'b', configSchema: () => null },
      { name: 'c', configSchema: () => ({ type: 'object' }) }, // no required
    ];
    const { logger } = makeLogger();
    const { warnings } = validatePluginConfigSchemas(plugins, { get: () => null }, logger);
    expect(warnings).toEqual([]);
  });

  it('catches throwing configSchema() with warn', () => {
    const plugins = [{
      name: 'broken',
      configSchema: () => { throw new Error('schema is dead'); },
    }];
    const { logger, lines } = makeLogger();
    const { warnings } = validatePluginConfigSchemas(plugins, { get: () => null }, logger);
    expect(warnings).toEqual([]);
    expect(lines.warn.some((m) => m.includes('broken: configSchema() threw: schema is dead'))).toBe(true);
  });

  it('reports multiple missing fields in one warning', () => {
    const plugins = [{
      name: 'p',
      configSchema: () => ({ required: ['a', 'b', 'c'] }),
    }];
    const { logger } = makeLogger();
    const { warnings } = validatePluginConfigSchemas(
      plugins,
      { get: (k) => (k === 'b' ? 'set' : null) },
      logger,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].missing).toEqual(['a', 'c']);
  });
});
