// @ts-check
import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock data — same shape as what the TORQUE API returns
// ---------------------------------------------------------------------------

const MOCK_STRATEGIC_STATUS = {
  provider: 'deepinfra',
  model: 'Qwen/Qwen2.5-72B-Instruct',
  confidence_threshold: 0.7,
  fallback_chain: ['deepinfra', 'hyperbolic', 'ollama'],
  usage: {
    total_calls: 42,
    fallback_calls: 5,
    total_tokens: 128500,
  },
};

const MOCK_STRATEGIC_OPERATIONS = {
  operations: [
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
  ],
};

const MOCK_DECISIONS = [
  {
    task_id: 'dec-1111-1111',
    complexity: 'normal',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    status: 'completed',
    description: 'Generate tests for auth module',
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
    success_rate_1h: 98,
    avg_duration_seconds: 45,
    completed_today: 15,
    failed_today: 1,
  },
  {
    provider: 'ollama',
    enabled: true,
    health_status: 'warning',
    success_rate_1h: 85,
    avg_duration_seconds: 62,
    completed_today: 22,
    failed_today: 3,
  },
];

// ---------------------------------------------------------------------------
// Intercept API calls at the page level so no mock server is needed.
//
// The Strategic component uses two base URLs:
//   - /api/v2/strategic/* for status, decisions, and provider-health (requestV2)
//   - /api/strategic/*    for operations (request)
//
// V2 responses must be wrapped in { data: ... } envelope since requestV2 unwraps.
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/status', (route) => {
    route.fulfill({ json: { authenticated: true, mode: 'open' } });
  });
  // V2 endpoint: status
  await page.route('**/api/v2/strategic/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_STRATEGIC_STATUS }),
    });
  });

  // Legacy endpoint: operations
  await page.route('**/api/strategic/operations*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_STRATEGIC_OPERATIONS),
    });
  });

  // V2 endpoint: decisions
  await page.route('**/api/v2/strategic/decisions*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_DECISIONS }),
    });
  });

  // V2 endpoint: provider-health
  await page.route('**/api/v2/strategic/provider-health*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_PROVIDER_HEALTH }),
    });
  });

  // Catch-all for other API routes that the layout/shell might call
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    // Let strategic routes through (handled above)
    if (url.includes('/strategic/')) {
      route.fallback();
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: {}, meta: {} }),
    });
  });
});

