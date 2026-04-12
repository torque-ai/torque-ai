'use strict';

const fs = require('fs');
const path = require('path');

const DEPENDENCY_EXTENSIONS = ['.js', '.ts', '.json', '.mjs', '.cjs', '.jsx', '.tsx', '.py', '.cs'];

module.exports = { extractSymbols };

function extractSymbols(source, filePath) {
  return extractTs(source, filePath);
}

function extractTs(source, filePath) {
  const content = String(source || '');
  return parseTypeScript(content, filePath);
}

function parseTypeScript(content, filePath) {
  return {
    symbols: extractTypeScriptSymbols(content, filePath),
    imports: extractTypeScriptImports(content, filePath),
    exports: extractTypeScriptExports(content),
  };
}

function extractTypeScriptSymbols(content, filePath) {
  const lines = String(content || '').split('\n');
  const symbols = [];
  const TS_PATTERNS = [
    { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/, kind: 'function' },
    { regex: /^(?:export\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /^(?:export\s+)?interface\s+(\w+)/, kind: 'interface' },
    { regex: /^(?:export\s+)?type\s+(\w+)\s*=/, kind: 'type' },
    { regex: /^(?:export\s+)?enum\s+(\w+)/, kind: 'enum' },
    { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/, kind: 'const' },
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '').trim();
    if (!line || line.startsWith('//') || line.startsWith('*')) {
      continue;
    }
    for (const pattern of TS_PATTERNS) {
      const match = line.match(pattern.regex);
      if (!match) {
        continue;
      }
      symbols.push({
        name: match[1],
        kind: pattern.kind,
        startLine: index + 1,
        endLine: index + 1,
        signature: line.substring(0, 120),
        filePath,
        exported: line.startsWith('export'),
      });
      break;
    }
  }

  return symbols;
}

function extractTypeScriptImports(content, filePath) {
  const dependencies = [];
  const patterns = [
    /\bimport\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const resolved = resolveDependencyPath(match[1], filePath);
      if (resolved) {
        dependencies.push(resolved);
      }
    }
  }

  return uniquePaths(dependencies);
}

function extractTypeScriptExports(content) {
  const exportNames = [];
  const addExport = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return;
    }
    exportNames.push(normalized);
  };

  const declarationPatterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\bmodule\.exports\.([A-Za-z_$][\w$]*)\s*=/g,
    /\bexports\.([A-Za-z_$][\w$]*)\s*=/g,
  ];

  for (const pattern of declarationPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      addExport(match[1]);
    }
  }

  const namedExportPattern = /\bexport\s*\{([^}]+)\}/g;
  let namedExportMatch;
  while ((namedExportMatch = namedExportPattern.exec(content)) !== null) {
    const parts = namedExportMatch[1].split(',');
    for (const part of parts) {
      const normalized = String(part || '').trim();
      if (!normalized) {
        continue;
      }
      const aliasParts = normalized.split(/\s+as\s+/i);
      addExport(aliasParts[1] || aliasParts[0]);
    }
  }

  const commonJsObjectPattern = /\bmodule\.exports\s*=\s*\{([\s\S]*?)\}/g;
  let commonJsObjectMatch;
  while ((commonJsObjectMatch = commonJsObjectPattern.exec(content)) !== null) {
    const block = commonJsObjectMatch[1];
    const propertyPattern = /(?:^|,)\s*(?:([A-Za-z_$][\w$]*)\s*:|([A-Za-z_$][\w$]*)(?=\s*(?:,|$))|['"]([^'"]+)['"]\s*:)/gm;
    let propertyMatch;
    while ((propertyMatch = propertyPattern.exec(block)) !== null) {
      addExport(propertyMatch[1] || propertyMatch[2] || propertyMatch[3]);
    }
  }

  if (/\bexport\s+default\b/.test(content)) {
    addExport('default');
  }

  const commonJsDefaultPatterns = [
    /\bmodule\.exports\s*=\s*(?:async\s+)?function\s*([A-Za-z_$][\w$]*)?/,
    /\bmodule\.exports\s*=\s*class\s*([A-Za-z_$][\w$]*)?/,
  ];
  for (const pattern of commonJsDefaultPatterns) {
    const match = content.match(pattern);
    if (match) {
      addExport(match[1] || 'default');
    }
  }

  return uniqueStrings(exportNames);
}

function toRepoPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
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

function uniquePaths(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = toRepoPath(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function toRepoRelativePath(absolutePath, workingDirectory) {
  return toRepoPath(path.relative(workingDirectory, absolutePath));
}

function resolveDependencyPath(specifier, filePath) {
  const normalized = String(specifier || '').trim();
  if (!normalized) {
    return null;
  }

  if (!normalized.startsWith('.') && !normalized.startsWith('/')) {
    return normalized;
  }

  const workingDirectory = process.cwd();
  const repoPath = path.isAbsolute(String(filePath || ''))
    ? toRepoRelativePath(filePath, workingDirectory)
    : toRepoPath(filePath);
  const baseAbsolute = path.resolve(path.join(workingDirectory, path.dirname(repoPath)), normalized);
  const candidates = [baseAbsolute];
  for (const extension of DEPENDENCY_EXTENSIONS) {
    candidates.push(baseAbsolute + extension);
  }
  for (const extension of DEPENDENCY_EXTENSIONS) {
    candidates.push(path.join(baseAbsolute, 'index' + extension));
  }

  const resolved = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });

  if (resolved) {
    return toRepoRelativePath(resolved, workingDirectory);
  }

  if (baseAbsolute.startsWith(workingDirectory)) {
    return toRepoRelativePath(baseAbsolute, workingDirectory);
  }

  return normalized;
}
