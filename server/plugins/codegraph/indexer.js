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
  const deleteClassEdges    = db.prepare('DELETE FROM cg_class_edges    WHERE repo_path = ?');
  const deleteImports       = db.prepare('DELETE FROM cg_imports        WHERE repo_path = ?');
  const insertImport = db.prepare(`
    INSERT INTO cg_imports (repo_path, file_path, local_name, source_module, source_name, line, col)
    VALUES (@repoPath, @filePath, @localName, @sourceModule, @sourceName, @line, @col)
  `);
  const insertFile = db.prepare(`
    INSERT INTO cg_files (repo_path, file_path, language, content_sha, indexed_at)
    VALUES (@repoPath, @filePath, @language, @contentSha, @indexedAt)
  `);
  const insertSymbol = db.prepare(`
    INSERT INTO cg_symbols (repo_path, file_path, name, kind, start_line, start_col, end_line, end_col, is_exported, is_async, is_generator, is_static)
    VALUES (@repoPath, @filePath, @name, @kind, @startLine, @startCol, @endLine, @endCol, @isExported, @isAsync, @isGenerator, @isStatic)
  `);
  const insertReference = db.prepare(`
    INSERT INTO cg_references (repo_path, file_path, caller_symbol_id, target_name, line, col)
    VALUES (@repoPath, @filePath, @callerSymbolId, @targetName, @line, @col)
  `);
  const insertDispatchEdge = db.prepare(`
    INSERT INTO cg_dispatch_edges (repo_path, file_path, case_string, handler_name, line, col)
    VALUES (@repoPath, @filePath, @caseString, @handlerName, @line, @col)
  `);
  const insertClassEdge = db.prepare(`
    INSERT INTO cg_class_edges (repo_path, file_path, subtype_name, supertype_name, edge_kind, line, col)
    VALUES (@repoPath, @filePath, @subtypeName, @supertypeName, @edgeKind, @line, @col)
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

  let totalFiles = 0, totalSymbols = 0, totalRefs = 0, totalDispatch = 0, totalClassEdges = 0, totalImports = 0;

  const tx = db.transaction(() => {
    deleteImports.run(repoPath);
    deleteClassEdges.run(repoPath);
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
          isExported:  s.isExported  ? 1 : 0,
          isAsync:     s.isAsync     ? 1 : 0,
          isGenerator: s.isGenerator ? 1 : 0,
          isStatic:    s.isStatic    ? 1 : 0,
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

      const cEdges = extracted.classEdges || [];
      for (const e of cEdges) {
        insertClassEdge.run({
          repoPath,
          filePath: rel,
          subtypeName: e.subtypeName,
          supertypeName: e.supertypeName,
          edgeKind: e.edgeKind,
          line: e.line,
          col: e.col,
        });
      }
      totalClassEdges += cEdges.length;

      const imps = extracted.imports || [];
      for (const imp of imps) {
        insertImport.run({
          repoPath,
          filePath: rel,
          localName: imp.localName,
          sourceModule: imp.sourceModule,
          sourceName: imp.sourceName == null ? null : imp.sourceName,
          line: imp.line,
          col:  imp.col,
        });
      }
      totalImports += imps.length;
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
  // Pass 2: resolve references using import map + cross-file symbol lookup.
  // Runs in its own (smaller) transaction. Sets resolved_symbol_id on
  // references whose target name maps through the file's imports to a
  // single exported symbol elsewhere. Stays NULL otherwise — strict-scope
  // queries skip NULLs, loose-scope falls back to identifier match.
  const resolvedCount = resolveReferences({ db, repoPath });

  const result = {
    files: totalFiles,
    symbols: totalSymbols,
    references: totalRefs,
    dispatch_edges: totalDispatch,
    class_edges: totalClassEdges,
    imports: totalImports,
    resolved_references: resolvedCount,
  };
  if (skipped.length > 0) result.skipped = skipped;
  return result;
}

// Incremental reindex: replace rows only for files that changed between
// fromSha and toSha. The caller (index-runner.js) supplies:
//   added/modified/deleted — file path lists from `git diff --name-status`
//   readFileAtSha(filePath)  — returns Buffer of that file at toSha (git show)
//   languageFor(filePath)    — same dispatch as full reindex; returns null for
//                              non-indexable files (skipped silently)
//
// Per-file delete cascade: cg_files / cg_symbols / cg_references /
// cg_dispatch_edges / cg_class_edges all index by (repo_path, file_path)
// — no FK constraints, so we DELETE explicitly. Renamed files come in as
// (deleted: old, added: new) so the old path's rows are dropped naturally.
async function runIncrementalIndex({
  db, repoPath, fromSha, toSha,
  added = [], modified = [], deleted = [],
  readFileAtSha, languageFor,
}) {
  const now = new Date().toISOString();

  // Files needing fresh extraction: added + modified. Renames decompose into
  // delete-old + add-new before reaching us, so a rename's "added" entry is
  // the new path which gets parsed here.
  const toExtract = [...added, ...modified].filter((f) => languageFor(f) != null);
  // Files needing row deletion: anything whose old rows must go. Modified
  // files re-insert after; deleted files don't.
  const toDelete = [...deleted, ...modified, ...added.filter((f) => languageFor(f) != null)];

  const work = [];
  const skipped = [];
  for (const rel of toExtract) {
    const ext = extractorFor(rel);
    if (!ext) continue;
    let buf;
    try {
      buf = readFileAtSha(rel);
    } catch (err) {
      // git show fails when the file is gone (race) or pointed at a sha that
      // doesn't contain it. Skip; the row stays absent which matches reality.
      skipped.push({ file: rel, reason: 'read', error: err.message });
      continue;
    }
    const source = buf.toString('utf8');
    let extracted;
    try {
      extracted = await ext.extract(source);
    } catch (err) {
      skipped.push({ file: rel, reason: 'parse', error: err.message });
      continue;
    }
    work.push({ rel, language: ext.language, contentSha: sha256(buf), extracted });
  }

  const deleteFileRows         = db.prepare('DELETE FROM cg_files          WHERE repo_path = ? AND file_path = ?');
  const deleteSymbolRows       = db.prepare('DELETE FROM cg_symbols        WHERE repo_path = ? AND file_path = ?');
  const deleteReferenceRows    = db.prepare('DELETE FROM cg_references     WHERE repo_path = ? AND file_path = ?');
  const deleteDispatchEdgeRows = db.prepare('DELETE FROM cg_dispatch_edges WHERE repo_path = ? AND file_path = ?');
  const deleteClassEdgeRows    = db.prepare('DELETE FROM cg_class_edges    WHERE repo_path = ? AND file_path = ?');
  const deleteImportRows       = db.prepare('DELETE FROM cg_imports        WHERE repo_path = ? AND file_path = ?');

  const insertFile = db.prepare(`
    INSERT INTO cg_files (repo_path, file_path, language, content_sha, indexed_at)
    VALUES (@repoPath, @filePath, @language, @contentSha, @indexedAt)
  `);
  const insertSymbol = db.prepare(`
    INSERT INTO cg_symbols (repo_path, file_path, name, kind, start_line, start_col, end_line, end_col, is_exported, is_async, is_generator, is_static)
    VALUES (@repoPath, @filePath, @name, @kind, @startLine, @startCol, @endLine, @endCol, @isExported, @isAsync, @isGenerator, @isStatic)
  `);
  const insertReference = db.prepare(`
    INSERT INTO cg_references (repo_path, file_path, caller_symbol_id, target_name, line, col)
    VALUES (@repoPath, @filePath, @callerSymbolId, @targetName, @line, @col)
  `);
  const insertDispatchEdge = db.prepare(`
    INSERT INTO cg_dispatch_edges (repo_path, file_path, case_string, handler_name, line, col)
    VALUES (@repoPath, @filePath, @caseString, @handlerName, @line, @col)
  `);
  const insertClassEdge = db.prepare(`
    INSERT INTO cg_class_edges (repo_path, file_path, subtype_name, supertype_name, edge_kind, line, col)
    VALUES (@repoPath, @filePath, @subtypeName, @supertypeName, @edgeKind, @line, @col)
  `);
  const insertImport = db.prepare(`
    INSERT INTO cg_imports (repo_path, file_path, local_name, source_module, source_name, line, col)
    VALUES (@repoPath, @filePath, @localName, @sourceModule, @sourceName, @line, @col)
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
  const countFiles      = db.prepare('SELECT COUNT(*) AS c FROM cg_files      WHERE repo_path = ?');
  const countSymbols    = db.prepare('SELECT COUNT(*) AS c FROM cg_symbols    WHERE repo_path = ?');
  const countReferences = db.prepare('SELECT COUNT(*) AS c FROM cg_references WHERE repo_path = ?');

  let filesAdded = 0, filesModified = 0, filesDeleted = 0;
  let newSymbols = 0, newRefs = 0, newDispatch = 0, newClassEdges = 0;

  const tx = db.transaction(() => {
    // Drop rows for every changed file in one pass — modified files will get
    // re-inserted from `work` below, deleted files stay gone.
    for (const rel of toDelete) {
      deleteImportRows.run(repoPath, rel);
      deleteClassEdgeRows.run(repoPath, rel);
      deleteDispatchEdgeRows.run(repoPath, rel);
      deleteReferenceRows.run(repoPath, rel);
      deleteSymbolRows.run(repoPath, rel);
      deleteFileRows.run(repoPath, rel);
    }
    filesDeleted = deleted.filter((f) => languageFor(f) != null).length;

    for (const { rel, language, contentSha, extracted } of work) {
      insertFile.run({ repoPath, filePath: rel, language, contentSha, indexedAt: now });
      if (added.includes(rel)) filesAdded++;
      else filesModified++;

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
          isExported:  s.isExported  ? 1 : 0,
          isAsync:     s.isAsync     ? 1 : 0,
          isGenerator: s.isGenerator ? 1 : 0,
          isStatic:    s.isStatic    ? 1 : 0,
        });
        symbolIds.push(info.lastInsertRowid);
      }
      newSymbols += extracted.symbols.length;

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
      newRefs += extracted.references.length;

      const edges = extracted.dispatchEdges || [];
      for (const e of edges) {
        insertDispatchEdge.run({
          repoPath, filePath: rel,
          caseString: e.caseString, handlerName: e.handlerName,
          line: e.line, col: e.col,
        });
      }
      newDispatch += edges.length;

      const cEdges = extracted.classEdges || [];
      for (const e of cEdges) {
        insertClassEdge.run({
          repoPath, filePath: rel,
          subtypeName: e.subtypeName, supertypeName: e.supertypeName,
          edgeKind: e.edgeKind,
          line: e.line, col: e.col,
        });
      }
      newClassEdges += cEdges.length;

      const imps = extracted.imports || [];
      for (const imp of imps) {
        insertImport.run({
          repoPath, filePath: rel,
          localName: imp.localName,
          sourceModule: imp.sourceModule,
          sourceName: imp.sourceName == null ? null : imp.sourceName,
          line: imp.line, col: imp.col,
        });
      }
    }

    // Recompute repo-wide totals after deletes + inserts. cg_index_state
    // tracks aggregate counts for cg_index_status callers — must reflect
    // the post-incremental state, not the pre-incremental snapshot.
    const totals = {
      files: countFiles.get(repoPath).c,
      symbols: countSymbols.get(repoPath).c,
      refs: countReferences.get(repoPath).c,
    };
    upsertState.run({
      repoPath,
      commitSha: toSha || '',
      indexedAt: now,
      ...totals,
    });
  });

  tx();

  // Clear dangling resolved_symbol_id values: when a file is deleted or
  // modified, its old symbol rows go away with new IDs assigned to the new
  // ones. References from OTHER files that pointed at the old IDs need to
  // be re-resolved or they'd point at ghosts. One UPDATE handles all of
  // them; pass 2 below re-resolves the now-NULL rows.
  db.prepare(`
    UPDATE cg_references
    SET resolved_symbol_id = NULL
    WHERE repo_path = @repoPath
      AND resolved_symbol_id IS NOT NULL
      AND resolved_symbol_id NOT IN (SELECT id FROM cg_symbols WHERE repo_path = @repoPath)
  `).run({ repoPath });

  // Pass 2: re-resolve references for the entire repo.
  const resolvedCount = resolveReferences({ db, repoPath });

  const result = {
    incremental: true,
    from_sha: fromSha,
    to_sha: toSha,
    files_added: filesAdded,
    files_modified: filesModified,
    files_deleted: filesDeleted,
    new_symbols: newSymbols,
    new_references: newRefs,
    new_dispatch_edges: newDispatch,
    resolved_references_added: resolvedCount,
    new_class_edges: newClassEdges,
    // Repo-wide totals after the incremental update — same shape as the full
    // reindex result so downstream callers (cg_index_status) don't branch.
    files: countFiles.get(repoPath).c,
    symbols: countSymbols.get(repoPath).c,
    references: countReferences.get(repoPath).c,
  };
  if (skipped.length > 0) result.skipped = skipped;
  return result;
}

