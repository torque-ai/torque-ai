'use strict';

const {
  mergeExtraPluginNames,
  wirePluginEventHandlers,
  dedupPluginTools,
  installPluginsWithUnloadOnError,
  getAllClassifierRules,
  getAllRecoveryStrategies,
  validatePluginConfigSchemas,
  uninstallAllPlugins,
  aggregatePluginHealth,
  applyPluginMigrations,
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

// ── plugin-contract.md #8: uninstall path on shutdown ──────────────────
describe('uninstallAllPlugins', () => {
  function makeLogger() {
    const lines = { info: [], warn: [] };
    return {
      logger: { info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) },
      lines,
    };
  }

  it('calls uninstall() on each plugin in reverse load order', () => {
    const order = [];
    const plugins = [
      { name: 'a', uninstall: () => order.push('a') },
      { name: 'b', uninstall: () => order.push('b') },
      { name: 'c', uninstall: () => order.push('c') },
    ];
    const { logger } = makeLogger();
    const { uninstalled, failures } = uninstallAllPlugins(plugins, logger);
    // Reverse order: dependents tear down before dependencies
    expect(order).toEqual(['c', 'b', 'a']);
    expect(uninstalled).toEqual(['c', 'b', 'a']);
    expect(failures).toEqual([]);
  });

  it('skips plugins without uninstall()', () => {
    const order = [];
    const plugins = [
      { name: 'has-uninstall', uninstall: () => order.push('has') },
      { name: 'no-uninstall' },
    ];
    const { logger } = makeLogger();
    const { uninstalled, failures } = uninstallAllPlugins(plugins, logger);
    expect(order).toEqual(['has']);
    expect(uninstalled).toEqual(['has']);
    expect(failures).toEqual([]);
  });

  it('continues with other plugins when one uninstall throws', () => {
    const order = [];
    const plugins = [
      { name: 'good-1', uninstall: () => order.push('good-1') },
      { name: 'broken', uninstall: () => { throw new Error('boom'); } },
      { name: 'good-2', uninstall: () => order.push('good-2') },
    ];
    const { logger, lines } = makeLogger();
    const { uninstalled, failures } = uninstallAllPlugins(plugins, logger);
    expect(order).toEqual(['good-2', 'good-1']);
    expect(uninstalled).toEqual(['good-2', 'good-1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({ name: 'broken', error: 'boom' });
    expect(lines.warn.some((m) => m.includes('Plugin uninstall FAILED: broken'))).toBe(true);
  });
});

// ── plugin-contract.md #9: aggregatePluginHealth ───────────────────────
describe('aggregatePluginHealth', () => {
  it('returns ok overall when all plugins report ok', () => {
    const plugins = [
      { name: 'a', health: () => ({ status: 'ok' }) },
      { name: 'b', health: () => ({ status: 'ok', details: 'all good' }) },
    ];
    const result = aggregatePluginHealth(plugins);
    expect(result.overall).toBe('ok');
    expect(result.perPlugin).toEqual([
      { plugin: 'a', status: 'ok', details: null },
      { plugin: 'b', status: 'ok', details: 'all good' },
    ]);
  });

  it('downgrades overall to worst-case across reporting plugins', () => {
    const plugins = [
      { name: 'a', health: () => ({ status: 'ok' }) },
      { name: 'b', health: () => ({ status: 'degraded' }) },
      { name: 'c', health: () => ({ status: 'down', details: 'crashed' }) },
    ];
    const result = aggregatePluginHealth(plugins);
    expect(result.overall).toBe('down');
  });

  it('skips plugins without health() (no contribution to overall)', () => {
    const plugins = [
      { name: 'a' }, // no health
      { name: 'b', health: () => ({ status: 'ok' }) },
    ];
    const result = aggregatePluginHealth(plugins);
    expect(result.overall).toBe('ok');
    expect(result.perPlugin).toHaveLength(1);
    expect(result.perPlugin[0].plugin).toBe('b');
  });

  it('treats throwing health() as unknown', () => {
    const plugins = [
      { name: 'broken', health: () => { throw new Error('boom'); } },
    ];
    const result = aggregatePluginHealth(plugins);
    expect(result.perPlugin[0]).toMatchObject({ plugin: 'broken', status: 'unknown' });
    expect(result.perPlugin[0].details).toContain('health() threw: boom');
  });

  it('treats non-object return as unknown', () => {
    const plugins = [{ name: 'p', health: () => 'ok' }];
    const result = aggregatePluginHealth(plugins);
    expect(result.perPlugin[0].status).toBe('unknown');
  });

  it('treats unknown status string as unknown', () => {
    const plugins = [{ name: 'p', health: () => ({ status: 'gibberish' }) }];
    const result = aggregatePluginHealth(plugins);
    expect(result.perPlugin[0].status).toBe('unknown');
  });

  it('overall is ok when no plugin reports (nothing implements health())', () => {
    const result = aggregatePluginHealth([{ name: 'a' }, { name: 'b' }]);
    expect(result.overall).toBe('ok');
    expect(result.perPlugin).toEqual([]);
  });
});

// ── plugin-contract.md #11: applyPluginMigrations ──────────────────────
describe('applyPluginMigrations', () => {
  function makeLogger() {
    const lines = { info: [], warn: [] };
    return {
      logger: { info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) },
      lines,
    };
  }

  function makeFakeDb() {
    // In-memory plugin_migrations table substitute for unit tests.
    const rows = new Map();
    return {
      rows,
      prepare(sql) {
        const isSelect = /^SELECT/i.test(sql.trim());
        if (isSelect) {
          return {
            get(name) { return rows.has(name) ? { applied_version: rows.get(name) } : undefined; },
          };
        }
        // INSERT ... ON CONFLICT
        return {
          run(name, version /* , ts */) { rows.set(name, version); },
        };
      },
    };
  }

  it('runs migrate(null, currVersion) on first install', () => {
    const calls = [];
    const plugins = [{
      name: 'p',
      version: '1.0.0',
      migrate: (prev, curr) => { calls.push({ prev, curr }); },
    }];
    const db = makeFakeDb();
    const { logger } = makeLogger();
    const { ran, failures } = applyPluginMigrations(plugins, db, logger);
    expect(calls).toEqual([{ prev: null, curr: '1.0.0' }]);
    expect(ran).toEqual([{ plugin: 'p', fromVersion: null, toVersion: '1.0.0' }]);
    expect(failures).toEqual([]);
    expect(db.rows.get('p')).toBe('1.0.0');
  });

  it('skips migrate when version unchanged', () => {
    const calls = [];
    const plugins = [{
      name: 'p',
      version: '1.0.0',
      migrate: (prev, curr) => { calls.push({ prev, curr }); },
    }];
    const db = makeFakeDb();
    db.rows.set('p', '1.0.0'); // already migrated
    const { logger } = makeLogger();
    const { ran } = applyPluginMigrations(plugins, db, logger);
    expect(calls).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('runs migrate(prev, curr) on version change', () => {
    const calls = [];
    const plugins = [{
      name: 'p',
      version: '2.0.0',
      migrate: (prev, curr) => { calls.push({ prev, curr }); },
    }];
    const db = makeFakeDb();
    db.rows.set('p', '1.0.0');
    const { logger } = makeLogger();
    applyPluginMigrations(plugins, db, logger);
    expect(calls).toEqual([{ prev: '1.0.0', curr: '2.0.0' }]);
    expect(db.rows.get('p')).toBe('2.0.0');
  });

  it('does NOT update version when migrate throws (so next boot retries)', () => {
    const plugins = [{
      name: 'p',
      version: '2.0.0',
      migrate: () => { throw new Error('migration broken'); },
    }];
    const db = makeFakeDb();
    db.rows.set('p', '1.0.0');
    const { logger, lines } = makeLogger();
    const { ran, failures } = applyPluginMigrations(plugins, db, logger);
    expect(ran).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({ plugin: 'p', error: 'migration broken' });
    expect(db.rows.get('p')).toBe('1.0.0'); // unchanged — retry next boot
    expect(lines.warn.some((m) => m.includes('Plugin migration FAILED: p') && m.includes('1.0.0 → 2.0.0') && m.includes('will retry next boot'))).toBe(true);
  });

  it('skips plugins without migrate()', () => {
    const plugins = [{ name: 'p', version: '1.0.0' }];
    const db = makeFakeDb();
    const { logger } = makeLogger();
    const { ran } = applyPluginMigrations(plugins, db, logger);
    expect(ran).toEqual([]);
    expect(db.rows.size).toBe(0);
  });

  it('warns when db is unavailable', () => {
    const plugins = [{ name: 'p', version: '1.0.0', migrate: () => {} }];
    const { logger, lines } = makeLogger();
    const { ran } = applyPluginMigrations(plugins, null, logger);
    expect(ran).toEqual([]);
    expect(lines.warn.some((m) => m.includes('db unavailable'))).toBe(true);
  });
});

// ── plugin-contract.md #10: structured validation errors ──────────────
describe('validatePlugin (structured errors)', () => {
  const { validatePlugin, formatValidationErrors } = require('../plugins/plugin-contract');

  it('returns structured error objects for missing required fields', () => {
    const result = validatePlugin({ name: 'p' }); // missing version, install, etc.
    expect(result.valid).toBe(false);
    const versionErr = result.errors.find((e) => e.field === 'version');
    expect(versionErr).toEqual({
      field: 'version',
      expected: 'string',
      actual: 'undefined',
      kind: 'missing',
      message: 'missing required field: version',
    });
  });

  it('returns kind=type-mismatch when field type is wrong', () => {
    const plugin = {
      name: 'p',
      version: '1.0',
      install: 'not-a-function', // wrong type
      uninstall: () => {},
      middleware: () => [],
      mcpTools: () => [],
      eventHandlers: () => ({}),
      configSchema: () => ({}),
    };
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(false);
    const installErr = result.errors.find((e) => e.field === 'install');
    expect(installErr).toMatchObject({
      field: 'install',
      expected: 'function',
      actual: 'string',
      kind: 'type-mismatch',
    });
  });

  it('returns kind=malformed-input for non-object plugin', () => {
    const result = validatePlugin(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      field: '$root',
      expected: 'object',
      actual: 'null',
      kind: 'malformed-input',
    });
  });

  it('formatValidationErrors produces back-compat string output', () => {
    const errors = [
      { field: 'version', kind: 'missing', message: 'missing required field: version' },
      { field: 'install', kind: 'type-mismatch', message: 'install must be a function' },
    ];
    expect(formatValidationErrors(errors)).toBe(
      'missing required field: version, install must be a function'
    );
  });

  it('formatValidationErrors accepts legacy string entries (mixed)', () => {
    expect(formatValidationErrors(['old style', { message: 'new style' }])).toBe(
      'old style, new style'
    );
  });

  it('valid plugin returns empty errors array', () => {
    const plugin = {
      name: 'p', version: '1.0',
      install: () => {}, uninstall: () => {},
      middleware: () => [], mcpTools: () => [],
      eventHandlers: () => ({}), configSchema: () => ({}),
    };
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
