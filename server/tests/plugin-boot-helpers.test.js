'use strict';

const {
  mergeExtraPluginNames,
  wirePluginEventHandlers,
  dedupPluginTools,
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
