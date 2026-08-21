import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';
import type { SandboxCapabilityInfo } from '../../../src/shared/sandbox-capability-info.js';

/**
 * Sandbox boot-outcome surface — real-Electron plumbing smoke.
 *
 * The RENDER of the degraded notice is already unit-tested six ways in
 * `PermissionsTab.sandbox-boot.test.tsx`, so re-asserting the markup here would
 * buy nothing. What no unit test can reach is the chain the outcome actually
 * travels: boot gate → `setSandboxBootOutcome` → the sealed main-process store →
 * the permissions IPC handler → preload → the settings render. Every one of
 * those links is mocked away in the unit suites; a `boot: undefined` reaching
 * the renderer would leave all six of them green.
 *
 * So this spec asserts two things about the LIVE app:
 *   1. `boot` arrives non-null with a well-formed outcome — the gate ran and its
 *      decision survived the trip to the renderer.
 *   2. The notice's presence agrees with that decision. This is an INVARIANT,
 *      not a fixed expectation: which branch the gate takes is a property of the
 *      host (platform default, whether ASRT is installed), and a spec that
 *      demanded one branch would be asserting the test machine, not the code.
 */

const GATE_ACTIONS = ['skip', 'activate', 'degrade', 'abort'] as const;

test('the boot gate outcome reaches settings, and the notice matches it', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'permissions');

  const capability = (await settingsPage.evaluate(
    () => window.lvis.permission.sandboxCapability(),
  )) as SandboxCapabilityInfo;

  // The gate always runs at boot, so absence here means a broken link in the
  // chain — not "the sandbox is off". `null` is reserved for hosts that never
  // ran sandbox init, which the real main process always does.
  expect(capability.boot).toBeTruthy();
  const boot = capability.boot!;
  expect(GATE_ACTIONS).toContain(boot.action);
  expect(boot.reason.length).toBeGreaterThan(0);
  expect(['explicit-env', 'default-settings', 'off']).toContain(boot.onSignal);
  expect(Array.isArray(boot.dependencyErrors)).toBe(true);
  // `abort` throws out of boot, so a running app can never report it.
  expect(boot.action).not.toBe('abort');

  const notice = settingsPage.getByTestId('os-sandbox-boot-degraded');
  if (boot.action === 'degrade') {
    await expect(notice).toBeVisible();
    // The dependency errors carry the install command the user has to run, so
    // a degrade that renders the heading without them is still a dead end.
    if (boot.dependencyErrors.length > 0) {
      await expect(settingsPage.getByTestId('os-sandbox-boot-degraded-detail')).toBeVisible();
    }
  } else {
    // `skip` (never turned on) and `activate` (on and working) are both states
    // the user has no problem to fix — warning about either would be noise.
    await expect(notice).toHaveCount(0);
  }

  await closeInlineSettings(app, settingsPage);
});
