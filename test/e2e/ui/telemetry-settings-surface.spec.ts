import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

/**
 * Telemetry settings surface — real-Electron round trip.
 *
 * The defect being closed is not a rendering one: `telemetry.enabled` was
 * written exactly once, by the first-boot consent prompt, and the store was
 * the only thing that could ever hold a second answer. So the test that
 * matters is whether the switch and the endpoint field reach the real
 * `SettingsService` — the same one `TelemetryService` reads before it decides
 * whether to send anything.
 *
 * The allowlist is read-only on purpose (it bounds the endpoint the renderer
 * can write), so it is asserted as displayed, never as edited.
 */
test('the telemetry controls round-trip through the real settings service', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'audit');

  const readTelemetry = () =>
    settingsPage.evaluate(async () => {
      const api = (window as unknown as {
        lvisApi: { getSettings: () => Promise<unknown> };
      }).lvisApi;
      const settings = (await api.getSettings()) as {
        telemetry?: { enabled?: boolean; endpoint?: string; telemetryPromptAnswered?: boolean };
      };
      return settings.telemetry ?? {};
    });

  const toggle = settingsPage.getByTestId('telemetry-enabled');
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // The bound on the endpoint is shown, so the field below is usable.
  await expect(settingsPage.getByTestId('telemetry-allowed-hosts')).toContainText('localhost');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(readTelemetry).toMatchObject({ enabled: true, telemetryPromptAnswered: true });

  const endpoint = settingsPage.getByTestId('telemetry-endpoint');
  await endpoint.fill('  https://localhost/v1  ');
  await settingsPage.getByTestId('telemetry-endpoint-save').click();
  await expect.poll(readTelemetry).toMatchObject({ endpoint: 'https://localhost/v1' });

  // Clearing has to reach the store as "no destination" rather than as an
  // empty string the transport would then try to POST to.
  await endpoint.fill('');
  await settingsPage.getByTestId('telemetry-endpoint-save').click();
  await expect.poll(async () => (await readTelemetry()).endpoint).toBeUndefined();

  // The whole point: the consent answer is no longer permanent.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(readTelemetry).toMatchObject({ enabled: false, telemetryPromptAnswered: true });

  await closeInlineSettings(app, settingsPage);
});
