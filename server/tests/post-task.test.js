const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const childProcess = require('child_process');

let testDir;
let taskCore;
let projectConfigCore;
let fileTracking;
let mod;
let mockExecFileSync;
let mockSpawnSync;
let saveBuildResultSpy;

const originalExecFileSync = childProcess.execFileSync;
const originalSpawnSync = childProcess.spawnSync;
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

function setup() {
  ({ testDir } = setupTestDbOnly('post-task'));

  mockExecFileSync = vi.fn();
  mockSpawnSync = vi.fn();
  childProcess.execFileSync = mockExecFileSync;
  childProcess.spawnSync = mockSpawnSync;

  delete require.cache[require.resolve('../validation/build-verification')];
  delete require.cache[require.resolve('../validation/post-task')];

  taskCore = require('../db/task-core');
  projectConfigCore = require('../db/project-config-core');
  fileTracking = require('../db/file-tracking');

  saveBuildResultSpy = vi.fn((...args) => fileTracking.saveBuildResult(...args));

  mod = require('../validation/post-task');
  mod.init({
    db: {
      getProjectFromPath: (...args) => projectConfigCore.getProjectFromPath(...args),
      getProjectConfig: (...args) => projectConfigCore.getProjectConfig(...args),
      saveBuildResult: (...args) => saveBuildResultSpy(...args),
      getTask: (...args) => taskCore.getTask(...args),
      getTaskFileChanges: (...args) => fileTracking.getTaskFileChanges(...args),
    },
    getModifiedFiles: () => [],
    parseGitStatusLine: (line) => ({ filePath: line.trim().replace(/^[AMDR?! ]{1,3}\s*"?/, '').replace(/"$/, '').trim() }),
    sanitizeLLMOutput: (output) => output,
  });
}

function teardown() {
  childProcess.execFileSync = originalExecFileSync;
  childProcess.spawnSync = originalSpawnSync;
  teardownTestDb();
}

