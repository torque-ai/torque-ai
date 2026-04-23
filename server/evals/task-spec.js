'use strict';

function createTaskSpec({ name, dataset, solver, scorer, sandbox, approvalPolicy, tags = [], metadata = {} }) {
  if (!Array.isArray(dataset) || dataset.length === 0) throw new Error('TaskSpec: dataset required');
  if (!solver || typeof solver.run !== 'function') throw new Error('TaskSpec: solver with run() required');
  if (!scorer || typeof scorer.score !== 'function') throw new Error('TaskSpec: scorer with score() required');
  return { name: name || 'task', dataset, solver, scorer, sandbox, approvalPolicy, tags, metadata };
}

module.exports = { createTaskSpec };
