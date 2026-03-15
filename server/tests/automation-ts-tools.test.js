/**
 * Tests for automation-ts-tools.js handler module.
 *
 * Covers all 14 exported handlers with 2-3 tests each:
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
      'export interface GameEvents {',
      '  click: { x: number; y: number };',
      '}',
    ].join('\n'));

    const result = handlers.handleAddTsInterfaceMembers({
      file_path: fp,
      interface_name: 'GameEvents',
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
    'import { EventSystem } from "./EventSystem";',
    '',
    'export class GameScene {',
    '  private eventSystem!: EventSystem;',
    '',
    '  constructor() {',
    '    this.eventSystem = new EventSystem();',
    '  }',
    '',
    '  private doStuff() {',
    '    // internal',
    '  }',
    '}',
  ].join('\n');

  it('injects import, field, init, and getter', () => {
    const fp = tmpFile('scene.ts', classContent);

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
    const fp = tmpFile('scene-dup.ts', classContent);

    const result = handlers.handleInjectClassDependency({
      file_path: fp,
      import_statement: 'import { EventSystem } from "./EventSystem";',
      field_declaration: 'private eventSystem2!: EventSystem;',
      initialization: 'this.eventSystem2 = new EventSystem();',
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
// 6. handleValidateEventConsistency
// ════════════════════════════════════════════════════════════════════════════════
describe('handleValidateEventConsistency', () => {
  it('reports no issues when events are consistent', () => {
    // Set up a minimal project structure
    const srcDir = path.join(tmpDir, 'src');
    const systemsDir = path.join(srcDir, 'systems');
    fs.mkdirSync(systemsDir, { recursive: true });

    // EventSystem.ts with GameEvents interface
    fs.writeFileSync(path.join(systemsDir, 'EventSystem.ts'), [
      'export interface GameEvents {',
      '  playerMoved: { x: number; y: number };',
      '  scoreChanged: { score: number };',
      '}',
    ].join('\n'), 'utf8');

    // NotificationBridge.ts with matching union
    fs.writeFileSync(path.join(systemsDir, 'NotificationBridge.ts'), [
      'type NotificationEvent =',
      '  | "playerMoved"',
      '  | "scoreChanged";',
    ].join('\n'), 'utf8');

    // Source file that emits both events
    fs.writeFileSync(path.join(srcDir, 'Player.ts'), [
      'class Player {',
      '  move() { this.events.emit("playerMoved", { x: 1, y: 2 }); }',
      '  score() { this.events.emit("scoreChanged", { score: 10 }); }',
      '}',
    ].join('\n'), 'utf8');

    const result = handlers.handleValidateEventConsistency({
      working_directory: tmpDir,
      event_system_path: path.join(systemsDir, 'EventSystem.ts'),
      bridge_path: path.join(systemsDir, 'NotificationBridge.ts'),
      source_dir: srcDir,
    });

    expect(result.isError).toBeFalsy();
    expect(result._issues.length).toBe(0);
    expect(result._stats.declared).toBe(2);
    expect(result._stats.emitted).toBe(2);
    expect(result.content[0].text).toContain('All clear');
  });

  it('detects emitted-but-undeclared events', () => {
    const srcDir = path.join(tmpDir, 'src');
    const systemsDir = path.join(srcDir, 'systems');
    fs.mkdirSync(systemsDir, { recursive: true });

    fs.writeFileSync(path.join(systemsDir, 'EventSystem.ts'), [
      'export interface GameEvents {',
      '  knownEvent: { data: string };',
      '}',
    ].join('\n'), 'utf8');

    // Source emits an event NOT in GameEvents
    fs.writeFileSync(path.join(srcDir, 'Rogue.ts'), [
      'this.events.emit("unknownEvent", {});',
    ].join('\n'), 'utf8');

    const result = handlers.handleValidateEventConsistency({
      working_directory: tmpDir,
      event_system_path: path.join(systemsDir, 'EventSystem.ts'),
      bridge_path: path.join(tmpDir, 'nonexistent.ts'), // no bridge
      source_dir: srcDir,
    });

    expect(result.isError).toBeFalsy();
    const errors = result._issues.filter(i => i.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some(e => e.message.includes('unknownEvent'))).toBe(true);
  });

  it('reports unsupported_layout when canonical contract files are absent', () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const noop = () => null;\n', 'utf8');

    const result = handlers.handleValidateEventConsistency({
      working_directory: tmpDir,
    });

    expect(result.isError).toBeFalsy();
    expect(result._status).toBe('unsupported_layout');
    expect(result._layout.event_system_exists).toBe(false);
    expect(result.content[0].text).toContain('**Status:** unsupported_layout');
    expect(result.content[0].text).not.toContain('All clear');
  });

  it('returns error for missing working_directory', () => {
    const result = handlers.handleValidateEventConsistency({});
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 7. handleNormalizeInterfaceFormatting
// ════════════════════════════════════════════════════════════════════════════════
describe('handleNormalizeInterfaceFormatting', () => {
  it('fixes inconsistent indentation', () => {
    const fp = tmpFile('drifted.ts', [
      'export interface GameEvents {',
      '    name: string;',
      '      age: number;',
      '  active: boolean;',
      '}',
    ].join('\n'));

    const result = handlers.handleNormalizeInterfaceFormatting({
      file_path: fp,
      interface_name: 'GameEvents',
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
// 8. handleAuditClassCompleteness
// ════════════════════════════════════════════════════════════════════════════════
describe('handleAuditClassCompleteness', () => {
  function setupProjectStructure() {
    const srcDir = path.join(tmpDir, 'src');
    const systemsDir = path.join(srcDir, 'systems');
    const scenesDir = path.join(srcDir, 'scenes');
    fs.mkdirSync(systemsDir, { recursive: true });
    fs.mkdirSync(scenesDir, { recursive: true });

    // System files
    fs.writeFileSync(path.join(systemsDir, 'FooSystem.ts'), 'export class FooSystem {}', 'utf8');
    fs.writeFileSync(path.join(systemsDir, 'BarSystem.ts'), 'export class BarSystem {}', 'utf8');
    fs.writeFileSync(path.join(systemsDir, 'BazSystem.ts'), 'export class BazSystem {}', 'utf8');

    return { systemsDir, scenesDir };
  }

  it('reports fully wired systems as complete', () => {
    const { systemsDir, scenesDir } = setupProjectStructure();

    // GameScene.ts that imports and instantiates all three, with getters
    const gameScene = path.join(scenesDir, 'GameScene.ts');
    fs.writeFileSync(gameScene, [
      'import { FooSystem } from "../systems/FooSystem";',
      'import { BarSystem } from "../systems/BarSystem";',
      'import { BazSystem } from "../systems/BazSystem";',
      '',
      'export class GameScene {',
      '  constructor() {',
      '    this.foo = new FooSystem();',
      '    this.bar = new BarSystem();',
      '    this.baz = new BazSystem();',
      '  }',
      '  getFooSystem() { return this.foo; }',
      '  getBarSystem() { return this.bar; }',
      '  getBazSystem() { return this.baz; }',
      '}',
    ].join('\n'), 'utf8');

    const result = handlers.handleAuditClassCompleteness({
      working_directory: tmpDir,
      systems_dir: systemsDir,
      target_file: gameScene,
      file_pattern: 'System.ts',
      exclude_files: [],
    });

    expect(result.isError).toBeFalsy();
    expect(result._stats.wired).toBe(3);
    expect(result._stats.missingImport).toBe(0);
    expect(result._stats.missingInstantiation).toBe(0);
    expect(result.content[0].text).toContain('All clear');
  });

  it('reports missing imports and instantiations', () => {
    const { systemsDir, scenesDir } = setupProjectStructure();

    // GameScene.ts with only FooSystem wired
    const gameScene = path.join(scenesDir, 'GameScene.ts');
    fs.writeFileSync(gameScene, [
      'import { FooSystem } from "../systems/FooSystem";',
      'export class GameScene {',
      '  constructor() {',
      '    this.foo = new FooSystem();',
      '  }',
      '}',
    ].join('\n'), 'utf8');

    const result = handlers.handleAuditClassCompleteness({
      working_directory: tmpDir,
      systems_dir: systemsDir,
      target_file: gameScene,
      file_pattern: 'System.ts',
      exclude_files: [],
    });

    expect(result.isError).toBeFalsy();
    expect(result._stats.wired).toBe(1);
    expect(result._stats.missingImport).toBe(2);
    expect(result.content[0].text).toContain('BarSystem');
    expect(result.content[0].text).toContain('BazSystem');
  });

  it('returns error for missing systems directory', () => {
    const result = handlers.handleAuditClassCompleteness({
      working_directory: tmpDir,
      systems_dir: path.join(tmpDir, 'nonexistent-dir'),
      target_file: path.join(tmpDir, 'whatever.ts'),
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
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

// ════════════════════════════════════════════════════════════════════════════════
// 12. handleWireSystemToGamescene
// ════════════════════════════════════════════════════════════════════════════════
describe('handleWireSystemToGamescene', () => {
  it('wires a system into a GameScene file', () => {
    const scenesDir = path.join(tmpDir, 'src', 'scenes');
    fs.mkdirSync(scenesDir, { recursive: true });

    const gameScene = path.join(scenesDir, 'GameScene.ts');
    fs.writeFileSync(gameScene, [
      'import { EventSystem } from "../systems/EventSystem";',
      '',
      'export class GameScene {',
      '  private eventSystem!: EventSystem;',
      '  private notificationBridge!: any;',
      '',
      '  constructor() {',
      '    this.eventSystem = new EventSystem();',
      '  }',
      '',
      '  private generateLoanRequestForRandomResident() {',
      '    // internal',
      '  }',
      '}',
    ].join('\n'), 'utf8');

    const result = handlers.handleWireSystemToGamescene({
      working_directory: tmpDir,
      system_name: 'Foo',
      file_path: gameScene,
    });

    expect(result.isError).toBeFalsy();
    const content = read(gameScene);
    expect(content).toContain('import { FooSystem }');
    expect(content).toContain('fooSystem');
  });

  it('returns error for missing required params', () => {
    const result = handlers.handleWireSystemToGamescene({});
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 13. handleWireEventsToEventsystem
// ════════════════════════════════════════════════════════════════════════════════
describe('handleWireEventsToEventsystem', () => {
  it('wires events into an EventSystem file', () => {
    const systemsDir = path.join(tmpDir, 'src', 'systems');
    fs.mkdirSync(systemsDir, { recursive: true });

    const esFile = path.join(systemsDir, 'EventSystem.ts');
    fs.writeFileSync(esFile, [
      'export interface GameEvents {',
      '  existingEvent: { data: string };',
      '}',
    ].join('\n'), 'utf8');

    const result = handlers.handleWireEventsToEventsystem({
      working_directory: tmpDir,
      events: [
        { name: 'newEvent', payload: { count: 'number', label: 'string' } },
      ],
      file_path: esFile,
    });

    expect(result.isError).toBeFalsy();
    const content = read(esFile);
    expect(content).toContain('newEvent');
    expect(content).toContain('count: number');
  });

  it('returns error for missing params', () => {
    const result = handlers.handleWireEventsToEventsystem({});
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('detects duplicate events', () => {
    const systemsDir = path.join(tmpDir, 'src', 'systems');
    fs.mkdirSync(systemsDir, { recursive: true });

    const esFile = path.join(systemsDir, 'EventSystem.ts');
    fs.writeFileSync(esFile, [
      'export interface GameEvents {',
      '  existingEvent: { data: string };',
      '}',
    ].join('\n'), 'utf8');

    const result = handlers.handleWireEventsToEventsystem({
      working_directory: tmpDir,
      events: [{ name: 'existingEvent', payload: { data: 'string' } }],
      file_path: esFile,
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('CONFLICT');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 14. handleWireNotificationsToBridge
// ════════════════════════════════════════════════════════════════════════════════
describe('handleWireNotificationsToBridge', () => {
  function makeBridgeFile() {
    const systemsDir = path.join(tmpDir, 'src', 'systems');
    fs.mkdirSync(systemsDir, { recursive: true });

    const bridgePath = path.join(systemsDir, 'NotificationBridge.ts');
    fs.writeFileSync(bridgePath, [
      'type NotificationEvent =',
      '  | "existing_event";',
      '',
      'class NotificationBridge {',
      '  private toastManager: any;',
      '',
      '  bind() {',
      '    this.bind("existing_event", () => {',
      '      this.toastManager.show("hello", { color: "#fff" });',
      '    });',
      '',
      '    this.connected = true;',
      '  }',
      '}',
    ].join('\n'), 'utf8');

    return bridgePath;
  }

  it('adds union members and bind calls to bridge', () => {
    const bridgePath = makeBridgeFile();

    const result = handlers.handleWireNotificationsToBridge({
      working_directory: tmpDir,
      notifications: [
        {
          event_name: 'score_updated',
          toast_template: 'Score: ${score}',
          color: '#4CAF50',
          icon: 'star',
        },
      ],
      file_path: bridgePath,
    });

    expect(result.isError).toBeFalsy();
    const content = read(bridgePath);
    // Union member added
    expect(content).toContain('"score_updated"');
    // Bind call added
    expect(content).toContain('this.bind("score_updated"');
    expect(content).toContain('this.toastManager.show');
    expect(content).toContain('#4CAF50');
  });

  it('returns error for missing file', () => {
    const result = handlers.handleWireNotificationsToBridge({
      working_directory: tmpDir,
      notifications: [{ event_name: 'x', toast_template: 'x', color: '#fff' }],
      file_path: path.join(tmpDir, 'nonexistent.ts'),
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
  });

  it('returns error for missing required params', () => {
    const result = handlers.handleWireNotificationsToBridge({});
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });
});
