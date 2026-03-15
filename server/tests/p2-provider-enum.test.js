const taskSubmissionDefs = require('../tool-defs/task-submission-defs');
const { PROVIDER_DEFAULT_TIMEOUTS } = require('../constants');

describe('submit_task provider enum completeness', () => {
  const submitTaskDef = taskSubmissionDefs.find((tool) => tool.name === 'submit_task');
  const providerEnum = submitTaskDef?.inputSchema?.properties?.provider?.enum ?? [];

  it('includes all providers from PROVIDER_DEFAULT_TIMEOUTS', () => {
    const timeoutProviders = Object.keys(PROVIDER_DEFAULT_TIMEOUTS);

    for (const provider of timeoutProviders) {
      expect(providerEnum).toContain(provider);
    }
  });

  it('defines deepinfra and hyperbolic timeouts', () => {
    expect(PROVIDER_DEFAULT_TIMEOUTS.deepinfra).toBe(20);
    expect(PROVIDER_DEFAULT_TIMEOUTS.hyperbolic).toBe(20);
  });

  it('submit_task provider enum has exactly 14 providers', () => {
    expect(providerEnum).toHaveLength(14);
  });
});
