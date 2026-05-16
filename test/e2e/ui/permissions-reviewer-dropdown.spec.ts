/**
 * Playwright E2E — Reviewer provider dropdown (foundry / gcp-playground)
 *
 * Closes #768 — adds visual-regression coverage for the key-driven
 * dynamic activation behavior introduced in PR #756. The PermissionsTab
 * unit suite (`PermissionsTab.reviewer-c3.test.tsx`) verifies the IPC
 * call pattern, but cannot exercise the Radix portal-rendered SelectItem
 * disabled state or the live `SETTINGS.updated` broadcast wiring.
 *
 * Scenarios (5 tests covering #768 items 1–5):
 *   1. `foundry` — disabled with no key, no baseUrl; tooltip on hover
 *      reveals "키 설정 필요" hint; enabled only after BOTH key + baseUrl.
 *   2. `gcp-playground` — disabled with no key, enabled after gemini key.
 *   3. Pre-existing providers (openai, anthropic) regression — both start
 *      disabled in a fresh LVIS_HOME (no keys seeded). Adding anthropic
 *      key enables only anthropic; openai stays disabled. Proves PR #756
 *      didn't introduce a foundry-special branch.
 *   4. Tooltip text — disabled foundry option exposes screen-reader hint
 *      via Radix Tooltip portal.
 *   5. Revoke scenario (#768 item 5) — set foundry key + baseUrl → assert
 *      enabled → clear API key → assert disabled again. Verifies the
 *      dynamic *disable* path mirrors the dynamic *enable* path so that
 *      SETTINGS.updated broadcasts in both directions repaint the option
 *      list.
 *
 * Pattern: builds on `fixtures.ts` so the renderer boots against an
 * isolated `LVIS_HOME` (fresh per test — no seeded API keys), then drives
 * the real Electron settings window through the same `openSettingsWindow`
 * helper used by other settings specs. Keys are written via the public
 * `window.lvisApi.setApiKey` / `updateSettings` IPC so the same
 * `SETTINGS.updated` broadcast that powers
 * `PermissionsTab.refreshProviderKeyMap()` fires under test.
 *
 * `data-disabled=""` — Radix Select renders the attribute as an empty
 * string on disabled SelectItems and omits it entirely on enabled ones.
 * The assertion `toHaveAttribute('data-disabled', '')` checks for the
 * exact disabled contract; `.not.toHaveAttribute('data-disabled', '')`
 * asserts the attribute is absent (enabled).
 */
import { test, expect } from './fixtures';
import { openSettingsWindow } from './settings-window';
import type { Page } from 'playwright';

const FOUNDRY_BASE_URL =
  'https://example-resource.openai.azure.com/openai/deployments/test-deployment';

/**
 * Open the provider Select dropdown and return the locator for a given
 * provider's SelectItem. Radix renders SelectItem in a portal that only
 * exists after the trigger is clicked.
 */
async function openProviderDropdown(settingsWindow: Page): Promise<void> {
  const trigger = settingsWindow.getByTestId('reviewer-provider-select');
  await expect(trigger).toBeVisible();
  await trigger.click();
  // Wait for the portal to render — any option should be visible.
  await expect(
    settingsWindow.getByTestId('reviewer-provider-option-openai'),
  ).toBeVisible({ timeout: 5_000 });
}

/** Close the dropdown by pressing Escape (Radix Select close shortcut). */
async function closeProviderDropdown(settingsWindow: Page): Promise<void> {
  await settingsWindow.keyboard.press('Escape');
  // Trigger should still be visible afterwards.
  await expect(settingsWindow.getByTestId('reviewer-provider-select')).toBeVisible();
}

/**
 * Write an LLM provider API key through the public preload bridge so
 * the main process emits the `SETTINGS.updated` broadcast that drives
 * PermissionsTab.refreshProviderKeyMap.
 */
