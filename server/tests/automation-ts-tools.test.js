/**
 * Tests for automation-ts-tools.js handler module.
 *
 * Covers exported handlers with 2-3 tests each:
 *   - Happy path (basic functionality)
 *   - Error handling (missing file, invalid args)
 *   - Idempotency / duplicate detection
 *
 * Uses vitest with globals: true — do NOT import from 'vitest'.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const handlers = require('../handlers/automation-ts-tools');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Helper: write a temp file and return its absolute path
// ──────────────────────────────────────────────────────────────────────────────
function tmpFile(name, content) {
  const fp = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
  return fp;
}

function read(fp) {
  return fs.readFileSync(fp, 'utf8');
}

// ════════════════════════════════════════════════════════════════════════════════
// 1. handleAddTsInterfaceMembers
// ════════════════════════════════════════════════════════════════════════════════
describe('handleAddTsInterfaceMembers', () => {
  it('adds members to an interface', () => {
    const fp = tmpFile('iface.ts', [
      'export interface Config {',
      '  name: string;',
      '}',
    ].join('\n'));

    const result = handlers.handleAddTsInterfaceMembers({
      file_path: fp,
      interface_name: 'Config',
      members: [
        { name: 'timeout', type_definition: 'number' },
        { name: 'debug', type_definition: 'boolean' },
      ],
    });

    expect(result.isError).toBeFalsy();
    const content = read(fp);
    expect(content).toContain('timeout: number;');
    expect(content).toContain('debug: boolean;');
    expect(result.content[0].text).toContain('Added 2 members');
  });

  it('returns error for missing file', () => {
    const result = handlers.handleAddTsInterfaceMembers({
      file_path: path.join(tmpDir, 'nonexistent.ts'),
      interface_name: 'Config',
      members: [{ name: 'a', type_definition: 'string' }],
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
  });

  it('detects duplicate members', () => {
    const fp = tmpFile('iface-dup.ts', [
      'export interface Config {',
      '  timeout: number;',
      '}',
    ].join('\n'));

    const result = handlers.handleAddTsInterfaceMembers({
      file_path: fp,
      interface_name: 'Config',
      members: [{ name: 'timeout', type_definition: 'number' }],
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('CONFLICT');
    expect(result.content[0].text).toContain('timeout');
  });

  it('returns error for missing required params', () => {
    const result = handlers.handleAddTsInterfaceMembers({});
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('supports payload format members', () => {
    const fp = tmpFile('iface-payload.ts', [
      'export interface AppEvents {',
      '  click: { x: number; y: number };',
      '}',
    ].join('\n'));

    const result = handlers.handleAddTsInterfaceMembers({
      file_path: fp,
      interface_name: 'AppEvents',
      members: [{ name: 'hover', payload: { x: 'number', y: 'number' } }],
    });

    expect(result.isError).toBeFalsy();
    const content = read(fp);
    expect(content).toContain('hover: { x: number; y: number }');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2. handleInjectClassDependency
// ════════════════════════════════════════════════════════════════════════════════
describe('handleInjectClassDependency', () => {
  const classContent = [
    'import { EventBus } from "./EventBus";',
    '',
    'export class AppService {',
    '  private eventBus!: EventBus;',
    '',
    '  constructor() {',
    '    this.eventBus = new EventBus();',
    '  }',
    '',
    '  private doStuff() {',
    '    // internal',
    '  }',
    '}',
  ].join('\n');

  it('injects import, field, init, and getter', () => {
    const fp = tmpFile('app-service.ts', classContent);

    const result = handlers.handleInjectClassDependency({
      file_path: fp,
      import_statement: 'import { FooSystem } from "./FooSystem";',
      field_declaration: 'private fooSystem!: FooSystem;',
      initialization: 'this.fooSystem = new FooSystem();',
      getter: '  public getFooSystem(): FooSystem {\n    return this.fooSystem;\n  }',
    });

    expect(result.isError).toBeFalsy();
    const content = read(fp);
    expect(content).toContain('import { FooSystem }');
    expect(content).toContain('fooSystem!: FooSystem');
    expect(content).toContain('this.fooSystem = new FooSystem()');
    expect(content).toContain('getFooSystem()');
  });

  it('returns error for missing file', () => {
    const result = handlers.handleInjectClassDependency({
      file_path: path.join(tmpDir, 'nope.ts'),
      import_statement: 'import { X } from "./X";',
      field_declaration: 'private x!: X;',
      initialization: 'this.x = new X();',
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
  });

  it('skips duplicate import (skip_if_exists default)', () => {
    const fp = tmpFile('service-dup.ts', classContent);

    const result = handlers.handleInjectClassDependency({
      file_path: fp,
      import_statement: 'import { EventBus } from "./EventBus";',
      field_declaration: 'private eventBus2!: EventBus;',
      initialization: 'this.eventBus2 = new EventBus();',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('already imported');
  });

  it('returns error for missing required params', () => {
    const result = handlers.handleInjectClassDependency({
      file_path: tmpFile('empty.ts', ''),
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3. handleAddTsUnionMembers
// ════════════════════════════════════════════════════════════════════════════════
describe('handleAddTsUnionMembers', () => {
  const unionContent = [
    'export type NotificationEvent =',
    '  | "click"',
    '  | "hover";',
    '',
  ].join('\n');

  it('adds new members to union type', () => {
    const fp = tmpFile('union.ts', unionContent);

    const result = handlers.handleAddTsUnionMembers({
      file_path: fp,
      type_name: 'NotificationEvent',
      members: ['scroll', 'resize'],
    });

    expect(result.isError).toBeFalsy();
    const content = read(fp);
    expect(content).toContain('"scroll"');
    expect(content).toContain('"resize"');
    expect(result.content[0].text).toContain('Added 2 members');
  });

  it('returns error for missing file', () => {
    const result = handlers.handleAddTsUnionMembers({
      file_path: path.join(tmpDir, 'missing.ts'),
      type_name: 'X',
      members: ['a'],
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
  });

  it('detects duplicate union members', () => {
    const fp = tmpFile('union-dup.ts', unionContent);

    const result = handlers.handleAddTsUnionMembers({
      file_path: fp,
      type_name: 'NotificationEvent',
      members: ['click'],
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('CONFLICT');
    expect(result.content[0].text).toContain('click');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4. handleInjectMethodCalls
// ════════════════════════════════════════════════════════════════════════════════
describe('handleInjectMethodCalls', () => {
  it('inserts code before a marker string', () => {
    const fp = tmpFile('bridge.ts', [
      'class Bridge {',
      '  bind() {',
      '    this.connected = true;',
      '  }',
      '}',
    ].join('\n'));

    const result = handlers.handleInjectMethodCalls({
      file_path: fp,
      before_marker: 'this.connected = true;',
      code: '    this.init();\n',
    });

    expect(result.isError).toBeFalsy();
    const content = read(fp);
    const initIdx = content.indexOf('this.init()');
    const connIdx = content.indexOf('this.connected = true');
    expect(initIdx).toBeLessThan(connIdx);
    expect(initIdx).toBeGreaterThan(-1);
  });

  it('returns error when marker not found', () => {
    const fp = tmpFile('no-marker.ts', 'class Foo {}');

    const result = handlers.handleInjectMethodCalls({
      file_path: fp,
      before_marker: 'nonexistent marker',
      code: 'x();',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
  });

  it('returns error for missing required params', () => {
    const result = handlers.handleInjectMethodCalls({});
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5. handleAddTsEnumMembers
// ════════════════════════════════════════════════════════════════════════════════
describe('handleAddTsEnumMembers', () => {
  const enumContent = [
    'export enum Status {',
    '  Active = "active",',
    '  Inactive = "inactive",',
    '}',
  ].join('\n');

  it('adds new members to an enum', () => {
    const fp = tmpFile('enums.ts', enumContent);

    const result = handlers.handleAddTsEnumMembers({
      file_path: fp,
      enum_name: 'Status',
      members: [
        { name: 'Pending', value: 'pending' },
        { name: 'Archived', value: 'archived' },
      ],
    });

    expect(result.isError).toBeFalsy();
    const content = read(fp);
    expect(content).toContain('Pending = "pending"');
    expect(content).toContain('Archived = "archived"');
  });

  it('returns error for missing file', () => {
    const result = handlers.handleAddTsEnumMembers({
      file_path: path.join(tmpDir, 'nope.ts'),
      enum_name: 'Status',
      members: [{ name: 'X', value: 'x' }],
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
  });

  it('detects duplicate enum members', () => {
    const fp = tmpFile('enum-dup.ts', enumContent);

    const result = handlers.handleAddTsEnumMembers({
      file_path: fp,
      enum_name: 'Status',
      members: [{ name: 'Active', value: 'active' }],
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('CONFLICT');
    expect(result.content[0].text).toContain('Active');
  });
});


// ════════════════════════════════════════════════════════════════════════════════
// 7. handleNormalizeInterfaceFormatting
// ════════════════════════════════════════════════════════════════════════════════
describe('handleNormalizeInterfaceFormatting', () => {
  it('fixes inconsistent indentation', () => {
    const fp = tmpFile('drifted.ts', [
      'export interface AppEvents {',
      '    name: string;',
      '      age: number;',
      '  active: boolean;',
      '}',
    ].join('\n'));

    const result = handlers.handleNormalizeInterfaceFormatting({
      file_path: fp,
      interface_name: 'AppEvents',
      indent: '  ',
    });

    expect(result.isError).toBeFalsy();
    const lines = read(fp).split('\n');
    // All member lines should have exactly 2 spaces of indentation
    expect(lines[1]).toContain('  name: string;');
    expect(lines[2]).toContain('  age: number;');
    expect(lines[3]).toContain('  active: boolean;');
    expect(result.content[0].text).toContain('Lines fixed:');
  });

  it('returns error when interface not found', () => {
    const fp = tmpFile('no-iface.ts', 'const x = 1;');

    const result = handlers.handleNormalizeInterfaceFormatting({
      file_path: fp,
      interface_name: 'NonExistent',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
  });

  it('is idempotent — running twice produces same result', () => {
    const fp = tmpFile('idempotent.ts', [
      'export interface Config {',
      '      x: number;',
      '  y: string;',
      '}',
    ].join('\n'));

    handlers.handleNormalizeInterfaceFormatting({
      file_path: fp,
      interface_name: 'Config',
      indent: '  ',
    });
    const first = read(fp);

    handlers.handleNormalizeInterfaceFormatting({
      file_path: fp,
      interface_name: 'Config',
      indent: '  ',
    });
    const second = read(fp);

    expect(first).toBe(second);
  });
});


// ════════════════════════════════════════════════════════════════════════════════
// 9. handleAddTsMethodToClass
// ════════════════════════════════════════════════════════════════════════════════
describe('handleAddTsMethodToClass', () => {
  const classSource = [
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
  ].join('\n');

  it('adds a method at end of class by default', () => {
    const fp = tmpFile('service.ts', classSource);

    const result = handlers.handleAddTsMethodToClass({
      file_path: fp,
      class_name: 'MyService',
      method_code: 'public newMethod() {\n  return 42;\n}',
    });

    expect(result.isError).toBeFalsy();
    const content = read(fp);
    expect(content).toContain('newMethod');
    expect(result.content[0].text).toContain('Added method');
  });

  it('returns error for non-existent class', () => {
    const fp = tmpFile('cls.ts', classSource);

    const result = handlers.handleAddTsMethodToClass({
      file_path: fp,
      class_name: 'NoSuchClass',
      method_code: 'public foo() {}',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
    expect(result.content[0].text).toContain('not found');
  });

  it('skips duplicate method (idempotency)', () => {
    const fp = tmpFile('cls-dup.ts', classSource);

    const result = handlers.handleAddTsMethodToClass({
      file_path: fp,
      class_name: 'MyService',
      method_code: 'public getData() {\n  return "new";\n}',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('already exists');
    // Original preserved
    const content = read(fp);
    expect(content).toContain('return this.name;');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 10. handleReplaceTsMethodBody
// ════════════════════════════════════════════════════════════════════════════════
describe('handleReplaceTsMethodBody', () => {
  const classSource = [
    'export class Calculator {',
    '  public add(a: number, b: number): number {',
    '    return a + b;',
    '  }',
    '',
    '  public subtract(a: number, b: number): number {',
    '    return a - b;',
    '  }',
    '}',
  ].join('\n');

  it('replaces a method body', () => {
    const fp = tmpFile('calc.ts', classSource);

    const result = handlers.handleReplaceTsMethodBody({
      file_path: fp,
      class_name: 'Calculator',
      method_name: 'add',
      new_body: 'console.log("adding");\nreturn a + b + 1;',
    });

    expect(result.isError).toBeFalsy();
    const content = read(fp);
    expect(content).toContain('console.log("adding")');
    expect(content).toContain('return a + b + 1');
    // Subtract should be untouched
    expect(content).toContain('return a - b;');
  });

  it('returns error for non-existent method', () => {
    const fp = tmpFile('calc2.ts', classSource);

    const result = handlers.handleReplaceTsMethodBody({
      file_path: fp,
      class_name: 'Calculator',
      method_name: 'multiply',
      new_body: 'return a * b;',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
    expect(result.content[0].text).toContain('multiply');
  });

  it('returns error for missing required params', () => {
    const result = handlers.handleReplaceTsMethodBody({
      file_path: tmpFile('empty.ts', 'export class X {}'),
      class_name: 'X',
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 11. handleAddImportStatement
// ════════════════════════════════════════════════════════════════════════════════
describe('handleAddImportStatement', () => {
  const fileContent = [
    'import { A } from "./A";',
    'import { B } from "./B";',
    '',
    'export class Foo {',
    '  constructor() {}',
    '}',
  ].join('\n');

  it('adds an import statement after existing imports', () => {
    const fp = tmpFile('imports.ts', fileContent);

    const result = handlers.handleAddImportStatement({
      file_path: fp,
      import_statement: 'import { C } from "./C";',
    });

    expect(result.isError).toBeFalsy();
    const content = read(fp);
    expect(content).toContain('import { C } from "./C";');
    expect(result.content[0].text).toContain('Added import');
  });

  it('skips duplicate import for same module (idempotency)', () => {
    const fp = tmpFile('imports-dup.ts', fileContent);

    const result = handlers.handleAddImportStatement({
      file_path: fp,
      import_statement: 'import { A2 } from "./A";',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('already imported');
    // File unchanged
    expect(read(fp)).toBe(fileContent);
  });

  it('returns error for malformed import statement', () => {
    const fp = tmpFile('imports-bad.ts', fileContent);

    const result = handlers.handleAddImportStatement({
      file_path: fp,
      import_statement: 'const x = 42;',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
  });

  it('returns error for missing file', () => {
    const result = handlers.handleAddImportStatement({
      file_path: path.join(tmpDir, 'nope.ts'),
      import_statement: 'import { X } from "./X";',
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
  });
});
