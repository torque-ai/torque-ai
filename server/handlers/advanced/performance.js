/**
 * Advanced handlers — Performance Optimization
 *
 * 5 handlers for query analysis, database optimization, cache clearing,
 * query plans, and database statistics.
 * Extracted from advanced-handlers.js during Phase 7 handler decomposition.
 */

const { getSlowQueries, getFrequentQueries, vacuumDatabase, analyzeDatabase, integrityCheck, clearCacheStats, explainQueryPlan, getDatabaseStats, getIndexStats, getOptimizationHistory } = require('../../db/project-config-core');
const { ErrorCodes, makeError } = require('../error-codes');


/**
 * Analyze query performance
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleAnalyzeQueryPerformance(args) {
  const { analysis_type = 'both', limit = 20, min_avg_ms = 10 } = args;

  let output = `## Query Performance Analysis\n\n`;
  const results = {};

  if (analysis_type === 'slow' || analysis_type === 'both') {
    const slowQueries = getSlowQueries(limit, min_avg_ms);
    results.slow_queries = slowQueries;

    output += `### Slow Queries (avg >= ${min_avg_ms}ms)\n\n`;
    if (slowQueries.length === 0) {
      output += `No queries found with avg execution >= ${min_avg_ms}ms\n\n`;
    } else {
      output += `| Avg (ms) | Max (ms) | Count | Query Pattern |\n`;
      output += `|----------|----------|-------|---------------|\n`;
      for (const q of slowQueries) {
        const pattern = q.query_pattern.length > 50
          ? q.query_pattern.substring(0, 47) + '...'
          : q.query_pattern;
        output += `| ${q.avg_time_ms.toFixed(2)} | ${q.max_time_ms.toFixed(2)} | ${q.execution_count} | ${pattern} |\n`;
      }
      output += '\n';
    }
  }

  if (analysis_type === 'frequent' || analysis_type === 'both') {
    const frequentQueries = getFrequentQueries(limit);
    results.frequent_queries = frequentQueries;

    output += `### Most Frequent Queries\n\n`;
    if (frequentQueries.length === 0) {
      output += `No query statistics recorded yet\n\n`;
    } else {
      output += `| Count | Avg (ms) | Total (ms) | Query Pattern |\n`;
      output += `|-------|----------|------------|---------------|\n`;
      for (const q of frequentQueries) {
        const pattern = q.query_pattern.length > 50
          ? q.query_pattern.substring(0, 47) + '...'
          : q.query_pattern;
        output += `| ${q.execution_count} | ${q.avg_time_ms.toFixed(2)} | ${q.total_time_ms.toFixed(0)} | ${pattern} |\n`;
      }
      output += '\n';
    }
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Optimize database
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleOptimizeDatabase(args) {
  const { operations = ['analyze'], table_name } = args;
  const results = [];

  let output = `## Database Optimization\n\n`;

  for (const op of operations) {
    switch (op) {
      case 'vacuum': {
        const result = vacuumDatabase();
        results.push({ operation: 'vacuum', ...result });
        output += `### VACUUM\n`;
        output += `- Duration: ${result.duration_ms}ms\n`;
        output += `- Size before: ${(result.size_before / 1024).toFixed(2)} KB\n`;
        output += `- Size after: ${(result.size_after / 1024).toFixed(2)} KB\n`;
        output += `- Space saved: ${(result.space_saved / 1024).toFixed(2)} KB\n\n`;
        break;
      }
      case 'analyze': {
        const result = analyzeDatabase(table_name);
        results.push({ operation: 'analyze', ...result });
        output += `### ANALYZE\n`;
        output += `- Duration: ${result.duration_ms}ms\n`;
        output += `- Table: ${result.table}\n\n`;
        break;
      }
      case 'integrity_check': {
        const result = integrityCheck();
        results.push({ operation: 'integrity_check', ...result });
        output += `### Integrity Check\n`;
        output += `- Status: ${result.ok ? '✓ OK' : '✗ Issues Found'}\n`;
        if (!result.ok) {
          output += `- Issues: ${JSON.stringify(result.result)}\n`;
        }
        output += '\n';
        break;
      }
    }
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Clear cache
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleClearCache(args) {
  const { cache_name, clear_stats = true } = args;

  let output = `## Cache Cleared\n\n`;

  if (clear_stats) {
    const result = clearCacheStats(cache_name);
    output += `- Statistics cleared: ${result.changes} record(s)\n`;
  }

  if (cache_name) {
    output += `- Cleared cache: ${cache_name}\n`;
  } else {
    output += `- Cleared: All caches\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Get query execution plan
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleQueryPlan(args) {
  const { query } = args;

  if (!query || typeof query !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'query parameter is required and must be a string');
  }

  const result = explainQueryPlan(query);

  let output = `## Query Execution Plan\n\n`;
  output += `**Query:** \`${query}\`\n\n`;

  if (result.error) {
    output += `**Error:** ${result.error}\n`;
  } else {
    output += `### Plan\n\n`;
    output += `| ID | Parent | Detail |\n`;
    output += `|----|--------|--------|\n`;
    for (const row of result.plan) {
      output += `| ${row.id} | ${row.parent} | ${row.detail} |\n`;
    }
    output += '\n';

    // Simple recommendations
    output += `### Recommendations\n\n`;
    const planText = result.plan.map(r => r.detail).join(' ');
    if (planText.includes('SCAN TABLE') && !planText.includes('USING INDEX')) {
      output += `- ⚠️ Full table scan detected. Consider adding an index on filtered columns.\n`;
    }
    if (planText.includes('USING TEMPORARY')) {
      output += `- ⚠️ Temporary table used. Query may benefit from optimization.\n`;
    }
    if (planText.includes('USING INDEX')) {
      output += `- ✓ Query uses index(es)\n`;
    }
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Get database statistics
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleDatabaseStats(args) {
  const { include_indexes = false, include_history = false } = args;

  const stats = getDatabaseStats();

  let output = `## Database Statistics\n\n`;
  output += `### Overview\n\n`;
  output += `- **Database Size:** ${stats.database_size_mb} MB (${stats.database_size_bytes.toLocaleString()} bytes)\n`;
  output += `- **Total Tables:** ${stats.total_tables}\n`;
  output += `- **Total Rows:** ${stats.total_rows.toLocaleString()}\n`;
  output += `- **Total Indexes:** ${stats.total_indexes}\n\n`;

  output += `### Tables by Row Count\n\n`;
  output += `| Table | Rows | Indexes |\n`;
  output += `|-------|------|----------|\n`;
  for (const t of stats.tables.slice(0, 20)) {
    output += `| ${t.table_name} | ${t.row_count.toLocaleString()} | ${t.index_count} |\n`;
  }
  if (stats.tables.length > 20) {
    output += `| ... | (${stats.tables.length - 20} more tables) | |\n`;
  }
  output += '\n';

  if (include_indexes) {
    const indexStats = getIndexStats();
    output += `### Index Details\n\n`;
    output += `| Table | Index | Columns |\n`;
    output += `|-------|-------|----------|\n`;
    for (const idx of indexStats.slice(0, 30)) {
      output += `| ${idx.table_name} | ${idx.index_name} | ${idx.columns.join(', ')} |\n`;
    }
    if (indexStats.length > 30) {
      output += `| ... | (${indexStats.length - 30} more indexes) | |\n`;
    }
    output += '\n';
  }

  if (include_history) {
    const history = getOptimizationHistory(10);
    output += `### Recent Optimization History\n\n`;
    if (history.length === 0) {
      output += `No optimization history available\n`;
    } else {
      output += `| Operation | Table | Duration | Date |\n`;
      output += `|-----------|-------|----------|------|\n`;
      for (const h of history) {
        output += `| ${h.operation_type} | ${h.table_name || 'all'} | ${h.duration_ms}ms | ${h.executed_at} |\n`;
      }
    }
    output += '\n';
  }

  return { content: [{ type: 'text', text: output }] };
}


function createPerformanceHandlers() {
  return {
    handleAnalyzeQueryPerformance,
    handleOptimizeDatabase,
    handleClearCache,
    handleQueryPlan,
    handleDatabaseStats,
  };
}

module.exports = {
  handleAnalyzeQueryPerformance,
  handleOptimizeDatabase,
  handleClearCache,
  handleQueryPlan,
  handleDatabaseStats,
  createPerformanceHandlers,
};
