'use strict';

const path = require('path');
const fs = require('fs');
const { createConfigMock } = require('./test-helpers');

const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');

const VERIFICATION_SUBJECT_MODULE = '../policy-engine/adapters/verification';
const REFACTOR_DEBT_SUBJECT_MODULE = '../policy-engine/adapters/refactor-debt';
const MATCHERS_MODULE = '../policy-engine/matchers';
const DATABASE_MODULE = '../db/backup-core';
const PROFILE_STORE_MODULE = '../policy-engine/profile-store';
const PROFILE_LOADER_MODULE = '../policy-engine/profile-loader';
const EVALUATION_STORE_MODULE = '../policy-engine/evaluation-store';
const ENGINE_MODULE = '../policy-engine/engine';

const VERIFICATION_POLICY_ID = 'verification_required_for_code_changes';
const REFACTOR_POLICY_ID = 'refactor_backlog_required_for_hotspot_worsening';
function resolvePolicyFixtureRoot() {
  const preferredRoot = path.resolve(__dirname, '..', '..');
  const preferredPath = path.join(preferredRoot, 'artifacts', 'policy', 'config', 'torque-dev-policy.seed.json');
  if (fs.existsSync(preferredPath)) {
    return preferredRoot;
  }

  const fallbackRoot = path.resolve(__dirname, '..', '..', '..', 'Torque');
  const fallbackPath = path.join(fallbackRoot, 'artifacts', 'policy', 'config', 'torque-dev-policy.seed.json');
  if (fs.existsSync(fallbackPath)) {
    return fallbackRoot;
  }

  return preferredRoot;
}

const projectRoot = resolvePolicyFixtureRoot();
const realMatchers = require(MATCHERS_MODULE);

const UNIT_MODULES = [
  VERIFICATION_SUBJECT_MODULE,
  REFACTOR_DEBT_SUBJECT_MODULE,
  MATCHERS_MODULE,
  DATABASE_MODULE,
  'crypto',
];

const INTEGRATION_MODULES = [
  DATABASE_MODULE,
  PROFILE_STORE_MODULE,
  PROFILE_LOADER_MODULE,
  EVALUATION_STORE_MODULE,
  ENGINE_MODULE,
  VERIFICATION_SUBJECT_MODULE,
  REFACTOR_DEBT_SUBJECT_MODULE,
  MATCHERS_MODULE,
];

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModuleCaches(modulePaths) {
  for (const modulePath of modulePaths) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that have not been loaded yet.
    }
  }
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function createEmptyCategories() {
  return {
    code: [],
    test: [],
    schema: [],
    docs: [],
    config: [],
  };
}

function getEvidence(evidence, type) {
  return evidence.find((entry) => entry.type === type);
}

function toEvidenceMap(evidence) {
  return Object.fromEntries(evidence.map((entry) => [entry.type, entry]));
}

function loadVerificationSubject(options = {}) {
  clearModuleCaches([VERIFICATION_SUBJECT_MODULE, MATCHERS_MODULE]);

  const matchers = {
    normalizePath: vi.fn(options.normalizePath || ((value) => realMatchers.normalizePath(value))),
    extractChangedFiles: vi.fn(
      options.extractChangedFiles || ((context) => realMatchers.extractChangedFiles(context)),
    ),
    matchesAnyGlob: vi.fn(
      options.matchesAnyGlob || ((candidate, globs) => realMatchers.matchesAnyGlob(candidate, globs)),
    ),
  };

  installMock(MATCHERS_MODULE, matchers);

  return {
    ...require(VERIFICATION_SUBJECT_MODULE),
    __mocks: {
      matchers,
    },
  };
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

function createRefactorMatchersMock(options = {}) {
  return {
    normalizePath: vi.fn((value) => normalizePath(value)),
    extractChangedFiles: vi.fn((context) => {
      if (typeof options.extractChangedFiles === 'function') {
        return options.extractChangedFiles(context);
      }
      if (Object.prototype.hasOwnProperty.call(options, 'extractedChangedFiles')) {
        return options.extractedChangedFiles;
      }
      return null;
    }),
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
          const digest = `hex:${fingerprint}:${encoding}`;
          state.digests.push(digest);
          return digest;
        }),
      };
      return hash;
    }),
  };
}

function createRefactorDb(options = {}) {
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

      throw new Error(`Unexpected SQL for refactor-debt test: ${normalized}`);
    }),
  };
}

function loadRefactorDebtSubject(options = {}) {
  clearModuleCaches([REFACTOR_DEBT_SUBJECT_MODULE, DATABASE_MODULE, MATCHERS_MODULE, 'crypto']);

  const database = Object.prototype.hasOwnProperty.call(options, 'database')
    ? options.database
    : (
      options.omitGetDbInstance
        ? {}
        : {
            getConfig: vi.fn().mockImplementation(createConfigMock()),
            getDbInstance: vi.fn(() => (
              Object.prototype.hasOwnProperty.call(options, 'dbInstance') ? options.dbInstance : null
            )),
          }
    );
  const matchers = createRefactorMatchersMock({
    extractedChangedFiles: options.extractedChangedFiles,
    extractChangedFiles: options.extractChangedFiles,
  });
  const crypto = createCryptoMock();

  installMock('crypto', crypto);
  installMock(DATABASE_MODULE, database);
  installMock(MATCHERS_MODULE, matchers);

  return {
    ...require(REFACTOR_DEBT_SUBJECT_MODULE),
    __mocks: {
      database,
      matchers,
      crypto,
    },
  };
}

function createTask(db, testDir, id, overrides = {}) {
  db.createTask({
    id,
    task_description: overrides.task_description || `Task ${id}`,
    status: overrides.status || 'completed',
    provider: overrides.provider || 'codex',
    working_directory: overrides.working_directory || testDir,
    project: overrides.project || 'Torque',
    ...overrides,
  });
  return id;
}

