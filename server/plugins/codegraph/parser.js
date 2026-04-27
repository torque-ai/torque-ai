'use strict';

const Parser = require('tree-sitter');

// Grammar loaders. Each returns a tree-sitter Language object suitable for
// `parser.setLanguage()`. Most languages publish a CommonJS package; some
// (tree-sitter-c-sharp@0.23.5+) switched to ESM-only and require dynamic
// import. Loaders are async so we can mix the two transparently — this
// supersedes the defensive `try { require(...) } catch {}` workaround in
// commit aea5015d, which kept those grammars *unavailable* on Node 22+
// instead of actually loading them.
const LOADERS = {
  javascript: async () => require('tree-sitter-javascript'),
  typescript: async () => require('tree-sitter-typescript').typescript,
  tsx:        async () => require('tree-sitter-typescript').tsx,
  python:     async () => require('tree-sitter-python'),
  go:         async () => require('tree-sitter-go'),
  csharp:     async () => {
    // tree-sitter-c-sharp@0.23.5 ships as ESM-only ("type": "module").
    // Dynamic import keeps this file CommonJS-compatible.
    const mod = await import('tree-sitter-c-sharp');
    return mod.default || mod;
  },
  powershell: async () => require('tree-sitter-powershell'),
};

const cache = new Map();

async function getParser(language) {
  const loader = LOADERS[language];
  if (!loader) throw new Error(`unsupported language: ${language}`);
  if (cache.has(language)) return cache.get(language);
  const grammar = await loader();
  if (!grammar) throw new Error(`grammar for ${language} loaded as null`);
  const parser = new Parser();
  parser.setLanguage(grammar);
  cache.set(language, parser);
  return parser;
}

function supportedLanguages() {
  return Object.keys(LOADERS);
}

module.exports = { getParser, supportedLanguages };
