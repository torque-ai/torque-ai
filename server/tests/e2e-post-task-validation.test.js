/**
 * E2E Test: Post-Task Validation Safeguards
 *
 * Tests the validation pipeline that runs after task completion:
 * - File quality checks (stub detection, empty methods)
 * - Conversational refusal detection
 * - No-file-change detection
 * - LLM safeguard checks
 */


const path = require('path');
const fs = require('fs');
const { setupE2eDb, teardownE2eDb } = require('./e2e-helpers');
const { checkFileQuality } = require('../validation/post-task');
const { CONVERSATIONAL_REFUSAL_PATTERN } = require('../task-manager');

let ctx;

describe('E2E: Post-task validation safeguards', () => {
  beforeEach(async () => {
    if (ctx) await teardownE2eDb(ctx);
    ctx = setupE2eDb('post-task-validation');
  });

  afterAll(async () => {
    if (ctx) await teardownE2eDb(ctx);
  });

  it('checkFileQuality detects stub files', () => {
    // Create a stub file
    const filePath = path.join(ctx.testDir, 'stub.ts');
    fs.writeFileSync(filePath, `
export class MyService {
  // TODO: implement
  getData() {
    throw new Error('Not implemented');
  }
}
`.trim());

    const result = checkFileQuality(filePath);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('placeholder/stub content'),
    ]));
  });

  it('checkFileQuality passes valid code', () => {
    const filePath = path.join(ctx.testDir, 'valid.ts');
    fs.writeFileSync(filePath, `
export function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

export function fibonacci(n: number): number {
  if (n <= 1) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    const temp = a + b;
    a = b;
    b = temp;
  }
  return b;
}
`.trim());

    const result = checkFileQuality(filePath);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('detects conversational refusal patterns in LLM output', () => {
    const refusalOutputs = [
      "I'm ready to help you! Please share the files you'd like me to modify.",
      "Could you provide more information about what you need?",
      "Which files you want me to change?",
    ];

    const validOutputs = [
      "Here are the changes I made to hello.js",
      "Applied diff to src/main.ts",
      "Modified 3 files successfully",
    ];

    for (const output of refusalOutputs) {
      expect(CONVERSATIONAL_REFUSAL_PATTERN.test(output)).toBe(true);
    }

    for (const output of validOutputs) {
      expect(CONVERSATIONAL_REFUSAL_PATTERN.test(output)).toBe(false);
    }
  });

  it('detects truncation patterns in LLM output', () => {
    const truncatedOutputs = [
      "function hello() {\n  // ... rest of implementation\n}",
      "export class MyClass {\n  // [truncated for brevity]\n}",
      "const data = [\n  // ... remaining items ...\n];",
    ];

    for (const [index, output] of truncatedOutputs.entries()) {
      const filePath = path.join(ctx.testDir, `truncated-${index}.ts`);
      fs.writeFileSync(filePath, output);

      const result = checkFileQuality(filePath, { isNewFile: true });
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.stringContaining('placeholder/stub content'),
      ]));
    }
  });

  it('baseline comparison detects significant file size decrease', () => {
    const relativePath = 'shrink.ts';
    const filePath = path.join(ctx.testDir, relativePath);

    // Original content: substantial
    const originalContent = Array(100).fill('export const line = "data";').join('\n');
    fs.writeFileSync(filePath, originalContent);

    ctx.db.captureFileBaseline(relativePath, ctx.testDir);

    // Simulate shrunk content
    const shrunkContent = 'export const line = "data";';
    fs.writeFileSync(filePath, shrunkContent);

    const comparison = ctx.db.compareFileToBaseline(relativePath, ctx.testDir);
    expect(comparison.hasBaseline).toBe(true);
    expect(comparison.isSignificantlyShrunk).toBe(true);
    expect(comparison.sizeChangePercent).toBeLessThan(-50);
    expect(comparison.lineDelta).toBeLessThan(0);
  });
});
