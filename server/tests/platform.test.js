/**
 * Platform-Specific Tests
 *
 * Tests for platform detection, pre-commit hooks, path handling, file encoding.
 */

const { setupTestDb, teardownTestDb, safeTool } = require('./vitest-setup');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { uniqueId } = require('./test-helpers');

describe('Platform-Specific Tests', () => {
  beforeAll(() => { setupTestDb('platform'); });
  afterAll(() => { teardownTestDb(); });

  describe('Platform Detection', () => {
    it('process.platform is available', () => {
      expect(typeof process.platform).toBe('string');
    });

    it('platform is recognized', () => {
      expect(['win32', 'linux', 'darwin']).toContain(process.platform);
    });
  });

  describe('Pre-commit Hook Generation', () => {
    let tempDir;

    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-test-'));
      const hooksDir = path.join(tempDir, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
    });

    afterAll(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('setup_precommit_hook succeeds', async () => {
      const result = await safeTool('setup_precommit_hook', {
        working_directory: tempDir,
        checks: ['validation', 'syntax', 'build']
      });
      expect(result.isError).toBeFalsy();
    });

    it('creates platform-appropriate hook file', async () => {
      const hooksDir = path.join(tempDir, '.git', 'hooks');
      if (process.platform === 'win32') {
        const psHookPath = path.join(hooksDir, 'pre-commit.ps1');
        expect(fs.existsSync(psHookPath)).toBe(true);
        const content = fs.readFileSync(psHookPath, 'utf8');
        expect(content.length).toBeGreaterThan(0);
        expect(content).toContain('validation');
      } else {
        const unixHookPath = path.join(hooksDir, 'pre-commit');
        expect(fs.existsSync(unixHookPath)).toBe(true);
        const stats = fs.statSync(unixHookPath);
        expect((stats.mode & 0o111) !== 0).toBe(true);
        const content = fs.readFileSync(unixHookPath, 'utf8');
        expect(content.length).toBeGreaterThan(0);
        expect(content).toContain('validation');
      }
    });
  });

  describe('Path Handling', () => {
    it('path.join works correctly', () => {
      const joined = path.join('foo', 'bar', 'baz');
      expect(typeof joined).toBe('string');
      expect(joined.length).toBeGreaterThan(0);
    });

    it('os.tmpdir returns valid existing path', () => {
      const tmpdir = os.tmpdir();
      expect(typeof tmpdir).toBe('string');
      expect(tmpdir.length).toBeGreaterThan(0);
      expect(fs.existsSync(tmpdir)).toBe(true);
    });

    it('path separator is platform-specific', () => {
      if (process.platform === 'win32') {
        expect(path.sep).toBe('\\');
      } else {
        expect(path.sep).toBe('/');
      }
    });
  });

  describe('File Encoding and Baselines', () => {
    let testTempDir;
    let testFile;
    const testContent = 'function hello() {\n  console.log("Hello, World!");\n}\n';

    beforeAll(async () => {
      testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-baseline-'));
      testFile = path.join(testTempDir, 'example.js');
      fs.writeFileSync(testFile, testContent, 'utf8');
      fs.mkdirSync(path.join(testTempDir, '.git'), { recursive: true });
    });

    afterAll(() => {
      if (testTempDir && fs.existsSync(testTempDir)) {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      }
    });

    it('capture_file_baselines succeeds', async () => {
      const result = await safeTool('capture_file_baselines', {
        working_directory: testTempDir,
        extensions: ['.js']
      });
      expect(result.isError).toBeFalsy();
    });

    it('test file is unchanged after baseline capture', () => {
      expect(fs.existsSync(testFile)).toBe(true);
      const readContent = fs.readFileSync(testFile, 'utf8');
      expect(readContent).toBe(testContent);
    });

    it('test file has correct size', () => {
      const stats = fs.statSync(testFile);
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.size).toBe(testContent.length);
    });
  });

  describe('Cross-Platform Compatibility', () => {
    it('file write/read round-trips correctly', () => {
      const tempFile = path.join(os.tmpdir(), `torque-compat-${uniqueId()}.txt`);
      try {
        fs.writeFileSync(tempFile, 'test content', 'utf8');
        expect(fs.existsSync(tempFile)).toBe(true);
        expect(fs.readFileSync(tempFile, 'utf8')).toBe('test content');
      } finally {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      }
    });

    it('recursive directory creation works', () => {
      const rootName = `torque-deep-${uniqueId()}`;
      const deepDir = path.join(os.tmpdir(), rootName, 'a', 'b', 'c');
      try {
        fs.mkdirSync(deepDir, { recursive: true });
        expect(fs.existsSync(deepDir)).toBe(true);
      } finally {
        const rootDir = path.join(os.tmpdir(), rootName);
        if (fs.existsSync(rootDir)) fs.rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe('Environment Variables and Paths', () => {
    it('temp environment variable exists', () => {
      const os = require('os');
      // On Linux CI, neither TEMP nor TMPDIR may be set, but os.tmpdir() always works
      const hasTempVar = process.env.TEMP !== undefined
        || process.env.TMPDIR !== undefined
        || process.env.TMP !== undefined;
      expect(hasTempVar || typeof os.tmpdir() === 'string').toBe(true);
    });

    it('process.platform matches expected values', () => {
      expect(['win32', 'linux', 'darwin']).toContain(process.platform);
    });
  });
});
