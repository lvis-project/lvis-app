import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for Electron UI E2E tests.
 *
 * These tests are opt-in via `E2E=1` env var. The default vitest suite
 * does NOT invoke Playwright — use `bunx playwright test` or
 * `npx playwright test` to run these.
 */
export default defineConfig({
  testDir: './test/e2e',
  testIgnore: ['**/marketplace-e2e.test.ts'],
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
