'use strict';

/**
 * Handlers for competitive-analysis-inspired features.
 * Auto-discovered by tools.js routeMap via handleXxx naming convention.
 */

// logger available if needed: require('../logger').child({ component: 'competitive-features' })

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

// ─── Agent Discovery ─────────────────────────────────────────────────────

async function handleDiscoverAgents(_args) {
  const { discoverAgents, formatDiscoveryReport } = require('../utils/agent-discovery');
  const result = discoverAgents();
  const report = formatDiscoveryReport(result);
  return { content: [{ type: 'text', text: report }], structuredData: result };
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
  const database = require('../database');
  const inst = database.getDbInstance ? database.getDbInstance() : null;
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
  const database = require('../database');
  const inst = database.getDbInstance ? database.getDbInstance() : null;
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
  const database = require('../database');
  const inst = database.getDbInstance ? database.getDbInstance() : null;
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
  const database = require('../database');
  const inst = database.getDbInstance ? database.getDbInstance() : null;
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
  const database = require('../database');
  const inst = database.getDbInstance ? database.getDbInstance() : null;
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

function createCompetitiveFeatureHandlers() {
  return {
    handleCompareProviders,
    handleReviewTaskOutput,
    handleDiscoverAgents,
    handleDetectProjectType,
    handleListProjectTemplates,
    handleGetProviderScores,
    handleGetCircuitBreakerStatus,
    handlePolishTaskDescription,
    handleIndexProject,
    handleSearchSymbols,
    handleGetSymbolSource,
    handleGetFileOutline,
  };
}

module.exports = {
  handleCompareProviders,
  handleReviewTaskOutput,
  handleDiscoverAgents,
  handleDetectProjectType,
  handleListProjectTemplates,
  handleGetProviderScores,
  handleGetCircuitBreakerStatus,
  handlePolishTaskDescription,
  handleIndexProject,
  handleSearchSymbols,
  handleGetSymbolSource,
  handleGetFileOutline,
  createCompetitiveFeatureHandlers,
};
