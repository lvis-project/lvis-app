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
 * string on disabled SelectItems and omits it entirely (`void 0`) on
 * enabled ones. Assertions:
 *   - disabled → `toHaveAttribute('data-disabled', '')` (exact empty).
 *   - enabled  → `not.toHaveAttribute('data-disabled')` (1-arg form
 *     asserts attribute ABSENT, not just "not equal to ''" — guards
 *     against future Radix versions emitting `data-disabled="false"`).
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

/**
 * Delete an LLM provider API key through the public preload bridge —
 * the production revoke path that removes the secrets entry entirely
 * (vs. `setApiKey(vendor, '')` which stores an empty-encrypted value
 * and is NOT what the host treats as "no key").
 */
async function deleteApiKey(
  settingsWindow: Page,
  vendor: string,
): Promise<void> {
  const result = await settingsWindow.evaluate(async (v) => {
    const api = (window as unknown as {
      lvisApi?: {
        deleteApiKey?: (vendor: string) => Promise<{ ok: boolean }>;
      };
    }).lvisApi;
    if (!api?.deleteApiKey) throw new Error('window.lvisApi.deleteApiKey unavailable');
    return api.deleteApiKey(v);
  }, vendor);
  expect(result.ok).toBe(true);
}

/** Patch the foundry baseUrl through `window.lvisApi.updateSettings`. */
async function setFoundryBaseUrl(
  settingsWindow: Page,
  baseUrl: string,
): Promise<void> {
  // `lvis:settings:update` IPC returns the full `AppSettings` snapshot on
  // success (consumed by RolesTab / use-role-presets / ThemeProvider) and
  // `{ ok: false, error, message }` on failure — heterogeneous return
  // shape by design. Treat any non-error-shaped object as success.
  const result = (await settingsWindow.evaluate(async (url) => {
    const api = (window as unknown as {
      lvisApi?: {
        updateSettings?: (partial: unknown) => Promise<unknown>;
      };
    }).lvisApi;
    if (!api?.updateSettings) throw new Error('window.lvisApi.updateSettings unavailable');
    return api.updateSettings({
      llm: { vendors: { 'azure-foundry': { baseUrl: url } } },
    });
  }, baseUrl)) as Record<string, unknown>;
  if (result && (result as { ok?: unknown }).ok === false) {
    throw new Error(`updateSettings failed: ${(result as { error?: string }).error ?? 'unknown'}`);
  }
}

