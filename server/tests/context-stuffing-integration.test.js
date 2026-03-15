/**
 * Integration Tests: Context Stuffing Pipeline
 *
 * Tests resolveContextFiles (smart-scan.js) and enrichTaskDescription (execute-api.js)
 * as integration points for the context-stuffing feature.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

let testDir;

function tmpFile(relPath, content) {
  const abs = path.join(testDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `torque-ctx-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── resolveContextFiles ─────────────────────────────────────────────────

describe('resolveContextFiles', () => {
  let resolveContextFiles;

  beforeEach(() => {
    ({ resolveContextFiles } = require('../utils/smart-scan'));
  });

  it('resolves files from explicit list and discovers imports via smartScan', () => {
    // Create a source file that imports another file
    const depFile = tmpFile('src/helper.js', 'module.exports = { add: (a,b) => a+b };');
    const mainFile = tmpFile('src/index.js', "const { add } = require('./helper');\nconsole.log(add(1, 2));\n");

    const result = resolveContextFiles({
      taskDescription: 'Fix the add function',
      workingDirectory: testDir,
      files: [mainFile],
      contextDepth: 1,
    });

    // Should include the explicit file
    expect(result.contextFiles).toContain(path.resolve(mainFile));
    // Should also discover the imported helper
    expect(result.contextFiles).toContain(path.resolve(depFile));
    // Reasons should be populated
    expect(result.reasons.size).toBeGreaterThanOrEqual(2);
  });

  it('returns empty when no files detected', () => {
    const result = resolveContextFiles({
      taskDescription: 'Do something abstract',
      workingDirectory: testDir,
      files: [],
      contextDepth: 1,
    });

    expect(result.contextFiles).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.reasons.size).toBe(0);
  });

  it('works with only explicit files (no task description)', () => {
    const file = tmpFile('lib/utils.js', 'module.exports = 42;');

    const result = resolveContextFiles({
      files: [file],
      workingDirectory: testDir,
    });

    expect(result.contextFiles).toContain(path.resolve(file));
  });

  it('deduplicates files found via description and explicit list', () => {
    const file = tmpFile('src/main.js', 'const x = 1;\n');

    const result = resolveContextFiles({
      taskDescription: 'Fix src/main.js',
      workingDirectory: testDir,
      files: [file],
      contextDepth: 1,
    });

    // Should not contain duplicates
    const uniquePaths = new Set(result.contextFiles.map(f => path.resolve(f)));
    expect(result.contextFiles.length).toBe(uniquePaths.size);
  });

  it('discovers convention-matched test files', () => {
    const srcFile = tmpFile('src/calculator.js', 'module.exports = { add: (a,b) => a+b };');
    tmpFile('src/calculator.test.js', "const calc = require('./calculator');\ntest('add', () => {});");

    const result = resolveContextFiles({
      files: [srcFile],
      workingDirectory: testDir,
      contextDepth: 1,
    });

    // Convention matching should find the .test.js file
    const filenames = result.contextFiles.map(f => path.basename(f));
    expect(filenames).toContain('calculator.test.js');
  });
});

// ─── enrichTaskDescription ───────────────────────────────────────────────

describe('enrichTaskDescription', () => {
  let enrichTaskDescription;

  beforeEach(() => {
    ({ enrichTaskDescription } = require('../providers/execute-api'));
  });

  it('enriches description when context_files present in metadata', async () => {
    const filePath = tmpFile('src/widget.js', 'export function render() { return "<div>"; }\n');

    const task = {
      task_description: 'Fix the render function',
      provider: 'groq',
      working_directory: testDir,
      metadata: JSON.stringify({
        context_files: [filePath],
      }),
    };

    const result = await enrichTaskDescription(task);

    // Should contain the file content
    expect(result).toContain('export function render()');
    // Should contain the original description
    expect(result).toContain('Fix the render function');
    // Should have the project context header
    expect(result).toContain('### Project Context');
    // Should have the task section
    expect(result).toContain('### Task');
  });

  it('returns original description when no context_files in metadata', async () => {
    const task = {
      task_description: 'Do something',
      provider: 'groq',
      working_directory: testDir,
      metadata: JSON.stringify({}),
    };

    const result = await enrichTaskDescription(task);
    expect(result).toBe('Do something');
  });

  it('returns original description when context_stuff is false in metadata', async () => {
    const filePath = tmpFile('src/app.js', 'console.log("hello");');

    const task = {
      task_description: 'Fix the app',
      provider: 'groq',
      working_directory: testDir,
      metadata: JSON.stringify({
        context_stuff: false,
        context_files: [filePath],
      }),
    };

    const result = await enrichTaskDescription(task);
    expect(result).toBe('Fix the app');
  });

  it('returns original description when provider does not support context stuffing', async () => {
    const filePath = tmpFile('src/code.js', 'const x = 1;\n');

    const task = {
      task_description: 'Fix the code',
      provider: 'codex', // not a context-stuffing provider
      working_directory: testDir,
      metadata: JSON.stringify({
        context_files: [filePath],
      }),
    };

    const result = await enrichTaskDescription(task);
    expect(result).toBe('Fix the code');
  });

  it('returns original description when metadata is invalid JSON', async () => {
    const task = {
      task_description: 'Some task',
      provider: 'groq',
      metadata: 'not-valid-json{{{',
    };

    const result = await enrichTaskDescription(task);
    expect(result).toBe('Some task');
  });

  it('returns original description when metadata is null', async () => {
    const task = {
      task_description: 'Some task',
      provider: 'groq',
      metadata: null,
    };

    const result = await enrichTaskDescription(task);
    expect(result).toBe('Some task');
  });

  it('returns original description when context_files is empty array', async () => {
    const task = {
      task_description: 'Some task',
      provider: 'groq',
      metadata: JSON.stringify({ context_files: [] }),
    };

    const result = await enrichTaskDescription(task);
    expect(result).toBe('Some task');
  });

  it('handles metadata as already-parsed object', async () => {
    const filePath = tmpFile('src/data.js', 'module.exports = { x: 1 };\n');

    const task = {
      task_description: 'Fix data module',
      provider: 'groq',
      working_directory: testDir,
      metadata: {
        context_files: [filePath],
      },
    };

    const result = await enrichTaskDescription(task);
    expect(result).toContain('module.exports = { x: 1 }');
    expect(result).toContain('Fix data module');
  });

  it('rejects over-budget context with actionable error', async () => {
    // ~100K tokens at 4 chars/token = 400KB — exceeds groq's 96K budget
    const bigFile = tmpFile('src/huge.js', 'x'.repeat(400 * 1024));

    const task = {
      task_description: 'Review',
      provider: 'groq',
      working_directory: testDir,
      metadata: JSON.stringify({ context_files: [bigFile] }),
    };

    await expect(enrichTaskDescription(task)).rejects.toThrow(/context too large/i);
  });

  it('respects custom context_budget in metadata', async () => {
    // Create a file that's small enough for normal budget but exceeds custom budget of 1 token
    const filePath = tmpFile('src/small.js', 'const x = 1;\n');

    const task = {
      task_description: 'Fix it',
      provider: 'groq',
      working_directory: testDir,
      metadata: JSON.stringify({
        context_files: [filePath],
        context_budget: 1, // ridiculously low
      }),
    };

    // Should throw because the token count exceeds the 1-token budget
    await expect(enrichTaskDescription(task)).rejects.toThrow(/context too large/i);
  });
});

// ─── End-to-End: Submission + Execution ─────────────────────────────────

describe('end-to-end: submission scan → execution stuffing', () => {
  it('smart-scan at submit → stuffContext at execute produces enriched prompt', async () => {
    // Setup: files that import each other
    const utils = tmpFile('src/utils.js', 'function helper() { return 1; }\nmodule.exports = { helper };');
    tmpFile('src/utils.test.js', "const { helper } = require('./utils');\ntest('works', () => expect(helper()).toBe(1));");
    const main = tmpFile('src/main.js', "const { helper } = require('./utils');\nconsole.log(helper());");

    // Phase 1: submission-time scan (normally in integration-routing.js)
    const { resolveContextFiles } = require('../utils/smart-scan');
    const scanResult = resolveContextFiles({
      taskDescription: `Review src/main.js for bugs`,
      workingDirectory: testDir,
      files: [main],
      contextDepth: 1,
    });

    expect(scanResult.contextFiles).toContain(path.resolve(main));
    expect(scanResult.contextFiles).toContain(path.resolve(utils));

    // Phase 2: execution-time stuffing (normally in execute-api.js)
    const { enrichTaskDescription } = require('../providers/execute-api');
    const task = {
      task_description: `Review src/main.js for bugs`,
      provider: 'groq',
      working_directory: testDir,
      metadata: JSON.stringify({
        context_files: scanResult.contextFiles,
        context_scan_reasons: Object.fromEntries(scanResult.reasons),
      }),
    };

    const enriched = await enrichTaskDescription(task);

    // Enriched description should contain file contents from both files
    expect(enriched).toContain('function helper()');
    expect(enriched).toContain("require('./utils')");
    expect(enriched).toContain('console.log(helper())');
    // Should have structure
    expect(enriched).toContain('### Project Context');
    expect(enriched).toContain('### Task');
    expect(enriched).toContain('Review src/main.js for bugs');
  });
});
