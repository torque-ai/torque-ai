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
});
