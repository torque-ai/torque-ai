'use strict';

const path = require('path');
const javascript = require('./javascript');
const python = require('./python');

const EXT_TO_LANGUAGE = {
  '.js':  'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // .jsx routes through the tsx grammar, which is a superset that handles
  // JSX syntax. The plain `javascript` grammar rejects JSX with a parse
  // error, taking down the whole index for one bad file.
  '.jsx': 'tsx',
  '.ts':  'typescript',
  '.tsx': 'tsx',
  '.py':  'python',
  '.pyi': 'python', // type stubs; same grammar
};

// Map language → extractor module. Each module exports extractFromSource(src, lang)
// (the JS extractor takes lang because one module handles javascript/typescript/tsx).
// Single-language extractors (python, future go/rust/etc.) ignore the lang arg.
const EXTRACTORS_BY_LANGUAGE = {
  javascript: javascript,
  typescript: javascript,
  tsx:        javascript,
  python:     python,
};

function languageFor(filePath) {
  return EXT_TO_LANGUAGE[path.extname(filePath).toLowerCase()] || null;
}

function extractorFor(filePath) {
  const language = languageFor(filePath);
  if (!language) return null;
  const ext = EXTRACTORS_BY_LANGUAGE[language];
  if (!ext) return null;
  return {
    language,
    extract: (source) => ext.extractFromSource(source, language),
  };
}

module.exports = { extractorFor, languageFor };
