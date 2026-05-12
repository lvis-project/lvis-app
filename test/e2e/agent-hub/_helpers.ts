/**
 * Shared helpers for agent-hub v3 E2E tests.
 *
 * Extracted to avoid duplication between agent-hub-v3.spec.ts and
 * v3-ia-stretch.spec.ts.  All helpers are pure functions over Playwright's
 * Page / Locator types — no fixture state is imported here.
 */

import type { ElectronApplication, Page, Locator } from 'playwright';
import type { AgentHubMockServer } from './fixtures/agent-hub-mock-server';

const AGENT_HUB_PANEL_SELECTORS = ['[data-testid="work-board-panel"]'];

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to the agent-hub plugin view from the current host navigation.
 * Returns true if found and clicked, false if the plugin is not present
 * (treat false as a skip signal in the calling test).
 */
export async function openAgentHubTab(page: Page): Promise<boolean> {
  const gridButton = page.locator('[data-testid="plugin-grid-button"]').first();
  const gridVisible = await gridButton
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (gridVisible) {
    await gridButton.click();
    const gridSelectors = [
      '[data-testid="plugin-cell-plugin-agent-hub-agent-hub-panel"]',
      'button[data-viewkey="plugin:agent-hub:agent-hub-panel"]',
      '[data-testid^="plugin-cell-plugin-agent-hub-"]:has-text("Agent Hub")',
      '[data-testid^="plugin-cell-plugin-agent-hub-"]:has-text("업무 보드")',
    ];
    for (const sel of gridSelectors) {
      const cell = page.locator(sel).first();
      const visible = await cell
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (visible) {
        await cell.click();
        return true;
      }
    }
  }

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

export async function openAgentHubView(
  page: Page,
  app: ElectronApplication,
): Promise<Page | null> {
  const knownPages = new Set(app.windows());
  const detachedWindowPromise = app
    .waitForEvent('window', { timeout: 10_000 })
    .catch(() => null);

  const opened = await openAgentHubTab(page);
  if (!opened) return null;

  const embeddedVisible = await page
    .locator('webview')
    .first()
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (embeddedVisible) return page;

  const detachedWindow = await detachedWindowPromise;
  if (detachedWindow) {
    await detachedWindow.waitForLoadState('domcontentloaded').catch(() => {});
    await detachedWindow
      .locator('webview')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {});
    return detachedWindow;
  }

  for (const candidate of app.windows()) {
    if (knownPages.has(candidate)) continue;
    const hasWebview = await candidate
      .locator('webview')
      .first()
      .isVisible()
      .catch(() => false);
    if (hasWebview) return candidate;
  }

  return null;
}

export async function isAgentHubPanelMounted(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(async ({ webContents }, selectors) => {
    const script = `
      (() => {
        const selectors = ${JSON.stringify(selectors)};
        return selectors.some((selector) => {
          const el = document.querySelector(selector);
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== "hidden" && style.display !== "none";
        });
      })()
    `;

    for (const contents of webContents.getAllWebContents()) {
      if (contents.getType() !== 'webview') continue;
      const mounted = await contents.executeJavaScript(script, true).catch(() => false);
      if (mounted) return true;
    }

    return false;
  }, AGENT_HUB_PANEL_SELECTORS);
}

/**
 * Wait for the agent-hub v3 panel to be visible.
 * Returns the panel Locator, or null when the panel is not present.
 */
export async function waitForV3Panel(
  page: Page,
  timeout = 20_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    for (const selector of AGENT_HUB_PANEL_SELECTORS) {
      const panel = page.locator(selector).first();
      if (await panel.isVisible().catch(() => false)) {
        return panel;
      }
    }

    for (const frame of page.frames()) {
      for (const selector of AGENT_HUB_PANEL_SELECTORS) {
        const panel = frame.locator(selector).first();
        if (await panel.isVisible().catch(() => false)) {
          return panel;
        }
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
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
  const isHostWebview = await panel
    .evaluate((el) => el.tagName.toLowerCase() === 'webview')
    .catch(() => false);
  if (isHostWebview) return false;

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
 * Inject the agent-hub mock server's base URL into the already-loaded
 * Electron window.  The plugin's fetch logic reads `window.lvisEnv.AGENT_HUB_API_BASE`
 * (and `__LVIS_AGENT_HUB_MOCK_BASE__` legacy alias) and dispatches to that origin.
 *
 * Uses `page.evaluate()` rather than `page.addInitScript()` — the latter only
 * fires on page navigation and is a no-op for already-loaded Electron windows.
 *
 * No `page.route()` interception is performed: AgentHubMockServer is a real
 * HTTP endpoint on localhost, so the plugin's fetches reach it directly via
 * the injected base URL.  Future iteration may add `page.route()` if hard
 * network isolation is needed.
 *
 * Must be called BEFORE `openAgentHubTab()` so the panel's mount-time fetches
 * already see the mock URL.
 *
 * @param page        Playwright Page object for the main Electron window.
 * @param mockServer  Running AgentHubMockServer instance.
 */
export async function injectMockBaseUrl(
  page: Page,
  mockServer: AgentHubMockServer,
): Promise<void> {
  const base = mockServer.baseUrl;

  // Expose the mock base URL to in-page code so the plugin's fetch logic
  // resolves to the running AgentHubMockServer.  evaluate() (not
  // addInitScript) works on the already-loaded Electron window.
  // Note: no page.route() interception — the mock server is a real HTTP
  // endpoint on localhost; requests reach it directly via this base URL.
  await page.evaluate((baseUrl: string) => {
    const win = window as any;
    win.__LVIS_AGENT_HUB_MOCK_BASE__ = baseUrl;
    win.lvisEnv = win.lvisEnv ?? {};
    win.lvisEnv.AGENT_HUB_API_BASE = baseUrl;
  }, base);
}
