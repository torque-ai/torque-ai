// @ts-check
import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock data — same shape as what the TORQUE API returns
// ---------------------------------------------------------------------------

const MOCK_FREE_TIER_STATUS = {
  status: 'ok',
  providers: {
    groq: {
      rpm_limit: 30,
      rpd_limit: 14400,
      tpm_limit: 6000,
      tpd_limit: 500000,
      minute_requests: 5,
      minute_tokens: 1200,
      daily_requests: 100,
      daily_tokens: 25000,
      cooldown_remaining_seconds: 0,
      minute_resets_in_seconds: 45,
      daily_resets_in_seconds: 43200,
    },
    cerebras: {
      rpm_limit: 30,
      rpd_limit: 14400,
      tpm_limit: 8000,
      tpd_limit: 1000000,
      minute_requests: 0,
      minute_tokens: 0,
      daily_requests: 0,
      daily_tokens: 0,
      cooldown_remaining_seconds: 30,
      minute_resets_in_seconds: 60,
      daily_resets_in_seconds: 86400,
    },
  },
};

const MOCK_FREE_TIER_HISTORY = {
  history: [
    { date: '2026-03-06', provider: 'groq', total_requests: 45 },
    { date: '2026-03-06', provider: 'cerebras', total_requests: 12 },
    { date: '2026-03-07', provider: 'groq', total_requests: 60 },
    { date: '2026-03-07', provider: 'cerebras', total_requests: 8 },
    { date: '2026-03-08', provider: 'groq', total_requests: 100 },
    { date: '2026-03-08', provider: 'cerebras', total_requests: 0 },
  ],
};

// ---------------------------------------------------------------------------
// Intercept API calls at the page level so no mock server is needed
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/status', (route) => {
    route.fulfill({ json: { authenticated: true, mode: 'open' } });
  });
  await page.route('**/api/quota/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_FREE_TIER_STATUS),
    });
  });

  await page.route('**/api/quota/history*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_FREE_TIER_HISTORY),
    });
  });

  // Catch-all for other API routes that the layout/shell might call
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    // Let quota routes through (handled above)
    if (url.includes('/api/quota/')) {
      route.fallback();
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
});

