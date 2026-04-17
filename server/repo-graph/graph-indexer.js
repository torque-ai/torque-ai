'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const defaultLogger = require('../logger').child({ component: 'graph-indexer' });
const defaultSymbolIndexer = require('../utils/symbol-indexer');
const { createRepoRegistry } = require('./repo-registry');

const MAX_BODY_PREVIEW_LINES = 20;
const MAX_BODY_PREVIEW_CHARS = 1200;

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('createGraphIndexer requires a sqlite database handle');
  }
}

function validateDependencies(symbolIndexer) {
  if (!symbolIndexer || typeof symbolIndexer.walkProjectFiles !== 'function' || typeof symbolIndexer.indexFile !== 'function') {
    throw new TypeError('createGraphIndexer requires a symbolIndexer with walkProjectFiles() and indexFile()');
  }
}

function normalizeRepoFilePath(rootPath, filePath) {
  const relativePath = path.relative(rootPath, filePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Indexed file is outside repo root: ${filePath}`);
  }
  return relativePath.replace(/\\/g, '/');
}

function buildQualifiedName(repoFilePath, symbolName) {
  const scope = String(repoFilePath || '')
    .replace(/\.[^/.]+$/, '')
    .split('/')
    .filter(Boolean)
    .join('.');

  return scope ? `${scope}.${symbolName}` : symbolName;
}

function buildSymbolId(repoFilePath, symbol) {
  return crypto
    .createHash('sha256')
    .update([
      repoFilePath,
      symbol.kind,
      symbol.name,
      symbol.startLine,
      symbol.endLine,
    ].join(':'))
    .digest('hex')
    .slice(0, 32);
}

function buildBodyPreview(content, symbol) {
  if (typeof content !== 'string' || !content) {
    return null;
  }

  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, Number(symbol.startLine) || 1);
  let endLine = Math.max(startLine, Number(symbol.endLine) || startLine);
  // Regex fallback parser sets endLine === startLine for all symbols,
  // which captures only the declaration line. When endLine isn't meaningful,
  // expand the preview window to capture the body (up to MAX_BODY_PREVIEW_LINES).
  if (endLine === startLine) {
    endLine = startLine + MAX_BODY_PREVIEW_LINES - 1;
  }
  const preview = lines
    .slice(startLine - 1, Math.min(lines.length, endLine, startLine + MAX_BODY_PREVIEW_LINES - 1))
    .join('\n')
    .trim();

  const fallback = String(symbol.signature || '').trim();
  const output = preview || fallback;
  return output ? output.slice(0, MAX_BODY_PREVIEW_CHARS) : null;
}

function validateRepoRoot(rootPath) {
  const normalizedRootPath = String(rootPath || '').trim();
  if (!normalizedRootPath) {
    throw new Error('Registered repo is missing a root_path');
  }

  let stats;
  try {
    stats = fs.statSync(normalizedRootPath);
  } catch {
    throw new Error(`Registered repo root path not found: ${normalizedRootPath}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Registered repo root path is not a directory: ${normalizedRootPath}`);
  }

  return normalizedRootPath;
}

function createGraphIndexer({ db, repoRegistry, symbolIndexer, logger } = {}) {
  requireDb(db);

  const registry = repoRegistry || createRepoRegistry({ db });
  const parserIndexer = symbolIndexer || defaultSymbolIndexer;
  const graphLogger = logger || defaultLogger;
  validateDependencies(parserIndexer);

  if (typeof parserIndexer.init === 'function') {
    parserIndexer.init(db);
  }

  const deleteRepoSymbolsStmt = db.prepare(`
    DELETE FROM repo_symbols
    WHERE repo_id = ?
  `);
  const insertRepoSymbolStmt = db.prepare(`
    INSERT INTO repo_symbols (
      repo_id,
      symbol_id,
      kind,
      name,
      qualified_name,
      file_path,
      start_line,
      end_line,
      body_preview
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const replaceRepoSymbols = db.transaction((repoId, rows) => {
    deleteRepoSymbolsStmt.run(repoId);
    for (const row of rows) {
      insertRepoSymbolStmt.run(
        repoId,
        row.symbol_id,
        row.kind,
        row.name,
        row.qualified_name,
        row.file_path,
        row.start_line,
        row.end_line,
        row.body_preview,
      );
    }
  });

  async function indexRepo(repoId) {
    const repo = registry.get(repoId);
    if (!repo) {
      throw new Error(`Registered repo '${repoId}' not found`);
    }

    const rootPath = validateRepoRoot(repo.rootPath || repo.root_path);
    const files = parserIndexer.walkProjectFiles(rootPath);
    const indexedRows = [];
    let filesIndexed = 0;
    let parseErrors = 0;

    for (const file of files) {
      try {
        const content = fs.readFileSync(file.path, 'utf8');
        const symbols = await parserIndexer.indexFile(file.path, content, rootPath);
        const repoFilePath = normalizeRepoFilePath(rootPath, file.path);

        for (const symbol of symbols) {
          indexedRows.push({
            symbol_id: buildSymbolId(repoFilePath, symbol),
            kind: symbol.kind,
            name: symbol.name,
            qualified_name: buildQualifiedName(repoFilePath, symbol.name),
            file_path: repoFilePath,
            start_line: symbol.startLine || null,
            end_line: symbol.endLine || null,
            body_preview: buildBodyPreview(content, symbol),
          });
        }

        filesIndexed++;
      } catch (err) {
        parseErrors++;
        graphLogger.warn(`Graph indexer: failed to index ${file.path}: ${err.message}`);
      }
    }

    replaceRepoSymbols(repo.repo_id, indexedRows);
    const updatedRepo = registry.markIndexed(repo.repo_id);

    return {
      repo_id: repo.repo_id,
      repo_name: repo.name,
      files_scanned: files.length,
      files_indexed: filesIndexed,
      total_symbols: indexedRows.length,
      parse_errors: parseErrors,
      last_indexed_at: updatedRepo ? updatedRepo.last_indexed_at : null,
    };
  }

  async function indexAll() {
    const repos = registry.list();
    const results = [];
    let totalFilesScanned = 0;
    let totalFilesIndexed = 0;
    let totalSymbols = 0;
    let totalParseErrors = 0;

    for (const repo of repos) {
      const result = await indexRepo(repo.repo_id);
      results.push(result);
      totalFilesScanned += result.files_scanned;
      totalFilesIndexed += result.files_indexed;
      totalSymbols += result.total_symbols;
      totalParseErrors += result.parse_errors;
    }

    return {
      repo_count: repos.length,
      total_files_scanned: totalFilesScanned,
      total_files_indexed: totalFilesIndexed,
      total_symbols: totalSymbols,
      total_parse_errors: totalParseErrors,
      results,
    };
  }

  return {
    indexRepo,
    indexAll,
  };
}

module.exports = {
  createGraphIndexer,
  buildQualifiedName,
  buildSymbolId,
  buildBodyPreview,
};
