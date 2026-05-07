// @ts-check
import { test, expect } from '@playwright/test';

const MOCK_STRATEGIC_STATUS = {
  provider: 'deepinfra',
  model: 'Qwen/Qwen2.5-72B-Instruct',
  confidence_threshold: 0.7,
  fallback_chain: ['deepinfra', 'hyperbolic', 'ollama'],
};

const MOCK_OPERATIONS = [
  {
    id: 'op-1',
    description: 'Decompose authentication module into subtasks',
    status: 'completed',
    provider: 'deepinfra',
    created_at: new Date(Date.now() - 3600_000).toISOString(),
  },
  {
    id: 'op-2',
    description: 'Diagnose failing CI pipeline for database migration',
    status: 'running',
    provider: 'deepinfra',
    created_at: new Date(Date.now() - 1800_000).toISOString(),
  },
  {
    id: 'op-3',
    description: 'Review code quality of WebSocket refactor',
    status: 'failed',
    provider: 'hyperbolic',
    created_at: new Date(Date.now() - 7200_000).toISOString(),
  },
];

const MOCK_DECISIONS = [
  {
    task_id: 'dec-1111-1111',
    complexity: 'normal',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    status: 'completed',
    description: 'Generate tests for auth module',
    reason: 'Matched fast coding lane',
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    fallback_used: false,
    needs_review: false,
    split_advisory: false,
  },
];

const MOCK_PROVIDER_HEALTH = [
  {
    provider: 'deepinfra',
    enabled: true,
    health_status: 'healthy',
    avg_duration_seconds: 45,
  },
  {
    provider: 'ollama',
    enabled: true,
    health_status: 'warning',
    avg_duration_seconds: 62,
  },
];

const MOCK_PROVIDER_STATS = [
  {
    provider: 'deepinfra',
    enabled: true,
    stats: {
      total_tasks: 24,
      completed_tasks: 22,
      failed_tasks: 2,
      success_rate: 92,
      avg_duration_seconds: 45,
    },
  },
  {
    provider: 'ollama',
    enabled: true,
    stats: {
      total_tasks: 10,
      completed_tasks: 8,
      failed_tasks: 2,
      success_rate: 80,
      avg_duration_seconds: 62,
    },
  },
];

async function mockApi(page) {
  await page.route('**/api/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: {}, meta: {} }),
    });
  });

  await page.route('**/api/auth/status', (route) => {
    route.fulfill({ json: { authenticated: true, mode: 'open' } });
  });

  await page.route('**/api/v2/strategic/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_STRATEGIC_STATUS }),
    });
  });

  await page.route('**/api/v2/strategic/operations*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { operations: MOCK_OPERATIONS } }),
    });
  });

  await page.route('**/api/v2/strategic/decisions*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { decisions: MOCK_DECISIONS } }),
    });
  });

  await page.route('**/api/v2/strategic/provider-health*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { providers: MOCK_PROVIDER_HEALTH } }),
    });
  });

  await page.route('**/api/v2/providers', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: MOCK_PROVIDER_STATS } }),
    });
  });

  await page.route('**/api/v2/budget/summary*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { total_cost: 4.52 } }),
    });
  });

  await page.route(/\/api\/v2\/tasks\?/, (route) => {
    const url = new URL(route.request().url());
    const status = url.searchParams.get('status');
    const total = status === 'queued' ? 3 : status === 'running' ? 1 : 0;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [], total } }),
    });
  });

  await page.route('**/api/v2/routing/active', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { template: { id: 'free-agentic', name: 'All Free Agentic' } } }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('strategy view loads under the operations routing tab', async ({ page }) => {
  await page.goto('/operations#routing');

  await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('heading', { name: 'Strategy' })).toBeVisible();
  await expect(page.getByText('Task routing, provider health, and queue status')).toBeVisible();
});

