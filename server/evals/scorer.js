'use strict';

function createScorer({ kind, target, grade }) {
  const score = async (sample, result, context) => {
    const tgt = typeof target === 'function' ? await target(sample, context) : target;
    switch (kind) {
      case 'match':
        return { value: result.output === tgt ? 1 : 0, kind, target: tgt };
      case 'choice':
        return { value: result.output === tgt ? 1 : 0, kind, target: tgt };
      case 'model_graded':
        if (typeof grade !== 'function') throw new Error('model_graded scorer requires grade(sample,result)');
        return { ...(await grade(sample, result, context)), kind };
      default:
        throw new Error(`unknown scorer kind: ${kind}`);
    }
  };
  return { kind, score };
}

module.exports = { createScorer };
