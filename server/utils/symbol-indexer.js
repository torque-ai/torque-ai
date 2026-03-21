'use strict';

/**
 * AST-level symbol indexer using web-tree-sitter (WASM, no native bindings).
 *
 * Parses project files and extracts symbols (functions, classes, methods,
 * interfaces, types) into a SQLite table for context-stuffing at the
 * symbol level instead of whole-file level.
 *
 * Inspired by Gobby's CodeIndexer (tree-sitter to SQLite, 90%+ token savings).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger').child({ component: 'symbol-indexer' });

// Lazy-loaded tree-sitter parser
let Parser = null;
let parserReady = false;
const languageParsers = new Map(); // ext -> Language

// SQLite handle (injected via init)
let _db = null;

const WASM_DIR = path.join(__dirname, '..', 'node_modules', 'tree-sitter-wasms', 'out');

const LANGUAGE_MAP = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.cs': 'c_sharp',
  '.c': 'c',
  '.cpp': 'cpp',
  '.css': 'css',
};

// Directories to skip during project walk
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next',
  '__pycache__', '.venv', 'venv', 'target', 'vendor', '.cache',
]);

// Max file size to parse (256KB)
const MAX_FILE_SIZE = 256 * 1024;

/**
 * Initialize the symbol indexer with a database instance.
 */
function init(db) {
  _db = db;
  _db.exec(`
    CREATE TABLE IF NOT EXISTS symbol_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT,
      content_hash TEXT,
      working_dir TEXT NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbol_index(name, working_dir);
    CREATE INDEX IF NOT EXISTS idx_symbol_file ON symbol_index(file_path, working_dir);
    CREATE INDEX IF NOT EXISTS idx_symbol_kind ON symbol_index(kind, working_dir);
    CREATE INDEX IF NOT EXISTS idx_symbol_hash ON symbol_index(content_hash);
  `);
}

/**
 * Initialize the WASM parser (async -- must be called before parsing).
 */
async function initParser() {
  if (parserReady) return;
  try {
    const TreeSitter = require('web-tree-sitter');
    await TreeSitter.init();
    Parser = TreeSitter;
    parserReady = true;
    logger.info('[symbol-indexer] Parser initialized (WASM)');
  } catch (err) {
    logger.info('[symbol-indexer] Failed to init parser: ' + err.message);
    throw err;
  }
}

/**
 * Get or load a language parser for a file extension.
 */
async function getLanguageParser(ext) {
  if (!parserReady) await initParser();
  if (languageParsers.has(ext)) return languageParsers.get(ext);

  const langName = LANGUAGE_MAP[ext];
  if (!langName) return null;

  const wasmPath = path.join(WASM_DIR, 'tree-sitter-' + langName + '.wasm');
  if (!fs.existsSync(wasmPath)) {
    logger.info('[symbol-indexer] No WASM grammar for ' + langName);
    return null;
  }

  try {
    const language = await Parser.Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(language);
    languageParsers.set(ext, { parser, language, langName });
    return languageParsers.get(ext);
  } catch (err) {
    logger.info('[symbol-indexer] Failed to load ' + langName + ': ' + err.message);
    return null;
  }
}

/**
 * Classify a tree-sitter node into a symbol kind.
 */
function classifyNode(node, langName) {
  const type = node.type;

  // JavaScript/TypeScript
  if (langName === 'javascript' || langName === 'typescript') {
    if (type === 'function_declaration') return 'function';
    if (type === 'class_declaration') return 'class';
    if (type === 'method_definition') return 'method';
    if (type === 'interface_declaration') return 'interface';
    if (type === 'type_alias_declaration') return 'type';
    if (type === 'enum_declaration') return 'enum';
    if (type === 'arrow_function' && node.parent && node.parent.type === 'variable_declarator') return 'function';
    if (type === 'lexical_declaration' || type === 'variable_declaration') {
      const children = node.namedChildren || [];
      const declarator = children.find(function(c) { return c.type === 'variable_declarator'; });
      if (declarator) {
        const declChildren = declarator.namedChildren || [];
        const init = declChildren.find(function(c) { return c.type === 'arrow_function' || c.type === 'function'; });
        if (init) return 'function';
      }
      return null;
    }
  }

  // Python
  if (langName === 'python') {
    if (type === 'function_definition') return 'function';
    if (type === 'class_definition') return 'class';
  }

  // Rust
  if (langName === 'rust') {
    if (type === 'function_item') return 'function';
    if (type === 'struct_item') return 'class';
    if (type === 'impl_item') return 'class';
    if (type === 'enum_item') return 'enum';
    if (type === 'trait_item') return 'interface';
    if (type === 'type_item') return 'type';
  }

  // Go
  if (langName === 'go') {
    if (type === 'function_declaration') return 'function';
    if (type === 'method_declaration') return 'method';
    if (type === 'type_declaration') return 'type';
  }

  // C#
  if (langName === 'c_sharp') {
    if (type === 'method_declaration') return 'method';
    if (type === 'class_declaration') return 'class';
    if (type === 'interface_declaration') return 'interface';
    if (type === 'enum_declaration') return 'enum';
  }

  return null;
}

