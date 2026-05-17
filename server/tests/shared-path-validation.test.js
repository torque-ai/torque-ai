/**
 * Workspace Path Validation Tests
 *
 * Unit tests for resolveAndValidateWorkspacePath in shared.js.
 * Verifies that the helper correctly gates filesystem access by
 * rejecting paths outside allowed workspace bases.
 */

const path = require('path');
const shared = require('../handlers/shared');

describe('resolveAndValidateWorkspacePath', () => {
  const { resolveAndValidateWorkspacePath } = shared;

  // Use platform-appropriate paths for test fixtures
  const isWin = process.platform === 'win32';
  const baseDir = isWin ? 'C:\\projects\\workspace' : '/projects/workspace';
  const baseDir2 = isWin ? 'C:\\other\\allowed' : '/other/allowed';

  it('returns valid: true for a path inside the allowed base', () => {
    const filePath = path.join(baseDir, 'src', 'index.js');
    const result = resolveAndValidateWorkspacePath(filePath, [baseDir]);

    expect(result.valid).toBe(true);
    expect(result.resolved).toBe(path.resolve(filePath));
  });

  it('returns valid: false for a path outside all allowed bases', () => {
    const outsidePath = isWin ? 'C:\\unauthorized\\secret.txt' : '/unauthorized/secret.txt';
    const result = resolveAndValidateWorkspacePath(outsidePath, [baseDir]);

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/resolves outside all allowed workspaces/);
  });

  it('returns valid: false when allowedBases is empty (fail-closed)', () => {
    const filePath = path.join(baseDir, 'file.txt');
    const result = resolveAndValidateWorkspacePath(filePath, []);

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/No allowed workspace bases provided/);
  });

  it('returns valid: false for .. traversal escaping the base', () => {
    // Construct a path that uses .. to escape the workspace
    const traversalPath = path.join(baseDir, 'src', '..', '..', '..', 'etc', 'passwd');
    const result = resolveAndValidateWorkspacePath(traversalPath, [baseDir]);

    expect(result.valid).toBe(false);
  });

  it('handles multiple allowed bases correctly (path in second base passes)', () => {
    const filePath = path.join(baseDir2, 'data', 'config.json');
    const result = resolveAndValidateWorkspacePath(filePath, [baseDir, baseDir2]);

    expect(result.valid).toBe(true);
    expect(result.resolved).toBe(path.resolve(filePath));
  });

  it('normalizes Windows-style paths correctly (backslash handling)', () => {
    // Even on non-Windows, path.resolve normalizes separators, but on Windows
    // the function must handle mixed separators gracefully
    const mixedPath = isWin
      ? 'C:\\projects\\workspace/src\\utils/helper.js'
      : '/projects/workspace/src/utils/helper.js';

    const result = resolveAndValidateWorkspacePath(mixedPath, [baseDir]);

    expect(result.valid).toBe(true);
    expect(result.resolved).toBe(path.resolve(mixedPath));
  });
});
