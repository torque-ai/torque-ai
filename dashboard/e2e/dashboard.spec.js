// @ts-check
import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock data — same shapes as what the TORQUE mock-api.js returns, embedded
// here so we can use Playwright page.route() interception instead of a live
// mock HTTP server + Vite proxy.  Page-level route interception is reliable
// across all CI platforms (the Vite proxy was flaky on ubuntu-22 / Node 22).
// ---------------------------------------------------------------------------

const MOCK_TASKS = [
  {
    id: 'aaaaaaaa-1111-1111-1111-111111111111',
    status: 'running',
    task_description: 'Generate unit tests for the authentication module',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    ollama_host_name: null,
    ollama_host_id: null,
    created_at: new Date(Date.now() - 600_000).toISOString(),
    started_at: new Date(Date.now() - 300_000).toISOString(),
    completed_at: null,
    quality_score: null,
    error_output: null,
    retry_count: 0,
    tags: ['tests'],
    output_chunks: ['Running tests...'],
  },
  {
    id: 'bbbbbbbb-2222-2222-2222-222222222222',
    status: 'completed',
    task_description: 'Refactor database connection pooling logic',
    provider: 'ollama',
    model: 'qwen3:8b',
    ollama_host_name: 'local-gpu',
    ollama_host_id: 'host-1',
    created_at: new Date(Date.now() - 7200_000).toISOString(),
    started_at: new Date(Date.now() - 7000_000).toISOString(),
    completed_at: new Date(Date.now() - 6800_000).toISOString(),
    quality_score: 85,
    error_output: null,
    retry_count: 0,
    tags: ['refactor'],
    output_chunks: ['Refactoring complete. 3 files changed.'],
  },
  {
    id: 'cccccccc-3333-3333-3333-333333333333',
    status: 'failed',
    task_description: 'Add XAML data bindings for settings panel',
    provider: 'claude-cli',
    model: null,
    ollama_host_name: null,
    ollama_host_id: null,
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    started_at: new Date(Date.now() - 3500_000).toISOString(),
    completed_at: new Date(Date.now() - 3400_000).toISOString(),
    quality_score: 22,
    error_output: 'TypeScript compilation failed: TS2304 Cannot find name SettingsViewModel',
    retry_count: 1,
    tags: ['xaml', 'ui'],
    output_chunks: ['Build failed with 2 errors.'],
  },
  {
    id: 'dddddddd-4444-4444-4444-444444444444',
    status: 'completed',
    task_description: 'Write documentation for the REST API endpoints',
    provider: 'ollama',
    model: 'gemma3:4b',
    ollama_host_name: 'local-gpu',
    ollama_host_id: 'host-1',
    created_at: new Date(Date.now() - 14400_000).toISOString(),
    started_at: new Date(Date.now() - 14300_000).toISOString(),
    completed_at: new Date(Date.now() - 14000_000).toISOString(),
    quality_score: 78,
    error_output: null,
    retry_count: 0,
    tags: ['docs'],
    output_chunks: ['Documentation generated for 12 endpoints.'],
  },
  {
    id: 'eeeeeeee-5555-5555-5555-555555555555',
    status: 'queued',
    task_description: 'Optimize webpack bundle size for production build',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    ollama_host_name: null,
    ollama_host_id: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    started_at: null,
    completed_at: null,
    quality_score: null,
    error_output: null,
    retry_count: 0,
    tags: ['perf'],
    output_chunks: [],
  },
];

const MOCK_OVERVIEW = {
  today: { total: 23, completed: 18, failed: 3, successRate: 78 },
  yesterday: { total: 19, completed: 15, failed: 2 },
  active: { running: 1, queued: 1 },
};

const MOCK_TIMESERIES = [
  { date: new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10), completed: 12, failed: 2 },
  { date: new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10), completed: 15, failed: 1 },
  { date: new Date(Date.now() - 4 * 86400_000).toISOString().slice(0, 10), completed: 8, failed: 3 },
  { date: new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10), completed: 20, failed: 0 },
  { date: new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10), completed: 18, failed: 2 },
  { date: new Date(Date.now() - 1 * 86400_000).toISOString().slice(0, 10), completed: 15, failed: 2 },
  { date: new Date().toISOString().slice(0, 10), completed: 18, failed: 3 },
];

// ---------------------------------------------------------------------------
// Intercept API calls at the page level so no mock HTTP server is needed.
//
// The dashboard uses two base URLs:
//   - /api/v2/*  for most endpoints (requestV2 unwraps { data: ... })
//   - /api/*     for legacy endpoints (request returns raw JSON)
//
// V2 responses must be wrapped in { data: ... } since requestV2 unwraps them.
// ---------------------------------------------------------------------------

