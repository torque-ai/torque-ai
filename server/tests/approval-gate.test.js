'use strict';

const path = require('path');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SUBJECT_MODULE = '../hooks/approval-gate';
const TASK_CORE_MODULE = '../db/task-core';
const FILE_TRACKING_MODULE = '../db/file-tracking';
const VALIDATION_RULES_MODULE = '../db/validation-rules';
const LOGGER_MODULE = '../logger';
const CONSTANTS_MODULE = '../constants';
const CHILD_PROCESS_MODULE = 'child_process';

const subjectPath = require.resolve(SUBJECT_MODULE);
const taskCorePath = require.resolve(TASK_CORE_MODULE);
const fileTrackingPath = require.resolve(FILE_TRACKING_MODULE);
const validationRulesPath = require.resolve(VALIDATION_RULES_MODULE);
const loggerPath = require.resolve(LOGGER_MODULE);
const constantsPath = require.resolve(CONSTANTS_MODULE);
const childProcessPath = require.resolve(CHILD_PROCESS_MODULE);
const gitUtilsPath = require.resolve('../utils/git');

function clearModuleCaches() {
  delete require.cache[subjectPath];
  delete require.cache[taskCorePath];
  delete require.cache[fileTrackingPath];
  delete require.cache[validationRulesPath];
  delete require.cache[loggerPath];
  delete require.cache[constantsPath];
  delete require.cache[childProcessPath];
  delete require.cache[gitUtilsPath];
}

function createDbMock(overrides) {
  return {
    getTask: vi.fn(() => null),
    getValidationResults: vi.fn(() => []),
    getTaskFileChanges: vi.fn(() => []),
    compareFileToBaseline: vi.fn(() => ({ hasBaseline: false })),
    ...overrides,
  };
}

function loadSubject(options = {}) {
  const db = createDbMock(options.db);
  const approvalLogger = {
    info: vi.fn(),
  };
  const logger = {
    child: vi.fn(() => approvalLogger),
  };
  const childProcess = {
    execFileSync: vi.fn(() => ''),
    ...(options.childProcess || {}),
  };
  const constants = {
    TASK_TIMEOUTS: {
      GIT_DIFF: options.gitDiffTimeout || 4321,
    },
  };

  // Split db mock into per-module mocks matching the source imports
  const taskCoreMock = { getTask: db.getTask };
  const fileTrackingMock = {
    getTaskFileChanges: db.getTaskFileChanges,
    compareFileToBaseline: db.compareFileToBaseline,
  };
  const validationRulesMock = {
    getValidationResults: db.getValidationResults,
  };

  clearModuleCaches();
  installMock(TASK_CORE_MODULE, taskCoreMock);
  installMock(FILE_TRACKING_MODULE, fileTrackingMock);
  installMock(VALIDATION_RULES_MODULE, validationRulesMock);
  installMock(LOGGER_MODULE, logger);
  installMock(CONSTANTS_MODULE, constants);
  installMock(CHILD_PROCESS_MODULE, childProcess);
  installMock('../utils/git', {
    safeGitExec: (args, opts) => childProcess.execFileSync('git', args, {
      encoding: 'utf8',
      timeout: constants.TASK_TIMEOUTS.GIT_DIFF,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...opts,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...(opts?.env || {}) },
    }),
    gitRefExists: (workingDir, ref, opts = {}) => {
      try {
        childProcess.execFileSync('git', ['rev-parse', '--verify', ref], {
          cwd: workingDir,
          encoding: 'utf8',
          timeout: opts.timeout || constants.TASK_TIMEOUTS.GIT_DIFF,
          maxBuffer: 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        });
        return true;
      } catch {
        return false;
      }
    },
  });

  return {
    ...require(SUBJECT_MODULE),
    db,
    logger,
    approvalLogger,
    childProcess,
    constants,
  };
}

afterEach(() => {
  clearModuleCaches();
  vi.clearAllMocks();
});

