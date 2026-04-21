'use strict';

/**
 * Handlers for competitive-analysis-inspired features.
 * Auto-discovered by tools.js routeMap via handleXxx naming convention.
 */

// logger available if needed: require('../logger').child({ component: 'competitive-features' })
const { defaultContainer } = require('../container');

let competitiveFeatureHandlerDeps = {};

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeCompetitiveFeatureHandlerDeps(deps = {}) {
  const normalized = {};
  if (hasOwn(deps, 'db')) normalized.db = deps.db;
  if (hasOwn(deps, 'database')) normalized.db = deps.database;
  if (hasOwn(deps, 'databaseFacade')) normalized.db = deps.databaseFacade;
  if (hasOwn(deps, 'rawDb')) normalized.rawDb = deps.rawDb;
  if (hasOwn(deps, 'container')) normalized.container = deps.container;
  return normalized;
}

function init(deps = {}) {
  competitiveFeatureHandlerDeps = normalizeCompetitiveFeatureHandlerDeps(deps);
  return module.exports;
}

function getContainer() {
  return hasOwn(competitiveFeatureHandlerDeps, 'container')
    ? competitiveFeatureHandlerDeps.container
    : defaultContainer;
}

function getContainerValue(name) {
  const container = getContainer();
  if (!container || typeof container.get !== 'function') {
    return null;
  }
  try {
    if (typeof container.has === 'function' && !container.has(name)) {
      return null;
    }
    return container.get(name);
  } catch (_e) {
    return null;
  }
}

function unwrapDb(db) {
  return db && typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;
}

function getDbDependency() {
  if (hasOwn(competitiveFeatureHandlerDeps, 'rawDb')) {
    return competitiveFeatureHandlerDeps.rawDb;
  }
  if (hasOwn(competitiveFeatureHandlerDeps, 'db')) {
    return competitiveFeatureHandlerDeps.db;
  }
  return getContainerValue('db');
}

function getRawDbDependency() {
  return unwrapDb(getDbDependency());
}

function withCompetitiveFeatureHandlerDeps(deps, handler) {
  return (...args) => {
    const previousDeps = competitiveFeatureHandlerDeps;
    competitiveFeatureHandlerDeps = deps;
    try {
      const result = handler(...args);
      if (result && typeof result.then === 'function') {
        return result.finally(() => {
          competitiveFeatureHandlerDeps = previousDeps;
        });
      }
      competitiveFeatureHandlerDeps = previousDeps;
      return result;
    } catch (err) {
      competitiveFeatureHandlerDeps = previousDeps;
      throw err;
    }
  };
}

// ─── Provider Comparison ─────────────────────────────────────────────────

async function handleCompareProviders(args) {
  const { handleCompareProviders: impl } = require('./comparison-handler');
  return impl(args);
}

// ─── Code Review ─────────────────────────────────────────────────────────

async function handleReviewTaskOutput(args) {
  const { handleReviewTaskOutput: impl } = require('./review-handler');
  return impl(args);
}

// ─── Project Template Detection ──────────────────────────────────────────

async function handleDetectProjectType(args) {
  const { detectProjectType } = require('../templates/registry');
  const workingDir = args.working_directory;
  if (!workingDir) {
    return { content: [{ type: 'text', text: 'working_directory is required' }], isError: true };
  }
  const detected = detectProjectType(workingDir);
  if (!detected) {
    return { content: [{ type: 'text', text: `No project type detected in ${workingDir}` }] };
  }
  let text = `## Project Type Detected: ${detected.name || detected.id}\n\n`;
  text += `**Template ID:** ${detected.id}\n`;
  text += `**Priority:** ${detected.priority}\n`;
  text += `**Confidence:** ${detected.score || detected.confidence || 'N/A'}\n\n`;
  text += `### Agent Context\n\`\`\`\n${detected.agent_context}\n\`\`\`\n`;
  return { content: [{ type: 'text', text }], structuredData: detected };
}

async function handleListProjectTemplates(_args) {
  const { listTemplates } = require('../templates/registry');
  const templates = listTemplates();
  let text = '## Available Project Templates\n\n';
  text += '| ID | Priority | Markers |\n|---|---|---|\n';
  for (const t of templates) {
    text += `| ${t.id} | ${t.priority} | ${(t.markers || []).join(', ')} |\n`;
  }
  return { content: [{ type: 'text', text }], structuredData: templates };
}