/** Set up page.route() interception for all API endpoints used by dashboard tests. */
async function interceptApi(page) {
  // -- Auth: always return authenticated --
  await page.route('**/api/auth/status', (route) => {
    route.fulfill({ json: { authenticated: true, mode: 'open' } });
  });

  // -- V2: Tasks list (supports ?status= and ?q= filtering) --
  await page.route('**/api/v2/tasks?**', (route) => {
    const url = new URL(route.request().url());
    let filtered = [...MOCK_TASKS];
    const status = url.searchParams.get('status');
    if (status) {
      filtered = filtered.filter((t) => t.status === status);
    }
    const q = url.searchParams.get('q');
    if (q) {
      const lower = q.toLowerCase();
      filtered = filtered.filter((t) => (t.task_description || '').toLowerCase().includes(lower));
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { items: filtered, total: filtered.length },
        meta: { page: 1, totalPages: 1 },
      }),
    });
  });

  // V2: Tasks list without query string
  await page.route(/\/api\/v2\/tasks$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { items: MOCK_TASKS, total: MOCK_TASKS.length },
        meta: { page: 1, totalPages: 1 },
      }),
    });
  });

  // -- V2: Single task by ID --
  await page.route(/\/api\/v2\/tasks\/[a-f0-9-]+$/, (route) => {
    const url = route.request().url();
    const match = url.match(/\/api\/v2\/tasks\/([a-f0-9-]+)$/);
    const task = match ? MOCK_TASKS.find((t) => t.id === match[1]) : null;
    route.fulfill({
      status: task ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(task ? { data: { ...task } } : { error: { code: 'NOT_FOUND', message: 'Task not found' } }),
    });
  });

  // -- V2: Task diff --
  await page.route(/\/api\/v2\/tasks\/[a-f0-9-]+\/diff$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { diff_content: null, files_changed: 0, lines_added: 0, lines_removed: 0 } }),
    });
  });

  // -- V2: Task logs --
  await page.route(/\/api\/v2\/tasks\/[a-f0-9-]+\/logs$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  // -- V2: Task cancel --
  await page.route(/\/api\/v2\/tasks\/[a-f0-9-]+\/cancel$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { success: true } }),
    });
  });

  // -- Legacy: Task cancel (the Cancel button uses legacy /api/tasks/:id/cancel) --
  await page.route(/\/api\/tasks\/[a-f0-9-]+\/cancel$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  // -- V2: Stats overview --
  await page.route('**/api/v2/stats/overview', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_OVERVIEW }),
    });
  });

  // -- V2: Stats timeseries --
  await page.route('**/api/v2/stats/timeseries*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { series: MOCK_TIMESERIES } }),
    });
  });

  // -- V2: Stats quality --
  await page.route('**/api/v2/stats/quality*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { overall: { avgScore: 74, totalScored: 40 } } }),
    });
  });

  // -- V2: Stats stuck --
  await page.route('**/api/v2/stats/stuck*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { totalNeedsAttention: 0, longRunning: { tasks: [] }, pendingApproval: { tasks: [] }, pendingSwitch: { tasks: [] } } }),
    });
  });

  // -- V2: Stats models --
  await page.route('**/api/v2/stats/models*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    });
  });

  // -- V2: Stats format-success --
  await page.route('**/api/v2/stats/format-success*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    });
  });

  // -- V2: Providers --
  await page.route('**/api/v2/providers', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [
        { id: 'codex', name: 'Codex', enabled: true, tasks_completed: 150, tasks_failed: 8, avg_duration: 45 },
        { id: 'ollama', name: 'Ollama', enabled: true, tasks_completed: 320, tasks_failed: 12, avg_duration: 62 },
        { id: 'claude-cli', name: 'Claude CLI', enabled: true, tasks_completed: 55, tasks_failed: 5, avg_duration: 90 },
        { id: 'deepinfra', name: 'DeepInfra', enabled: false, tasks_completed: 0, tasks_failed: 0, avg_duration: 0 },
      ] } }),
    });
  });

  // -- V2: Provider stats --
  await page.route(/\/api\/v2\/providers\/[^/]+\/stats/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { completed: 50, failed: 2, avg_duration: 45 } }),
    });
  });

  // -- V2: Provider trends --
  await page.route('**/api/v2/providers/trends*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    });
  });

  // -- V2: Hosts --
  await page.route('**/api/v2/hosts/activity*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { hosts: { 'host-1': { gpuMetrics: { vramUsedMb: 3200, vramTotalMb: 8192 } }, 'host-2': { gpuMetrics: { vramUsedMb: 6400, vramTotalMb: 24576 } } } } }),
    });
  });

  await page.route(/\/api\/v2\/hosts$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [
        { id: 'host-1', name: 'local-gpu', url: 'http://localhost:11434', enabled: true, status: 'online', gpu: 'RTX 4060', vram_mb: 8192, running_tasks: 1, max_concurrent: 3, models: ['gemma3:4b', 'qwen3:8b'] },
        { id: 'host-2', name: 'remote-gpu-host', url: 'http://192.168.1.100:11434', enabled: true, status: 'online', gpu: 'RTX 3090', vram_mb: 24576, running_tasks: 0, max_concurrent: 2, models: ['qwen2.5-coder:32b', 'codestral:22b'] },
      ] } }),
    });
  });

  // -- V2: Budget --
  await page.route('**/api/v2/budget/summary*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { totalCost: 4.52, providers: {} } }),
    });
  });

  await page.route('**/api/v2/budget/status*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { budget: 50, spent: 4.52, remaining: 45.48 } }),
    });
  });

  // -- V2: Workflows --
  await page.route('**/api/v2/workflows*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [], total: 0 } }),
    });
  });

  // -- V2: Plan Projects --
  await page.route('**/api/v2/plan-projects*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [], total: 0 } }),
    });
  });

  // -- V2: System status --
  await page.route('**/api/v2/system/status*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { status: 'ok', uptime: 3600 } }),
    });
  });

  // -- V2: Tuning --
  await page.route('**/api/v2/tuning*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    });
  });

  // -- V2: Schedules --
  await page.route('**/api/v2/schedules*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    });
  });

  // -- V2: Approvals --
  await page.route('**/api/v2/approvals*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    });
  });

  // -- V2: Peek Hosts --
  await page.route('**/api/v2/peek-hosts*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    });
  });

  // -- V2: Instances --
  await page.route('**/api/v2/instances*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    });
  });

  // -- V2: Benchmarks --
  await page.route('**/api/v2/benchmarks*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    });
  });

  // -- Legacy: Hosts activity --
  await page.route('**/api/hosts/activity*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hosts: { 'host-1': { gpuMetrics: { vramUsedMb: 3200, vramTotalMb: 8192 } }, 'host-2': { gpuMetrics: { vramUsedMb: 6400, vramTotalMb: 24576 } } } }),
    });
  });

  // -- Legacy: Instances --
  await page.route('**/api/instances*', (route) => {
    const url = route.request().url();
    if (url.includes('/api/v2/')) { route.fallback(); return; }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  // -- Catch-all for any other /api/** routes --
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    // Let specific routes registered above handle their matches
    if (url.includes('/api/v2/') || url.includes('/api/tasks/') || url.includes('/api/hosts/') || url.includes('/api/instances')) {
      route.fallback();
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
}

// ---------------------------------------------------------------------------
// Set up page-level route interception before each test
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await interceptApi(page);
});

