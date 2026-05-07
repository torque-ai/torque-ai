// @ts-check
import { defineConfig } from '@playwright/test';

const configuredDevPort = Number.parseInt(process.env.TORQUE_DASHBOARD_DEV_PORT || '', 10);
const devPort = Number.isFinite(configuredDevPort) && configuredDevPort > 0 ? configuredDevPort : 5173;
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${devPort}`;
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results';
const testLane = Boolean(process.env.TORQUE_TEST_LANE);
const workers = testLane ? 1 : undefined;

process.env.VITE_TORQUE_E2E_AUTH_BYPASS = process.env.VITE_TORQUE_E2E_AUTH_BYPASS || '1';

/**
 * Playwright E2E configuration for the TORQUE dashboard.
 *
 * Uses the Playwright-managed Chromium browser binary.
 *
 * To install/update browser binaries:
 *
 *   npx playwright install chromium
 */
export default defineConfig({
  testDir: './e2e',
  outputDir,
  timeout: process.env.CI ? 60000 : 30000,
  expect: {
    timeout: process.env.CI ? 10000 : 5000,
  },
  fullyParallel: false,
  workers,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {},
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: baseURL,
    reuseExistingServer: !process.env.CI && !testLane,
    timeout: 60000,
  },
});
