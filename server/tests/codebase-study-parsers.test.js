'use strict';

const { createParsers } = require('../integrations/codebase-study/parsers');

describe('codebase-study parsers module', () => {
  const parserFactory = createParsers();
  const fixtures = [
    {
      language: 'javascript',
      filePath: 'fixtures/demo.js',
      symbolName: 'buildWidget',
      source: [
        'import helper from "./helper";',
        '',
        'const label = "widget";',
        '',
        'export function buildWidget() {',
        '  return helper(label);',
        '}',
        '',
        'export { buildWidget as shippedWidget };',
        '',
      ].join('\n'),
    },
    {
      language: 'typescript',
      filePath: 'fixtures/demo.ts',
      symbolName: 'buildTypedWidget',
      source: [
        'import { helper } from "./helper";',
        '',
        'export type Widget = { name: string };',
        '',
        'export function buildTypedWidget(): Widget {',
        '  return helper("typed");',
        '}',
        '',
        'export { buildTypedWidget as shippedWidget };',
        '',
      ].join('\n'),
    },
    {
      language: 'go',
      filePath: 'fixtures/demo.go',
      symbolName: 'BuildWidget',
      source: [
        'package demo',
        '',
        'import "fmt"',
        '',
        'type Widget struct{}',
        '',
        'func BuildWidget() string {',
        '  return fmt.Sprint("ok")',
        '}',
        '',
      ].join('\n'),
    },
    {
      language: 'python',
      filePath: 'fixtures/demo.py',
      symbolName: 'build_widget',
      source: [
        'import os',
        'from pathlib import Path',
        '',
        'class Widget:',
        '    pass',
        '',
        'def build_widget():',
        '    return os.path.join(str(Path.cwd()), "widget")',
        '',
      ].join('\n'),
    },
    {
      language: 'rust',
      filePath: 'fixtures/demo.rs',
      symbolName: 'build_widget',
      source: [
        'use std::fmt;',
        '',
        'pub struct Widget;',
        '',
        'pub fn build_widget() -> String {',
        '    format!("widget")',
        '}',
        '',
        'impl fmt::Display for Widget {',
        '    fn fmt(&self, f: &mut fmt::Formatter<\'_>) -> fmt::Result { write!(f, "Widget") }',
        '}',
      ].join('\n'),
    },
    {
      language: 'csharp',
      filePath: 'fixtures/Demo.cs',
      symbolName: 'BuildWidget',
      source: [
        'using System;',
        'using System.Collections.Generic;',
        '',
        'namespace Demo;',
        '',
        'public class WidgetService',
        '{',
        '  public string BuildWidget() { return String.Empty; }',
        '}',
        '',
      ].join('\n'),
    },
  ];

  it.each(fixtures)('extracts symbols for %s fixtures', ({ language, filePath, symbolName, source }) => {
    const result = parserFactory.extractSymbols(
      {
        path: filePath,
        source,
      },
      language
    );

    expect(Object.keys(result).sort()).toEqual(['exports', 'imports', 'symbols']);
    expect(result).toEqual(expect.objectContaining({
      symbols: expect.any(Array),
      imports: expect.any(Array),
      exports: expect.any(Array),
    }));
    expect(result.symbols.map((symbol) => symbol.name)).toContain(symbolName);
  });

  it('lists the supported parser languages', () => {
    expect(parserFactory.getSupportedLanguages().slice().sort()).toEqual([
      'csharp',
      'go',
      'javascript',
      'python',
      'rust',
      'typescript',
    ]);
  });
});