// ─── Provider Scores ─────────────────────────────────────────────────────

async function handleGetProviderScores(args) {
  const scoring = require('../db/provider-scoring');
  const inst = getRawDbDependency();
  if (!inst) return { content: [{ type: 'text', text: 'Database not available' }], isError: true };
  scoring.init(inst);
  const trustedOnly = args.trusted_only !== false;
  const scores = scoring.getAllProviderScores({ trustedOnly });
  if (scores.length === 0) {
    return { content: [{ type: 'text', text: trustedOnly ? 'No trusted provider scores yet (need 5+ task completions per provider)' : 'No provider scores recorded yet' }] };
  }
  let text = '## Provider Scores\n\n';
  text += '| Provider | Composite | Reliability | Speed | Quality | Cost | Samples | Trusted |\n';
  text += '|----------|-----------|-------------|-------|---------|------|---------|---------|\n';
  for (const s of scores) {
    text += `| ${s.provider} | ${(s.composite_score || 0).toFixed(3)} | ${(s.reliability_score || 0).toFixed(2)} | ${(s.speed_score || 0).toFixed(2)} | ${(s.quality_score || 0).toFixed(2)} | ${(s.cost_efficiency || 0).toFixed(2)} | ${s.sample_count} | ${s.trusted ? 'Yes' : 'No'} |\n`;
  }
  return { content: [{ type: 'text', text }], structuredData: scores };
}

// ─── Circuit Breaker Status ──────────────────────────────────────────────

async function handleGetCircuitBreakerStatus(_args) {
  const cb = require('../execution/circuit-breaker');
  const open = cb.getAllOpenCircuits();
  if (open.length === 0) {
    return { content: [{ type: 'text', text: 'All circuits closed — no providers tripped.' }] };
  }
  let text = '## Circuit Breaker Status\n\n';
  text += '| Provider | State | Consecutive Failures | Category | Tripped At |\n';
  text += '|----------|-------|---------------------|----------|------------|\n';
  const details = [];
  for (const provider of open) {
    const state = cb.getState(provider);
    text += `| ${provider} | ${state.state} | ${state.consecutiveFailures} | ${state.lastFailureCategory} | ${state.trippedAt ? new Date(state.trippedAt).toISOString() : '-'} |\n`;
    details.push({ provider, ...state });
  }
  return { content: [{ type: 'text', text }], structuredData: details };
}

// ─── Task Polish ─────────────────────────────────────────────────────────

async function handlePolishTaskDescription(args) {
  const { polishTaskDescription } = require('../utils/task-polish');
  const raw = args.text || args.description || '';
  if (!raw) return { content: [{ type: 'text', text: 'No text provided' }], isError: true };
  const result = polishTaskDescription(raw);
  let text = `## Polished Task\n\n**Title:** ${result.title}\n`;
  if (result.description) text += `**Description:** ${result.description}\n`;
  if (result.acceptanceCriteria.length > 0) {
    text += `\n**Acceptance Criteria:**\n`;
    for (const c of result.acceptanceCriteria) text += `- ${c}\n`;
  }
  return { content: [{ type: 'text', text }], structuredData: result };
}

// ─── Symbol Indexing ─────────────────────────────────────────────────────

async function handleIndexProject(args) {
  const indexer = require('../utils/symbol-indexer');
  const inst = getDbDependency();
  if (!inst) return { content: [{ type: 'text', text: 'Database not available' }], isError: true };
  const workingDir = args.working_directory;
  if (!workingDir) return { content: [{ type: 'text', text: 'working_directory is required' }], isError: true };
  indexer.init(inst);
  const result = await indexer.indexProject(workingDir, { force: args.force || false });
  let text = `## Symbol Index Results\n\n`;
  text += `**Files scanned:** ${result.filesScanned}\n`;
  text += `**Files indexed:** ${result.filesIndexed}\n`;
  text += `**Symbols found:** ${result.totalSymbols}\n`;
  text += `**Orphans removed:** ${result.orphansRemoved}\n`;
  return { content: [{ type: 'text', text }], structuredData: result };
}

