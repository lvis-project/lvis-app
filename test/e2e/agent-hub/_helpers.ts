/**
 * Shared helpers for agent-hub v3 E2E tests.
 *
 * Extracted to avoid duplication between agent-hub-v3.spec.ts and
 * v3-ia-stretch.spec.ts.  All helpers are pure functions over Playwright's
 * Page / Locator types — no fixture state is imported here.
 */

import type { Page, Locator } from 'playwright';
import type { AgentHubMockServer } from './fixtures/agent-hub-mock-server';

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to the agent-hub plugin tab in the main toolbar.
 * Returns true if found and clicked, false if the plugin is not present
 * (treat false as a skip signal in the calling test).
 */
export async function openAgentHubTab(page: Page): Promise<boolean> {
  const tabSelectors = [
    '[data-testid="agent-hub-tab"]',
    'button[role="tab"]:has-text("에이전트 허브")',
    'button[role="tab"]:has-text("Agent Hub")',
    '[role="tab"]:has-text("에이전트 허브")',
    '[role="tab"]:has-text("Agent Hub")',
  ];

  for (const sel of tabSelectors) {
    const tab = page.locator(sel).first();
    const visible = await tab
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (visible) {
      await tab.click();
      return true;
    }
  }
  return false;
}

/**
 * Wait for the agent-hub v3 panel to be visible.
 * Returns the panel Locator, or null when the panel is not present.
 */
export async function waitForV3Panel(
  page: Page,
  timeout = 20_000,
): Promise<Locator | null> {
  const panel = page.locator('[data-testid="agent-hub-panel-v3"]').first();
  const found = await panel
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  return found ? panel : null;
}

/**
 * Ensure auth has reached S3 (data loaded) by waiting for the mywork toggle
 * button to become enabled.  The toggle is disabled in S0/S1/S2 and enabled
 * only once the plugin reaches S3.
 */
export async function waitForAuthS3(
  panel: Locator,
  timeout = 30_000,
): Promise<boolean> {
  const { expect } = await import('@playwright/test');
  const myworkBtn = panel
    .locator('[data-testid="agent-hub-toggle-mywork"]')
    .first();
  const visible = await myworkBtn
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (!visible) return false;
  // Poll until enabled — avoids a race where the toggle is visible-but-disabled
  // briefly during the S2→S3 auth transition.
  return expect(myworkBtn)
    .toBeEnabled({ timeout })
    .then(() => true)
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// Mock-route injection
// ---------------------------------------------------------------------------

/**
 * Set up Playwright route interception for the agent-hub mock server and
 * inject the base URL into the already-loaded Electron window.
 *
 * Uses page.route() (Playwright-native network interception) rather than
 * page.addInitScript() — the latter only fires on page navigation and is
 * therefore a no-op for already-loaded Electron windows.
 *
 * Must be called BEFORE openAgentHubTab() so that any fetch triggered at
 * panel mount is already intercepted.
 *
 * @param page        Playwright Page object for the main Electron window.
 * @param mockServer  Running AgentHubMockServer instance.
 */
export async function setupMockRoutes(
  page: Page,
  mockServer: AgentHubMockServer,
): Promise<void> {
  const base = mockServer.baseUrl;

  // Intercept all requests destined for the mock server and proxy them
  // through Playwright's route handler — this works for already-loaded
  // windows because route interception operates at the network layer, not
  // at script-evaluation time.
  await page.route(`${base}/**`, async (route) => {
    // Forward to the real mock server running on localhost.
    await route.continue();
  });

  // Expose the mock base URL to in-page code so the plugin's fetch logic
  // picks it up.  evaluate() (not addInitScript) works on the live window.
  await page.evaluate((baseUrl: string) => {
    const win = window as any;
    win.__LVIS_AGENT_HUB_MOCK_BASE__ = baseUrl;
    win.lvisEnv = win.lvisEnv ?? {};
    win.lvisEnv.AGENT_HUB_API_BASE = baseUrl;
  }, base);
}
