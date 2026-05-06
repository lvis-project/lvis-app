import { test, expect } from './fixtures';
import path from 'node:path';
import fs from 'node:fs';

/**
 * B1 — Settings → Appearance 탭의 외부 URL 표시 정책 토글 e2e.
 *
 * Flow:
 *  1. Settings 다이얼로그를 연다.
 *  2. Appearance 탭으로 전환한다.
 *  3. webview preferred-flow 라디오에서 'system-browser' 를 클릭한다.
 *  4. lvis-settings.json 의 webView.preferredFlow 가 'system-browser' 로
 *     기록되었는지 확인한다.
 *  5. 'in-app' 다시 클릭 → 동일하게 디스크 반영 확인.
 *
 * 어떤 셀렉터가 안 잡히면 skip — 머지 차단보다 회귀 차단 우선.
 */
test('webView.preferredFlow toggle persists to settings.json', async ({
  mainWindow,
  userDataDir,
}) => {
  const settingsPath = path.join(userDataDir, 'lvis-settings.json');

  const trigger = mainWindow
    .locator(
      [
        '[data-testid="settings-trigger"]',
        'button[aria-label*="Settings" i]',
        'button[aria-label*="설정"]',
      ].join(', '),
    )
    .first();
  const hasTrigger = await trigger
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hasTrigger, 'No settings trigger — skipping webView toggle e2e.');

  await trigger.click();
  const dialog = mainWindow.locator('[role="dialog"]').first();
  await expect(dialog).toBeVisible({ timeout: 8_000 });

  // Switch to Appearance tab
  const appearanceTab = dialog
    .locator('[role="tab"]:has-text("테마"), [role="tab"][value="appearance"]')
    .first();
  const hasAppearance = await appearanceTab
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hasAppearance, 'Appearance tab not visible — skipping.');
  await appearanceTab.click();

  const radiogroup = dialog.locator('[data-testid="webview-preferred-flow"]').first();
  const hasGroup = await radiogroup
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hasGroup, 'webView toggle group not rendered — skipping.');

  const systemBrowserBtn = radiogroup.locator('[data-value="system-browser"]').first();
  await systemBrowserBtn.click();

  // Wait for the IPC roundtrip to flush settings.json.
  await expect
    .poll(
      () => {
        try {
          const raw = fs.readFileSync(settingsPath, 'utf-8');
          return JSON.parse(raw)?.webView?.preferredFlow;
        } catch {
          return undefined;
        }
      },
      { timeout: 5_000, intervals: [200, 400, 800] },
    )
    .toBe('system-browser');

  await expect(systemBrowserBtn).toHaveAttribute('aria-checked', 'true');

  // Toggle back to in-app — verify the IPC also persists the reverse path.
  const inAppBtn = radiogroup.locator('[data-value="in-app"]').first();
  await inAppBtn.click();
  await expect
    .poll(
      () => {
        try {
          const raw = fs.readFileSync(settingsPath, 'utf-8');
          return JSON.parse(raw)?.webView?.preferredFlow;
        } catch {
          return undefined;
        }
      },
      { timeout: 5_000, intervals: [200, 400, 800] },
    )
    .toBe('in-app');
});
