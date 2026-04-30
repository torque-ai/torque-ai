'use strict';

const fs = require('fs');
const path = require('path');

const WASM_DIR = path.join(__dirname, '..', '..', 'node_modules', 'tree-sitter-wasms', 'out');

const WASM_BY_LANGUAGE = {
  javascript: 'javascript',
  typescript: 'typescript',
  tsx: 'tsx',
  python: 'python',
  go: 'go',
  csharp: 'c_sharp',
  // tree-sitter-wasms does not ship PowerShell yet. Keep the language listed
  // so existing extractor probes fail cleanly and indexing skips .ps1 files.
  powershell: null,
};

const cache = new Map();
let ParserClass = null;
let LanguageClass = null;
let initPromise = null;

async function initRuntime() {
  if (!initPromise) {
    initPromise = (async () => {
      const TreeSitter = require('web-tree-sitter');
      ParserClass = typeof TreeSitter === 'function' ? TreeSitter : (TreeSitter.Parser || TreeSitter);
      if (!ParserClass || typeof ParserClass !== 'function') {
        throw new Error('web-tree-sitter Parser export not found');
      }
      if (typeof ParserClass.init === 'function') {
        await ParserClass.init();
      }
      LanguageClass = ParserClass.Language || (typeof TreeSitter === 'object' ? TreeSitter.Language : null);
      if (!LanguageClass || typeof LanguageClass.load !== 'function') {
        throw new Error('web-tree-sitter Language export not found');
      }
    })();
  }
  await initPromise;
}

async function getParser(language) {
  if (!Object.prototype.hasOwnProperty.call(WASM_BY_LANGUAGE, language)) {
    throw new Error(`unsupported language: ${language}`);
  }
  if (cache.has(language)) return cache.get(language);
  const wasmName = WASM_BY_LANGUAGE[language];
  if (!wasmName) throw new Error(`grammar for ${language} is unavailable`);

  await initRuntime();
  const wasmPath = path.join(WASM_DIR, `tree-sitter-${wasmName}.wasm`);
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`grammar for ${language} is unavailable at ${wasmPath}`);
  }

  const grammar = await LanguageClass.load(wasmPath);
  const parser = new ParserClass();
  parser.setLanguage(grammar);
  cache.set(language, parser);
  return parser;
}

function supportedLanguages() {
  return Object.keys(WASM_BY_LANGUAGE);
}

module.exports = { getParser, supportedLanguages };