// Resolve a `./bar`-style relative module specifier against the importing
// file's path. Tries the literal target plus common file extensions and
// `/index` resolution. Returns the relative path (matching cg_files.file_path)
// of the first match, or null. Bare specifiers ('fmt', 'System.IO', 'lodash')
// resolve to null — those are cross-package imports we can't reach.
function resolveRelativeModule(db, repoPath, importingFile, sourceModule) {
  if (!sourceModule || (!sourceModule.startsWith('.') && !sourceModule.startsWith('/'))) {
    return null;
  }
  const path = require('path');
  // Drop the importing file's basename, then resolve the module spec against
  // its dir. Use POSIX semantics so cg_files paths (forward slashes) match.
  const importerDir = path.posix.dirname(importingFile.replace(/\\/g, '/'));
  const joined = path.posix.normalize(path.posix.join(importerDir, sourceModule));

  const lookup = db.prepare(
    'SELECT file_path FROM cg_files WHERE repo_path = ? AND file_path = ? LIMIT 1'
  );
  // Direct hit (already has extension, e.g. './bar.js').
  const direct = lookup.get(repoPath, joined);
  if (direct) return direct.file_path;
  // Try common extensions.
  for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.cs']) {
    const row = lookup.get(repoPath, joined + ext);
    if (row) return row.file_path;
  }
  // index files: ./bar → ./bar/index.{ext}
  for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py']) {
    const row = lookup.get(repoPath, joined + '/index' + ext);
    if (row) return row.file_path;
  }
  return null;
}

