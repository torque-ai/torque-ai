'use strict';

const { createPlugin } = require('../index');

describe('model-freshness install — scheduled scan', () => {
  it('registers a daily scheduled task that targets model_freshness_scan_now', () => {
    const scheduleCalls = [];
    const fakeCron = {
      createCronScheduledTask: (spec) => {
        scheduleCalls.push(spec);
        return { id: 'sch-1' };
      },
    };

    const container = {
      get: (name) => {
        if (name === 'cronScheduling') return fakeCron;
        return null;
      },
    };

    const plugin = createPlugin();
    plugin.install(container);

    const scan = scheduleCalls.find((s) => {
      if (!s) return false;
      const toolName = s.task_config && s.task_config.tool_name;
      return toolName === 'model_freshness_scan_now';
    });
    expect(scan).toBeDefined();
    expect(scan.cron_expression).toBe('0 3 * * *');
    expect(scan.name).toBe('model-freshness-daily-scan');
    expect(scan.payload_kind).toBe('task');
    expect(scan.source).toBe('plugin:model-freshness');
  });

  it('honors container.config.scan_hour_local when provided', () => {
    const scheduleCalls = [];
    const fakeCron = {
      createCronScheduledTask: (spec) => {
        scheduleCalls.push(spec);
        return { id: 'sch-1' };
      },
    };

    const container = {
      get: (name) => (name === 'cronScheduling' ? fakeCron : null),
      config: { scan_hour_local: 14 },
    };

    const plugin = createPlugin();
    plugin.install(container);

    expect(scheduleCalls[0].cron_expression).toBe('0 14 * * *');
  });

  it('skips createCronScheduledTask when a schedule with the same name already exists', () => {
    const scheduleCalls = [];
    const fakeCron = {
      getScheduledTask: (name) =>
        name === 'model-freshness-daily-scan' ? { id: 'pre-existing', name } : null,
      createCronScheduledTask: (spec) => {
        scheduleCalls.push(spec);
        return { id: 'sch-should-not-happen' };
      },
    };

    const container = {
      get: (name) => (name === 'cronScheduling' ? fakeCron : null),
    };

    const plugin = createPlugin();
    plugin.install(container);

    expect(scheduleCalls).toHaveLength(0);
  });

  it('is idempotent across repeated install() calls on the same container', () => {
    const rows = new Map();
    const fakeCron = {
      getScheduledTask: (name) => rows.get(name) || null,
      createCronScheduledTask: (spec) => {
        if (rows.has(spec.name)) {
          throw new Error('SCHEDULE_NAME_CONFLICT: duplicate');
        }
        const row = { id: `sch-${rows.size + 1}`, ...spec };
        rows.set(spec.name, row);
        return row;
      },
    };

    const container = {
      get: (name) => (name === 'cronScheduling' ? fakeCron : null),
    };

    const plugin = createPlugin();
    plugin.install(container);
    plugin.install(container);
    plugin.install(container);

    expect(rows.size).toBe(1);
    expect(rows.has('model-freshness-daily-scan')).toBe(true);
  });
});