/**
 * Extract the name from a symbol node.
 */
function extractNodeName(node) {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  // Arrow functions assigned to variables
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const children = node.namedChildren || [];
    const declarator = children.find(function(c) { return c.type === 'variable_declarator'; });
    if (declarator) {
      const name = declarator.childForFieldName('name');
      if (name) return name.text;
    }
  }

  return null;
}

/**
 * Extract a function/method signature (first line).
 */
function extractSignature(node) {
  const text = node.text || '';
  const firstLine = text.split('\n')[0];
  return firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
}

/**
 * Extract symbols from a parsed AST tree.
 */
function extractSymbols(tree, langName, filePath) {
  const symbols = [];
  const cursor = tree.walk();
  const visited = new Set();

  function walk() {
    const node = cursor.currentNode;
    const nodeId = node.startPosition.row + ':' + node.startPosition.column;
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const kind = classifyNode(node, langName);
    if (kind) {
      const name = extractNodeName(node);
      if (name) {
        symbols.push({
          filePath: filePath,
          name: name,
          kind: kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: extractSignature(node),
        });
      }
    }

    if (cursor.gotoFirstChild()) {
      do { walk(); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }

  walk();
  return symbols;
}

/**
 * Compute content hash for a file.
 */
function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Walk a project directory and return parseable files.
 */
function walkProjectFiles(workingDir) {
  const files = [];

  function walk(dir, depth) {
    if (depth > 10) return;
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(path.join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (LANGUAGE_MAP[ext]) {
          const fullPath = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size <= MAX_FILE_SIZE) {
              files.push({ path: fullPath, ext: ext, size: stat.size });
            }
          } catch { /* skip unreadable */ }
        }
      }
    }
  }

  walk(workingDir, 0);
  return files;
}

/**
 * Get files that need re-indexing (content hash changed).
 */
function getStaleFiles(files, workingDir) {
  if (!_db) return files;

  const stmt = _db.prepare('SELECT file_path, content_hash FROM symbol_index WHERE working_dir = ? GROUP BY file_path');
  const indexed = new Map();
  for (const row of stmt.all(workingDir)) {
    indexed.set(row.file_path, row.content_hash);
  }

  return files.filter(function(f) {
    try {
      const content = fs.readFileSync(f.path, 'utf8');
      const hash = hashContent(content);
      f._content = content;
      f._hash = hash;
      return indexed.get(f.path) !== hash;
    } catch {
      return false;
    }
  });
}

/**
 * Clean up symbols for deleted files.
 */
function cleanupOrphans(workingDir) {
  if (!_db) return 0;

  const stmt = _db.prepare('SELECT DISTINCT file_path FROM symbol_index WHERE working_dir = ?');
  const indexedPaths = stmt.all(workingDir).map(function(r) { return r.file_path; });
  var removed = 0;

  for (const filePath of indexedPaths) {
    if (!fs.existsSync(filePath)) {
      _db.prepare('DELETE FROM symbol_index WHERE file_path = ? AND working_dir = ?').run(filePath, workingDir);
      removed++;
    }
  }

  return removed;
}

/**
 * Index a single file -- parse and store symbols.
 */
