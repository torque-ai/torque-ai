/**
 * Code Analysis Module Tests
 *
 * Unit tests for code-analysis.js — complexity analysis, dead code detection,
 * documentation coverage, resource estimation, i18n, accessibility,
 * type verification, and build error analysis.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

let testDir;
let origDataDir;
let db;
let codeAnalysis;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-code-analysis-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);

  codeAnalysis = require('../db/code-analysis');
  codeAnalysis.setDb(db.getDbInstance());
  return db;
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

function createTask(overrides = {}) {
  const id = overrides.id || uuidv4();
  db.createTask({
    id,
    task_description: 'test task',
    provider: 'ollama',
    status: 'completed',
    ...overrides,
  });
  return id;
}

function rawDb() {
  return db.getDbInstance();
}

function clearTable(tableName) {
  rawDb().prepare(`DELETE FROM ${tableName}`).run();
}

describe('Code Analysis Module', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  // ===========================================
  // analyzeCodeComplexity
  // ===========================================
  describe('analyzeCodeComplexity', () => {
    let taskId;

    beforeEach(() => {
      clearTable('complexity_metrics');
      taskId = createTask();
    });

    test('calculates cyclomatic complexity from decision patterns', () => {
      const code = `
        function foo(x) {
          if (x > 0) {
            while (x > 1) {
              x--;
            }
          } else {
            for (let i = 0; i < x; i++) {}
          }
        }
      `;
      const result = codeAnalysis.analyzeCodeComplexity(taskId, 'test.js', code);
      // Base 1 + if + while + else + for = 5
      expect(result.cyclomatic_complexity).toBe(5);
    });

    test('calculates max nesting depth from braces', () => {
      const code = `function a() { if (true) { for (;;) { while (true) { } } } }`;
      const result = codeAnalysis.analyzeCodeComplexity(taskId, 'test.js', code);
      // function { if { for { while { } } } } => depth 4
      expect(result.max_nesting_depth).toBe(4);
    });

    test('counts functions with multiple patterns', () => {
      const code = `
        function named(a) {}
        const arrow = (b) => {};
        const func = function(c) {};
        class X { method(d) {} }
      `;
      const result = codeAnalysis.analyzeCodeComplexity(taskId, 'test.js', code);
      expect(result.function_count).toBeGreaterThanOrEqual(3);
    });

    test('counts non-empty lines of code', () => {
      const code = 'line1\n\nline3\n   \nline5\n';
      const result = codeAnalysis.analyzeCodeComplexity(taskId, 'test.js', code);
      // line1, line3, line5 are non-empty after trim; empty string and whitespace-only are excluded
      expect(result.lines_of_code).toBe(3);
    });

    test('returns maintainability_index between 0 and 100', () => {
      const code = 'const x = 1;\n';
      const result = codeAnalysis.analyzeCodeComplexity(taskId, 'test.js', code);
      expect(result.maintainability_index).toBeGreaterThanOrEqual(0);
      expect(result.maintainability_index).toBeLessThanOrEqual(100);
    });

    test('returns correct file_path in result', () => {
      const result = codeAnalysis.analyzeCodeComplexity(taskId, 'src/utils.ts', 'const a = 1;');
      expect(result.file_path).toBe('src/utils.ts');
    });

    test('persists metrics to database', () => {
      codeAnalysis.analyzeCodeComplexity(taskId, 'test.js', 'if (true) { if (false) {} }');
      const rows = codeAnalysis.getComplexityMetrics(taskId);
      expect(rows.length).toBe(1);
      expect(rows[0].task_id).toBe(taskId);
      expect(rows[0].file_path).toBe('test.js');
      expect(rows[0].cyclomatic_complexity).toBeGreaterThan(1);
    });

    test('detects ternary, && and || operators', () => {
      const code = 'const a = x ? y : z; const b = a && b || c;';
      const result = codeAnalysis.analyzeCodeComplexity(taskId, 'test.js', code);
      // Base 1 + ternary(1) + &&(1) + ||(1) = 4
      expect(result.cyclomatic_complexity).toBe(4);
    });

    test('counts case and catch statements', () => {
      const code = `
        switch(x) { case 1: break; case 2: break; }
        try {} catch (e) {}
      `;
      const result = codeAnalysis.analyzeCodeComplexity(taskId, 'test.js', code);
      // Base 1 + case(2) + catch(1) = 4
      expect(result.cyclomatic_complexity).toBe(4);
    });

    test('low-complexity code gets high maintainability index', () => {
      const simple = 'const x = 1;\n';
      const complex = Array(200).fill('if (x) { if (y) { while (true) {} } }').join('\n');
      const simpleResult = codeAnalysis.analyzeCodeComplexity(createTask(), 'simple.js', simple);
      const complexResult = codeAnalysis.analyzeCodeComplexity(createTask(), 'complex.js', complex);
      expect(simpleResult.maintainability_index).toBeGreaterThan(complexResult.maintainability_index);
    });
  });

  // ===========================================
  // getComplexityMetrics
  // ===========================================
  describe('getComplexityMetrics', () => {
    test('returns empty array for unknown task', () => {
      const rows = codeAnalysis.getComplexityMetrics('nonexistent-id');
      expect(rows).toEqual([]);
    });
  });

  // ===========================================
  // detectDeadCode
  // ===========================================
  describe('detectDeadCode', () => {
    let taskId;

    beforeEach(() => {
      clearTable('dead_code_results');
      taskId = createTask();
    });

    test('detects unused named function', () => {
      const code = `
        function unusedHelper() { return 42; }
        function main() { console.log("hello"); }
      `;
      const results = codeAnalysis.detectDeadCode(taskId, 'test.js', code);
      const unused = results.find(r => r.identifier === 'unusedHelper');
      expect(unused).toBeDefined();
      expect(unused.type).toBe('unused_function');
      expect(unused.confidence).toBe(0.7);
    });

    test('detects unused variable', () => {
      const code = `const unusedVar = 42;\nconsole.log("no reference");`;
      const results = codeAnalysis.detectDeadCode(taskId, 'test.js', code);
      const unused = results.find(r => r.identifier === 'unusedVar');
      expect(unused).toBeDefined();
      expect(unused.type).toBe('unused_variable');
      expect(unused.confidence).toBe(0.6);
    });

    test('does not flag constructor or lifecycle methods', () => {
      const code = `function constructor() {} function render() {} function ngOnInit() {}`;
      const results = codeAnalysis.detectDeadCode(taskId, 'test.js', code);
      const flagged = results.filter(r => ['constructor', 'render', 'ngOnInit'].includes(r.identifier));
      expect(flagged.length).toBe(0);
    });

    test('does not flag functions called more than once', () => {
      const code = `
        function helper() { return 1; }
        const x = helper();
        const y = helper();
      `;
      const results = codeAnalysis.detectDeadCode(taskId, 'test.js', code);
      const flagged = results.find(r => r.identifier === 'helper');
      expect(flagged).toBeUndefined();
    });

    test('ignores single-character variable names', () => {
      const code = `const x = 1;`;
      const results = codeAnalysis.detectDeadCode(taskId, 'test.js', code);
      const flagged = results.find(r => r.identifier === 'x');
      expect(flagged).toBeUndefined();
    });

    test('persists dead code results to database', () => {
      codeAnalysis.detectDeadCode(taskId, 'test.js', 'function deadFn() { return 1; }');
      const rows = codeAnalysis.getDeadCodeResults(taskId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].task_id).toBe(taskId);
    });

    test('returns line numbers for detected items', () => {
      const code = `line1\nfunction orphan() { return 1; }\nline3`;
      const results = codeAnalysis.detectDeadCode(taskId, 'test.js', code);
      const orphan = results.find(r => r.identifier === 'orphan');
      if (orphan) {
        expect(orphan.line).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ===========================================
  // checkDocCoverage
  // ===========================================
  describe('checkDocCoverage', () => {
    let taskId;

    beforeEach(() => {
      clearTable('doc_coverage_results');
      taskId = createTask();
    });

    test('detects undocumented exported functions in JS/TS', () => {
      const code = `export function doSomething() {}\nexport const CONST_VAL = 1;`;
      const result = codeAnalysis.checkDocCoverage(taskId, 'test.ts', code);
      expect(result.total_public_items).toBe(2);
      expect(result.documented_items).toBe(0);
      expect(result.missing_docs).toContain('doSomething');
      expect(result.missing_docs).toContain('CONST_VAL');
    });

    test('recognizes JSDoc-documented exports', () => {
      const code = `/** Does stuff */\nexport function documented() {}`;
      const result = codeAnalysis.checkDocCoverage(taskId, 'test.ts', code);
      expect(result.documented_items).toBe(1);
      expect(result.missing_docs.length).toBe(0);
    });

    test('C# files use SOURCE_EXTENSIONS path (export pattern)', () => {
      // .cs is in SOURCE_EXTENSIONS, so it uses the export keyword path.
      // C# code without export keywords yields 0 public items.
      const code = `public class MyService {}\npublic void DoWork() {}`;
      const result = codeAnalysis.checkDocCoverage(taskId, 'test.cs', code);
      expect(result.total_public_items).toBe(0);
      expect(result.coverage_percent).toBe(100);
    });

    test('detects exported interfaces and types in TS', () => {
      const code = `export interface Config {}\nexport type Status = string;`;
      const result = codeAnalysis.checkDocCoverage(taskId, 'test.ts', code);
      expect(result.total_public_items).toBe(2);
      expect(result.missing_docs).toContain('Config');
      expect(result.missing_docs).toContain('Status');
    });

    test('detects exported async functions', () => {
      const code = `export async function fetchData() {}`;
      const result = codeAnalysis.checkDocCoverage(taskId, 'test.ts', code);
      expect(result.total_public_items).toBe(1);
      expect(result.missing_docs).toContain('fetchData');
    });

    test('Python files use SOURCE_EXTENSIONS path (export pattern)', () => {
      // .py is in SOURCE_EXTENSIONS, so it uses the export keyword path.
      // Python code without export keywords yields 0 public items.
      const code = `def public_func():\n    pass\ndef another():\n    pass`;
      const result = codeAnalysis.checkDocCoverage(taskId, 'test.py', code);
      expect(result.total_public_items).toBe(0);
      expect(result.coverage_percent).toBe(100);
    });

    test('returns 100% coverage for files with no public items', () => {
      const code = `const internal = 1;`;
      const result = codeAnalysis.checkDocCoverage(taskId, 'test.ts', code);
      expect(result.coverage_percent).toBe(100);
    });

    test('persists doc coverage to database', () => {
      codeAnalysis.checkDocCoverage(taskId, 'test.ts', 'export function x() {}');
      const rows = codeAnalysis.getDocCoverageResults(taskId);
      expect(rows.length).toBe(1);
      expect(rows[0].task_id).toBe(taskId);
    });

    test('returns non-source extension with 100% coverage', () => {
      const code = `Some plain text file content.`;
      const result = codeAnalysis.checkDocCoverage(taskId, 'test.txt', code);
      expect(result.coverage_percent).toBe(100);
      expect(result.total_public_items).toBe(0);
    });
  });

  // ===========================================
  // estimateResourceUsage
  // ===========================================
  describe('estimateResourceUsage', () => {
    let taskId;

    beforeEach(() => {
      clearTable('resource_estimates');
      taskId = createTask();
    });

    test('detects while(true) infinite loop risk', () => {
      const code = `while (true) { break; }`;
      const result = codeAnalysis.estimateResourceUsage(taskId, 'test.js', code);
      expect(result.risk_factors).toContain('potential_infinite_loop');
      expect(result.cpu_risk_score).toBeGreaterThanOrEqual(50);
    });

    test('detects for(;;) infinite loop risk', () => {
      const code = `for (;;) { break; }`;
      const result = codeAnalysis.estimateResourceUsage(taskId, 'test.js', code);
      expect(result.risk_factors).toContain('potential_infinite_loop');
    });

    test('detects large array allocation', () => {
      const code = `const arr = new Array(1000000);`;
      const result = codeAnalysis.estimateResourceUsage(taskId, 'test.js', code);
      expect(result.risk_factors).toContain('large_array_allocation');
      expect(result.estimated_memory_mb).toBeGreaterThan(50);
    });

    test('detects large buffer allocation', () => {
      const code = `const buf = Buffer.alloc(10000000);`;
      const result = codeAnalysis.estimateResourceUsage(taskId, 'test.js', code);
      expect(result.risk_factors).toContain('large_buffer_allocation');
    });

    test('detects blocking IO patterns', () => {
      const code = `const data = readFileSync('file.txt'); execSync('ls');`;
      const result = codeAnalysis.estimateResourceUsage(taskId, 'test.js', code);
      expect(result.risk_factors).toContain('blocking_io');
    });

    test('clean code reports no risk factors', () => {
      const code = `const x = 1;\nconst y = 2;\nconsole.log(x + y);`;
      const result = codeAnalysis.estimateResourceUsage(taskId, 'test.js', code);
      expect(result.risk_factors.length).toBe(0);
      expect(result.estimated_memory_mb).toBe(50);
      expect(result.cpu_risk_score).toBe(0);
    });

    test('persists resource estimates to database', () => {
      codeAnalysis.estimateResourceUsage(taskId, 'test.js', 'while (true) {}');
      const rows = codeAnalysis.getResourceEstimates(taskId);
      expect(rows.length).toBe(1);
      expect(rows[0].has_infinite_loop_risk).toBe(1);
    });
  });

  // ===========================================
  // checkI18n
  // ===========================================
  describe('checkI18n', () => {
    let taskId;

    beforeEach(() => {
      clearTable('i18n_results');
      taskId = createTask();
    });

    test('detects hardcoded strings in source extensions', () => {
      // String must be > 10 chars, start with uppercase, have 2+ lowercase words
      const code = `const msg = "Please enter your name here";`;
      const result = codeAnalysis.checkI18n(taskId, 'test.ts', code);
      expect(result.hardcoded_strings_count).toBeGreaterThanOrEqual(1);
    });

    test('ignores non-source file extensions', () => {
      const code = `Please enter your name here`;
      const result = codeAnalysis.checkI18n(taskId, 'test.txt', code);
      expect(result.hardcoded_strings_count).toBe(0);
    });

    test('ignores URLs', () => {
      const code = `const url = "https://example.com/some/path";`;
      const result = codeAnalysis.checkI18n(taskId, 'test.ts', code);
      // URLs should be filtered out (contain ://)
      const hasUrl = result.hardcoded_strings.some(s => s.text.includes('://'));
      expect(hasUrl).toBe(false);
    });

    test('persists i18n results to database', () => {
      codeAnalysis.checkI18n(taskId, 'test.ts', 'const x = 1;');
      const rows = codeAnalysis.getI18nResults(taskId);
      expect(rows.length).toBe(1);
      expect(rows[0].task_id).toBe(taskId);
    });

    test('limits returned hardcoded strings to 10', () => {
      // Generate many hardcoded strings
      const lines = [];
      for (let i = 0; i < 15; i++) {
        lines.push(`const msg${i} = "Welcome to the application now";`);
      }
      const result = codeAnalysis.checkI18n(taskId, 'test.ts', lines.join('\n'));
      expect(result.hardcoded_strings.length).toBeLessThanOrEqual(10);
    });
  });

  // ===========================================
  // checkAccessibility
  // ===========================================
  describe('checkAccessibility', () => {
    let taskId;

    beforeEach(() => {
      clearTable('a11y_results');
      taskId = createTask();
    });

    test('detects images missing alt attribute', () => {
      const code = `<img src="photo.jpg">`;
      const result = codeAnalysis.checkAccessibility(taskId, 'test.html', code);
      expect(result.violations_count).toBeGreaterThanOrEqual(1);
      const imgViolation = result.violations.find(v => v.rule === 'img-alt');
      expect(imgViolation).toBeDefined();
      expect(imgViolation.wcag).toBe('1.1.1');
    });

    test('no violation when img has alt', () => {
      const code = `<img src="photo.jpg" alt="A photo">`;
      const result = codeAnalysis.checkAccessibility(taskId, 'test.html', code);
      const imgViolation = result.violations.find(v => v.rule === 'img-alt');
      expect(imgViolation).toBeUndefined();
    });

    test('detects heading level skips', () => {
      const code = `<h1>Title</h1><h3>Subtitle</h3>`;
      const result = codeAnalysis.checkAccessibility(taskId, 'test.html', code);
      const headingViolation = result.violations.find(v => v.rule === 'heading-order');
      expect(headingViolation).toBeDefined();
      expect(headingViolation.message).toContain('h1');
      expect(headingViolation.message).toContain('h3');
    });

    test('no heading violation for sequential levels', () => {
      const code = `<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>`;
      const result = codeAnalysis.checkAccessibility(taskId, 'test.html', code);
      const headingViolation = result.violations.find(v => v.rule === 'heading-order');
      expect(headingViolation).toBeUndefined();
    });

    test('ignores non-UI file extensions', () => {
      const code = `<img src="photo.jpg">`;
      const result = codeAnalysis.checkAccessibility(taskId, 'test.py', code);
      expect(result.violations_count).toBe(0);
    });

    test('persists a11y results to database', () => {
      codeAnalysis.checkAccessibility(taskId, 'test.html', '<img src="x">');
      const rows = codeAnalysis.getAccessibilityResults(taskId);
      expect(rows.length).toBe(1);
      expect(rows[0].task_id).toBe(taskId);
      expect(rows[0].wcag_level).toBe('AA');
    });

    test('works with JSX/TSX extensions', () => {
      const code = `<img src="photo.jpg">`;
      const result = codeAnalysis.checkAccessibility(taskId, 'component.tsx', code);
      expect(result.violations_count).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================
  // verifyTypeReferences
  // ===========================================
  describe('verifyTypeReferences', () => {
    let taskId;
    let typeDir;

    beforeEach(() => {
      clearTable('type_verification_results');
      taskId = createTask();
      typeDir = path.join(testDir, `types-${Date.now()}`);
      fs.mkdirSync(typeDir, { recursive: true });
    });

    afterEach(() => {
      try { fs.rmSync(typeDir, { recursive: true, force: true }); } catch {}
    });

    test('finds type defined in working directory via extends', () => {
      // extends uses 'class' kind — no I-prefix doubling
      fs.writeFileSync(path.join(typeDir, 'base.cs'), 'class GameConfig {}');
      const code = `class Foo extends GameConfig {}`;
      const result = codeAnalysis.verifyTypeReferences(taskId, 'test.ts', code, typeDir);
      const found = result.results.find(r => r.type_name === 'GameConfig');
      expect(found).toBeDefined();
      expect(found.exists).toBe(true);
      expect(result.status).toBe('verified');
    });

    test('reports missing type when not in codebase', () => {
      // extends uses 'class' kind — searches for 'class PhantomType'
      const code = `class Bar extends PhantomType {}`;
      const result = codeAnalysis.verifyTypeReferences(taskId, 'test.ts', code, typeDir);
      const missing = result.results.find(r => r.type_name === 'PhantomType');
      expect(missing).toBeDefined();
      expect(missing.exists).toBe(false);
      expect(result.status).toBe('types_missing');
    });

    test('ignores framework types like IDisposable', () => {
      const code = `class Foo implements IDisposable {}`;
      const result = codeAnalysis.verifyTypeReferences(taskId, 'test.ts', code, typeDir);
      const disposable = result.results.find(r => r.type_name === 'IDisposable');
      expect(disposable).toBeUndefined();
    });

    test('handles extends keyword for class references', () => {
      fs.writeFileSync(path.join(typeDir, 'base.ts'), 'class BaseSystem {}');
      const code = `class MySystem extends BaseSystem {}`;
      const result = codeAnalysis.verifyTypeReferences(taskId, 'test.ts', code, typeDir);
      const base = result.results.find(r => r.type_name === 'BaseSystem');
      expect(base).toBeDefined();
      expect(base.type_kind).toBe('class');
      expect(base.exists).toBe(true);
    });

    test('persists verification results to database', () => {
      const code = `class X extends SomeClass {}`;
      codeAnalysis.verifyTypeReferences(taskId, 'test.ts', code, typeDir);
      const rows = codeAnalysis.getTypeVerificationResults(taskId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    test('returns counts for types checked and missing', () => {
      const code = `class A extends Missing1 {} class B implements IMissing2 {}`;
      const result = codeAnalysis.verifyTypeReferences(taskId, 'test.ts', code, typeDir);
      expect(result.types_checked).toBeGreaterThanOrEqual(2);
      expect(result.missing_types).toBeGreaterThanOrEqual(2);
    });

    test('works without working directory', () => {
      const code = `class X extends SomeType {}`;
      const result = codeAnalysis.verifyTypeReferences(taskId, 'test.ts', code, null);
      // Without working dir, types won't be found but function should not crash
      expect(result.types_checked).toBeGreaterThanOrEqual(1);
    });

    test('skips node_modules and .git directories', () => {
      // Create a matching file inside node_modules — should not be found
      const nmDir = path.join(typeDir, 'node_modules');
      fs.mkdirSync(nmDir, { recursive: true });
      fs.writeFileSync(path.join(nmDir, 'dep.ts'), 'class HiddenInNodeModules {}');
      const code = `class X extends HiddenInNodeModules {}`;
      const result = codeAnalysis.verifyTypeReferences(taskId, 'test.ts', code, typeDir);
      const hidden = result.results.find(r => r.type_name === 'HiddenInNodeModules');
      expect(hidden).toBeDefined();
      expect(hidden.exists).toBe(false);
    });
  });

  // ===========================================
  // analyzeBuildOutput
  // ===========================================
  describe('analyzeBuildOutput', () => {
    let taskId;

    beforeEach(() => {
      clearTable('build_error_analysis');
      taskId = createTask();
    });

    test('detects CS0246 missing type error', () => {
      const buildOutput = `error CS0246: The type or namespace 'MyWidget' could not be found`;
      const result = codeAnalysis.analyzeBuildOutput(taskId, buildOutput);
      expect(result.errors_found).toBe(1);
      expect(result.has_missing_types).toBe(true);
      expect(result.errors[0].error_type).toBe('missing_type');
      expect(result.errors[0].code).toBe('CS0246');
    });

    test('detects CS0104 ambiguous reference', () => {
      const buildOutput = `error CS0104: 'Timer' is an ambiguous reference between 'System.Timers.Timer' and 'System.Threading.Timer'`;
      const result = codeAnalysis.analyzeBuildOutput(taskId, buildOutput);
      expect(result.has_namespace_conflicts).toBe(true);
      expect(result.errors[0].error_type).toBe('namespace_conflict');
      expect(result.errors[0].suggestedFix).toContain('using');
    });

    test('detects CS0234 missing namespace member', () => {
      const buildOutput = `error CS0234: The type or namespace name 'Foo' does not exist in the namespace 'Bar'`;
      const result = codeAnalysis.analyzeBuildOutput(taskId, buildOutput);
      expect(result.errors_found).toBe(1);
      expect(result.errors[0].error_type).toBe('missing_namespace_member');
    });

    test('detects CS0103 undefined name', () => {
      const buildOutput = `error CS0103: The name 'myVar' does not exist in the current context`;
      const result = codeAnalysis.analyzeBuildOutput(taskId, buildOutput);
      expect(result.errors_found).toBe(1);
      expect(result.errors[0].code).toBe('CS0103');
    });

    test('detects CS1061 missing member', () => {
      const buildOutput = `error CS1061: 'string' does not contain a definition for 'Foo'`;
      const result = codeAnalysis.analyzeBuildOutput(taskId, buildOutput);
      expect(result.errors_found).toBe(1);
      expect(result.errors[0].error_type).toBe('missing_member');
    });

    test('handles multiple errors in one build output', () => {
      const buildOutput = [
        `error CS0246: The type or namespace 'Widget' could not be found`,
        `error CS0103: The name 'helper' does not exist in the current context`,
        `error CS0246: The type or namespace 'Service' could not be found`,
      ].join('\n');
      const result = codeAnalysis.analyzeBuildOutput(taskId, buildOutput);
      expect(result.errors_found).toBe(3);
    });

    test('returns clean result for build with no errors', () => {
      const buildOutput = `Build succeeded.\n0 Error(s)\n0 Warning(s)`;
      const result = codeAnalysis.analyzeBuildOutput(taskId, buildOutput);
      expect(result.errors_found).toBe(0);
      expect(result.has_namespace_conflicts).toBe(false);
      expect(result.has_missing_types).toBe(false);
    });

    test('persists build errors to database', () => {
      codeAnalysis.analyzeBuildOutput(taskId, `error CS0246: The type or namespace 'X' could not be found`);
      const rows = codeAnalysis.getBuildErrorAnalysis(taskId);
      expect(rows.length).toBe(1);
      expect(rows[0].error_code).toBe('CS0246');
    });
  });

  // ===========================================
  // Getter functions return empty for unknown tasks
  // ===========================================
  describe('getter functions for unknown tasks', () => {
    const unknownId = 'nonexistent-task-id';

    test('getComplexityMetrics returns empty array', () => {
      expect(codeAnalysis.getComplexityMetrics(unknownId)).toEqual([]);
    });

    test('getDeadCodeResults returns empty array', () => {
      expect(codeAnalysis.getDeadCodeResults(unknownId)).toEqual([]);
    });

    test('getDocCoverageResults returns empty array', () => {
      expect(codeAnalysis.getDocCoverageResults(unknownId)).toEqual([]);
    });

    test('getResourceEstimates returns empty array', () => {
      expect(codeAnalysis.getResourceEstimates(unknownId)).toEqual([]);
    });

    test('getI18nResults returns empty array', () => {
      expect(codeAnalysis.getI18nResults(unknownId)).toEqual([]);
    });

    test('getAccessibilityResults returns empty array', () => {
      expect(codeAnalysis.getAccessibilityResults(unknownId)).toEqual([]);
    });

    test('getTypeVerificationResults returns empty array', () => {
      expect(codeAnalysis.getTypeVerificationResults(unknownId)).toEqual([]);
    });

    test('getBuildErrorAnalysis returns empty array', () => {
      expect(codeAnalysis.getBuildErrorAnalysis(unknownId)).toEqual([]);
    });
  });
});
