'use strict';

/**
 * Unit Tests: validation/hashline-verify.js
 *
 * Tests hashline reference verification and fuzzy SEARCH/REPLACE repair
 * with mocked dependency injection for computeLineHash, getFileChangesForValidation,
 * and lineSimilarity.
 */

const fs = require('fs');
const _path = require('path');

describe('Hashline Verify', () => {
  let hashlineVerify;
  let mockComputeLineHash;
  let mockGetFileChanges;
  let mockLineSimilarity;

  beforeEach(() => {
    require.resolve('../validation/hashline-verify');

    hashlineVerify = require('../validation/hashline-verify');

    // Default mock: compute a short 2-char hex hash from first 2 chars of content
    mockComputeLineHash = vi.fn((line) => {
      if (!line) return '00';
      const code = (line.charCodeAt(0) * 31 + (line.charCodeAt(1) || 0)) & 0xff;
      return code.toString(16).padStart(2, '0');
    });

    mockGetFileChanges = vi.fn().mockReturnValue([]);
    mockLineSimilarity = vi.fn().mockReturnValue(1.0);

    hashlineVerify.init({
      computeLineHash: mockComputeLineHash,
      getFileChangesForValidation: mockGetFileChanges,
      lineSimilarity: mockLineSimilarity,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── verifyHashlineReferences ──────────────────────────────

  describe('verifyHashlineReferences', () => {
    it('returns defaults when output is null', () => {
      const result = hashlineVerify.verifyHashlineReferences('task-1', null, '/project');
      expect(result).toEqual({ total: 0, matched: 0, mismatched: 0, score: 100 });
    });

    it('returns defaults when output is empty string', () => {
      const result = hashlineVerify.verifyHashlineReferences('task-1', '', '/project');
      expect(result).toEqual({ total: 0, matched: 0, mismatched: 0, score: 100 });
    });

    it('returns defaults when workingDirectory is null', () => {
      const result = hashlineVerify.verifyHashlineReferences('task-1', 'some output', null);
      expect(result).toEqual({ total: 0, matched: 0, mismatched: 0, score: 100 });
    });

    it('returns defaults when no L###:xx patterns found in output', () => {
      const result = hashlineVerify.verifyHashlineReferences('task-1', 'normal output text', '/project');
      expect(result).toEqual({ total: 0, matched: 0, mismatched: 0, score: 100 });
    });

    it('returns score 100 when all hashline references match', () => {
      const fileContent = 'line one\nline two\nline three\n';
      const lines = fileContent.split('\n');

      // Compute actual hashes using our mock
      const hash1 = mockComputeLineHash(lines[0]);
      const hash2 = mockComputeLineHash(lines[1]);

      const output = `Edit L001:${hash1}: change something\nEdit L002:${hash2}: another change`;

      mockGetFileChanges.mockReturnValue([{ path: 'src/app.ts' }]);

      vi.spyOn(fs, 'readFileSync').mockReturnValue(fileContent);

      const result = hashlineVerify.verifyHashlineReferences('task-1', output, '/project');
      expect(result.score).toBe(100);
      expect(result.matched).toBe(2);
      expect(result.mismatched).toBe(0);
      expect(result.total).toBe(2);
    });

    it('returns lower score when some hashline references mismatch', () => {
      const fileContent = 'line one\nline two\nline three\n';
      const lines = fileContent.split('\n');
      const hash1 = mockComputeLineHash(lines[0]);

      // hash1 matches line 1, but 'ff' won't match line 2
      const output = `Edit L001:${hash1}: ok\nEdit L002:ff: stale ref`;

      mockGetFileChanges.mockReturnValue([{ path: 'src/app.ts' }]);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(fileContent);

      const result = hashlineVerify.verifyHashlineReferences('task-1', output, '/project');
      expect(result.total).toBe(2);
      expect(result.matched).toBe(1);
      expect(result.mismatched).toBe(1);
      expect(result.score).toBe(50);
    });

    it('handles missing files gracefully by skipping them', () => {
      const output = 'Edit L001:ab: something';

      mockGetFileChanges.mockReturnValue([{ path: 'src/missing.ts' }]);
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = hashlineVerify.verifyHashlineReferences('task-1', output, '/project');
      // No fileLines resolved, returns score 100 with total = count of refs
      expect(result.total).toBe(1);
      expect(result.score).toBe(100);
    });

    it('returns score 100 when no file matches the first reference hash', () => {
      const output = 'Edit L001:99: something';

      mockGetFileChanges.mockReturnValue([{ path: 'src/app.ts' }]);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('different content\n');

      const result = hashlineVerify.verifyHashlineReferences('task-1', output, '/project');
      // fileLines never set since first ref hash doesn't match
      expect(result.total).toBe(1);
      expect(result.score).toBe(100);
    });

    it('counts references beyond file length as mismatched', () => {
      // File has only 2 lines, but ref points to line 5
      const fileContent = 'line one\nline two';
      const lines = fileContent.split('\n');
      const hash1 = mockComputeLineHash(lines[0]);

      const output = `Edit L001:${hash1}: ok\nEdit L005:ab: out of bounds`;

      mockGetFileChanges.mockReturnValue([{ path: 'src/app.ts' }]);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(fileContent);

      const result = hashlineVerify.verifyHashlineReferences('task-1', output, '/project');
      expect(result.total).toBe(2);
      expect(result.matched).toBe(1);
      expect(result.mismatched).toBe(1);
      expect(result.score).toBe(50);
    });
  });

  // ── attemptFuzzySearchRepair ──────────────────────────────

  describe('attemptFuzzySearchRepair', () => {
    it('returns repaired:false when output is null', () => {
      const result = hashlineVerify.attemptFuzzySearchRepair('task-1', null, '/project');
      expect(result).toEqual({ repaired: false, file: null, similarity: 0 });
    });

    it('returns repaired:false when output is empty', () => {
      const result = hashlineVerify.attemptFuzzySearchRepair('task-1', '', '/project');
      expect(result).toEqual({ repaired: false, file: null, similarity: 0 });
    });

    it('returns repaired:false when workingDirectory is null', () => {
      const result = hashlineVerify.attemptFuzzySearchRepair('task-1', 'some output', null);
      expect(result).toEqual({ repaired: false, file: null, similarity: 0 });
    });

    it('returns repaired:false when no failure pattern is found', () => {
      const output = 'Everything completed successfully, no errors';
      const result = hashlineVerify.attemptFuzzySearchRepair('task-1', output, '/project');
      expect(result).toEqual({ repaired: false, file: null, similarity: 0 });
    });

    it('repairs at >= 80% similarity and writes file', () => {
      const output = `FAILED to apply edit to src/app.ts
<<<<<<< SEARCH
const old = true;
=======
const fixed = true;
>>>>>>> REPLACE`;

      const existingContent = 'const oldd = true;\nconst other = false;\n';

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(existingContent);
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      // 85% similarity — above the 80% threshold
      mockLineSimilarity.mockReturnValue(0.85);

      const result = hashlineVerify.attemptFuzzySearchRepair('task-1', output, '/project');
      expect(result.repaired).toBe(true);
      expect(result.file).toBe('src/app.ts');
      expect(result.similarity).toBe(0.85);
      expect(writeSpy).toHaveBeenCalledTimes(1);

      // Verify the written content has the replacement
      const writtenContent = writeSpy.mock.calls[0][1];
      expect(writtenContent).toContain('const fixed = true;');
    });

    it('rejects repair at < 80% similarity', () => {
      const output = `Can't edit src/app.ts
<<<<<<< SEARCH
const old = true;
=======
const fixed = true;
>>>>>>> REPLACE`;

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('completely different content\n');

      // 50% similarity — below threshold
      mockLineSimilarity.mockReturnValue(0.5);

      const result = hashlineVerify.attemptFuzzySearchRepair('task-1', output, '/project');
      expect(result.repaired).toBe(false);
      expect(result.file).toBe('src/app.ts');
      expect(result.similarity).toBe(0.5);
    });

    it('returns repaired:false when target file does not exist', () => {
      const output = `FAILED to apply edit to src/missing.ts
<<<<<<< SEARCH
const old = true;
=======
const fixed = true;
>>>>>>> REPLACE`;

      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const result = hashlineVerify.attemptFuzzySearchRepair('task-1', output, '/project');
      expect(result.repaired).toBe(false);
      expect(result.file).toBe('src/missing.ts');
      expect(result.similarity).toBe(0);
    });

    it('returns repaired:false when file read throws', () => {
      const output = `FAILED to apply edit to src/locked.ts
<<<<<<< SEARCH
const old = true;
=======
const fixed = true;
>>>>>>> REPLACE`;

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = hashlineVerify.attemptFuzzySearchRepair('task-1', output, '/project');
      expect(result.repaired).toBe(false);
      expect(result.file).toBe('src/locked.ts');
      expect(result.similarity).toBe(0);
    });

    it('returns repaired:false when no SEARCH/REPLACE blocks found', () => {
      const output = `FAILED to apply edit to src/app.ts
No search blocks here, just an error message.`;

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('some content\n');

      const result = hashlineVerify.attemptFuzzySearchRepair('task-1', output, '/project');
      expect(result.repaired).toBe(false);
      expect(result.file).toBe('src/app.ts');
      expect(result.similarity).toBe(0);
    });

    it('returns repaired:false when writeFileSync fails', () => {
      const output = `FAILED to apply edit to src/app.ts
<<<<<<< SEARCH
const old = true;
=======
const fixed = true;
>>>>>>> REPLACE`;

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('const old = true;\n');
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('ENOSPC: no space left');
      });

      mockLineSimilarity.mockReturnValue(0.95);

      const result = hashlineVerify.attemptFuzzySearchRepair('task-1', output, '/project');
      expect(result.repaired).toBe(false);
      expect(result.file).toBe('src/app.ts');
      expect(result.similarity).toBe(0.95);
    });
  });
});