async function indexFile(filePath, content, workingDir) {
  const ext = path.extname(filePath).toLowerCase();
  const langParser = await getLanguageParser(ext);
  if (!langParser) return [];

  const tree = langParser.parser.parse(content);
  const symbols = extractSymbols(tree, langParser.langName, filePath);
  const contentHash = hashContent(content);

  if (_db && symbols.length > 0) {
    _db.prepare('DELETE FROM symbol_index WHERE file_path = ? AND working_dir = ?').run(filePath, workingDir);

    const insert = _db.prepare(
      'INSERT INTO symbol_index (file_path, name, kind, start_line, end_line, signature, content_hash, working_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const tx = _db.transaction(function() {
      for (const sym of symbols) {
        insert.run(sym.filePath, sym.name, sym.kind, sym.startLine, sym.endLine, sym.signature, contentHash, workingDir);
      }
    });
    tx();
  }

  return symbols;
}

/**
 * Index an entire project -- incremental (only re-parses changed files).
 */
async function indexProject(workingDir, options) {
  options = options || {};
  if (!_db) throw new Error('Symbol indexer not initialized -- call init(db) first');
  await initParser();

  const allFiles = walkProjectFiles(workingDir);
  const stale = options.force ? allFiles : getStaleFiles(allFiles, workingDir);
  const orphans = cleanupOrphans(workingDir);

  var totalSymbols = 0;
  var filesIndexed = 0;

  for (const file of stale) {
    try {
      const content = file._content || fs.readFileSync(file.path, 'utf8');
      const symbols = await indexFile(file.path, content, workingDir);
      totalSymbols += symbols.length;
      filesIndexed++;
    } catch (err) {
      logger.info('[symbol-indexer] Error indexing ' + file.path + ': ' + err.message);
    }
  }

  logger.info('[symbol-indexer] Indexed ' + filesIndexed + ' files, ' + totalSymbols + ' symbols, ' + orphans + ' orphans cleaned (' + allFiles.length + ' total files scanned)');

  return { filesScanned: allFiles.length, filesIndexed: filesIndexed, totalSymbols: totalSymbols, orphansRemoved: orphans };
}

/**
 * Search symbols by name (prefix, contains, or exact).
 */
function searchSymbols(query, workingDir, options) {
  options = options || {};
  if (!_db) return [];
  const mode = options.mode || 'contains';
  const kind = options.kind || null;
  const limit = options.limit || 50;

  var sql = 'SELECT * FROM symbol_index WHERE working_dir = ?';
  const params = [workingDir];

  if (mode === 'exact') {
    sql += ' AND name = ?';
    params.push(query);
  } else if (mode === 'prefix') {
    sql += ' AND name LIKE ?';
    params.push(query + '%');
  } else {
    sql += ' AND name LIKE ?';
    params.push('%' + query + '%');
  }

  if (kind) {
    sql += ' AND kind = ?';
    params.push(kind);
  }

  sql += ' ORDER BY name LIMIT ?';
  params.push(limit);

  return _db.prepare(sql).all.apply(_db.prepare(sql), params);
}

/**
 * Get the source code for a specific symbol by reading its file lines.
 */
function getSymbolSource(symbolId) {
  if (!_db) return null;
  const sym = _db.prepare('SELECT * FROM symbol_index WHERE id = ?').get(symbolId);
  if (!sym) return null;

  try {
    const content = fs.readFileSync(sym.file_path, 'utf8');
    const lines = content.split('\n');
    const source = lines.slice(sym.start_line - 1, sym.end_line).join('\n');
    return Object.assign({}, sym, { source: source });
  } catch {
    return Object.assign({}, sym, { source: null });
  }
}

/**
 * Get a hierarchical file outline (symbols grouped by file).
 */
function getFileOutline(filePath, workingDir) {
  if (!_db) return [];
  return _db.prepare(
    'SELECT * FROM symbol_index WHERE file_path = ? AND working_dir = ? ORDER BY start_line'
  ).all(filePath, workingDir);
}

module.exports = {
  init: init,
  initParser: initParser,
  indexProject: indexProject,
  indexFile: indexFile,
  searchSymbols: searchSymbols,
  getSymbolSource: getSymbolSource,
  getFileOutline: getFileOutline,
  walkProjectFiles: walkProjectFiles,
  getStaleFiles: getStaleFiles,
  cleanupOrphans: cleanupOrphans,
  hashContent: hashContent,
  LANGUAGE_MAP: LANGUAGE_MAP,
};
