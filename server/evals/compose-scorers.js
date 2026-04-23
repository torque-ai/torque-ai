'use strict';

function composeScorers(scorers, { reduce = 'mean' } = {}) {
  return {
    kind: 'composite',
    async score(sample, result) {
      const components = [];
      for (const s of scorers) components.push(await s.score(sample, result));
      const nums = components.map((c) => c.value).filter((n) => typeof n === 'number');
      let value = 0;
      if (reduce === 'mean') value = nums.reduce((a, b) => a + b, 0) / (nums.length || 1);
      else if (reduce === 'min') value = Math.min(...nums);
      else if (reduce === 'max') value = Math.max(...nums);
      else throw new Error(`unknown reduce: ${reduce}`);
      return { value, components, reduce };
    },
  };
}

module.exports = { composeScorers };
