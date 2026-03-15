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
      unresolved: ['src/ghost.ts', 'ghost.ts'],
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
    expect(result.resolved[0]).toEqual({ mentioned: 'src/denied.ts', actual: path.join('src', 'denied.ts'), confidence: 'unique-basename' });
    expect(result.unresolved).toEqual([]);
    expect(existsSyncSpy).toHaveBeenCalled();
    expect(statSyncSpy).toHaveBeenCalled();
  });
});