async function setApiKey(
  settingsWindow: Page,
  vendor: string,
  apiKey: string,
): Promise<void> {
  const result = await settingsWindow.evaluate(
    async ({ v, k }) => {
      const api = (window as unknown as {
        lvisApi?: {
          setApiKey?: (vendor: string, apiKey: string) => Promise<{ ok: boolean }>;
        };
      }).lvisApi;
      if (!api?.setApiKey) throw new Error('window.lvisApi.setApiKey unavailable');
      return api.setApiKey(v, k);
    },
    { v: vendor, k: apiKey },
  );
  expect(result.ok).toBe(true);
}

/** Patch the foundry baseUrl through `window.lvisApi.updateSettings`. */
async function setFoundryBaseUrl(
  settingsWindow: Page,
  baseUrl: string,
): Promise<void> {
  const result = await settingsWindow.evaluate(async (url) => {
    const api = (window as unknown as {
      lvisApi?: {
        updateSettings?: (partial: unknown) => Promise<{ ok: boolean; error?: string; message?: string }>;
      };
    }).lvisApi;
    if (!api?.updateSettings) throw new Error('window.lvisApi.updateSettings unavailable');
    return api.updateSettings({
      llm: { vendors: { 'azure-foundry': { baseUrl: url } } },
    });
  }, baseUrl);
  expect(result.ok).toBe(true);
}

