'use strict';

const { defaultContainer } = require('../container');
const { parseMentions } = require('../repo-graph/mention-parser');

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

function getRepoRegistryService() {
  try {
    return defaultContainer.get('repoRegistry');
  } catch (_err) {
    return null;
  }
}

function getGraphIndexerService() {
  try {
    return defaultContainer.get('graphIndexer');
  } catch (_err) {
    return null;
  }
}

function getMentionResolverService() {
  try {
    return defaultContainer.get('mentionResolver');
  } catch (_err) {
    return null;
  }
}

async function handleSearchSymbols(args = {}) {
  try {
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
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Symbol search error: ${err.message}` }] };
  }
}

async function handleGetFileOutline(args = {}) {
  try {
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
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `File outline error: ${err.message}` }] };
  }
}

async function handleIndexProject(args = {}) {
  try {
    const workingDirectory = typeof args.working_directory === 'string' ? args.working_directory.trim() : '';
    if (!workingDirectory) return toErrorResponse('working_directory is required');

    const symbolIndexer = getSymbolIndexerService();
    if (!symbolIndexer) return toErrorResponse('Symbol indexer not initialized');

    const result = await symbolIndexer.indexProject(workingDirectory, {});

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredData: result,
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Index project error: ${err.message}` }] };
  }
}

async function handleRegisterRepo(args = {}) {
  try {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const rootPath = typeof args.root_path === 'string'
      ? args.root_path.trim()
      : typeof args.rootPath === 'string'
        ? args.rootPath.trim()
        : '';
    if (!name) return toErrorResponse('name is required');
    if (!rootPath) return toErrorResponse('root_path is required');

    const repoRegistry = getRepoRegistryService();
    if (!repoRegistry) return toErrorResponse('Repo registry not initialized');

    const repo = repoRegistry.register({
      repo_id: args.repo_id,
      repoId: args.repo_id,
      name,
      root_path: rootPath,
      rootPath,
      remote_url: args.remote_url,
      remoteUrl: args.remote_url,
      default_branch: args.default_branch,
      defaultBranch: args.default_branch,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(repo) }],
      structuredData: repo,
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Register repo error: ${err.message}` }] };
  }
}

async function handleListRepos() {
  try {
    const repoRegistry = getRepoRegistryService();
    if (!repoRegistry) return toErrorResponse('Repo registry not initialized');

    const repos = repoRegistry.list();
    return {
      content: [{ type: 'text', text: JSON.stringify({ count: repos.length, repos }) }],
      structuredData: { count: repos.length, repos },
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `List repos error: ${err.message}` }] };
  }
}

async function handleReindexRepo(args = {}) {
  try {
    const repoId = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
    if (!repoId) return toErrorResponse('repo_id is required');

    const graphIndexer = getGraphIndexerService();
    if (!graphIndexer) return toErrorResponse('Graph indexer not initialized');

    const result = await graphIndexer.indexRepo(repoId);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredData: result,
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Reindex repo error: ${err.message}` }] };
  }
}

async function handleResolveMentions(args = {}) {
  try {
    const text = typeof args.text === 'string' ? args.text : '';
    if (!text.trim()) return toErrorResponse('text is required');

    const mentionResolver = getMentionResolverService();
    if (!mentionResolver) return toErrorResponse('Mention resolver not initialized');

    const parsed = parseMentions(text);
    const resolved = await mentionResolver.resolve(parsed.mentions);
    const result = {
      mention_count: parsed.mentions.length,
      mentions: parsed.mentions,
      stripped_text: parsed.strippedText,
      resolved,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredData: result,
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Resolve mentions error: ${err.message}` }] };
  }
}

module.exports = {
  handleSearchSymbols,
  handleGetFileOutline,
  handleIndexProject,
  handleRegisterRepo,
  handleListRepos,
  handleReindexRepo,
  handleResolveMentions,
};
