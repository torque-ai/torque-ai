import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { createConfigMock, TEST_MODELS } from './test-helpers';

const require = createRequire(import.meta.url);
const actualPath = require('node:path');
const Module = require('module');

let mockFs;
let mockPath;
let mockChildProcess;
let mockDb;
let mockShared;
let mockLogger;
let loggerChild;
let mockTaskManager;
let mockSafeExecChain;
let mockExecuteValidatedCommandSync;
let mockBuildErrorFeedbackPrompt;
let mockCreateTestRunnerRegistry;
let mockRouter;
let mockGovernanceHooks;
let mockContainer;
let mockConstants;
let mockConfig;
let mockIndex;
let mockUuidV4;
let moduleLoadSpy;

function textOf(result) {
  return result?.content?.find((item) => item.type === 'text')?.text || '';
}

function extractJsonBlock(text) {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  return match ? JSON.parse(match[1]) : null;
}

function buildLines(count, prefix = 'line') {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}

function normalizePath(targetPath) {
  return actualPath.resolve(String(targetPath));
}

function createDirent(name, kind) {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

function createMockPath() {
  return {
    ...actualPath,
    sep: actualPath.sep,
    join: vi.fn((...parts) => actualPath.join(...parts)),
    dirname: vi.fn((...parts) => actualPath.dirname(...parts)),
    basename: vi.fn((...parts) => actualPath.basename(...parts)),
    extname: vi.fn((...parts) => actualPath.extname(...parts)),
    relative: vi.fn((...parts) => actualPath.relative(...parts)),
    resolve: vi.fn((...parts) => actualPath.resolve(...parts)),
  };
}

function createVirtualFs(initialEntries = {}) {
  const dirs = new Set();
  const files = new Map();
  const writes = [];

  function ensureDir(dirPath) {
    const resolved = normalizePath(dirPath);
    if (dirs.has(resolved)) return;
    const parent = actualPath.dirname(resolved);
    if (parent !== resolved) ensureDir(parent);
    dirs.add(resolved);
  }

  function addDir(dirPath) {
    ensureDir(dirPath);
  }

  function addFile(filePath, content = '') {
    const resolved = normalizePath(filePath);
    ensureDir(actualPath.dirname(resolved));
    files.set(resolved, String(content));
  }

  for (const [entryPath, value] of Object.entries(initialEntries)) {
    if (value && typeof value === 'object' && value.type === 'dir') {
      addDir(entryPath);
    } else {
      addFile(entryPath, value);
    }
  }

  const api = {
    existsSync: vi.fn((targetPath) => {
      const resolved = normalizePath(targetPath);
      return dirs.has(resolved) || files.has(resolved);
    }),
    readdirSync: vi.fn((dirPath, options = undefined) => {
      const resolved = normalizePath(dirPath);
      if (!dirs.has(resolved)) {
        const error = new Error(`ENOENT: no such file or directory, scandir '${dirPath}'`);
        error.code = 'ENOENT';
        throw error;
      }

      const children = new Map();
      for (const dir of dirs) {
        if (dir !== resolved && actualPath.dirname(dir) === resolved) {
          const name = actualPath.basename(dir);
          children.set(name, createDirent(name, 'dir'));
        }
      }
      for (const filePath of files.keys()) {
        if (actualPath.dirname(filePath) === resolved) {
          const name = actualPath.basename(filePath);
          children.set(name, createDirent(name, 'file'));
        }
      }

      const sorted = Array.from(children.values()).sort((a, b) => a.name.localeCompare(b.name));
      if (options && options.withFileTypes) {
        return sorted;
      }
      return sorted.map((entry) => entry.name);
    }),
    readFileSync: vi.fn((filePath) => {
      const resolved = normalizePath(filePath);
      if (!files.has(resolved)) {
        const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(resolved);
    }),
    writeFileSync: vi.fn((filePath, content) => {
      const resolved = normalizePath(filePath);
      ensureDir(actualPath.dirname(resolved));
      const text = String(content);
      files.set(resolved, text);
      writes.push({ path: resolved, content: text });
    }),
    statSync: vi.fn((filePath) => {
      const resolved = normalizePath(filePath);
      if (!files.has(resolved)) {
        const error = new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return { size: Buffer.byteLength(files.get(resolved), 'utf8') };
    }),
    lstatSync: vi.fn((filePath) => {
      const resolved = normalizePath(filePath);
      const isFile = files.has(resolved);
      const isDir = dirs.has(resolved);
      if (!isFile && !isDir) {
        const error = new Error(`ENOENT: no such file or directory, lstat '${filePath}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return {
        isSymbolicLink: () => false,
        isFile: () => isFile,
        isDirectory: () => isDir,
        size: isFile ? Buffer.byteLength(files.get(resolved), 'utf8') : 0,
      };
    }),
    realpathSync: vi.fn((filePath) => normalizePath(filePath)),
    __addDir: addDir,
    __addFile: addFile,
    __getFile: (filePath) => files.get(normalizePath(filePath)),
    __writes: writes,
  };
  // fs.promises shim — the production code converted scanDirectory and
  // handleGenerateTestTasks to async (commit e2f186c2), so these handlers
  // now call fs.promises.readdir/readFile/stat. Wrap the sync mocks so
  // virtual-fs tests keep working without rewriting fixture setup.
  api.promises = {
    readdir: vi.fn(async (dirPath, options = undefined) => api.readdirSync(dirPath, options)),
    readFile: vi.fn(async (filePath, encoding = undefined) => {
      const buf = api.readFileSync(filePath);
      // production callers pass 'utf8' and expect a string; mirror that.
      return typeof encoding === 'string' || (encoding && encoding.encoding) ? String(buf) : buf;
    }),
    // Mirror lstatSync's directory-aware behavior so callers that stat a
    // directory (e.g. handleGenerateTestTasks does `await fs.promises.stat(srcDir)`
    // before scanning) don't get ENOENT when the path is a registered dir.
    // The bare statSync mock only checks `files`, which would short-circuit
    // those callers and return zero source files.
    stat: vi.fn(async (filePath) => {
      const lstat = api.lstatSync(filePath);
      return {
        size: lstat.size,
        isFile: lstat.isFile,
        isDirectory: lstat.isDirectory,
        isSymbolicLink: lstat.isSymbolicLink,
      };
    }),
    lstat: vi.fn(async (filePath) => api.lstatSync(filePath)),
    writeFile: vi.fn(async (filePath, content) => api.writeFileSync(filePath, content)),
    realpath: vi.fn(async (filePath) => api.realpathSync(filePath)),
  };
  return api;
}

function createErrorCodes() {
  return {
    INVALID_PARAM: { code: 'INVALID_PARAM' },
    MISSING_REQUIRED_PARAM: { code: 'MISSING_REQUIRED_PARAM' },
    RESOURCE_NOT_FOUND: { code: 'RESOURCE_NOT_FOUND' },
    INTERNAL_ERROR: { code: 'INTERNAL_ERROR' },
    WORKFLOW_NOT_FOUND: { code: 'WORKFLOW_NOT_FOUND' },
    OPERATION_FAILED: { code: 'OPERATION_FAILED' },
  };
}

function createDbMock(options = {}) {
  const configStore = new Map(Object.entries(options.config || {}));
  const projectConfigs = new Map(Object.entries(options.projectConfigs || {}));
  const projectMetadata = new Map(
    Object.entries(options.projectMetadata || {}).map(([project, metadata]) => [project, { ...metadata }]),
  );
  const tasks = new Map(Object.entries(options.tasks || {}));
  const fallbackConfig = createConfigMock();

  return {
    getTask: vi.fn((taskId) => tasks.get(taskId) ?? null),
    createTask: vi.fn((payload) => payload),
    getProjectFromPath: vi.fn((workingDir) => {
      if (options.projectFromPath && Object.prototype.hasOwnProperty.call(options.projectFromPath, workingDir)) {
        return options.projectFromPath[workingDir];
      }
      return options.defaultProject === undefined ? 'torque' : options.defaultProject;
    }),
    safeAddColumn: vi.fn(),
    setProjectConfig: vi.fn((project, update) => {
      const next = { ...(projectConfigs.get(project) || {}), ...update };
      projectConfigs.set(project, next);
      return next;
    }),
    getProjectConfig: vi.fn((project) => projectConfigs.get(project) ?? null),
    setProjectMetadata: vi.fn((project, key, value) => {
      const next = { ...(projectMetadata.get(project) || {}) };
      next[key] = value;
      projectMetadata.set(project, next);
    }),
    getProjectMetadata: vi.fn((project, key) => {
      const metadata = projectMetadata.get(project);
      return metadata && Object.prototype.hasOwnProperty.call(metadata, key) ? metadata[key] : null;
    }),
    getConfig: vi.fn((key) => {
      return configStore.has(key) ? configStore.get(key) : fallbackConfig(key);
    }),
    setConfig: vi.fn((key, value) => {
      configStore.set(key, value);
    }),
  };
}

function resetMocks(options = {}) {
  if (moduleLoadSpy) {
    moduleLoadSpy.mockRestore();
  }

  mockFs = createVirtualFs();
  mockPath = createMockPath();
  mockChildProcess = {
    execSync: vi.fn(),
    spawn: vi.fn(),
    spawnSync: vi.fn(),
  };
  mockDb = createDbMock(options.dbOptions);

  const errorCodes = createErrorCodes();
  mockShared = {
    ErrorCodes: errorCodes,
    makeError: vi.fn((errorCode, message) => {
      const code = errorCode?.code || String(errorCode);
      return {
        isError: true,
        error_code: code,
        content: [{ type: 'text', text: `${code}: ${message}` }],
      };
    }),
  };

  loggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  mockLogger = {
    child: vi.fn(() => loggerChild),
  };

  mockTaskManager = {
    startTask: vi.fn(),
  };
  mockSafeExecChain = vi.fn(() => ({
    exitCode: 0,
    output: '0 passed (0)',
    error: '',
  }));
  mockExecuteValidatedCommandSync = vi.fn(() => '');
  mockBuildErrorFeedbackPrompt = vi.fn((prompt) => `[feedback]\n${prompt}`);
  mockRouter = {
    runVerifyCommand: vi.fn(async () => ({
      output: '',
      error: '',
      exitCode: 0,
      remote: false,
      durationMs: 0,
    })),
  };
  mockCreateTestRunnerRegistry = vi.fn(() => mockRouter);
  mockGovernanceHooks = null;
  mockContainer = {
    defaultContainer: {
      has: vi.fn((name) => name === 'governanceHooks' && Boolean(mockGovernanceHooks)),
      get: vi.fn((name) => (name === 'governanceHooks' ? mockGovernanceHooks : undefined)),
    },
  };
  mockConstants = {
    TASK_TIMEOUTS: {
      GIT_DIFF: 5_000,
      TEST_RUN: 30_000,
      VERIFY_COMMAND: 120_000,
    },
    CODE_EXTENSIONS: ['.js', '.ts', '.jsx', '.tsx'],
    SOURCE_EXTENSIONS: new Set(['.js', '.ts', '.jsx', '.tsx']),
    UI_EXTENSIONS: ['.vue', '.svelte'],
  };
  const configFallback = createConfigMock();
  mockConfig = {
    get: vi.fn((key) => configFallback(key)),
  };
  mockIndex = {
    getTestRunnerRegistry: vi.fn(() => null),
  };

  let uuidCounter = 0;
  mockUuidV4 = vi.fn(() => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
  });

  const originalLoad = Module._load;
  moduleLoadSpy = vi.spyOn(Module, '_load').mockImplementation(function mockedLoad(request, parent, isMain) {
    // Only intercept core-module requires when the caller is in the
    // project tree, not from inside node_modules. Otherwise dependencies
    // like better-sqlite3 (which `require('fs')` for backup paths) get
    // handed our virtual-fs shim, and operations like `promisify(fs.access)`
    // throw because the shim doesn't implement every method. Real fs is
    // safe for them — they only touch real backup files.
    const fromNodeModules = parent && typeof parent.filename === 'string'
      && parent.filename.includes('node_modules');
    if (!fromNodeModules) {
      if (request === 'fs') return mockFs;
      if (request === 'path') return mockPath;
      if (request === 'child_process') return mockChildProcess;
      if (request === 'uuid') return { v4: mockUuidV4 };
    }
    return originalLoad.call(this, request, parent, isMain);
  });
}

function addVirtualFiles(entries) {
  for (const [filePath, content] of Object.entries(entries)) {
    mockFs.__addFile(filePath, content);
  }
}

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module was not loaded yet.
  }
}

function clearCjsModules(modulePaths) {
  for (const modulePath of modulePaths) {
    clearCjsModule(modulePath);
  }
}

const AUTOMATION_MODULES = [
  '../handlers/automation-handlers',
  '../database',
  '../db/config-core',
  '../db/task-core',
  '../db/project-config-core',
  '../task-manager',
  '../handlers/shared',
  '../logger',
  '../constants',
  '../config',
  '../utils/context-enrichment',
  '../utils/safe-exec',
  '../execution/command-policy',
  '../test-runner-registry',
  '../container',
  '../handlers/automation-ts-tools',
  '../handlers/automation-batch-orchestration',
  '../index',
];

const INTEGRATION_MODULES = [
  '../handlers/integration/infra',
  '../db/backup-core',
  '../db/config-core',
  '../db/email-peek',
  '../db/host/management',
  '../db/provider/routing-core',
  '../logger',
  '../config',
  '../constants',
  '../utils/context-stuffing',
  '../execution/queue-scheduler',
  '../handlers/error-codes',
];

function loadAutomationHandlers() {
  vi.resetModules();
  clearCjsModules(AUTOMATION_MODULES);
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../db/config-core', mockDb);
  installCjsModuleMock('../db/task-core', mockDb);
  installCjsModuleMock('../db/project-config-core', mockDb);
  installCjsModuleMock('../task-manager', mockTaskManager);
  installCjsModuleMock('../handlers/shared', mockShared);
  installCjsModuleMock('../logger', mockLogger);
  installCjsModuleMock('../constants', mockConstants);
  installCjsModuleMock('../config', mockConfig);
  installCjsModuleMock('../utils/context-enrichment', {
    buildErrorFeedbackPrompt: mockBuildErrorFeedbackPrompt,
  });
  installCjsModuleMock('../utils/safe-exec', {
    safeExecChain: mockSafeExecChain,
  });
  installCjsModuleMock('../execution/command-policy', {
    executeValidatedCommandSync: mockExecuteValidatedCommandSync,
  });
  installCjsModuleMock('../test-runner-registry', {
    createTestRunnerRegistry: mockCreateTestRunnerRegistry,
  });
  installCjsModuleMock('../container', mockContainer);
  installCjsModuleMock('../handlers/automation-ts-tools', {});
  installCjsModuleMock('../handlers/automation-batch-orchestration', {});
  installCjsModuleMock('../index', mockIndex);
  return require('../handlers/automation-handlers');
}

function loadIntegrationHandlers() {
  vi.resetModules();
  clearCjsModules(INTEGRATION_MODULES);
  installCjsModuleMock('../db/backup-core', {});
  installCjsModuleMock('../db/config-core', mockDb);
  installCjsModuleMock('../db/email-peek', {});
  installCjsModuleMock('../db/host/management', {});
  installCjsModuleMock('../db/provider/routing-core', {});
  installCjsModuleMock('../logger', mockLogger);
  installCjsModuleMock('../config', mockConfig);
  installCjsModuleMock('../constants', mockConstants);
  installCjsModuleMock('../utils/context-stuffing', {
    PROVIDER_CONTEXT_BUDGETS: {},
  });
  installCjsModuleMock('../execution/queue-scheduler', {
    COST_FREE_PROVIDERS: [],
  });
  installCjsModuleMock('../handlers/error-codes', {
    ErrorCodes: mockShared.ErrorCodes,
    makeError: mockShared.makeError,
  });
  return require('../handlers/integration/infra');
}

function seedScanFixture(projectDir) {
  addVirtualFiles({
    [actualPath.join(projectDir, 'src', 'alpha.js')]: [
      'export const alpha = true;',
      '// TODO tighten assertions',
      'export function sum(a, b) {',
      '  return a + b;',
      '}',
    ].join('\n'),
    [actualPath.join(projectDir, 'src', 'beta.ts')]: buildLines(4, 'beta'),
    [actualPath.join(projectDir, 'src', 'index.ts')]: 'export * from "./alpha";',
    [actualPath.join(projectDir, 'src', 'types.d.ts')]: 'export interface Example { id: string; }',
    [actualPath.join(projectDir, 'src', '__tests__', 'alpha.test.ts')]: 'export {}',
    [actualPath.join(projectDir, 'config', 'settings.js')]: [
      'module.exports = {',
      "  mode: 'test',",
      '  // FIXME split env config',
      '};',
    ].join('\n'),
    [actualPath.join(projectDir, 'data', 'items.js')]: [
      '[',
      '  {',
      "    id: 'sword',",
      '  },',
      '  {',
      "    id: 'shield',",
      '  },',
      ']',
    ].join('\n'),
    [actualPath.join(projectDir, 'scripts', 'build.js')]: buildLines(3, 'build'),
    [actualPath.join(projectDir, 'package.json')]: JSON.stringify({
      name: 'sample-app',
      version: '1.2.3',
      scripts: { test: 'vitest', build: 'tsc' },
      dependencies: { express: '^5.0.0', zod: '^3.0.0' },
      devDependencies: { eslint: '^9.0.0', vitest: '^4.0.0' },
    }),
    [actualPath.join(projectDir, 'node_modules', 'ignored.js')]: 'module.exports = {};',
  });
}

vi.mock('fs', () => mockFs);
vi.mock('path', () => mockPath);
vi.mock('child_process', () => mockChildProcess);
vi.mock('../database', () => mockDb);
vi.mock('../task-manager', () => mockTaskManager);
vi.mock('../handlers/shared', () => mockShared);
vi.mock('../handlers/error-codes', () => ({
  ErrorCodes: mockShared.ErrorCodes,
  makeError: mockShared.makeError,
}));
vi.mock('../logger', () => mockLogger);
vi.mock('../constants', () => mockConstants);
vi.mock('../config', () => mockConfig);
vi.mock('../utils/context-enrichment', () => ({
  buildErrorFeedbackPrompt: mockBuildErrorFeedbackPrompt,
}));
vi.mock('../utils/safe-exec', () => ({
  safeExecChain: mockSafeExecChain,
}));
vi.mock('../execution/command-policy', () => ({
  executeValidatedCommandSync: mockExecuteValidatedCommandSync,
}));
vi.mock('../test-runner-registry', () => ({
  createTestRunnerRegistry: mockCreateTestRunnerRegistry,
}));
vi.mock('../handlers/automation-ts-tools', () => ({}));
vi.mock('../handlers/automation-batch-orchestration', () => ({}));
vi.mock('../index', () => mockIndex);
vi.mock('uuid', () => ({
  v4: mockUuidV4,
}));

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  clearCjsModules([...new Set([...AUTOMATION_MODULES, ...INTEGRATION_MODULES])]);
});

describe('Task Project Handlers', () => {
  describe('handleScanProject', () => {
    it('returns RESOURCE_NOT_FOUND when the project path does not exist', () => {
      const handlers = loadIntegrationHandlers();
      const missingPath = actualPath.join('C:\\', 'missing', 'project');

      const result = handlers.handleScanProject({ path: missingPath });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(mockShared.ErrorCodes.RESOURCE_NOT_FOUND.code);
      expect(textOf(result)).toContain(missingPath);
    });

    it('builds the full scan report for a mixed project tree', () => {
      const handlers = loadIntegrationHandlers();
      const projectDir = actualPath.join('C:\\repo', 'scan-fixture');
      seedScanFixture(projectDir);

      const result = handlers.handleScanProject({ path: projectDir });
      const text = textOf(result);

      expect(text).toContain(`## Project Scan: ${actualPath.basename(projectDir)}`);
      expect(text).toContain('**Total files:** 9');
      expect(text).toContain('| src | 5 |');
      expect(text).toContain('| .js | 4 |');
      expect(text).toContain('**0/2 source files have tests (0%)**');
      expect(text).toContain(`- ${actualPath.join('src', 'beta.ts')} (4 lines)`);
      expect(text).toContain('**2 found**');
      expect(text).toContain(`**FIXME** ${actualPath.join('config', 'settings.js')}:3`);
      expect(text).toContain(`**TODO** ${actualPath.join('src', 'alpha.js')}:2`);
      expect(text).toContain('### File Sizes');
      expect(text).toContain(`| ${actualPath.join('data', 'items.js')} | 8 | 2 |`);
      expect(text).toContain('**sample-app** v1.2.3');
      expect(text).toContain('**Dependencies (2):** express, zod');
      expect(text).toContain('**Dev dependencies (2):** eslint, vitest');
      expect(text).not.toContain('ignored.js');
    });

    it('honors custom source_dirs, test_pattern, ignore_dirs, and checks', () => {
      const handlers = loadIntegrationHandlers();
      const projectDir = actualPath.join('C:\\repo', 'scan-custom');
      addVirtualFiles({
        [actualPath.join(projectDir, 'app', 'feature.js')]: buildLines(24, 'feature'),
        [actualPath.join(projectDir, 'app', 'feature.spec.js')]: 'export {}',
        [actualPath.join(projectDir, 'docs', 'readme.md')]: '# readme',
        [actualPath.join(projectDir, 'ignored', 'skip.js')]: 'console.log("skip");',
      });

      const result = handlers.handleScanProject({
        path: projectDir,
        checks: ['summary', 'missing_tests'],
        source_dirs: ['app'],
        test_pattern: '.spec.js',
        ignore_dirs: ['ignored'],
      });
      const text = textOf(result);

      expect(text).toContain('**Total files:** 3');
      expect(text).toContain('**1/1 source files have tests (100%)**');
      expect(text).not.toContain('### TODOs/FIXMEs');
      expect(text).not.toContain('skip.js');
    });

    it('ignores index files and declaration files in missing-test coverage', () => {
      const handlers = loadIntegrationHandlers();
      const projectDir = actualPath.join('C:\\repo', 'scan-coverage-filter');
      addVirtualFiles({
        [actualPath.join(projectDir, 'src', 'Feature.ts')]: buildLines(12, 'feature'),
        [actualPath.join(projectDir, 'src', '__tests__', 'Feature.test.ts')]: 'export {}',
        [actualPath.join(projectDir, 'src', 'index.ts')]: 'export * from "./Feature";',
        [actualPath.join(projectDir, 'src', 'types.d.ts')]: 'export interface Shape {}',
      });

      const result = handlers.handleScanProject({ path: projectDir, checks: ['missing_tests'] });
      const text = textOf(result);

      expect(text).toContain('**0/1 source files have tests (0%)**');
      expect(text).toContain('Missing tests');
    });

    it('logs TODO parsing errors and continues scanning', () => {
      const handlers = loadIntegrationHandlers();
      const projectDir = actualPath.join('C:\\repo', 'scan-todo-errors');
      addVirtualFiles({
        [actualPath.join(projectDir, 'src', 'broken.js')]: 'const broken = true;',
      });
      const defaultRead = mockFs.readFileSync.getMockImplementation();
      mockFs.readFileSync.mockImplementation((filePath, encoding) => {
        if (normalizePath(filePath) === normalizePath(actualPath.join(projectDir, 'src', 'broken.js'))) {
          throw new Error('cannot read todo source');
        }
        return defaultRead(filePath, encoding);
      });

      const result = handlers.handleScanProject({ path: projectDir, checks: ['todos'] });
      const text = textOf(result);

      expect(loggerChild.debug).toHaveBeenCalledWith(
        '[integration-infra] non-critical error parsing TODO marker:',
        'cannot read todo source',
      );
      expect(text).toContain('### TODOs/FIXMEs');
      expect(text).toContain('**0 found**');
    });

    it('logs directory walk failures and still returns a summary', () => {
      const handlers = loadIntegrationHandlers();
      const projectDir = actualPath.join('C:\\repo', 'scan-walk-error');
      mockFs.__addDir(projectDir);
      const defaultReadDir = mockFs.readdirSync.getMockImplementation();
      mockFs.readdirSync.mockImplementation((dirPath, options) => {
        if (normalizePath(dirPath) === normalizePath(projectDir)) {
          throw new Error('walk blocked');
        }
        return defaultReadDir(dirPath, options);
      });

      const result = handlers.handleScanProject({ path: projectDir, checks: ['summary'] });
      const text = textOf(result);

      expect(loggerChild.debug).toHaveBeenCalledWith(
        '[integration-infra] non-critical error walking directory tree:',
        'walk blocked',
      );
      expect(text).toContain('**Total files:** 0');
    });

    it('keeps scanning when package.json cannot be parsed', () => {
      const handlers = loadIntegrationHandlers();
      const projectDir = actualPath.join('C:\\repo', 'scan-bad-package');
      addVirtualFiles({
        [actualPath.join(projectDir, 'src', 'main.ts')]: buildLines(5, 'main'),
        [actualPath.join(projectDir, 'package.json')]: '{bad json',
      });

      const result = handlers.handleScanProject({
        path: projectDir,
        checks: ['summary', 'dependencies'],
      });
      const text = textOf(result);

      expect(text).toContain(`## Project Scan: ${actualPath.basename(projectDir)}`);
      expect(text).toContain('### Dependencies');
    });
  });

  describe('handleSetProjectDefaults', () => {
    it('returns a missing parameter error when working_directory is absent', () => {
      const handlers = loadAutomationHandlers();

      const result = handlers.handleSetProjectDefaults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(mockShared.ErrorCodes.MISSING_REQUIRED_PARAM.code);
      expect(textOf(result)).toContain('working_directory is required');
    });

    it('returns RESOURCE_NOT_FOUND when the project cannot be resolved', () => {
      mockDb.getProjectFromPath.mockReturnValue(null);
      const handlers = loadAutomationHandlers();

      const result = handlers.handleSetProjectDefaults({ working_directory: 'C:\\outside\\repo' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(mockShared.ErrorCodes.RESOURCE_NOT_FOUND.code);
      expect(textOf(result)).toContain('Could not determine project from path');
    });

    it('rejects unsupported providers without persisting config', () => {
      const handlers = loadAutomationHandlers();

      const result = handlers.handleSetProjectDefaults({
        working_directory: 'C:\\repo\\root',
        provider: 'nonexistent-provider',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(mockShared.ErrorCodes.INVALID_PARAM.code);
      expect(mockDb.setProjectConfig).not.toHaveBeenCalled();
      expect(textOf(result)).toContain('Invalid provider "nonexistent-provider"');
    });

    it('persists provider, verify, auto-fix, test pattern, and remote settings', () => {
      const handlers = loadAutomationHandlers();

      const result = handlers.handleSetProjectDefaults({
        working_directory: 'C:\\repo\\root',
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        verify_command: 'pnpm verify',
        auto_fix: true,
        test_pattern: '.spec.ts',
        auto_verify_on_completion: true,
        remote_agent_id: 'agent-7',
        remote_project_path: 'D:\\remote\\torque',
        prefer_remote_tests: true,
      });
      const text = textOf(result);

      expect(mockDb.safeAddColumn).toHaveBeenCalledWith('project_config', 'default_provider TEXT');
      expect(mockDb.safeAddColumn).toHaveBeenCalledWith('project_config', 'default_model TEXT');
      expect(mockDb.safeAddColumn).toHaveBeenCalledWith('project_config', 'verify_command TEXT');
      expect(mockDb.safeAddColumn).toHaveBeenCalledWith('project_config', 'auto_fix_enabled INTEGER DEFAULT 0');
      expect(mockDb.safeAddColumn).toHaveBeenCalledWith('project_config', 'test_pattern TEXT');
      expect(mockDb.safeAddColumn).toHaveBeenCalledWith('project_config', 'auto_verify_on_completion INTEGER');
      expect(mockDb.safeAddColumn).toHaveBeenCalledWith('project_config', 'remote_agent_id TEXT');
      expect(mockDb.safeAddColumn).toHaveBeenCalledWith('project_config', 'remote_project_path TEXT');
      expect(mockDb.safeAddColumn).toHaveBeenCalledWith('project_config', 'prefer_remote_tests INTEGER DEFAULT 0');
      expect(mockDb.setProjectConfig).toHaveBeenCalledWith('torque', {
        default_provider: 'codex',
        default_model: 'gpt-5.3-codex-spark',
        verify_command: 'pnpm verify',
        auto_fix_enabled: 1,
        test_pattern: '.spec.ts',
        auto_verify_on_completion: 1,
        remote_agent_id: 'agent-7',
        remote_project_path: 'D:\\remote\\torque',
        prefer_remote_tests: 1,
      });
      expect(text).toContain('Default provider: codex');
      expect(text).toContain('Verify command: pnpm verify');
      expect(text).toContain('Auto-fix: enabled');
      expect(text).toContain('Remote agent ID: agent-7');
      expect(text).toContain('| Provider | codex |');
      expect(text).toContain('| Remote agent | agent-7 |');
    });

    it('persists disabled auto-fix and step providers metadata', () => {
      const handlers = loadAutomationHandlers();

      const result = handlers.handleSetProjectDefaults({
        working_directory: 'C:\\repo\\root',
        auto_fix: false,
        step_providers: { types: 'ollama', tests: 'codex' },
      });
      const text = textOf(result);

      expect(mockDb.setProjectConfig).toHaveBeenCalledWith('torque', {
        auto_fix_enabled: 0,
      });
      expect(mockDb.setProjectMetadata).toHaveBeenCalledWith(
        'torque',
        'step_providers',
        '{"types":"ollama","tests":"codex"}',
      );
      expect(text).toContain('Auto-fix: disabled');
      expect(text).toContain('Step providers: {"types":"ollama","tests":"codex"}');
    });

    it('clears remote settings when blank values are provided', () => {
      const handlers = loadAutomationHandlers();

      const result = handlers.handleSetProjectDefaults({
        working_directory: 'C:\\repo\\root',
        remote_agent_id: '',
        remote_project_path: '',
      });
      const text = textOf(result);

      expect(mockDb.setProjectConfig).toHaveBeenCalledWith('torque', {
        remote_agent_id: null,
        remote_project_path: null,
      });
      expect(text).toContain('Remote agent ID: (cleared)');
      expect(text).toContain('Remote project path: (cleared)');
    });

    it('persists disabled prefer_remote_tests as 0', () => {
      const handlers = loadAutomationHandlers();

      const result = handlers.handleSetProjectDefaults({
        working_directory: 'C:\\repo\\root',
        prefer_remote_tests: false,
      });
      const text = textOf(result);

      expect(mockDb.setProjectConfig).toHaveBeenCalledWith('torque', {
        prefer_remote_tests: 0,
      });
      expect(text).toContain('Prefer remote tests: disabled');
    });

    it('returns current settings without writing when no changes are provided', () => {
      mockDb.getProjectConfig.mockReturnValue({
        default_provider: 'codex',
        default_model: 'gpt-5.3-codex-spark',
        verify_command: 'pnpm verify',
        auto_fix_enabled: 1,
        test_pattern: '.test.ts',
        default_timeout: 45,
        max_concurrent: 3,
      });
      const handlers = loadAutomationHandlers();

      const result = handlers.handleSetProjectDefaults({
        working_directory: 'C:\\repo\\root',
      });
      const text = textOf(result);

      expect(mockDb.setProjectConfig).not.toHaveBeenCalled();
      expect(mockDb.setProjectMetadata).not.toHaveBeenCalled();
      expect(text).toContain('### Current Settings');
      expect(text).toContain('| Provider | codex |');
      expect(text).toContain('| Timeout | 45min |');
    });
  });

  describe('handleGetProjectDefaults', () => {
    it('returns a missing parameter error when working_directory is absent', () => {
      const handlers = loadAutomationHandlers();

      const result = handlers.handleGetProjectDefaults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(mockShared.ErrorCodes.MISSING_REQUIRED_PARAM.code);
      expect(textOf(result)).toContain('working_directory is required');
    });

    it('returns RESOURCE_NOT_FOUND when the project cannot be resolved', () => {
      mockDb.getProjectFromPath.mockReturnValue(null);
      const handlers = loadAutomationHandlers();

      const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\outside\\repo' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(mockShared.ErrorCodes.RESOURCE_NOT_FOUND.code);
      expect(textOf(result)).toContain('Could not determine project from path');
    });

    it('reports when no configuration exists for the project', () => {
      const handlers = loadAutomationHandlers();

      const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\repo\\root' });

      expect(textOf(result)).toContain('No project configuration found');
      expect(textOf(result)).toContain('set_project_defaults');
    });

    it('renders remote settings and parsed step providers', () => {
      mockDb.getProjectConfig.mockReturnValue({
        default_provider: 'ollama',
        default_model: TEST_MODELS.SMALL,
        verify_command: 'pnpm verify',
        auto_fix_enabled: 1,
        test_pattern: '.test.js',
        default_timeout: 60,
        max_concurrent: 2,
        build_verification_enabled: 1,
        remote_agent_id: 'agent-1',
        remote_project_path: 'D:\\remote\\torque',
        prefer_remote_tests: 1,
      });
      mockDb.getProjectMetadata.mockImplementation((project, key) => (
        key === 'step_providers' ? '{"types":"ollama","system":"codex"}' : null
      ));
      const handlers = loadAutomationHandlers();

      const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\repo\\root' });
      const text = textOf(result);

      expect(text).toContain('| Provider | ollama |');
      expect(text).toContain(`| Model | ${TEST_MODELS.SMALL} |`);
      expect(text).toContain('| Verify command | pnpm verify |');
      expect(text).toContain('| Auto-fix | Yes |');
      expect(text).toContain('| Remote agent | agent-1 |');
      expect(text).toContain('| Remote path | D:\\remote\\torque |');
      expect(text).toContain('| Prefer remote tests | Yes |');
      expect(text).toContain('| Step providers | types=ollama, system=codex |');
    });

    it('logs invalid step provider metadata and omits the row', () => {
      mockDb.getProjectConfig.mockReturnValue({
        default_provider: 'codex',
      });
      mockDb.getProjectMetadata.mockReturnValue('{invalid json');
      const handlers = loadAutomationHandlers();

      const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\repo\\root' });
      const text = textOf(result);

      expect(loggerChild.debug).toHaveBeenCalledWith(
        '[automation-handlers] invalid step_providers JSON for project defaults:',
        expect.any(String),
      );
      expect(text).toContain('### Current Settings');
      expect(text).not.toContain('| Step providers |');
    });

    it('renders smart-routing defaults when config values are empty', () => {
      mockDb.getProjectConfig.mockReturnValue({
        default_provider: null,
        default_model: null,
        verify_command: null,
        auto_fix_enabled: 0,
        test_pattern: null,
        default_timeout: null,
        max_concurrent: null,
        build_verification_enabled: 0,
      });
      const handlers = loadAutomationHandlers();

      const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\repo\\root' });
      const text = textOf(result);

      expect(text).toContain('| Provider | (smart routing) |');
      expect(text).toContain('| Model | (auto) |');
      expect(text).toContain('| Verify command | (none) |');
      expect(text).toContain('| Auto-fix | No |');
      expect(text).toContain('| Test pattern | .test.ts |');
      expect(text).toContain('| Timeout | 30min |');
    });

    it('omits remote rows when no remote agent is configured', () => {
      mockDb.getProjectConfig.mockReturnValue({
        default_provider: 'codex',
        default_model: 'gpt-5',
        verify_command: 'npm test',
        auto_fix_enabled: 0,
      });
      const handlers = loadAutomationHandlers();

      const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\repo\\root' });
      const text = textOf(result);

      expect(text).not.toContain('| Remote agent |');
      expect(text).not.toContain('| Remote path |');
      expect(text).not.toContain('| Prefer remote tests |');
    });
  });

  describe('handleAutoVerifyAndFix', () => {
    it('returns a missing parameter error when working_directory is absent', async () => {
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(mockShared.ErrorCodes.MISSING_REQUIRED_PARAM.code);
      expect(textOf(result)).toContain('working_directory is required');
    });

    it('reports successful verification with remote execution details', async () => {
      mockRouter.runVerifyCommand.mockResolvedValue({
        output: 'ok',
        error: '',
        exitCode: 0,
        remote: true,
        durationMs: 1500,
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        verify_command: 'pnpm typecheck',
        timeout_seconds: 9,
      });
      const text = textOf(result);

      expect(mockCreateTestRunnerRegistry).toHaveBeenCalledWith();
      expect(mockRouter.runVerifyCommand).toHaveBeenCalledWith('pnpm typecheck', 'C:\\repo', { timeout: 9000 });
      expect(text).toContain('### Result: PASSED');
      expect(text).toContain('**Execution:** remote (agent)');
      expect(text).toContain('**Duration:** 1.5s');
    });

    it('prints governance warnings and still runs verification in warn mode', async () => {
      mockGovernanceHooks = {
        evaluatePreVerify: vi.fn(async () => ({
          blocked: [],
          warned: [{ message: 'Test suite has been run 3 times for this change set.' }],
          shadowed: [],
          allPassed: true,
        })),
      };
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        verify_command: 'npx vitest run',
      });
      const text = textOf(result);

      expect(mockGovernanceHooks.evaluatePreVerify).toHaveBeenCalledWith(
        expect.objectContaining({ working_directory: 'C:\\repo' }),
        expect.objectContaining({ verify_command: 'npx vitest run' }),
      );
      expect(mockRouter.runVerifyCommand).toHaveBeenCalledTimes(1);
      expect(text).toContain('**Governance warnings:**');
      expect(text).toContain('Test suite has been run 3 times for this change set.');
      expect(text).toContain('### Result: PASSED');
    });

    it('prints governance blocks and skips verification in block mode', async () => {
      mockGovernanceHooks = {
        evaluatePreVerify: vi.fn(async () => ({
          blocked: [{ message: 'Test suite has been run 4 times for this change set.' }],
          warned: [],
          shadowed: [],
          allPassed: false,
        })),
      };
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        verify_command: 'npx vitest run',
      });
      const text = textOf(result);

      expect(mockGovernanceHooks.evaluatePreVerify).toHaveBeenCalledWith(
        expect.objectContaining({ working_directory: 'C:\\repo' }),
        expect.objectContaining({ verify_command: 'npx vitest run' }),
      );
      expect(mockRouter.runVerifyCommand).not.toHaveBeenCalled();
      expect(text).toContain('**Governance blocks:**');
      expect(text).toContain('Test suite has been run 4 times for this change set.');
      expect(text).toContain('### Result: SKIPPED');
      expect(text).toContain('Verification skipped.');
    });

    it('omits execution metadata for local passing verification', async () => {
      mockRouter.runVerifyCommand.mockResolvedValue({
        output: 'all good',
        error: '',
        exitCode: 0,
        remote: false,
        durationMs: 0,
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
      });
      const text = textOf(result);

      expect(text).toContain('### Result: PASSED');
      expect(text).not.toContain('**Execution:**');
      expect(text).not.toContain('**Duration:**');
    });

    it('parses TypeScript failures without auto-submitting when auto_fix is false', async () => {
      mockRouter.runVerifyCommand.mockResolvedValue({
        output: [
          'src/foo.ts(12,5): error TS2322: Type "string" is not assignable to type "number".',
          'src\\bar.ts(1,1): error TS7006: Parameter "value" implicitly has an "any" type.',
        ].join('\n'),
        error: '',
        exitCode: 2,
        remote: false,
        durationMs: 0,
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        auto_fix: false,
      });
      const text = textOf(result);

      expect(text).toContain('FAILED (2 errors in 2 files)');
      expect(text).toContain('**src/foo.ts:**');
      expect(text).toContain('**src/bar.ts:**');
      expect(text).toContain('**Summary:** 2 errors, 0 fix tasks submitted');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('reports failed verification with zero parsed TypeScript errors when output does not match', async () => {
      mockRouter.runVerifyCommand.mockResolvedValue({
        output: 'Build failed with generic compiler output',
        error: '',
        exitCode: 1,
        remote: false,
        durationMs: 0,
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
      });
      const text = textOf(result);

      expect(text).toContain('FAILED (0 errors in 0 files)');
      expect(text).toContain('**Summary:** 0 errors, 0 fix tasks submitted');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('submits one fix task per file when auto-fix is enabled', async () => {
      mockRouter.runVerifyCommand.mockResolvedValue({
        output: [
          'src/app.ts(8,2): error TS2304: Cannot find name "missingThing".',
          'src/util.ts(4,1): error TS2554: Expected 2 arguments, but got 1.',
        ].join('\n'),
        error: '',
        exitCode: 2,
        remote: false,
        durationMs: 0,
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        fix_provider: 'ollama',
      });
      const text = textOf(result);

      expect(mockDb.createTask).toHaveBeenCalledTimes(2);
      expect(mockDb.createTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000001',
        provider: null,
        timeout_minutes: 10,
        priority: 5,
      }));
      // Fix tasks now use deferred assignment with intended_provider in metadata
      const firstCallMeta = JSON.parse(mockDb.createTask.mock.calls[0][0].metadata);
      expect(firstCallMeta.intended_provider).toBe('ollama');
      expect(mockDb.createTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000002',
        provider: null,
      }));
      const secondCallMeta = JSON.parse(mockDb.createTask.mock.calls[1][0].metadata);
      expect(secondCallMeta.intended_provider).toBe('ollama');
      expect(mockTaskManager.startTask).toHaveBeenNthCalledWith(1, '00000000-0000-4000-8000-000000000001');
      expect(mockTaskManager.startTask).toHaveBeenNthCalledWith(2, '00000000-0000-4000-8000-000000000002');
      expect(text).toContain('Task `00000000` submitted to ollama');
      expect(text).toContain('**Summary:** 2 errors, 2 fix tasks submitted');
    });

    it('uses source task context when building an error-feedback prompt', async () => {
      mockDb.getTask.mockReturnValue({
        id: 'source-task',
        output: 'original task context',
      });
      mockBuildErrorFeedbackPrompt.mockReturnValue('FEEDBACK PROMPT');
      mockRouter.runVerifyCommand.mockResolvedValue({
        output: [
          'src/app.ts(8,2): error TS2304: Cannot find name "missingThing".',
          'src/app.ts(12,4): error TS2345: Argument of type "string" is not assignable to parameter of type "number".',
        ].join('\n'),
        error: '',
        exitCode: 2,
        remote: false,
        durationMs: 0,
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        source_task_id: 'source-task',
      });
      const text = textOf(result);

      expect(mockBuildErrorFeedbackPrompt).toHaveBeenCalledWith(
        expect.stringContaining('Fix TypeScript errors in src/app.ts'),
        'original task context',
        expect.stringContaining('TS2304'),
      );
      expect(mockDb.createTask).toHaveBeenCalledWith(expect.objectContaining({
        task_description: 'FEEDBACK PROMPT',
      }));
      expect(text).toContain('**Summary:** 2 errors, 1 fix tasks submitted');
    });

    it('logs source task lookup failures and falls back to the plain prompt', async () => {
      mockDb.getTask.mockImplementation(() => {
        throw new Error('db offline');
      });
      mockRouter.runVerifyCommand.mockResolvedValue({
        output: 'src/app.ts(8,2): error TS2304: Cannot find name "missingThing".',
        error: '',
        exitCode: 2,
        remote: false,
        durationMs: 0,
      });
      const handlers = loadAutomationHandlers();

      await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        source_task_id: 'source-task',
      });

      expect(loggerChild.debug).toHaveBeenCalledWith(
        '[automation-handlers] non-critical error loading source task:',
        'db offline',
      );
      expect(mockDb.createTask).toHaveBeenCalledWith(expect.objectContaining({
        task_description: expect.stringContaining('Read the file, understand the context around each error line'),
      }));
      expect(mockBuildErrorFeedbackPrompt).not.toHaveBeenCalled();
    });

    it('reports fix task submission failures inline', async () => {
      mockRouter.runVerifyCommand.mockResolvedValue({
        output: 'src/app.ts(8,2): error TS2304: Cannot find name "missingThing".',
        error: '',
        exitCode: 2,
        remote: false,
        durationMs: 0,
      });
      mockDb.createTask.mockImplementation(() => {
        throw new Error('db down');
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
      });
      const text = textOf(result);

      expect(mockTaskManager.startTask).not.toHaveBeenCalled();
      expect(text).toContain('Failed to submit fix task — db down');
      expect(text).toContain('**Summary:** 1 errors, 0 fix tasks submitted');
    });

    it('returns an internal error when verification throws unexpectedly', async () => {
      mockRouter.runVerifyCommand.mockRejectedValue(new Error('router exploded'));
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(mockShared.ErrorCodes.INTERNAL_ERROR.code);
      expect(textOf(result)).toContain('INTERNAL_ERROR: router exploded');
    });
  });

  describe('handleGenerateTestTasks', () => {
    it('returns a missing parameter error when working_directory is absent', async () => {
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(mockShared.ErrorCodes.MISSING_REQUIRED_PARAM.code);
      expect(textOf(result)).toContain('working_directory is required');
    });

    it('rejects non-string source_dirs values', async () => {
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({
        working_directory: 'C:\\repo',
        source_dirs: ['src', 7],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(mockShared.ErrorCodes.INVALID_PARAM.code);
      expect(textOf(result)).toContain('source_dirs must be an array of strings or a string');
    });

    it('accepts a single source_dirs string and scans that directory', async () => {
      const workingDir = 'C:\\repo';
      addVirtualFiles({
        [actualPath.join(workingDir, 'app', 'Feature.ts')]: buildLines(24, 'feature'),
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        source_dirs: 'app',
        count: 1,
      });
      const text = textOf(result);

      expect(text).toContain('**Source files:** 1');
      expect(text).toContain('**Untested files:** 1');
      expect(text).toContain('| app/Feature.ts | 24 |');
    });

    it('reports when no suitable untested files remain after filtering', async () => {
      const workingDir = 'C:\\repo';
      addVirtualFiles({
        [actualPath.join(workingDir, 'src', 'main.ts')]: buildLines(30, 'main'),
        [actualPath.join(workingDir, 'src', 'tiny.ts')]: buildLines(3, 'tiny'),
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({ working_directory: workingDir });
      const text = textOf(result);

      expect(text).toContain('Test Gap Analysis');
      expect(text).toContain('No suitable untested files found.');
    });

    it('selects the largest untested files first and respects count', async () => {
      const workingDir = 'C:\\repo';
      addVirtualFiles({
        [actualPath.join(workingDir, 'src', 'systems', 'BigSystem.ts')]: buildLines(60, 'big'),
        [actualPath.join(workingDir, 'src', 'systems', 'MediumSystem.ts')]: buildLines(40, 'medium'),
        [actualPath.join(workingDir, 'src', 'systems', 'SmallSystem.ts')]: buildLines(25, 'small'),
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        count: 2,
      });
      const text = textOf(result);
      const json = extractJsonBlock(text);

      expect(text).toContain('| src/systems/BigSystem.ts | 60 |');
      expect(text).toContain('| src/systems/MediumSystem.ts | 40 |');
      expect(text).not.toContain('| src/systems/SmallSystem.ts | 25 |');
      expect(json).toHaveLength(2);
      expect(json[0].node_id).toBe('test-bigsystem');
      expect(json[1].node_id).toBe('test-mediumsystem');
    });

    it('reuses an existing related test file outside __tests__ when generating tasks', async () => {
      const workingDir = 'C:\\repo';
      addVirtualFiles({
        [actualPath.join(workingDir, 'src', 'handlers', 'task-pipeline.js')]: buildLines(40, 'pipeline'),
        [actualPath.join(workingDir, 'tests', 'handler-task-pipeline.test.js')]: 'export {}',
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        source_dirs: ['src/handlers', 'tests'],
        test_pattern: '.test.js',
        count: 1,
      });
      const text = textOf(result);
      const json = extractJsonBlock(text);

      expect(text).toContain('| src/handlers/task-pipeline.js | 40 | tests/handler-task-pipeline.test.js |');
      expect(json).toHaveLength(1);
      expect(json[0].task).toContain('Extend the existing test file tests/handler-task-pipeline.test.js');
    });

    it('respects exclude_patterns and min_lines when selecting candidates', async () => {
      const workingDir = 'C:\\repo';
      addVirtualFiles({
        [actualPath.join(workingDir, 'src', 'BootScene.ts')]: buildLines(80, 'boot'),
        [actualPath.join(workingDir, 'src', 'PlayableScene.ts')]: buildLines(18, 'playable'),
        [actualPath.join(workingDir, 'src', 'BattleScene.ts')]: buildLines(35, 'battle'),
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        exclude_patterns: ['BootScene'],
        min_lines: 20,
      });
      const text = textOf(result);
      const json = extractJsonBlock(text);

      expect(text).toContain('| src/BattleScene.ts | 35 |');
      expect(text).not.toContain('BootScene');
      expect(text).not.toContain('PlayableScene');
      expect(json).toHaveLength(1);
    });

    it('recognizes .spec.js tests even when test_pattern is .test.js', async () => {
      const workingDir = 'C:\\repo';
      addVirtualFiles({
        [actualPath.join(workingDir, 'src', 'Widget.js')]: buildLines(28, 'widget'),
        [actualPath.join(workingDir, 'src', 'Widget.spec.js')]: 'export {}',
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        test_pattern: '.test.js',
      });
      const text = textOf(result);

      expect(text).toContain('**Test files:** 1');
      expect(text).toContain('**Untested files:** 1');
      expect(text).toContain('| src/Widget.js | 28 | src/__tests__/Widget.test.js |');
    });

    it('auto-submits generated tasks and starts the task manager', async () => {
      const workingDir = 'C:\\repo';
      addVirtualFiles({
        [actualPath.join(workingDir, 'src', 'systems', 'QueueSystem.ts')]: buildLines(32, 'queue-system'),
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        auto_submit: true,
        provider: 'claude-cli',
        count: 1,
      });
      const text = textOf(result);

      expect(mockDb.createTask).toHaveBeenCalledWith(expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000001',
        provider: 'claude-cli',
        working_directory: workingDir,
        timeout_minutes: 15,
      }));
      expect(mockDb.createTask.mock.calls[0][0].task_description).toContain('with ~8 tests');
      expect(mockTaskManager.startTask).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
      expect(text).toContain('Submitted 1 test tasks to claude-cli.');
    });

    it('reports auto-submit failures inline', async () => {
      const workingDir = 'C:\\repo';
      addVirtualFiles({
        [actualPath.join(workingDir, 'src', 'systems', 'QueueSystem.ts')]: buildLines(32, 'queue-system'),
      });
      mockDb.createTask.mockImplementation(() => {
        throw new Error('queue full');
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        auto_submit: true,
        count: 1,
      });
      const text = textOf(result);

      expect(mockTaskManager.startTask).not.toHaveBeenCalled();
      expect(text).toContain('Submit failed: queue full');
      expect(text).toContain('Submitted 0 test tasks to codex.');
    });

    it('applies custom category templates and the custom default template', async () => {
      const workingDir = 'C:\\repo';
      addVirtualFiles({
        [actualPath.join(workingDir, 'src', 'ui', 'Dialog.ts')]: buildLines(28, 'dialog'),
        [actualPath.join(workingDir, 'src', 'misc', 'Worker.ts')]: buildLines(28, 'worker'),
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        count: 2,
        category_templates: {
          '/ui/': 'Custom UI template',
        },
        default_template: 'Generic fallback template',
      });
      const json = extractJsonBlock(textOf(result));

      expect(json.map((item) => item.task)).toEqual([
        'Generic fallback template',
        'Custom UI template',
      ]);
    });

    it('ignores node_modules, build, coverage, and __mocks__ directories', async () => {
      const workingDir = 'C:\\repo';
      addVirtualFiles({
        [actualPath.join(workingDir, 'src', 'Feature.ts')]: buildLines(26, 'feature'),
        [actualPath.join(workingDir, 'src', 'node_modules', 'Skip.ts')]: buildLines(40, 'skip'),
        [actualPath.join(workingDir, 'src', 'build', 'SkipToo.ts')]: buildLines(40, 'skip'),
        [actualPath.join(workingDir, 'src', 'coverage', 'SkipThree.ts')]: buildLines(40, 'skip'),
        [actualPath.join(workingDir, 'src', '__mocks__', 'SkipFour.ts')]: buildLines(40, 'skip'),
      });
      const handlers = loadAutomationHandlers();

      const result = await handlers.handleGenerateTestTasks({
        working_directory: workingDir,
      });
      const text = textOf(result);

      expect(text).toContain('**Source files:** 1');
      expect(text).not.toContain('Skip.ts');
      expect(text).toContain('| src/Feature.ts | 26 |');
    });
  });

  describe('handleUpdateProjectStats', () => {
    it('is no longer exported from automation handlers', () => {
      const handlers = loadAutomationHandlers();

      expect(handlers.handleUpdateProjectStats).toBeUndefined();
    });
  });
});
