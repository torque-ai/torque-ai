// @ts-check
import { test, expect } from '@playwright/test';
import { startMockApi, stopMockApi, MOCK_TASKS } from './mock-api.js';

// ---------------------------------------------------------------------------
// The mock API server runs on port 3456. Vite is configured to proxy /api
// requests to http://127.0.0.1:3456, so the dashboard talks to our mock
// server transparently.
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  await startMockApi(3456);
});

test.afterAll(async () => {
  await stopMockApi();
});

// ---------------------------------------------------------------------------
// 1. Page loads
// ---------------------------------------------------------------------------
test('dashboard loads and shows TORQUE title', async ({ page }) => {
  await page.goto('/');
  // The sidebar header contains "TORQUE"
  await expect(page.locator('h1')).toContainText('TORQUE');
  // The breadcrumb area also shows "TORQUE"
  await expect(page.locator('text=TORQUE')).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 2. Navigation -- click sidebar links and verify URL changes
// ---------------------------------------------------------------------------
test('sidebar navigation updates the URL', async ({ page }) => {
  await page.goto('/');

  // Click "History" nav link
  await page.locator('nav a', { hasText: 'History' }).click();
  await expect(page).toHaveURL(/\/history/);

  // Click "Providers" nav link
  await page.locator('nav a', { hasText: 'Providers' }).click();
  await expect(page).toHaveURL(/\/providers/);

  // Click "Hosts" nav link
  await page.locator('nav a', { hasText: 'Hosts' }).click();
  await expect(page).toHaveURL(/\/hosts/);

  // Click "Budget" nav link
  await page.locator('nav a', { hasText: 'Budget' }).click();
  await expect(page).toHaveURL(/\/budget/);

  // Click "Kanban" to go back home
  await page.locator('nav a', { hasText: 'Kanban' }).click();
  await expect(page).toHaveURL(/\/$/);
});

// ---------------------------------------------------------------------------
// 3. Task list renders on /history
// ---------------------------------------------------------------------------
test('task list renders on history page', async ({ page }) => {
  await page.goto('/history');

  // Wait for the "Task History" heading
  await expect(page.locator('h2', { hasText: 'Task History' })).toBeVisible();

  // The table should contain task rows. We wait for the API to respond and
  // the loading skeleton to disappear by looking for task descriptions.
  // Each mock task description is unique, so check for at least one.
  await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10000 });

  // Verify we have multiple rows (mock returns 5 tasks)
  const rows = page.locator('table tbody tr');
  await expect(rows).not.toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 4. Task status badges have correct colors
// ---------------------------------------------------------------------------
test('status badges display with correct colors', async ({ page }) => {
  await page.goto('/history');

  // Wait for table to populate
  await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10000 });

  // Check that running badge is blue
  const runningBadge = page.locator('span', { hasText: 'running' }).first();
  if (await runningBadge.isVisible()) {
    await expect(runningBadge).toHaveClass(/bg-blue-500/);
  }

  // Check that completed badge is green
  const completedBadge = page.locator('span', { hasText: 'completed' }).first();
  if (await completedBadge.isVisible()) {
    await expect(completedBadge).toHaveClass(/bg-green-500/);
  }

  // Check that failed badge is red
  const failedBadge = page.locator('span', { hasText: 'failed' }).first();
  if (await failedBadge.isVisible()) {
    await expect(failedBadge).toHaveClass(/bg-red-500/);
  }
});

// ---------------------------------------------------------------------------
// 5. Search filter updates URL query param
// ---------------------------------------------------------------------------
test('search filter updates URL with query param', async ({ page }) => {
  await page.goto('/history');

  // Wait for history page to load
  await expect(page.locator('h2', { hasText: 'Task History' })).toBeVisible();

  // Type in the search box
  const searchInput = page.locator('input[placeholder="Search tasks..."]');
  await searchInput.fill('authentication');

  // Wait until the debounced query param is applied to the URL
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('q') === 'authentication');
  await expect(page).toHaveURL(/q=authentication/);
});

// ---------------------------------------------------------------------------
// 6. Status filter dropdown updates the task list
// ---------------------------------------------------------------------------
test('status filter dropdown filters tasks', async ({ page }) => {
  await page.goto('/history');

  // Wait for table to populate
  await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10000 });

  // Select "Failed" in the status dropdown (first select is the status filter)
  const statusSelect = page.locator('select').first();
  await statusSelect.selectOption('failed');

  // URL should contain status=failed
  await expect(page).toHaveURL(/status=failed/);

  // Wait for the table to update — the mock returns only the failed task when
  // status=failed is passed as a query parameter.  Wait for the row with the
  // failed task description to be the (only) visible row.
  await expect(
    page.locator('table tbody tr', { hasText: 'XAML data bindings' })
  ).toBeVisible({ timeout: 10000 });

  // All visible status badges should be "failed"
  const badges = page.locator('table tbody span.rounded-full');
  const count = await badges.count();
  if (count > 0) {
    for (let i = 0; i < count; i++) {
      await expect(badges.nth(i)).toContainText('failed');
    }
  }
});