function makeWorkDir(name) {
  const dir = path.join(testDir, `${name}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(workingDir, relativePath, content) {
  const fullPath = path.join(workingDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

function setProjectConfig(workingDir, config) {
  const project = path.basename(workingDir);
  projectConfigCore.setProjectConfig(project, config);
  return project;
}

function createTaskForDir(workingDir, project = path.basename(workingDir)) {
  const taskId = randomUUID();
  taskCore.createTask({
    id: taskId,
    task_description: 'post-task test',
    status: 'queued',
    working_directory: workingDir,
    project,
  });
  return taskId;
}

function expectUnhandledExec() {
  mockExecFileSync.mockImplementation((cmd, args) => {
    throw new Error(`Unhandled execFileSync call: ${cmd} ${(args || []).join(' ')}`);
  });
}

function expectUnhandledSpawn() {
  mockSpawnSync.mockImplementation((cmd, args) => {
    throw new Error(`Unhandled spawnSync call: ${cmd} ${(args || []).join(' ')}`);
  });
}

describe('post-task validation module', () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    teardown();
  });

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockSpawnSync.mockReset();
    saveBuildResultSpy.mockClear();
    expectUnhandledExec();
    expectUnhandledSpawn();
  });

  describe('cleanupJunkFiles', () => {
    it('removes junk files from git status output and keeps valid files', () => {
      const workingDir = makeWorkDir('cleanup-junk');
      const junkFile = writeFile(workingDir, 'Sure this is junk.js', 'console.log(1);');
      const validFile = writeFile(workingDir, 'src/app.js', 'module.exports = 1;\n');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'status') {
          return '?? "Sure this is junk.js"\n?? src/app.js\n';
        }
        if (cmd === 'git' && args[0] === 'reset') {
          return '';
        }
        throw new Error(`Unexpected git call: ${args.join(' ')}`);
      });

      mod.cleanupJunkFiles(workingDir, 'task-cleanup-1');

      expect(fs.existsSync(junkFile)).toBe(false);
      expect(fs.existsSync(validFile)).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['reset', 'HEAD', '--', 'Sure this is junk.js'],
        expect.objectContaining({ cwd: workingDir })
      );
    });

    it('returns without throwing when git status fails', () => {
      const workingDir = makeWorkDir('cleanup-fail');
      const file = writeFile(workingDir, 'TODO_plan.txt', 'keep me');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'status') {
          throw new Error('not a git repo');
        }
        return '';
      });

      expect(() => mod.cleanupJunkFiles(workingDir, 'task-cleanup-2')).not.toThrow();
      expect(fs.existsSync(file)).toBe(true);
    });
  });

  describe('getFileChangesForValidation', () => {
    it('returns empty array when working directory is missing', () => {
      const missingDir = path.join(testDir, 'missing-dir');
      const result = mod.getFileChangesForValidation(missingDir, 1);
      expect(result).toEqual([]);
    });

    it('collects changed source files and original content', () => {
      const workingDir = makeWorkDir('file-changes-main');
      const currentContent = 'const answer = 42;\nmodule.exports = answer;\n';
      const originalContent = 'module.exports = 1;\n';
      writeFile(workingDir, 'src/a.js', currentContent);
      writeFile(workingDir, 'README.md', '# docs\n');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'diff' && args[2] === 'HEAD~2') {
          return 'src/a.js\nREADME.md\n';
        }
        if (cmd === 'git' && args[0] === 'show' && args[1] === 'HEAD~2:src/a.js') {
          return originalContent;
        }
        throw new Error(`Unexpected git call: ${args.join(' ')}`);
      });

      const result = mod.getFileChangesForValidation(workingDir, 2);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('src/a.js');
      expect(result[0].content).toBe(currentContent);
      expect(result[0].originalContent).toBe(originalContent);
      expect(result[0].size).toBe(Buffer.byteLength(currentContent, 'utf8'));
      expect(result[0].originalSize).toBe(Buffer.byteLength(originalContent, 'utf8'));
    });

    it('falls back to HEAD diff and treats missing original content as new file', () => {
      const workingDir = makeWorkDir('file-changes-fallback');
      const current = 'export const x = {\n  value: 1\n};\n';
      writeFile(workingDir, 'new.ts', current);

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'diff' && args[2] === 'HEAD~1') {
          throw new Error('no previous commit');
        }
        if (cmd === 'git' && args[0] === 'diff' && args[2] === 'HEAD') {
          return 'new.ts\n';
        }
        if (cmd === 'git' && args[0] === 'show') {
          throw new Error('new file');
        }
        throw new Error(`Unexpected git call: ${args.join(' ')}`);
      });

      const result = mod.getFileChangesForValidation(workingDir, 1);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('new.ts');
      expect(result[0].originalContent).toBe('');
      expect(result[0].originalSize).toBe(result[0].size);
    });
  });

  describe('checkFileQuality', () => {
    it('passes a valid implementation file', () => {
      const workingDir = makeWorkDir('quality-good');
      const filePath = writeFile(workingDir, 'good.js', `
function sum(a, b) {
  const result = a + b;
  return result;
}

function multiply(a, b) {
  const result = a * b;
  return result;
}

module.exports = { sum, multiply };
`.trim());

      const result = mod.checkFileQuality(filePath);
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('flags tiny existing files as near-empty stubs', () => {
      const workingDir = makeWorkDir('quality-tiny');
      const filePath = writeFile(workingDir, 'tiny.js', 'const x = 1;\n');

      const result = mod.checkFileQuality(filePath);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('nearly empty'))).toBe(true);
      expect(result.issues.some(i => i.includes('lines of code'))).toBe(true);
    });

    it('skips size and line-count checks for new files', () => {
      const workingDir = makeWorkDir('quality-new-file');
      const filePath = writeFile(workingDir, 'new-util.js', 'const x = 1;\n');

      const result = mod.checkFileQuality(filePath, { isNewFile: true });
      expect(result.valid).toBe(true);
      expect(result.issues.some(i => i.includes('nearly empty'))).toBe(false);
      expect(result.issues.some(i => i.includes('lines of code'))).toBe(false);
    });

    it('detects placeholder and accidental diff content', () => {
      const workingDir = makeWorkDir('quality-placeholders');
      const filePath = writeFile(workingDir, 'bad.js', `
// TODO: implement parser
--- a/src/bad.js
+++ b/src/bad.js
@@ -1,2 +1,2 @@
-function run() {}
+function run(x) { return x; }
`.trim());

      const result = mod.checkFileQuality(filePath);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('placeholder/stub'))).toBe(true);
      expect(result.issues.some(i => i.includes('diff/patch'))).toBe(true);
    });

    it('detects exact placeholder marker files', () => {
      const workingDir = makeWorkDir('quality-exact-placeholder');
      const filePath = writeFile(workingDir, 'placeholder.js', '// Placeholder — to be generated by LLM\n');

      const result = mod.checkFileQuality(filePath, { isNewFile: true });

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('placeholder/stub'))).toBe(true);
    });
  });

  describe('checkDuplicateFiles', () => {
    it('flags untracked files that shadow an existing file name', () => {
      const workingDir = makeWorkDir('duplicate-shadow');
      writeFile(workingDir, 'src/Feature.js', 'module.exports = 1;\n');
      writeFile(workingDir, 'legacy/Feature.js', 'module.exports = 2;\n');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '--') {
          // git ls-files -- **/Feature.js returns both matches
          return 'src/Feature.js\nlegacy/Feature.js\n';
        }
        if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '--error-unmatch') {
          // File is untracked — throw to signal new file
          throw new Error('untracked');
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const result = mod.checkDuplicateFiles(workingDir, ['src/Feature.js']);

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toContain("New file 'Feature.js' may shadow existing");
    });

    it('does not flag duplicates when the file is already tracked', () => {
      const workingDir = makeWorkDir('duplicate-tracked');
      writeFile(workingDir, 'src/Feature.js', 'module.exports = 1;\n');
      writeFile(workingDir, 'legacy/Feature.js', 'module.exports = 2;\n');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '--') {
          return 'src/Feature.js\nlegacy/Feature.js\n';
        }
        if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '--error-unmatch') {
          // File IS tracked — return normally
          return 'src/Feature.js\n';
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const result = mod.checkDuplicateFiles(workingDir, ['src/Feature.js']);
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });
  });

  describe('checkSyntax', () => {
    it('reports C# and JavaScript syntax issues', () => {
      const workingDir = makeWorkDir('syntax-main');
      writeFile(workingDir, 'bad.cs', 'public void Run() {\n');
      const badJsPath = writeFile(workingDir, 'bad.js', 'const value = ;\n');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'node' && args[0] === '--check' && args[1] === badJsPath) {
          throw new Error('Unexpected token ;');
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const result = mod.checkSyntax(workingDir, ['bad.cs', 'bad.js']);

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('bad.cs: Mismatched braces'))).toBe(true);
      expect(result.issues.some(i => i.includes('bad.cs: Missing namespace/class/interface declaration'))).toBe(true);
      expect(result.issues.some(i => i.includes('bad.js: Syntax error'))).toBe(true);
    });

    it('falls back for missing TypeScript tool and skips Python when interpreter is unavailable', () => {
      const workingDir = makeWorkDir('syntax-fallback');
      writeFile(workingDir, 'bad.ts', 'export const fn = () => {\n');
      writeFile(workingDir, 'bad.py', 'def run(:\n    pass\n');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'npx' && args[0] === 'tsc') {
          const err = new Error('ENOENT: npx not found');
          err.status = 127;
          throw err;
        }
        if ((cmd === 'python' || cmd === 'python3') && args[0] === '-m') {
          const err = new Error('ENOENT: python not found');
          err.status = 127;
          throw err;
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const result = mod.checkSyntax(workingDir, ['bad.ts', 'bad.py']);

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('bad.ts: Mismatched braces'))).toBe(true);
      expect(result.issues.some(i => i.includes('bad.py'))).toBe(false);
    });
  });

  describe('runLLMSafeguards', () => {
    it('aggregates file-quality, duplicate, and syntax issues', () => {
      const workingDir = makeWorkDir('safeguards-fail');
      writeFile(workingDir, 'src/bad.js', '// TODO: implement parser\nconst x = ;\n');
      writeFile(workingDir, 'legacy/bad.js', 'module.exports = 1;\n');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'status') {
          return '?? src/bad.js\n';
        }
        if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '--') {
          // git ls-files -- **/bad.js returns both matches
          return 'src/bad.js\nlegacy/bad.js\n';
        }
        if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '--error-unmatch') {
          throw new Error('untracked');
        }
        if (cmd === 'node' && args[0] === '--check') {
          throw new Error('Unexpected token ;');
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const result = mod.runLLMSafeguards('task-safeguard-1', workingDir, ['src/bad.js']);

      expect(result.passed).toBe(false);
      expect(result.issues.some(i => i.includes('bad.js: File contains placeholder/stub content'))).toBe(true);
      expect(result.issues.some(i => i.includes("New file 'bad.js' may shadow existing"))).toBe(true);
      expect(result.issues.some(i => i.includes('bad.js: Syntax error'))).toBe(true);
      expect(result.details.fileQuality.checked).toBe(1);
      expect(result.details.duplicates.checked).toBe(true);
      expect(result.details.syntax.checked).toBe(1);
    });

    it('passes when modified files are valid and syntax checks succeed', () => {
      const workingDir = makeWorkDir('safeguards-pass');
      const goodJsPath = writeFile(workingDir, 'src/good.js', `
function add(a, b) {
  return a + b;
}

function sub(a, b) {
  return a - b;
}

module.exports = { add, sub };
`.trim());

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'status') {
          return ' M src/good.js\n';
        }
        if (cmd === 'find') {
          return `${goodJsPath}\n`;
        }
        if (cmd === 'node' && args[0] === '--check') {
          return '';
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const result = mod.runLLMSafeguards('task-safeguard-2', workingDir, ['src/good.js']);
      expect(result.passed).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('fails when a placeholder file remains even without validated file changes', () => {
      const workingDir = makeWorkDir('safeguards-placeholder-file');
      writeFile(workingDir, 'src/placeholder.js', '// Placeholder — to be generated by LLM\n');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'status') {
          return '?? src/placeholder.js\n';
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const result = mod.runLLMSafeguards('task-safeguard-3', workingDir, []);

      expect(result.passed).toBe(false);
      expect(result.issues.some(i => i.includes('src/placeholder.js'))).toBe(true);
      expect(result.issues.some(i => i.includes('placeholder marker'))).toBe(true);
      expect(result.details.placeholderArtifacts.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'src/placeholder.js' })
        ])
      );
    });

    it('fails when task output is only placeholder markers and no files were validated', () => {
      const workingDir = makeWorkDir('safeguards-placeholder-output');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'status') {
          return '';
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const result = mod.runLLMSafeguards('task-safeguard-4', workingDir, [], {
        outputText: '// Placeholder — to be generated by LLM\n',
        checkOutputMarkers: true,
      });

      expect(result.passed).toBe(false);
      expect(result.issues.some(i => i.includes('Task output still contains placeholder marker'))).toBe(true);
      expect(result.details.outputMarkers.markers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'placeholder marker' })
        ])
      );
    });
  });

  describe('runBuildVerification', () => {
    it('skips when build verification is disabled', async () => {
      const workingDir = makeWorkDir('build-disabled');
      const project = setProjectConfig(workingDir, { build_verification_enabled: false });
      const taskId = createTaskForDir(workingDir, project);

      const result = await mod.runBuildVerification(taskId, { project }, workingDir);

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('disabled');
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('runs build command and saves passed build result', async () => {
      const workingDir = makeWorkDir('build-pass');
      const project = setProjectConfig(workingDir, {
        build_verification_enabled: true,
        build_command: 'npm run build',
      });
      const taskId = createTaskForDir(workingDir, project);

      mockSpawnSync.mockReturnValue({ status: 0, stdout: 'build ok', stderr: '' });

      const result = await mod.runBuildVerification(taskId, { project }, workingDir);

      expect(result.success).toBe(true);
      expect(result.output).toContain('build ok');
      // Build command may be routed via remote test router or run locally
      expect(saveBuildResultSpy).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({ status: 'passed', command: 'npm run build', exitCode: 0 })
      );
    });

    it('returns failure and saves failed build result when command exits non-zero', async () => {
      const workingDir = makeWorkDir('build-fail');
      const project = setProjectConfig(workingDir, {
        build_verification_enabled: true,
        build_command: 'npm run build',
      });
      const taskId = createTaskForDir(workingDir, project);

      mockSpawnSync.mockReturnValue({ status: 2, stdout: 'partial', stderr: 'compile error' });

      const result = await mod.runBuildVerification(taskId, { project }, workingDir);

      expect(result.success).toBe(false);
      expect(result.output).toContain('partial');
      expect(result.error).toContain('compile error');
      expect(saveBuildResultSpy).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({ status: 'failed', command: 'npm run build' })
      );
    });
  });

  describe('runTestVerification', () => {
    it('skips when test verification is disabled', async () => {
      const workingDir = makeWorkDir('test-disabled');
      const project = setProjectConfig(workingDir, { test_verification_enabled: false });
      const taskId = createTaskForDir(workingDir, project);

      const result = await mod.runTestVerification(taskId, { project }, workingDir);

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('disabled');
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('returns failure when test command exits non-zero', async () => {
      const workingDir = makeWorkDir('test-fail');
      const project = setProjectConfig(workingDir, {
        test_verification_enabled: true,
        test_command: 'npm test',
      });
      const taskId = createTaskForDir(workingDir, project);

      mockSpawnSync.mockReturnValue({ status: 1, stdout: 'run 12 tests', stderr: '2 failed' });

      const result = await mod.runTestVerification(taskId, { project }, workingDir);

      expect(result.success).toBe(false);
      expect(result.output).toContain('run 12 tests');
      expect(result.error).toContain('2 failed');
    });
  });

  describe('runStyleCheck', () => {
    it('returns success with duration when style check passes', () => {
      const workingDir = makeWorkDir('style-pass');
      const project = setProjectConfig(workingDir, {
        style_check_enabled: true,
        style_check_command: 'npm run lint --silent',
      });
      const taskId = createTaskForDir(workingDir, project);

      mockSpawnSync.mockReturnValue({ status: 0, stdout: 'lint clean', stderr: '' });

      const result = mod.runStyleCheck(taskId, { project }, workingDir);

      expect(result.success).toBe(true);
      expect(result.output).toBe('lint clean');
      expect(typeof result.durationSeconds).toBe('number');
      expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
    });

    it('returns warnings when style check fails', () => {
      const workingDir = makeWorkDir('style-fail');
      const project = setProjectConfig(workingDir, {
        style_check_enabled: true,
        style_check_command: 'npm run lint --silent',
      });
      const taskId = createTaskForDir(workingDir, project);

      mockSpawnSync.mockReturnValue({ status: 1, stdout: 'lint output', stderr: 'lint error' });

      const result = mod.runStyleCheck(taskId, { project }, workingDir);

      expect(result.success).toBe(false);
      expect(result.warnings).toBe(true);
      expect(result.output).toBe('lint output');
      expect(result.error).toBe('lint error');
    });
  });

  describe('rollbackTaskChanges', () => {
    it('restores only recorded task files when git status is dirty', () => {
      const workingDir = makeWorkDir('rollback-dirty');
      const taskId = createTaskForDir(workingDir);
      writeFile(workingDir, 'src/a.js', 'console.log("a");\n');
      fileTracking.recordFileChange(taskId, path.join(workingDir, 'src/a.js'), 'modified', {
        workingDirectory: workingDir,
      });

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'status') {
          return ' M src/a.js\n';
        }
        if (cmd === 'git' && args[0] === 'ls-files') {
          return 'src/a.js\n';
        }
        if (cmd === 'git' && args[0] === 'checkout') {
          return '';
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const rolledBack = mod.rollbackTaskChanges(taskId, workingDir);

      expect(rolledBack).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['checkout', '--', 'src/a.js'],
        expect.objectContaining({ cwd: workingDir })
      );
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        ['clean', '-fd'],
        expect.anything()
      );
    });

    it('reverts last commit when clean repo has TORQUE-authored commit message', () => {
      const workingDir = makeWorkDir('rollback-torque');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'status') {
          return '';
        }
        if (cmd === 'git' && args[0] === 'log') {
          return 'fix: update flow [Torque local]\n';
        }
        if (cmd === 'git' && args[0] === 'revert') {
          return '';
        }
        if (cmd === 'git' && args[0] === 'commit') {
          return '';
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const rolledBack = mod.rollbackTaskChanges('task-rollback-2', workingDir);

      expect(rolledBack).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['revert', '--no-commit', 'HEAD'],
        expect.objectContaining({ cwd: workingDir })
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', 'Revert: Build verification failed for task task-rollback-2'],
        expect.objectContaining({ cwd: workingDir })
      );
    });
  });

  describe('scopedRollback', () => {
    it('skips untracked task files without deleting them', () => {
      const workingDir = makeWorkDir('scoped-rollback-untracked');
      const taskId = createTaskForDir(workingDir);
      writeFile(workingDir, 'src/new-file.js', 'module.exports = "keep";\n');
      fileTracking.recordFileChange(taskId, path.join(workingDir, 'src/new-file.js'), 'created', {
        workingDirectory: workingDir,
      });

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git' && args[0] === 'ls-files') {
          throw new Error('untracked');
        }
        throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
      });

      const result = mod.scopedRollback(taskId, workingDir);

      expect(result.reverted).toEqual([]);
      expect(result.skipped).toEqual(['src/new-file.js']);
      expect(fs.existsSync(path.join(workingDir, 'src/new-file.js'))).toBe(true);
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        ['checkout', '--', 'src/new-file.js'],
        expect.anything()
      );
    });
  });
});
