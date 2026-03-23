import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

const { installMock } = require('./cjs-mock');

const SUBJECT_MODULE = '../policy-engine/adapters/feature-flag';
const DATABASE_MODULE = '../db/backup-core';
const MATCHERS_MODULE = '../policy-engine/matchers';
const FS_MODULE = 'fs';
const CRYPTO_MODULE = 'crypto';

const subjectPath = require.resolve(SUBJECT_MODULE);
const databasePath = require.resolve(DATABASE_MODULE);
const matchersPath = require.resolve(MATCHERS_MODULE);
const fsPath = require.resolve(FS_MODULE);
const cryptoPath = require.resolve(CRYPTO_MODULE);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clearModuleCaches() {
  [
    subjectPath,
    databasePath,
    matchersPath,
    fsPath,
    cryptoPath,
  ].forEach((moduleId) => {
    delete require.cache[moduleId];
  });
}

function normalizePathValue(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function createMockMatchers(options = {}) {
  const normalizePathImpl = options.normalizePathImpl || ((value) => normalizePathValue(value));
  const extractedChangedFiles = hasOwn(options, 'extractedChangedFiles')
    ? options.extractedChangedFiles
    : null;

  return {
    normalizePath: vi.fn((value) => normalizePathImpl(value)),
    extractChangedFiles: vi.fn(() => extractedChangedFiles),
  };
}

function createMockFs(entries = {}) {
  const files = new Map(
    Object.entries(entries).map(([filePath, entry]) => [normalizePathValue(filePath), entry]),
  );

  function lookup(filePath) {
    return files.get(normalizePathValue(filePath));
  }

  return {
    statSync: vi.fn((filePath) => {
      const entry = lookup(filePath);
      if (!entry || entry.statError) {
        throw entry?.statError || new Error(`ENOENT: ${filePath}`);
      }

      return {
        isFile: () => entry.isFile !== false,
        size: hasOwn(entry, 'size')
          ? entry.size
          : Buffer.byteLength(entry.content || '', 'utf8'),
      };
    }),
    readFileSync: vi.fn((filePath, encoding) => {
      const entry = lookup(filePath);
      if (!entry || entry.readError) {
        throw entry?.readError || new Error(`ENOENT: ${filePath}`);
      }
      if (encoding !== 'utf8') {
        throw new Error(`Unexpected encoding: ${encoding}`);
      }
      return entry.content;
    }),
  };
}

function createMockDb() {
  const deleteRuns = [];
  const insertRuns = [];
  const deleteStatement = {
    run: vi.fn((taskId) => {
      deleteRuns.push(taskId);
      return { changes: 1 };
    }),
  };
  const insertStatement = {
    run: vi.fn((...params) => {
      insertRuns.push(params);
      return { changes: 1 };
    }),
  };

  return {
    prepare: vi.fn((sql) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized === 'DELETE FROM feature_flag_evidence WHERE task_id = ?') {
        return deleteStatement;
      }
      if (normalized.startsWith('INSERT INTO feature_flag_evidence')) {
        return insertStatement;
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    }),
    __deleteRuns: deleteRuns,
    __insertRuns: insertRuns,
    __deleteStatement: deleteStatement,
    __insertStatement: insertStatement,
  };
}

function loadSubject(options = {}) {
  const mockFs = options.mockFs || createMockFs(options.files);
  const mockDb = hasOwn(options, 'dbHandle') ? options.dbHandle : createMockDb();
  const mockDatabase = options.database || {
    getDbInstance: vi.fn(() => mockDb),
  };
  const mockMatchers = options.mockMatchers || createMockMatchers({
    extractedChangedFiles: options.extractedChangedFiles,
    normalizePathImpl: options.normalizePathImpl,
  });

  let uuidCounter = 0;
  const randomUUID = options.randomUUID || vi.fn(() => `uuid-${++uuidCounter}`);

  clearModuleCaches();
  installMock(FS_MODULE, mockFs);
  installMock(CRYPTO_MODULE, { randomUUID });
  installMock(DATABASE_MODULE, mockDatabase);
  installMock(MATCHERS_MODULE, mockMatchers);

  return {
    ...require(SUBJECT_MODULE),
    mockFs,
    mockDb,
    mockDatabase,
    mockMatchers,
    randomUUID,
  };
}

