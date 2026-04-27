'use strict';

const path = require('path');
const javascript = require('./javascript');

const EXT_TO_LANGUAGE = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
};

function languageFor(filePath) {
  return EXT_TO_LANGUAGE[path.extname(filePath).toLowerCase()] || null;
}

function extractorFor(filePath) {
  const language = languageFor(filePath);
  if (!language) return null;
  return {
    language,
    extract: (source) => javascript.extractFromSource(source, language),
  };
}

module.exports = { extractorFor, languageFor };
