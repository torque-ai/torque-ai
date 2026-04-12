'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const defaultSymbolIndexer = require('../../utils/symbol-indexer');

const GENERATED_STUDY_FILES = new Set([
  'docs/architecture/module-index.json',
  'docs/architecture/study-state.json',
  'docs/architecture/knowledge-pack.json',
  'docs/architecture/study-delta.json',
  'docs/architecture/study-evaluation.json',
  'docs/architecture/study-benchmark.json',
  'docs/architecture/SUMMARY.md',
]);
const ALLOWED_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.py', '.cs']);
const JS_LIKE_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);
const SYMBOL_INDEX_EXTENSIONS = new Set([...JS_LIKE_EXTENSIONS, '.py', '.cs']);
const DEPENDENCY_EXTENSIONS = ['.js', '.ts', '.json', '.mjs', '.cjs', '.jsx', '.tsx', '.py', '.cs'];

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
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

function isStudyCandidate(filePath) {
  const normalized = toRepoPath(filePath);
  if (!normalized) {
    return false;
  }

  if (GENERATED_STUDY_FILES.has(normalized)) {
    return false;
  }

  return ALLOWED_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function filterStudyCandidates(values) {
  return uniquePaths(values).filter(isStudyCandidate);
}

function splitGitOutput(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function runGitCommand(workingDirectory, args) {
  const result = spawnSync('git', args, {
    cwd: workingDirectory,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `git ${args.join(' ')} failed with exit code ${result.status}`);
  }

  return (result.stdout || '').trim();
}

function loadTrackedFiles(workingDirectory) {
  return filterStudyCandidates(splitGitOutput(runGitCommand(workingDirectory, ['ls-files'])));
}

function toRepoRelativePath(absolutePath, workingDirectory) {
  return toRepoPath(path.relative(workingDirectory, absolutePath));
}

function resolveDependencyPath(specifier, repoPath, workingDirectory) {
  const normalized = String(specifier || '').trim();
  if (!normalized) {
    return null;
  }

  if (!normalized.startsWith('.') && !normalized.startsWith('/')) {
    return normalized;
  }

  const baseAbsolute = path.resolve(path.join(workingDirectory, path.dirname(repoPath)), normalized);
  const candidates = [baseAbsolute];
  for (const extension of DEPENDENCY_EXTENSIONS) {
    candidates.push(baseAbsolute + extension);
  }
  for (const extension of DEPENDENCY_EXTENSIONS) {
    candidates.push(path.join(baseAbsolute, 'index' + extension));
  }

  const resolved = candidates.find(candidate => {
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

function extractImports(content, repoPath, workingDirectory, extension = path.extname(repoPath).toLowerCase()) {
  if (extension === '.cs') {
    return [];
  }

  const dependencies = [];
  const patterns = [
    /\bimport\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+([.\w]+)\s+import\b/gm,
    /^\s*import\s+([A-Za-z_][\w.]*)\b/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const resolved = resolveDependencyPath(match[1], repoPath, workingDirectory);
      if (resolved) {
        dependencies.push(resolved);
      }
    }
  }

  return uniqueStrings(dependencies);
}

function extractJsonExports(content) {
  try {
    const value = JSON.parse(content);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value);
    }
  } catch {
    // Invalid JSON is handled elsewhere; return no inferred exports here.
  }
  return [];
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

function extractExplicitExports(content, extension) {
  if (extension === '.json') {
    return extractJsonExports(content);
  }
  if (extension === '.cs') {
    return extractCSharpExplicitExports(content);
  }
  if (!JS_LIKE_EXTENSIONS.has(extension)) {
    return [];
  }

  const exportNames = [];
  const addExport = value => {
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

function createScanner(deps = {}) {
  const {
    symbolIndexer = defaultSymbolIndexer,
    logger,
  } = deps;
  const scanLogger = logger || createNoopLogger();

  async function readFileRecords(workingDirectory, files) {
    const records = [];
    for (const repoPath of uniquePaths(files)) {
      const fullPath = path.join(workingDirectory, repoPath);
      try {
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
          continue;
        }
        const content = await fs.promises.readFile(fullPath, 'utf8');
        records.push({
          file: repoPath,
          fullPath,
          content,
          extension: path.extname(repoPath).toLowerCase(),
        });
      } catch (error) {
        scanLogger.debug('[codebase-study] file scan skipped for ' + fullPath + ': ' + (error.message || error));
      }
    }
    return records;
  }

  async function extractSymbolsForFile(fullPath, content, workingDirectory, extension) {
    if (!SYMBOL_INDEX_EXTENSIONS.has(extension)) {
      return [];
    }
    if (!symbolIndexer || typeof symbolIndexer.indexFile !== 'function') {
      return [];
    }

    try {
      return await symbolIndexer.indexFile(fullPath, content, workingDirectory);
    } catch (error) {
      scanLogger.debug('[codebase-study] symbol extraction failed for ' + fullPath + ': ' + (error.message || error));
      return [];
    }
  }

  function listRepoFiles(workingDirectory, profile = {}) {
    const explicitFiles = Array.isArray(profile.files)
      ? profile.files
      : Array.isArray(profile.trackedFiles)
        ? profile.trackedFiles
        : null;
    const files = explicitFiles
      ? filterStudyCandidates(explicitFiles)
      : loadTrackedFiles(workingDirectory);
    const maxFiles = Number.isInteger(profile.maxFiles) && profile.maxFiles > 0
      ? profile.maxFiles
      : null;
    return maxFiles ? files.slice(0, maxFiles) : files;
  }

  async function indexSymbols(workingDirectory, fileRecords) {
    const output = [];
    for (const record of fileRecords) {
      const symbols = await extractSymbolsForFile(
        record.fullPath,
        record.content,
        workingDirectory,
        record.extension
      );
      const exports = extractExplicitExports(record.content, record.extension);
      if (symbols.length === 0 && exports.length === 0) {
        continue;
      }
      output.push({
        file: record.file,
        exports,
        symbols,
      });
    }
    return output;
  }

  function indexImports(workingDirectory, fileRecords) {
    const output = [];
    for (const record of fileRecords) {
      const imports = extractImports(record.content, record.file, workingDirectory, record.extension);
      if (imports.length === 0) {
        continue;
      }
      output.push({
        file: record.file,
        imports,
      });
    }
    return output;
  }

  async function scanRepo(repoPath, profile = {}) {
    if (typeof repoPath !== 'string' || !repoPath.trim()) {
      throw new Error('repoPath must be a non-empty string');
    }

    const workingDirectory = path.resolve(repoPath);
    const files = listRepoFiles(workingDirectory, profile);
    const fileRecords = await readFileRecords(workingDirectory, files);
    const symbols = await indexSymbols(workingDirectory, fileRecords);
    const imports = indexImports(workingDirectory, fileRecords);

    return {
      files: fileRecords.map(record => record.file),
      symbols,
      imports,
    };
  }

  return { scanRepo };
}

module.exports = { createScanner };
