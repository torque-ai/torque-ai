/**
 * Integration Test: Safeguard Cascades
 */

const path = require('path');
const fs = require('fs');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let testDir;
let db;
let tm;
let fileTracking;

describe('Integration: Safeguard Cascades', () => {
  beforeAll(() => {
    ({ db, testDir } = setupTestDbOnly('integration-safeguards'));
    fileTracking = require('../db/file-tracking');
    fileTracking.setDb(db.getDb ? db.getDb() : db.getDbInstance());
    tm = require('../task-manager');
  });
  afterAll(() => { teardownTestDb(); });

  function writeTestFile(filename, content) {
    const filePath = path.join(testDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

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
      expect(result.valid).toBe(false);
    });
  });

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
      writeTestFile('baseline-test.js', 'function hello() { return "world"; }\n'.repeat(5));

      const comparison = fileTracking.compareFileToBaseline('baseline-test.js', testDir);
      expect(comparison.hasBaseline).toBe(true);
      expect(comparison.sizeChangePercent).toBeLessThan(-50);
      expect(comparison.isTruncated).toBe(true);
    });

    it('compare detects significant shrinkage (>25%)', () => {
      const bigContent = 'const x = 1;\n'.repeat(100);
      writeTestFile('shrink-test.js', bigContent);
      fileTracking.captureFileBaseline('shrink-test.js', testDir);

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

  describe('Cascading safeguards on same file', () => {
    it('stub + tiny file triggers multiple quality issues', () => {
      const filePath = writeTestFile('cascade.js', `// TODO: implement\n`);
      const result = tm.checkFileQuality(filePath);
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
    });

    it('baseline truncation + quality issues compound', () => {
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

      writeTestFile('compound.js', '// ... code remains unchanged\n');

      const quality = tm.checkFileQuality(path.join(testDir, 'compound.js'));
      const baseline = fileTracking.compareFileToBaseline('compound.js', testDir);

      expect(quality.valid).toBe(false);
      expect(baseline.isTruncated).toBe(true);
    });
  });

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

  describe('New file handling (isNewFile option)', () => {
    it('small new file does not trigger size/line-count warnings', () => {
      const filePath = writeTestFile('new-small.js', `
module.exports = function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
};
`);
      const result = tm.checkFileQuality(filePath, { isNewFile: true });
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