// ---------------------------------------------------------------------------
// 1. Page loads
// ---------------------------------------------------------------------------
test('dashboard loads and shows TORQUE title', async ({ page }) => {
  await page.goto('/');
  // The sidebar header contains "TORQUE"
  await expect(page.locator('h1')).toContainText('TORQUE');
  // The breadcrumb area also shows "TORQUE"
  await expect(page.locator('text=TORQUE')).toBeVisible();
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
  await expect(runningBadge).toBeVisible();
  await expect(runningBadge).toHaveClass(/bg-blue-500/);

  // Check that completed badge is green
  const completedBadge = page.locator('span', { hasText: 'completed' }).first();
  await expect(completedBadge).toBeVisible();
  await expect(completedBadge).toHaveClass(/bg-green-500/);

  // Check that failed badge is red
  const failedBadge = page.locator('span', { hasText: 'failed' }).first();
  await expect(failedBadge).toBeVisible();
  await expect(failedBadge).toHaveClass(/bg-red-500/);
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
  await expect(badges.first()).toBeVisible();
  const count = await badges.count();
  for (let i = 0; i < count; i++) {
    await expect(badges.nth(i)).toContainText('failed');
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
  await expect(runningRow).toBeVisible();
  await runningRow.click();

  // The drawer should show a Cancel button for running tasks
  const cancelBtn = page.locator('[role="dialog"] button', { hasText: 'Cancel' });
  await expect(cancelBtn).toBeVisible({ timeout: 10000 });

  // Click cancel -- the mock API returns success
  await cancelBtn.click();

  // A toast notification should appear confirming cancellation
  await expect(page.locator('text=Task cancelled')).toBeVisible({ timeout: 5000 });
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
  // Use exact match to avoid matching "TS2304" in task error text
  await expect(page.getByText('23', { exact: true })).toBeVisible({ timeout: 5000 });

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