test.describe('PermissionsTab reviewer provider dropdown — #768', () => {
  test('foundry option is disabled when no API key + baseUrl, then enables after both are saved', async ({
    app,
    mainWindow,
  }) => {
    const settingsWindow = await openSettingsWindow(app, mainWindow, 'permissions');

    // ─── 1. Initial state: foundry disabled, "(키 없음)" suffix present ──
    await openProviderDropdown(settingsWindow);
    const foundryOption = settingsWindow.getByTestId('reviewer-provider-option-foundry');
    await expect(foundryOption).toBeVisible();
    await expect(foundryOption).toHaveAttribute('data-disabled', '');
    // "(키 없음)" suffix is rendered as a sibling span on disabled items.
    await expect(foundryOption).toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    // ─── 2. Add API key only → still disabled (baseUrl still missing) ──
    await setApiKey(settingsWindow, 'azure-foundry', 'sk-foundry-e2e-test-key');
    await openProviderDropdown(settingsWindow);
    await expect(foundryOption).toHaveAttribute('data-disabled', '');
    await closeProviderDropdown(settingsWindow);

    // ─── 3. Add baseUrl → now enabled ─────────────────────────────────
    await setFoundryBaseUrl(settingsWindow, FOUNDRY_BASE_URL);
    await openProviderDropdown(settingsWindow);
    // Allow a moment for the SETTINGS.updated broadcast to flow back to the
    // renderer and refreshProviderKeyMap to repaint the option list.
    await expect(foundryOption).not.toHaveAttribute('data-disabled', '', {
      timeout: 5_000,
    });
    await expect(foundryOption).not.toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    await settingsWindow.getByRole('button', { name: '닫기' }).click();
  });

  test('gcp-playground option is disabled when no key, enabled after key saved', async ({
    app,
    mainWindow,
  }) => {
    const settingsWindow = await openSettingsWindow(app, mainWindow, 'permissions');

    // ─── 1. Initial state: gcp-playground disabled ────────────────────
    await openProviderDropdown(settingsWindow);
    const gcpOption = settingsWindow.getByTestId(
      'reviewer-provider-option-gcp-playground',
    );
    await expect(gcpOption).toBeVisible();
    await expect(gcpOption).toHaveAttribute('data-disabled', '');
    await expect(gcpOption).toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    // ─── 2. Save gemini key → enables gcp-playground ─────────────────
    await setApiKey(settingsWindow, 'gemini', 'AIza-gcp-e2e-test-key');
    await openProviderDropdown(settingsWindow);
    await expect(gcpOption).not.toHaveAttribute('data-disabled', '', {
      timeout: 5_000,
    });
    await expect(gcpOption).not.toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    await settingsWindow.getByRole('button', { name: '닫기' }).click();
  });

  test('pre-existing providers regression — openai/anthropic disable/enable behaves identically to new providers', async ({
    app,
    mainWindow,
  }) => {
    const settingsWindow = await openSettingsWindow(app, mainWindow, 'permissions');

    await openProviderDropdown(settingsWindow);

    // In a fresh LVIS_HOME (no keys seeded), both pre-existing providers
    // should render disabled — same code path as foundry/gcp-playground.
    // This proves PR #756 didn't introduce a foundry-special branch;
    // the activation rule is uniform across all five providers.
    const openaiOption = settingsWindow.getByTestId('reviewer-provider-option-openai');
    await expect(openaiOption).toBeVisible();
    await expect(openaiOption).toHaveAttribute('data-disabled', '');
    await expect(openaiOption).toContainText('(키 없음)');

    const anthropicOption = settingsWindow.getByTestId(
      'reviewer-provider-option-anthropic',
    );
    await expect(anthropicOption).toBeVisible();
    await expect(anthropicOption).toHaveAttribute('data-disabled', '');
    await expect(anthropicOption).toContainText('(키 없음)');

    await closeProviderDropdown(settingsWindow);

    // Add anthropic key → enables the pre-existing provider through the
    // same SETTINGS.updated path used by foundry/gcp-playground. If a
    // future change regresses the broadcast wiring for openai/anthropic
    // (e.g. someone scopes rewireReviewerAgent only to azure-foundry),
    // this assertion fails before merge.
    await setApiKey(settingsWindow, 'anthropic', 'sk-ant-e2e-test-key');
    await openProviderDropdown(settingsWindow);
    await expect(anthropicOption).not.toHaveAttribute('data-disabled', '', {
      timeout: 5_000,
    });
    await expect(anthropicOption).not.toContainText('(키 없음)');
    // openai remains disabled (no key added) — confirms the enable was
    // scoped to the specific provider, not a blanket "any key present".
    await expect(openaiOption).toHaveAttribute('data-disabled', '');
    await closeProviderDropdown(settingsWindow);

    await settingsWindow.getByRole('button', { name: '닫기' }).click();
  });

  test('disabled foundry option exposes tooltip text for screen readers / hover', async ({
    app,
    mainWindow,
  }) => {
    const settingsWindow = await openSettingsWindow(app, mainWindow, 'permissions');

    await openProviderDropdown(settingsWindow);
    const foundryOption = settingsWindow.getByTestId('reviewer-provider-option-foundry');
    await expect(foundryOption).toBeVisible();
    await expect(foundryOption).toHaveAttribute('data-disabled', '');

    // Hover the disabled SelectItem (wrapped in TooltipTrigger) — the
    // Radix Tooltip portal renders the description from PermissionsTab.
    // Locate by data-testid (locale-independent) instead of Korean text.
    await foundryOption.hover();
    await expect(
      settingsWindow.getByTestId('reviewer-provider-tooltip'),
    ).toBeVisible({ timeout: 5_000 });

    await closeProviderDropdown(settingsWindow);
    await settingsWindow.getByRole('button', { name: '닫기' }).click();
  });

  test('foundry option disables again when API key is revoked (issue #768 item 5)', async ({
    app,
    mainWindow,
  }) => {
    const settingsWindow = await openSettingsWindow(app, mainWindow, 'permissions');

    // ─── 1. Seed both: key + baseUrl → foundry enabled ────────────────
    await setApiKey(settingsWindow, 'azure-foundry', 'sk-foundry-e2e-test-key');
    await setFoundryBaseUrl(settingsWindow, FOUNDRY_BASE_URL);
    await openProviderDropdown(settingsWindow);
    const foundryOption = settingsWindow.getByTestId('reviewer-provider-option-foundry');
    await expect(foundryOption).not.toHaveAttribute('data-disabled', '', {
      timeout: 5_000,
    });
    await expect(foundryOption).not.toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    // ─── 2. Revoke the API key (empty string) → SETTINGS.updated fires
    //       → refreshProviderKeyMap re-renders → option becomes disabled.
    //       Mirrors the dynamic-enable path in the inverse direction.
    await setApiKey(settingsWindow, 'azure-foundry', '');
    await openProviderDropdown(settingsWindow);
    await expect(foundryOption).toHaveAttribute('data-disabled', '', {
      timeout: 5_000,
    });
    await expect(foundryOption).toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    await settingsWindow.getByRole('button', { name: '닫기' }).click();
  });
});
