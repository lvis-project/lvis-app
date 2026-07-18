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
import { seedRealPlugins } from './plugin-seed.js';

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

export type ScreenshotOptions = {
  /**
   * Manifest ids of REAL plugins to side-load into the isolated profile before
   * launch (e.g. `['local-indexer']`). Their built `dist/` is copied from the
   * sibling `../lvis-plugin-<id>/` repo so their actual UI bundle renders — see
   * `plugin-seed.ts`. Empty (default) keeps the old behavior: no plugins, an
   * empty registry. Set per-scenario via `test.use({ installPlugins: [...] })`.
   */
  installPlugins: readonly string[];
  /**
   * Keep the LLM permission reviewer ON. By default seeding plugins disables it
   * (so panel mount-time read tools don't pop the approval modal). The
   * `plugin-permission-grant` scenario sets this true because its capture target
   * IS that approval modal.
   */
  keepReviewer: boolean;
};

/**
 * Electron launch fixture for the screenshot harness.
 *
 * Unlike `test/e2e/ui/fixtures.ts`'s `ElectronFixtures` (which seeds inert
 * `"E2E Plugin UI"` stubs to test host-side lifecycle wiring), this seeds the
 * plugin repos' REAL built UI bundles when a scenario opts in via
 * `test.use({ installPlugins: [...] })` — see `plugin-seed.ts`. Scenarios with
 * no `installPlugins` get an empty plugin registry (host-only screens).
 *
 * Reuses `buildE2eBaseSettings` / `buildE2eSecrets` / `buildIsolatedElectronEnv`
 * from the existing e2e harness (test/e2e/ui/seeded-electron.ts) so the demo
 * LLM-key seeding and settings-file shape stay in lockstep with the suite
 * this harness sits next to, instead of drifting via a second copy.
 */
export const test = base.extend<ScreenshotFixtures & ScreenshotOptions>({
  installPlugins: [[], { option: true }],
  keepReviewer: [false, { option: true }],

  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvis-screenshot-'));
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },

  app: async ({ userDataDir, installPlugins, keepReviewer }, use) => {
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
    // Seed a usable test LLM key so the composer is enabled for chat-* captures.
    fs.writeFileSync(
      path.join(userDataDir, 'lvis-secrets.json'),
      JSON.stringify(buildE2eSecrets(), null, 2) + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
    // Plugin registry. When `installPlugins` is empty (default) this writes an
    // empty registry — the original no-plugin behavior. When a scenario names
    // plugins, their REAL built `dist/` bundle is copied from the sibling repo
    // so the actual UI renders (see plugin-seed.ts), and a signed whitelist
    // snapshot is produced for any host-secret grants they declare.
    let pluginEnv: Record<string, string | undefined> = {};
    if (installPlugins.length === 0) {
      const pluginsRoot = path.join(lvisHomeForTest, 'plugins');
      fs.mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(pluginsRoot, 'registry.json'),
        `${JSON.stringify({ version: 1, plugins: [] }, null, 2)}\n`,
        'utf-8',
      );
    } else {
      const result = await seedRealPlugins(REPO_ROOT, lvisHomeForTest, installPlugins, {
        disableReviewer: !keepReviewer,
      });
      pluginEnv = result.env;
      if (result.missing.length > 0) {
        // Surface missing bundles loudly — a scenario asked for a plugin whose
        // built dist is absent, so its capture will not be meaningful.
        console.warn(
          `[screenshots] requested plugins not seeded (bundle missing): ${result.missing.join(', ')}`,
        );
      }
    }

    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
      env: buildIsolatedElectronEnv({
        ...pluginEnv,
        HOME: userDataDir,
        USERPROFILE: userDataDir,
        LVIS_DEV: '1',
        LVIS_E2E: '1',
        LVIS_HOME: lvisHomeForTest,
        NODE_ENV: 'test',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
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
