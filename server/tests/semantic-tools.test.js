const path = require('path');
const os = require('os');
const fs = require('fs');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Semantic TypeScript Tools', () => {
  let tmpDir;

  beforeAll(() => {
    setupTestDb('semantic-tools');
    tmpDir = path.join(os.tmpdir(), `semantic-tools-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    teardownTestDb();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── add_ts_method_to_class ───────────────────────────────────────
  describe('add_ts_method_to_class', () => {
    let classFile;

    beforeEach(() => {
      classFile = path.join(tmpDir, `class-${Date.now()}.ts`);
      fs.writeFileSync(classFile, [
        'export class MyService {',
        '  private name: string;',
        '',
        '  constructor() {',
        '    this.name = "test";',
        '  }',
        '',
        '  public getData() {',
        '    return this.name;',
        '  }',
        '',
        '  private doInternal() {',
        '    // internal',
        '  }',
        '}',
      ].join('\n'), 'utf8');
    });

    it('adds method at end of class', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: classFile,
        class_name: 'MyService',
        method_code: 'public newMethod() {\n  return 42;\n}',
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('newMethod');

      const content = fs.readFileSync(classFile, 'utf8');
      expect(content).toContain('newMethod');
    });

    it('rejects when class not found', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: classFile,
        class_name: 'NonExistentClass',
        method_code: 'public foo() {}',
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('skips duplicate method name', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: classFile,
        class_name: 'MyService',
        method_code: 'public getData() {\n  return "new";\n}',
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('already exists');

      // Original implementation preserved
      const content = fs.readFileSync(classFile, 'utf8');
      expect(content).toContain('return this.name;');
    });

    it('supports before_first_private position', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: classFile,
        class_name: 'MyService',
        method_code: 'public inserted() {\n  return true;\n}',
        position: 'before_first_private',
      });
      expect(result.isError).toBeFalsy();

      const content = fs.readFileSync(classFile, 'utf8');
      const insertedPos = content.indexOf('inserted');
      const privatePos = content.indexOf('private doInternal');
      expect(insertedPos).toBeLessThan(privatePos);
    });

    it('errors on missing required params', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: classFile,
        // missing class_name and method_code
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('required');
    });
  });

  // ── replace_ts_method_body ───────────────────────────────────────
  describe('replace_ts_method_body', () => {
    let classFile;

    beforeEach(() => {
      classFile = path.join(tmpDir, `replace-${Date.now()}.ts`);
      fs.writeFileSync(classFile, [
        'class Calculator {',
        '  add(a: number, b: number) {',
        '    return a + b;',
        '  }',
        '',
        '  multiply(a: number, b: number) {',
        '    return a * b;',
        '  }',
        '}',
      ].join('\n'), 'utf8');
    });

    it('replaces body by name, signature preserved', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: classFile,
        class_name: 'Calculator',
        method_name: 'add',
        new_body: 'console.log("adding");\nreturn a + b + 1;',
      });
      expect(result.isError).toBeFalsy();

      const content = fs.readFileSync(classFile, 'utf8');
      // Signature preserved
      expect(content).toContain('add(a: number, b: number)');
      // New body present
      expect(content).toContain('return a + b + 1;');
      // Old body gone
      expect(content).not.toMatch(/^\s*return a \+ b;\s*$/m);
    });

    it('rejects when method not found', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: classFile,
        class_name: 'Calculator',
        method_name: 'nonexistent',
        new_body: 'return 0;',
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('rejects when class not found', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: classFile,
        class_name: 'WrongClass',
        method_name: 'add',
        new_body: 'return 0;',
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('errors on missing required params', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: classFile,
        class_name: 'Calculator',
        // missing method_name and new_body
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('required');
    });

    it('works with multi-line replacement body', async () => {
      const newBody = [
        'const result = a * b;',
        'if (result > 100) {',
        '  throw new Error("overflow");',
        '}',
        'return result;',
      ].join('\n');

      const result = await safeTool('replace_ts_method_body', {
        file_path: classFile,
        class_name: 'Calculator',
        method_name: 'multiply',
        new_body: newBody,
      });
      expect(result.isError).toBeFalsy();

      const content = fs.readFileSync(classFile, 'utf8');
      expect(content).toContain('throw new Error("overflow")');
      expect(content).toContain('multiply(a: number, b: number)');
    });
  });

  // ── add_import_statement ─────────────────────────────────────────
  describe('add_import_statement', () => {
    let importFile;

    beforeEach(() => {
      importFile = path.join(tmpDir, `imports-${Date.now()}.ts`);
      fs.writeFileSync(importFile, [
        'import { Foo } from "./foo";',
        'import { Bar } from "./bar";',
        '',
        'export class App {',
        '  run() {}',
        '}',
      ].join('\n'), 'utf8');
    });

    it('adds import after last existing import', async () => {
      const result = await safeTool('add_import_statement', {
        file_path: importFile,
        import_statement: 'import { Baz } from "./baz";',
      });
      expect(result.isError).toBeFalsy();

      const content = fs.readFileSync(importFile, 'utf8');
      expect(content).toContain('import { Baz } from "./baz";');

      // Baz import should be after Bar import
      const barIdx = content.indexOf('import { Bar }');
      const bazIdx = content.indexOf('import { Baz }');
      expect(bazIdx).toBeGreaterThan(barIdx);
    });

    it('skips if module already imported (idempotent)', async () => {
      const result = await safeTool('add_import_statement', {
        file_path: importFile,
        import_statement: 'import { Foo, Extra } from "./foo";',
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('already imported');

      // File unchanged — still has original import
      const content = fs.readFileSync(importFile, 'utf8');
      const fooCount = (content.match(/from "\.\/foo"/g) || []).length;
      expect(fooCount).toBe(1);
    });

    it('errors on nonexistent file', async () => {
      const result = await safeTool('add_import_statement', {
        file_path: path.join(tmpDir, 'does-not-exist.ts'),
        import_statement: 'import { X } from "./x";',
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('handles require() style imports', async () => {
      const requireFile = path.join(tmpDir, `require-${Date.now()}.ts`);
      fs.writeFileSync(requireFile, [
        'const path = require("path");',
        'const fs = require("fs");',
        '',
        'function main() {}',
      ].join('\n'), 'utf8');

      const result = await safeTool('add_import_statement', {
        file_path: requireFile,
        import_statement: 'import { join } from "path/posix";',
      });
      expect(result.isError).toBeFalsy();

      const content = fs.readFileSync(requireFile, 'utf8');
      expect(content).toContain('import { join } from "path/posix";');

      // New import should appear after the require() lines
      const lastRequire = content.lastIndexOf('require(');
      const newImport = content.indexOf('import { join }');
      expect(newImport).toBeGreaterThan(lastRequire);
    });
  });
});