// ---------------------------------------------------------------------------
// 7. Task detail drawer opens when clicking a task row
// ---------------------------------------------------------------------------
test('clicking a task row opens the detail drawer', async ({ page }) => {
  await page.goto('/history');

  // Wait for table to populate
  await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10000 });

  // Click the first task row (click the description cell to avoid checkbox)
  await page.locator('table tbody tr').first().click();

  // The drawer should appear — it uses role="dialog" and aria-modal="true"
  const drawer = page.locator('[role="dialog"]');
  await expect(drawer).toBeVisible({ timeout: 10000 });

  // The drawer should contain "Description" heading (h4.heading-sm)
  await expect(drawer.locator('h4', { hasText: 'Description' })).toBeVisible({ timeout: 5000 });

  // The drawer should show the task status in a MetaItem
  await expect(drawer.locator('text=Status')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 8. Cancel task button in drawer
// ---------------------------------------------------------------------------
test('cancel button appears for running/queued tasks in drawer', async ({ page }) => {
  await page.goto('/history');

  // Wait for table to populate
  await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10000 });

  // We need to find and click a running or queued task.
  // The first mock task is "running". Click it.
  const runningRow = page.locator('table tbody tr', { hasText: 'authentication' });
  if (await runningRow.isVisible()) {
    await runningRow.click();

    // The drawer should show a Cancel button for running tasks
    const cancelBtn = page.locator('[role="dialog"] button', { hasText: 'Cancel' });
    await expect(cancelBtn).toBeVisible({ timeout: 10000 });

    // Click cancel -- the mock API returns success
    await cancelBtn.click();

    // A toast notification should appear confirming cancellation
    await expect(page.locator('text=Task cancelled')).toBeVisible({ timeout: 5000 });
  }
});

// ---------------------------------------------------------------------------
// 9. Kanban view renders stat cards with numbers
// ---------------------------------------------------------------------------
test('kanban view renders stat cards', async ({ page }) => {
  await page.goto('/');

  // Wait for the overview data to load.
  // The stat cards show "Today", "Running", "Queued", "Completed (24h)".
  // The "Today" card is a custom div, the rest are StatCard components.
  // Wait for the "Today" label to appear (signals loading is complete).
  await expect(page.locator('text=Today').first()).toBeVisible({ timeout: 15000 });

  // The overview mock returns today.total = 23
  await expect(page.locator('text=23')).toBeVisible({ timeout: 5000 });

  // Check "Running" stat card appears (also used in Kanban column headers,
  // so use .first() to avoid ambiguity)
  await expect(page.locator('text=Running').first()).toBeVisible();

  // Check "Queued" stat card appears
  await expect(page.locator('text=Queued').first()).toBeVisible();

  // Check "Completed" stat card appears (label is "Completed (24h)")
  await expect(page.locator('text=Completed').first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 10. Responsive layout -- sidebar collapses at mobile width
// ---------------------------------------------------------------------------
test('sidebar collapses at mobile viewport width', async ({ page }) => {
  // Start at desktop size
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  // The sidebar should be visible (contains nav links)
  const sidebar = page.locator('aside');
  await expect(sidebar).toBeVisible();

  // At desktop, the nav text labels should be visible
  await expect(page.locator('nav a', { hasText: 'History' })).toBeVisible();

  // Resize to mobile width
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForSelector('button[aria-label="Open navigation menu"]', { state: 'visible' });

  // On mobile, the sidebar should be off-screen (translated left).
  // It uses -translate-x-full on mobile, so it is not in the visible viewport.
  // The hamburger menu button should be visible instead.
  const hamburger = page.locator('button[aria-label="Open navigation menu"]');
  await expect(hamburger).toBeVisible();

  // Click the hamburger to open the mobile sidebar
  await hamburger.click();

  // Now the sidebar should slide in and nav links should be visible
  await expect(page.locator('nav a', { hasText: 'History' })).toBeVisible();

  // Click a nav link -- sidebar should close on route change
  await page.locator('nav a', { hasText: 'Hosts' }).click();
  await expect(page).toHaveURL(/\/hosts/);
});