function flagPairs(evidence) {
  return evidence.feature_flags_found.map((finding) => [finding.flag_type, finding.flag_name]);
}

function collectSingleFile(options = {}) {
  const filePath = options.filePath || 'src/example.js';
  const hasWorkingDirectory = hasOwn(options, 'workingDirectory');
  const workingDirectory = hasWorkingDirectory
    ? options.workingDirectory
    : path.join(process.cwd(), '.tmp-policy-feature-flags');
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : workingDirectory
      ? path.join(workingDirectory, filePath)
      : path.resolve(filePath);

  const { subjectOptions = {}, extraFiles = {}, fileEntry = {} } = options;
  const loaded = loadSubject({
    ...subjectOptions,
    files: {
      [absolutePath]: {
        content: options.content || '',
        ...fileEntry,
      },
      ...extraFiles,
    },
  });

  const taskData = hasOwn(options, 'taskData')
    ? options.taskData
    : (workingDirectory ? { working_directory: workingDirectory } : {});
  const changedFiles = hasOwn(options, 'changedFiles') ? options.changedFiles : [filePath];

  return {
    ...loaded,
    evidence: loaded.collectEvidence(taskData, changedFiles),
    absolutePath,
    workingDirectory,
  };
}

beforeEach(() => {
  clearModuleCaches();
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

afterEach(() => {
  clearModuleCaches();
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('policy-engine/adapters/feature-flag', () => {
  describe('collectEvidence', () => {
    describe('changed file resolution', () => {
      it('returns empty evidence when changed files are unavailable', () => {
        const { collectEvidence, mockDatabase, mockFs, mockMatchers } = loadSubject({
          dbHandle: null,
          extractedChangedFiles: null,
        });

        expect(collectEvidence()).toEqual({
          user_visible_changes: [],
          feature_flags_found: [],
          has_feature_flag: false,
        });
        expect(mockMatchers.extractChangedFiles).toHaveBeenCalledWith({});
        expect(mockFs.statSync).not.toHaveBeenCalled();
        expect(mockDatabase.getDbInstance).toHaveBeenCalledOnce();
      });

      it('prefers explicit changedFiles, normalizes duplicates, and persists findings', () => {
        const workingDirectory = path.join(process.cwd(), '.tmp-policy-feature-flags-explicit');
        const filePath = 'server/routes/dashboard.js';
        const absolutePath = path.join(workingDirectory, filePath);
        const { collectEvidence, mockDb, mockFs, mockMatchers } = loadSubject({
          extractedChangedFiles: ['ignored/by/matcher.js'],
          files: {
            [absolutePath]: {
              content: [
                'if (process.env.FEATURE_ALPHA) {}',
                'if (process.env.FEATURE_ALPHA) {}',
                'app.get("/dashboard", handler);',
              ].join('\n'),
            },
          },
        });

        const evidence = collectEvidence(
          {
            id: ' task-explicit ',
            working_directory: ` ${workingDirectory} `,
          },
          ['./server\\routes\\dashboard.js', 'server/routes/dashboard.js'],
        );

        expect(mockMatchers.extractChangedFiles).not.toHaveBeenCalled();
        expect(mockFs.statSync).toHaveBeenCalledOnce();
        expect(evidence).toEqual({
          user_visible_changes: [
            {
              file_path: filePath,
              reasons: ['surface_path', 'http_handler_registration'],
            },
          ],
          feature_flags_found: [
            {
              file_path: filePath,
              flag_name: 'FEATURE_ALPHA',
              flag_type: 'env',
              match: 'process.env.FEATURE_ALPHA',
            },
          ],
          has_feature_flag: true,
        });
        expect(mockDb.__deleteRuns).toEqual(['task-explicit']);
        expect(mockDb.__insertRuns).toEqual([
          ['uuid-1', 'task-explicit', filePath, 'FEATURE_ALPHA', 'env'],
        ]);
      });

      it('uses extracted changed files when explicit changedFiles are absent', () => {
        const workingDirectory = path.join(process.cwd(), '.tmp-policy-feature-flags-extracted');
        const filePath = 'client/components/FeaturePanel.jsx';
        const absolutePath = path.join(workingDirectory, filePath);
        const { collectEvidence, mockMatchers } = loadSubject({
          extractedChangedFiles: [filePath, `./${filePath}`, filePath],
          files: {
            [absolutePath]: {
              content: [
                'if (featureFlags.isEnabled("panel-rollout")) {}',
                'export default function FeaturePanel() {}',
              ].join('\n'),
            },
          },
        });

        const evidence = collectEvidence({
          task: {
            working_directory: workingDirectory,
          },
        });

        expect(mockMatchers.extractChangedFiles).toHaveBeenCalledOnce();
        expect(evidence).toEqual({
          user_visible_changes: [
            {
              file_path: filePath,
              reasons: ['surface_path', 'react_component_export'],
            },
          ],
          feature_flags_found: [
            {
              file_path: filePath,
              flag_name: 'panel-rollout',
              flag_type: 'feature_flags',
              match: 'featureFlags.isEnabled("panel-rollout")',
            },
          ],
          has_feature_flag: true,
        });
      });

      it('filters out changed files whose normalized paths are blank', () => {
        const workingDirectory = path.join(process.cwd(), '.tmp-policy-feature-flags-filtered');
        const filePath = 'src/keep.js';
        const absolutePath = path.join(workingDirectory, filePath);
        const mockMatchers = createMockMatchers({
          extractedChangedFiles: ['skip.js', filePath],
          normalizePathImpl: (value) => {
            if (value === 'skip.js') return '';
            return normalizePathValue(value);
          },
        });
        const { collectEvidence, mockFs } = loadSubject({
          mockMatchers,
          files: {
            [absolutePath]: {
              content: 'if (process.env.FEATURE_KEEP) {}',
            },
          },
        });

        const evidence = collectEvidence({
          workingDirectory: workingDirectory,
        });

        expect(evidence.feature_flags_found).toHaveLength(1);
        expect(evidence.feature_flags_found[0]).toMatchObject({
          file_path: filePath,
          flag_name: 'FEATURE_KEEP',
          flag_type: 'env',
        });
        expect(mockFs.statSync).toHaveBeenCalledOnce();
      });
    });

    describe('working directory resolution', () => {
      it.each([
        ['workingDirectory', (workingDirectory) => ({ workingDirectory })],
        ['project_path', (workingDirectory) => ({ project_path: workingDirectory })],
        ['projectPath', (workingDirectory) => ({ projectPath: workingDirectory })],
        ['task.working_directory', (workingDirectory) => ({ task: { working_directory: workingDirectory } })],
        ['task.workingDirectory', (workingDirectory) => ({ task: { workingDirectory } })],
        ['task.project_path', (workingDirectory) => ({ task: { project_path: workingDirectory } })],
        ['task.projectPath', (workingDirectory) => ({ task: { projectPath: workingDirectory } })],
      ])('reads relative files using %s', (_label, createTaskData) => {
        const workingDirectory = path.join(process.cwd(), '.tmp-policy-feature-flags-alias');
        const filePath = 'api/routes/alias.js';
        const absolutePath = path.join(workingDirectory, filePath);
        const { collectEvidence, mockFs } = loadSubject({
          files: {
            [absolutePath]: {
              content: 'if (process.env.FEATURE_ALIAS) {}',
            },
          },
        });

        const evidence = collectEvidence(createTaskData(workingDirectory), [filePath]);

        expect(evidence.has_feature_flag).toBe(true);
        expect(mockFs.statSync).toHaveBeenCalledWith(absolutePath);
        expect(flagPairs(evidence)).toEqual([['env', 'FEATURE_ALIAS']]);
      });

      it('resolves relative files from the current working directory when no working directory is provided', () => {
        const filePath = 'tmp/policy-feature-flag-relative.js';
        const absolutePath = path.resolve(filePath);
        const { evidence, mockFs } = collectSingleFile({
          filePath,
          content: 'export async function GET() {}',
          taskData: {},
          workingDirectory: null,
        });

        expect(mockFs.statSync).toHaveBeenCalledWith(absolutePath);
        expect(evidence.user_visible_changes).toEqual([
          {
            file_path: normalizePathValue(filePath),
            reasons: ['http_handler_export'],
          },
        ]);
      });

      it('uses absolute changed files as-is without joining them to a working directory', () => {
        const absoluteFile = normalizePathValue(path.join(
          process.cwd(),
          '.tmp-policy-feature-flags-absolute',
          'components',
          'AbsolutePanel.jsx',
        ));
        const { collectEvidence, mockFs } = loadSubject({
          files: {
            [absoluteFile]: {
              content: 'export default function AbsolutePanel() {}',
            },
          },
        });

        const evidence = collectEvidence(
          {
            working_directory: path.join(process.cwd(), 'should-not-be-used'),
          },
          [absoluteFile],
        );

        expect(mockFs.statSync).toHaveBeenCalledWith(absoluteFile);
        expect(evidence.user_visible_changes).toEqual([
          {
            file_path: absoluteFile,
            reasons: ['surface_path', 'react_component_export'],
          },
        ]);
      });
    });

    describe('task id resolution and persistence', () => {
      it.each([
        ['task_id', (taskId, workingDirectory) => ({ task_id: taskId, working_directory: workingDirectory })],
        ['taskId', (taskId, workingDirectory) => ({ taskId, working_directory: workingDirectory })],
        ['task.id', (taskId, workingDirectory) => ({ working_directory: workingDirectory, task: { id: taskId } })],
        ['task.task_id', (taskId, workingDirectory) => ({ working_directory: workingDirectory, task: { task_id: taskId } })],
        ['task.taskId', (taskId, workingDirectory) => ({ working_directory: workingDirectory, task: { taskId } })],
      ])('uses %s as the persisted task id', (label, createTaskData) => {
        const workingDirectory = path.join(process.cwd(), '.tmp-policy-feature-flags-task-id');
        const filePath = 'src/policy.js';
        const absolutePath = path.join(workingDirectory, filePath);
        const expectedTaskId = `task-${normalizePathValue(label).replace(/[^a-z0-9]+/gi, '-')}`;
        const { collectEvidence, mockDb } = loadSubject({
          files: {
            [absolutePath]: {
              content: 'if (process.env.FEATURE_TASK_ID) {}',
            },
          },
        });

        collectEvidence(createTaskData(expectedTaskId, workingDirectory), [filePath]);

        expect(mockDb.__deleteRuns).toEqual([expectedTaskId]);
        expect(mockDb.__insertRuns).toEqual([
          ['uuid-1', expectedTaskId, filePath, 'FEATURE_TASK_ID', 'env'],
        ]);
      });

      it('keeps a blank top-level task id from falling back to nested ids', () => {
        const workingDirectory = path.join(process.cwd(), '.tmp-policy-feature-flags-blank-id');
        const filePath = 'components/FeaturePanel.jsx';
        const absolutePath = path.join(workingDirectory, filePath);
        const { collectEvidence, mockDb } = loadSubject({
          files: {
            [absolutePath]: {
              content: [
                'if (featureFlags.isEnabled("   ")) {}',
                'if (!flags.panelDisabled) {}',
                'export default function FeaturePanel() {}',
              ].join('\n'),
            },
          },
        });

        const evidence = collectEvidence({
          id: '   ',
          working_directory: workingDirectory,
          task: {
            id: 'nested-task-id',
          },
        }, [filePath]);

        expect(evidence.feature_flags_found).toEqual([
          {
            file_path: filePath,
            flag_name: null,
            flag_type: 'feature_flags',
            match: 'featureFlags.isEnabled("   ")',
          },
          {
            file_path: filePath,
            flag_name: 'panelDisabled',
            flag_type: 'flags_object',
            match: 'if (!flags.panelDisabled)',
          },
        ]);
        expect(mockDb.__deleteStatement.run).not.toHaveBeenCalled();
        expect(mockDb.__insertRuns).toEqual([
          ['uuid-1', null, filePath, null, 'feature_flags'],
          ['uuid-2', null, filePath, 'panelDisabled', 'flags_object'],
        ]);
      });

      it('skips persistence when the db handle is null', () => {
        const { evidence, mockDatabase } = collectSingleFile({
          filePath: 'src/no-db.js',
          content: 'if (process.env.FEATURE_NO_DB) {}',
          subjectOptions: {
            dbHandle: null,
          },
        });

        expect(evidence.has_feature_flag).toBe(true);
        expect(mockDatabase.getDbInstance).toHaveBeenCalledOnce();
      });

      it('skips persistence when the database module does not expose getDbInstance', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/no-get-db.js',
          content: 'if (process.env.FEATURE_NO_GET_DB) {}',
          subjectOptions: {
            database: {},
          },
        });

        expect(evidence.has_feature_flag).toBe(true);
      });

      it('deletes existing rows but skips inserts when no feature flags are found', () => {
        const workingDirectory = path.join(process.cwd(), '.tmp-policy-feature-flags-delete-only');
        const filePath = 'docs/readme.md';
        const absolutePath = path.join(workingDirectory, filePath);
        const { collectEvidence, mockDb } = loadSubject({
          files: {
            [absolutePath]: {
              content: 'plain text with no feature flags',
            },
          },
        });

        const evidence = collectEvidence({
          task_id: 'task-delete-only',
          working_directory: workingDirectory,
        }, [filePath]);

        expect(evidence).toEqual({
          user_visible_changes: [],
          feature_flags_found: [],
          has_feature_flag: false,
        });
        expect(mockDb.__deleteRuns).toEqual(['task-delete-only']);
        expect(mockDb.__insertRuns).toEqual([]);
      });
    });

    describe('user-visible change detection', () => {
      it('detects HTTP handler exports outside user-visible surface paths', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/server-only.js',
          content: 'export async function GET() {}',
        });

        expect(evidence.user_visible_changes).toEqual([
          {
            file_path: 'src/server-only.js',
            reasons: ['http_handler_export'],
          },
        ]);
      });

      it('detects HTTP handler registrations outside user-visible surface paths', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/router.js',
          content: 'router.post("/feature", handler);',
        });

        expect(evidence.user_visible_changes).toEqual([
          {
            file_path: 'src/router.js',
            reasons: ['http_handler_registration'],
          },
        ]);
      });

      it.each([
        ['named function exports', 'export function AdminPanel() {}'],
        ['const exports', 'export const AdminPanel = () => null;'],
        ['React component classes', 'export default class AdminPanel extends React.Component {}'],
      ])('detects react component exports from %s', (_label, content) => {
        const { evidence } = collectSingleFile({
          filePath: 'src/admin-panel.jsx',
          content,
        });

        expect(evidence.user_visible_changes).toEqual([
          {
            file_path: 'src/admin-panel.jsx',
            reasons: ['react_component_export'],
          },
        ]);
      });
    });

    describe('feature flag detection', () => {
      it('detects env-based flags and removes duplicates', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/env-flags.js',
          content: [
            'if (process.env.FEATURE_ALPHA) {}',
            'if (process.env.FEATURE_ALPHA) {}',
            'if (process.env.FF_BETA) {}',
          ].join('\n'),
        });

        expect(flagPairs(evidence)).toEqual([
          ['env', 'FEATURE_ALPHA'],
          ['env', 'FF_BETA'],
        ]);
      });

      it('detects featureFlags.isEnabled calls for all supported quote styles and preserves blank names as null', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/feature-flags.js',
          content: [
            'featureFlags.isEnabled(\'checkout\');',
            'featureFlags.isEnabled("billing");',
            'featureFlags.isEnabled(`pricing`);',
            'featureFlags.isEnabled("   ");',
          ].join('\n'),
        });

        expect(evidence.feature_flags_found).toEqual([
          {
            file_path: 'src/feature-flags.js',
            flag_name: 'checkout',
            flag_type: 'feature_flags',
            match: 'featureFlags.isEnabled(\'checkout\')',
          },
          {
            file_path: 'src/feature-flags.js',
            flag_name: 'billing',
            flag_type: 'feature_flags',
            match: 'featureFlags.isEnabled("billing")',
          },
          {
            file_path: 'src/feature-flags.js',
            flag_name: 'pricing',
            flag_type: 'feature_flags',
            match: 'featureFlags.isEnabled(`pricing`)',
          },
          {
            file_path: 'src/feature-flags.js',
            flag_name: null,
            flag_type: 'feature_flags',
            match: 'featureFlags.isEnabled("   ")',
          },
        ]);
      });

      it('detects flags object checks and deduplicates repeated flag names', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/flags-object.js',
          content: [
            'if (flags.alpha) {}',
            'if (!flags.alpha) {}',
            'if (user && flags.beta) {}',
          ].join('\n'),
        });

        expect(evidence.feature_flags_found).toEqual([
          {
            file_path: 'src/flags-object.js',
            flag_name: 'alpha',
            flag_type: 'flags_object',
            match: 'if (flags.alpha)',
          },
          {
            file_path: 'src/flags-object.js',
            flag_name: 'beta',
            flag_type: 'flags_object',
            match: 'if (user && flags.beta)',
          },
        ]);
      });

      it('detects config.feature_* checks', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/config-flags.js',
          content: [
            'if (config.feature_adminPanel) {}',
            'if (config.feature_adminPanel) {}',
          ].join('\n'),
        });

        expect(flagPairs(evidence)).toEqual([
          ['config_feature', 'feature_adminPanel'],
        ]);
      });

      it('detects LaunchDarkly variation and hook usage', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/launchdarkly.js',
          content: [
            'ldClient.variation("ld-flag", user, false);',
            'useFlag(\'hook-flag\');',
          ].join('\n'),
        });

        expect(flagPairs(evidence)).toEqual([
          ['launchdarkly', 'ld-flag'],
          ['launchdarkly', 'hook-flag'],
        ]);
      });

      it('detects Unleash isEnabled and getVariant calls', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/unleash.js',
          content: [
            'unleash.isEnabled("checkout");',
            'unleashClient.getVariant(\'banner\');',
          ].join('\n'),
        });

        expect(flagPairs(evidence)).toEqual([
          ['unleash', 'checkout'],
          ['unleash', 'banner'],
        ]);
      });

      it('detects custom SDK calls across supported object names', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/custom-sdk.js',
          content: [
            'featureToggle.isEnabled("alpha");',
            'featureToggles.getVariant("beta");',
            'flags.variation("gamma");',
            'toggles.isEnabled("delta");',
          ].join('\n'),
        });

        expect(flagPairs(evidence)).toEqual([
          ['custom_sdk', 'alpha'],
          ['custom_sdk', 'beta'],
          ['custom_sdk', 'gamma'],
          ['custom_sdk', 'delta'],
        ]);
      });

      it('keeps the same flag name when detected under different sources', () => {
        const { evidence } = collectSingleFile({
          filePath: 'src/shared-name.js',
          content: [
            'if (process.env.FEATURE_SHARED) {}',
            'featureFlags.isEnabled("FEATURE_SHARED");',
            'ldClient.variation("FEATURE_SHARED", user, false);',
          ].join('\n'),
        });

        expect(flagPairs(evidence)).toEqual([
          ['env', 'FEATURE_SHARED'],
          ['feature_flags', 'FEATURE_SHARED'],
          ['launchdarkly', 'FEATURE_SHARED'],
        ]);
      });
    });

    describe('file read guards', () => {
      it('treats directories in user-visible paths as surface-path-only changes and skips reads', () => {
        const workingDirectory = path.join(process.cwd(), '.tmp-policy-feature-flags-directory');
        const filePath = 'client/pages/not-a-file.js';
        const absolutePath = path.join(workingDirectory, filePath);
        const { collectEvidence, mockFs } = loadSubject({
          files: {
            [absolutePath]: {
              content: 'if (process.env.FEATURE_NEVER_READ) {}',
              isFile: false,
            },
          },
        });

        const evidence = collectEvidence(
          { working_directory: workingDirectory },
          [filePath],
        );

        expect(evidence).toEqual({
          user_visible_changes: [
            {
              file_path: filePath,
              reasons: ['surface_path'],
            },
          ],
          feature_flags_found: [],
          has_feature_flag: false,
        });
        expect(mockFs.readFileSync).not.toHaveBeenCalled();
      });

      it('treats oversized user-facing files as surface-path-only changes and skips reads', () => {
        const workingDirectory = path.join(process.cwd(), '.tmp-policy-feature-flags-large');
        const filePath = 'client/pages/giant-page.js';
        const absolutePath = path.join(workingDirectory, filePath);
        const { collectEvidence, mockFs } = loadSubject({
          files: {
            [absolutePath]: {
              content: 'if (process.env.FEATURE_NEVER_READ) {}',
              size: (1024 * 1024) + 1,
            },
          },
        });

        const evidence = collectEvidence(
          { workingDirectory },
          [filePath],
        );

        expect(evidence).toEqual({
          user_visible_changes: [
            {
              file_path: filePath,
              reasons: ['surface_path'],
            },
          ],
          feature_flags_found: [],
          has_feature_flag: false,
        });
        expect(mockFs.readFileSync).not.toHaveBeenCalled();
      });

      it('returns no evidence when stat lookup fails for a non-surface file', () => {
        const { evidence, mockFs } = collectSingleFile({
          filePath: 'scripts/missing.js',
          fileEntry: {
            statError: new Error('ENOENT'),
          },
        });

        expect(evidence).toEqual({
          user_visible_changes: [],
          feature_flags_found: [],
          has_feature_flag: false,
        });
        expect(mockFs.readFileSync).not.toHaveBeenCalled();
      });

      it('returns no evidence when file reads fail after stat succeeds', () => {
        const { evidence, mockFs } = collectSingleFile({
          filePath: 'scripts/unreadable.js',
          fileEntry: {
            readError: new Error('EACCES'),
          },
        });

        expect(evidence).toEqual({
          user_visible_changes: [],
          feature_flags_found: [],
          has_feature_flag: false,
        });
        expect(mockFs.readFileSync).toHaveBeenCalledOnce();
      });
    });

    describe('aggregate behavior', () => {
      it('combines results from multiple files in order and persists every finding', () => {
        const workingDirectory = path.join(process.cwd(), '.tmp-policy-feature-flags-multi');
        const userVisiblePath = 'routes/dashboard.js';
        const servicePath = 'src/service/flags.js';
        const absoluteUserVisiblePath = path.join(workingDirectory, userVisiblePath);
        const absoluteServicePath = path.join(workingDirectory, servicePath);
        const { collectEvidence, mockDb, randomUUID } = loadSubject({
          files: {
            [absoluteUserVisiblePath]: {
              content: [
                'if (process.env.FEATURE_DASHBOARD) {}',
                'export function DashboardPage() {}',
              ].join('\n'),
            },
            [absoluteServicePath]: {
              content: [
                'unleashClient.getVariant("service-variant");',
                'toggles.isEnabled("service-toggle");',
              ].join('\n'),
            },
          },
        });

        const evidence = collectEvidence(
          {
            taskId: 'task-multi-file',
            project_path: workingDirectory,
          },
          [userVisiblePath, servicePath],
        );

        expect(evidence).toEqual({
          user_visible_changes: [
            {
              file_path: userVisiblePath,
              reasons: ['surface_path', 'react_component_export'],
            },
          ],
          feature_flags_found: [
            {
              file_path: userVisiblePath,
              flag_name: 'FEATURE_DASHBOARD',
              flag_type: 'env',
              match: 'process.env.FEATURE_DASHBOARD',
            },
            {
              file_path: servicePath,
              flag_name: 'service-variant',
              flag_type: 'unleash',
              match: 'unleashClient.getVariant("service-variant"',
            },
            {
              file_path: servicePath,
              flag_name: 'service-toggle',
              flag_type: 'custom_sdk',
              match: 'toggles.isEnabled("service-toggle"',
            },
          ],
          has_feature_flag: true,
        });
        expect(mockDb.__deleteRuns).toEqual(['task-multi-file']);
        expect(mockDb.__insertRuns).toEqual([
          ['uuid-1', 'task-multi-file', userVisiblePath, 'FEATURE_DASHBOARD', 'env'],
          ['uuid-2', 'task-multi-file', servicePath, 'service-variant', 'unleash'],
          ['uuid-3', 'task-multi-file', servicePath, 'service-toggle', 'custom_sdk'],
        ]);
        expect(randomUUID).toHaveBeenCalledTimes(3);
      });
    });
  });
});
