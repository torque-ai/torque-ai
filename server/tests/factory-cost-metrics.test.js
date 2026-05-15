import { describe, it, expect } from 'vitest';

const {
  createCostMetrics,
  getCostPerCycle,
  getCostPerHealthPoint,
  getProviderEfficiency,
} = require('../factory/cost-metrics');

function createCostSummaryDb(batchId, cost) {
  const taskId = `task-${batchId}`;
  return {
    prepare(sql) {
      return {
        all() {
          if (sql.includes('FROM factory_feedback')) {
            return [{ batch_id: batchId, health_delta_json: '{"quality":{"delta":2}}' }];
          }
          if (sql.includes('FROM tasks')) {
            return [{ id: taskId, provider: 'codex' }];
          }
          if (sql.includes('FROM token_usage')) {
            return [{ task_id: taskId, total_cost: cost, row_count: 1 }];
          }
          if (sql.includes('FROM cost_tracking')) {
            return [];
          }
          return [];
        },
      };
    },
  };
}

describe('factory cost metrics', () => {
  it('returns zero for unknown project', () => {
    expect(getCostPerCycle('nonexistent')).toBe(0);
    expect(getCostPerHealthPoint('nonexistent')).toBe(0);
  });

  it('returns empty array for provider efficiency with no data', () => {
    expect(getProviderEfficiency('nonexistent')).toEqual([]);
  });

  it('returns zero for null project_id', () => {
    expect(getCostPerCycle(null)).toBe(0);
    expect(getCostPerHealthPoint(null)).toBe(0);
    expect(getProviderEfficiency(null)).toEqual([]);
  });

  it('exports all 3 metric functions', () => {
    expect(typeof getCostPerCycle).toBe('function');
    expect(typeof getCostPerHealthPoint).toBe('function');
    expect(typeof getProviderEfficiency).toBe('function');
  });

  it('scopes injected db bindings to each factory instance', () => {
    const first = createCostMetrics({ db: createCostSummaryDb('first', 1.5) });
    const second = createCostMetrics({ db: createCostSummaryDb('second', 2.5) });

    expect(first.buildProjectCostSummary('project-a')).toMatchObject({
      cycle_count: 1,
      total_cost: 1.5,
      total_improvement: 2,
      tasks: [{ id: 'task-first', provider: 'codex', total_cost: 1.5 }],
    });
    expect(second.buildProjectCostSummary('project-a')).toMatchObject({
      cycle_count: 1,
      total_cost: 2.5,
      total_improvement: 2,
      tasks: [{ id: 'task-second', provider: 'codex', total_cost: 2.5 }],
    });
  });
});