describe('hooks/approval-gate', () => {
  it('rejects missing task ids before hitting the database', () => {
    const { checkApprovalGate, db, approvalLogger } = loadSubject();

    expect(checkApprovalGate('   ')).toEqual({
      approved: false,
      reasons: ['taskId is required'],
    });
    expect(db.getTask).not.toHaveBeenCalled();
    expect(approvalLogger.info).not.toHaveBeenCalled();
  });

  it('rejects unknown tasks', () => {
    const { checkApprovalGate, db, approvalLogger } = loadSubject({
      db: {
        getTask: vi.fn(() => null),
      },
    });

    expect(checkApprovalGate('task-missing')).toEqual({
      approved: false,
      reasons: ['Task not found: task-missing'],
    });
    expect(db.getTask).toHaveBeenCalledWith('task-missing');
    expect(approvalLogger.info).not.toHaveBeenCalled();
  });

  it('approves clean tasks when optional validation and baseline hooks are unavailable', () => {
    const { checkApprovalGate, db, logger, approvalLogger, childProcess } = loadSubject({
      db: {
        getTask: vi.fn(() => ({
          id: 'task-clean',
          output: 'completed successfully',
          working_directory: '   ',
        })),
        getValidationResults: undefined,
      },
    });

    expect(checkApprovalGate('task-clean')).toEqual({
      approved: true,
      reasons: [],
    });
    expect(logger.child).toHaveBeenCalledWith({ component: 'approval-gate' });
    expect(db.getTask).toHaveBeenCalledWith('task-clean');
    expect(db.compareFileToBaseline).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(approvalLogger.info).toHaveBeenCalledWith('[ApprovalGate] task-clean => approved');
  });

  it('rejects empty output and de-duplicates repeated validation failures', () => {
    const { checkApprovalGate, db, approvalLogger } = loadSubject({
      db: {
        getTask: vi.fn(() => ({
          id: 'task-validation',
          output: '   ',
          working_directory: '',
        })),
        getValidationResults: vi.fn(() => [
          { status: 'fail', rule_name: 'No TODOs', file_path: 'src/todo.js' },
          { status: 'fail', rule_name: 'No TODOs', file_path: 'src/todo.js' },
          { status: 'pass', rule_name: 'No Console', file_path: 'src/todo.js' },
          { status: 'fail', rule_name: '', file_path: '  ' },
        ]),
      },
    });

    expect(checkApprovalGate('task-validation')).toEqual({
      approved: false,
      reasons: [
        'Task output is empty',
        'Validation failure: No TODOs (src/todo.js)',
        'Validation failure: unknown rule',
      ],
    });
    expect(db.getValidationResults).toHaveBeenCalledWith('task-validation');
    expect(db.compareFileToBaseline).not.toHaveBeenCalled();
    expect(approvalLogger.info).toHaveBeenCalledWith('[ApprovalGate] task-validation => rejected');
  });

  it('rejects destructive file shrink and falls back to the absolute file path when needed', () => {
    const workingDirectory = path.join(process.cwd(), 'approval-gate-workdir');
    const relativePath = path.join('src', 'shrunk.js');
    const absolutePath = path.join(workingDirectory, relativePath);

    const { checkApprovalGate, db, approvalLogger } = loadSubject({
      db: {
        getTask: vi.fn(() => ({
          id: 'task-shrink',
          output: 'done',
          working_directory: workingDirectory,
        })),
        getTaskFileChanges: vi.fn(() => [
          { file_path: absolutePath },
        ]),
        compareFileToBaseline: vi.fn((filePath, cwd) => {
          expect(cwd).toBe(workingDirectory);
          if (filePath === relativePath) {
            return { hasBaseline: false };
          }

          if (filePath === absolutePath) {
            return {
              hasBaseline: true,
              sizeChangePercent: -75,
            };
          }

          return { hasBaseline: false };
        }),
      },
    });

    expect(checkApprovalGate('task-shrink')).toEqual({
      approved: false,
      reasons: [`${relativePath} shrank by 75.0%`],
    });
    expect(db.getTaskFileChanges).toHaveBeenCalledWith('task-shrink');
    expect(db.compareFileToBaseline).toHaveBeenNthCalledWith(1, relativePath, workingDirectory);
    expect(db.compareFileToBaseline).toHaveBeenNthCalledWith(2, absolutePath, workingDirectory);
    expect(approvalLogger.info).toHaveBeenCalledWith('[ApprovalGate] task-shrink => rejected');
  });

  it('falls back to git diff output when tracked file changes are unavailable', () => {
    const workingDirectory = path.join(process.cwd(), 'approval-gate-git');
    const relativePath = path.join('src', 'git-only.js');

    const { checkApprovalGate, db, childProcess, constants, approvalLogger } = loadSubject({
      db: {
        getTask: vi.fn(() => ({
          id: 'task-git-diff',
          output: 'done',
          working_directory: workingDirectory,
        })),
        getTaskFileChanges: vi.fn(() => []),
        compareFileToBaseline: vi.fn(() => ({
          hasBaseline: true,
          sizeChangePercent: -51,
        })),
      },
      childProcess: {
        execFileSync: vi.fn()
          .mockImplementationOnce(() => {
            throw new Error('git missing');
          })
          .mockImplementationOnce(() => '   ')
          .mockImplementationOnce(() => 'deadbeef\n')
          .mockImplementationOnce(() => `${relativePath}\n`),
      },
    });

    expect(checkApprovalGate('task-git-diff')).toEqual({
      approved: false,
      reasons: [`${relativePath} shrank by 51.0%`],
    });
    expect(childProcess.execFileSync).toHaveBeenNthCalledWith(1, 'git', ['diff', '--name-only'], {
      cwd: workingDirectory,
      encoding: 'utf8',
      timeout: constants.TASK_TIMEOUTS.GIT_DIFF,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: expect.objectContaining({
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      }),
    });
    expect(childProcess.execFileSync).toHaveBeenNthCalledWith(2, 'git', ['diff', '--name-only', '--cached'], {
      cwd: workingDirectory,
      encoding: 'utf8',
      timeout: constants.TASK_TIMEOUTS.GIT_DIFF,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: expect.objectContaining({
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      }),
    });
    expect(childProcess.execFileSync).toHaveBeenNthCalledWith(3, 'git', ['rev-parse', '--verify', 'HEAD~1'], {
      cwd: workingDirectory,
      encoding: 'utf8',
      timeout: constants.TASK_TIMEOUTS.GIT_DIFF,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: expect.objectContaining({
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      }),
    });
    expect(childProcess.execFileSync).toHaveBeenNthCalledWith(4, 'git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      cwd: workingDirectory,
      encoding: 'utf8',
      timeout: constants.TASK_TIMEOUTS.GIT_DIFF,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: expect.objectContaining({
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      }),
    });
    expect(db.compareFileToBaseline).toHaveBeenCalledWith(relativePath, workingDirectory);
    expect(approvalLogger.info).toHaveBeenCalledWith('[ApprovalGate] task-git-diff => rejected');
  });
});
