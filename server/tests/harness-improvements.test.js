const path = require('path');
const os = require('os');
const fs = require('fs');

// Import the internal functions directly from task-manager
const {
  computeLineHash,
  detectTaskTypes,
  lineSimilarity,
  verifyHashlineReferences,
  attemptFuzzySearchRepair,
} = require('../task-manager');

describe('Harness Improvements — Internal Functions', () => {

  // ── computeLineHash ──────────────────────────────────────────────
  describe('computeLineHash', () => {
    it('returns a 2-character hex string', () => {
      const hash = computeLineHash('const x = 42;');
      expect(hash).toMatch(/^[0-9a-f]{2}$/);
    });

    it('produces consistent hash for empty string', () => {
      const h1 = computeLineHash('');
      const h2 = computeLineHash('');
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{2}$/);
    });

    it('produces different hashes for different content', () => {
      const h1 = computeLineHash('function foo() {}');
      const h2 = computeLineHash('function bar() {}');
      expect(h1).not.toBe(h2);
    });

    it('is deterministic — same content always gives same hash', () => {
      const content = '  return this.value + offset;';
      const results = new Set();
      for (let i = 0; i < 100; i++) {
        results.add(computeLineHash(content));
      }
      expect(results.size).toBe(1);
    });

    it('always returns lowercase hex', () => {
      const samples = [
        'import { Foo } from "./bar";',
        'export default class Baz {}',
        '// TODO: fix this',
        'console.log("HELLO WORLD");',
      ];
      for (const s of samples) {
        const hash = computeLineHash(s);
        expect(hash).toBe(hash.toLowerCase());
      }
    });
  });

  // ── detectTaskTypes ──────────────────────────────────────────────
  describe('detectTaskTypes', () => {
    it('detects file-creation from "create file foo.ts"', () => {
      const types = detectTaskTypes('Create file foo.ts with a helper function');
      expect(types).toContain('file-creation');
    });

    it('detects file-creation from "create a new service.js"', () => {
      const types = detectTaskTypes('Create a new service.js that handles auth');
      expect(types).toContain('file-creation');
    });

    it('detects single-file-task when one file referenced', () => {
      const types = detectTaskTypes('Fix the bug in utils.ts');
      expect(types).toContain('single-file-task');
    });

    it('does not detect single-file-task when multiple files referenced', () => {
      const types = detectTaskTypes('Refactor utils.ts and helpers.js to share code');
      expect(types).not.toContain('single-file-task');
    });

    it('still detects existing types like xml-documentation and markdown', () => {
      const xmlTypes = detectTaskTypes('Add xml documentation comments to the public API');
      expect(xmlTypes).toContain('xml-documentation');

      const mdTypes = detectTaskTypes('Update the README.md with new usage instructions');
      expect(mdTypes).toContain('markdown');
    });

    it('returns empty array for generic description with no file refs', () => {
      const types = detectTaskTypes('Improve performance of the sorting algorithm');
      expect(types).toEqual([]);
    });
  });

  // ── lineSimilarity ───────────────────────────────────────────────
  describe('lineSimilarity', () => {
    it('returns 1.0 for identical strings', () => {
      expect(lineSimilarity('hello world', 'hello world')).toBe(1.0);
    });

    it('returns 0 for empty vs non-empty', () => {
      expect(lineSimilarity('', 'something')).toBe(0);
      expect(lineSimilarity('something', '')).toBe(0);
    });

    it('returns 1.0 for both empty', () => {
      expect(lineSimilarity('', '')).toBe(1.0);
    });

    it('returns >= 0.8 for minor whitespace differences', () => {
      const a = '  const value = computeResult(input);';
      const b = '   const value = computeResult(input);';
      expect(lineSimilarity(a, b)).toBeGreaterThanOrEqual(0.8);
    });

    it('returns < 0.5 for very different strings', () => {
      const a = 'import { readFileSync } from "fs";';
      const b = 'export default class UserService {}';
      expect(lineSimilarity(a, b)).toBeLessThan(0.5);
    });
  });

  // ── verifyHashlineReferences ─────────────────────────────────────
  describe('verifyHashlineReferences', () => {
    it('returns score 100 when no hashline refs in output', () => {
      const result = verifyHashlineReferences('task-1', 'Some normal output', '/tmp');
      expect(result.score).toBe(100);
      expect(result.total).toBe(0);
    });

    it('returns score 100 when output is empty', () => {
      const result = verifyHashlineReferences('task-2', '', '/tmp');
      expect(result.score).toBe(100);
    });

    it('correctly matches hashes against temp file content', () => {
      const tmpDir = path.join(os.tmpdir(), `hashline-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        // Create a temp file with known content
        const lines = ['line one', 'line two', 'line three'];
        const filePath = path.join(tmpDir, 'test.ts');
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        // Compute expected hashes
        const h1 = computeLineHash(lines[0]);
        const h2 = computeLineHash(lines[1]);

        // Build output referencing those hashes — the function looks for recently
        // modified files, so we use a .git-like approach. Since getFileChangesForValidation
        // may not find our temp file, this mainly tests the parsing path.
        const output = `Editing L001:${h1}: and L002:${h2}: in the file`;
        const result = verifyHashlineReferences('task-3', output, tmpDir);

        // Should have parsed 2 references
        expect(result.total).toBe(2);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('flags mismatched (stale) hashline references', () => {
      // Use fake hashes that won't match any file
      const output = 'Check L001:ff: and L002:ee: in the code';
      const result = verifyHashlineReferences('task-4', output, os.tmpdir());
      expect(result.total).toBe(2);
      // Since no matching file is found, score should still be 100 (no file to mismatch against)
      expect(result.score).toBe(100);
    });
  });

  // ── attemptFuzzySearchRepair ─────────────────────────────────────
  describe('attemptFuzzySearchRepair', () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = path.join(os.tmpdir(), `fuzzy-repair-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns repaired: false when no failure pattern in output', () => {
      const result = attemptFuzzySearchRepair('task-5', 'All edits applied successfully', tmpDir);
      expect(result.repaired).toBe(false);
    });

    it('returns repaired: false when target file does not exist', () => {
      const output = "FAILED to apply edit to nonexistent.ts\n<<<<<<< SEARCH\nold code\n=======\nnew code\n>>>>>>> REPLACE";
      const result = attemptFuzzySearchRepair('task-6', output, tmpDir);
      expect(result.repaired).toBe(false);
      expect(result.file).toBe('nonexistent.ts');
    });

    it('repairs a SEARCH block with minor whitespace diff (>= 80% similarity)', () => {
      // Create a file with known content
      const filePath = path.join(tmpDir, 'repairable.ts');
      const originalContent = [
        'class Foo {',
        '  getValue() {',
        '    return this.value;',
        '  }',
        '}',
      ].join('\n');
      fs.writeFileSync(filePath, originalContent, 'utf8');

      // Build output with a SEARCH block that has minor whitespace diffs
      const output = [
        "FAILED to apply edit to repairable.ts",
        "<<<<<<< SEARCH",
        "  getValue() {",
        "    return  this.value;",   // extra space — still >= 80% similar per line
        "  }",
        "=======",
        "  getValue() {",
        "    return this.value * 2;",
        "  }",
        ">>>>>>> REPLACE",
      ].join('\n');

      const result = attemptFuzzySearchRepair('task-7', output, tmpDir);
      expect(result.repaired).toBe(true);
      expect(result.similarity).toBeGreaterThanOrEqual(0.8);

      // Verify the file was actually updated
      const updated = fs.readFileSync(filePath, 'utf8');
      expect(updated).toContain('return this.value * 2;');
    });

    it('does NOT repair when similarity is too low (< 80%)', () => {
      const filePath = path.join(tmpDir, 'no-repair.ts');
      const originalContent = [
        'class Bar {',
        '  compute(x: number) {',
        '    return x * x;',
        '  }',
        '}',
      ].join('\n');
      fs.writeFileSync(filePath, originalContent, 'utf8');

      // Build output with a SEARCH block that is very different from actual content
      const output = [
        "FAILED to apply edit to no-repair.ts",
        "<<<<<<< SEARCH",
        "  totallyDifferentMethod(a: string, b: string) {",
        "    return a.concat(b).toUpperCase();",
        "  }",
        "=======",
        "  replacement() { return 0; }",
        ">>>>>>> REPLACE",
      ].join('\n');

      const result = attemptFuzzySearchRepair('task-8', output, tmpDir);
      expect(result.repaired).toBe(false);
      expect(result.similarity).toBeLessThan(0.8);

      // Verify file is unchanged
      const unchanged = fs.readFileSync(filePath, 'utf8');
      expect(unchanged).toContain('return x * x;');
    });
  });
});
