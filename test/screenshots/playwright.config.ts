import { defineConfig } from '@playwright/test';

/**
 * Standalone Playwright config for the screenshot-capture harness.
 *
 * Deliberately separate from the repo-root `playwright.config.ts` (which is
 * scoped to `./test/e2e` and owned by the UI E2E suite) so this harness can
 * be added without touching that file — see test/screenshots/README.md for
 * the rationale. Run via `node scripts/capture-screenshots.mjs` or directly:
 *
 *   bunx playwright test --config test/screenshots/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /capture\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
