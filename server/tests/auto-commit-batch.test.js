import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const path = require('node:path');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const MODULE_PATH = '../handlers/auto-commit-batch';
const MOCKED_MODULES = [
  MODULE_PATH,
  '../utils/safe-exec',
  '../execution/command-policy',
  '../utils/temp-file-filter',
  '../utils/shell-policy',
  '../db/config-core',
  '../db/project-config-core',
  '../utils/resource-gate',
  '../utils/host-monitoring',
  '../logger',
];

let testDir;
let workingDir;
let mockSafeExecChain;
let mockExecuteValidatedCommand;
let mockFilterTempFiles;
let mockValidateShellCommand;
let mockGetConfig;
let mockGetProjectDefaults;
let mockCheckResourceGate;
let mockLoggerChild;
let mockHostMonitoring;

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

function clearCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module has not been loaded yet.
  }
}

function clearCjsModules(modulePaths) {
  for (const modulePath of modulePaths) {
    clearCjsModule(modulePath);
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

function installDependencyMocks() {
  installCjsModuleMock('../utils/safe-exec', {
    safeExecChain: mockSafeExecChain,
  });
  installCjsModuleMock('../execution/command-policy', {
    executeValidatedCommand: mockExecuteValidatedCommand,
  });
  installCjsModuleMock('../utils/temp-file-filter', {
    filterTempFiles: mockFilterTempFiles,
  });
  installCjsModuleMock('../utils/shell-policy', {
    validateShellCommand: mockValidateShellCommand,
  });
  installCjsModuleMock('../db/config-core', {
    getConfig: mockGetConfig,
  });
  installCjsModuleMock('../db/project-config-core', {
    getProjectDefaults: mockGetProjectDefaults,
  });
  installCjsModuleMock('../utils/resource-gate', {
    checkResourceGate: mockCheckResourceGate,
  });
  installCjsModuleMock('../utils/host-monitoring', mockHostMonitoring);
  installCjsModuleMock('../logger', {
    child: vi.fn(() => mockLoggerChild),
  });
}

function loadHandler(options = {}) {
  clearCjsModule(MODULE_PATH);
  const mod = require(MODULE_PATH);
  const resolveTrackedCommitFiles = options.resolveTrackedCommitFiles || vi.fn(() => []);
  const getFallbackCommitFiles = options.getFallbackCommitFiles || vi.fn(() => []);

  mod.init({ resolveTrackedCommitFiles, getFallbackCommitFiles });

  return {
    ...mod,
    resolveTrackedCommitFiles,
    getFallbackCommitFiles,
  };
}

function findGitCall(subcommand) {
  return mockExecuteValidatedCommand.mock.calls.find(
    ([command, args]) => command === 'git' && Array.isArray(args) && args[0] === subcommand,
  );
}

function mockSuccessfulGitFlow(filesToCommit) {
  const stagedOutput = filesToCommit.length > 0 ? `${filesToCommit.join('\n')}\n` : '';

  mockExecuteValidatedCommand.mockImplementation(async (command, args = []) => {
    if (command !== 'git') {
      throw new Error(`Unexpected command: ${command}`);
    }

    switch (args[0]) {
      case 'rev-parse':
        return { stdout: `${workingDir}\n` };
      case 'add':
        return { stdout: '' };
      case 'diff':
        return { stdout: stagedOutput };
      case 'commit':
        return { stdout: '[main abc123] commit\n' };
      case 'push':
        return { stdout: '' };
      default:
        throw new Error(`Unexpected git command: ${args.join(' ')}`);
    }
  });
}

beforeEach(() => {
  ({ testDir } = setupTestDbOnly('auto-commit-batch'));
  workingDir = path.join(testDir, 'repo');

  mockSafeExecChain = vi.fn(() => ({
    exitCode: 0,
    output: '7 passed',
    stderr: '',
    error: '',
  }));
  mockExecuteValidatedCommand = vi.fn(async (_command, args = []) => {
    if (args[0] === 'diff') {
      return { stdout: '' };
    }
    return { stdout: '' };
  });
  mockFilterTempFiles = vi.fn((files) => ({
    kept: [...files],
    excluded: [],
  }));
  mockValidateShellCommand = vi.fn(() => ({ ok: true }));
  mockGetConfig = vi.fn(() => null);
  mockGetProjectDefaults = vi.fn(() => null);
  mockCheckResourceGate = vi.fn(() => ({ allowed: true }));
  mockLoggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  mockHostMonitoring = {
    hostActivityCache: new Map(),
  };

  vi.resetModules();
  clearCjsModules(MOCKED_MODULES);
  installDependencyMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  clearCjsModules(MOCKED_MODULES);
  teardownTestDb();
});

describe('auto-commit-batch handler', () => {
  it('returns error when working_directory is missing', async () => {
    const { handleAutoCommitBatch } = loadHandler();

    const result = await handleAutoCommitBatch({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('working_directory is required');
    expect(mockExecuteValidatedCommand).not.toHaveBeenCalled();
  });

  it('returns error when verify_command is rejected by shell policy', async () => {
    mockGetProjectDefaults.mockReturnValue({
      verify_command: 'pnpm forbidden',
    });
    mockValidateShellCommand.mockReturnValue({
      ok: false,
      reason: 'blocked by shell policy',
    });

    const { handleAutoCommitBatch } = loadHandler();
    const result = await handleAutoCommitBatch({ working_directory: workingDir });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('verify_command rejected: blocked by shell policy');
    expect(mockGetProjectDefaults).toHaveBeenCalledWith(workingDir);
    expect(mockSafeExecChain).not.toHaveBeenCalled();
  });

  it('returns error when verification fails with a non-zero exit code', async () => {
    mockSafeExecChain.mockReturnValue({
      exitCode: 1,
      output: '',
      stderr: 'src/app.ts(1,1): error TS1005: ; expected\n2 failed',
      error: '',
    });

    const { handleAutoCommitBatch } = loadHandler();
    const result = await handleAutoCommitBatch({ working_directory: workingDir });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toContain('Verification **FAILED**');
    expect(text).toContain('TypeScript errors');
    expect(text).toContain('2 test failures');
    expect(text).toContain('Aborting commit. Fix errors first.');
    expect(mockExecuteValidatedCommand).not.toHaveBeenCalled();
  });

  it('returns success when there are no files to commit', async () => {
    const resolveTrackedCommitFiles = vi.fn(() => []);
    const getFallbackCommitFiles = vi.fn(() => []);
    const { handleAutoCommitBatch } = loadHandler({
      resolveTrackedCommitFiles,
      getFallbackCommitFiles,
    });

    const args = { working_directory: workingDir, verify: false };
    const result = await handleAutoCommitBatch(args);
    const text = result.content[0].text;

    expect(result.isError).not.toBe(true);
    expect(text).toContain('No changes to commit — working tree is clean.');
    expect(resolveTrackedCommitFiles).toHaveBeenCalledWith(args, workingDir);
    expect(getFallbackCommitFiles).toHaveBeenCalledWith(workingDir);
    expect(mockFilterTempFiles).toHaveBeenCalledWith([]);
    expect(findGitCall('rev-parse')).toBeTruthy();
  });

  it('stages and commits files successfully', async () => {
    const filesToCommit = ['src/app.js', 'README.md'];
    mockSuccessfulGitFlow(filesToCommit);
    mockSafeExecChain.mockReturnValue({
      exitCode: 0,
      output: '12 passed',
      stderr: '',
      error: '',
    });

    const { handleAutoCommitBatch } = loadHandler({
      resolveTrackedCommitFiles: vi.fn(() => filesToCommit),
    });

    const result = await handleAutoCommitBatch({
      working_directory: workingDir,
      verify: false,
      commit_message: 'feat: batch commit',
    });
    const text = result.content[0].text;
    const addCall = findGitCall('add');
    const commitCall = findGitCall('commit');

    expect(result.isError).not.toBe(true);
    expect(text).toContain('2 file(s) selected for commit');
    expect(text).toContain('Committed: "feat: batch commit"');
    expect(text).toContain('- **Files:** 2 committed');
    expect(text).toContain('- **Pushed:** No');
    expect(addCall[1]).toEqual(['add', '--', 'src/app.js', 'README.md']);
    expect(commitCall[1][0]).toBe('commit');
    expect(commitCall[1][1]).toBe('-m');
    expect(commitCall[1][2]).toContain('feat: batch commit');
    expect(commitCall[1][2]).toContain('Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>');
    expect(commitCall[1].slice(3)).toEqual(['--', 'src/app.js', 'README.md']);
  });

  it('pushes after commit when auto_push is true', async () => {
    const filesToCommit = ['src/pushed.js'];
    mockSuccessfulGitFlow(filesToCommit);

    const { handleAutoCommitBatch } = loadHandler({
      resolveTrackedCommitFiles: vi.fn(() => filesToCommit),
    });

    const result = await handleAutoCommitBatch({
      working_directory: workingDir,
      verify: false,
      auto_push: true,
      commit_message: 'feat: push batch',
    });
    const text = result.content[0].text;

    expect(result.isError).not.toBe(true);
    expect(findGitCall('push')).toBeTruthy();
    expect(text).toContain('Pushed to remote.');
    expect(text).toContain('- **Pushed:** Yes');
  });

  it('truncates commit_message values longer than 4096 characters', async () => {
    const filesToCommit = ['src/long-message.js'];
    const longMessage = 'x'.repeat(5000);
    mockSuccessfulGitFlow(filesToCommit);

    const { handleAutoCommitBatch } = loadHandler({
      resolveTrackedCommitFiles: vi.fn(() => filesToCommit),
    });

    const result = await handleAutoCommitBatch({
      working_directory: workingDir,
      verify: false,
      commit_message: longMessage,
    });
    const text = result.content[0].text;
    const commitCall = findGitCall('commit');
    const [subject, footer] = commitCall[1][2].split('\n\nCo-Authored-By: ');

    expect(result.isError).not.toBe(true);
    expect(text).toContain('commit_message exceeded 4096 characters and was truncated');
    expect(subject).toHaveLength(4096);
    expect(subject).toBe(longMessage.slice(0, 4096));
    expect(footer).toBe('Claude Opus 4.6 <noreply@anthropic.com>');
  });

  it('filters temp files out of the commit set', async () => {
    const rawFiles = ['src/app.js', 'tmp/agent-output.tmp'];
    mockFilterTempFiles.mockReturnValue({
      kept: ['src/app.js'],
      excluded: ['tmp/agent-output.tmp'],
    });
    mockSuccessfulGitFlow(['src/app.js']);

    const { handleAutoCommitBatch } = loadHandler({
      resolveTrackedCommitFiles: vi.fn(() => rawFiles),
    });

    const result = await handleAutoCommitBatch({
      working_directory: workingDir,
      verify: false,
      commit_message: 'feat: filtered batch',
    });
    const text = result.content[0].text;
    const addCall = findGitCall('add');
    const diffCall = findGitCall('diff');
    const commitCall = findGitCall('commit');

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Excluded 1 temp file(s): tmp/agent-output.tmp');
    expect(mockFilterTempFiles).toHaveBeenCalledWith(rawFiles);
    expect(addCall[1]).toEqual(['add', '--', 'src/app.js']);
    expect(diffCall[1]).toEqual(['diff', '--cached', '--name-only', '--relative', '--', 'src/app.js']);
    expect(commitCall[1].slice(3)).toEqual(['--', 'src/app.js']);
  });
});
