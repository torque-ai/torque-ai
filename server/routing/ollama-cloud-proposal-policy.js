'use strict';

const READ_ONLY_AGENTIC_TOOLS = Object.freeze(['read_file', 'list_directory', 'search_files']);
const WRITE_VERB_PATTERN = /\b(create|add|write|implement|generate|edit|modify|change|update|refactor|rename|fix|remove|delete|replace|move|insert|append)\b/i;
const DISABLED_MODES = new Set(['direct', 'off', 'disabled', 'none']);

function normalizeProvider(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isOllamaCloudPrimaryTemplate(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'preset-ollama-cloud-primary'
    || normalized === 'ollama-cloud-primary'
    || normalized === 'ollama cloud primary';
}

function chainMentionsOllamaCloud(chain) {
  return Array.isArray(chain)
    && chain.some((entry) => normalizeProvider(entry?.provider || entry) === 'ollama-cloud');
}

function taskLikelyRequiresRepoWrite(taskDescription, files, metadata = {}) {
  if (WRITE_VERB_PATTERN.test(String(taskDescription || ''))) {
    return true;
  }

  const referencedFiles = normalizeStringList(files);
  const metadataFiles = normalizeStringList(metadata.file_paths);
  const requiredPaths = normalizeStringList(
    metadata.agentic_required_modified_paths ?? metadata.required_modified_paths
  );
  return referencedFiles.length > 0 || metadataFiles.length > 0 || requiredPaths.length > 0;
}

function buildOllamaCloudProposalApplyMetadata({
  taskDescription,
  files,
  selectedProvider,
  routingChain,
  routingTemplate,
  userTaskMetadata = {},
} = {}) {
  const metadata = userTaskMetadata && typeof userTaskMetadata === 'object' && !Array.isArray(userTaskMetadata)
    ? userTaskMetadata
    : {};
  const explicitMode = typeof metadata.ollama_cloud_repo_write_mode === 'string'
    ? metadata.ollama_cloud_repo_write_mode.trim().toLowerCase()
    : (typeof metadata.cloud_repo_write_mode === 'string' ? metadata.cloud_repo_write_mode.trim().toLowerCase() : '');

  if (explicitMode && DISABLED_MODES.has(explicitMode)) {
    return {};
  }
  if (!isOllamaCloudPrimaryTemplate(routingTemplate)) {
    return {};
  }
  if (!taskLikelyRequiresRepoWrite(taskDescription, files, metadata)) {
    return {};
  }

  const provider = normalizeProvider(selectedProvider);
  if (provider === 'codex' || provider === 'codex-spark' || provider === 'claude-cli' || provider === 'claude-code-sdk') {
    return {};
  }
  if (provider !== 'ollama-cloud' && !chainMentionsOllamaCloud(routingChain)) {
    return {};
  }

  return {
    ollama_cloud_repo_write_mode: 'proposal_apply',
    proposal_apply_provider: metadata.proposal_apply_provider || 'codex',
    agentic_allowed_tools: READ_ONLY_AGENTIC_TOOLS.slice(),
  };
}

module.exports = {
  READ_ONLY_AGENTIC_TOOLS,
  buildOllamaCloudProposalApplyMetadata,
  chainMentionsOllamaCloud,
  isOllamaCloudPrimaryTemplate,
  taskLikelyRequiresRepoWrite,
};
