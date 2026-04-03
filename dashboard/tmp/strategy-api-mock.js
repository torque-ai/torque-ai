export const request = async () => ({});
export const requestV2 = async () => ({});

export const strategic = {
  status: async () => ({
    provider: 'deepinfra',
    model: 'meta-llama/Llama-3.1-405B-Instruct',
    confidence_threshold: 0.4,
    usage: {
      total_calls: 15,
      total_tokens: 24500,
      total_cost: 0.32,
      total_duration_ms: 18200,
      fallback_calls: 3,
    },
    fallback_chain: ['deepinfra', 'hyperbolic', 'ollama'],
  }),
  operations: async () => ({
    operations: [
      {
        id: 'task-op-001-aabbccdd',
        description: 'Strategic decomposition of UserAuth feature for Headwaters project',
        status: 'completed',
        provider: 'deepinfra',
        created_at: '2026-03-08T10:30:00Z',
      },
      {
        id: 'task-op-002-eeff0011',
        description: 'Strategic diagnosis of codex failure on test generation task',
        status: 'failed',
        provider: 'ollama',
        created_at: '2026-03-08T09:15:00Z',
      },
    ],
  }),
  decisions: async () => ({
    decisions: [
      {
        task_id: 'task-abc-12345678',
        created_at: '2026-03-08T12:00:00Z',
        complexity: 'complex',
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        status: 'completed',
        fallback_used: false,
        needs_review: true,
        description: 'Write comprehensive tests for the UserAuth system',
      },
      {
        task_id: 'task-def-87654321',
        created_at: '2026-03-08T11:30:00Z',
        complexity: 'normal',
        provider: 'ollama',
        model: 'qwen2.5-coder:32b',
        status: 'running',
        fallback_used: false,
        needs_review: false,
        description: 'Fix import ordering in EventSystem.ts',
      },
      {
        task_id: 'task-ghi-11223344',
        created_at: '2026-03-08T11:00:00Z',
        complexity: 'simple',
        provider: 'ollama',
        model: 'qwen2.5-coder:32b',
        status: 'failed',
        fallback_used: true,
        needs_review: false,
        description: 'Update docs for the notification bridge component',
      },
    ],
  }),
  providerHealth: async () => ({
    providers: [
      {
        provider: 'codex',
        enabled: true,
        health_status: 'healthy',
        success_rate_1h: 95,
        successes_1h: 19,
        failures_1h: 1,
        tasks_today: 24,
        completed_today: 22,
        failed_today: 2,
        avg_duration_seconds: 45,
      },
      {
        provider: 'ollama',
        enabled: true,
        health_status: 'warning',
        success_rate_1h: 80,
        successes_1h: 8,
        failures_1h: 2,
        tasks_today: 12,
        completed_today: 10,
        failed_today: 2,
        avg_duration_seconds: 120,
      },
      {
        provider: 'deepinfra',
        enabled: true,
        health_status: 'healthy',
        success_rate_1h: 100,
        successes_1h: 5,
        failures_1h: 0,
        tasks_today: 6,
        completed_today: 6,
        failed_today: 0,
        avg_duration_seconds: 30,
      },
      {
        provider: 'groq',
        enabled: false,
        health_status: 'disabled',
        success_rate_1h: null,
        successes_1h: 0,
        failures_1h: 0,
        tasks_today: 0,
        completed_today: 0,
        failed_today: 0,
        avg_duration_seconds: 0,
      },
    ],
  }),
};

export const providers = {
  list: async () => ([
    {
      provider: 'codex',
      enabled: true,
      stats: {
        total_tasks: 15,
        completed_tasks: 14,
        failed_tasks: 1,
        success_rate: 93,
        avg_duration_seconds: 120,
      },
    },
    {
      provider: 'ollama',
      enabled: true,
      stats: {
        total_tasks: 30,
        completed_tasks: 28,
        failed_tasks: 2,
        success_rate: 93,
        avg_duration_seconds: 45,
      },
    },
  ]),
};

export const budget = {
  summary: async () => ({ total_cost: 0.45, task_count: 45, by_provider: { codex: 0.45 } }),
};

export const tasks = {
  list: async () => ({ tasks: [], total: 3 }),
};

export const routingTemplates = {
  list: async () => ([]),
  getActive: async () => ({ template: { id: 'preset-system-default', name: 'System Default' } }),
  categories: async () => ([]),
};
