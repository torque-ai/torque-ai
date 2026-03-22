/**
 * Task Manager Module Tests
 *
 * Direct unit tests for task-manager.js exported functions.
 * Uses vi.mock for child_process to avoid real process spawns.
 * Uses isolated temp DB via vitest-setup.js pattern.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

let testDir;
let origDataDir;
let db;
let tm;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setupTm() {
  testDir = path.join(os.tmpdir(), `torque-vtest-taskmgr-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  tm = require('../task-manager');
  return { db, tm };
}

function teardownTm() {
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

describe('Task Manager Module', () => {
  beforeAll(() => { setupTm(); });
  afterAll(() => { teardownTm(); });

  // ── Running Process Count ────────────────────────────────
  describe('getRunningTaskCount', () => {
    it('returns 0 initially', () => {
      expect(tm.getRunningTaskCount()).toBe(0);
    });

    it('returns a number', () => {
      expect(typeof tm.getRunningTaskCount()).toBe('number');
    });
  });

  // ── Cancel Task ──────────────────────────────────────────
  describe('cancelTask', () => {
    it('cancels a queued task', () => {
      const id = uuidv4();
      db.createTask({
        id,
        task_description: 'Task to cancel',
        status: 'queued',
        working_directory: testDir,
      });
      const result = tm.cancelTask(id, 'Unit test cancellation');
      expect(result).not.toBeNull();
      const task = db.getTask(id);
      expect(task.status).toBe('cancelled');
    });

    it('throws for nonexistent task ID', () => {
      expect(() => tm.cancelTask('nonexistent_task_abc123', 'Test'))
        .toThrow();
    });
  });

  // ── File Quality ─────────────────────────────────────────
  describe('checkFileQuality', () => {
    let tmpFile;

    afterEach(() => {
      if (tmpFile && fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    });

    it('reports no issues for valid code file', () => {
      tmpFile = path.join(testDir, 'valid.js');
      fs.writeFileSync(tmpFile, `
function greet(name) {
  console.log('Hello ' + name);
  return name.toUpperCase();
}

function farewell(name) {
  console.log('Goodbye ' + name);
  return name.toLowerCase();
}

module.exports = { greet, farewell };
`);
      const result = tm.checkFileQuality(tmpFile);
      expect(result.valid).toBe(true);
      expect(result.issues.length).toBe(0);
    });

    it('detects empty files', () => {
      tmpFile = path.join(testDir, 'empty.js');
      fs.writeFileSync(tmpFile, '   ');
      const result = tm.checkFileQuality(tmpFile);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some(i => i.includes('empty'))).toBe(true);
    });

    it('detects stub files', () => {
      tmpFile = path.join(testDir, 'stub.js');
      fs.writeFileSync(tmpFile, `// placeholder\nthrow new Error("Not implemented");\n`);
      const result = tm.checkFileQuality(tmpFile);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('returns valid for nonexistent file', () => {
      const result = tm.checkFileQuality('/tmp/does-not-exist-xyz.js');
      expect(result.valid).toBe(true);
    });

    it('skips size checks for new files', () => {
      tmpFile = path.join(testDir, 'newfile.js');
      fs.writeFileSync(tmpFile, 'x = 1;');
      const result = tm.checkFileQuality(tmpFile, { isNewFile: true });
      // Should not complain about tiny size for new files
      const sizeIssues = result.issues.filter(i => i.includes('empty') || i.includes('lines of code'));
      expect(sizeIssues.length).toBe(0);
    });
  });

  // ── File Path Validation ─────────────────────────────────
  describe('isValidFilePath', () => {
    it.todo('isValidFilePath not exported');
  });

  // ── Shell Safety ─────────────────────────────────────────
  describe('isShellSafe', () => {
    it.todo('isShellSafe not exported');
  });

  // ── Extract Modified Files ───────────────────────────────
  describe('extractModifiedFiles', () => {
    it.todo('extractModifiedFiles not exported');
  });

  describe('detectSuccessFromOutput', () => {
    it('detects codex success markers even when they are earlier than the final 2KB', () => {
      const output = [
        'Success. Updated the following files:',
        'M src/runner.js',
        '',
        'x'.repeat(2500)
      ].join('\n');

      expect(tm.detectSuccessFromOutput(output, 'codex')).toBe(true);
    });

    it('detects plain-language file writes when the transcript includes the written path', () => {
      const output = [
        'Baseline snapshot has been written to:',
        'artifacts/inspection/runner-status-integrity.md',
        '',
        'tokens used: 123'
      ].join('\n');

      expect(tm.detectSuccessFromOutput(output, 'codex')).toBe(true);
    });

    it('detects diff-only codex transcripts as successful work', () => {
      const output = [
        'Some planning text',
        'diff --git a/server/handlers/workflow-handlers.js b/server/handlers/workflow-handlers.js',
        '--- a/server/handlers/workflow-handlers.js',
        '+++ b/server/handlers/workflow-handlers.js',
        '@@ -1,3 +1,4 @@',
        '+const restartGuard = true;',
      ].join('\n');

      expect(tm.detectSuccessFromOutput(output, 'codex')).toBe(true);
    });

    it('rejects Codex API errors even when success patterns are present', () => {
      const output = [
        'mcp startup: ready: torque, pixellab',
        'ERROR: {"detail":"The \'codex\' model is not supported when using Codex with a ChatGPT account."}',
        '',
        'Changes made:',
        'Implemented the feature',
      ].join('\n');

      expect(tm.detectSuccessFromOutput(output, 'codex')).toBe(false);
    });

    it('rejects model-not-found errors', () => {
      const output = [
        'Error: model "gpt-99" not found on this server',
        'diff --git a/file.js b/file.js',
      ].join('\n');

      expect(tm.detectSuccessFromOutput(output, 'codex')).toBe(false);
    });

    it('rejects invalid API key errors', () => {
      const output = 'Error: Invalid API key provided. Success. Updated the following files:';

      expect(tm.detectSuccessFromOutput(output, 'deepinfra')).toBe(false);
    });

    it('rejects authentication failed errors', () => {
      const output = 'Authentication failed: token expired\nAll 5 tests passed';

      expect(tm.detectSuccessFromOutput(output, 'hyperbolic')).toBe(false);
    });

    it('rejects insufficient quota errors', () => {
      const output = 'Error: insufficient_quota - you have exceeded your billing limit\nfile update:';

      expect(tm.detectSuccessFromOutput(output, 'deepinfra')).toBe(false);
    });

    it('detects shared test-pass summaries once the provider threshold is met', () => {
      const output = `${'x'.repeat(2100)}\n12 passed, 0 failed`;

      expect(tm.detectSuccessFromOutput(output, 'unknown-provider')).toBe(true);
    });
  });

  // ── Context Estimation ───────────────────────────────────
  describe('estimateRequiredContext', () => {
    it.todo('estimateRequiredContext not exported');
  });

  // ── Instruction Templates ────────────────────────────────
  describe('Instruction Templates', () => {
    it('DEFAULT_INSTRUCTION_TEMPLATES is defined', () => {
      expect(tm.DEFAULT_INSTRUCTION_TEMPLATES).toBeDefined();
      expect(typeof tm.DEFAULT_INSTRUCTION_TEMPLATES).toBe('object');
    });

    it('getInstructionTemplate returns a string', () => {
      const template = tm.getInstructionTemplate('default');
      expect(template).toBeTruthy();
      expect(template).toContain('{TASK_DESCRIPTION}');
    });

    it('wrapWithInstructions wraps task description', () => {
      const wrapped = tm.wrapWithInstructions('Do something', {});
      expect(typeof wrapped).toBe('string');
      expect(wrapped.length).toBeGreaterThan(0);
    });
  });

  // ── Provider Timeouts ────────────────────────────────────
  describe('PROVIDER_DEFAULT_TIMEOUTS', () => {
    it('contains expected providers', () => {
      expect(tm.PROVIDER_DEFAULT_TIMEOUTS).toBeDefined();
      expect(typeof tm.PROVIDER_DEFAULT_TIMEOUTS).toBe('object');
      expect(tm.PROVIDER_DEFAULT_TIMEOUTS.codex).toBeDefined();
      expect(tm.PROVIDER_DEFAULT_TIMEOUTS.ollama).toBeDefined();
    });
  });

  // ── Hashline Internals ──────────────────────────────────
  describe('computeLineHash', () => {
    it('returns a 2-char hex string', () => {
      const hash = tm.computeLineHash('hello world');
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(2);
      expect(/^[0-9a-f]{2}$/.test(hash)).toBe(true);
    });

    it('returns consistent results', () => {
      const h1 = tm.computeLineHash('test line');
      const h2 = tm.computeLineHash('test line');
      expect(h1).toBe(h2);
    });

    it('returns different hashes for different content', () => {
      const h1 = tm.computeLineHash('line A');
      const h2 = tm.computeLineHash('line B');
      expect(/^[0-9a-f]{2}$/.test(h1)).toBe(true);
      expect(/^[0-9a-f]{2}$/.test(h2)).toBe(true);
      expect(h1).not.toBe(h2);
    });
  });

  // ── Model Size Helpers ───────────────────────────────────
  describe('Model Size Helpers', () => {
    it('parseModelSizeB extracts size from model name', () => {
      expect(tm.parseModelSizeB('qwen3:8b')).toBe(8);
      expect(tm.parseModelSizeB('qwen2.5-coder:32b')).toBe(32);
      expect(tm.parseModelSizeB('gemma3:4b')).toBe(4);
    });

    it('isSmallModel identifies small models', () => {
      expect(tm.isSmallModel('gemma3:4b')).toBe(true);
      expect(tm.isSmallModel('qwen2.5-coder:32b')).toBe(false);
    });

    it('isThinkingModel identifies thinking models', () => {
      expect(tm.isThinkingModel('deepseek-r1:14b')).toBe(true);
      expect(tm.isThinkingModel('gemma3:4b')).toBe(false);
    });

    it('getModelSizeCategory returns a valid category', () => {
      const cat = tm.getModelSizeCategory('qwen3:8b');
      expect(['small', 'medium', 'large', 'xlarge', 'unknown']).toContain(cat);
    });
  });

  // ── detectTaskTypes ──────────────────────────────────────
  describe('detectTaskTypes', () => {
    it('detects code creation task', () => {
      const types = tm.detectTaskTypes('Create a new test file for the auth module');
      expect(Array.isArray(types)).toBe(true);
      expect(types.length).toBeGreaterThan(0);
    });

    it('does not classify existing test file extension work as creation', () => {
      const types = tm.detectTaskTypes('Extend the existing test file tests/auth.test.js with more retry coverage');
      expect(types).not.toContain('file-creation');
      expect(types).toContain('single-file-task');
    });

    it('returns empty array for ambiguous task', () => {
      const types = tm.detectTaskTypes('do something');
      expect(Array.isArray(types)).toBe(true);
    });
  });

  // ── Hashline Edit Parsing ────────────────────────────────
  describe('parseHashlineEdits', () => {
    it('parses valid hashline edit blocks', () => {
      const result = tm.parseHashlineEdits(`
HASHLINE_EDIT file.ts
REPLACE 5:ab-8:cd
new content here
more content
END_REPLACE
END_EDIT
`);
      expect(result).toBeDefined();
      expect(Array.isArray(result.edits)).toBe(true);
      expect(Array.isArray(result.parseErrors)).toBe(true);
    });

    it('returns empty edits for empty input', () => {
      const result = tm.parseHashlineEdits('');
      expect(result.edits.length).toBe(0);
    });

    it('returns empty edits for null input', () => {
      const result = tm.parseHashlineEdits(null);
      expect(result.edits.length).toBe(0);
    });
  });
});

describe('Task Manager shutdown behaviour', () => {
  it('clears the queue poll interval during shutdown', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    try {
      // Verify the queue poll interval exists before shutdown
      const queuePollInterval = tm._testing.queuePollInterval;
      expect(queuePollInterval).toBeDefined();

      clearIntervalSpy.mockClear();
      tm.shutdown();

      expect(clearIntervalSpy).toHaveBeenCalledWith(queuePollInterval);
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });
});
