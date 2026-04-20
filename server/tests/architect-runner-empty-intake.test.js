'use strict';

const architectRunner = require('../factory/architect-runner');
const factoryIntake = require('../db/factory-intake');
const factoryArchitect = require('../db/factory-architect');
const factoryHealth = require('../db/factory-health');

describe('runArchitectCycle empty-intake guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the LLM call and writes a deterministic empty cycle when intake is empty', async () => {
    const project = { id: 'p1', path: process.cwd(), trust_level: 'dark' };
    vi.spyOn(factoryHealth, 'getProject').mockReturnValue(project);
    vi.spyOn(factoryHealth, 'getLatestScores').mockReturnValue([]);
    vi.spyOn(factoryIntake, 'listOpenWorkItems').mockReturnValue([]);
    vi.spyOn(factoryArchitect, 'getLatestCycle').mockReturnValue(null);
    const createCycle = vi.spyOn(factoryArchitect, 'createCycle').mockImplementation((cycle) => ({
      id: 999,
      ...cycle,
    }));
    const llmSpy = vi.spyOn(architectRunner._internalForTests, 'runArchitectLLM');

    const cycle = await architectRunner.runArchitectCycle('p1', 'test');

    expect(llmSpy).not.toHaveBeenCalled();
    expect(createCycle).toHaveBeenCalledTimes(1);
    const createCall = createCycle.mock.calls[0][0];
    expect(createCall.reasoning).toMatch(/no open work items|empty intake/i);
    expect(createCall.backlog).toEqual([]);
    expect(cycle.id).toBe(999);
  });
});
