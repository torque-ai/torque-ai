'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { extractorFor } = require('./extractors');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function runIndex({ db, repoPath, files, commitSha = null, _sourceDir = null }) {
  const now = new Date().toISOString();

  const deleteFiles         = db.prepare('DELETE FROM cg_files          WHERE repo_path = ?');
  const deleteSymbols       = db.prepare('DELETE FROM cg_symbols        WHERE repo_path = ?');
  const deleteReferences    = db.prepare('DELETE FROM cg_references     WHERE repo_path = ?');
  const deleteDispatchEdges = db.prepare('DELETE FROM cg_dispatch_edges WHERE repo_path = ?');
  const insertFile = db.prepare(`
    INSERT INTO cg_files (repo_path, file_path, language, content_sha, indexed_at)
    VALUES (@repoPath, @filePath, @language, @contentSha, @indexedAt)
  `);
  const insertSymbol = db.prepare(`
    INSERT INTO cg_symbols (repo_path, file_path, name, kind, start_line, start_col, end_line, end_col, is_exported)
    VALUES (@repoPath, @filePath, @name, @kind, @startLine, @startCol, @endLine, @endCol, @isExported)
  `);
  const insertReference = db.prepare(`
    INSERT INTO cg_references (repo_path, file_path, caller_symbol_id, target_name, line, col)
    VALUES (@repoPath, @filePath, @callerSymbolId, @targetName, @line, @col)
  `);
  const insertDispatchEdge = db.prepare(`
    INSERT INTO cg_dispatch_edges (repo_path, file_path, case_string, handler_name, line, col)
    VALUES (@repoPath, @filePath, @caseString, @handlerName, @line, @col)
  `);
  const upsertState = db.prepare(`
    INSERT INTO cg_index_state (repo_path, commit_sha, indexed_at, files, symbols, references_count)
    VALUES (@repoPath, @commitSha, @indexedAt, @files, @symbols, @refs)
    ON CONFLICT(repo_path) DO UPDATE SET
      commit_sha = excluded.commit_sha,
      indexed_at = excluded.indexed_at,
      files      = excluded.files,
      symbols    = excluded.symbols,
      references_count = excluded.references_count
  `);

  const work = [];
  const skipped = [];
  for (const rel of files) {
    const ext = extractorFor(rel);
    if (!ext) continue;
    const abs = path.join(_sourceDir || repoPath, rel);
    let buf;
    try {
      buf = await fs.readFile(abs);
    } catch (err) {
      skipped.push({ file: rel, reason: 'read', error: err.message });
      continue;
    }
    const source = buf.toString('utf8');
    let extracted;
    try {
      extracted = await ext.extract(source);
    } catch (err) {
      // Tree-sitter throws on files it can't parse (binary blobs renamed
      // to .js, exotic syntax extensions, oversize source). Skip and keep
      // indexing — a single bad file shouldn't take down the whole graph.
      skipped.push({ file: rel, reason: 'parse', error: err.message });
      continue;
    }
    work.push({ rel, language: ext.language, contentSha: sha256(buf), extracted });
  }

  let totalFiles = 0, totalSymbols = 0, totalRefs = 0, totalDispatch = 0;

  const tx = db.transaction(() => {
    deleteDispatchEdges.run(repoPath);
    deleteReferences.run(repoPath);
    deleteSymbols.run(repoPath);
    deleteFiles.run(repoPath);

    for (const { rel, language, contentSha, extracted } of work) {
      insertFile.run({
        repoPath, filePath: rel, language, contentSha, indexedAt: now,
      });
      totalFiles++;

      const symbolIds = [];
      for (const s of extracted.symbols) {
        const info = insertSymbol.run({
          repoPath,
          filePath: rel,
          name: s.name,
          kind: s.kind,
          startLine: s.startLine,
          startCol:  s.startCol,
          endLine:   s.endLine,
          endCol:    s.endCol,
          isExported: s.isExported ? 1 : 0,
        });
        symbolIds.push(info.lastInsertRowid);
      }
      totalSymbols += extracted.symbols.length;

      for (const r of extracted.references) {
        const callerId = r.callerSymbolIndex == null ? null : symbolIds[r.callerSymbolIndex];
        insertReference.run({
          repoPath,
          filePath: rel,
          callerSymbolId: callerId,
          targetName: r.targetName,
          line: r.line,
          col:  r.col,
        });
      }
      totalRefs += extracted.references.length;

      const edges = extracted.dispatchEdges || [];
      for (const e of edges) {
        insertDispatchEdge.run({
          repoPath,
          filePath: rel,
          caseString: e.caseString,
          handlerName: e.handlerName,
          line: e.line,
          col: e.col,
        });
      }
      totalDispatch += edges.length;
    }

    upsertState.run({
      repoPath,
      commitSha: commitSha || '',
      indexedAt: now,
      files: totalFiles,
      symbols: totalSymbols,
      refs: totalRefs,
    });
  });

  tx();

  const result = { files: totalFiles, symbols: totalSymbols, references: totalRefs, dispatch_edges: totalDispatch };
  if (skipped.length > 0) result.skipped = skipped;
  return result;
}

module.exports = { runIndex };
