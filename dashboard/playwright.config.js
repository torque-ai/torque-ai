// @ts-check
import { defineConfig } from '@playwright/test';

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
  timeout: process.env.CI ? 60000 : 30000,
  expect: {
    timeout: process.env.CI ? 10000 : 5000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
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
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
