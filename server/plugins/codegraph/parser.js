'use strict';

const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript');
const Go = require('tree-sitter-go');

// tree-sitter-python and tree-sitter-c-sharp now ship as ESM with top-level
// await, which `require()` refuses with ERR_REQUIRE_ASYNC_MODULE on Node 22+.
// Wrap each in a try/catch so a broken language binding doesn't take the
// whole codegraph plugin (and the ~18 dependent test files) down with it.
// The lookup in `getParser` returns null for unavailable languages — callers
// already handle missing grammars via the `unsupported language` throw path.
let Python = null;
let CSharp = null;
try { Python = require('tree-sitter-python'); } catch (_e) { /* ESM/TLA on newer Node */ }
try { CSharp = require('tree-sitter-c-sharp'); } catch (_e) { /* ESM/TLA on newer Node */ }

const GRAMMARS = {
  javascript: JavaScript,
  typescript: TypeScript.typescript,
  tsx:        TypeScript.tsx,
  python:     Python,
  go:         Go,
  csharp:     CSharp,
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
  // Filter to languages whose grammar actually loaded — Python/C# may be
  // null on Node versions where the binding's ESM/TLA isn't `require()`-able.
  return Object.keys(GRAMMARS).filter((lang) => GRAMMARS[lang] != null);
}

module.exports = { getParser, supportedLanguages };
