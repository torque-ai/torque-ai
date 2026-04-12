'use strict';

const { createHotspotsAnalyzer } = require('../integrations/codebase-study/hotspots');

function createAnalyzer(overrides = {}) {
  return createHotspotsAnalyzer({
    HOTSPOT_LIMIT: 3,
    getSubsystemForFile: (filePath) => ({
      id: filePath.startsWith('client/') ? 'client' : 'server',
      label: filePath.startsWith('client/') ? 'Client' : 'Server',
    }),
    isLikelyEntrypoint: (filePath) => filePath === 'server/app-entry.js' || filePath === 'client/main.jsx',
    ...overrides,
  });
}

describe('createHotspotsAnalyzer', () => {
  it('ranks hotspots by score, respects HOTSPOT_LIMIT, and surfaces reason strings', () => {
    const analyzer = createAnalyzer();
    const hotspots = analyzer.analyzeHotspots({
      entries: [
        {
          file: 'server/app-entry.js',
          deps: ['server/alpha-module.js'],
          exports: ['start'],
        },
        {
          file: 'server/alpha-module.js',
          deps: ['server/delta-module.js', 'server/epsilon-module.js', 'server/zeta-module.js', 'server/eta-module.js'],
          exports: ['run', 'stop'],
        },
        {
          file: 'server/task-service.js',
          deps: ['server/gamma-module.js'],
          exports: ['run'],
        },
        {
          file: 'server/gamma-module.js',
          deps: ['server/alpha-module.js'],
          exports: ['gamma'],
        },
        {
          file: 'server/delta-module.js',
          deps: [],
          exports: ['delta'],
        },
        {
          file: 'server/epsilon-module.js',
          deps: [],
          exports: ['epsilon'],
        },
        {
          file: 'server/zeta-module.js',
          deps: ['server/alpha-module.js'],
          exports: ['zeta'],
        },
        {
          file: 'server/eta-module.js',
          deps: ['server/alpha-module.js', 'server/task-service.js'],
          exports: ['eta'],
        },
        {
          file: 'server/logger.js',
          deps: [],
          exports: ['log'],
        },
      ],
      activeProfile: {
        id: 'generic-javascript-repo',
      },
    });

    expect(hotspots).toHaveLength(3);
    expect(hotspots.map(item => item.file)).toEqual([
      'server/alpha-module.js',
      'server/task-service.js',
      'server/eta-module.js',
    ]);
    expect(hotspots[0]).toEqual(expect.objectContaining({
      file: 'server/alpha-module.js',
      confidence: 'high',
      reason: expect.stringContaining('High fan-in'),
    }));
    expect(hotspots.some(item => item.file === 'server/logger.js')).toBe(false);
  });

  it('uses injected reverse dependencies without recomputing them', () => {
    const analyzer = createAnalyzer();
    const hotspots = analyzer.analyzeHotspots({
      entries: [
        {
          file: 'server/app-entry.js',
          deps: ['server/shared-module.js'],
          exports: ['start'],
        },
        {
          file: 'server/shared-module.js',
          deps: [],
          exports: ['shared'],
        },
      ],
      reverseDeps: new Map([
        ['server/shared-module.js', new Set(['a.js', 'b.js', 'c.js', 'd.js'])],
      ]),
      activeProfile: {
        id: 'generic-javascript-repo',
      },
    });

    expect(hotspots[0]).toEqual(expect.objectContaining({
      file: 'server/shared-module.js',
      inbound_dependents: 4,
      reason: expect.stringContaining('reused by 4 indexed modules'),
    }));
  });

  it('computes reverse dependencies internally when they are omitted', () => {
    const analyzer = createAnalyzer();
    const hotspots = analyzer.analyzeHotspots({
      entries: [
        {
          file: 'server/app-entry.js',
          deps: ['server/shared-module.js'],
          exports: ['start'],
        },
        {
          file: 'server/other-module.js',
          deps: ['server/shared-module.js'],
          exports: ['other'],
        },
        {
          file: 'server/shared-module.js',
          deps: [],
          exports: ['shared'],
        },
      ],
      activeProfile: {
        id: 'generic-javascript-repo',
      },
    });

    const sharedModule = hotspots.find(item => item.file === 'server/shared-module.js');
    expect(sharedModule).toEqual(expect.objectContaining({
      inbound_dependents: 2,
      confidence: 'medium',
    }));
  });

  it('summarizes hotspot counts, role buckets, and top files in order', () => {
    const analyzer = createAnalyzer();

    const summary = analyzer.summarizeHotspots([
      { file: 'server/app-entry.js' },
      { file: 'server/task-service.js' },
      { file: 'server/setup/bootstrapper.js' },
      { file: 'server/task-service.js' },
    ]);

    expect(summary).toEqual({
      count: 4,
      byRoleBucket: {
        entrypoint: 1,
        logic: 2,
        setup: 1,
      },
      topFiles: [
        'server/app-entry.js',
        'server/task-service.js',
        'server/setup/bootstrapper.js',
      ],
    });
  });

  it('keeps low-signal hotspot files out of the ranked result set', () => {
    const analyzer = createAnalyzer();
    const hotspots = analyzer.analyzeHotspots({
      entries: [
        {
          file: 'server/app-entry.js',
          deps: ['server/task-service.js', 'server/logger.js'],
          exports: ['start'],
        },
        {
          file: 'server/task-service.js',
          deps: ['server/shared-module.js'],
          exports: ['run', 'stop'],
        },
        {
          file: 'server/shared-module.js',
          deps: [],
          exports: ['shared'],
        },
        {
          file: 'server/config-module.js',
          deps: ['server/shared-module.js'],
          exports: ['config'],
        },
        {
          file: 'server/logger.js',
          deps: [],
          exports: ['log'],
        },
      ],
      activeProfile: {
        id: 'generic-javascript-repo',
      },
    });

    expect(analyzer.isLowSignalHotspotFile('server/logger.js')).toBe(true);
    expect(hotspots.map(item => item.file)).not.toContain('server/logger.js');
  });
});
