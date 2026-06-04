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
  // 2 retries in CI: the suite has a few inherently timing-sensitive specs
  // (perf budgets, scroll settle). The deterministic fixes land in the specs;
  // this is a safety net against residual CI render-timing variance so a single
  // transient sample doesn't red the whole suite (#1218).
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
