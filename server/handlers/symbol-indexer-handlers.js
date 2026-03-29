'use strict';

const { defaultContainer } = require('../container');

function getSymbolIndexerService() {
  try {
    return defaultContainer.get('symbolIndexer');
  } catch (_err) {
    return null;
  }
}

function toErrorResponse(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

async function handleSearchSymbols(args = {}) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const workingDirectory = typeof args.working_directory === 'string' ? args.working_directory.trim() : '';
  if (!query) return toErrorResponse('query is required');
  if (!workingDirectory) return toErrorResponse('working_directory is required');

  const symbolIndexer = getSymbolIndexerService();
  if (!symbolIndexer) return toErrorResponse('Symbol indexer not initialized');

  const results = symbolIndexer.searchSymbols(query, workingDirectory, {
    kind: args.kind,
    limit: args.limit,
  });

  return {
    content: [{ type: 'text', text: JSON.stringify(results) }],
    structuredData: results,
  };
}

async function handleGetFileOutline(args = {}) {
  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
  const workingDirectory = typeof args.working_directory === 'string' ? args.working_directory.trim() : '';
  if (!filePath) return toErrorResponse('file_path is required');
  if (!workingDirectory) return toErrorResponse('working_directory is required');

  const symbolIndexer = getSymbolIndexerService();
  if (!symbolIndexer) return toErrorResponse('Symbol indexer not initialized');

  const outline = symbolIndexer.getFileOutline(filePath, workingDirectory);
  return {
    content: [{ type: 'text', text: JSON.stringify(outline) }],
    structuredData: outline,
  };
}

async function handleIndexProject(args = {}) {
  const workingDirectory = typeof args.working_directory === 'string' ? args.working_directory.trim() : '';
  if (!workingDirectory) return toErrorResponse('working_directory is required');

  const symbolIndexer = getSymbolIndexerService();
  if (!symbolIndexer) return toErrorResponse('Symbol indexer not initialized');

  const result = await symbolIndexer.indexProject(workingDirectory, {});

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredData: result,
  };
}

module.exports = {
  handleSearchSymbols,
  handleGetFileOutline,
  handleIndexProject,
};