async function handleSearchSymbols(args) {
  const indexer = require('../utils/symbol-indexer');
  const inst = getDbDependency();
  if (!inst) return { content: [{ type: 'text', text: 'Database not available' }], isError: true };
  indexer.init(inst);
  const results = indexer.searchSymbols(args.query || '', args.working_directory || '', {
    mode: args.mode || 'contains',
    kind: args.kind || null,
    limit: args.limit || 20,
  });
  if (results.length === 0) {
    return { content: [{ type: 'text', text: `No symbols matching "${args.query}"` }] };
  }
  let text = `## Symbol Search: "${args.query}"\n\n`;
  text += '| Name | Kind | File | Lines |\n|------|------|------|-------|\n';
  for (const s of results) {
    const shortPath = s.file_path.split(/[/\\]/).slice(-3).join('/');
    text += `| ${s.name} | ${s.kind} | ${shortPath} | ${s.start_line}-${s.end_line} |\n`;
  }
  return { content: [{ type: 'text', text }], structuredData: results };
}

async function handleGetSymbolSource(args) {
  const indexer = require('../utils/symbol-indexer');
  const inst = getDbDependency();
  if (!inst) return { content: [{ type: 'text', text: 'Database not available' }], isError: true };
  indexer.init(inst);
  const result = indexer.getSymbolSource(args.symbol_id);
  if (!result) return { content: [{ type: 'text', text: 'Symbol not found' }], isError: true };
  let text = `## ${result.name} (${result.kind})\n`;
  text += `**File:** ${result.file_path}:${result.start_line}-${result.end_line}\n\n`;
  text += '```\n' + (result.source || '(source unavailable)') + '\n```\n';
  return { content: [{ type: 'text', text }], structuredData: result };
}

async function handleGetFileOutline(args) {
  const indexer = require('../utils/symbol-indexer');
  const inst = getDbDependency();
  if (!inst) return { content: [{ type: 'text', text: 'Database not available' }], isError: true };
  indexer.init(inst);
  const results = indexer.getFileOutline(args.file_path || '', args.working_directory || '');
  if (results.length === 0) {
    return { content: [{ type: 'text', text: 'No symbols found in file (may need indexing first)' }] };
  }
  let text = `## File Outline: ${args.file_path}\n\n`;
  for (const s of results) {
    const indent = s.kind === 'method' ? '  ' : '';
    text += `${indent}- **${s.kind}** ${s.name} (L${s.start_line}-${s.end_line})\n`;
  }
  return { content: [{ type: 'text', text }], structuredData: results };
}

function buildCompetitiveFeatureHandlerExports(deps = competitiveFeatureHandlerDeps) {
  return {
    handleCompareProviders: withCompetitiveFeatureHandlerDeps(deps, handleCompareProviders),
    handleReviewTaskOutput: withCompetitiveFeatureHandlerDeps(deps, handleReviewTaskOutput),
    handleDetectProjectType: withCompetitiveFeatureHandlerDeps(deps, handleDetectProjectType),
    handleListProjectTemplates: withCompetitiveFeatureHandlerDeps(deps, handleListProjectTemplates),
    handleGetProviderScores: withCompetitiveFeatureHandlerDeps(deps, handleGetProviderScores),
    handleGetCircuitBreakerStatus: withCompetitiveFeatureHandlerDeps(deps, handleGetCircuitBreakerStatus),
    handlePolishTaskDescription: withCompetitiveFeatureHandlerDeps(deps, handlePolishTaskDescription),
    handleIndexProject: withCompetitiveFeatureHandlerDeps(deps, handleIndexProject),
    handleSearchSymbols: withCompetitiveFeatureHandlerDeps(deps, handleSearchSymbols),
    handleGetSymbolSource: withCompetitiveFeatureHandlerDeps(deps, handleGetSymbolSource),
    handleGetFileOutline: withCompetitiveFeatureHandlerDeps(deps, handleGetFileOutline),
  };
}

function createCompetitiveFeatureHandlers(deps = {}) {
  const hasDeps = deps && Object.keys(deps).length > 0;
  return buildCompetitiveFeatureHandlerExports(
    hasDeps ? normalizeCompetitiveFeatureHandlerDeps(deps) : competitiveFeatureHandlerDeps
  );
}

module.exports = {
  handleCompareProviders,
  handleReviewTaskOutput,
  handleDetectProjectType,
  handleListProjectTemplates,
  handleGetProviderScores,
  handleGetCircuitBreakerStatus,
  handlePolishTaskDescription,
  handleIndexProject,
  handleSearchSymbols,
  handleGetSymbolSource,
  handleGetFileOutline,
  init,
  createCompetitiveFeatureHandlers,
};
