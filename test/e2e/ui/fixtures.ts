import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Shared fixture: launches the built Electron main process with an
 * isolated userData dir so E2E runs do not pollute local state.
 */
export type ElectronFixtures = {
  app: ElectronApplication;
  mainWindow: Page;
  userDataDir: string;
};

export const test = base.extend<ElectronFixtures>({
  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvis-e2e-'));
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },

  app: async ({ userDataDir }, use) => {
    const repoRoot = path.resolve(HERE, '../../..');
    const mainEntry = path.join(repoRoot, 'dist/src/main.js');
    if (!fs.existsSync(mainEntry)) {
      throw new Error(
        `Electron main entry not found at ${mainEntry}. Run 'bun run build' before 'playwright test'.`,
      );
    }
    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        LVIS_E2E: '1',
        NODE_ENV: 'test',
      },
      timeout: 30_000,
    });
    await use(app);
    await app.close().catch(() => {});
  },

  mainWindow: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

export { expect };