// ---------------------------------------------------------------------------
// 1. Page loads and shows heading
// ---------------------------------------------------------------------------
test('strategic brain page loads and shows heading', async ({ page }) => {
  await page.goto('/strategy');
  await expect(page.locator('h2', { hasText: 'Strategic Brain' })).toBeVisible({ timeout: 10000 });
  await expect(
    page.locator('text=Routing decisions, provider health, and LLM-powered orchestration')
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Active configuration section renders
// ---------------------------------------------------------------------------
test('active configuration section renders with provider and model', async ({ page }) => {
  await page.goto('/strategy');
  const configCard = page.locator('.glass-card', { hasText: 'Active Configuration' });
  await expect(configCard).toBeVisible({ timeout: 10000 });

  // Provider should show "deepinfra" within the config card
  await expect(configCard.locator('text=deepinfra')).toBeVisible();

  // Model should show the model name
  await expect(configCard.locator('text=Qwen/Qwen2.5-72B-Instruct')).toBeVisible();

  // Confidence threshold should show "70%"
  await expect(configCard.locator('text=Confidence Threshold')).toBeVisible();
  await expect(configCard.locator('text=70%')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. Stat cards render with usage numbers
// ---------------------------------------------------------------------------
test('stat cards render with usage values', async ({ page }) => {
  await page.goto('/strategy');
  await expect(page.locator('h3', { hasText: 'Active Configuration' })).toBeVisible({ timeout: 10000 });

  // StatCards: "Active Provider", "LLM Calls", "Fallback Rate", "Tokens Used",
  //            "Providers Enabled", "Providers Healthy"
  await expect(page.locator('text=LLM Calls')).toBeVisible();
  await expect(page.locator('text=Fallback Rate')).toBeVisible();
  await expect(page.locator('text=Tokens Used')).toBeVisible();
  await expect(page.getByText('Active Provider', { exact: true })).toBeVisible();

  // Mock values: total_calls=42, total_tokens=128500
  await expect(page.locator('text=42')).toBeVisible();

  // Tokens formatted with toLocaleString -> "128,500"
  await expect(page.locator('text=128,500')).toBeVisible();

  // Fallback rate: 5 / (42+5) * 100 = ~10.6% — use prefix match to tolerate rounding
  await expect(page.locator('text=/10\\.\\d+%/')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 4. Fallback chain renders
// ---------------------------------------------------------------------------
test('fallback chain renders with provider nodes', async ({ page }) => {
  await page.goto('/strategy');
  await expect(page.locator('h3', { hasText: 'Fallback Chain' })).toBeVisible({ timeout: 10000 });

  // The chain should have deepinfra, hyperbolic, ollama
  const chainCard = page.locator('.glass-card', { hasText: 'Fallback Chain' });
  await expect(chainCard.locator('text=deepinfra').first()).toBeVisible();
  await expect(chainCard.locator('text=hyperbolic').first()).toBeVisible();
  await expect(chainCard.locator('text=ollama').first()).toBeVisible();

  // The active provider is shown in the explanation text
  await expect(chainCard.locator('text=Active provider')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 5. Operations table renders with task rows (behind Strategic Operations tab)
// ---------------------------------------------------------------------------
test('operations table renders with recent operations', async ({ page }) => {
  await page.goto('/strategy');
  // Wait for page to load
  await expect(page.locator('h2', { hasText: 'Strategic Brain' })).toBeVisible({ timeout: 10000 });

  // Click the "Strategic Operations" tab to reveal operations table
  await page.locator('button', { hasText: 'Strategic Operations' }).click();

  await expect(
    page.locator('h3', { hasText: 'Recent Strategic Operations' })
  ).toBeVisible({ timeout: 5000 });

  // Check for operation descriptions
  await expect(page.locator('text=Decompose authentication module into subtasks')).toBeVisible();
  await expect(
    page.locator('text=Diagnose failing CI pipeline for database migration')
  ).toBeVisible();
  await expect(page.locator('text=Review code quality of WebSocket refactor')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 6. Operations table shows status badges with correct colors
// ---------------------------------------------------------------------------
test('operations table shows status badges with correct colors', async ({ page }) => {
  await page.goto('/strategy');
  await expect(page.locator('h2', { hasText: 'Strategic Brain' })).toBeVisible({ timeout: 10000 });

  // Click the "Strategic Operations" tab
  await page.locator('button', { hasText: 'Strategic Operations' }).click();

  await expect(
    page.locator('h3', { hasText: 'Recent Strategic Operations' })
  ).toBeVisible({ timeout: 5000 });

  // Operation statuses: completed, running, failed
  const opsSection = page.locator('.glass-card', { hasText: 'Recent Strategic Operations' });
  const table = opsSection.locator('table');
  await expect(table.locator('span', { hasText: 'completed' })).toBeVisible();
  await expect(table.locator('span', { hasText: 'running' })).toBeVisible();
  await expect(table.locator('span', { hasText: 'failed' })).toBeVisible();

  // Verify color classes on status badges
  const completedBadge = table.locator('span', { hasText: 'completed' });
  await expect(completedBadge).toHaveClass(/bg-green-500/);

  const runningBadge = table.locator('span', { hasText: 'running' });
  await expect(runningBadge).toHaveClass(/bg-blue-500/);

  const failedBadge = table.locator('span', { hasText: 'failed' });
  await expect(failedBadge).toHaveClass(/bg-red-500/);
});

// ---------------------------------------------------------------------------
// 7. Operations table shows provider column
// ---------------------------------------------------------------------------
test('operations table shows provider names', async ({ page }) => {
  await page.goto('/strategy');
  await expect(page.locator('h2', { hasText: 'Strategic Brain' })).toBeVisible({ timeout: 10000 });

  // Click the "Strategic Operations" tab
  await page.locator('button', { hasText: 'Strategic Operations' }).click();

  await expect(
    page.locator('h3', { hasText: 'Recent Strategic Operations' })
  ).toBeVisible({ timeout: 5000 });

  // Table header has "Provider" column
  const opsSection = page.locator('.glass-card', { hasText: 'Recent Strategic Operations' });
  const table = opsSection.locator('table');
  await expect(table.locator('th', { hasText: 'Provider' })).toBeVisible();

  // Provider values appear in table cells with the capitalize class
  const providerCells = table.locator('td.capitalize');
  const count = await providerCells.count();
  expect(count).toBe(3);
});

// ---------------------------------------------------------------------------
// 8. Refresh button triggers API re-fetch
// ---------------------------------------------------------------------------
test('refresh button triggers re-fetch', async ({ page }) => {
  let apiCallCount = 0;
  await page.route('**/api/v2/strategic/status', (route) => {
    apiCallCount++;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_STRATEGIC_STATUS }),
    });
  });

  await page.goto('/strategy');
  await expect(page.locator('h2', { hasText: 'Strategic Brain' })).toBeVisible({ timeout: 10000 });

  const callsBefore = apiCallCount;
  const refreshBtn = page.locator('button', { hasText: 'Refresh' });
  await expect(refreshBtn).toBeVisible();
  await refreshBtn.click();

  // Wait for the API to be called again after refresh click
  await page.waitForResponse(url => url.url().includes('/strategic/'), { timeout: 5000 });
  expect(apiCallCount).toBeGreaterThan(callsBefore);
});

// ---------------------------------------------------------------------------
// 9. Configuration labels are all present
// ---------------------------------------------------------------------------
test('configuration section shows all labels', async ({ page }) => {
  await page.goto('/strategy');
  await expect(page.locator('h3', { hasText: 'Active Configuration' })).toBeVisible({ timeout: 10000 });

  await expect(page.locator('text=Provider').first()).toBeVisible();
  await expect(page.locator('text=Model').first()).toBeVisible();
  await expect(page.locator('text=Confidence Threshold')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 10. Auto-refresh does not crash the page
// ---------------------------------------------------------------------------
test('auto-refresh does not crash after initial load', async ({ page }) => {
  let apiCallCount = 0;
  await page.route('**/api/v2/strategic/status', (route) => {
    apiCallCount++;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_STRATEGIC_STATUS }),
    });
  });

  await page.goto('/strategy');
  await expect(page.locator('h2', { hasText: 'Strategic Brain' })).toBeVisible({ timeout: 10000 });

  const initialCalls = apiCallCount;

  // Wait for at least one auto-refresh cycle (Strategic interval is 15s)
  await page.waitForRequest(url => url.url().includes('/strategic/'), { timeout: 20000 });

  // Should have made additional calls
  expect(apiCallCount).toBeGreaterThan(initialCalls);

  // Page should still show content
  await expect(page.locator('h2', { hasText: 'Strategic Brain' })).toBeVisible();

  // Decision History is the default tab, so verify that's visible
  await expect(
    page.locator('h3', { hasText: 'Decision History' })
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// 11. Operations table has correct column headers
// ---------------------------------------------------------------------------
test('operations table has correct column headers', async ({ page }) => {
  await page.goto('/strategy');
  await expect(page.locator('h2', { hasText: 'Strategic Brain' })).toBeVisible({ timeout: 10000 });

  // Click the "Strategic Operations" tab
  await page.locator('button', { hasText: 'Strategic Operations' }).click();

  await expect(
    page.locator('h3', { hasText: 'Recent Strategic Operations' })
  ).toBeVisible({ timeout: 5000 });

  const opsSection = page.locator('.glass-card', { hasText: 'Recent Strategic Operations' });
  const table = opsSection.locator('table');
  await expect(table.locator('th', { hasText: 'Task' })).toBeVisible();
  await expect(table.locator('th', { hasText: 'Status' })).toBeVisible();
  await expect(table.locator('th', { hasText: 'Provider' })).toBeVisible();
  await expect(table.locator('th', { hasText: 'Created' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// 12. Fallback chain explanation text is present
// ---------------------------------------------------------------------------
test('fallback chain shows explanation text', async ({ page }) => {
  await page.goto('/strategy');
  await expect(page.locator('h3', { hasText: 'Fallback Chain' })).toBeVisible({ timeout: 10000 });

  await expect(
    page.locator('text=Chain walks left-to-right until a healthy provider with credentials is found.')
  ).toBeVisible();
});