// ---------------------------------------------------------------------------
// 1. Page loads and shows heading
// ---------------------------------------------------------------------------
test('free tier page loads and shows heading', async ({ page }) => {
  await page.goto('/quota');
  await expect(page.locator('h2', { hasText: 'Free Tier Quotas' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('text=Overflow providers for when Codex slots are full')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Provider cards render with names
// ---------------------------------------------------------------------------
test('provider cards render for groq and cerebras', async ({ page }) => {
  await page.goto('/quota');
  await expect(page.locator('h3', { hasText: 'groq' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('h3', { hasText: 'cerebras' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. Usage bars render with quota labels
// ---------------------------------------------------------------------------
test('usage bars render with correct labels', async ({ page }) => {
  await page.goto('/quota');

  // Wait for data to load
  await expect(page.locator('h3', { hasText: 'groq' })).toBeVisible({ timeout: 10000 });

  // Each provider has 4 usage bars, so 2 providers = 8 total bar labels
  await expect(page.locator('text=Requests / Minute')).toHaveCount(2);
  await expect(page.locator('text=Requests / Day')).toHaveCount(2);
  await expect(page.locator('text=Tokens / Minute')).toHaveCount(2);
  await expect(page.locator('text=Tokens / Day')).toHaveCount(2);
});

// ---------------------------------------------------------------------------
// 4. Usage bars show correct quota values
// ---------------------------------------------------------------------------
test('usage bars show correct values for groq', async ({ page }) => {
  await page.goto('/quota');
  await expect(page.locator('h3', { hasText: 'groq' })).toBeVisible({ timeout: 10000 });

  // groq: minute_requests=5 / rpm_limit=30
  await expect(page.locator('text=5 / 30')).toBeVisible();
  // groq: daily_requests=100 / rpd_limit=14,400
  await expect(page.locator('text=100 / 14,400')).toBeVisible();
  // groq: minute_tokens=1,200 / tpm_limit=6,000
  await expect(page.locator('text=1,200 / 6,000')).toBeVisible();
  // groq: daily_tokens=25,000 / tpd_limit=500,000
  await expect(page.locator('text=25,000 / 500,000')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 5. Stat cards show summary numbers
// ---------------------------------------------------------------------------
test('stat cards render with correct summary values', async ({ page }) => {
  await page.goto('/quota');
  await expect(page.locator('h3', { hasText: 'groq' })).toBeVisible({ timeout: 10000 });

  // 4 StatCards: Providers, Available, On Cooldown, Daily Requests
  await expect(page.locator('text=Providers').first()).toBeVisible();
  await expect(page.locator('text=Available').first()).toBeVisible();
  await expect(page.locator('text=On Cooldown')).toBeVisible();
  await expect(page.locator('text=Daily Requests')).toBeVisible();

  // 2 providers total
  // groq available (cooldown=0), cerebras on cooldown (cooldown=30)
  // Available=1, On Cooldown=1, Providers=2, Daily Requests=100
  await expect(page.locator('text=2').first()).toBeVisible();
  await expect(page.locator('text=100').first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 6. Cooldown badge shows for providers on cooldown
// ---------------------------------------------------------------------------
test('cooldown badge appears for cerebras', async ({ page }) => {
  await page.goto('/quota');
  await expect(page.locator('h3', { hasText: 'cerebras' })).toBeVisible({ timeout: 10000 });

  // cerebras has cooldown_remaining_seconds=30 => "Cooldown 30s"
  await expect(page.locator('text=Cooldown 30s')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 7. Available badge shows for providers not on cooldown
// ---------------------------------------------------------------------------
test('available badge appears for groq provider card', async ({ page }) => {
  await page.goto('/quota');
  await expect(page.locator('h3', { hasText: 'groq' })).toBeVisible({ timeout: 10000 });

  // groq has cooldown=0, should show "Available" badge inside its provider card
  // Locate the groq card by its heading, then find the badge within the same card
  const groqCard = page.locator('.glass-card', { has: page.locator('h3', { hasText: 'groq' }) });
  await expect(groqCard.locator('span', { hasText: 'Available' })).toBeVisible();

  // cerebras should NOT have an Available badge (it's on cooldown)
  const cerebrasCard = page.locator('.glass-card', { has: page.locator('h3', { hasText: 'cerebras' }) });
  await expect(cerebrasCard.locator('span', { hasText: 'Available' })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 8. Chart section renders (7-Day Usage History)
// ---------------------------------------------------------------------------
test('chart section renders with heading', async ({ page }) => {
  await page.goto('/quota');

  // Wait for the chart heading
  await expect(page.locator('h3', { hasText: '7-Day Usage History' })).toBeVisible({ timeout: 10000 });

  // The chart section should be present (Recharts SVG or empty message)
  const chartSection = page.locator('.glass-card', { hasText: '7-Day Usage History' });
  await expect(chartSection).toBeVisible();
});

// ---------------------------------------------------------------------------
// 9. Refresh button triggers re-fetch
// ---------------------------------------------------------------------------
test('refresh button is visible and clickable', async ({ page }) => {
  let apiCallCount = 0;
  await page.route('**/api/quota/status', (route) => {
    apiCallCount++;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_FREE_TIER_STATUS),
    });
  });

  await page.goto('/quota');
  await expect(page.locator('h3', { hasText: 'groq' })).toBeVisible({ timeout: 10000 });

  const callsBefore = apiCallCount;
  const refreshBtn = page.locator('button', { hasText: 'Refresh' });
  await expect(refreshBtn).toBeVisible();

  // Click and wait for the resulting API response rather than a fixed timeout
  await Promise.all([
    page.waitForResponse('**/api/quota/status'),
    refreshBtn.click(),
  ]);
  expect(apiCallCount).toBeGreaterThan(callsBefore);
});

// ---------------------------------------------------------------------------
// 10. Auto-refresh triggers additional API calls
// ---------------------------------------------------------------------------
test('auto-refresh does not crash after multiple cycles', async ({ page }) => {
  let apiCallCount = 0;
  await page.route('**/api/quota/status', (route) => {
    apiCallCount++;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_FREE_TIER_STATUS),
    });
  });

  await page.goto('/quota');
  await expect(page.locator('h3', { hasText: 'groq' })).toBeVisible({ timeout: 10000 });

  const initialCalls = apiCallCount;

  // Wait for at least one auto-refresh cycle (interval is 10s)
  await page.waitForTimeout(11000);

  // Should have made additional calls
  expect(apiCallCount).toBeGreaterThan(initialCalls);

  // Page should still be functional
  await expect(page.locator('h3', { hasText: 'groq' })).toBeVisible();
  await expect(page.locator('h3', { hasText: 'cerebras' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// 11. Reset timer values display correctly
// ---------------------------------------------------------------------------
test('reset timer values are displayed', async ({ page }) => {
  await page.goto('/quota');
  await expect(page.locator('h3', { hasText: 'groq' })).toBeVisible({ timeout: 10000 });

  // groq minute_resets_in_seconds=45 => "45s"
  await expect(page.locator('text=45s')).toBeVisible();
  // groq daily_resets_in_seconds=43200 => "12h"
  await expect(page.locator('text=12h')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 12. Page renders properly after navigation
// ---------------------------------------------------------------------------
test('page renders after navigation from another route', async ({ page }) => {
  // Start at root
  await page.goto('/');

  // Navigate to quota via URL
  await page.goto('/quota');
  await expect(page.locator('h2', { hasText: 'Free Tier Quotas' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('h3', { hasText: 'groq' })).toBeVisible();
});
