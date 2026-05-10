import { afterEach, describe, expect, it, vi } from 'vitest';

const { defaultContainer } = require('../container');
const factoryHealth = require('../db/factory/health');
const { handleFactoryCostMetrics } = require('../handlers/factory-handlers');

describe('factory-handlers cost metrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves cost metrics through the DI container', async () => {
    const project = {
      id: 'project-1',
      name: 'Project One',
      path: 'C:/repo/project-one',
    };
    const summary = {
      cycle_count: 2,
      total_cost: 5,
      total_improvement: 4,
      tasks: [],
    };
    const costMetrics = {
      buildProjectCostSummary: vi.fn().mockReturnValue(summary),
      getCostPerCycle: vi.fn().mockReturnValue(2.5),
      getCostPerHealthPoint: vi.fn().mockReturnValue(1.25),
      getProviderEfficiency: vi.fn().mockReturnValue([{ provider: 'codex', total_cost: 5 }]),
    };

    vi.spyOn(factoryHealth, 'getProject').mockReturnValue(project);
    vi.spyOn(defaultContainer, 'get').mockImplementation((name) => {
      if (name === 'costMetrics') {
        return costMetrics;
      }
      throw new Error(`Unexpected container lookup: ${name}`);
    });

    const result = await handleFactoryCostMetrics({ project: project.id });

    expect(defaultContainer.get).toHaveBeenCalledWith('costMetrics');
    expect(costMetrics.buildProjectCostSummary).toHaveBeenCalledWith(project.id);
    expect(costMetrics.getCostPerCycle).toHaveBeenCalledWith(project.id, summary);
    expect(costMetrics.getCostPerHealthPoint).toHaveBeenCalledWith(project.id, summary);
    expect(costMetrics.getProviderEfficiency).toHaveBeenCalledWith(project.id, summary);
    expect(result.structuredData).toEqual({
      project: { id: project.id, name: project.name, path: project.path },
      cost_per_cycle: 2.5,
      cost_per_health_point: 1.25,
      provider_efficiency: [{ provider: 'codex', total_cost: 5 }],
    });
  });
});
