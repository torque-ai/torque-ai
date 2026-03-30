/**
 * Unit Tests: utils/context-enrichment.js
 *
 * Tests the 5 harness improvements:
 * 1. Import/type dependency traversal
 * 2. Test file auto-inclusion
 * 3. Recent git context injection
 * 4. Few-shot example retrieval
 * 5. Error-feedback prompt building
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  extractImportPaths,
  resolveImportToFile,
  extractTypeSignatures,
  walkImportsForTypes,
  buildImportContext,
  findRelatedTestFiles,
  extractTestSummary,
  buildTestContext,
  buildGitContext,
  buildFewShotContext,
  buildErrorFeedbackPrompt,
  buildHashlineErrorFeedbackPrompt,
  enrichResolvedContext,
    MAX_IMPORT_FILES,
} = require('../utils/context-enrichment');
const { computeLineHash } = require('../handlers/hashline-handlers');

let testDir;

beforeAll(() => {
  testDir = path.join(os.tmpdir(), `torque-vtest-enrichment-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── 1. Import/Type Dependency Traversal ────────────────────────────────────

describe('extractImportPaths', () => {
  it('extracts ES import paths', () => {
    const content = `import { Foo } from './utils/foo';\nimport Bar from '../bar';`;
    const result = extractImportPaths(content, '.ts');
    expect(result).toContain('./utils/foo');
    expect(result).toContain('../bar');
  });

  it('extracts CJS require paths', () => {
    const content = `const foo = require('./foo');\nconst bar = require('../bar');`;
    const result = extractImportPaths(content, '.js');
    expect(result).toContain('./foo');
    expect(result).toContain('../bar');
  });

  it('ignores non-relative imports', () => {
    const content = `import React from 'react';\nimport { z } from 'zod';`;
    const result = extractImportPaths(content, '.ts');
    expect(result).toHaveLength(0);
  });

  it('extracts Python imports', () => {
    const content = `from models.user import User\nimport utils.helpers`;
    const result = extractImportPaths(content, '.py');
    expect(result).toContain('models.user');
    expect(result).toContain('utils.helpers');
  });

  it('extracts C# using statements', () => {
    const content = `using System.Collections.Generic;\nusing MyApp.Models;`;
    const result = extractImportPaths(content, '.cs');
    expect(result).toContain('System.Collections.Generic');
    expect(result).toContain('MyApp.Models');
  });

  it('returns empty for null/empty', () => {
    expect(extractImportPaths(null, '.ts')).toEqual([]);
    expect(extractImportPaths('', '.ts')).toEqual([]);
  });

  it('extracts re-exports', () => {
    const content = `export { Thing } from './thing';`;
    const result = extractImportPaths(content, '.ts');
    expect(result).toContain('./thing');
  });
});

describe('resolveImportToFile', () => {
  it('resolves relative import with extension', () => {
    const srcDir = path.join(testDir, 'resolve-test');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'helper.ts'), 'export const x = 1;');

    const result = resolveImportToFile('./helper', srcDir, testDir);
    expect(result).toBe(path.join(srcDir, 'helper.ts'));
  });

  it('resolves index file', () => {
    const srcDir = path.join(testDir, 'resolve-index');
    const subDir = path.join(srcDir, 'utils');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'index.ts'), 'export default {};');

    const result = resolveImportToFile('./utils', srcDir, testDir);
    expect(result).toBe(path.join(subDir, 'index.ts'));
  });

  it('returns null for non-existent', () => {
    expect(resolveImportToFile('./nonexistent', testDir, testDir)).toBeNull();
  });

  it('returns null for non-relative', () => {
    expect(resolveImportToFile('react', testDir, testDir)).toBeNull();
  });
});

describe('extractTypeSignatures', () => {
  it('extracts exported interfaces', () => {
    const filePath = path.join(testDir, 'types.ts');
    fs.writeFileSync(filePath, `
export interface User {
  id: number;
  name: string;
}

export interface Config {
  timeout: number;
}

const x = 1;
`);

    const result = extractTypeSignatures(filePath);
    expect(result).toContain('export interface User');
    expect(result).toContain('id: number');
    expect(result).toContain('export interface Config');
    expect(result).not.toContain('const x = 1');
  });

  it('extracts exported types and enums', () => {
    const filePath = path.join(testDir, 'types2.ts');
    fs.writeFileSync(filePath, `
export type Status = 'active' | 'inactive';

export enum Color {
  Red = 'red',
  Blue = 'blue',
}
`);

    const result = extractTypeSignatures(filePath);
    expect(result).toContain('export type Status');
    expect(result).toContain('export enum Color');
  });

  it('extracts exported classes', () => {
    const filePath = path.join(testDir, 'class.ts');
    fs.writeFileSync(filePath, `
export class UserService {
  getUser(id: number): User { return null; }
}
`);

    const result = extractTypeSignatures(filePath);
    expect(result).toContain('export class UserService');
  });

  it('returns empty for file with no exports', () => {
    const filePath = path.join(testDir, 'no-exports.ts');
    fs.writeFileSync(filePath, `const x = 1;\nconst y = 2;\n`);

    expect(extractTypeSignatures(filePath)).toBe('');
  });

  it('returns empty for nonexistent file', () => {
    expect(extractTypeSignatures(path.join(testDir, 'nonexistent.ts'))).toBe('');
  });

  it('truncates overly large blocks', () => {
    const filePath = path.join(testDir, 'big-interface.ts');
    const lines = ['export interface BigThing {'];
    for (let i = 0; i < 50; i++) {
      lines.push(`  field${i}: string;`);
    }
    lines.push('}');
    fs.writeFileSync(filePath, lines.join('\n'));

    const result = extractTypeSignatures(filePath);
    expect(result).toContain('[truncated]');
  });
});

describe('walkImportsForTypes', () => {
  it('collects signatures from imported files', () => {
    const projDir = path.join(testDir, 'walk-imports');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'main.ts'), `
import { User } from './types';
const u: User = { id: 1, name: 'test' };
`);
    fs.writeFileSync(path.join(projDir, 'types.ts'), `
export interface User {
  id: number;
  name: string;
}
`);

    const results = walkImportsForTypes(path.join(projDir, 'main.ts'), projDir);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].signatures).toContain('export interface User');
  });

  it('respects MAX_IMPORT_DEPTH', () => {
    const projDir = path.join(testDir, 'deep-imports');
    fs.mkdirSync(projDir, { recursive: true });

    // Create a 3-level chain: main → a → b → c
    fs.writeFileSync(path.join(projDir, 'main.ts'), `import { A } from './a';`);
    fs.writeFileSync(path.join(projDir, 'a.ts'), `import { B } from './b';\nexport interface A { x: number; }`);
    fs.writeFileSync(path.join(projDir, 'b.ts'), `import { C } from './c';\nexport interface B { y: number; }`);
    fs.writeFileSync(path.join(projDir, 'c.ts'), `export interface C { z: number; }`);

    const results = walkImportsForTypes(path.join(projDir, 'main.ts'), projDir);
    const files = results.map(r => r.file);
    // Should get a.ts and b.ts (depth 0 and 1), possibly c.ts at depth 2
    expect(files).toContain('a.ts');
    expect(files).toContain('b.ts');
  });

  it('avoids circular imports', () => {
    const projDir = path.join(testDir, 'circular-imports');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'a.ts'), `import { B } from './b';\nexport interface A { x: number; }`);
    fs.writeFileSync(path.join(projDir, 'b.ts'), `import { A } from './a';\nexport interface B { y: number; }`);

    // Should not infinite loop
    const results = walkImportsForTypes(path.join(projDir, 'a.ts'), projDir);
    expect(results.length).toBeLessThanOrEqual(MAX_IMPORT_FILES);
  });

  it('returns empty for file with no imports', () => {
    const projDir = path.join(testDir, 'no-imports');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'standalone.ts'), `const x = 1;`);

    const results = walkImportsForTypes(path.join(projDir, 'standalone.ts'), projDir);
    expect(results).toHaveLength(0);
  });
});

describe('buildImportContext', () => {
  it('builds formatted import context', () => {
    const projDir = path.join(testDir, 'build-import-ctx');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'main.ts'), `import { Config } from './config';`);
    fs.writeFileSync(path.join(projDir, 'config.ts'), `export interface Config { timeout: number; }`);

    const result = buildImportContext([{ actual: 'main.ts' }], projDir);
    expect(result).toContain('IMPORTED TYPE SIGNATURES');
    expect(result).toContain('export interface Config');
  });

  it('returns empty when no imports found', () => {
    const projDir = path.join(testDir, 'no-import-ctx');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'standalone.ts'), `const x = 1;`);

    expect(buildImportContext([{ actual: 'standalone.ts' }], projDir)).toBe('');
  });

  it('returns empty for empty files list', () => {
    expect(buildImportContext([], testDir)).toBe('');
    expect(buildImportContext(null, testDir)).toBe('');
  });
});

// ─── 2. Test File Auto-Inclusion ────────────────────────────────────────

describe('findRelatedTestFiles', () => {
  it('finds .test.ts file in same directory', () => {
    const projDir = path.join(testDir, 'test-find');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'utils.ts'), 'export function add(a, b) { return a + b; }');
    fs.writeFileSync(path.join(projDir, 'utils.test.ts'), `
describe('add', () => {
  it('adds two numbers', () => {
    expect(add(1, 2)).toBe(3);
  });
});
`);

    const result = findRelatedTestFiles([{ actual: 'utils.ts' }], projDir);
    expect(result).toHaveLength(1);
    expect(result[0].testFile).toBe('utils.test.ts');
    expect(result[0].content).toContain('adds two numbers');
  });

  it('finds test in __tests__ subdirectory', () => {
    const projDir = path.join(testDir, 'test-find-subdir');
    const testsDir = path.join(projDir, '__tests__');
    fs.mkdirSync(testsDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'helper.ts'), 'export function foo() {}');
    fs.writeFileSync(path.join(testsDir, 'helper.test.ts'), `
it('works', () => { expect(true).toBe(true); });
`);

    const result = findRelatedTestFiles([{ actual: 'helper.ts' }], projDir);
    expect(result).toHaveLength(1);
  });

  it('returns empty when no test file found', () => {
    const projDir = path.join(testDir, 'no-test');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'orphan.ts'), 'const x = 1;');

    const result = findRelatedTestFiles([{ actual: 'orphan.ts' }], projDir);
    expect(result).toHaveLength(0);
  });
});

describe('extractTestSummary', () => {
  it('extracts describe/it names and expects', () => {
    const content = `
describe('MyService', () => {
  it('should create', () => {
    expect(service).toBeTruthy();
  });
  it('should process', () => {
    expect(service.process()).toBe(true);
  });
});
`;
    const result = extractTestSummary(content);
    expect(result).toContain("describe('MyService'");
    expect(result).toContain("it('should create'");
    expect(result).toContain("it('should process'");
    expect(result).toContain('expect(service)');
  });

  it('returns empty for null/empty', () => {
    expect(extractTestSummary(null)).toBe('');
    expect(extractTestSummary('')).toBe('');
  });
});

describe('buildTestContext', () => {
  it('builds formatted test context', () => {
    const projDir = path.join(testDir, 'build-test-ctx');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'app.ts'), 'export class App {}');
    fs.writeFileSync(path.join(projDir, 'app.test.ts'), `
describe('App', () => {
  it('initializes', () => {
    expect(new App()).toBeTruthy();
  });
});
`);

    const result = buildTestContext([{ actual: 'app.ts' }], projDir);
    expect(result).toContain('RELATED TEST FILES');
    expect(result).toContain('initializes');
  });
});

// ─── 3. Git Context ────────────────────────────────────────────────────

describe('buildGitContext', () => {
  it('returns empty for non-git directory', () => {
    const nonGitDir = path.join(testDir, 'not-a-repo');
    fs.mkdirSync(nonGitDir, { recursive: true });

    expect(buildGitContext(nonGitDir, [])).toBe('');
  });

  it('returns git context for a real git repo', () => {
    // Reload context-enrichment with real git — the module captures execFileSync
    // at require time, so we must restore + reload for actual git output.
    const cp = require('child_process');
    const patched = cp.execFileSync;
    cp.execFileSync = cp._realExecFileSync || patched;
    try {
      delete require.cache[require.resolve('../utils/context-enrichment')];
      const { buildGitContext: realBuildGitContext } = require('../utils/context-enrichment');
      const torqueDir = path.resolve(__dirname, '..');
      const result = realBuildGitContext(torqueDir, [{ actual: 'task-manager.js' }]);
      expect(result).toContain('RECENT GIT CONTEXT');
      expect(result).toContain('Recent commits');
    } finally {
      cp.execFileSync = patched;
      delete require.cache[require.resolve('../utils/context-enrichment')];
    }
  });

  it('returns empty for null working dir', () => {
    expect(buildGitContext(null, [])).toBe('');
  });
});

// ─── 4. Few-Shot Example Retrieval ──────────────────────────────────────

describe('buildFewShotContext', () => {
  it('returns empty for null description', () => {
    expect(buildFewShotContext(null, null)).toBe('');
    expect(buildFewShotContext('', null)).toBe('');
  });

  it('returns empty for null db', () => {
    expect(buildFewShotContext('fix the bug', null)).toBe('');
  });

  // DB-dependent tests require a real database — tested via integration
});

// ─── 5. Error-Feedback Prompt ──────────────────────────────────────────

describe('buildErrorFeedbackPrompt', () => {
  it('includes original description and errors', () => {
    const result = buildErrorFeedbackPrompt(
      'Fix type errors in utils.ts',
      'const x: number = "hello";',
      'Line 1: TS2322 — Type string is not assignable to type number'
    );
    expect(result).toContain('Fix type errors in utils.ts');
    expect(result).toContain('PREVIOUS ATTEMPT PRODUCED ERRORS');
    expect(result).toContain('TS2322');
  });

  it('truncates long original output', () => {
    const longOutput = 'x'.repeat(5000);
    const result = buildErrorFeedbackPrompt('fix it', longOutput, 'error');
    expect(result.length).toBeLessThan(5000);
  });

  it('returns raw description when no errors', () => {
    const result = buildErrorFeedbackPrompt('just do it', 'output', null);
    expect(result).toBe('just do it');
  });
});

// ─── 6. Hashline Error-Feedback Prompt ──────────────────────────────────

describe('buildHashlineErrorFeedbackPrompt', () => {
  it('returns prompt with re-annotated file content', () => {
    const projDir = path.join(testDir, 'hashline-feedback-1');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'code.js'), 'const x = 1;\nconst y = 2;\n');

    const result = buildHashlineErrorFeedbackPrompt(
      projDir, ['code.js'], ['code.js: Syntax error'], 'hashline'
    );
    expect(result).toContain('L001:');
    expect(result).toContain('L002:');
    expect(result).toContain('### FILE: code.js');
    expect(result).toContain('Syntax error');
    expect(result).toContain('FIX THE FOLLOWING ERRORS');
  });

  it('includes line hashes that match computeLineHash output', () => {
    const projDir = path.join(testDir, 'hashline-feedback-hashes');
    fs.mkdirSync(projDir, { recursive: true });

    const line = 'export function add(a, b) { return a + b; }';
    fs.writeFileSync(path.join(projDir, 'math.ts'), line + '\n');

    const result = buildHashlineErrorFeedbackPrompt(
      projDir, ['math.ts'], ['TS error'], 'hashline'
    );
    const expectedHash = computeLineHash(line);
    expect(result).toContain(`L001:${expectedHash}:`);
  });

  it('includes error messages in output', () => {
    const projDir = path.join(testDir, 'hashline-feedback-errors');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'test.ts'), 'const x = 1;\n');

    const errors = [
      'test.ts: TS2322 at L1:5 — Type mismatch',
      'test.ts: TS1005 at L2:1 — Expected semicolon'
    ];
    const result = buildHashlineErrorFeedbackPrompt(projDir, ['test.ts'], errors, 'hashline');
    expect(result).toContain('TS2322');
    expect(result).toContain('TS1005');
    expect(result).toContain('Type mismatch');
    expect(result).toContain('Expected semicolon');
  });
});

// ─── Orchestrator ───────────────────────────────────────────────────────

describe('enrichResolvedContext', () => {
  it('returns empty when all features disabled', () => {
    const result = enrichResolvedContext(
      [{ actual: 'test.ts' }], testDir, 'task', null,
      { enableImports: false, enableTests: false, enableGit: false, enableFewShot: false }
    );
    expect(result).toBe('');
  });

  it('survives errors gracefully', () => {
    // Pass a nonexistent working dir — should not throw
    const result = enrichResolvedContext(
      [{ actual: 'nonexistent.ts' }], '/nonexistent/path', 'task', null
    );
    // Should return without crashing (may have git context error)
    expect(typeof result).toBe('string');
  });

  it('combines multiple enrichments', () => {
    const projDir = path.join(testDir, 'enrich-combo');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(path.join(projDir, 'main.ts'), `
import { Config } from './config';
export function run(c: Config) {}
`);
    fs.writeFileSync(path.join(projDir, 'config.ts'), `
export interface Config {
  timeout: number;
}
`);
    fs.writeFileSync(path.join(projDir, 'main.test.ts'), `
describe('run', () => {
  it('runs with config', () => { expect(true).toBe(true); });
});
`);

    const result = enrichResolvedContext(
      [{ actual: 'main.ts' }], projDir, 'fix run function',
      null, // no db for few-shot
      { enableImports: true, enableTests: true, enableGit: false, enableFewShot: false }
    );

    expect(result).toContain('IMPORTED TYPE SIGNATURES');
    expect(result).toContain('export interface Config');
    expect(result).toContain('RELATED TEST FILES');
    expect(result).toContain('runs with config');
  });
});
