import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
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
 * Recursively hardlink a directory tree.
 *
 * Hardlinks — not a copy (633 MB per venv) and not a junction: near-instant,
 * no extra disk, and safe when the destination's parent (the isolated profile)
 * is recursively removed at teardown. `fs.rmSync` deletes the hardlink entries
 * but the SOURCE keeps its own directory entries, so the inodes survive and the
 * real provisioned venv is never wiped — unlike a junction, which `fs.rmSync`
 * can traverse into and delete the target contents of. Falls back to a copy per
 * file across volumes (EXDEV) or if the link cannot be created.
 */
function hardlinkTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      hardlinkTree(s, d);
    } else if (entry.isFile()) {
      try {
        fs.linkSync(s, d);
      } catch {
        fs.copyFileSync(s, d);
      }
    }
  }
}

/**
 * Opt-in real-Python reuse (`LVIS_SCREENSHOT_REAL_PYTHON=1`).
 *
 * A worker-backed plugin (local-indexer) only registers its live sidebar view
 * after its Python worker starts healthily, and the isolated profile has an
 * empty runtime cache — so without this it degrades to a Doctor entry. For each
 * seeded plugin that shipped a `python-requirements.lock` (plugin-seed copies it
 * only under this opt-in), find the venv the host ALREADY provisioned for that
 * exact lock under the REAL `~/.lvis/runtime` and hardlink it into the isolated
 * runtime at the path the host derives from the lock hash. The host's
 * PythonRuntimeBootstrapper then hits the `.ready` sentinel (no network, no
 * build) and the worker starts for real. No-op with a warning when no matching
 * venv exists — the capture then shows the Doctor entry, same as without the
 * opt-in. Machine-local by nature (relies on a prior real provisioning).
 */
function reuseRealPythonRuntime(lvisHomeForTest: string, seededIds: readonly string[]): void {
  const realEnvsRoot = path.join(os.homedir(), '.lvis', 'runtime', 'python-envs');
  if (!fs.existsSync(realEnvsRoot)) {
    console.warn(`[screenshots] real-python: no provisioned runtime at ${realEnvsRoot}`);
    return;
  }
  const realDirs = fs.readdirSync(realEnvsRoot);
  for (const id of seededIds) {
    const lockPath = path.join(lvisHomeForTest, 'plugins', id, 'python-requirements.lock');
    if (!fs.existsSync(lockPath)) continue;
    const lockHash = createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex').slice(0, 24);
    const match = realDirs.find(
      (d) => d.endsWith(`-py312-${lockHash}`) && fs.existsSync(path.join(realEnvsRoot, d, 'venv', '.ready')),
    );
    if (!match) {
      console.warn(
        `[screenshots] real-python: no ready venv for ${id} (lock ${lockHash}) — plugin will show a Doctor entry`,
      );
      continue;
    }
    const srcVenv = path.join(realEnvsRoot, match, 'venv');
    const destVenv = path.join(lvisHomeForTest, 'runtime', 'python-envs', match, 'venv');
    hardlinkTree(srcVenv, destVenv);
    // eslint-disable-next-line no-console
    console.log(`[screenshots] real-python: linked venv for ${id} -> ${destVenv}`);
  }
}

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
 * from the existing e2e harness (test/e2e/ui/seeded-electron.ts) so the test
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
      // Opt-in: make a worker-backed plugin's live panel capturable by reusing
      // the machine's pre-provisioned Python venv (see reuseRealPythonRuntime).
      if (process.env.LVIS_SCREENSHOT_REAL_PYTHON === '1') {
        reuseRealPythonRuntime(lvisHomeForTest, result.seeded);
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
