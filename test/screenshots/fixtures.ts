import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildE2eBaseSettings,
  buildE2eSecrets,
  buildIsolatedElectronEnv,
} from '../e2e/ui/seeded-electron.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

/**
 * Fixed capture viewport. Chosen independently of any single existing
 * screenshot (the current lvisai.xyz/public/screenshots/*.png assets have
 * inconsistent aspect ratios because each was cropped to its own target
 * element after capture — see README.md "Aspect ratio" section) — 1600x1000
 * gives enough width for the expanded work-mode rail plus a chat column
 * without clipping, and is large enough that per-key crops (locator
 * screenshots) still have full-resolution source pixels to crop from.
 */
export const CAPTURE_VIEWPORT = { width: 1600, height: 1000 } as const;

export type ScreenshotFixtures = {
  app: ElectronApplication;
  mainWindow: Page;
  userDataDir: string;
};

/**
 * Electron launch fixture for the screenshot harness. Deliberately narrower
 * than `test/e2e/ui/fixtures.ts`'s `ElectronFixtures`: no plugin seeding
 * options are exposed here because plugin UI screenshots are out of scope
 * for this harness (see README.md skip list) — the shared E2E plugin seeder
 * mounts an inert `"E2E Plugin UI"` stub, not the plugin's real UI bundle,
 * so seeding it would only produce misleading placeholder captures.
 *
 * Reuses `buildE2eBaseSettings` / `buildE2eSecrets` / `buildIsolatedElectronEnv`
 * from the existing e2e harness (test/e2e/ui/seeded-electron.ts) so the demo
 * LLM-key seeding and settings-file shape stay in lockstep with the suite
 * this harness sits next to, instead of drifting via a second copy.
 */
export const test = base.extend<ScreenshotFixtures>({
  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvis-screenshot-'));
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },

  app: async ({ userDataDir }, use) => {
    const mainEntry = path.join(REPO_ROOT, 'dist/src/main/main.js');
    if (!fs.existsSync(mainEntry)) {
      throw new Error(
        `Electron main entry not found at ${mainEntry}. Run 'bun run build' before capturing screenshots.`,
      );
    }

    const lvisHomeForTest = path.join(userDataDir, 'lvis-state');
    fs.mkdirSync(lvisHomeForTest, { recursive: true, mode: 0o700 });

    // `system.appMode` is intentionally omitted — DEFAULT_APP_MODE ("work",
    // src/shared/initial-app-mode.ts) already matches the work-mode capture
    // requirement, and readPersistedAppModeSync falls back to it when the
    // settings file has no `system` block at all.
    fs.writeFileSync(
      path.join(userDataDir, 'lvis-settings.json'),
      `${JSON.stringify(buildE2eBaseSettings(true, 'en'), null, 2)}\n`,
      'utf-8',
    );
    // Seed a usable demo LLM key so the composer is enabled for chat-* captures.
    fs.writeFileSync(
      path.join(userDataDir, 'lvis-secrets.json'),
      JSON.stringify(buildE2eSecrets(), null, 2) + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
    // Empty plugin registry — no plugin UI stubs seeded (see fixture doc above).
    const pluginsRoot = path.join(lvisHomeForTest, 'plugins');
    fs.mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(pluginsRoot, 'registry.json'),
      `${JSON.stringify({ version: 1, plugins: [] }, null, 2)}\n`,
      'utf-8',
    );

    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
      env: buildIsolatedElectronEnv({
        HOME: userDataDir,
        USERPROFILE: userDataDir,
        LVIS_DEV: '1',
        LVIS_E2E: '1',
        LVIS_HOME: lvisHomeForTest,
        NODE_ENV: 'test',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        // Demo activation placeholder — never a real code. See README.md
        // "Environment variables". Left unset by default; callers running
        // against demo-gated screens must export LVIS_DEMO_ACTIVATION_CODE
        // themselves (real internal value; not something this harness ships).
        LVIS_DEMO_ACTIVATION_CODE: process.env.LVIS_DEMO_ACTIVATION_CODE,
      }),
      timeout: 30_000,
    });
    app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[electron:stdout] ${d}`));
    app.process().stderr?.on('data', (d: Buffer) => process.stdout.write(`[electron:stderr] ${d}`));
    await use(app);
    await app.close().catch(() => {});
  },

  mainWindow: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.setViewportSize(CAPTURE_VIEWPORT);
    await win.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    // Same overlay-neutralization as test/e2e/ui/fixtures.ts mainWindow fixture:
    // the post-tour first-task nudge is state-dependent and not something any
    // capture key wants floating over the shot.
    await win.addStyleTag({
      content: '[data-testid="post-tour-first-task"]{display:none !important;}',
    });
    // Deterministic captures: kill CSS transitions/animations globally so a
    // mid-tween frame is never captured, and hide the blinking caret. This is
    // a page.addStyleTag applied at the fixture level (not a src/** change) —
    // scoped to the screenshot harness only.
    await win.addStyleTag({
      content: `
        *, *::before, *::after {
          transition-duration: 0ms !important;
          animation-duration: 0ms !important;
          animation-delay: 0ms !important;
          caret-color: transparent !important;
        }
      `,
    });
    await use(win);
  },
});

export { expect };
export { REPO_ROOT };
