import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  hashReceiptFiles,
  listFilesRecursive,
  writeInstallReceipt,
} from '../../../src/plugins/plugin-install-receipt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const E2E_PLUGIN_REPOS = [
  'lvis-plugin-local-indexer',
  'lvis-plugin-meeting',
  'lvis-plugin-work-proactive',
  'lvis-plugin-agent-hub',
] as const;

/** Kill any processes occupying the local-indexer worker port so E2E runs cleanly. */
function killLocalIndexerWorkers(): void {
  if (process.platform === 'win32') return;

  try {
    const raw = execSync('lsof -ti :43129 2>/dev/null || true').toString().trim();
    const pids = raw.split('\n').filter(Boolean);
    for (const pid of pids) {
      try { process.kill(parseInt(pid), 'SIGKILL'); } catch { /* already dead */ }
    }
  } catch { /* lsof unavailable */ }
}

function resolveE2ePluginSourceRoot(repoRoot: string): string {
  return process.env.LVIS_E2E_PLUGIN_SOURCE_ROOT
    ? path.resolve(process.env.LVIS_E2E_PLUGIN_SOURCE_ROOT)
    : path.resolve(repoRoot, '..');
}

async function seedE2ePlugins(repoRoot: string, lvisHomeForTest: string): Promise<void> {
  const sourceRoot = resolveE2ePluginSourceRoot(repoRoot);
  const pluginsRoot = path.join(lvisHomeForTest, 'plugins');
  const cacheRoot = path.join(pluginsRoot, '.cache');
  fs.mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });

  const entries: Array<{
    id: string;
    manifestPath: string;
    enabled: boolean;
    installSource: 'local-dev';
    approvedPluginAccess?: unknown;
  }> = [];

  for (const repoSlug of E2E_PLUGIN_REPOS) {
    const sourceDir = path.join(sourceRoot, repoSlug);
    const sourceManifest = path.join(sourceDir, 'plugin.json');
    if (!fs.existsSync(sourceManifest)) {
      console.warn(`[e2e] plugin source missing, not seeded: ${sourceManifest}`);
      continue;
    }

    const sourceManifestText = fs.readFileSync(sourceManifest, 'utf-8');
    const manifest = JSON.parse(sourceManifestText) as {
      id?: unknown;
      version?: unknown;
      pluginAccess?: unknown;
    };
    if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`[e2e] invalid plugin manifest: ${sourceManifest}`);
    }

    const pluginDir = path.join(pluginsRoot, manifest.id);
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), sourceManifestText, 'utf-8');

    const targetDist = path.join(pluginDir, 'dist');
    if (manifest.id === 'agent-hub') {
      const sourceDist = path.join(sourceDir, 'dist');
      if (!fs.existsSync(sourceDist)) {
        throw new Error(`[e2e] agent-hub dist missing: ${sourceDist}`);
      }
      fs.cpSync(sourceDist, targetDist, {
        recursive: true,
        force: true,
        filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && !src.includes(`${path.sep}node_modules${path.sep}`),
      });
    } else {
      const uiEntries = Array.isArray((manifest as { ui?: unknown }).ui)
        ? ((manifest as { ui: Array<{ entry?: unknown; displayName?: unknown }> }).ui)
        : [];
      fs.mkdirSync(targetDist, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(targetDist, 'hostPlugin.js'),
        `export default function createPlugin() { return { handlers: {}, start() {}, stop() {} }; }\n`,
        'utf-8',
      );
      for (const ui of uiEntries) {
        if (typeof ui.entry !== 'string' || !ui.entry.startsWith('dist/')) continue;
        const uiPath = path.join(pluginDir, ui.entry);
        fs.mkdirSync(path.dirname(uiPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          uiPath,
          `export function mount({ root }) { root.textContent = ${JSON.stringify(String(ui.displayName ?? manifest.id))}; }\nexport default { mount };\n`,
          'utf-8',
        );
      }
    }

    const receiptFiles = ['plugin.json'];
    if (fs.existsSync(targetDist)) {
      for (const file of await listFilesRecursive(targetDist)) {
        receiptFiles.push(`dist/${file}`);
      }
    }
    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 2,
      pluginId: manifest.id,
      version: manifest.version,
      installSource: 'local-dev',
      artifactSha256: null,
      signerKeyId: null,
      installedAt: new Date().toISOString(),
      files: await hashReceiptFiles(pluginDir, receiptFiles),
    });

    entries.push({
      id: manifest.id,
      manifestPath: `${manifest.id}/plugin.json`,
      enabled: true,
      installSource: 'local-dev',
      approvedPluginAccess: manifest.pluginAccess,
    });
  }

  fs.writeFileSync(
    path.join(pluginsRoot, 'registry.json'),
    `${JSON.stringify({ version: 1, plugins: entries }, null, 2)}\n`,
    'utf-8',
  );
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
    // Kill any leftover local-indexer worker from a previous run before launching
    killLocalIndexerWorkers();
    /* Isolate LVIS user-data state under the per-test temp dir so encrypted
       secret blobs from a previous dev run on `~/.lvis/secrets/` do not bleed
       into the test (their Keychain key may have rotated, decryption fails,
       bootstrap dies). Resolved via the shared `lvisHome()` helper. */
    const lvisHomeForTest = path.join(userDataDir, 'lvis-state');
    fs.mkdirSync(lvisHomeForTest, { recursive: true, mode: 0o700 });
    await seedE2ePlugins(repoRoot, lvisHomeForTest);
    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
      env: {
        ...process.env,
        LVIS_DEV: '1',
        LVIS_E2E: '1',
        LVIS_HOME: lvisHomeForTest,
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
    // Ensure child Python workers spawned by local-indexer are cleaned up
    killLocalIndexerWorkers();
  },

  mainWindow: async ({ app }, use) => {
    const win = await app.firstWindow();
    // The app first loads a data: splash URL, then boots and replaces it with
    // the real index.html. Wait for the top action bar root via data-testid —
    // this is the first persistent element after React mounts and survives
    // view changes. Locale-independent: previously we matched on Korean
    // header text, which would break the moment the UI is localized.
    await win.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    await use(win);
  },
});

export { expect };
