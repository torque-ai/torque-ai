// @ts-check
import { test, expect } from '@playwright/test';

const MOCK_PROVIDERS = [
  {
    provider: 'groq',
    enabled: true,
    provider_type: 'cloud-api',
    api_key_status: 'not_set',
    limits: { max_concurrent: 3 },
    stats: {
      total_tasks: 100,
      successful_tasks: 95,
      failed_tasks: 5,
      success_rate: 95,
      avg_duration_seconds: 18,
      total_cost: 0.42,
    },
  },
  {
    provider: 'cerebras',
    enabled: true,
    provider_type: 'cloud-api',
    api_key_status: 'not_set',
    limits: { max_concurrent: 2 },
    stats: {
      total_tasks: 12,
      successful_tasks: 9,
      failed_tasks: 3,
      success_rate: 75,
      avg_duration_seconds: 24,
      total_cost: 0.18,
    },
  },
];

const MOCK_TIMESERIES = [
  { date: '2026-03-06', total: 10, completed: 8, failed: 2, success_rate: 80, groq: 8, cerebras: 2 },
  { date: '2026-03-07', total: 14, completed: 13, failed: 1, success_rate: 93, groq: 12, cerebras: 2 },
  { date: '2026-03-08', total: 18, completed: 16, failed: 2, success_rate: 89, groq: 15, cerebras: 3 },
];

const MOCK_QUOTA_HISTORY = {
  history: [
    { date: '2026-03-06', provider: 'groq', total_requests: 45, total_tokens: 12000 },
    { date: '2026-03-06', provider: 'cerebras', total_requests: 12, total_tokens: 4000 },
    { date: '2026-03-07', provider: 'groq', total_requests: 60, total_tokens: 18000 },
    { date: '2026-03-07', provider: 'cerebras', total_requests: 8, total_tokens: 3000 },
  ],
};

