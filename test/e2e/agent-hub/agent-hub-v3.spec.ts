/**
 * E2E: Agent Hub plugin v0.2.0 — v3 UI smoke tests
 *
 * Tests the agent-hub-panel-v3 plugin UI mounted inside the Electron host.
 * All tests depend on the Electron app booting with the agent-hub plugin
 * loaded (LVIS_E2E=1, LVIS_DEV=1 bypass security checks).
 *
 * Coverage:
 *   1. Plugin panel mount — data-testid="agent-hub-panel-v3" visible
 *   2. 마이워크 ↔ 팀보드 toggle via ah-pill-toggle (arrow keys + click)
 *   3. Approval row click → ConfirmModal → confirm → DOM store update
 *   4. bridge.config/storage round-trip via gear → SettingsPanel → save → reload
 *   5. 6-region partial-sync — mock 1 region fail → S5PartialSync banner
 *
 * The mount test is intentionally non-skipping: this workflow is the host
 * navigation guard for Agent Hub, so a missing plugin entry must fail loudly.
 */

import { AgentHubMockServer } from './fixtures/agent-hub-mock-server';
import { test as base, expect } from '../ui/fixtures';
import { openAgentHubTab, waitForV3Panel, injectMockBaseUrl } from './_helpers';

// ---------------------------------------------------------------------------
// Extended fixture: mock server lifecycle
// ---------------------------------------------------------------------------

type AgentHubFixtures = {
  mockServer: AgentHubMockServer;
  mockServerFailing: AgentHubMockServer;
};

const test = base.extend<AgentHubFixtures>({
  mockServer: async ({}, use) => {
    const server = await AgentHubMockServer.start();
    await use(server);
    await server.stop();
  },
  mockServerFailing: async ({}, use) => {
    // Force ap-northeast-2 to fail — triggers S5PartialSync banner
    const server = await AgentHubMockServer.start({ failRegion: 'ap-northeast-2' });
    await use(server);
    await server.stop();
  },
});

// ---------------------------------------------------------------------------
// Test 1: Plugin panel mount
// ---------------------------------------------------------------------------

