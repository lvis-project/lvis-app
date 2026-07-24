import { _electron as electron, type ElectronApplication, type Page,
} from "playwright";
import { test as base, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  hashReceiptFiles,
  listFilesRecursive,
  writeInstallReceipt,
} from "../../../src/plugins/plugin-install-receipt.js";
import {
  buildE2eBaseSettings,
  buildE2eSecrets,
  buildIsolatedElectronEnv,
} from "./seeded-electron";
import { canonicalJSON } from "../../../src/plugins/whitelist/canonical-json.js";
import { makeTestT, type TestT } from "./i18n.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const E2E_PLUGIN_REPOS = [
  "lvis-plugin-local-indexer",
  "lvis-plugin-meeting",
  "lvis-plugin-work-assistant",
] as const;

const E2E_RESOLVE_CREDENTIAL_PROBE_TOOL = "meeting_resolve_credential_probe";
const E2E_PLUGIN_UI_STUB_SOURCE =
  'export function mount({ root }) { root.textContent = "E2E Plugin UI"; }\nexport default { mount };\n';

type LaunchEnv = Record<string, string | undefined>;

type E2eManifest = {
  id?: unknown;
  version?: unknown;
  pluginAccess?: unknown;
  tools?: unknown;
  hostSecrets?: { read?: unknown };
  ui?: unknown;
  python?: unknown;
};

function addCredentialProbeTool(tools: unknown): unknown[] {
  if (
    !Array.isArray(tools) ||
    tools.some((tool) =>
        tool === null || typeof tool !== "object" || Array.isArray(tool),
    )
  ) {
    throw new Error("E2E plugin manifest must declare pure Tool objects");
  }
  if (
    tools.some(
      (tool) =>
        (tool as { name?: unknown }).name === E2E_RESOLVE_CREDENTIAL_PROBE_TOOL,
    )
  ) {
    return tools;
  }
  return [
    ...tools,
    {
      name: E2E_RESOLVE_CREDENTIAL_PROBE_TOOL,
      description:
        "E2E-only probe that resolves the host-managed OpenAI key through hostApi.resolveApiKey.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      _meta: {
        ui: { visibility: ["model", "app"] },
      },
    },
  ];
}

function manifestIdentitySha256FromPluginJson(pluginJsonPath: string): string {
  const manifest = JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8"),
  ) as unknown;
  return createHash("sha256").update(canonicalJSON(manifest)).digest("hex");
}

function prepareE2eManifest(manifest: E2eManifest, enableCredentialProbe: boolean,
): E2eManifest {
  const base = { ...manifest };
  delete base.python;
  if (!enableCredentialProbe || base.id !== "meeting") return base;

  const declaredHostKeyNames = Array.isArray(base.hostSecrets?.read)
    ? base.hostSecrets.read.filter((item): item is string => typeof item === "string",
      )
    : [];
  const hostSecretReads = declaredHostKeyNames.includes("llm.apiKey.openai")
    ? declaredHostKeyNames
    : [...declaredHostKeyNames, "llm.apiKey.openai"];
  return {
    ...base,
    hostSecrets: { read: hostSecretReads },
    tools: addCredentialProbeTool(base.tools),
  };
}

