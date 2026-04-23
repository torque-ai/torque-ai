'use strict';

function createPromptOptimizer({ strategy, llm }) {
  async function optimize({ current, trajectory = [], feedback = [] }) {
    if (strategy === 'prompt_memory') {
      const successful = trajectory.filter(t => (t.score ?? 0) > 0);
      if (successful.length === 0 && feedback.length === 0) return { prompt: current, strategy, changed: false };
      const examples = successful.map(t => `Input: ${t.input}\nOutput: ${t.output}`).join('\n---\n');
      const joined = examples ? `${current}\n\nExamples:\n${examples}` : current;
      return { prompt: joined, strategy, changed: examples.length > 0 };
    }
    if (strategy === 'metaprompt' || strategy === 'gradient') {
      if (!llm || typeof llm.propose !== 'function') throw new Error(`${strategy} strategy requires llm.propose()`);
      const prompt = await llm.propose({ current, feedback, trajectory });
      return { prompt, strategy, changed: prompt !== current };
    }
    throw new Error(`unknown strategy: ${strategy}`);
  }
  return { optimize, strategy };
}

module.exports = { createPromptOptimizer };
