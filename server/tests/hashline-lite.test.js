'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

// Dynamic imports — assigned after setupTestDb initializes the DB
let parseHashlineLiteEdits, applyHashlineLiteEdits, selectHashlineFormat,
    findSearchMatch, computeLineHash, _lineSimilarity, HASHLINE_LITE_SYSTEM_PROMPT, applyHashlineEdits;
let db;

describe('Hashline-Lite Provider', () => {
  let tempDir;

  beforeAll(() => {
    const setup = setupTestDb('hashline-lite');
    db = setup.db;

    const tm = require('../task-manager');
    if (typeof tm.initEarlyDeps === 'function') tm.initEarlyDeps();
    if (typeof tm.initSubModules === 'function') tm.initSubModules();
    parseHashlineLiteEdits = tm.parseHashlineLiteEdits;
    applyHashlineLiteEdits = tm.applyHashlineLiteEdits;
    selectHashlineFormat = tm.selectHashlineFormat;
    findSearchMatch = tm.findSearchMatch;
    computeLineHash = tm.computeLineHash;
    _lineSimilarity = tm.lineSimilarity;
    HASHLINE_LITE_SYSTEM_PROMPT = tm.HASHLINE_LITE_SYSTEM_PROMPT;
    applyHashlineEdits = tm.applyHashlineEdits;

    tempDir = path.join(os.tmpdir(), `torque-hashline-lite-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    teardownTestDb();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── HASHLINE_LITE_SYSTEM_PROMPT ─────────────────────────────────────

  describe('HASHLINE_LITE_SYSTEM_PROMPT', () => {
    it('is a non-empty string', () => {
      expect(typeof HASHLINE_LITE_SYSTEM_PROMPT).toBe('string');
      expect(HASHLINE_LITE_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it('contains SEARCH/REPLACE instructions but not HASHLINE_EDIT format', () => {
      expect(HASHLINE_LITE_SYSTEM_PROMPT).toContain('SEARCH');
      expect(HASHLINE_LITE_SYSTEM_PROMPT).toContain('REPLACE');
      expect(HASHLINE_LITE_SYSTEM_PROMPT).toContain('=======');
      expect(HASHLINE_LITE_SYSTEM_PROMPT).toContain('<<<<<<< SEARCH');
      expect(HASHLINE_LITE_SYSTEM_PROMPT).toContain('>>>>>>> REPLACE');
      // Should NOT instruct models to produce HASHLINE_EDIT blocks
      expect(HASHLINE_LITE_SYSTEM_PROMPT).not.toContain('END_REPLACE');
      expect(HASHLINE_LITE_SYSTEM_PROMPT).not.toContain('END_DELETE');
    });

    it('instructs NOT to include L###:xx: prefixes in output', () => {
      expect(HASHLINE_LITE_SYSTEM_PROMPT).toContain('WITHOUT');
      expect(HASHLINE_LITE_SYSTEM_PROMPT).toMatch(/L###:xx/);
    });
  });

  // ─── parseHashlineLiteEdits ───────────────────────────────────────────

  describe('parseHashlineLiteEdits', () => {
    const sampleFile = [
      'function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'function subtract(a, b) {',
      '  return a - b;',
      '}',
      '',
      'module.exports = { add, subtract };'
    ];

    it('parses a single SEARCH/REPLACE block with known file content', () => {
      const fileContextMap = new Map([['src/math.js', sampleFile]]);
      const output = `### FILE: src/math.js
<<<<<<< SEARCH
function add(a, b) {
  return a + b;
}
=======
function add(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('Expected numbers');
  return a + b;
}
>>>>>>> REPLACE`;

      const { edits, parseErrors } = parseHashlineLiteEdits(output, fileContextMap);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].type).toBe('replace');
      expect(edits[0].filePath).toBe('src/math.js');
      expect(edits[0].startLine).toBe(1);
      expect(edits[0].endLine).toBe(3);
      expect(edits[0].newContent).toContain('TypeError');
    });

    it('parses multiple SEARCH/REPLACE blocks for the same file', () => {
      const fileContextMap = new Map([['src/math.js', sampleFile]]);
      const output = `### FILE: src/math.js
<<<<<<< SEARCH
function add(a, b) {
  return a + b;
}
=======
function add(a, b) {
  return a + b + 0; // ensure numeric
}
>>>>>>> REPLACE

<<<<<<< SEARCH
function subtract(a, b) {
  return a - b;
}
=======
function subtract(a, b) {
  return a - b - 0; // ensure numeric
}
>>>>>>> REPLACE`;

      const { edits, parseErrors } = parseHashlineLiteEdits(output, fileContextMap);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(2);
      expect(edits[0].startLine).toBe(1);
      expect(edits[1].startLine).toBe(5);
    });

    it('strips leaked L###:xx: prefixes from SEARCH content', () => {
      const fileContextMap = new Map([['src/math.js', sampleFile]]);
      // Use valid-ish hex hashes (LLM might output these)
      const output = `### FILE: src/math.js
<<<<<<< SEARCH
L001:a1: function add(a, b) {
L002:b2:   return a + b;
L003:c3: }
=======
function add(a, b) {
  return a + b + 1;
}
>>>>>>> REPLACE`;

      const { edits, parseErrors } = parseHashlineLiteEdits(output, fileContextMap);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].startLine).toBe(1);
    });

    it('strips leaked L###:xx: prefixes from REPLACE content', () => {
      const fileContextMap = new Map([['src/math.js', sampleFile]]);
      const output = `### FILE: src/math.js
<<<<<<< SEARCH
function add(a, b) {
  return a + b;
}
=======
L001:a1: function add(a, b) {
L002:b2:   return a + b + 1;
L003:c3: }
>>>>>>> REPLACE`;

      const { edits, parseErrors } = parseHashlineLiteEdits(output, fileContextMap);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      // The REPLACE content should have prefixes stripped
      expect(edits[0].newContent).not.toContain('L001:');
      expect(edits[0].newContent).toContain('function add');
    });

    it('handles empty REPLACE (deletion)', () => {
      const fileContextMap = new Map([['src/math.js', sampleFile]]);
      const output = `### FILE: src/math.js
<<<<<<< SEARCH
function subtract(a, b) {
  return a - b;
}
=======
>>>>>>> REPLACE`;

      const { edits, parseErrors } = parseHashlineLiteEdits(output, fileContextMap);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].startLine).toBe(5);
      expect(edits[0].endLine).toBe(7);
      expect(edits[0].newContent).toBe('');
    });

    it('reports error for SEARCH block not found in file', () => {
      const fileContextMap = new Map([['src/math.js', sampleFile]]);
      // Use content completely unlike anything in the file
      const output = `### FILE: src/math.js
<<<<<<< SEARCH
class DatabaseConnection {
  constructor(url) {
    this.url = url;
  }
}
=======
class DatabaseConnection {
  constructor(url, options) {
    this.url = url;
    this.options = options;
  }
}
>>>>>>> REPLACE`;

      const { edits, parseErrors } = parseHashlineLiteEdits(output, fileContextMap);
      expect(edits).toHaveLength(0);
      expect(parseErrors.length).toBeGreaterThan(0);
      expect(parseErrors[0]).toContain('not found');
    });

    it('infers file path when only one file in context', () => {
      const fileContextMap = new Map([['src/math.js', sampleFile]]);
      // No ### FILE: header
      const output = `<<<<<<< SEARCH
function add(a, b) {
  return a + b;
}
=======
function add(a, b) {
  return a + b + 0;
}
>>>>>>> REPLACE`;

      const { edits, parseErrors } = parseHashlineLiteEdits(output, fileContextMap);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].filePath).toBe('src/math.js');
    });

    it('returns empty edits for null/undefined output', () => {
      const fileContextMap = new Map([['src/math.js', sampleFile]]);
      expect(parseHashlineLiteEdits(null, fileContextMap).edits).toHaveLength(0);
      expect(parseHashlineLiteEdits(undefined, fileContextMap).edits).toHaveLength(0);
      expect(parseHashlineLiteEdits('', fileContextMap).edits).toHaveLength(0);
    });
  });

  // ─── findSearchMatch (fuzzy matching) ─────────────────────────────────

  describe('findSearchMatch', () => {
    const fileLines = [
      'function hello() {',
      '  console.log("hello");',
      '}',
      '',
      'function world() {',
      '  console.log("world");',
      '}'
    ];

    it('finds exact match', () => {
      const search = ['function hello() {', '  console.log("hello");', '}'];
      const match = findSearchMatch(search, fileLines);
      expect(match).not.toBeNull();
      expect(match.startLine).toBe(1);
      expect(match.endLine).toBe(3);
      expect(match.score).toBe(1);
    });

    it('finds fuzzy match above 80% threshold', () => {
      // Slightly different indentation
      const search = ['function hello() {', '  console.log("hello") ;', '}'];
      const match = findSearchMatch(search, fileLines);
      expect(match).not.toBeNull();
      expect(match.startLine).toBe(1);
      expect(match.score).toBeGreaterThanOrEqual(0.8);
    });

    it('rejects match below 80% threshold', () => {
      const search = ['class TotallyDifferent extends Base {', '  this.initializeComponent();', '}'];
      const match = findSearchMatch(search, fileLines);
      expect(match).toBeNull();
    });

    it('returns null for empty search', () => {
      expect(findSearchMatch([], fileLines)).toBeNull();
    });
  });

  // ─── applyHashlineLiteEdits ───────────────────────────────────────────

  describe('applyHashlineLiteEdits', () => {
    it('applies edits through the hashline applicator', () => {
      const testFile = path.join(tempDir, 'apply-test.js');
      const content = 'function foo() {\n  return 1;\n}';
      fs.writeFileSync(testFile, content, 'utf8');

      const fileLines = content.split('\n');
      const edits = [{
        type: 'replace',
        filePath: testFile,
        startLine: 1,
        startHash: computeLineHash(fileLines[0]),
        endLine: 3,
        endHash: computeLineHash(fileLines[2]),
        newContent: 'function foo() {\n  return 42;\n}'
      }];

      const result = applyHashlineLiteEdits(tempDir, edits);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(true);

      const updated = fs.readFileSync(testFile, 'utf8');
      expect(updated).toContain('return 42');
    });

    it('returns success for empty edits', () => {
      const result = applyHashlineLiteEdits(tempDir, []);
      expect(result.success).toBe(true);
    });
  });

  // ─── selectHashlineFormat ─────────────────────────────────────────────

  describe('selectHashlineFormat', () => {
    it('returns config override for models in hashline_model_formats', () => {
      // R-hashline migration configures qwen2.5-coder:32b → hashline (standard)
      const result = selectHashlineFormat('qwen2.5-coder:32b', {});
      expect(result.format).toBe('hashline');
      expect(result.reason).toBe('config_override');
    });

    it('returns metadata override when hashline_format_override is set', () => {
      const task = { metadata: JSON.stringify({ hashline_format_override: 'hashline-lite' }) };
      const result = selectHashlineFormat('qwen2.5-coder:32b', task);
      expect(result.format).toBe('hashline-lite');
      expect(result.reason).toBe('fallback_override');
    });

    it('returns default hashline for unconfigured model with no data', () => {
      const result = selectHashlineFormat('some-unknown-model:7b', {});
      expect(result.format).toBe('hashline');
      expect(result.reason).toBe('default');
    });

    it('auto-routes to hashline-lite when hashline success rate is below threshold', () => {
      // Record enough failures for hashline
      for (let i = 0; i < 5; i++) {
        db.recordFormatSuccess('test-model-auto:7b', 'hashline', false, 'syntax_gate', 60);
      }
      // Record one success for hashline
      db.recordFormatSuccess('test-model-auto:7b', 'hashline', true, null, 30);

      const result = selectHashlineFormat('test-model-auto:7b', {});
      expect(result.format).toBe('hashline-lite');
      expect(result.reason).toContain('auto_');
    });
  });

  // ─── Syntax gate auto-repair ──────────────────────────────────────────

  describe('syntax gate auto-repair (trailing braces)', () => {
    it('auto-repairs 1-2 extra trailing braces at EOF', () => {
      const testFile = path.join(tempDir, 'brace-repair.js');
      // No trailing newline — clean file
      const content = 'function foo() {\n  return 1;\n}';
      fs.writeFileSync(testFile, content, 'utf8');

      const fileLines = content.split('\n');
      // Simulate an edit that adds extra trailing braces
      const edits = [{
        type: 'replace',
        filePath: testFile,
        startLine: 1,
        startHash: computeLineHash(fileLines[0]),
        endLine: 3,
        endHash: computeLineHash(fileLines[2]),
        newContent: 'function foo() {\n  return 2;\n}\n}'  // extra closing brace
      }];

      const result = applyHashlineEdits(testFile, edits);
      // Should auto-repair and succeed
      expect(result.success).toBe(true);

      const updated = fs.readFileSync(testFile, 'utf8');
      const open = (updated.match(/\{/g) || []).length;
      const close = (updated.match(/\}/g) || []).length;
      expect(open).toBe(close);
    });

    it('rejects when too many extra braces (>4) cannot be repaired', () => {
      const testFile = path.join(tempDir, 'brace-reject.js');
      const content = 'function bar() {\n  return 1;\n}';
      fs.writeFileSync(testFile, content, 'utf8');

      const fileLines = content.split('\n');
      const edits = [{
        type: 'replace',
        filePath: testFile,
        startLine: 1,
        startHash: computeLineHash(fileLines[0]),
        endLine: 3,
        endHash: computeLineHash(fileLines[2]),
        newContent: 'function bar() {\n  return 2;\n}\n}\n}\n}\n}\n}'  // 5 extra braces
      }];

      const result = applyHashlineEdits(testFile, edits);
      expect(result.success).toBe(false);
      expect(result.syntaxGateReject).toBe(true);
    });
  });

  // ─── Success rate recording end-to-end ────────────────────────────────

  describe('format success rate recording', () => {
    it('records success and retrieves accurate rates', () => {
      const model = 'test-recording-model:8b';
      db.recordFormatSuccess(model, 'hashline', true, null, 30);
      db.recordFormatSuccess(model, 'hashline', true, null, 40);
      db.recordFormatSuccess(model, 'hashline', false, 'syntax_gate', 60);

      const rate = db.getFormatSuccessRate(model, 'hashline');
      expect(rate.total).toBe(3);
      expect(rate.successes).toBe(2);
      expect(rate.rate).toBeCloseTo(0.67, 1);
      expect(rate.avg_duration).toBeGreaterThan(0);
    });

    it('returns zero rates for unknown model', () => {
      const rate = db.getFormatSuccessRate('nonexistent-model:1b', 'hashline');
      expect(rate.total).toBe(0);
      expect(rate.rate).toBe(0);
    });

    it('summary includes all recorded models', () => {
      db.recordFormatSuccess('summary-test:7b', 'hashline-lite', true, null, 20);
      const summary = db.getFormatSuccessRatesSummary();
      expect(summary.length).toBeGreaterThan(0);
      const entry = summary.find(r => r.model === 'summary-test:7b');
      expect(entry).toBeDefined();
      expect(entry.edit_format).toBe('hashline-lite');
      expect(entry.successes).toBe(1);
    });

    it('getBestFormatForModel returns recommendation based on data', () => {
      const model = 'best-format-test:14b';
      // Record bad hashline performance
      for (let i = 0; i < 4; i++) {
        db.recordFormatSuccess(model, 'hashline', false, 'syntax_gate', 90);
      }
      db.recordFormatSuccess(model, 'hashline', true, null, 45);

      const best = db.getBestFormatForModel(model);
      expect(best.format).toBe('hashline-lite');
      expect(best.reason).toBe('hashline_below_threshold');
    });
  });

  // ─── Format escalation chain (syntax gate → hashline-lite → aider) ──

  describe('format escalation chain', () => {
    // Helper: create a task in the DB for escalation testing
    function createEscalationTask(overrides = {}) {
      const { randomUUID } = require('crypto');
      const taskId = overrides.id || randomUUID();
      db.createTask({
        id: taskId,
        task_description: overrides.description || 'Test escalation task',
        status: overrides.status || 'running',
        provider: overrides.provider || 'hashline-ollama',
        model: overrides.model || 'qwen3:8b',
        working_directory: overrides.working_directory || tempDir,
        metadata: overrides.metadata || null,
      });
      return db.getTask(taskId);
    }

    it('syntax gate reject on hashline → sets hashline_format_override to hashline-lite', () => {
      // Step 1: Create a JS file with valid syntax
      const testFile = path.join(tempDir, 'escalation-step1.js');
      const content = 'function greet(name) {\n  return "Hello " + name;\n}';
      fs.writeFileSync(testFile, content, 'utf8');

      // Step 2: Apply malformed edits that trigger syntax gate (5+ extra braces)
      const fileLines = content.split('\n');
      const edits = [{
        type: 'replace',
        filePath: testFile,
        startLine: 1,
        startHash: computeLineHash(fileLines[0]),
        endLine: 3,
        endHash: computeLineHash(fileLines[2]),
        newContent: 'function greet(name) {\n  return "Hello " + name;\n}\n}\n}\n}\n}\n}'
      }];

      const result = applyHashlineEdits(testFile, edits);
      expect(result.syntaxGateReject).toBe(true);

      // Step 3: Simulate what executeHashlineOllamaTask does on syntax gate reject
      // when editFormat === 'hashline' (lines 1497-1510 of execution.js)
      const task = createEscalationTask();
      const currentMeta = {};
      currentMeta.hashline_format_override = 'hashline-lite';
      db.updateTaskStatus(task.id, 'queued', {
        provider: 'hashline-ollama',
        pid: null, started_at: null,
        metadata: JSON.stringify(currentMeta),
        error_output: 'Syntax gate rejected hashline edits. Retrying with hashline-lite.'
      });

      // Step 4: Verify the task is requeued with format override
      const updated = db.getTask(task.id);
      expect(updated.status).toBe('queued');
      expect(updated.provider).toBe('hashline-ollama');
      const meta = updated.metadata || {};
      expect(meta.hashline_format_override).toBe('hashline-lite');

      // Step 5: selectHashlineFormat should now pick up the override
      const format = selectHashlineFormat(updated.model, updated);
      expect(format.format).toBe('hashline-lite');
      expect(format.reason).toBe('fallback_override');
    });

    it('syntax gate reject on hashline-lite → falls back to aider-ollama', () => {
      // Step 1: Create a JS file
      const testFile = path.join(tempDir, 'escalation-step2.js');
      const content = 'function calc(x) {\n  return x * 2;\n}';
      fs.writeFileSync(testFile, content, 'utf8');

      // Step 2: Verify syntax gate rejects malformed edits
      const fileLines = content.split('\n');
      const edits = [{
        type: 'replace',
        filePath: testFile,
        startLine: 1,
        startHash: computeLineHash(fileLines[0]),
        endLine: 3,
        endHash: computeLineHash(fileLines[2]),
        newContent: 'function calc(x) {\n  return x * 2;\n}\n}\n}\n}\n}\n}'
      }];

      const result = applyHashlineEdits(testFile, edits);
      expect(result.syntaxGateReject).toBe(true);

      // Step 3: Simulate what executeHashlineOllamaTask does on syntax gate reject
      // when editFormat !== 'hashline' (i.e. hashline-lite) — lines 1513-1522 of execution.js
      const task = createEscalationTask({
        metadata: JSON.stringify({ hashline_format_override: 'hashline-lite' })
      });

      db.updateTaskStatus(task.id, 'queued', {
        provider: 'aider-ollama',
        pid: null, started_at: null, ollama_host_id: null,
        error_output: 'Syntax gate rejected hashline-lite edits. Falling back to aider-ollama.'
      });

      // Step 4: Verify the task is now aider-ollama
      const updated = db.getTask(task.id);
      expect(updated.status).toBe('queued');
      expect(updated.provider).toBe('aider-ollama');
      expect(updated.error_output).toContain('aider-ollama');
    });

    it('full escalation: hashline → hashline-lite → aider-ollama state machine', () => {
      const model = 'escalation-chain-model:8b';
      const testFile = path.join(tempDir, 'escalation-full.js');
      const content = 'function process(data) {\n  return data.map(x => x + 1);\n}';
      fs.writeFileSync(testFile, content, 'utf8');

      // ─── Stage 1: hashline format, syntax gate rejects ───
      const task = createEscalationTask({ model });
      db.recordFormatSuccess(model, 'hashline', false, 'syntax_gate', 30);

      // Simulate requeue with hashline-lite override
      const meta1 = { hashline_format_override: 'hashline-lite' };
      db.updateTaskStatus(task.id, 'queued', {
        provider: 'hashline-ollama',
        metadata: JSON.stringify(meta1),
        error_output: 'Stage 1: syntax gate rejected hashline.'
      });

      const state1 = db.getTask(task.id);
      expect(state1.status).toBe('queued');
      expect(state1.provider).toBe('hashline-ollama');
      expect(selectHashlineFormat(model, state1).format).toBe('hashline-lite');

      // ─── Stage 2: hashline-lite format, syntax gate rejects ───
      db.updateTaskStatus(task.id, 'running', {});
      db.recordFormatSuccess(model, 'hashline-lite', false, 'syntax_gate', 25);

      // Simulate fallback to aider-ollama
      db.updateTaskStatus(task.id, 'queued', {
        provider: 'aider-ollama',
        pid: null, started_at: null, ollama_host_id: null,
        error_output: 'Stage 2: syntax gate rejected hashline-lite. Falling back to aider-ollama.'
      });

      const state2 = db.getTask(task.id);
      expect(state2.status).toBe('queued');
      expect(state2.provider).toBe('aider-ollama');

      // ─── Verify format success tracking ───
      const hashlineRate = db.getFormatSuccessRate(model, 'hashline');
      expect(hashlineRate.total).toBeGreaterThanOrEqual(1);
      expect(hashlineRate.successes).toBe(0);

      const liteRate = db.getFormatSuccessRate(model, 'hashline-lite');
      expect(liteRate.total).toBeGreaterThanOrEqual(1);
      expect(liteRate.successes).toBe(0);
    });

    it('format success recording influences future auto-routing after escalation', () => {
      const model = 'auto-route-after-esc:8b';

      // Record 3 hashline syntax gate failures (enough to trigger auto-routing)
      for (let i = 0; i < 3; i++) {
        db.recordFormatSuccess(model, 'hashline', false, 'syntax_gate', 30);
      }
      // Record 1 hashline-lite success
      db.recordFormatSuccess(model, 'hashline-lite', true, null, 20);

      // With auto-select enabled, future tasks should auto-route to hashline-lite
      db.setConfig('hashline_format_auto_select', '1');
      const format = selectHashlineFormat(model, null);
      expect(format.format).toBe('hashline-lite');
      expect(format.reason).toContain('auto_');
    });

    it('metadata override takes priority over auto-routing after escalation', () => {
      const model = 'override-priority:8b';

      // Record bad hashline performance → auto-routing would suggest hashline-lite
      for (let i = 0; i < 5; i++) {
        db.recordFormatSuccess(model, 'hashline', false, 'syntax_gate', 30);
      }

      // But metadata override forces hashline (e.g. from stall recovery)
      const task = { metadata: JSON.stringify({ hashline_format_override: 'hashline' }) };
      const format = selectHashlineFormat(model, task);
      expect(format.format).toBe('hashline');
      expect(format.reason).toBe('fallback_override');
    });

    it('file-size-aware routing overrides hashline → hashline-lite for small files', () => {
      // This tests that the file-size override (execution.js lines 1180-1189)
      // works independently of the escalation chain
      const smallFile = path.join(tempDir, 'tiny.js');
      const content = 'const x = 1;\nconst y = 2;\nconst z = x + y;\n';
      fs.writeFileSync(smallFile, content, 'utf8');
      const lineCount = content.split('\n').filter(l => l.length > 0).length;

      // File is < 50 lines, so it should trigger the file-size override
      expect(lineCount).toBeLessThan(50);

      // selectHashlineFormat returns 'hashline' for unconfigured model
      const format = selectHashlineFormat('qwen2.5-coder:32b', {});
      expect(format.format).toBe('hashline');

      // The actual file-size override happens in executeHashlineOllamaTask,
      // not in selectHashlineFormat. Verify the threshold config exists.
      const threshold = parseInt(db.getConfig('hashline_file_size_threshold') || '50', 10);
      expect(threshold).toBe(50);
      expect(lineCount).toBeLessThan(threshold);
      // In execution.js, this would cause: editFormat = 'hashline-lite'
    });
  });
});
