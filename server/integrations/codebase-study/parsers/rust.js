'use strict';

module.exports = { extractSymbols };

function extractSymbols(source, filePath) {
  return extractRust(source, filePath);
}

function extractRust(source, filePath) {
  const content = String(source || '');
  return parseRust(content, filePath);
}

function parseRust(content, filePath) {
  return {
    symbols: extractRustSymbols(content, filePath),
    imports: [],
    exports: [],
  };
}

function extractRustSymbols(content, filePath) {
  const lines = String(content || '').split('\n');
  const symbols = [];
  const RUST_PATTERNS = [
    { regex: /^(?:pub\s+)?fn\s+(\w+)/, kind: 'function' },
    { regex: /^(?:pub\s+)?struct\s+(\w+)/, kind: 'class' },
    { regex: /^(?:pub\s+)?impl(?:<[^>]+>)?\s+(\w+)/, kind: 'class' },
    { regex: /^(?:pub\s+)?enum\s+(\w+)/, kind: 'enum' },
    { regex: /^(?:pub\s+)?trait\s+(\w+)/, kind: 'interface' },
    { regex: /^(?:pub\s+)?type\s+(\w+)/, kind: 'type' },
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '').trim();
    if (!line || line.startsWith('//')) {
      continue;
    }
    for (const pattern of RUST_PATTERNS) {
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
