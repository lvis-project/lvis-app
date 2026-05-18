/**
 * Live Auto-play e2e — proposal §11.
 *
 * Flow:
 *   (1) First-run boot with `LVIS_DEMO_VENDOR` set → autoplay starts,
 *       REC banner is visible.
 *   (2) User triggers take-over via "키 잡기 →" button.
 *   (3) Autoplay overlay disappears, normal chat surface returns.
 *   (4) `~/.lvis/audit/<date>.jsonl` contains `[demo-autoplay]` entries.
 */
import { test, expect } from './fixtures';
import path from 'node:path';
import fs from 'node:fs';

test.describe('Live Auto-play', () => {
  test.use({
    // Force first-run + LVIS_DEMO_VENDOR so the autoplay activation
    // predicate (proposal §7) evaluates true. The fixture also enables
    // the demo login surface so the demo path has its mockup vendor.
    launchEnv: {
      LVIS_DEMO_VENDOR: 'openai',
      LVIS_DEMO_ENABLED: '1',
    },
  });

  test('autoplay overlay shows REC banner, take-over restores normal chat, audit log records [demo-autoplay] entries', async ({
    mainWindow,
    userDataDir,
  }) => {
    // Overlay should appear on first run.
    const overlay = mainWindow.locator('[data-testid="demo-autoplay-overlay"]');
    await expect(overlay).toBeVisible({ timeout: 15_000 });

    // REC indicator + "키 잡기 →" must be visible.
    const recDot = mainWindow.locator('[data-testid="demo-autoplay-banner:rec"]');
    await expect(recDot).toBeVisible();
    await expect(recDot).toContainText('REC');

    const takeOver = mainWindow.locator('[data-testid="demo-autoplay-banner:take-over"]');
    await expect(takeOver).toBeVisible();
    await expect(takeOver).toContainText('키 잡기');

    // Demo entry — user message should render at least.
    const demoUser = mainWindow.locator('[data-testid="demo-entry:user"]').first();
    await expect(demoUser).toBeVisible({ timeout: 5_000 });

    // Take-over click → overlay disappears.
    await takeOver.click();
    await expect(overlay).toBeHidden({ timeout: 5_000 });

    // Normal chat surface should remain — composer host element present.
    // (We don't assert on Composer specifically because its testid may
    // differ across themes; presence of the React root is enough.)
    await expect(mainWindow.locator('#root')).toBeVisible();

    // Audit log assertion — find `[demo-autoplay]` line in today's jsonl.
    // The fixture's `lvisHomeForTest` is `${userDataDir}/.lvis` per
    // fixtures.ts.
    const auditDir = path.join(userDataDir, '.lvis', 'audit');
    const date = new Date().toISOString().slice(0, 10);
    const auditFile = path.join(auditDir, `${date}.jsonl`);
    let attempts = 0;
    let hasDemoEntry = false;
    while (attempts < 10 && !hasDemoEntry) {
      if (fs.existsSync(auditFile)) {
        const content = fs.readFileSync(auditFile, 'utf-8');
        hasDemoEntry = content.includes('[demo-autoplay]');
      }
      if (!hasDemoEntry) {
        await new Promise((r) => setTimeout(r, 300));
        attempts += 1;
      }
    }
    expect(hasDemoEntry, `audit file ${auditFile} should contain [demo-autoplay] entries`).toBe(true);
  });
});

test.describe('Live Auto-play — production dead path', () => {
  // Without LVIS_DEMO_VENDOR the activation predicate must short-circuit
  // (proposal §7 / R2). Overlay must NEVER appear in this configuration.
  test('does not activate when LVIS_DEMO_VENDOR is unset', async ({ mainWindow }) => {
    // Give the renderer time to probe settings; overlay would normally
    // appear within ~1s on first boot if the env predicate matched.
    await mainWindow.waitForTimeout(2_000);
    const overlay = mainWindow.locator('[data-testid="demo-autoplay-overlay"]');
    await expect(overlay).toHaveCount(0);
  });
});
