import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  hashReceiptFiles,
  listFilesRecursive,
  writeInstallReceipt,
} from '../../../src/plugins/plugin-install-receipt.js';
import {
  buildE2eBaseSettings,
  buildIsolatedElectronEnv,
} from './seeded-electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const E2E_PLUGIN_REPOS = [
  'lvis-plugin-local-indexer',
  'lvis-plugin-meeting',
  'lvis-plugin-work-assistant',
  'lvis-plugin-agent-hub',
] as const;

const E2E_RESOLVE_DEMO_KEY_TOOL = 'meeting_resolve_demo_key';

type LaunchEnv = Record<string, string | undefined>;

type E2eManifest = {
  id?: unknown;
  version?: unknown;
  pluginAccess?: unknown;
  tools?: unknown;
  uiCallable?: unknown;
  hostSecrets?: { read?: unknown };
  toolSchemas?: Record<string, unknown>;
  ui?: unknown;
};

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(',')}}`;
}

function addUniqueString(list: unknown, value: string): string[] {
  const next = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  if (!next.includes(value)) next.push(value);
  return next;
}

function prepareE2eManifest(manifest: E2eManifest, enableDemoKeyProbe: boolean): E2eManifest {
  if (!enableDemoKeyProbe || manifest.id !== 'meeting') return manifest;

  const hostSecretReads = addUniqueString(manifest.hostSecrets?.read, 'llm.apiKey.openai');
  return {
    ...manifest,
    hostSecrets: { read: hostSecretReads },
    tools: addUniqueString(manifest.tools, E2E_RESOLVE_DEMO_KEY_TOOL),
    uiCallable: addUniqueString(manifest.uiCallable, E2E_RESOLVE_DEMO_KEY_TOOL),
    toolSchemas: {
      ...(manifest.toolSchemas ?? {}),
      [E2E_RESOLVE_DEMO_KEY_TOOL]: {
        description: 'E2E-only probe that resolves the host-managed OpenAI key through hostApi.resolveApiKey.',
        category: 'read',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
  };
}

function buildHostPluginStub(manifestId: string, enableDemoKeyProbe: boolean): string {
  if (!enableDemoKeyProbe || manifestId !== 'meeting') {
    return `export default function createPlugin() { return { handlers: {}, start() {}, stop() {} }; }\n`;
  }

  return `export default function createPlugin(context) {
  return {
    handlers: {
      ${E2E_RESOLVE_DEMO_KEY_TOOL}: async () => {
        const resolver = context.hostApi && context.hostApi.resolveApiKey;
        if (typeof resolver !== "function") {
          return { ok: false, reason: "missing-resolveApiKey" };
        }
        const result = await resolver({ purpose: "llm", vendor: "openai" });
        if (!result.ok) return result;
        try {
          return { ok: true, vendor: result.vendor, bearer: result.bearer() };
        } finally {
          result.release();
        }
      }
    },
    start() {},
    stop() {}
  };
}\n`;
}

function buildSignedWhitelistEnv(
  lvisHomeForTest: string,
  grants: Record<string, { read: string[]; manifestSha256: string }>,
): LaunchEnv {
  if (Object.keys(grants).length === 0) return {};
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const doc = {
    version: 1,
    schemaVersion: 1,
    issuedAt: '2026-05-17T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    pluginGrants: Object.fromEntries(
      Object.entries(grants).map(([pluginId, grant]) => [
        pluginId,
        {
          publisher: 'e2e',
          hostSecrets: { read: grant.read },
          approvedManifestSha256: grant.manifestSha256,
        },
      ]),
    ),
  };
  const body = JSON.stringify(doc);
  const envelope = {
    version: 1,
    iat: Math.floor(Date.now() / 1000),
    artifact_sha256: createHash('sha256').update(Buffer.from(body, 'utf-8')).digest('hex'),
    signatures: [
      {
        key_id: 'whitelist-v1',
        alg: 'ed25519',
        sig: sign(null, Buffer.from(body, 'utf-8'), privateKey).toString('base64'),
      },
    ],
  };
  const whitelistPath = path.join(lvisHomeForTest, 'e2e-marketplace-whitelist.demo.json');
  fs.writeFileSync(whitelistPath, body, 'utf-8');
  fs.writeFileSync(`${whitelistPath}.sig`, JSON.stringify(envelope), 'utf-8');
  return {
    LVIS_E2E_WHITELIST_SNAPSHOT_PATH: whitelistPath,
    LVIS_E2E_WHITELIST_PUBLIC_KEY: rawPublicKey.toString('base64'),
  };
}

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

async function seedE2ePlugins(
  repoRoot: string,
  lvisHomeForTest: string,
  enableDemoKeyProbe: boolean,
): Promise<LaunchEnv> {
  const sourceRoot = resolveE2ePluginSourceRoot(repoRoot);
  const pluginsRoot = path.join(lvisHomeForTest, 'plugins');
  const cacheRoot = path.join(pluginsRoot, '.cache');
  fs.mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
  const whitelistGrants: Record<string, { read: string[]; manifestSha256: string }> = {};

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
    const manifest = prepareE2eManifest(
      JSON.parse(sourceManifestText) as E2eManifest,
      enableDemoKeyProbe,
    );
    if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`[e2e] invalid plugin manifest: ${sourceManifest}`);
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const hostSecretReads = Array.isArray(manifest.hostSecrets?.read)
      ? manifest.hostSecrets.read.filter((item): item is string => typeof item === 'string')
      : [];
    if (hostSecretReads.length > 0) {
      whitelistGrants[manifest.id] = {
        read: hostSecretReads,
        manifestSha256: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
      };
    }

    const pluginDir = path.join(pluginsRoot, manifest.id);
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), manifestText, 'utf-8');

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
        buildHostPluginStub(manifest.id, enableDemoKeyProbe),
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

  return buildSignedWhitelistEnv(lvisHomeForTest, whitelistGrants);
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
export type ElectronOptions = {
  launchEnv: LaunchEnv;
  onboardingCompleted: boolean;
};

export const test = base.extend<ElectronFixtures & ElectronOptions>({
  launchEnv: [{}, { option: true }],
  onboardingCompleted: [true, { option: true }],

  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvis-e2e-'));
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },

  app: async ({ userDataDir, launchEnv, onboardingCompleted }, use) => {
    const repoRoot = path.resolve(HERE, '../../..');
    const mainEntry = path.join(repoRoot, 'dist/src/main/main.js');
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
    fs.writeFileSync(
      path.join(userDataDir, 'lvis-settings.json'),
      JSON.stringify(buildE2eBaseSettings(onboardingCompleted), null, 2) + '\n',
      'utf-8',
    );
    const e2eWhitelistEnv = await seedE2ePlugins(
      repoRoot,
      lvisHomeForTest,
      launchEnv.LVIS_E2E_RESOLVE_DEMO_KEY_PROBE === '1',
    );
    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
      env: buildIsolatedElectronEnv({
        ...launchEnv,
        ...e2eWhitelistEnv,
        HOME: userDataDir,
        USERPROFILE: userDataDir,
        LVIS_DEV: '1',
        LVIS_E2E: '1',
        LVIS_HOME: lvisHomeForTest,
        // Consumed by detached-window-titlebar.spec.ts which spawns a second
        // BrowserWindow via app.evaluate and needs the resolved main.js path
        // for preload/indexHtml siblings.
        LVIS_MAIN_ENTRY: mainEntry,
        NODE_ENV: 'test',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      }),
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
