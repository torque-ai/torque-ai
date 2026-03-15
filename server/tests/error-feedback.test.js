'use strict';

/**
 * Unit Tests: Error-Feedback Retry Loop
 *
 * Tests runErrorFeedbackLoop, runOllamaGenerate, parseAndApplyEdits,
 * and buildHashlineErrorFeedbackPrompt integration.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { computeLineHash } = require('../utils/hashline-parser');
const { buildHashlineErrorFeedbackPrompt } = require('../utils/context-enrichment');

// We need db + execution module initialized for runErrorFeedbackLoop
let db;
let tempDir;

beforeAll(() => {
  const setup = setupTestDb('error-feedback');
  db = setup.db;
  tempDir = path.join(os.tmpdir(), `torque-error-feedback-test-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
});

afterAll(() => {
  teardownTestDb();
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── buildHashlineErrorFeedbackPrompt ──────────────────────────────────

describe('buildHashlineErrorFeedbackPrompt', () => {
  it('generates re-annotated content with line hashes', () => {
    const projDir = path.join(tempDir, 'feedback-prompt-1');
    fs.mkdirSync(projDir, { recursive: true });

    const fileContent = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
    fs.writeFileSync(path.join(projDir, 'test.js'), fileContent);

    const errors = ['test.js: Syntax error - unexpected token'];
    const result = buildHashlineErrorFeedbackPrompt(projDir, ['test.js'], errors, 'hashline');

    // Should contain re-annotated lines
    expect(result).toContain('L001:');
    expect(result).toContain('L002:');
    expect(result).toContain('L003:');

    // Should contain the error
    expect(result).toContain('unexpected token');

    // Should contain fix instruction
    expect(result).toContain('FIX THE FOLLOWING ERRORS');
    expect(result).toContain('HASHLINE_EDIT');
  });

  it('includes correct hashes matching computeLineHash', () => {
    const projDir = path.join(tempDir, 'feedback-prompt-hashes');
    fs.mkdirSync(projDir, { recursive: true });

    const line1 = 'function hello() {';
    const line2 = '  return "world";';
    const line3 = '}';
    fs.writeFileSync(path.join(projDir, 'func.js'), `${line1}\n${line2}\n${line3}\n`);

    const result = buildHashlineErrorFeedbackPrompt(projDir, ['func.js'], ['error'], 'hashline');

    const hash1 = computeLineHash(line1);
    const hash2 = computeLineHash(line2);
    const hash3 = computeLineHash(line3);

    expect(result).toContain(`L001:${hash1}:`);
    expect(result).toContain(`L002:${hash2}:`);
    expect(result).toContain(`L003:${hash3}:`);
  });

  it('uses SEARCH/REPLACE instruction for hashline-lite format', () => {
    const projDir = path.join(tempDir, 'feedback-prompt-lite');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'test.ts'), 'const x: number = "hello";\n');

    const result = buildHashlineErrorFeedbackPrompt(projDir, ['test.ts'], ['TS2322'], 'hashline-lite');
    expect(result).toContain('SEARCH');
    expect(result).toContain('REPLACE');
  });

  it('returns empty for no errors', () => {
    const result = buildHashlineErrorFeedbackPrompt(tempDir, ['test.js'], [], 'hashline');
    expect(result).toBe('');
  });

  it('returns empty for no modified files', () => {
    const result = buildHashlineErrorFeedbackPrompt(tempDir, [], ['error'], 'hashline');
    expect(result).toBe('');
  });

  it('returns empty for null inputs', () => {
    expect(buildHashlineErrorFeedbackPrompt(tempDir, null, ['error'], 'hashline')).toBe('');
    expect(buildHashlineErrorFeedbackPrompt(tempDir, ['f'], null, 'hashline')).toBe('');
  });

  it('handles multiple files', () => {
    const projDir = path.join(tempDir, 'feedback-prompt-multi');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'a.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(projDir, 'b.js'), 'const b = 2;\n');

    const errors = ['a.js: error1', 'b.js: error2'];
    const result = buildHashlineErrorFeedbackPrompt(projDir, ['a.js', 'b.js'], errors, 'hashline');

    expect(result).toContain('### FILE: a.js');
    expect(result).toContain('### FILE: b.js');
    expect(result).toContain('error1');
    expect(result).toContain('error2');
  });

  it('skips non-existent files gracefully', () => {
    const projDir = path.join(tempDir, 'feedback-prompt-missing');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'exists.js'), 'const x = 1;\n');

    const result = buildHashlineErrorFeedbackPrompt(projDir, ['exists.js', 'missing.js'], ['error'], 'hashline');
    expect(result).toContain('### FILE: exists.js');
    expect(result).not.toContain('### FILE: missing.js');
  });
});

// ─── parseAndApplyEdits ────────────────────────────────────────────────

describe('parseAndApplyEdits', () => {
  // We import this from execution.js after init
  let parseAndApplyEdits;

  beforeAll(() => {
    // The execution module needs init, but for parseAndApplyEdits we only need
    // hashline-parser functions which are imported at module level
    parseAndApplyEdits = require('../providers/execution').parseAndApplyEdits;
  });

  it('parses and applies hashline edits', () => {
    const projDir = path.join(tempDir, 'parse-apply-1');
    fs.mkdirSync(projDir, { recursive: true });

    const line1 = 'const x = 1;';
    const line2 = 'const y = 2;';
    const line3 = 'const z = 3;';
    fs.writeFileSync(path.join(projDir, 'test.js'), `${line1}\n${line2}\n${line3}\n`);

    const hash2 = computeLineHash(line2);
    const fileContextMap = new Map([['test.js', [line1, line2, line3, '']]]);

    const llmOutput = `HASHLINE_EDIT test.js
REPLACE L002:${hash2} TO L002:${hash2}
const y = 42;
END_REPLACE`;

    const result = parseAndApplyEdits({
      llmOutput,
      editFormat: 'hashline',
      fileContextMap,
      resolvedFiles: [{ mentioned: 'test.js', actual: 'test.js' }],
      workingDir: projDir
    });

    expect(result.edits).toHaveLength(1);
    expect(result.allSuccess).toBe(true);
    expect(result.totalAdded).toBe(1);
    expect(result.totalRemoved).toBe(1);
    expect(result.modifiedFiles).toContain('test.js');
  });

  it('returns empty results when no edits found', () => {
    const result = parseAndApplyEdits({
      llmOutput: 'No edits here, just explanation text.',
      editFormat: 'hashline',
      fileContextMap: new Map(),
      resolvedFiles: [],
      workingDir: tempDir
    });

    expect(result.edits).toHaveLength(0);
    expect(result.allSuccess).toBe(false);
    expect(result.modifiedFiles).toHaveLength(0);
  });
});

// ─── runErrorFeedbackLoop (config gating) ──────────────────────────────

describe('runErrorFeedbackLoop', () => {
  let runErrorFeedbackLoop;

  beforeAll(() => {
    // Initialize execution module with minimal deps
    const execution = require('../providers/execution');
    execution.init({
      db,
      dashboard: {
        notifyTaskUpdated: () => {},
        notifyTaskOutput: () => {},
      },
      runningProcesses: new Map(),
      apiAbortControllers: new Map(),
      safeUpdateTaskStatus: () => {},
      processQueue: () => {},
    });
    runErrorFeedbackLoop = execution.runErrorFeedbackLoop;
  });

  it('returns null when error_feedback_enabled is not set', async () => {
    // Ensure config is not set (default)
    const result = await runErrorFeedbackLoop({
      taskId: 'test-1',
      task: { id: 'test-1' },
      workingDir: tempDir,
      editFormat: 'hashline',
      ollamaHost: 'http://localhost:11434',
      ollamaModel: 'test',
      systemPrompt: '',
      options: {},
      modifiedFiles: [],
      resolvedFiles: [],
      fileContextMap: new Map(),
      ollamaStreamId: 'stream-1'
    });

    expect(result).toBeNull();
  });

  it('returns null when error_feedback_enabled is 0', async () => {
    db.setConfig('error_feedback_enabled', '0');

    const result = await runErrorFeedbackLoop({
      taskId: 'test-2',
      task: { id: 'test-2' },
      workingDir: tempDir,
      editFormat: 'hashline',
      ollamaHost: 'http://localhost:11434',
      ollamaModel: 'test',
      systemPrompt: '',
      options: {},
      modifiedFiles: [],
      resolvedFiles: [],
      fileContextMap: new Map(),
      ollamaStreamId: 'stream-2'
    });

    expect(result).toBeNull();

    // Clean up
    db.setConfig('error_feedback_enabled', '0');
  });

  it('returns null when checkSyntax passes (no errors)', async () => {
    db.setConfig('error_feedback_enabled', '1');

    // Create a valid JS file
    const projDir = path.join(tempDir, 'feedback-valid');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'good.js'), 'const x = 1;\n');

    const result = await runErrorFeedbackLoop({
      taskId: 'test-3',
      task: { id: 'test-3' },
      workingDir: projDir,
      editFormat: 'hashline',
      ollamaHost: 'http://localhost:11434',
      ollamaModel: 'test',
      systemPrompt: '',
      options: {},
      modifiedFiles: ['good.js'],
      resolvedFiles: [{ mentioned: 'good.js', actual: 'good.js' }],
      fileContextMap: new Map(),
      ollamaStreamId: 'stream-3'
    });

    // No errors found → null (caller proceeds normally)
    expect(result).toBeNull();

    // Clean up
    db.setConfig('error_feedback_enabled', '0');
  });

  it('respects max_turns configuration', async () => {
    db.setConfig('error_feedback_enabled', '1');
    db.setConfig('error_feedback_max_turns', '3');

    // Create a JS file with a syntax error that can't be fixed without Ollama
    const projDir = path.join(tempDir, 'feedback-max-turns');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'broken.js'), 'const x = {\n');

    const result = await runErrorFeedbackLoop({
      taskId: 'test-4',
      task: { id: 'test-4' },
      workingDir: projDir,
      editFormat: 'hashline',
      ollamaHost: 'http://localhost:99999', // unreachable — will fail on connect
      ollamaModel: 'test',
      systemPrompt: '',
      options: {},
      modifiedFiles: ['broken.js'],
      resolvedFiles: [{ mentioned: 'broken.js', actual: 'broken.js' }],
      fileContextMap: new Map(),
      ollamaStreamId: 'stream-4'
    });

    // Should have tried and failed (Ollama unreachable), breaking after first turn
    expect(result).not.toBeNull();
    expect(result.fixed).toBe(false);
    expect(result.feedbackLog.length).toBeLessThanOrEqual(3);

    // Clean up
    db.setConfig('error_feedback_enabled', '0');
    db.setConfig('error_feedback_max_turns', '1');
  });

  it('handles files with no syntax issues gracefully on first check', async () => {
    db.setConfig('error_feedback_enabled', '1');

    const projDir = path.join(tempDir, 'feedback-no-issues');
    fs.mkdirSync(projDir, { recursive: true });

    // Create files that checkSyntax won't flag (non-JS/TS/CS extensions)
    fs.writeFileSync(path.join(projDir, 'data.txt'), 'just some text');

    const result = await runErrorFeedbackLoop({
      taskId: 'test-5',
      task: { id: 'test-5' },
      workingDir: projDir,
      editFormat: 'hashline',
      ollamaHost: 'http://localhost:11434',
      ollamaModel: 'test',
      systemPrompt: '',
      options: {},
      modifiedFiles: ['data.txt'],
      resolvedFiles: [{ mentioned: 'data.txt', actual: 'data.txt' }],
      fileContextMap: new Map(),
      ollamaStreamId: 'stream-5'
    });

    // Non-code files pass syntax check → null
    expect(result).toBeNull();

    // Clean up
    db.setConfig('error_feedback_enabled', '0');
  });
});