// Pass 2: resolve cg_references rows by joining against cg_imports + cg_symbols.
// For each unresolved reference, look up the file's import for `target_name`.
// If the import points to a same-repo file, find an exported symbol by name
// and set resolved_symbol_id. Cross-package or ambiguous imports stay NULL.
function resolveReferences({ db, repoPath }) {
  const refsToResolve = db.prepare(`
    SELECT r.id, r.file_path, r.target_name
    FROM cg_references r
    WHERE r.repo_path = @repoPath AND r.resolved_symbol_id IS NULL
  `).all({ repoPath });

  const importLookup = db.prepare(`
    SELECT source_module, source_name
    FROM cg_imports
    WHERE repo_path = @repoPath AND file_path = @filePath AND local_name = @localName
    LIMIT 1
  `);
  const symbolLookup = db.prepare(`
    SELECT id FROM cg_symbols
    WHERE repo_path = @repoPath AND file_path = @filePath AND name = @name
    LIMIT 1
  `);
  const updateRef = db.prepare(`
    UPDATE cg_references SET resolved_symbol_id = @resolvedId WHERE id = @id
  `);

  let resolved = 0;
  const tx = db.transaction(() => {
    for (const r of refsToResolve) {
      const imp = importLookup.get({ repoPath, filePath: r.file_path, localName: r.target_name });
      if (!imp) continue;
      // Cross-package: source_module doesn't start with './' or '../' or '/'.
      // Stays NULL — we can't reach into npm packages, Go stdlib, etc.
      const targetFile = resolveRelativeModule(db, repoPath, r.file_path, imp.source_module);
      if (!targetFile) continue;
      // If source_name is null (namespace import / module-level binding),
      // we can't pick a single symbol; leave unresolved. Slice B will use
      // cg_locals to handle `obj.foo()` calls through namespace imports.
      const targetName = imp.source_name;
      if (!targetName || targetName === 'default') continue;
      const sym = symbolLookup.get({ repoPath, filePath: targetFile, name: targetName });
      if (!sym) continue;
      updateRef.run({ resolvedId: sym.id, id: r.id });
      resolved++;
    }
  });
  tx();
  return resolved;
}

module.exports = { runIndex, runIncrementalIndex, resolveReferences };
