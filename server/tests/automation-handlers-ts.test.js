/**
 * Automation Handlers Tests
 *
 * Integration tests for MCP tools in automation-handlers.js.
 * Tests universal TS tools with temp files, config tools via DB,
 * semantic TS tools, and error paths for remaining tools.
 */

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const path = require('path');
const os = require('os');
const fs = require('fs');

describe('Automation Handlers', () => {
  let tempDir;

  beforeAll(() => {
    setupTestDb('automation');
    tempDir = path.join(os.tmpdir(), `torque-auto-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    teardownTestDb();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── configure_stall_detection ─────────────────────────────────────────────

  describe('add_ts_interface_members', () => {
    let tsFile;

    beforeEach(() => {
      tsFile = path.join(tempDir, 'test-interface.ts');
      fs.writeFileSync(tsFile, `export interface Config {
  name: string;
  version: number;
}
`);
    });

    it('adds members to interface', async () => {
      const result = await safeTool('add_ts_interface_members', {
        file_path: tsFile,
        interface_name: 'Config',
        members: [{ name: 'timeout', type_definition: 'number' }]
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('timeout: number;');
    });

    it('supports payload format', async () => {
      const result = await safeTool('add_ts_interface_members', {
        file_path: tsFile,
        interface_name: 'Config',
        members: [{ name: 'event', payload: { id: 'string', count: 'number' } }]
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('event:');
      expect(content).toContain('id: string');
    });

    it('rejects duplicate members', async () => {
      const result = await safeTool('add_ts_interface_members', {
        file_path: tsFile,
        interface_name: 'Config',
        members: [{ name: 'name', type_definition: 'string' }]
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Duplicate');
    });

    it('rejects interface not found', async () => {
      const result = await safeTool('add_ts_interface_members', {
        file_path: tsFile,
        interface_name: 'NonExistent',
        members: [{ name: 'foo', type_definition: 'string' }]
      });
      expect(result.isError).toBe(true);
    });

    it('rejects file not found', async () => {
      const result = await safeTool('add_ts_interface_members', {
        file_path: path.join(tempDir, 'nope.ts'),
        interface_name: 'Config',
        members: [{ name: 'foo', type_definition: 'string' }]
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing required params', async () => {
      const result = await safeTool('add_ts_interface_members', {});
      expect(result.isError).toBe(true);
    });

    it('adds multiple members at once', async () => {
      const result = await safeTool('add_ts_interface_members', {
        file_path: tsFile,
        interface_name: 'Config',
        members: [
          { name: 'timeout', type_definition: 'number' },
          { name: 'retries', type_definition: 'number' },
          { name: 'label', type_definition: 'string' },
        ]
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('timeout: number;');
      expect(content).toContain('retries: number;');
      expect(content).toContain('label: string;');
    });

    it('expands payload with more than 3 fields to multi-line', async () => {
      const result = await safeTool('add_ts_interface_members', {
        file_path: tsFile,
        interface_name: 'Config',
        members: [{
          name: 'meta',
          payload: { a: 'string', b: 'number', c: 'boolean', d: 'string' }
        }]
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('meta:');
      expect(content).toContain('a: string;');
    });

    it('reports added member names in output', async () => {
      const result = await safeTool('add_ts_interface_members', {
        file_path: tsFile,
        interface_name: 'Config',
        members: [{ name: 'debug', type_definition: 'boolean' }]
      });
      const text = getText(result);
      expect(text).toContain('debug');
      expect(text).toContain('Added 1 members');
    });
  });

  describe('add_ts_union_members', () => {
    let tsFile;

    beforeEach(() => {
      tsFile = path.join(tempDir, 'test-union.ts');
      fs.writeFileSync(tsFile, `type EventType =
  | "click"
  | "hover";
`);
    });

    it('adds members to union', async () => {
      const result = await safeTool('add_ts_union_members', {
        file_path: tsFile,
        type_name: 'EventType',
        members: ['scroll', 'resize']
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('"scroll"');
      expect(content).toContain('"resize"');
    });

    it('rejects duplicate members', async () => {
      const result = await safeTool('add_ts_union_members', {
        file_path: tsFile,
        type_name: 'EventType',
        members: ['click']
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Duplicate');
    });

    it('rejects file not found', async () => {
      const result = await safeTool('add_ts_union_members', {
        file_path: path.join(tempDir, 'nope.ts'),
        type_name: 'EventType',
        members: ['scroll']
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing params', async () => {
      const result = await safeTool('add_ts_union_members', {});
      expect(result.isError).toBe(true);
    });

    it('preserves existing members after adding new ones', async () => {
      await safeTool('add_ts_union_members', {
        file_path: tsFile,
        type_name: 'EventType',
        members: ['scroll']
      });
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('"click"');
      expect(content).toContain('"hover"');
      expect(content).toContain('"scroll"');
    });

    it('reports added count in output', async () => {
      const result = await safeTool('add_ts_union_members', {
        file_path: tsFile,
        type_name: 'EventType',
        members: ['drag', 'drop']
      });
      const text = getText(result);
      expect(text).toContain('Added 2 members');
    });
  });

  describe('inject_method_calls', () => {
    let tsFile;

    beforeEach(() => {
      tsFile = path.join(tempDir, 'test-inject.ts');
      fs.writeFileSync(tsFile, `class App {
  init() {
    this.setup();
    this.ready = true;
  }
}
`);
    });

    it('injects code before marker', async () => {
      const result = await safeTool('inject_method_calls', {
        file_path: tsFile,
        before_marker: 'this.ready = true;',
        code: '    this.loadPlugins();'
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('this.loadPlugins();');
      // Verify order: loadPlugins before ready
      const loadIdx = content.indexOf('this.loadPlugins()');
      const readyIdx = content.indexOf('this.ready = true');
      expect(loadIdx).toBeLessThan(readyIdx);
    });

    it('rejects marker not found', async () => {
      const result = await safeTool('inject_method_calls', {
        file_path: tsFile,
        before_marker: 'nonexistent marker',
        code: 'whatever();'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects file not found', async () => {
      const result = await safeTool('inject_method_calls', {
        file_path: path.join(tempDir, 'nope.ts'),
        before_marker: 'x',
        code: 'y'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing params', async () => {
      const result = await safeTool('inject_method_calls', {});
      expect(result.isError).toBe(true);
    });

    it('reports line count in output', async () => {
      const result = await safeTool('inject_method_calls', {
        file_path: tsFile,
        before_marker: 'this.ready = true;',
        code: '    this.a();\n    this.b();'
      });
      const text = getText(result);
      expect(text).toContain('Injected');
      expect(text).toContain('lines');
    });

    it('injects multi-line code blocks', async () => {
      const code = '    if (this.config) {\n      this.configure();\n    }';
      const result = await safeTool('inject_method_calls', {
        file_path: tsFile,
        before_marker: 'this.ready = true;',
        code
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('this.configure();');
    });
  });

  describe('add_ts_enum_members', () => {
    let tsFile;

    beforeEach(() => {
      tsFile = path.join(tempDir, 'test-enum.ts');
      fs.writeFileSync(tsFile, `export enum Status {
  Active = "active",
  Inactive = "inactive",
}
`);
    });

    it('adds members to enum', async () => {
      const result = await safeTool('add_ts_enum_members', {
        file_path: tsFile,
        enum_name: 'Status',
        members: [{ name: 'Pending', value: 'pending' }]
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('Pending = "pending"');
    });

    it('rejects duplicate members', async () => {
      const result = await safeTool('add_ts_enum_members', {
        file_path: tsFile,
        enum_name: 'Status',
        members: [{ name: 'Active', value: 'active' }]
      });
      expect(result.isError).toBe(true);
    });

    it('rejects enum not found', async () => {
      const result = await safeTool('add_ts_enum_members', {
        file_path: tsFile,
        enum_name: 'NonExistent',
        members: [{ name: 'Foo', value: 'foo' }]
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing params', async () => {
      const result = await safeTool('add_ts_enum_members', {});
      expect(result.isError).toBe(true);
    });

    it('supports numeric enum values', async () => {
      fs.writeFileSync(tsFile, `export enum Priority {
  Low = 1,
  Medium = 2,
}
`);
      const result = await safeTool('add_ts_enum_members', {
        file_path: tsFile,
        enum_name: 'Priority',
        members: [{ name: 'High', value: 3 }]
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('High = 3');
    });

    it('rejects file not found', async () => {
      const result = await safeTool('add_ts_enum_members', {
        file_path: path.join(tempDir, 'nope.ts'),
        enum_name: 'Status',
        members: [{ name: 'Foo', value: 'foo' }]
      });
      expect(result.isError).toBe(true);
    });

    it('adds multiple members at once', async () => {
      const result = await safeTool('add_ts_enum_members', {
        file_path: tsFile,
        enum_name: 'Status',
        members: [
          { name: 'Pending', value: 'pending' },
          { name: 'Archived', value: 'archived' }
        ]
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('Pending = "pending"');
      expect(content).toContain('Archived = "archived"');
    });

    it('reports added count in output', async () => {
      const result = await safeTool('add_ts_enum_members', {
        file_path: tsFile,
        enum_name: 'Status',
        members: [{ name: 'Draft', value: 'draft' }]
      });
      const text = getText(result);
      expect(text).toContain('Added 1 members');
    });
  });

  describe('normalize_interface_formatting', () => {
    let tsFile;

    beforeEach(() => {
      tsFile = path.join(tempDir, 'test-normalize.ts');
      // Intentionally messy indentation
      fs.writeFileSync(tsFile, `export interface Events {
      click: { x: number };
   hover: { y: number };
         scroll: { delta: number };
}
`);
    });

    it('normalizes indentation', async () => {
      const result = await safeTool('normalize_interface_formatting', {
        file_path: tsFile,
        interface_name: 'Events'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Lines fixed');
    });

    it('rejects interface not found', async () => {
      const result = await safeTool('normalize_interface_formatting', {
        file_path: tsFile,
        interface_name: 'NonExistent'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing params', async () => {
      const result = await safeTool('normalize_interface_formatting', {});
      expect(result.isError).toBe(true);
    });

    it('rejects file not found', async () => {
      const result = await safeTool('normalize_interface_formatting', {
        file_path: path.join(tempDir, 'nope.ts'),
        interface_name: 'Events'
      });
      expect(result.isError).toBe(true);
    });

    it('reports fix count in output', async () => {
      const result = await safeTool('normalize_interface_formatting', {
        file_path: tsFile,
        interface_name: 'Events'
      });
      const text = getText(result);
      expect(text).toContain('Lines fixed');
      expect(text).toContain('Target indent');
    });

    it('supports custom indent', async () => {
      const result = await safeTool('normalize_interface_formatting', {
        file_path: tsFile,
        interface_name: 'Events',
        indent: '    '
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('4 spaces');
    });
  });

  describe('inject_class_dependency', () => {
    let tsFile;

    beforeEach(() => {
      tsFile = path.join(tempDir, 'test-inject-dep.ts');
      fs.writeFileSync(tsFile, `import { ServiceA } from "./ServiceA";

export class MyApp {
  private serviceA!: ServiceA;

  constructor() {
    this.serviceA = new ServiceA();
  }

  private init() {}
}
`);
    });

    it('injects full dependency', async () => {
      const result = await safeTool('inject_class_dependency', {
        file_path: tsFile,
        import_statement: 'import { ServiceB } from "./ServiceB";',
        field_declaration: 'private serviceB!: ServiceB;',
        initialization: 'this.serviceB = new ServiceB();'
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('import { ServiceB }');
      expect(content).toContain('private serviceB!: ServiceB;');
      expect(content).toContain('this.serviceB = new ServiceB();');
    });

    it('skips if already imported', async () => {
      const result = await safeTool('inject_class_dependency', {
        file_path: tsFile,
        import_statement: 'import { ServiceA } from "./ServiceA";',
        field_declaration: 'private serviceA!: ServiceA;',
        initialization: 'this.serviceA = new ServiceA();'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('already imported');
    });

    it('rejects file not found', async () => {
      const result = await safeTool('inject_class_dependency', {
        file_path: path.join(tempDir, 'nope.ts'),
        import_statement: 'import { X } from "./X";',
        field_declaration: 'private x!: X;',
        initialization: 'this.x = new X();'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing required params', async () => {
      const result = await safeTool('inject_class_dependency', {
        file_path: tsFile
      });
      expect(result.isError).toBe(true);
    });

    it('injects with getter when provided', async () => {
      const result = await safeTool('inject_class_dependency', {
        file_path: tsFile,
        import_statement: 'import { ServiceC } from "./ServiceC";',
        field_declaration: 'private serviceC!: ServiceC;',
        initialization: 'this.serviceC = new ServiceC();',
        getter: '  public getServiceC(): ServiceC {\n    return this.serviceC;\n  }'
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('getServiceC');
    });

    it('reports injected items in output', async () => {
      const result = await safeTool('inject_class_dependency', {
        file_path: tsFile,
        import_statement: 'import { ServiceD } from "./ServiceD";',
        field_declaration: 'private serviceD!: ServiceD;',
        initialization: 'this.serviceD = new ServiceD();'
      });
      const text = getText(result);
      expect(text).toContain('Injected dependency');
      expect(text).toContain('Import');
      expect(text).toContain('Field');
      expect(text).toContain('Init');
    });
  });

  // ─── Semantic TypeScript Tools ─────────────────────────────────────────────

  describe('add_ts_method_to_class', () => {
    let tsFile;

    beforeEach(() => {
      tsFile = path.join(tempDir, 'test-method.ts');
      fs.writeFileSync(tsFile, `export class Calculator {
  private value: number = 0;

  public add(n: number): number {
    this.value += n;
    return this.value;
  }

  private reset() {
    this.value = 0;
  }
}
`);
    });

    it('adds a method to end of class', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: tsFile,
        class_name: 'Calculator',
        method_code: 'public subtract(n: number): number {\n  this.value -= n;\n  return this.value;\n}'
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('subtract');
      expect(content).toContain('this.value -= n');
    });

    it('rejects missing file_path', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        class_name: 'Calculator',
        method_code: 'public foo() {}'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing class_name', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: tsFile,
        method_code: 'public foo() {}'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing method_code', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: tsFile,
        class_name: 'Calculator'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects file not found', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: path.join(tempDir, 'nope.ts'),
        class_name: 'Calculator',
        method_code: 'public foo() {}'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects class not found', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: tsFile,
        class_name: 'NonExistent',
        method_code: 'public foo() {}'
      });
      expect(result.isError).toBe(true);
    });

    it('skips if method already exists', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: tsFile,
        class_name: 'Calculator',
        method_code: 'public add(n: number): number {\n  return n;\n}'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('already exists');
    });

    it('supports before_first_private position', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: tsFile,
        class_name: 'Calculator',
        method_code: 'public multiply(n: number): number {\n  this.value *= n;\n  return this.value;\n}',
        position: 'before_first_private'
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      const multiplyIdx = content.indexOf('multiply');
      const resetIdx = content.indexOf('private reset');
      expect(multiplyIdx).toBeLessThan(resetIdx);
    });

    it('supports after_method position', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: tsFile,
        class_name: 'Calculator',
        method_code: 'public getTotal(): number {\n  return this.value;\n}',
        position: 'after_method:add'
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('getTotal');
    });

    it('reports method name and position in output', async () => {
      const result = await safeTool('add_ts_method_to_class', {
        file_path: tsFile,
        class_name: 'Calculator',
        method_code: 'public divide(n: number): number {\n  this.value /= n;\n  return this.value;\n}'
      });
      const text = getText(result);
      expect(text).toContain('divide');
      expect(text).toContain('Calculator');
    });
  });

  describe('replace_ts_method_body', () => {
    let tsFile;

    beforeEach(() => {
      tsFile = path.join(tempDir, 'test-replace-method.ts');
      fs.writeFileSync(tsFile, `export class Greeter {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  public greet(): string {
    return "Hello, " + this.name;
  }

  public farewell(): string {
    return "Goodbye, " + this.name;
  }
}
`);
    });

    it('replaces a method body', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: tsFile,
        class_name: 'Greeter',
        method_name: 'greet',
        new_body: 'return `Howdy, ${this.name}!`;'
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('Howdy');
      expect(content).not.toContain('"Hello, "');
    });

    it('rejects missing file_path', async () => {
      const result = await safeTool('replace_ts_method_body', {
        class_name: 'Greeter',
        method_name: 'greet',
        new_body: 'return "hi";'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing class_name', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: tsFile,
        method_name: 'greet',
        new_body: 'return "hi";'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing method_name', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: tsFile,
        class_name: 'Greeter',
        new_body: 'return "hi";'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing new_body', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: tsFile,
        class_name: 'Greeter',
        method_name: 'greet'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects file not found', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: path.join(tempDir, 'nope.ts'),
        class_name: 'Greeter',
        method_name: 'greet',
        new_body: 'return "hi";'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects class not found', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: tsFile,
        class_name: 'NonExistent',
        method_name: 'greet',
        new_body: 'return "hi";'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects method not found', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: tsFile,
        class_name: 'Greeter',
        method_name: 'nonexistent',
        new_body: 'return "hi";'
      });
      expect(result.isError).toBe(true);
    });

    it('preserves other methods when replacing one', async () => {
      await safeTool('replace_ts_method_body', {
        file_path: tsFile,
        class_name: 'Greeter',
        method_name: 'greet',
        new_body: 'return "replaced";'
      });
      const content = fs.readFileSync(tsFile, 'utf8');
      // farewell method should still be intact
      expect(content).toContain('farewell');
      expect(content).toContain('Goodbye');
    });

    it('reports replacement details in output', async () => {
      const result = await safeTool('replace_ts_method_body', {
        file_path: tsFile,
        class_name: 'Greeter',
        method_name: 'farewell',
        new_body: 'return "See ya!";'
      });
      const text = getText(result);
      expect(text).toContain('Replaced method body');
      expect(text).toContain('Greeter');
      expect(text).toContain('farewell');
    });
  });

  describe('add_import_statement', () => {
    let tsFile;

    beforeEach(() => {
      tsFile = path.join(tempDir, 'test-import.ts');
      fs.writeFileSync(tsFile, `import { foo } from "./foo";
import { bar } from "./bar";

export function doStuff() {
  return foo() + bar();
}
`);
    });

    it('adds import after existing imports', async () => {
      const result = await safeTool('add_import_statement', {
        file_path: tsFile,
        import_statement: 'import { baz } from "./baz";'
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(tsFile, 'utf8');
      expect(content).toContain('import { baz } from "./baz";');
    });

    it('rejects missing file_path', async () => {
      const result = await safeTool('add_import_statement', {
        import_statement: 'import { x } from "./x";'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing import_statement', async () => {
      const result = await safeTool('add_import_statement', {
        file_path: tsFile
      });
      expect(result.isError).toBe(true);
    });

    it('rejects file not found', async () => {
      const result = await safeTool('add_import_statement', {
        file_path: path.join(tempDir, 'nope.ts'),
        import_statement: 'import { x } from "./x";'
      });
      expect(result.isError).toBe(true);
    });

    it('skips if module already imported', async () => {
      const result = await safeTool('add_import_statement', {
        file_path: tsFile,
        import_statement: 'import { foo2 } from "./foo";'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('already imported');
    });

    it('rejects invalid import without from clause', async () => {
      const result = await safeTool('add_import_statement', {
        file_path: tsFile,
        import_statement: 'import something;'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Could not extract module path');
    });

    it('reports module path in output', async () => {
      const result = await safeTool('add_import_statement', {
        file_path: tsFile,
        import_statement: 'import { qux } from "./qux";'
      });
      const text = getText(result);
      expect(text).toContain('./qux');
      expect(text).toContain('Added import statement');
    });

    it('handles file with no existing imports', async () => {
      const noImportsFile = path.join(tempDir, 'no-imports.ts');
      fs.writeFileSync(noImportsFile, `export function hello() {
  return "world";
}
`);
      const result = await safeTool('add_import_statement', {
        file_path: noImportsFile,
        import_statement: 'import { util } from "./util";'
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(noImportsFile, 'utf8');
      expect(content).toContain('import { util } from "./util";');
    });
  });

  // ─── Error Path Tests (validation-only for complex tools) ──────────────────

});