function mockQuotaStatus() {
  const now = new Date();
  return {
    providers: {
      groq: {
        status: 'green',
        source: 'test',
        lastUpdated: now.toISOString(),
        limits: {
          rpm: { remaining: 25, limit: 30, resetsAt: new Date(now.getTime() + 45_000).toISOString() },
          tpm: { remaining: 5200, limit: 6000, resetsAt: new Date(now.getTime() + 45_000).toISOString() },
          daily: { remaining: 900, limit: 1000, resetsAt: new Date(now.getTime() + 43_200_000).toISOString() },
        },
      },
      cerebras: {
        status: 'yellow',
        source: 'test',
        cooldownUntil: new Date(now.getTime() + 60_000).toISOString(),
        lastUpdated: now.toISOString(),
        limits: {
          rpm: { remaining: 0, limit: 30, resetsAt: new Date(now.getTime() + 60_000).toISOString() },
          tpm: { remaining: 8000, limit: 8000, resetsAt: new Date(now.getTime() + 60_000).toISOString() },
          daily: { remaining: 950, limit: 1000, resetsAt: new Date(now.getTime() + 86_400_000).toISOString() },
        },
      },
    },
  };
}

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

  await page.route('**/api/v2/providers', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: MOCK_PROVIDERS } }),
    });
  });

  await page.route('**/api/v2/providers/trends*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          providers: ['groq', 'cerebras'],
          series: [
            { date: '2026-03-06', groq_total: 8, groq_success_rate: 88, cerebras_total: 2, cerebras_success_rate: 50 },
            { date: '2026-03-07', groq_total: 12, groq_success_rate: 92, cerebras_total: 2, cerebras_success_rate: 100 },
          ],
        },
      }),
    });
  });

  await page.route('**/api/v2/stats/timeseries*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { series: MOCK_TIMESERIES } }),
    });
  });

  await page.route('**/api/v2/hosts', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    });
  });

  await page.route('**/api/v2/provider-quotas/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: mockQuotaStatus() }),
    });
  });

  await page.route('**/api/v2/provider-quotas/history*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_QUOTA_HISTORY }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('providers quota surface loads in the current providers page', async ({ page }) => {
  await page.goto('/providers');

  await expect(page.getByRole('heading', { name: 'Provider Statistics' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Overview', { exact: true })).toBeVisible();
});

test('provider rows render for quota-tracked cloud providers', async ({ page }) => {
  await page.goto('/providers');

  await expect(page.getByText('groq', { exact: true }).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('cerebras', { exact: true }).first()).toBeVisible();
});

test('quota status badges expose request and token limits', async ({ page }) => {
  await page.goto('/providers');

  await expect(page.locator('span[aria-label*="RPM: 25/30"]').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('span[aria-label*="TPM: 5200/6000"]').first()).toBeVisible();
  await expect(page.locator('span[aria-label*="Day: 900/1000"]').first()).toBeVisible();
});

test('expanded provider row shows quota bars', async ({ page }) => {
  await page.goto('/providers');

  await page.locator('[role="button"]', { hasText: 'groq' }).first().click();
  await expect(page.getByText('RPM', { exact: true })).toBeVisible();
  await expect(page.getByText('TPM', { exact: true })).toBeVisible();
  await expect(page.getByText('Day', { exact: true })).toBeVisible();
  await expect(page.getByText('25/30', { exact: true })).toBeVisible();
});

test('cooldown quota status is visible for throttled providers', async ({ page }) => {
  await page.goto('/providers');

  const cooldownBadge = page.locator('span[aria-label*="Cooldown:"]').first();
  await expect(cooldownBadge).toBeVisible({ timeout: 10000 });
  await expect(cooldownBadge).toHaveClass(/bg-yellow-500/);
});

test('summary stats include provider count and total tasks', async ({ page }) => {
  await page.goto('/providers');

  await expect(page.getByText('Total Tasks')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('112', { exact: true })).toBeVisible();
  const providersStat = page.locator('div.rounded-xl', {
    has: page.locator('p', { hasText: /^Providers$/ }),
  }).first();
  await expect(providersStat.getByText('2', { exact: true })).toBeVisible();
});

test('compare mode exposes provider selectors', async ({ page }) => {
  await page.goto('/providers');

  await page.getByRole('button', { name: 'Compare' }).click();
  await expect(page.getByLabel('Compare provider A')).toBeVisible();
  await expect(page.getByLabel('Compare provider B')).toBeVisible();
});

test('provider usage history chart renders with metric toggles', async ({ page }) => {
  await page.goto('/providers');

  await expect(page.getByRole('heading', { name: '7-Day Provider Usage' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Tokens' }).click();
  await expect(page.getByRole('button', { name: 'Tokens' })).toHaveAttribute('aria-pressed', 'true');
});

test('time range selector triggers a provider data reload', async ({ page }) => {
  let providerCalls = 0;
  await page.route('**/api/v2/providers', (route) => {
    providerCalls++;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: MOCK_PROVIDERS } }),
    });
  });

  await page.goto('/providers');
  await expect(page.getByText('groq', { exact: true }).first()).toBeVisible({ timeout: 10000 });
  const callsBefore = providerCalls;

  await page.getByLabel('Filter provider stats by time range').selectOption('14');
  await expect.poll(() => providerCalls).toBeGreaterThan(callsBefore);
});

test('add provider form opens from providers page', async ({ page }) => {
  await page.goto('/providers');

  await page.getByRole('button', { name: 'Add Provider' }).click();
  await expect(page.getByRole('heading', { name: 'Add Provider' })).toBeVisible();
  await expect(page.getByLabel('Name')).toBeVisible();
});

test('cloud provider API key editor opens from expanded quota row', async ({ page }) => {
  await page.goto('/providers');

  await page.locator('[role="button"]', { hasText: 'groq' }).first().click();
  await page.getByRole('button', { name: 'Add Key' }).click();
  await expect(page.getByPlaceholder('Paste API key')).toBeVisible();
});

test('providers quota surface renders after navigation from another route', async ({ page }) => {
  await page.goto('/');
  await page.goto('/providers');

  await expect(page.getByRole('heading', { name: 'Provider Statistics' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('groq', { exact: true }).first()).toBeVisible();
});
