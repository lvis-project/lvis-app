import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Kill any processes occupying the pageindex worker port so E2E runs cleanly. */
function killPageindexWorkers(): void {
  try {
    const raw = execSync('lsof -ti :43129 2>/dev/null || true').toString().trim();
    const pids = raw.split('\n').filter(Boolean);
    for (const pid of pids) {
      try { process.kill(parseInt(pid), 'SIGKILL'); } catch { /* already dead */ }
    }
  } catch { /* lsof unavailable */ }
}

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
    // Kill any leftover pageindex worker from a previous run before launching
    killPageindexWorkers();
    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
      env: {
        ...process.env,
        LVIS_DEV: '1',
        LVIS_E2E: '1',
        NODE_ENV: 'test',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      timeout: 30_000,
    });
    // Capture main-process console output to help diagnose CI crashes.
    app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[electron:stdout] ${d}`));
    app.process().stderr?.on('data', (d: Buffer) => process.stdout.write(`[electron:stderr] ${d}`));
    await use(app);
    await app.close().catch(() => {});
    // Ensure child Python workers spawned by pageindex are cleaned up
    killPageindexWorkers();
  },

  mainWindow: async ({ app }, use) => {
    const win = await app.firstWindow();
    // The app first loads a data: splash URL, then boots and replaces it with
    // the real index.html. Wait for the Sidebar root via data-testid — this
    // is the first persistent element after React mounts and survives view
    // changes. Locale-independent: previously we matched on the Korean
    // "메뉴" header text, which would break the moment the UI is localized.
    await win.locator('[data-testid="sidebar"]').first().waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    await use(win);
  },
});

export { expect };
