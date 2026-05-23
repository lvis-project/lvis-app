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
  // github-hosted ARM64 (4 vCPU, single worker) is slower than the former
  // self-hosted box, so the Electron suite needs generous per-test headroom
  // and an extra retry to absorb cold-start / render jitter on CI.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
