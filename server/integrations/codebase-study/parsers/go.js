'use strict';

module.exports = { extractSymbols };

function extractSymbols(source, filePath) {
  return extractGo(source, filePath);
}

function extractGo(source, filePath) {
  const content = String(source || '');
  return parseGo(content, filePath);
}

function parseGo(content, filePath) {
  return {
    symbols: extractGoSymbols(content, filePath),
    imports: [],
    exports: [],
  };
}

function extractGoSymbols(content, filePath) {
  const lines = String(content || '').split('\n');
  const symbols = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '').trim();
    if (!line || line.startsWith('//')) {
      continue;
    }

    let match = line.match(/^func\s*\([^)]*\)\s*(\w+)\s*\(/);
    if (match) {
      symbols.push(buildSymbol(filePath, match[1], 'method', index + 1, line));
      continue;
    }

    match = line.match(/^func\s+(\w+)\s*\(/);
    if (match) {
      symbols.push(buildSymbol(filePath, match[1], 'function', index + 1, line));
      continue;
    }

    match = line.match(/^type\s+(\w+)\b/);
    if (match) {
      symbols.push(buildSymbol(filePath, match[1], 'type', index + 1, line));
    }
  }

  return symbols;
}

function buildSymbol(filePath, name, kind, startLine, signature) {
  return {
    filePath,
    name,
    kind,
    startLine,
    endLine: startLine,
    signature: signature.length > 200 ? signature.slice(0, 200) + '...' : signature,
    exported: false,
  };
}
