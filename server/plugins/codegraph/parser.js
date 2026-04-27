'use strict';

const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript');

const GRAMMARS = {
  javascript: JavaScript,
  typescript: TypeScript.typescript,
  tsx:        TypeScript.tsx,
};

const cache = new Map();

async function getParser(language) {
  const grammar = GRAMMARS[language];
  if (!grammar) throw new Error(`unsupported language: ${language}`);
  if (cache.has(language)) return cache.get(language);
  const parser = new Parser();
  parser.setLanguage(grammar);
  cache.set(language, parser);
  return parser;
}

function supportedLanguages() {
  return Object.keys(GRAMMARS);
}

module.exports = { getParser, supportedLanguages };
