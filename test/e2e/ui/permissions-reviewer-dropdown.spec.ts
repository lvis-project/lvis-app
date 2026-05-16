/**
 * Playwright E2E — Reviewer provider dropdown (foundry / gcp-playground)
 *
 * Closes #768 — adds visual-regression coverage for the key-driven
 * dynamic activation behavior introduced in PR #756. The PermissionsTab
 * unit suite (`PermissionsTab.reviewer-c3.test.tsx`) verifies the IPC
 * call pattern, but cannot exercise the Radix portal-rendered SelectItem
 * disabled state or the live `SETTINGS.updated` broadcast wiring.
 *
 * Scenarios (per issue #768):
 *   1. `foundry` SelectItem disabled when no API key — tooltip on hover
 *      reveals "키 설정 필요" hint.
 *   2. `foundry` SelectItem enabled after API key + baseUrl saved.
 *   3. `gcp-playground` SelectItem disabled when no API key.
 *   4. `gcp-playground` SelectItem enabled after API key saved.
 *   5. Pre-existing providers (openai, anthropic) regression — openai is
 *      always enabled (test seed gives it a key by default); anthropic
 *      starts disabled (no key) and the dropdown render itself is sound.
 *
 * Pattern: builds on `fixtures.ts` so the renderer boots against an
 * isolated `LVIS_HOME`, then drives the real Electron settings window
 * through the same `openSettingsWindow` helper used by other settings
 * specs. Keys are written via the public `window.lvisApi.setApiKey` /
 * `updateSettings` IPC so the same `SETTINGS.updated` broadcast that
 * powers `PermissionsTab.refreshProviderKeyMap()` fires under test.
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
    await expect(foundryOption).toHaveAttribute('data-disabled', /.*/);
    // "(키 없음)" suffix is rendered as a sibling span on disabled items.
    await expect(foundryOption).toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    // ─── 2. Add API key only → still disabled (baseUrl still missing) ──
    await setApiKey(settingsWindow, 'azure-foundry', 'sk-foundry-e2e-test-key');
    await openProviderDropdown(settingsWindow);
    await expect(foundryOption).toHaveAttribute('data-disabled', /.*/);
    await closeProviderDropdown(settingsWindow);

    // ─── 3. Add baseUrl → now enabled ─────────────────────────────────
    await setFoundryBaseUrl(settingsWindow, FOUNDRY_BASE_URL);
    await openProviderDropdown(settingsWindow);
    // Allow a moment for the SETTINGS.updated broadcast to flow back to the
    // renderer and refreshProviderKeyMap to repaint the option list.
    await expect(foundryOption).not.toHaveAttribute('data-disabled', /.*/, {
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
    await expect(gcpOption).toHaveAttribute('data-disabled', /.*/);
    await expect(gcpOption).toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    // ─── 2. Save gemini key → enables gcp-playground ─────────────────
    await setApiKey(settingsWindow, 'gemini', 'AIza-gcp-e2e-test-key');
    await openProviderDropdown(settingsWindow);
    await expect(gcpOption).not.toHaveAttribute('data-disabled', /.*/, {
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
    await expect(openaiOption).toHaveAttribute('data-disabled', /.*/);
    await expect(openaiOption).toContainText('(키 없음)');

    const anthropicOption = settingsWindow.getByTestId(
      'reviewer-provider-option-anthropic',
    );
    await expect(anthropicOption).toBeVisible();
    await expect(anthropicOption).toHaveAttribute('data-disabled', /.*/);
    await expect(anthropicOption).toContainText('(키 없음)');

    await closeProviderDropdown(settingsWindow);

    // Add anthropic key → enables the pre-existing provider through the
    // same SETTINGS.updated path used by foundry/gcp-playground. If a
    // future change regresses the broadcast wiring for openai/anthropic
    // (e.g. someone scopes rewireReviewerAgent only to azure-foundry),
    // this assertion fails before merge.
    await setApiKey(settingsWindow, 'anthropic', 'sk-ant-e2e-test-key');
    await openProviderDropdown(settingsWindow);
    await expect(anthropicOption).not.toHaveAttribute('data-disabled', /.*/, {
      timeout: 5_000,
    });
    await expect(anthropicOption).not.toContainText('(키 없음)');
    // openai remains disabled (no key added) — confirms the enable was
    // scoped to the specific provider, not a blanket "any key present".
    await expect(openaiOption).toHaveAttribute('data-disabled', /.*/);
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
    await expect(foundryOption).toHaveAttribute('data-disabled', /.*/);

    // Hover the disabled SelectItem (wrapped in TooltipTrigger) — the
    // Radix Tooltip portal renders the description from PermissionsTab
    // ("API 키 설정 필요 — 지능 설정에서 키를 추가하세요.").
    await foundryOption.hover();
    await expect(
      settingsWindow.getByText('API 키 설정 필요 — 지능 설정에서 키를 추가하세요.'),
    ).toBeVisible({ timeout: 5_000 });

    await closeProviderDropdown(settingsWindow);
    await settingsWindow.getByRole('button', { name: '닫기' }).click();
  });
});
