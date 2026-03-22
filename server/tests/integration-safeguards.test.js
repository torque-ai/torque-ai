/**
 * Integration Test: Safeguard Cascades
 *
 * Tests that quality safeguards compose correctly on the same output:
 * - checkFileQuality detects stubs, empty files, placeholder content
 * - checkSyntax detects basic syntax issues
 * - captureFileBaseline / compareFileToBaseline detects regressions
 * - Multiple safeguards can fire on the same file
 * - Valid output passes all checks
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: _uuidv4 } = require('uuid');

let testDir;
let origDataDir;
let db;
let tm;
let fileTracking;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-safeguards-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);

  fileTracking = require('../db/file-tracking');
  fileTracking.setDb(db.getDb ? db.getDb() : db.getDbInstance());

  tm = require('../task-manager');
  return { db, tm };
}

function teardownDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (origDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = origDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  }
}

/** Write a test file to the shared testDir */
function writeTestFile(filename, content) {
  const filePath = path.join(testDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('Integration: Safeguard Cascades', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  // ── File Quality: Empty Files ───────────────────────────

  describe('Empty file detection', () => {
    it('nearly empty file triggers quality issue', () => {
      const filePath = writeTestFile('empty.js', '// just a comment\n');
      const result = tm.checkFileQuality(filePath);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => /empty|chars/i.test(i))).toBe(true);
    });

    it('completely empty file triggers quality issue', () => {
      const filePath = writeTestFile('blank.js', '');
      const result = tm.checkFileQuality(filePath);
      // Empty files have 0 chars (< 50)
      expect(result.valid).toBe(false);
    });
  });

  // ── File Quality: Stub Detection ────────────────────────

  describe('Stub/placeholder detection', () => {
    it('file with TODO: implement triggers stub detection', () => {
      const filePath = writeTestFile('stub-todo.js', `
function doSomething() {
  // TODO: implement this function
  return null;
}
`);
      const result = tm.checkFileQuality(filePath);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => /placeholder|stub/i.test(i))).toBe(true);
    });

    it('file with throw NotImplementedException triggers stub detection', () => {
      const filePath = writeTestFile('stub-notimpl.cs', `
namespace Test {
  class Foo {
    public void Bar() {
      throw new NotImplementedException();
    }
  }
}
`);
      const result = tm.checkFileQuality(filePath);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => /placeholder|stub/i.test(i))).toBe(true);
    });

    it('file with mass stub comments triggers P95 detection', () => {
      const filePath = writeTestFile('mass-stub.js', `
function method1() {
  // ... rest of implementation unchanged
}
function method2() {
  // ... remaining code remains unchanged
}
function method3() {
  // ... same as before
}
`);
      const result = tm.checkFileQuality(filePath);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => /stub comments|P95/i.test(i))).toBe(true);
    });

    it('file with empty arrow function triggers stub detection', () => {
      const filePath = writeTestFile('empty-arrow.js', `
const handler = () => {};
const onClick = () => {};
export default handler;
`);
      const result = tm.checkFileQuality(filePath);
      expect(result.valid).toBe(false);
    });
  });

  // ── File Quality: Diff Content Detection ────────────────

  describe('Diff content detection', () => {
    it('file containing diff markers triggers diff detection', () => {
      const filePath = writeTestFile('accidental-diff.js', `
--- a/src/foo.js
+++ b/src/foo.js
@@ -1,5 +1,5 @@
 function foo() {
-  return 1;
+  return 2;
 }
`);
      const result = tm.checkFileQuality(filePath);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => /diff|patch/i.test(i))).toBe(true);
    });
  });

  // ── File Quality: Valid Output ──────────────────────────

  describe('Valid output passes all checks', () => {
    it('well-formed JS file passes quality check', () => {
      const filePath = writeTestFile('good-file.js', `
const express = require('express');
const router = express.Router();

router.get('/api/data', (req, res) => {
  const data = fetchData(req.query);
  res.json({ success: true, data });
});

function fetchData(query) {
  return { items: [], total: 0, page: query.page || 1 };
}

module.exports = router;
`);
      const result = tm.checkFileQuality(filePath);
      expect(result.valid).toBe(true);
      expect(result.issues.length).toBe(0);
    });

    it('non-existent file returns valid (not our problem)', () => {
      const result = tm.checkFileQuality(path.join(testDir, 'does-not-exist.js'));
      expect(result.valid).toBe(true);
    });
  });

  // ── Baseline Comparison ─────────────────────────────────

  describe('Baseline capture and comparison', () => {
    it('capture baseline records file stats', () => {
      const content = 'function hello() { return "world"; }\n'.repeat(50);
      writeTestFile('baseline-test.js', content);

      const result = fileTracking.captureFileBaseline('baseline-test.js', testDir);
      expect(result).toBeTruthy();
      expect(result.lines).toBeGreaterThan(0);
      expect(result.checksum).toBeTruthy();
    });

    it('compare detects no change when file unchanged', () => {
      const comparison = fileTracking.compareFileToBaseline('baseline-test.js', testDir);
      expect(comparison.hasBaseline).toBe(true);
      expect(comparison.sizeDelta).toBe(0);
      expect(comparison.isTruncated).toBe(false);
    });

    it('compare detects truncation when file shrinks >50%', () => {
      // Original was 50 lines, now shrink to 5 lines
      writeTestFile('baseline-test.js', 'function hello() { return "world"; }\n'.repeat(5));

      const comparison = fileTracking.compareFileToBaseline('baseline-test.js', testDir);
      expect(comparison.hasBaseline).toBe(true);
      expect(comparison.sizeChangePercent).toBeLessThan(-50);
      expect(comparison.isTruncated).toBe(true);
    });

    it('compare detects significant shrinkage (>25%)', () => {
      // Re-capture baseline with 100 lines
      const bigContent = 'const x = 1;\n'.repeat(100);
      writeTestFile('shrink-test.js', bigContent);
      fileTracking.captureFileBaseline('shrink-test.js', testDir);

      // Shrink to 60 lines (40% reduction)
      writeTestFile('shrink-test.js', 'const x = 1;\n'.repeat(60));
      const comparison = fileTracking.compareFileToBaseline('shrink-test.js', testDir);
      expect(comparison.hasBaseline).toBe(true);
      expect(comparison.isSignificantlyShrunk).toBe(true);
    });

    it('compare returns hasBaseline=false for unknown file', () => {
      const comparison = fileTracking.compareFileToBaseline('never-captured.js', testDir);
      expect(comparison.hasBaseline).toBe(false);
    });
  });

  // ── Multiple Safeguards on Same File ────────────────────

  describe('Cascading safeguards on same file', () => {
    it('stub + tiny file triggers multiple quality issues', () => {
      const filePath = writeTestFile('cascade.js', `// TODO: implement\n`);
      const result = tm.checkFileQuality(filePath);
      expect(result.valid).toBe(false);
      // Should have multiple issues: nearly empty + placeholder content
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
    });

    it('baseline truncation + quality issues compound', () => {
      // Create a good baseline
      const goodContent = `
function processData(input) {
  const validated = validate(input);
  const transformed = transform(validated);
  return save(transformed);
}

function validate(input) {
  if (!input) throw new Error('Missing input');
  if (!input.id) throw new Error('Missing id');
  return input;
}

function transform(data) {
  return { ...data, processed: true, timestamp: Date.now() };
}

function save(data) {
  return { success: true, id: data.id };
}

module.exports = { processData, validate, transform, save };
`.trim();
      writeTestFile('compound.js', goodContent);
      fileTracking.captureFileBaseline('compound.js', testDir);

      // Replace with stub content (much smaller)
      writeTestFile('compound.js', '// ... code remains unchanged\n');

      // Both checks fail
      const quality = tm.checkFileQuality(path.join(testDir, 'compound.js'));
      const baseline = fileTracking.compareFileToBaseline('compound.js', testDir);

      expect(quality.valid).toBe(false);
      expect(baseline.isTruncated).toBe(true);
    });
  });

  // ── Per-File Independence ───────────────────────────────

  describe('Per-file independence', () => {
    it('one file failing does not affect another file check', () => {
      const badPath = writeTestFile('bad-independent.js', '// TODO: implement\n');
      const goodPath = writeTestFile('good-independent.js', `
function realImplementation() {
  const data = loadFromDatabase();
  const processed = processResults(data);
  return formatOutput(processed);
}

function loadFromDatabase() {
  return [1, 2, 3, 4, 5];
}

function processResults(data) {
  return data.map(x => x * 2);
}

function formatOutput(results) {
  return JSON.stringify(results);
}

module.exports = { realImplementation };
`);

      const badResult = tm.checkFileQuality(badPath);
      const goodResult = tm.checkFileQuality(goodPath);

      expect(badResult.valid).toBe(false);
      expect(goodResult.valid).toBe(true);
    });
  });

  // ── New File Handling ───────────────────────────────────

  describe('New file handling (isNewFile option)', () => {
    it('small new file does not trigger size/line-count warnings', () => {
      const filePath = writeTestFile('new-small.js', `
module.exports = function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
};
`);
      const result = tm.checkFileQuality(filePath, { isNewFile: true });
      // isNewFile skips size/line-count checks, but placeholder detection still runs
      // This file has no placeholders so it should pass
      expect(result.valid).toBe(true);
    });

    it('new file with stub content still triggers placeholder detection', () => {
      const filePath = writeTestFile('new-stub.js', `
function planned() {
  // TODO: implement the main logic
  throw new NotImplementedException();
}
`);
      const result = tm.checkFileQuality(filePath, { isNewFile: true });
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => /placeholder|stub/i.test(i))).toBe(true);
    });
  });
});