function seedComplexityMetric({
  taskId,
  filePath,
  cyclomatic,
  cognitive,
  analyzedAt,
  linesOfCode = 100,
  functionCount = 4,
  maxNestingDepth = 3,
  maintainabilityIndex = 70,
}) {
  rawDb().prepare(`
    INSERT INTO complexity_metrics (
      task_id, file_path, cyclomatic_complexity, cognitive_complexity,
      lines_of_code, function_count, max_nesting_depth, maintainability_index, analyzed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    filePath,
    cyclomatic,
    cognitive,
    linesOfCode,
    functionCount,
    maxNestingDepth,
    maintainabilityIndex,
    analyzedAt,
  );
}

function seedBacklogItem({
  id,
  project = 'Torque',
  filePath,
  status = 'open',
  hotspotId = null,
  taskId = null,
}) {
  rawDb().prepare(`
    INSERT INTO refactor_backlog_items (
      id, project, file_path, hotspot_id, description, status, priority, task_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    project,
    filePath,
    hotspotId,
    `Refactor ${filePath}`,
    status,
    5,
    taskId,
  );
}

function seedPolicy(profileStore, {
  profileId,
  ruleId,
  name = ruleId,
  category = 'quality',
  stage = 'task_complete',
  mode = 'advisory',
  matcher = { type: 'always' },
  requiredEvidence = [],
  overridePolicy = {},
  actions = [],
  project = null,
}) {
  profileStore.savePolicyProfile({
    id: profileId,
    name: profileId,
    project,
    defaults: { mode: 'advisory' },
    enabled: true,
  });

  profileStore.savePolicyRule({
    id: ruleId,
    name,
    category,
    stage,
    mode,
    priority: 100,
    matcher,
    required_evidence: requiredEvidence,
    actions,
    override_policy: overridePolicy,
    enabled: true,
  });

  profileStore.savePolicyBinding({
    id: `${profileId}:${ruleId}`,
    profile_id: profileId,
    policy_id: ruleId,
    enabled: true,
  });
}

describe('policy adapters verify/refactor combined coverage', () => {
  describe('verification adapter', () => {
    afterEach(() => {
      clearModuleCaches([VERIFICATION_SUBJECT_MODULE, MATCHERS_MODULE]);
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.clearAllMocks();
    });

    it('returns unavailable evidence when verification metadata and changed files are missing', () => {
      const { collectVerificationEvidence, __mocks } = loadVerificationSubject();

      const evidence = collectVerificationEvidence({});

      expect(__mocks.matchers.extractChangedFiles).toHaveBeenCalledWith({});
      expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
        type: 'verify_command_passed',
        available: false,
        satisfied: false,
      });
      expect(getEvidence(evidence, 'test_command_passed')).toEqual({
        type: 'test_command_passed',
        available: false,
        satisfied: false,
      });
      expect(getEvidence(evidence, 'build_command_passed')).toEqual({
        type: 'build_command_passed',
        available: false,
        satisfied: false,
      });
      expect(getEvidence(evidence, 'changed_files_classified')).toEqual({
        type: 'changed_files_classified',
        available: false,
        satisfied: false,
        value: [],
        categories: createEmptyCategories(),
        by_file: [],
        unclassified: [],
      });
    });

    it('normalizes truthy verification status values', () => {
      const { collectVerificationEvidence } = loadVerificationSubject();

      const evidence = collectVerificationEvidence({
        task: {
          verification_passed: ' passed ',
          test_passed: 'YES',
          build_passed: ' enabled ',
        },
      });

      expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
        type: 'verify_command_passed',
        available: true,
        satisfied: true,
      });
      expect(getEvidence(evidence, 'test_command_passed')).toEqual({
        type: 'test_command_passed',
        available: true,
        satisfied: true,
      });
      expect(getEvidence(evidence, 'build_command_passed')).toEqual({
        type: 'build_command_passed',
        available: true,
        satisfied: true,
      });
    });

    it('normalizes falsey verification status values', () => {
      const { collectVerificationEvidence } = loadVerificationSubject();

      const evidence = collectVerificationEvidence({
        task: {
          verification_passed: ' failed ',
          test_passed: 'off',
          build_passed: ' no ',
        },
      });

      expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
        type: 'verify_command_passed',
        available: true,
        satisfied: false,
      });
      expect(getEvidence(evidence, 'test_command_passed')).toEqual({
        type: 'test_command_passed',
        available: true,
        satisfied: false,
      });
      expect(getEvidence(evidence, 'build_command_passed')).toEqual({
        type: 'build_command_passed',
        available: true,
        satisfied: false,
      });
    });

    it('normalizes numeric verification status values including negative numbers', () => {
      const { collectVerificationEvidence } = loadVerificationSubject();

      const evidence = collectVerificationEvidence({
        task: {
          verification_passed: -1,
          test_passed: 0,
          build_passed: 3,
        },
      });

      expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
        type: 'verify_command_passed',
        available: true,
        satisfied: true,
      });
      expect(getEvidence(evidence, 'test_command_passed')).toEqual({
        type: 'test_command_passed',
        available: true,
        satisfied: false,
      });
      expect(getEvidence(evidence, 'build_command_passed')).toEqual({
        type: 'build_command_passed',
        available: true,
        satisfied: true,
      });
    });

    it('treats blank and unrecognized verification values as unavailable', () => {
      const { collectVerificationEvidence } = loadVerificationSubject();

      const evidence = collectVerificationEvidence({
        task: {
          verification_passed: '  ',
          test_passed: 'sometimes',
          build_passed: { passed: true },
        },
      });

      expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
        type: 'verify_command_passed',
        available: false,
        satisfied: false,
      });
      expect(getEvidence(evidence, 'test_command_passed')).toEqual({
        type: 'test_command_passed',
        available: false,
        satisfied: false,
      });
      expect(getEvidence(evidence, 'build_command_passed')).toEqual({
        type: 'build_command_passed',
        available: false,
        satisfied: false,
      });
    });

    it('treats non-object task metadata as missing', () => {
      const { collectVerificationEvidence } = loadVerificationSubject();

      const evidence = collectVerificationEvidence({
        task: 'not-an-object',
      });

      expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
        type: 'verify_command_passed',
        available: false,
        satisfied: false,
      });
    });

    it('prefers matcher-extracted changed files over task fallbacks', () => {
      const { collectVerificationEvidence } = loadVerificationSubject({
        extractChangedFiles: () => ['docs/from-matcher.md'],
      });

      const changedFiles = getEvidence(
        collectVerificationEvidence({
          task: {
            changed_files: ['assets/logo.png'],
          },
        }),
        'changed_files_classified',
      );

      expect(changedFiles).toMatchObject({
        type: 'changed_files_classified',
        available: true,
        satisfied: true,
        value: ['docs/from-matcher.md'],
        unclassified: [],
      });
      expect(changedFiles.categories.docs).toEqual(['docs/from-matcher.md']);
    });

    it('falls back to task.changed_files and filters blank entries', () => {
      const { collectVerificationEvidence, __mocks } = loadVerificationSubject({
        extractChangedFiles: () => null,
      });

      const changedFiles = getEvidence(
        collectVerificationEvidence({
          task: {
            changed_files: ['server\\docs\\guide.md', '', null, './server/package-lock.json'],
          },
        }),
        'changed_files_classified',
      );

      expect(__mocks.matchers.extractChangedFiles).toHaveBeenCalledOnce();
      expect(changedFiles).toEqual({
        type: 'changed_files_classified',
        available: true,
        satisfied: true,
        value: ['server/docs/guide.md', 'server/package-lock.json'],
        categories: {
          code: [],
          test: [],
          schema: [],
          docs: ['server/docs/guide.md'],
          config: ['server/package-lock.json'],
        },
        by_file: [
          { path: 'server/docs/guide.md', categories: ['docs'] },
          { path: 'server/package-lock.json', categories: ['config'] },
        ],
        unclassified: [],
      });
    });

    it('falls back to task.changedFiles when matcher extraction does not return an array', () => {
      const { collectVerificationEvidence } = loadVerificationSubject({
        extractChangedFiles: () => 'not-an-array',
      });

      const changedFiles = getEvidence(
        collectVerificationEvidence({
          task: {
            changedFiles: ['README.md'],
          },
        }),
        'changed_files_classified',
      );

      expect(changedFiles).toEqual({
        type: 'changed_files_classified',
        available: true,
        satisfied: true,
        value: ['README.md'],
        categories: {
          code: [],
          test: [],
          schema: [],
          docs: ['README.md'],
          config: [],
        },
        by_file: [
          { path: 'README.md', categories: ['docs'] },
        ],
        unclassified: [],
      });
    });

    it('falls back to task.files_modified when other changed file sources are unavailable', () => {
      const { collectVerificationEvidence } = loadVerificationSubject({
        extractChangedFiles: () => undefined,
      });

      const changedFiles = getEvidence(
        collectVerificationEvidence({
          task: {
            files_modified: ['src\\feature.js', 'tests\\feature.spec.js'],
          },
        }),
        'changed_files_classified',
      );

      expect(changedFiles).toMatchObject({
        available: true,
        satisfied: true,
        value: ['src/feature.js', 'tests/feature.spec.js'],
        categories: {
          code: ['src/feature.js', 'tests/feature.spec.js'],
          test: ['tests/feature.spec.js'],
          schema: [],
          docs: [],
          config: [],
        },
      });
    });

    it('marks changed-file evidence unavailable when task fallback values are not arrays', () => {
      const { collectVerificationEvidence } = loadVerificationSubject({
        extractChangedFiles: () => null,
      });

      const changedFiles = getEvidence(
        collectVerificationEvidence({
          task: {
            changed_files: 'src/app.js',
            changedFiles: 'src/other.js',
            files_modified: 'src/third.js',
          },
        }),
        'changed_files_classified',
      );

      expect(changedFiles).toEqual({
        type: 'changed_files_classified',
        available: false,
        satisfied: false,
        value: [],
        categories: createEmptyCategories(),
        by_file: [],
        unclassified: [],
      });
    });

    it('treats an empty extracted changed-file list as available and satisfied', () => {
      const { collectVerificationEvidence } = loadVerificationSubject({
        extractChangedFiles: () => [],
      });

      const changedFiles = getEvidence(
        collectVerificationEvidence({ changed_files: ['src/app.js'] }),
        'changed_files_classified',
      );

      expect(changedFiles).toEqual({
        type: 'changed_files_classified',
        available: true,
        satisfied: true,
        value: [],
        categories: createEmptyCategories(),
        by_file: [],
        unclassified: [],
      });
    });

    it('classifies overlapping category matches across code, test, schema, docs, and config', () => {
      const { collectVerificationEvidence } = loadVerificationSubject();

      const changedFiles = getEvidence(
        collectVerificationEvidence({
          changed_files: [
            'server\\policy-engine\\adapters\\verification.js',
            'server/tests/user-schema.test.js',
            'server/db/migrations/001-init.sql',
            'docs/README.md',
            'server/package.json',
          ],
        }),
        'changed_files_classified',
      );

      expect(changedFiles).toMatchObject({
        available: true,
        satisfied: true,
        value: [
          'server/policy-engine/adapters/verification.js',
          'server/tests/user-schema.test.js',
          'server/db/migrations/001-init.sql',
          'docs/README.md',
          'server/package.json',
        ],
        unclassified: [],
      });
      expect(changedFiles.categories).toEqual({
        code: [
          'server/policy-engine/adapters/verification.js',
          'server/tests/user-schema.test.js',
        ],
        test: ['server/tests/user-schema.test.js'],
        schema: [
          'server/tests/user-schema.test.js',
          'server/db/migrations/001-init.sql',
        ],
        docs: ['docs/README.md'],
        config: ['server/package.json'],
      });
      expect(changedFiles.by_file).toEqual([
        {
          path: 'server/policy-engine/adapters/verification.js',
          categories: ['code'],
        },
        {
          path: 'server/tests/user-schema.test.js',
          categories: ['code', 'test', 'schema'],
        },
        {
          path: 'server/db/migrations/001-init.sql',
          categories: ['schema'],
        },
        {
          path: 'docs/README.md',
          categories: ['docs'],
        },
        {
          path: 'server/package.json',
          categories: ['config'],
        },
      ]);
    });

    it('marks changed-file evidence unsatisfied when any files are unclassified', () => {
      const { collectVerificationEvidence } = loadVerificationSubject();

      const changedFiles = getEvidence(
        collectVerificationEvidence({
          changed_files: ['assets/logo.png', 'README.md'],
        }),
        'changed_files_classified',
      );

      expect(changedFiles).toMatchObject({
        available: true,
        satisfied: false,
        value: ['assets/logo.png', 'README.md'],
        unclassified: ['assets/logo.png'],
      });
      expect(changedFiles.by_file).toEqual([
        { path: 'assets/logo.png', categories: [] },
        { path: 'README.md', categories: ['docs'] },
      ]);
    });

    it('classifies root-level documentation and config patterns', () => {
      const { collectVerificationEvidence } = loadVerificationSubject();

      const changedFiles = getEvidence(
        collectVerificationEvidence({
          changed_files: [
            'CHANGELOG.md',
            'LICENSE',
            '.env.local',
            'Dockerfile',
            'docker-compose.prod.yml',
            'tsconfig.base.json',
          ],
        }),
        'changed_files_classified',
      );

      expect(changedFiles).toMatchObject({
        available: true,
        satisfied: true,
        unclassified: [],
      });
      expect(changedFiles.categories.docs).toEqual(['CHANGELOG.md', 'LICENSE']);
      expect(changedFiles.categories.config).toEqual([
        '.env.local',
        'Dockerfile',
        'docker-compose.prod.yml',
        'tsconfig.base.json',
      ]);
    });

    it('preserves category order for multi-match files', () => {
      const { collectVerificationEvidence } = loadVerificationSubject();

      const changedFiles = getEvidence(
        collectVerificationEvidence({
          changed_files: ['tests/schema-change.test.js'],
        }),
        'changed_files_classified',
      );

      expect(changedFiles.by_file).toEqual([
        {
          path: 'tests/schema-change.test.js',
          categories: ['code', 'test', 'schema'],
        },
      ]);
    });

    it('preserves duplicate changed files when matcher extraction returns them directly', () => {
      const { collectVerificationEvidence } = loadVerificationSubject({
        extractChangedFiles: () => ['docs/readme.md', 'docs/readme.md'],
      });

      const changedFiles = getEvidence(
        collectVerificationEvidence({}),
        'changed_files_classified',
      );

      expect(changedFiles.value).toEqual(['docs/readme.md', 'docs/readme.md']);
      expect(changedFiles.categories.docs).toEqual(['docs/readme.md', 'docs/readme.md']);
      expect(changedFiles.by_file).toHaveLength(2);
    });
  });

  describe('refactor debt adapter', () => {
    afterEach(() => {
      clearModuleCaches([REFACTOR_DEBT_SUBJECT_MODULE, DATABASE_MODULE, MATCHERS_MODULE, 'crypto']);
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.clearAllMocks();
    });

    it('returns empty evidence when changed files normalize to an empty unique set', () => {
      const { collectEvidence, __mocks } = loadRefactorDebtSubject();

      expect(collectEvidence(
        { project: 'Torque' },
        ['  ', null, './', '.\\'],
      )).toEqual({
        hotspots_worsened: [],
        has_backlog_item: false,
        files_checked: 0,
      });
      expect(__mocks.matchers.extractChangedFiles).not.toHaveBeenCalled();
      expect(__mocks.database.getDbInstance).not.toHaveBeenCalled();
    });

    it('uses explicit changed files over extracted files and dedupes normalized paths', () => {
      const { collectEvidence, __mocks } = loadRefactorDebtSubject({
        extractedChangedFiles: ['src/ignored.js'],
      });

      expect(collectEvidence(
        { task: { project: 'Torque' } },
        ['src\\dup.js', './src/dup.js', 'src/other.js'],
      )).toEqual({
        hotspots_worsened: [],
        has_backlog_item: false,
        files_checked: 2,
      });
      expect(__mocks.matchers.extractChangedFiles).not.toHaveBeenCalled();
      expect(__mocks.database.getDbInstance).toHaveBeenCalledOnce();
    });

    it('uses extracted changed files and returns early when the database handle is unavailable', () => {
      const { collectEvidence, __mocks } = loadRefactorDebtSubject({
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
      expect(__mocks.matchers.extractChangedFiles).toHaveBeenCalledWith(taskData);
      expect(__mocks.database.getDbInstance).toHaveBeenCalledOnce();
    });

    it('returns an empty result when neither explicit nor extracted changed files are arrays', () => {
      const { collectEvidence, __mocks } = loadRefactorDebtSubject({
        extractChangedFiles: () => 'not-an-array',
      });

      expect(collectEvidence({ project: 'Torque' })).toEqual({
        hotspots_worsened: [],
        has_backlog_item: false,
        files_checked: 0,
      });
      expect(__mocks.matchers.extractChangedFiles).toHaveBeenCalledOnce();
      expect(__mocks.database.getDbInstance).not.toHaveBeenCalled();
    });

    it('returns early when the database module exposes no getDbInstance helper', () => {
      const { collectEvidence } = loadRefactorDebtSubject({
        omitGetDbInstance: true,
      });

      expect(collectEvidence(
        { project: 'Torque' },
        ['src/needs-db.js'],
      )).toEqual({
        hotspots_worsened: [],
        has_backlog_item: false,
        files_checked: 1,
      });
    });

    it('uses nested project and task aliases when recording a worsening hotspot', () => {
      const db = createRefactorDb({
        latestMetricForTask: {
          [compositeKey('task-alias', 'src/alias.js')]: createMetricRow({
            id: 'metric-current',
            task_id: 'task-alias',
            file_path: 'src\\alias.js',
            cyclomatic_complexity: 18,
            cognitive_complexity: 20,
            analyzed_at: '2026-03-10T08:00:00.000Z',
          }),
        },
        previousMetricForFile: {
          [compositeKey('src/alias.js', 'metric-current')]: createMetricRow({
            id: 'metric-previous',
            task_id: 'task-prev',
            file_path: 'src/alias.js',
            cyclomatic_complexity: 16,
            cognitive_complexity: 19,
            analyzed_at: '2026-03-09T08:00:00.000Z',
          }),
        },
        backlogItems: {
          [compositeKey('Torque', 'src/alias.js')]: { id: 'backlog-1', status: 'open' },
        },
      });
      const { collectEvidence, __mocks } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      const evidence = collectEvidence(
        {
          task: {
            project_id: 'Torque',
            taskId: 'task-alias',
          },
        },
        ['src\\alias.js'],
      );

      expect(evidence).toEqual({
        hotspots_worsened: [
          {
            hotspot_id: 'refactor-hotspot:hex:Torque:src/alias.js:hex',
            project: 'Torque',
            file_path: 'src/alias.js',
            trend: 'worsening',
            complexity_score: 38,
            backlog_item_exists: true,
            backlog_item_id: 'backlog-1',
            current: {
              id: 'metric-current',
              task_id: 'task-alias',
              file_path: 'src/alias.js',
              cyclomatic_complexity: 18,
              cognitive_complexity: 20,
              lines_of_code: 10,
              function_count: 1,
              max_nesting_depth: 1,
              maintainability_index: 80,
              analyzed_at: '2026-03-10T08:00:00.000Z',
            },
            previous: {
              id: 'metric-previous',
              task_id: 'task-prev',
              file_path: 'src/alias.js',
              cyclomatic_complexity: 16,
              cognitive_complexity: 19,
              lines_of_code: 10,
              function_count: 1,
              max_nesting_depth: 1,
              maintainability_index: 80,
              analyzed_at: '2026-03-09T08:00:00.000Z',
            },
          },
        ],
        has_backlog_item: true,
        files_checked: 1,
      });
      expect(db.__state.latestMetricForTaskCalls).toEqual([
        ['task-alias', 'src/alias.js'],
      ]);
      expect(db.__state.previousMetricForFileCalls).toEqual([
        ['src/alias.js', 'metric-current'],
      ]);
      expect(__mocks.crypto.__state.updates).toEqual(['Torque:src/alias.js']);
    });

    it('skips hotspot creation when the task-specific current metric has no previous comparison', () => {
      const db = createRefactorDb({
        latestMetricForTask: {
          [compositeKey('task-1', 'src/no-previous.js')]: createMetricRow({
            id: 'metric-current',
            task_id: 'task-1',
            file_path: 'src/no-previous.js',
            cyclomatic_complexity: 8,
            cognitive_complexity: 9,
          }),
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      expect(collectEvidence(
        { taskId: 'task-1', project: 'Torque' },
        ['src/no-previous.js'],
      )).toEqual({
        hotspots_worsened: [],
        has_backlog_item: false,
        files_checked: 1,
      });
      expect(db.__state.previousMetricForFileCalls).toEqual([
        ['src/no-previous.js', 'metric-current'],
      ]);
      expect(db.__state.latestMetricsForFileCalls).toEqual([]);
      expect(db.__state.upsertCalls).toEqual([]);
    });

    it('falls back to file history when task-specific metrics are missing', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/history.js': [
            createMetricRow({
              id: 'current',
              task_id: 'task-history',
              file_path: 'src/history.js',
              cyclomatic_complexity: 9,
              cognitive_complexity: 12,
              analyzed_at: '2026-03-11T09:00:00.000Z',
            }),
            createMetricRow({
              id: 'previous',
              task_id: 'task-history-prev',
              file_path: 'src/history.js',
              cyclomatic_complexity: 7,
              cognitive_complexity: 10,
              analyzed_at: '2026-03-10T09:00:00.000Z',
            }),
          ],
        },
        backlogItems: {
          [compositeKey('Torque', 'src/history.js')]: { id: 'backlog-history', status: 'in_progress' },
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      const evidence = collectEvidence(
        { task_id: 'task-current', projectId: 'Torque' },
        ['src/history.js'],
      );

      expect(evidence.hotspots_worsened).toHaveLength(1);
      expect(evidence.hotspots_worsened[0]).toMatchObject({
        file_path: 'src/history.js',
        trend: 'worsening',
        backlog_item_exists: true,
      });
      expect(db.__state.latestMetricForTaskCalls).toEqual([
        ['task-current', 'src/history.js'],
      ]);
      expect(db.__state.latestMetricsForFileCalls).toEqual(['src/history.js']);
    });

    it('uses file history directly when no task id is available', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/no-task-id.js': [
            createMetricRow({
              id: 'current',
              file_path: 'src/no-task-id.js',
              cyclomatic_complexity: 6,
              cognitive_complexity: 8,
            }),
            createMetricRow({
              id: 'previous',
              file_path: 'src/no-task-id.js',
              cyclomatic_complexity: 4,
              cognitive_complexity: 7,
            }),
          ],
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      const evidence = collectEvidence(
        { project: '   ' },
        ['src/no-task-id.js'],
      );

      expect(evidence.hotspots_worsened).toHaveLength(1);
      expect(db.__state.latestMetricForTaskCalls).toEqual([]);
      expect(db.__state.latestMetricsForFileCalls).toEqual(['src/no-task-id.js']);
    });

    it('skips stable history', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/stable.js': [
            createMetricRow({
              id: 'current',
              file_path: 'src/stable.js',
              cyclomatic_complexity: 5,
              cognitive_complexity: 7,
            }),
            createMetricRow({
              id: 'previous',
              file_path: 'src/stable.js',
              cyclomatic_complexity: 5,
              cognitive_complexity: 7,
            }),
          ],
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      expect(collectEvidence({}, ['src/stable.js'])).toEqual({
        hotspots_worsened: [],
        has_backlog_item: false,
        files_checked: 1,
      });
    });

    it('skips improving history', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/improving.js': [
            createMetricRow({
              id: 'current',
              file_path: 'src/improving.js',
              cyclomatic_complexity: 3,
              cognitive_complexity: 4,
            }),
            createMetricRow({
              id: 'previous',
              file_path: 'src/improving.js',
              cyclomatic_complexity: 4,
              cognitive_complexity: 5,
            }),
          ],
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      expect(collectEvidence({}, ['src/improving.js'])).toEqual({
        hotspots_worsened: [],
        has_backlog_item: false,
        files_checked: 1,
      });
    });

    it('treats mixed complexity deltas as worsening when either tracked metric increases', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/mixed-delta.js': [
            createMetricRow({
              id: 'current',
              file_path: 'src/mixed-delta.js',
              cyclomatic_complexity: 11,
              cognitive_complexity: 9,
            }),
            createMetricRow({
              id: 'previous',
              file_path: 'src/mixed-delta.js',
              cyclomatic_complexity: 10,
              cognitive_complexity: 12,
            }),
          ],
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      const evidence = collectEvidence({}, ['src/mixed-delta.js']);

      expect(evidence.hotspots_worsened).toHaveLength(1);
      expect(evidence.hotspots_worsened[0]).toMatchObject({
        trend: 'worsening',
        complexity_score: 20,
      });
    });

    it('skips files with incomplete history', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/no-history.js': [
            createMetricRow({
              id: 'current',
              file_path: 'src/no-history.js',
              cyclomatic_complexity: 11,
              cognitive_complexity: 13,
            }),
          ],
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      expect(collectEvidence({}, ['src/no-history.js'])).toEqual({
        hotspots_worsened: [],
        has_backlog_item: false,
        files_checked: 1,
      });
    });

    it('does not upsert or query backlog when project data is unavailable', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/no-project.js': [
            createMetricRow({
              id: 'current',
              file_path: 'src/no-project.js',
              cyclomatic_complexity: 9,
              cognitive_complexity: 10,
            }),
            createMetricRow({
              id: 'previous',
              file_path: 'src/no-project.js',
              cyclomatic_complexity: 7,
              cognitive_complexity: 8,
            }),
          ],
        },
      });
      const { collectEvidence, __mocks } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      const evidence = collectEvidence(
        { project: '   ' },
        ['src/no-project.js'],
      );

      expect(evidence.hotspots_worsened).toEqual([
        expect.objectContaining({
          hotspot_id: null,
          project: null,
          file_path: 'src/no-project.js',
          backlog_item_exists: false,
          backlog_item_id: null,
        }),
      ]);
      expect(db.__state.backlogCalls).toEqual([]);
      expect(db.__state.upsertCalls).toEqual([]);
      expect(__mocks.crypto.createHash).not.toHaveBeenCalled();
    });

    it('uses the current time when the latest worsening metric has no analyzed_at timestamp', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T12:34:56.000Z'));

      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/no-timestamp.js': [
            createMetricRow({
              id: 'current',
              file_path: 'src/no-timestamp.js',
              cyclomatic_complexity: 6,
              cognitive_complexity: 9,
              analyzed_at: null,
            }),
            createMetricRow({
              id: 'previous',
              file_path: 'src/no-timestamp.js',
              cyclomatic_complexity: 5,
              cognitive_complexity: 8,
              analyzed_at: '2026-03-10T11:00:00.000Z',
            }),
          ],
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      collectEvidence(
        { project: 'Torque' },
        ['src/no-timestamp.js'],
      );

      expect(db.__state.upsertCalls).toEqual([
        ['refactor-hotspot:hex:Torque:src/no-timestamp.js:hex', 'Torque', 'src/no-timestamp.js', 15, '2026-03-11T12:34:56.000Z'],
      ]);
    });

    it('sets has_backlog_item to true only when every worsening hotspot has backlog coverage', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/covered-one.js': [
            createMetricRow({
              id: 'covered-one-current',
              file_path: 'src/covered-one.js',
              cyclomatic_complexity: 7,
              cognitive_complexity: 9,
            }),
            createMetricRow({
              id: 'covered-one-previous',
              file_path: 'src/covered-one.js',
              cyclomatic_complexity: 5,
              cognitive_complexity: 8,
            }),
          ],
          'src/covered-two.js': [
            createMetricRow({
              id: 'covered-two-current',
              file_path: 'src/covered-two.js',
              cyclomatic_complexity: 6,
              cognitive_complexity: 7,
            }),
            createMetricRow({
              id: 'covered-two-previous',
              file_path: 'src/covered-two.js',
              cyclomatic_complexity: 4,
              cognitive_complexity: 6,
            }),
          ],
        },
        backlogItems: {
          [compositeKey('Torque', 'src/covered-one.js')]: { id: 'backlog-1', status: 'open' },
          [compositeKey('Torque', 'src/covered-two.js')]: { id: 'backlog-2', status: 'in_progress' },
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      const evidence = collectEvidence(
        { project: 'Torque' },
        ['src/covered-one.js', 'src/covered-two.js'],
      );

      expect(evidence.hotspots_worsened).toHaveLength(2);
      expect(evidence.has_backlog_item).toBe(true);
    });

    it('sets has_backlog_item to false when any worsening hotspot lacks backlog coverage', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/covered.js': [
            createMetricRow({
              id: 'covered-current',
              file_path: 'src/covered.js',
              cyclomatic_complexity: 8,
              cognitive_complexity: 9,
            }),
            createMetricRow({
              id: 'covered-previous',
              file_path: 'src/covered.js',
              cyclomatic_complexity: 7,
              cognitive_complexity: 8,
            }),
          ],
          'src/missing.js': [
            createMetricRow({
              id: 'missing-current',
              file_path: 'src/missing.js',
              cyclomatic_complexity: 10,
              cognitive_complexity: 11,
            }),
            createMetricRow({
              id: 'missing-previous',
              file_path: 'src/missing.js',
              cyclomatic_complexity: 9,
              cognitive_complexity: 10,
            }),
          ],
        },
        backlogItems: {
          [compositeKey('Torque', 'src/covered.js')]: { id: 'backlog-covered', status: 'open' },
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      const evidence = collectEvidence(
        { project: 'Torque' },
        ['src/covered.js', 'src/missing.js'],
      );

      expect(evidence.hotspots_worsened).toHaveLength(2);
      expect(evidence.has_backlog_item).toBe(false);
      expect(evidence.hotspots_worsened).toEqual([
        expect.objectContaining({
          file_path: 'src/covered.js',
          backlog_item_exists: true,
        }),
        expect.objectContaining({
          file_path: 'src/missing.js',
          backlog_item_exists: false,
        }),
      ]);
    });

    it('ignores backlog rows outside the open and in_progress policy statuses', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/closed-backlog.js': [
            createMetricRow({
              id: 'current',
              file_path: 'src/closed-backlog.js',
              cyclomatic_complexity: 7,
              cognitive_complexity: 10,
            }),
            createMetricRow({
              id: 'previous',
              file_path: 'src/closed-backlog.js',
              cyclomatic_complexity: 6,
              cognitive_complexity: 8,
            }),
          ],
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      const evidence = collectEvidence(
        { project: 'Torque' },
        ['src/closed-backlog.js'],
      );

      expect(evidence.hotspots_worsened).toEqual([
        expect.objectContaining({
          file_path: 'src/closed-backlog.js',
          backlog_item_exists: false,
          backlog_item_id: null,
        }),
      ]);
    });

    it('normalizes numeric strings and garbage metric values into snapshot numbers and score', () => {
      const db = createRefactorDb({
        latestMetricsForFile: {
          'src/numeric.js': [
            createMetricRow({
              id: 'current',
              task_id: 'task-current',
              file_path: 'src\\numeric.js',
              cyclomatic_complexity: 'not-a-number',
              cognitive_complexity: '4',
              lines_of_code: 'bad',
              function_count: '2',
              max_nesting_depth: '3',
              maintainability_index: 'nope',
              analyzed_at: '2026-03-11T09:00:00.000Z',
            }),
            createMetricRow({
              id: 'previous',
              task_id: 'task-previous',
              file_path: 'src/numeric.js',
              cyclomatic_complexity: 0,
              cognitive_complexity: 3,
              lines_of_code: 9,
              function_count: 1,
              max_nesting_depth: 1,
              maintainability_index: 75,
              analyzed_at: '2026-03-10T09:00:00.000Z',
            }),
          ],
        },
      });
      const { collectEvidence } = loadRefactorDebtSubject({
        dbInstance: db,
      });

      const evidence = collectEvidence(
        { project: 'Torque' },
        ['src/numeric.js'],
      );

      expect(evidence.hotspots_worsened).toEqual([
        {
          hotspot_id: 'refactor-hotspot:hex:Torque:src/numeric.js:hex',
          project: 'Torque',
          file_path: 'src/numeric.js',
          trend: 'worsening',
          complexity_score: 4,
          backlog_item_exists: false,
          backlog_item_id: null,
          current: {
            id: 'current',
            task_id: 'task-current',
            file_path: 'src/numeric.js',
            cyclomatic_complexity: 0,
            cognitive_complexity: 4,
            lines_of_code: 0,
            function_count: 2,
            max_nesting_depth: 3,
            maintainability_index: 0,
            analyzed_at: '2026-03-11T09:00:00.000Z',
          },
          previous: {
            id: 'previous',
            task_id: 'task-previous',
            file_path: 'src/numeric.js',
            cyclomatic_complexity: 0,
            cognitive_complexity: 3,
            lines_of_code: 9,
            function_count: 1,
            max_nesting_depth: 1,
            maintainability_index: 75,
            analyzed_at: '2026-03-10T09:00:00.000Z',
          },
        },
      ]);
    });
  });

  describe('adapter-backed policy outcomes', () => {
    let db;
    let testDir;
    let engine;
    let profileStore;
    let evaluationStore;
    let loadTorqueDefaults;
    let verificationAdapter;

    beforeEach(() => {
      clearModuleCaches([...UNIT_MODULES, ...INTEGRATION_MODULES]);
      ({ db, testDir } = setupTestDbOnly('policy-adapters-verify-refactor'));
      installMock(DATABASE_MODULE, {
        getDbInstance: vi.fn(() => rawDb()),
      });
      engine = require(ENGINE_MODULE);
      profileStore = require(PROFILE_STORE_MODULE);
      profileStore.setDb(rawDb());
      evaluationStore = require(EVALUATION_STORE_MODULE);
      evaluationStore.setDb(rawDb());
      ({ loadTorqueDefaults } = require(PROFILE_LOADER_MODULE));
      verificationAdapter = require(VERIFICATION_SUBJECT_MODULE);
    });

    afterEach(() => {
      if (profileStore && typeof profileStore.setDb === 'function') {
        profileStore.setDb(null);
      }
      if (evaluationStore && typeof evaluationStore.setDb === 'function') {
        evaluationStore.setDb(null);
      }
      teardownTestDb();
      clearModuleCaches(INTEGRATION_MODULES);
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.clearAllMocks();
    });

    it('passes a verification policy when the adapter reports satisfied verification evidence', () => {
      seedPolicy(profileStore, {
        profileId: 'verification-pass-profile',
        ruleId: VERIFICATION_POLICY_ID,
        stage: 'task_complete',
        mode: 'block',
        matcher: { type: 'path_glob', patterns: ['**/*.js'] },
        requiredEvidence: [{ type: 'verify_command_passed' }],
      });

      const result = engine.evaluatePolicies({
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-verify-pass',
        changed_files: ['src/app.js'],
        evidence: toEvidenceMap(verificationAdapter.collectVerificationEvidence({
          task: { verification_passed: true },
          changed_files: ['src/app.js'],
        })),
      });

      expect(result.summary).toMatchObject({
        passed: 1,
        failed: 0,
        blocked: 0,
      });
      expect(result.results[0]).toMatchObject({
        policy_id: VERIFICATION_POLICY_ID,
        outcome: 'pass',
        mode: 'block',
        severity: null,
      });
    });

    it('blocks when verification evidence fails under block mode', () => {
      seedPolicy(profileStore, {
        profileId: 'verification-block-profile',
        ruleId: VERIFICATION_POLICY_ID,
        stage: 'task_complete',
        mode: 'block',
        matcher: { type: 'path_glob', patterns: ['**/*.js'] },
        requiredEvidence: [{ type: 'verify_command_passed' }],
      });

      const result = engine.evaluatePolicies({
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-verify-block',
        changed_files: ['src/app.js'],
        evidence: toEvidenceMap(verificationAdapter.collectVerificationEvidence({
          task: { verification_passed: false },
          changed_files: ['src/app.js'],
        })),
      });

      expect(result.summary).toMatchObject({
        failed: 0,
        warned: 0,
        blocked: 1,
      });
      expect(result.results[0]).toMatchObject({
        policy_id: VERIFICATION_POLICY_ID,
        outcome: 'fail',
        mode: 'block',
        severity: 'error',
        message: 'required evidence failed: verify_command_passed',
      });
    });

    it('warns when verification evidence fails under warn mode', () => {
      seedPolicy(profileStore, {
        profileId: 'verification-warn-profile',
        ruleId: VERIFICATION_POLICY_ID,
        stage: 'task_complete',
        mode: 'warn',
        matcher: { type: 'path_glob', patterns: ['**/*.js'] },
        requiredEvidence: [{ type: 'verify_command_passed' }],
      });

      const result = engine.evaluatePolicies({
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-verify-warn',
        changed_files: ['src/app.js'],
        evidence: toEvidenceMap(verificationAdapter.collectVerificationEvidence({
          task: { verification_passed: false },
          changed_files: ['src/app.js'],
        })),
      });

      expect(result.summary).toMatchObject({
        failed: 0,
        warned: 1,
        blocked: 0,
      });
      expect(result.results[0]).toMatchObject({
        outcome: 'fail',
        mode: 'warn',
        severity: 'warning',
      });
    });

    it('supports override-based exemption for verification policy failures', () => {
      seedPolicy(profileStore, {
        profileId: 'verification-override-profile',
        ruleId: VERIFICATION_POLICY_ID,
        stage: 'task_complete',
        mode: 'block',
        matcher: { type: 'path_glob', patterns: ['**/*.js'] },
        requiredEvidence: [{ type: 'verify_command_passed' }],
        overridePolicy: { allowed: true, reason_codes: ['approved_exception'] },
      });

      const result = engine.evaluatePolicies({
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-verify-override',
        changed_files: ['src/app.js'],
        evidence: toEvidenceMap(verificationAdapter.collectVerificationEvidence({
          task: { verification_passed: false },
          changed_files: ['src/app.js'],
        })),
        override_decisions: [
          {
            policy_id: VERIFICATION_POLICY_ID,
            decision: 'override',
            reason_code: 'approved_exception',
          },
        ],
      });

      expect(result.summary).toMatchObject({
        overridden: 1,
        failed: 0,
        blocked: 0,
      });
      expect(result.results[0]).toMatchObject({
        outcome: 'overridden',
        message: 'required evidence failed: verify_command_passed',
      });
    });

    it.skipIf(!fs.existsSync(path.join(projectRoot, 'artifacts', 'policy', 'config', 'torque-dev-policy.seed.json')))('warns when refactor debt worsens without backlog coverage in advisory mode', () => {
      loadTorqueDefaults(projectRoot);
      createTask(db, testDir, 'task-refactor-prev');
      createTask(db, testDir, 'task-refactor-now');
      seedComplexityMetric({
        taskId: 'task-refactor-prev',
        filePath: 'server/policy-engine/refactor-target.js',
        cyclomatic: 10,
        cognitive: 18,
        analyzedAt: '2026-03-09T11:00:00.000Z',
      });
      seedComplexityMetric({
        taskId: 'task-refactor-now',
        filePath: 'server/policy-engine/refactor-target.js',
        cyclomatic: 15,
        cognitive: 27,
        analyzedAt: '2026-03-10T11:00:00.000Z',
      });

      const result = engine.evaluatePolicies({
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-refactor-now',
        project_id: 'Torque',
        project_path: testDir,
        changed_files: ['server/policy-engine/refactor-target.js'],
      });

      expect(result.summary).toMatchObject({
        failed: 0,
        warned: 1,
        blocked: 0,
      });
      expect(result.results.find((entry) => entry.policy_id === REFACTOR_POLICY_ID)).toMatchObject({
        outcome: 'fail',
        mode: 'advisory',
        severity: 'warning',
      });
    });

    it('blocks when refactor debt worsens without backlog coverage in block mode', () => {
      seedPolicy(profileStore, {
        profileId: 'refactor-block-profile',
        ruleId: REFACTOR_POLICY_ID,
        stage: 'task_complete',
        mode: 'block',
        matcher: { type: 'always' },
        requiredEvidence: [{ type: REFACTOR_POLICY_ID }],
      });
      createTask(db, testDir, 'task-refactor-prev');
      createTask(db, testDir, 'task-refactor-now');
      seedComplexityMetric({
        taskId: 'task-refactor-prev',
        filePath: 'src/refactor-block.js',
        cyclomatic: 9,
        cognitive: 14,
        analyzedAt: '2026-03-09T12:00:00.000Z',
      });
      seedComplexityMetric({
        taskId: 'task-refactor-now',
        filePath: 'src/refactor-block.js',
        cyclomatic: 13,
        cognitive: 22,
        analyzedAt: '2026-03-10T12:00:00.000Z',
      });

      const result = engine.evaluatePolicies({
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-refactor-now',
        project_id: 'Torque',
        project_path: testDir,
        changed_files: ['src/refactor-block.js'],
      });

      expect(result.summary).toMatchObject({
        failed: 0,
        warned: 0,
        blocked: 1,
      });
      expect(result.results[0]).toMatchObject({
        policy_id: REFACTOR_POLICY_ID,
        outcome: 'fail',
        mode: 'block',
        severity: 'error',
      });
    });

    it('passes when refactor debt worsens but every hotspot has a backlog item', () => {
      seedPolicy(profileStore, {
        profileId: 'refactor-pass-profile',
        ruleId: REFACTOR_POLICY_ID,
        stage: 'task_complete',
        mode: 'block',
        matcher: { type: 'always' },
        requiredEvidence: [{ type: REFACTOR_POLICY_ID }],
      });
      createTask(db, testDir, 'task-refactor-prev');
      createTask(db, testDir, 'task-refactor-now');
      seedComplexityMetric({
        taskId: 'task-refactor-prev',
        filePath: 'src/refactor-pass.js',
        cyclomatic: 10,
        cognitive: 15,
        analyzedAt: '2026-03-09T13:00:00.000Z',
      });
      seedComplexityMetric({
        taskId: 'task-refactor-now',
        filePath: 'src/refactor-pass.js',
        cyclomatic: 12,
        cognitive: 19,
        analyzedAt: '2026-03-10T13:00:00.000Z',
      });
      seedBacklogItem({
        id: 'backlog-refactor-pass',
        filePath: 'src/refactor-pass.js',
        status: 'open',
        taskId: 'task-refactor-now',
      });

      const result = engine.evaluatePolicies({
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-refactor-now',
        project_id: 'Torque',
        project_path: testDir,
        changed_files: ['src/refactor-pass.js'],
      });

      expect(result.summary).toMatchObject({
        passed: 1,
        failed: 0,
        blocked: 0,
      });
      expect(result.results[0]).toMatchObject({
        policy_id: REFACTOR_POLICY_ID,
        outcome: 'pass',
      });
    });

    it('supports override-based exemption for refactor debt policy failures', () => {
      seedPolicy(profileStore, {
        profileId: 'refactor-override-profile',
        ruleId: REFACTOR_POLICY_ID,
        stage: 'task_complete',
        mode: 'block',
        matcher: { type: 'always' },
        requiredEvidence: [{ type: REFACTOR_POLICY_ID }],
        overridePolicy: { allowed: true, reason_codes: ['approved_exception'] },
      });
      createTask(db, testDir, 'task-refactor-prev');
      createTask(db, testDir, 'task-refactor-now');
      seedComplexityMetric({
        taskId: 'task-refactor-prev',
        filePath: 'src/refactor-override.js',
        cyclomatic: 8,
        cognitive: 12,
        analyzedAt: '2026-03-09T14:00:00.000Z',
      });
      seedComplexityMetric({
        taskId: 'task-refactor-now',
        filePath: 'src/refactor-override.js',
        cyclomatic: 12,
        cognitive: 20,
        analyzedAt: '2026-03-10T14:00:00.000Z',
      });

      const result = engine.evaluatePolicies({
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-refactor-now',
        project_id: 'Torque',
        project_path: testDir,
        changed_files: ['src/refactor-override.js'],
        override_decisions: [
          {
            policy_id: REFACTOR_POLICY_ID,
            decision: 'override',
            reason_code: 'approved_exception',
          },
        ],
      });

      expect(result.summary).toMatchObject({
        overridden: 1,
        failed: 0,
        blocked: 0,
      });
      expect(result.results[0]).toMatchObject({
        policy_id: REFACTOR_POLICY_ID,
        outcome: 'overridden',
        message: 'required evidence failed: refactor_backlog_required_for_hotspot_worsening',
      });
    });
  });
});
