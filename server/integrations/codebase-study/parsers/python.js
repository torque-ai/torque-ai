'use strict';

module.exports = { extractSymbols };

function extractSymbols(source, filePath) {
  return extractPy(source, filePath);
}

function extractPy(source, filePath) {
  const content = String(source || '');
  return parsePython(content, filePath);
}

function parsePython(content, filePath) {
  return {
    symbols: extractPythonSymbols(content, filePath),
    imports: [],
    exports: [],
  };
}

function extractPythonSymbols(content, filePath) {
  const lines = String(content || '').split('\n');
  const symbols = [];
  const PYTHON_PATTERNS = [
    { regex: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/, kind: 'function' },
    { regex: /^\s*class\s+(\w+)/, kind: 'class' },
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '').trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    for (const pattern of PYTHON_PATTERNS) {
      const match = line.match(pattern.regex);
      if (!match) {
        continue;
      }
      symbols.push({
        filePath,
        name: match[1],
        kind: pattern.kind,
        startLine: index + 1,
        endLine: index + 1,
        signature: line.length > 200 ? line.slice(0, 200) + '...' : line,
        exported: false,
      });
      break;
    }
  }

  return symbols;
}
