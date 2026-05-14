const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildFileIndex,
  resolveFileReferences,
  _getFileIndexCache,
  _clearFileIndexCache,
} = require('../utils/file-resolution');

function createTempDir() {
  const tempDir = path.join(os.tmpdir(), `torque-file-resolution-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

describe('file-resolution defensive behavior', () => {
  const testDirs = [];

  afterEach(() => {
    _clearFileIndexCache();
    for (const dir of testDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    testDirs.length = 0;
    vi.restoreAllMocks();
  });

  it('rebuilds cache when existing cache entry is corrupted', () => {
    const workDir = createTempDir();
    testDirs.push(workDir);

    const srcDir = path.join(workDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'brokenfile.ts'), 'console.log("a")', 'utf8');

    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const initial = buildFileIndex(workDir);
    expect(initial.get('brokenfile.ts')).toEqual([path.join('src', 'brokenfile.ts')]);
    expect(readdirSpy).toHaveBeenCalled();

    const previousCalls = readdirSpy.mock.calls.length;
    _getFileIndexCache().set(workDir, { index: null, timestamp: 'invalid' });

    const rebuilt = buildFileIndex(workDir);
    expect(rebuilt.get('brokenfile.ts')).toEqual([path.join('src', 'brokenfile.ts')]);
    expect(readdirSpy.mock.calls.length).toBeGreaterThan(previousCalls);
  });

  it('gracefully handles missing directories by returning no index and unresolved refs', () => {
    const missingDir = path.join(os.tmpdir(), `torque-file-resolution-missing-${Date.now()}`);
    const index = buildFileIndex(missingDir);

    expect(index).toBeInstanceOf(Map);
    expect(index.size).toBe(0);

    const result = resolveFileReferences('update src/ghost.ts', missingDir);
    expect(result).toEqual({
      resolved: [],
      unresolved: ['src/ghost.ts'],
    });
  });

  it('continues when fs.existsSync throws permission denied', () => {
    const workDir = createTempDir();
    testDirs.push(workDir);

    const filePath = path.join(workDir, 'locked.ts');
    fs.writeFileSync(filePath, 'console.log("locked")', 'utf8');
    buildFileIndex(workDir);

    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation(() => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    });

    const result = resolveFileReferences('update locked.ts', workDir);
    expect(result).toEqual({
      resolved: [{ mentioned: 'locked.ts', actual: 'locked.ts', confidence: 'unique-basename' }],
      unresolved: [],
    });
    expect(existsSyncSpy).toHaveBeenCalled();

    // Restore spy before afterEach cleanup runs (cleanup uses fs.existsSync)
    existsSyncSpy.mockRestore();
  });

  it('continues when fs.statSync throws permission denied', () => {
    const workDir = createTempDir();
    testDirs.push(workDir);

    const filePath = path.join(workDir, 'src', 'denied.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'console.log("denied")', 'utf8');
    buildFileIndex(workDir);

    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const statSyncSpy = vi.spyOn(fs, 'statSync').mockImplementation(() => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    });

    const result = resolveFileReferences('update src/denied.ts', workDir);
    expect(result.resolved[0]).toEqual({ mentioned: 'src/denied.ts', actual: path.join('src', 'denied.ts'), confidence: 'path-suffix' });
    expect(result.unresolved).toEqual([]);
    expect(existsSyncSpy).toHaveBeenCalled();
    expect(statSyncSpy).toHaveBeenCalled();
  });

  it('does not resolve a directory-qualified reference through an unrelated unique basename', () => {
    const workDir = createTempDir();
    testDirs.push(workDir);

    const pluginFile = path.join(workDir, 'server', 'plugins', 'snapscope', 'handlers', 'verify.js');
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(pluginFile, 'module.exports = {};', 'utf8');

    const result = resolveFileReferences('Review server/factory/stages/verify.js for the verify stage.', workDir);

    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual(['server/factory/stages/verify.js']);
  });

  it('keeps strong suffix matches for directory-qualified references', () => {
    const workDir = createTempDir();
    testDirs.push(workDir);

    const stageFile = path.join(workDir, 'server', 'factory', 'stages', 'verify.js');
    fs.mkdirSync(path.dirname(stageFile), { recursive: true });
    fs.writeFileSync(stageFile, 'module.exports = {};', 'utf8');

    const result = resolveFileReferences('Update factory/stages/verify.js for the factory verify stage.', workDir);

    expect(result).toEqual({
      resolved: [{ mentioned: 'factory/stages/verify.js', actual: path.join('server', 'factory', 'stages', 'verify.js'), confidence: 'path-suffix' }],
      unresolved: [],
    });

    const windowsStyle = resolveFileReferences('Update factory\\stages\\verify.js for the factory verify stage.', workDir);
    expect(windowsStyle).toEqual({
      resolved: [{ mentioned: 'factory\\stages\\verify.js', actual: path.join('server', 'factory', 'stages', 'verify.js'), confidence: 'path-suffix' }],
      unresolved: [],
    });
  });

  it('suppresses known placeholder references when they do not exist', () => {
    const workDir = createTempDir();
    testDirs.push(workDir);

    const result = resolveFileReferences(
      'Examples only: path/to/spec.js, tests/test_foo.py, Node.js, MyApp.Tests.csproj, and bitsy/agent/session.py.',
      workDir
    );

    expect(result).toEqual({ resolved: [], unresolved: [] });
  });
});
