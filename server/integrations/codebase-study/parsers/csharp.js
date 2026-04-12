'use strict';

module.exports = { extractSymbols };

const C_SHARP_BUILTIN_TYPE_NAMES = new Set([
  'action',
  'array',
  'bool',
  'boolean',
  'byte',
  'cancellationtoken',
  'char',
  'collection',
  'datetime',
  'datetimeoffset',
  'decimal',
  'dictionary',
  'double',
  'dynamic',
  'eventargs',
  'exception',
  'float',
  'func',
  'guid',
  'ienumerable',
  'ienumerator',
  'iequalitycomparer',
  'iformattable',
  'ilist',
  'iqueryable',
  'list',
  'long',
  'memory',
  'object',
  'readonlymemory',
  'readonlyspan',
  'result',
  'serviceprovider',
  'short',
  'span',
  'stream',
  'string',
  'task',
  'timespan',
  'token',
  'uri',
  'value',
  'void',
]);

const C_SHARP_PARAMETER_MODIFIERS = new Set(['ref', 'out', 'in', 'params', 'this', 'scoped']);

function extractSymbols(source, filePath) {
  return extractCs(source, filePath);
}

function extractCs(source, filePath) {
  const content = String(source || '');
  return parseCSharp(content, filePath);
}

function parseCSharp(content, filePath) {
  return {
    symbols: extractCSharpSymbols(content, filePath),
    imports: [],
    exports: extractCSharpExplicitExports(content),
  };
}

function extractCSharpSymbols(content, filePath) {
  const lines = String(content || '').split('\n');
  const symbols = [];
  const CSHARP_PATTERNS = [
    { regex: /^(?:public|internal)\s+(?:partial\s+|sealed\s+|abstract\s+|static\s+)*(?:class|struct|record)\s+(\w+)/, kind: 'class' },
    { regex: /^(?:public|internal)\s+interface\s+(\w+)/, kind: 'interface' },
    { regex: /^(?:public|internal)\s+enum\s+(\w+)/, kind: 'enum' },
    { regex: /^(?:public|internal)\s+(?:static\s+|virtual\s+|override\s+|async\s+|sealed\s+|partial\s+)*(?:[\w<>\[\]?,.]+\s+)+(\w+)\s*\(/, kind: 'method' },
    { regex: /^(?:public|internal)\s+(?:static\s+|virtual\s+|override\s+|sealed\s+|partial\s+)*(?:[\w<>\[\]?,.]+\s+)+(\w+)\s*\{\s*(?:get|set)/, kind: 'property' },
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '').trim();
    if (!line || line.startsWith('//') || line.startsWith('*')) {
      continue;
    }
    for (const pattern of CSHARP_PATTERNS) {
      const match = line.match(pattern.regex);
      if (!match) {
        continue;
      }
      const name = String(match[1] || '').trim();
      if (!name || C_SHARP_BUILTIN_TYPE_NAMES.has(name.toLowerCase())) {
        break;
      }
      symbols.push({
        name,
        kind: pattern.kind,
        startLine: index + 1,
        endLine: index + 1,
        signature: line.substring(0, 120),
        filePath,
        exported: /^(?:public|internal)\b/.test(line),
      });
      break;
    }
  }

  return symbols;
}

function extractCSharpExplicitExports(content) {
  const exports = [];
  const patterns = [
    /\b(?:public|internal)\s+(?:partial\s+|sealed\s+|abstract\s+|static\s+)*(?:class|struct|record)\s+([A-Za-z_][\w]*)/g,
    /\b(?:public|internal)\s+interface\s+([A-Za-z_][\w]*)/g,
    /\b(?:public|internal)\s+enum\s+([A-Za-z_][\w]*)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(content || ''))) !== null) {
      exports.push(match[1]);
    }
  }

  return uniqueStrings(exports);
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}