function buildHostPluginStub(manifestId: string, enableCredentialProbe: boolean,
): string {
  if (!enableCredentialProbe || manifestId !== "meeting") {
    return `export default function createPlugin() { return { handlers: {}, start() {}, stop() {} }; }\n`;
  }

  return `export default function createPlugin(context) {
  return {
    handlers: {
      ${E2E_RESOLVE_CREDENTIAL_PROBE_TOOL}: async () => {
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
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey
    .export({ type: "spki", format: "der" })
    .slice(-32);
  const doc = {
    version: 1,
    schemaVersion: 1,
    issuedAt: "2026-05-17T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    pluginGrants: Object.fromEntries(
      Object.entries(grants).map(([pluginId, grant]) => [
        pluginId,
        {
          publisher: "e2e",
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
    artifact_sha256: createHash("sha256")
      .update(Buffer.from(body, "utf-8"))
      .digest("hex"),
    signatures: [
      {
        key_id: "whitelist-v1",
        alg: "ed25519",
        sig: sign(null, Buffer.from(body, "utf-8"), privateKey).toString(
          "base64",
        ),
      },
    ],
  };
  const whitelistPath = path.join(
    lvisHomeForTest,
    "e2e-marketplace-whitelist.fixture.json",
  );
  fs.writeFileSync(whitelistPath, body, "utf-8");
  fs.writeFileSync(`${whitelistPath}.sig`, JSON.stringify(envelope), "utf-8");
  return {
    LVIS_E2E_WHITELIST_SNAPSHOT_PATH: whitelistPath,
    LVIS_E2E_WHITELIST_PUBLIC_KEY: rawPublicKey.toString("base64"),
  };
}

/** Kill any processes occupying the local-indexer worker port so E2E runs cleanly. */
function killLocalIndexerWorkers(): void {
  if (process.platform === "win32") return;

  try {
    const raw = execSync("lsof -ti :43129 2>/dev/null || true")
      .toString()
      .trim();
    const pids = raw.split("\n").filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(parseInt(pid), "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  } catch {
    /* lsof unavailable */
  }
}

function resolveE2ePluginSourceRoot(repoRoot: string): string {
  if (process.env.LVIS_E2E_PLUGIN_SOURCE_ROOT) {
    return path.resolve(process.env.LVIS_E2E_PLUGIN_SOURCE_ROOT);
  }

  const candidates = [path.resolve(repoRoot, "..")];
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    for (const line of output.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      candidates.push(path.dirname(line.slice("worktree ".length).trim()));
    }
  } catch {
    /* Non-git CI checkouts fall back to repoRoot/.. below. */
  }

  const uniqueCandidates = [...new Set(candidates)];
  return (
    uniqueCandidates.find((candidate) =>
      E2E_PLUGIN_REPOS.some((repoSlug) =>
        fs.existsSync(path.join(candidate, repoSlug, "plugin.json")),
      ),
    ) ?? uniqueCandidates[0]
  );
}

async function seedE2ePlugins(
  repoRoot: string,
  lvisHomeForTest: string,
  enableCredentialProbe: boolean,
  seedTogglePlugin: boolean,
  seedRepositoryPlugins: boolean,
): Promise<LaunchEnv> {
  const pluginsRoot = path.join(lvisHomeForTest, "plugins");
  const cacheRoot = path.join(pluginsRoot, ".cache");
  fs.mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
  const whitelistGrants: Record<
    string,
    { read: string[]; manifestSha256: string }
  > = {};

  const entries: Array<{
    id: string;
    manifestPath: string;
    enabled: boolean;
    installSource: "local-dev";
    approvedPluginAccess?: unknown;
  }> = [];

  async function writeSeededPlugin(
    manifest: E2eManifest & {
      id: string;
      version: string;
      entry: string;
      tools: unknown[];
    },
    hostPluginSource: string,
  ): Promise<void> {
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const pluginDir = path.join(pluginsRoot, manifest.id);
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(pluginDir, "dist"), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(pluginDir, "plugin.json"),
      manifestText,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, manifest.entry),
      hostPluginSource,
      "utf-8",
    );
    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 2,
      pluginId: manifest.id,
      version: manifest.version,
      installSource: "local-dev",
      artifactSha256: null,
      signerKeyId: null,
      installedAt: new Date().toISOString(),
      files: await hashReceiptFiles(pluginDir, ["plugin.json", manifest.entry]),
    });
    entries.push({
      id: manifest.id,
      manifestPath: `${manifest.id}/plugin.json`,
      enabled: true,
      installSource: "local-dev",
      approvedPluginAccess: manifest.pluginAccess,
    });
  }

  if (seedTogglePlugin) {
    await writeSeededPlugin(
      {
        id: "e2e-toggle-plugin",
        name: "E2E Toggle Plugin",
        version: "0.0.0",
        description:
          "Minimal plugin used by plugin active/inactive E2E coverage.",
        publisher: "LVIS E2E",
        entry: "dist/hostPlugin.js",
        tools: [
          {
            name: "e2e_toggle_ping",
            description: "E2E toggle smoke tool",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            _meta: {
              ui: { visibility: ["model", "app"] },
            },
          },
        ],
      },
      `export default function createPlugin() {
  return {
    handlers: { e2e_toggle_ping: async () => "pong" },
    start() {},
    stop() {}
  };
}\n`,
    );
  }

  if (seedRepositoryPlugins) {
    const sourceRoot = resolveE2ePluginSourceRoot(repoRoot);
    for (const repoSlug of E2E_PLUGIN_REPOS) {
      const sourceDir = path.join(sourceRoot, repoSlug);
      const sourceManifest = path.join(sourceDir, "plugin.json");
      if (!fs.existsSync(sourceManifest)) {
        console.warn(
          `[e2e] plugin source missing, not seeded: ${sourceManifest}`,
        );
        continue;
      }

      const sourceManifestText = fs.readFileSync(sourceManifest, "utf-8");
      const manifest = prepareE2eManifest(
        JSON.parse(sourceManifestText) as E2eManifest,
        enableCredentialProbe,
      );
      if (
        typeof manifest.id !== "string" ||
        typeof manifest.version !== "string"
      ) {
        throw new Error(`[e2e] invalid plugin manifest: ${sourceManifest}`);
      }
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      const pluginDir = path.join(pluginsRoot, manifest.id);
      fs.rmSync(pluginDir, { recursive: true, force: true });
      fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
      const pluginJsonPath = path.join(pluginDir, "plugin.json");
      fs.writeFileSync(pluginJsonPath, manifestText, "utf-8");

      const hostSecretReads = Array.isArray(manifest.hostSecrets?.read)
        ? manifest.hostSecrets.read.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      if (hostSecretReads.length > 0) {
        whitelistGrants[manifest.id] = {
          read: hostSecretReads,
          manifestSha256: manifestIdentitySha256FromPluginJson(pluginJsonPath),
        };
      }

      const targetDist = path.join(pluginDir, "dist");
      const uiEntries = Array.isArray((manifest as { ui?: unknown }).ui)
        ? (
            manifest as {
              ui: Array<{ entry?: unknown; displayName?: unknown }>;
            }
          ).ui
        : [];
      fs.mkdirSync(targetDist, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(targetDist, "hostPlugin.js"),
        buildHostPluginStub(manifest.id, enableCredentialProbe),
        "utf-8",
      );
      for (const ui of uiEntries) {
        if (typeof ui.entry !== "string" || !ui.entry.startsWith("dist/"))
          continue;
        const uiPath = path.join(pluginDir, ui.entry);
        fs.mkdirSync(path.dirname(uiPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(uiPath, E2E_PLUGIN_UI_STUB_SOURCE, "utf-8");
      }

      const receiptFiles = ["plugin.json"];
      if (fs.existsSync(targetDist)) {
        for (const file of await listFilesRecursive(targetDist)) {
          receiptFiles.push(`dist/${file}`);
        }
      }
      await writeInstallReceipt(cacheRoot, {
        schemaVersion: 2,
        pluginId: manifest.id,
        version: manifest.version,
        installSource: "local-dev",
        artifactSha256: null,
        signerKeyId: null,
        installedAt: new Date().toISOString(),
        files: await hashReceiptFiles(pluginDir, receiptFiles),
      });

      entries.push({
        id: manifest.id,
        manifestPath: `${manifest.id}/plugin.json`,
        enabled: true,
        installSource: "local-dev",
        approvedPluginAccess: manifest.pluginAccess,
      });
    }
  }

  fs.writeFileSync(
    path.join(pluginsRoot, "registry.json"),
    `${JSON.stringify({ version: 1, plugins: entries }, null, 2)}\n`,
    "utf-8",
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
  /** i18n catalog binding for locale-agnostic assertions (see ./i18n.ts). */
  t: TestT;
};
export type ElectronOptions = {
  launchEnv: LaunchEnv;
  onboardingCompleted: boolean;
  seedTogglePlugin: boolean;
  seedRepositoryPlugins: boolean;
  seedApiKey: boolean;
  seedLocale: "ko" | "en";
};

export const test = base.extend<ElectronFixtures & ElectronOptions>({
  launchEnv: [{}, { option: true }],
  onboardingCompleted: [true, { option: true }],
  seedTogglePlugin: [false, { option: true }],
  seedRepositoryPlugins: [true, { option: true }],
  // Seed a usable LLM key so the composer is enabled (see buildE2eSecrets).
  // Specs that assert the no-key / key-toggle state override with
  // `test.use({ seedApiKey: false })`.
  seedApiKey: [true, { option: true }],
  // UI locale to seed. Defaults to 'en' — the production default (#1200) — so
  // ./fixtures specs exercise the English render path; their assertions go
  // through the `t` fixture so they resolve whatever is seeded. Specs that need
  // Korean override with `test.use({ seedLocale: 'ko' })`; specs with their own
  // harness pin their locale via a module-scoped `makeTestT(...)`.
  seedLocale: ["en", { option: true }],

  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvis-e2e-"));
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },

  app: async (
    {
      userDataDir,
      launchEnv,
      onboardingCompleted,
      seedTogglePlugin,
      seedRepositoryPlugins,
      seedApiKey,
      seedLocale,
    },
    use,
  ) => {
    const repoRoot = path.resolve(HERE, "../../..");
    const mainEntry = path.join(repoRoot, "dist/src/main/main.js");
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
    const lvisHomeForTest = path.join(userDataDir, "lvis-state");
    fs.mkdirSync(lvisHomeForTest, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(userDataDir, "lvis-settings.json"),
      JSON.stringify(
        buildE2eBaseSettings(onboardingCompleted, seedLocale),
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    if (seedApiKey) {
      // Seed an at-rest LLM key secret so `has-api-key` is true at boot and the
      // composer is enabled. Written to the same userData dir as the settings
      // file (SettingsService resolves both from options.userDataPath). Use
      // owner-only mode 0o600 to match production SettingsService.saveSecrets,
      // so the seeded file is never group/world-readable before the app's own
      // permission migration runs.
      fs.writeFileSync(
        path.join(userDataDir, "lvis-secrets.json"),
        JSON.stringify(buildE2eSecrets(), null, 2) + "\n",
        { encoding: "utf-8", mode: 0o600 },
      );
    }
    const e2eWhitelistEnv = await seedE2ePlugins(
      repoRoot,
      lvisHomeForTest,
      launchEnv.LVIS_E2E_RESOLVE_CREDENTIAL_PROBE === "1",
      seedTogglePlugin,
      seedRepositoryPlugins,
    );
    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        ...launchEnv,
        ...e2eWhitelistEnv,
        HOME: userDataDir,
        USERPROFILE: userDataDir,
        LVIS_DEV: "1",
        LVIS_E2E: "1",
        LVIS_HOME: lvisHomeForTest,
        // Consumed by detached-window-titlebar.spec.ts which spawns a second
        // BrowserWindow via app.evaluate and needs the resolved main.js path
        // for preload/indexHtml siblings.
        LVIS_MAIN_ENTRY: mainEntry,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    // Capture main-process console output to help diagnose CI crashes.
    app
      .process()
      .stdout?.on("data", (d: Buffer) =>
        process.stdout.write(`[electron:stdout] ${d}`),
      );
    app
      .process()
      .stderr?.on("data", (d: Buffer) =>
        process.stdout.write(`[electron:stderr] ${d}`),
      );
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
      state: "visible",
      timeout: 60_000,
    });
    // Neutralize the post-tour first-task nudge (PostTourFirstTask). With
    // onboardingCompleted seeded true the chain sits at "done" → tourCompleted,
    // and a seeded repository plugin (e.g. meeting) yields a proposal, so the
    // z-9000 bottom-right card renders and intercepts pointer events over the
    // composer/toolbar. No spec asserts this overlay, so hide it globally — CSS
    // applies even if it mounts after this point. Specs that need it can scope
    // it back in. Keeps the harness locale/onboarding-state agnostic.
    await win.addStyleTag({
      content: '[data-testid="post-tour-first-task"]{display:none !important;}',
    });
    await use(win);
  },

  // Catalog binding for locale-agnostic assertions, bound to the seeded locale.
  t: async ({ seedLocale }, use) => {
    await use(makeTestT(seedLocale));
  },
});

export { expect };