test('legacy strategy route redirects to the current operations tab', async ({ page }) => {
  await page.goto('/strategy');

  await expect(page).toHaveURL(/\/operations#routing$/);
  await expect(page.getByRole('heading', { name: 'Strategy' })).toBeVisible({ timeout: 10000 });
});

test('active routing section renders provider and template', async ({ page }) => {
  await page.goto('/operations#routing');

  const routingCard = page.locator('.glass-card', { hasText: 'Active Routing' });
  await expect(routingCard).toBeVisible({ timeout: 10000 });
  await expect(routingCard.getByText('All Free Agentic')).toBeVisible();
  await expect(routingCard.getByText('deepinfra')).toBeVisible();
  await expect(routingCard.getByText('Total Decisions')).toBeVisible();
});

test('overview stat cards render current routing metrics', async ({ page }) => {
  await page.goto('/operations#routing');

  const tasksStat = page.locator('div.rounded-xl', {
    has: page.locator('p', { hasText: /^Tasks \(7d\)$/ }),
  }).first();
  await expect(tasksStat.getByText('34', { exact: true })).toBeVisible({ timeout: 10000 });

  const successStat = page.locator('div.rounded-xl', {
    has: page.locator('p', { hasText: /^Success Rate$/ }),
  }).first();
  await expect(successStat.getByText('88%', { exact: true })).toBeVisible();

  const queueStat = page.locator('div.rounded-xl', {
    has: page.locator('p', { hasText: /^Queue$/ }),
  }).first();
  await expect(queueStat.getByText('4', { exact: true })).toBeVisible();

  const costStat = page.locator('div.rounded-xl', {
    has: page.locator('p', { hasText: /^Cost \(7d\)$/ }),
  }).first();
  await expect(costStat.getByText('$4.52', { exact: true })).toBeVisible();
});

test('fallback chain renders with provider nodes', async ({ page }) => {
  await page.goto('/operations#routing');

  const chainCard = page.locator('.glass-card', { hasText: 'Fallback Chain' });
  await expect(chainCard).toBeVisible({ timeout: 10000 });
  await expect(chainCard.getByText('deepinfra').first()).toBeVisible();
  await expect(chainCard.getByText('hyperbolic').first()).toBeVisible();
  await expect(chainCard.getByText('ollama').first()).toBeVisible();
  await expect(chainCard.getByText('Active provider')).toBeVisible();
});

test('provider health grid renders provider statuses', async ({ page }) => {
  await page.goto('/operations#routing');

  const healthCard = page.locator('.glass-card', { hasText: 'Provider Health' });
  await expect(healthCard).toBeVisible({ timeout: 10000 });
  await expect(healthCard.getByText('deepinfra').first()).toBeVisible();
  await expect(healthCard.getByText('healthy').first()).toBeVisible();
  await expect(healthCard.getByText('warning').first()).toBeVisible();
});

test('decisions tab renders decision history', async ({ page }) => {
  await page.goto('/operations#routing');

  await page.getByRole('button', { name: 'Decisions' }).click();
  await expect(page.getByRole('heading', { name: /Decision History/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Generate tests for auth module')).toBeVisible();
  await expect(page.getByText('codex').first()).toBeVisible();
});

test('operations table renders with recent operations', async ({ page }) => {
  await page.goto('/operations#routing');

  await page.getByRole('button', { name: 'Operations' }).click();
  await expect(page.getByRole('heading', { name: 'Recent Strategic Operations' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Decompose authentication module into subtasks')).toBeVisible();
  await expect(page.getByText('Diagnose failing CI pipeline for database migration')).toBeVisible();
  await expect(page.getByText('Review code quality of WebSocket refactor')).toBeVisible();
});

test('operations table shows status badges with correct colors', async ({ page }) => {
  await page.goto('/operations#routing');

  await page.getByRole('button', { name: 'Operations' }).click();
  const table = page.locator('.glass-card', { hasText: 'Recent Strategic Operations' }).locator('table');
  await expect(table.locator('span', { hasText: 'completed' })).toHaveClass(/bg-green-500/);
  await expect(table.locator('span', { hasText: 'running' })).toHaveClass(/bg-blue-500/);
  await expect(table.locator('span', { hasText: 'failed' })).toHaveClass(/bg-red-500/);
});

test('operations table has current column headers', async ({ page }) => {
  await page.goto('/operations#routing');

  await page.getByRole('button', { name: 'Operations' }).click();
  const table = page.locator('.glass-card', { hasText: 'Recent Strategic Operations' }).locator('table');
  await expect(table.locator('th', { hasText: 'Task' })).toBeVisible();
  await expect(table.locator('th', { hasText: 'Status' })).toBeVisible();
  await expect(table.locator('th', { hasText: 'Provider' })).toBeVisible();
  await expect(table.locator('th', { hasText: 'Created' })).toBeVisible();
});

test('configuration tab shows strategic intelligence values', async ({ page }) => {
  await page.goto('/operations#routing');

  await page.getByRole('button', { name: 'Configuration' }).click();
  const configCard = page.locator('.glass-card', { hasText: 'Strategic Intelligence' });
  await expect(configCard).toBeVisible({ timeout: 10000 });
  await expect(configCard.getByText('deepinfra')).toBeVisible();
  await expect(configCard.getByText('Qwen/Qwen2.5-72B-Instruct')).toBeVisible();
  await expect(configCard.getByText('70%')).toBeVisible();
});

test('refresh button triggers v2 strategic re-fetch', async ({ page }) => {
  let statusCalls = 0;
  await page.route('**/api/v2/strategic/status', (route) => {
    statusCalls++;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_STRATEGIC_STATUS }),
    });
  });

  await page.goto('/operations#routing');
  await expect(page.getByRole('heading', { name: 'Strategy' })).toBeVisible({ timeout: 10000 });
  const callsBefore = statusCalls;

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => statusCalls).toBeGreaterThan(callsBefore);
});
