'use strict';
/* global describe, it, expect, afterEach, vi */

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SUBJECT_MODULE = '../policy-engine/adapters/refactor-debt';
const DATABASE_MODULE = '../db/backup-core';
const MATCHERS_MODULE = '../policy-engine/matchers';

const subjectPath = require.resolve(SUBJECT_MODULE);
const databasePath = require.resolve(DATABASE_MODULE);
const matchersPath = require.resolve(MATCHERS_MODULE);
const cryptoPath = require.resolve('crypto');

function clearModuleCache() {
  [
    subjectPath,
    databasePath,
    matchersPath,
    cryptoPath,
  ].forEach((moduleId) => {
    delete require.cache[moduleId];
  });
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function compositeKey(first, second) {
  return `${first}::${second}`;
}

function createMetricRow(overrides = {}) {
  return {
    id: 'metric-1',
    task_id: 'task-1',
    file_path: 'src/file.js',
    cyclomatic_complexity: 1,
    cognitive_complexity: 1,
    lines_of_code: 10,
    function_count: 1,
    max_nesting_depth: 1,
    maintainability_index: 80,
    analyzed_at: '2026-03-11T00:00:00.000Z',
    ...overrides,
  };
}

function createMockMatchers(options = {}) {
  return {
    normalizePath: vi.fn((value) => normalizePath(value)),
    extractChangedFiles: vi.fn((context) => (
      typeof options.extractChangedFiles === 'function'
        ? options.extractChangedFiles(context)
        : (options.extractedChangedFiles === undefined ? null : options.extractedChangedFiles)
    )),
  };
}

function createCryptoMock() {
  const state = {
    algorithms: [],
    updates: [],
    digests: [],
  };

  return {
    __state: state,
    createHash: vi.fn((algorithm) => {
      state.algorithms.push(algorithm);
      let fingerprint = '';
      const hash = {
        update: vi.fn((value) => {
          fingerprint = String(value);
          state.updates.push(fingerprint);
          return hash;
        }),
        digest: vi.fn((encoding) => {
          const digest = `${encoding}:${fingerprint}`;
          state.digests.push(digest);
          return digest;
        }),
      };
      return hash;
    }),
  };
}

function createMockDb(options = {}) {
  const latestMetricForTask = new Map(Object.entries(options.latestMetricForTask || {}));
  const previousMetricForFile = new Map(Object.entries(options.previousMetricForFile || {}));
  const latestMetricsForFile = new Map(Object.entries(options.latestMetricsForFile || {}));
  const backlogItems = new Map(Object.entries(options.backlogItems || {}));
  const state = {
    preparedSql: [],
    latestMetricForTaskCalls: [],
    previousMetricForFileCalls: [],
    latestMetricsForFileCalls: [],
    backlogCalls: [],
    upsertCalls: [],
  };

  return {
    __state: state,
    prepare: vi.fn((sql) => {
      const normalized = normalizeSql(sql);
      state.preparedSql.push(normalized);

      if (normalized.includes('from complexity_metrics') && normalized.includes('where task_id = ?')) {
        return {
          get: vi.fn((taskId, filePath) => {
            state.latestMetricForTaskCalls.push([taskId, filePath]);
            return latestMetricForTask.get(compositeKey(taskId, filePath)) || null;
          }),
        };
      }

      if (normalized.includes('from complexity_metrics') && normalized.includes('id != ?')) {
        return {
          get: vi.fn((filePath, metricId) => {
            state.previousMetricForFileCalls.push([filePath, metricId]);
            return previousMetricForFile.get(compositeKey(filePath, metricId))
              || previousMetricForFile.get(filePath)
              || null;
          }),
        };
      }

      if (normalized.includes('from complexity_metrics') && normalized.includes('limit 2')) {
        return {
          all: vi.fn((filePath) => {
            state.latestMetricsForFileCalls.push(filePath);
            return (latestMetricsForFile.get(filePath) || []).slice();
          }),
        };
      }

      if (normalized.includes('from refactor_backlog_items')) {
        return {
          get: vi.fn((project, filePath) => {
            state.backlogCalls.push([project, filePath]);
            return backlogItems.get(compositeKey(project, filePath)) || null;
          }),
        };
      }

      if (normalized.includes('insert into refactor_hotspots')) {
        return {
          run: vi.fn((...params) => {
            state.upsertCalls.push(params);
            return { changes: 1 };
          }),
        };
      }

      throw new Error(`Unexpected SQL for refactor-debt adapter test: ${normalized}`);
    }),
  };
}

function loadSubject(options = {}) {
  clearModuleCache();

  const database = {
    getDbInstance: vi.fn(() => (
      Object.prototype.hasOwnProperty.call(options, 'dbInstance') ? options.dbInstance : null
    )),
  };
  const matchers = createMockMatchers({
    extractedChangedFiles: options.extractedChangedFiles,
    extractChangedFiles: options.extractChangedFiles,
  });
  const crypto = createCryptoMock();

  installMock('crypto', crypto);
  installMock(DATABASE_MODULE, database);
  installMock(MATCHERS_MODULE, matchers);

  return {
    ...require(SUBJECT_MODULE),
    __mocks: {
      crypto,
      database,
      matchers,
    },
  };
}

function expectedHotspotId(project, filePath) {
  return `refactor-hotspot:hex:${project}:${filePath}`;
}

afterEach(() => {
  clearModuleCache();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('policy-engine/adapters/refactor-debt', () => {
  it('returns empty evidence when changed files normalize to an empty unique set', () => {
    const { collectEvidence, __mocks } = loadSubject();

    expect(collectEvidence(
      { task: { project: 'Torque' } },
      ['  ', null, './', '.\\'],
    )).toEqual({
      hotspots_worsened: [],
      has_backlog_item: false,
      files_checked: 0,
    });
    expect(__mocks.database.getDbInstance).not.toHaveBeenCalled();
    expect(__mocks.matchers.extractChangedFiles).not.toHaveBeenCalled();
  });

  it('uses extracted changed files and returns early when the database handle is unavailable', () => {
    const { collectEvidence, __mocks } = loadSubject({
      extractedChangedFiles: ['src\\refactor.js', './src/refactor.js', ''],
    });
    const taskData = {
      task: {
        project: 'Torque',
      },
    };

    expect(collectEvidence(taskData)).toEqual({
      hotspots_worsened: [],
      has_backlog_item: false,
      files_checked: 1,
    });
    expect(__mocks.matchers.extractChangedFiles).toHaveBeenCalledOnce();
    expect(__mocks.matchers.extractChangedFiles).toHaveBeenCalledWith(taskData);
    expect(__mocks.database.getDbInstance).toHaveBeenCalledOnce();
  });

  it('uses task-specific metrics to record worsening hotspots with a covered backlog item', () => {
    const db = createMockDb({
      latestMetricForTask: {
        [compositeKey('task-now', 'src/refactor-target.js')]: createMetricRow({
          id: 'metric-current',
          task_id: 'task-now',
          file_path: 'src\\refactor-target.js',
          cyclomatic_complexity: '18',
          cognitive_complexity: '24',
          lines_of_code: '150',
          function_count: '6',
          max_nesting_depth: '4',
          maintainability_index: '62',
          analyzed_at: '2026-03-10T08:00:00.000Z',
        }),
      },
      previousMetricForFile: {
        [compositeKey('src/refactor-target.js', 'metric-current')]: createMetricRow({
          id: 'metric-previous',
          task_id: 'task-prev',
          file_path: 'src/refactor-target.js',
          cyclomatic_complexity: 17,
          cognitive_complexity: 20,
          lines_of_code: 148,
          function_count: 5,
          max_nesting_depth: 4,
          maintainability_index: 64,
          analyzed_at: '2026-03-09T08:00:00.000Z',
        }),
      },
      backlogItems: {
        [compositeKey('Torque', 'src/refactor-target.js')]: { id: 'backlog-1', status: 'open' },
      },
    });
    const { collectEvidence, __mocks } = loadSubject({
      dbInstance: db,
    });
    const hotspotId = expectedHotspotId('Torque', 'src/refactor-target.js');

    expect(collectEvidence(
      {
        task: {
          projectId: 'Torque',
          task_id: 'task-now',
        },
      },
      ['src\\refactor-target.js', './src/refactor-target.js'],
    )).toEqual({
      hotspots_worsened: [
        {
          hotspot_id: hotspotId,
          project: 'Torque',
          file_path: 'src/refactor-target.js',
          trend: 'worsening',
          complexity_score: 42,
          backlog_item_exists: true,
          backlog_item_id: 'backlog-1',
          current: {
            id: 'metric-current',
            task_id: 'task-now',
            file_path: 'src/refactor-target.js',
            cyclomatic_complexity: 18,
            cognitive_complexity: 24,
            lines_of_code: 150,
            function_count: 6,
            max_nesting_depth: 4,
            maintainability_index: 62,
            analyzed_at: '2026-03-10T08:00:00.000Z',
          },
          previous: {
            id: 'metric-previous',
            task_id: 'task-prev',
            file_path: 'src/refactor-target.js',
            cyclomatic_complexity: 17,
            cognitive_complexity: 20,
            lines_of_code: 148,
            function_count: 5,
            max_nesting_depth: 4,
            maintainability_index: 64,
            analyzed_at: '2026-03-09T08:00:00.000Z',
          },
        },
      ],
      has_backlog_item: true,
      files_checked: 1,
    });
    expect(db.__state.latestMetricForTaskCalls).toEqual([
      ['task-now', 'src/refactor-target.js'],
    ]);
    expect(db.__state.previousMetricForFileCalls).toEqual([
      ['src/refactor-target.js', 'metric-current'],
    ]);
    expect(db.__state.latestMetricsForFileCalls).toEqual([]);
    expect(db.__state.backlogCalls).toEqual([
      ['Torque', 'src/refactor-target.js'],
    ]);
    expect(db.__state.upsertCalls).toEqual([
      [hotspotId, 'Torque', 'src/refactor-target.js', 42, '2026-03-10T08:00:00.000Z'],
    ]);
    expect(__mocks.matchers.extractChangedFiles).not.toHaveBeenCalled();
    expect(__mocks.crypto.createHash).toHaveBeenCalledOnce();
    expect(__mocks.crypto.__state.algorithms).toEqual(['sha256']);
    expect(__mocks.crypto.__state.updates).toEqual(['Torque:src/refactor-target.js']);
  });

  it('falls back to file history when task metrics are missing and ignores stable, improving, or incomplete history', () => {
    const db = createMockDb({
      latestMetricsForFile: {
        'src/worsening.js': [
          createMetricRow({
            id: 'worsening-current',
            task_id: 'other-task-now',
            file_path: 'src/worsening.js',
            cyclomatic_complexity: 9,
            cognitive_complexity: 12,
            analyzed_at: '2026-03-11T09:00:00.000Z',
          }),
          createMetricRow({
            id: 'worsening-previous',
            task_id: 'other-task-prev',
            file_path: 'src/worsening.js',
            cyclomatic_complexity: 8,
            cognitive_complexity: 12,
            analyzed_at: '2026-03-10T09:00:00.000Z',
          }),
        ],
        'src/stable.js': [
          createMetricRow({
            id: 'stable-current',
            file_path: 'src/stable.js',
            cyclomatic_complexity: 5,
            cognitive_complexity: 7,
          }),
          createMetricRow({
            id: 'stable-previous',
            file_path: 'src/stable.js',
            cyclomatic_complexity: 5,
            cognitive_complexity: 7,
          }),
        ],
        'src/improving.js': [
          createMetricRow({
            id: 'improving-current',
            file_path: 'src/improving.js',
            cyclomatic_complexity: 3,
            cognitive_complexity: 4,
          }),
          createMetricRow({
            id: 'improving-previous',
            file_path: 'src/improving.js',
            cyclomatic_complexity: 4,
            cognitive_complexity: 5,
          }),
        ],
        'src/no-history.js': [
          createMetricRow({
            id: 'no-history-current',
            file_path: 'src/no-history.js',
            cyclomatic_complexity: 11,
            cognitive_complexity: 13,
          }),
        ],
      },
    });
    const { collectEvidence, __mocks } = loadSubject({
      dbInstance: db,
    });
    const evidence = collectEvidence(
      {
        taskId: 'task-fallback',
        project: '   ',
      },
      ['src/worsening.js', 'src/stable.js', 'src/improving.js', 'src/no-history.js'],
    );

    expect(evidence.files_checked).toBe(4);
    expect(evidence.has_backlog_item).toBe(false);
    expect(evidence.hotspots_worsened).toEqual([
      {
        hotspot_id: null,
        project: null,
        file_path: 'src/worsening.js',
        trend: 'worsening',
        complexity_score: 21,
        backlog_item_exists: false,
        backlog_item_id: null,
        current: {
          id: 'worsening-current',
          task_id: 'other-task-now',
          file_path: 'src/worsening.js',
          cyclomatic_complexity: 9,
          cognitive_complexity: 12,
          lines_of_code: 10,
          function_count: 1,
          max_nesting_depth: 1,
          maintainability_index: 80,
          analyzed_at: '2026-03-11T09:00:00.000Z',
        },
        previous: {
          id: 'worsening-previous',
          task_id: 'other-task-prev',
          file_path: 'src/worsening.js',
          cyclomatic_complexity: 8,
          cognitive_complexity: 12,
          lines_of_code: 10,
          function_count: 1,
          max_nesting_depth: 1,
          maintainability_index: 80,
          analyzed_at: '2026-03-10T09:00:00.000Z',
        },
      },
    ]);
    expect(db.__state.latestMetricForTaskCalls).toEqual([
      ['task-fallback', 'src/worsening.js'],
      ['task-fallback', 'src/stable.js'],
      ['task-fallback', 'src/improving.js'],
      ['task-fallback', 'src/no-history.js'],
    ]);
    expect(db.__state.latestMetricsForFileCalls).toEqual([
      'src/worsening.js',
      'src/stable.js',
      'src/improving.js',
      'src/no-history.js',
    ]);
    expect(db.__state.previousMetricForFileCalls).toEqual([]);
    expect(db.__state.backlogCalls).toEqual([]);
    expect(db.__state.upsertCalls).toEqual([]);
    expect(__mocks.crypto.createHash).not.toHaveBeenCalled();
  });

  it('uses history metrics without a task id, falls back to the current time, and requires backlog coverage for every worsening hotspot', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T12:34:56.000Z'));

    const db = createMockDb({
      latestMetricsForFile: {
        'src/open-backlog.js': [
          createMetricRow({
            id: 'open-current',
            task_id: 'task-open',
            file_path: 'src/open-backlog.js',
            cyclomatic_complexity: '10',
            cognitive_complexity: '11',
            analyzed_at: null,
          }),
          createMetricRow({
            id: 'open-previous',
            task_id: 'task-open-prev',
            file_path: 'src/open-backlog.js',
            cyclomatic_complexity: 8,
            cognitive_complexity: 9,
            analyzed_at: '2026-03-10T11:00:00.000Z',
          }),
        ],
        'src/missing-backlog.js': [
          createMetricRow({
            id: 'missing-current',
            task_id: 'task-missing',
            file_path: 'src\\missing-backlog.js',
            cyclomatic_complexity: 7,
            cognitive_complexity: '9',
            analyzed_at: null,
          }),
          createMetricRow({
            id: 'missing-previous',
            task_id: 'task-missing-prev',
            file_path: 'src/missing-backlog.js',
            cyclomatic_complexity: 6,
            cognitive_complexity: 6,
            analyzed_at: '2026-03-10T10:00:00.000Z',
          }),
        ],
      },
      backlogItems: {
        [compositeKey('Torque', 'src/open-backlog.js')]: { id: 'backlog-open', status: 'in_progress' },
      },
    });
    const { collectEvidence, __mocks } = loadSubject({
      dbInstance: db,
      extractedChangedFiles: ['src/open-backlog.js', 'src\\missing-backlog.js'],
    });
    const evidence = collectEvidence({
      project: 'Torque',
    });
    const firstHotspotId = expectedHotspotId('Torque', 'src/open-backlog.js');
    const secondHotspotId = expectedHotspotId('Torque', 'src/missing-backlog.js');

    expect(evidence.files_checked).toBe(2);
    expect(evidence.has_backlog_item).toBe(false);
    expect(evidence.hotspots_worsened).toEqual([
      {
        hotspot_id: firstHotspotId,
        project: 'Torque',
        file_path: 'src/open-backlog.js',
        trend: 'worsening',
        complexity_score: 21,
        backlog_item_exists: true,
        backlog_item_id: 'backlog-open',
        current: {
          id: 'open-current',
          task_id: 'task-open',
          file_path: 'src/open-backlog.js',
          cyclomatic_complexity: 10,
          cognitive_complexity: 11,
          lines_of_code: 10,
          function_count: 1,
          max_nesting_depth: 1,
          maintainability_index: 80,
          analyzed_at: null,
        },
        previous: {
          id: 'open-previous',
          task_id: 'task-open-prev',
          file_path: 'src/open-backlog.js',
          cyclomatic_complexity: 8,
          cognitive_complexity: 9,
          lines_of_code: 10,
          function_count: 1,
          max_nesting_depth: 1,
          maintainability_index: 80,
          analyzed_at: '2026-03-10T11:00:00.000Z',
        },
      },
      {
        hotspot_id: secondHotspotId,
        project: 'Torque',
        file_path: 'src/missing-backlog.js',
        trend: 'worsening',
        complexity_score: 16,
        backlog_item_exists: false,
        backlog_item_id: null,
        current: {
          id: 'missing-current',
          task_id: 'task-missing',
          file_path: 'src/missing-backlog.js',
          cyclomatic_complexity: 7,
          cognitive_complexity: 9,
          lines_of_code: 10,
          function_count: 1,
          max_nesting_depth: 1,
          maintainability_index: 80,
          analyzed_at: null,
        },
        previous: {
          id: 'missing-previous',
          task_id: 'task-missing-prev',
          file_path: 'src/missing-backlog.js',
          cyclomatic_complexity: 6,
          cognitive_complexity: 6,
          lines_of_code: 10,
          function_count: 1,
          max_nesting_depth: 1,
          maintainability_index: 80,
          analyzed_at: '2026-03-10T10:00:00.000Z',
        },
      },
    ]);
    expect(db.__state.latestMetricForTaskCalls).toEqual([]);
    expect(db.__state.latestMetricsForFileCalls).toEqual([
      'src/open-backlog.js',
      'src/missing-backlog.js',
    ]);
    expect(db.__state.backlogCalls).toEqual([
      ['Torque', 'src/open-backlog.js'],
      ['Torque', 'src/missing-backlog.js'],
    ]);
    expect(db.__state.upsertCalls).toEqual([
      [firstHotspotId, 'Torque', 'src/open-backlog.js', 21, '2026-03-11T12:34:56.000Z'],
      [secondHotspotId, 'Torque', 'src/missing-backlog.js', 16, '2026-03-11T12:34:56.000Z'],
    ]);
    expect(__mocks.matchers.extractChangedFiles).toHaveBeenCalledOnce();
    expect(__mocks.crypto.createHash).toHaveBeenCalledTimes(2);
    expect(__mocks.crypto.__state.updates).toEqual([
      'Torque:src/open-backlog.js',
      'Torque:src/missing-backlog.js',
    ]);
  });
});
