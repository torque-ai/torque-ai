// Token-extraction helpers used by the planner to score affinity between
// work items and candidate files. All pure — string transforms over title /
// description / path strings, plus two static stop-word sets.
//
// Extracted from server/factory/loop-controller.js as part of the Phase 1a-prep
// shared-utility lift. Behavior preserved; no signature changes.

const PLAN_RELATED_STOP_WORDS = new Set([
  'about',
  'acceptance',
  'adding',
  'after',
  'against',
  'before',
  'build',
  'command',
  'concrete',
  'cover',
  'create',
  'criteria',
  'current',
  'debug',
  'does',
  'done',
  'edge',
  'ensure',
  'existing',
  'expected',
  'factory',
  'failure',
  'fabro',
  'from',
  'function',
  'handle',
  'implementation',
  'instead',
  'invalid',
  'issue',
  'logic',
  'missing',
  'module',
  'nearest',
  'node',
  'only',
  'package',
  'pass',
  'path',
  'paths',
  'plan',
  'plans',
  'project',
  'provided',
  'requested',
  'return',
  'runner',
  'slice',
  'small',
  'task',
  'tests',
  'that',
  'this',
  'typed',
  'unit',
  'update',
  'uses',
  'valid',
  'verify',
  'with',
  'work',
  'yaml',
]);

const PLAN_RELATED_GENERIC_PATH_TOKENS = new Set([
  ...PLAN_RELATED_STOP_WORDS,
  '__tests__',
  'app',
  'apps',
  'component',
  'components',
  'definition',
  'definitions',
  'doc',
  'docs',
  'extractor',
  'extractors',
  'index',
  'integration',
  'integrations',
  'javascript',
  'jsx',
  'lib',
  'libs',
  'parser',
  'parsers',
  'react',
  'schema',
  'schemas',
  'server',
  'src',
  'spec',
  'template',
  'templates',
  'test',
  'type',
  'types',
  'typescript',
  'tsx',
]);

function normalizePlannerAffinityToken(token) {
  const lower = String(token || '').toLowerCase().trim();
  if (lower.length > 4 && lower.endsWith('ies')) {
    return `${lower.slice(0, -3)}y`;
  }
  if (lower.length > 4 && lower.endsWith('s')) {
    return lower.slice(0, -1);
  }
  return lower;
}

function tokenizePlannerPathForAffinity(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/g)
    .map(normalizePlannerAffinityToken)
    .filter((token) => token.length >= 4 && !PLAN_RELATED_GENERIC_PATH_TOKENS.has(token));
}

function buildPlannerTitleAffinityTokens(workItem) {
  return String(workItem?.title || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/g)
    .map(normalizePlannerAffinityToken)
    .filter((token) => token.length >= 4 && !PLAN_RELATED_GENERIC_PATH_TOKENS.has(token));
}

function tokenizePlannerSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !PLAN_RELATED_STOP_WORDS.has(token));
}

function buildPlannerFileSearchTokens(workItem, seedFiles = []) {
  const tokens = new Set(tokenizePlannerSearchText(`${workItem?.title || ''}\n${workItem?.description || ''}`));
  for (const file of seedFiles || []) {
    for (const token of tokenizePlannerSearchText(file)) {
      tokens.add(token);
    }
  }
  return Array.from(tokens);
}

module.exports = {
  PLAN_RELATED_STOP_WORDS,
  PLAN_RELATED_GENERIC_PATH_TOKENS,
  normalizePlannerAffinityToken,
  tokenizePlannerPathForAffinity,
  buildPlannerTitleAffinityTokens,
  tokenizePlannerSearchText,
  buildPlannerFileSearchTokens,
};
