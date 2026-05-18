'use strict';

const { scoreOutput, diffExperimentRuns } = require('../eval/native-evaluator');

function handleScoreNativeEval(args = {}) {
  const result = scoreOutput(args.output || '', args.scorers || []);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredData: result,
  };
}

function handleDiffNativeEvalRuns(args = {}) {
  const result = diffExperimentRuns(args.baseline || [], args.candidate || []);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredData: result,
  };
}

module.exports = {
  handleScoreNativeEval,
  handleDiffNativeEvalRuns,
};
