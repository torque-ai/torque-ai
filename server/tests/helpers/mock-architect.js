'use strict';

function createMockArchitect({
  rewrite = null,
  decompose = null,
  rewriteImpl = null,
  decomposeImpl = null,
  throwOn = null,
  delayMs = 0,
} = {}) {
  const calls = { rewrite: [], decompose: [] };

  async function delay() {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return {
    async rewriteWorkItem(args) {
      calls.rewrite.push(args);
      await delay();
      if (throwOn === 'rewrite') throw new Error('mock-architect: rewrite forced failure');
      if (rewriteImpl) return rewriteImpl(args);
      return rewrite ?? { title: '', description: '', acceptance_criteria: [] };
    },
    async decomposeWorkItem(args) {
      calls.decompose.push(args);
      await delay();
      if (throwOn === 'decompose') throw new Error('mock-architect: decompose forced failure');
      if (decomposeImpl) return decomposeImpl(args);
      return decompose ?? { children: [] };
    },
    calls,
  };
}

module.exports = { createMockArchitect };
