import { JSDOM } from 'jsdom';
import React from 'react';
import { fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../src/test-utils.jsx';
import Strategic from '../src/views/Strategy.jsx';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/strategy',
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis)) {
    globalThis[key] = dom.window[key];
  }
}

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  writable: true,
  value: () => ({
    fillRect() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    arc() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    fillText() {},
    strokeText() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    measureText() {
      return { width: 0 };
    },
  }),
});

const jsonResponse = (data) => ({
  ok: true,
  status: 200,
  headers: {
    get(name) {
      if (String(name).toLowerCase() === 'content-type') {
        return 'application/json';
      }
      return null;
    },
  },
  async json() {
    return data;
  },
  async text() {
    return JSON.stringify(data);
  },
});

globalThis.fetch = async (url) => {
  const href = String(url);

  if (href.endsWith('/api/v2/strategic/status')) {
    return jsonResponse({
      data: {
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
      },
    });
  }

  if (href.includes('/api/strategic/operations?limit=20')) {
    return jsonResponse({
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
    });
  }

  if (href.includes('/api/v2/strategic/decisions?limit=50')) {
    return jsonResponse({
      data: [
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
    });
  }

  if (href.endsWith('/api/v2/strategic/provider-health')) {
    return jsonResponse({
      data: [
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
    });
  }

  if (href.endsWith('/api/v2/providers')) {
    return jsonResponse({
      data: {
        items: [
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
        ],
      },
    });
  }

  if (href.endsWith('/api/v2/budget/summary?days=7')) {
    return jsonResponse({
      data: { total_cost: 0.45, task_count: 45, by_provider: { codex: 0.45 } },
    });
  }

  if (href.includes('/api/v2/tasks?status=queued&limit=1') || href.includes('/api/v2/tasks?limit=1&status=queued')) {
    return jsonResponse({ data: { items: [], total: 3 } });
  }

  if (href.includes('/api/v2/tasks?status=running&limit=1') || href.includes('/api/v2/tasks?limit=1&status=running')) {
    return jsonResponse({ data: { items: [], total: 3 } });
  }

  if (href.endsWith('/api/v2/routing/active')) {
    return jsonResponse({
      data: { template: { id: 'preset-system-default', name: 'System Default' } },
    });
  }

  throw new Error(`Unhandled fetch in debug harness: ${href}`);
};

async function main() {
  const utils = renderWithProviders(<Strategic />, { route: '/strategy' });
  await waitFor(() => {
    utils.getByText('Strategy');
  });
  console.log('subtitle:', utils.getByText('Task routing, provider health, and queue status').textContent);
  fireEvent.click(utils.getByText('Decisions'));
  await waitFor(() => {
    utils.getByText('Complexity');
  });
  const before = utils.getAllByTestId(/^decision-row-/).map((row) => row.textContent);
  fireEvent.click(utils.getByText('Complexity'));
  const afterFirstClick = utils.getAllByTestId(/^decision-row-/).map((row) => row.textContent);
  fireEvent.click(utils.getByText('Complexity'));
  const afterSecondClick = utils.getAllByTestId(/^decision-row-/).map((row) => row.textContent);
  console.log('before:', before);
  console.log('afterFirstClick:', afterFirstClick);
  console.log('afterSecondClick:', afterSecondClick);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