// SKIPPED: the reviewer no longer has a per-provider selection dropdown. The
// `reviewer-provider-select` UI (#768) was removed when the reviewer provider
// became managed centrally via the LLM/intelligence settings (the tab now shows
// `reviewer-active-llm-source` + the "provider managed in intelligence settings"
// note instead of a key-gated foundry/gcp-playground dropdown). These tests
// assert removed behavior and need a rewrite against the new reviewer UI rather
// than a fixture fix — tracked in #1212.
test.describe.skip('PermissionsTab reviewer provider dropdown — #768', () => {
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
    await expect(foundryOption).not.toHaveAttribute('data-disabled', {
      timeout: 5_000,
    });
    await expect(foundryOption).not.toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    // No explicit close — settings window lives inside the per-test `app`
    // fixture and is torn down with the Electron app when the test ends.
    // There is no in-DOM "닫기" button on the native settings window
    // (the OS frame X is the only close affordance on Linux/Win).
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
    await expect(gcpOption).not.toHaveAttribute('data-disabled', {
      timeout: 5_000,
    });
    await expect(gcpOption).not.toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    // No explicit close — settings window lives inside the per-test `app`
    // fixture and is torn down with the Electron app when the test ends.
    // There is no in-DOM "닫기" button on the native settings window
    // (the OS frame X is the only close affordance on Linux/Win).
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
    //
    // The reviewer UI name "anthropic" maps to canonical vendor "claude"
    // via REVIEWER_VENDOR_MAP — the secret is stored at `llm.apiKey.claude`
    // and `reviewerProviderKeyPresent('anthropic')` reads from there. Use
    // the canonical vendor for setApiKey so the key lands at the slot the
    // reviewer-provider check actually reads.
    await setApiKey(settingsWindow, 'claude', 'sk-ant-e2e-test-key');
    await openProviderDropdown(settingsWindow);
    await expect(anthropicOption).not.toHaveAttribute('data-disabled', {
      timeout: 5_000,
    });
    await expect(anthropicOption).not.toContainText('(키 없음)');
    // openai remains disabled (no key added) — confirms the enable was
    // scoped to the specific provider, not a blanket "any key present".
    await expect(openaiOption).toHaveAttribute('data-disabled', '');
    await closeProviderDropdown(settingsWindow);

    // No explicit close — settings window lives inside the per-test `app`
    // fixture and is torn down with the Electron app when the test ends.
    // There is no in-DOM "닫기" button on the native settings window
    // (the OS frame X is the only close affordance on Linux/Win).
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

    // PermissionsTab.tsx 의 disabled SelectItem 은 더 이상 Radix Tooltip 으로
    // 감싸지 않는다 — Radix Select 가 disabled SelectItem 에 `pointer-events: none`
    // 을 강제해 hover/focus 가 발화되지 않고 Tooltip 이 열리지 않기 때문.
    // 대신 모든 모달리티에 reason 을 노출:
    //   1. inline `(키 없음 · 설정 필요)` 가 항상 보이고
    //      `data-testid="reviewer-provider-tooltip"` 로 테스트 가능
    //   2. SelectItem 의 `aria-label` 에 full reason 포함 → 스크린리더가 typeahead/
    //      arrow nav 시 reason 까지 한 번에 announce
    // testid 가 모든 disabled option 에 동일하게 붙으므로 foundry option 내부로
    // 범위를 좁혀야 strict-mode 위반 안 함.
    const inlineHint = foundryOption.getByTestId('reviewer-provider-tooltip');
    await expect(inlineHint).toBeVisible();
    await expect(inlineHint).toContainText('(키 없음)');
    const ariaLabel = await foundryOption.getAttribute('aria-label');
    expect(ariaLabel, 'disabled foundry option must expose full reason via aria-label for screen readers').toBeTruthy();
    expect(ariaLabel).toContain('API 키 설정 필요');

    await closeProviderDropdown(settingsWindow);
    // No explicit close — settings window lives inside the per-test `app`
    // fixture and is torn down with the Electron app when the test ends.
    // There is no in-DOM "닫기" button on the native settings window
    // (the OS frame X is the only close affordance on Linux/Win).
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
    await expect(foundryOption).not.toHaveAttribute('data-disabled', {
      timeout: 5_000,
    });
    await expect(foundryOption).not.toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    // ─── 2. Revoke the API key via the production delete path →
    //       SETTINGS.updated fires → refreshProviderKeyMap re-renders →
    //       option becomes disabled. Mirrors the dynamic-enable path in
    //       the inverse direction. NOTE: `setApiKey(vendor, '')` would
    //       NOT work — settingsService.setSecret stores an
    //       empty-encrypted value (truthy in keyring), `getSecret` then
    //       returns `""` (not `null`), and `reviewerProviderKeyPresent`
    //       does `getSecret(...) !== null` → still treats key as present.
    //       The actual revoke contract is the dedicated delete-api-key
    //       IPC (settings-store.ts deleteSecret), bridged in preload.ts
    //       as `window.lvisApi.deleteApiKey`.
    await deleteApiKey(settingsWindow, 'azure-foundry');
    await openProviderDropdown(settingsWindow);
    await expect(foundryOption).toHaveAttribute('data-disabled', '', {
      timeout: 5_000,
    });
    await expect(foundryOption).toContainText('(키 없음)');
    await closeProviderDropdown(settingsWindow);

    // No explicit close — settings window lives inside the per-test `app`
    // fixture and is torn down with the Electron app when the test ends.
    // There is no in-DOM "닫기" button on the native settings window
    // (the OS frame X is the only close affordance on Linux/Win).
  });
});
