'use strict';

function createSolver({ name, run }) {
  if (typeof run !== 'function') throw new Error('solver: run(sample) required');
  return { name: name || 'solver', run };
}

function chainSolvers(solvers) {
  return createSolver({
    name: solvers.map((s) => s.name).join('>'),
    run: async (sample, runtime) => {
      let cur = { ...sample };
      for (const s of solvers) {
        const out = await s.run(cur, runtime);
        cur = { ...cur, ...out, input: out.output ?? cur.input };
      }
      return { output: cur.output };
    },
  });
}

module.exports = { createSolver, chainSolvers };