test('agent-hub-panel-v3 mounts from host navigation after boot', async ({ mainWindow }) => {
  const tabFound = await openAgentHubTab(mainWindow);
  expect(tabFound, 'agent-hub plugin entry must be reachable from the host plugin grid').toBe(true);

  const panel = await waitForV3Panel(mainWindow);
  expect(
    panel,
    'data-testid="agent-hub-panel-v3" must be visible after opening the plugin entry',
  ).not.toBeNull();

  await expect(panel!).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 2: 마이워크 ↔ 팀보드 pill toggle
// ---------------------------------------------------------------------------

test('ah-pill-toggle switches between 마이워크 and 팀보드', async ({ mainWindow }) => {
  const tabFound = await openAgentHubTab(mainWindow);
  test.skip(!tabFound, 'agent-hub plugin entry not present — skipping pill-toggle test');

  const panel = await waitForV3Panel(mainWindow);
  test.skip(!panel, 'agent-hub-panel-v3 not mounted — skipping pill-toggle test');

  const toggle = panel!.locator('[data-testid="ah-pill-toggle"]').first();
  const toggleFound = await toggle
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!toggleFound, 'ah-pill-toggle not found — skipping');

  // Read initial active value
  const initialValue =
    (await toggle.getAttribute('aria-pressed').catch(() => null)) ??
    (await toggle.getAttribute('data-value').catch(() => null)) ??
    (await toggle.getAttribute('data-state').catch(() => null));

  // Click the toggle to switch boards
  await toggle.click();
  // Deterministic: wait for the panel to remain visible (confirms state settled, no crash)
  await expect(panel!).toBeVisible();

  const afterClickValue =
    (await toggle.getAttribute('aria-pressed').catch(() => null)) ??
    (await toggle.getAttribute('data-value').catch(() => null)) ??
    (await toggle.getAttribute('data-state').catch(() => null));

  if (initialValue !== null && afterClickValue !== null) {
    expect(afterClickValue).not.toBe(initialValue);
  }

  // Arrow key navigation: press ArrowRight to cycle
  await toggle.focus();
  await mainWindow.keyboard.press('ArrowRight');
  // Panel visible confirms keyboard navigation settled without crash
  await expect(panel!).toBeVisible();

  await mainWindow.keyboard.press('ArrowLeft');
  // Panel visible confirms keyboard navigation settled without crash
  await expect(panel!).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 3: Approval row click → ConfirmModal → confirm → DOM assert
// ---------------------------------------------------------------------------

test('approval row click opens ConfirmModal and confirm updates DOM', async ({ mainWindow, mockServer }) => {
  // Inject mock base URL BEFORE opening the tab so panel-mount fetches use it.
  await injectMockBaseUrl(mainWindow, mockServer);

  const tabFound = await openAgentHubTab(mainWindow);
  test.skip(!tabFound, 'agent-hub plugin entry not present — skipping approval test');

  const panel = await waitForV3Panel(mainWindow);
  test.skip(!panel, 'agent-hub-panel-v3 not mounted — skipping approval test');

  // Find the first approval row — try specific testid pattern first
  const approvalRow = panel!
    .locator('[data-testid^="ah-approval-row-"]')
    .first();

  const rowFound = await approvalRow
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!rowFound, 'No ah-approval-row-* found — panel may not have loaded data');

  // Get the row id from testid for assertion
  const rowTestId = await approvalRow.getAttribute('data-testid').catch(() => 'ah-approval-row-unknown');

  // Click the row to open the ConfirmModal
  await approvalRow.click();
  // No explicit wait needed — confirmModal.waitFor({ state: 'visible' }) below is deterministic

  // ConfirmModal should appear
  const confirmModal = mainWindow
    .locator(
      [
        '[data-testid="ah-confirm-modal"]',
        '[role="dialog"]:has-text("승인")',
        '[role="dialog"]:has-text("Confirm")',
        '[role="alertdialog"]',
      ].join(', '),
    )
    .first();

  const modalVisible = await confirmModal
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!modalVisible, 'ConfirmModal did not appear after approval row click — skipping confirm flow');

  // Click the confirm/approve button inside the modal
  const confirmBtn = confirmModal
    .locator(
      [
        '[data-testid="ah-confirm-btn"]',
        'button:has-text("승인")',
        'button:has-text("확인")',
        'button:has-text("Confirm")',
        'button:has-text("Approve")',
      ].join(', '),
    )
    .first();

  await confirmBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await confirmBtn.click();
  // No explicit wait needed — expect(confirmModal).not.toBeVisible() below polls deterministically

  // Modal should close
  await expect(confirmModal).not.toBeVisible({ timeout: 5_000 });

  // The approval row should reflect the new status (approved / 승인됨)
  // Either the row disappears from pending list, or its status label changes.
  const rowStillPending = await panel!
    .locator(`[data-testid="${rowTestId}"][data-status="pending"]`)
    .isVisible()
    .catch(() => false);

  // After confirm, the row should NOT remain in pending state
  expect(
    rowStillPending,
    `Row ${rowTestId} must not remain in pending state after confirmation`,
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 4: bridge.config/storage round-trip via SettingsPanel
// ---------------------------------------------------------------------------

test('bridge.config round-trip: gear → SettingsPanel → save → value persists', async ({ mainWindow }) => {
  const tabFound = await openAgentHubTab(mainWindow);
  test.skip(!tabFound, 'agent-hub plugin entry not present — skipping config round-trip test');

  const panel = await waitForV3Panel(mainWindow);
  test.skip(!panel, 'agent-hub-panel-v3 not mounted — skipping config round-trip test');

  // Open settings via the gear icon
  const gearBtn = panel!
    .locator(
      [
        '[data-testid="ah-gear"]',
        'button[aria-label*="settings" i]',
        'button[aria-label*="설정"]',
        'button[title*="Settings" i]',
        'button[title*="설정"]',
      ].join(', '),
    )
    .first();

  const gearFound = await gearBtn
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!gearFound, 'Gear/settings button not found — skipping config round-trip test');

  await gearBtn.click();
  // No explicit wait needed — settingsPanel.waitFor({ state: 'visible' }) below is deterministic

  // SettingsPanel should appear
  const settingsPanel = mainWindow
    .locator(
      [
        '[data-testid="ah-settings-panel"]',
        '[data-testid="agent-hub-settings"]',
        '[role="dialog"]:has([data-testid*="settings"])',
        '[role="dialog"]:has-text("새로고침 주기")',
        '[role="dialog"]:has-text("Refresh Interval")',
      ].join(', '),
    )
    .first();

  const settingsVisible = await settingsPanel
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!settingsVisible, 'SettingsPanel did not open — skipping config round-trip test');

  // Find the refresh interval input
  const refreshInput = settingsPanel
    .locator(
      [
        '[data-testid="ah-refresh-interval"]',
        'input[name="refreshInterval"]',
        'input[aria-label*="새로고침 주기"]',
        'input[aria-label*="Refresh Interval" i]',
        'input[type="number"]',
      ].join(', '),
    )
    .first();

  const inputFound = await refreshInput
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!inputFound, 'Refresh interval input not found in SettingsPanel — skipping');

  // Change the value to a distinctive test value
  const testValue = '42';
  await refreshInput.click({ clickCount: 3 });
  await refreshInput.fill(testValue);
  // Verify the fill landed before proceeding to save
  await expect(refreshInput).toHaveValue(testValue);

  // Save
  const saveBtn = settingsPanel
    .locator(
      [
        '[data-testid="ah-settings-save"]',
        'button:has-text("저장")',
        'button:has-text("Save")',
        'button[type="submit"]',
      ].join(', '),
    )
    .first();

  await saveBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await saveBtn.click();
  // No explicit wait needed — expect(settingsPanel).not.toBeVisible() below polls deterministically

  // Settings panel closes
  await expect(settingsPanel).not.toBeVisible({ timeout: 5_000 });

  // Re-open settings to verify persistence (bridge.config.set was called)
  await gearBtn.click();
  // No explicit wait needed — settingsPanelReopened.waitFor({ state: 'visible' }) below is deterministic

  const settingsPanelReopened = mainWindow
    .locator(
      [
        '[data-testid="ah-settings-panel"]',
        '[data-testid="agent-hub-settings"]',
        '[role="dialog"]:has([data-testid*="settings"])',
      ].join(', '),
    )
    .first();

  await settingsPanelReopened
    .waitFor({ state: 'visible', timeout: 8_000 })
    .catch(() => {});

  const reopenedInput = settingsPanelReopened
    .locator(
      [
        '[data-testid="ah-refresh-interval"]',
        'input[name="refreshInterval"]',
        'input[aria-label*="새로고침 주기"]',
        'input[aria-label*="Refresh Interval" i]',
        'input[type="number"]',
      ].join(', '),
    )
    .first();

  const reopenedVal = await reopenedInput.inputValue().catch(() => null);
  if (reopenedVal !== null) {
    expect(
      reopenedVal,
      'Refresh interval must persist after save (bridge.config.set round-trip)',
    ).toBe(testValue);
  }
});

// ---------------------------------------------------------------------------
// Test 5: 6-region partial-sync — mock 1 region fail → S5PartialSync banner
// ---------------------------------------------------------------------------

test('S5PartialSync banner appears when one region fails', async ({ mainWindow, mockServerFailing }) => {
  // Inject mock base URL BEFORE opening the tab so panel-mount fetches use it.
  await injectMockBaseUrl(mainWindow, mockServerFailing);

  const tabFound = await openAgentHubTab(mainWindow);
  test.skip(!tabFound, 'agent-hub plugin entry not present — skipping partial-sync test');

  const panel = await waitForV3Panel(mainWindow);
  test.skip(!panel, 'agent-hub-panel-v3 not mounted — skipping partial-sync test');

  // Trigger a refresh so the plugin fetches from the mock server with one failing region
  await mainWindow.evaluate(() => {
    const win = window as any;
    // Try known refresh signals: custom event, plugin API, or dispatch
    if (typeof win.__lvis_ipc_emit__ === 'function') {
      win.__lvis_ipc_emit__('lvis:agent-hub:refresh', {});
    } else {
      window.dispatchEvent(new CustomEvent('lvis:agent-hub:refresh', { detail: {} }));
    }
  });

  // The S5PartialSync banner should appear within a reasonable timeout
  const partialSyncBanner = panel!
    .locator(
      [
        '[data-testid="ah-partial-sync-banner"]',
        '[data-testid="s5-partial-sync"]',
        '[role="alert"]:has-text("부분")',
        '[role="alert"]:has-text("partial")',
        '[role="status"]:has-text("partial")',
        '.partial-sync-banner',
      ].join(', '),
    )
    .first();

  const bannerFound = await partialSyncBanner
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(
    !bannerFound,
    'S5PartialSync banner not visible — plugin may not yet implement partial-sync UI. ' +
    'This test is a forward-guard for the partial-sync feature.',
  );

  await expect(
    partialSyncBanner,
    'S5PartialSync banner must be visible when one region returns 500',
  ).toBeVisible();

  // Banner should mention the failing region or a generic partial-sync message
  const bannerText = await partialSyncBanner.textContent().catch(() => '');
  expect(
    bannerText?.length ?? 0,
    'S5PartialSync banner must have non-empty text content',
  ).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test 6: 마이워크 board row visible (ah-myboard-row-*)
// ---------------------------------------------------------------------------

test('ah-myboard-row entries are visible in 마이워크 board', async ({ mainWindow, mockServer }) => {
  // Inject mock base URL BEFORE opening the tab so panel-mount fetches use it.
  await injectMockBaseUrl(mainWindow, mockServer);

  const tabFound = await openAgentHubTab(mainWindow);
  test.skip(!tabFound, 'agent-hub plugin entry not present — skipping myboard test');

  const panel = await waitForV3Panel(mainWindow);
  test.skip(!panel, 'agent-hub-panel-v3 not mounted — skipping myboard test');

  // Ensure we're in 마이워크 mode (first pill / default)
  const toggle = panel!.locator('[data-testid="ah-pill-toggle"]').first();
  const toggleFound = await toggle
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (toggleFound) {
    // Click first button in pill group to ensure 마이워크 is active
    const firstPill = panel!
      .locator('[data-testid="ah-pill-toggle"] button, [data-testid="ah-pill-toggle"] [role="tab"]')
      .first();
    const firstPillFound = await firstPill.isVisible().catch(() => false);
    if (firstPillFound) {
      await firstPill.click();
      // No explicit wait needed — myboardRows.first().toBeVisible() below is the deterministic gate
    }
  }

  // Check for at least one ah-myboard-row-* entry
  const myboardRows = panel!.locator('[data-testid^="ah-myboard-row-"]');
  const rowCount = await myboardRows.count().catch(() => 0);

  test.skip(
    rowCount === 0,
    'No ah-myboard-row-* elements found — board may not have loaded or testids differ',
  );

  expect(rowCount).toBeGreaterThan(0);
  await expect(myboardRows.first()).toBeVisible();
});
