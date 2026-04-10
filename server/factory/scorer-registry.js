'use strict';

const scorers = {
  structural: require('./scorers/structural'),
  test_coverage: require('./scorers/test-coverage'),
  security: require('./scorers/security'),
  user_facing: require('./scorers/user-facing'),
  api_completeness: require('./scorers/api-completeness'),
  documentation: require('./scorers/documentation'),
  dependency_health: require('./scorers/dependency-health'),
  build_ci: require('./scorers/build-ci'),
  performance: require('./scorers/performance'),
  debt_ratio: require('./scorers/debt-ratio'),
};

function scoreDimension(dimension, projectPath, scanReport, findingsDir) {
  const scorer = scorers[dimension];
  if (!scorer) throw new Error(`Unknown dimension: ${dimension}`);
  return scorer.score(projectPath, scanReport, findingsDir);
}

function scoreAll(projectPath, scanReport, findingsDir, dimensions) {
  const dims = dimensions || Object.keys(scorers);
  const results = {};
  for (const dim of dims) {
    try {
      results[dim] = scoreDimension(dim, projectPath, scanReport, findingsDir);
    } catch (err) {
      results[dim] = { score: 50, details: { error: err.message, source: 'error' }, findings: [] };
    }
  }
  return results;
}

module.exports = { scoreDimension, scoreAll, DIMENSIONS: Object.keys(scorers) };
