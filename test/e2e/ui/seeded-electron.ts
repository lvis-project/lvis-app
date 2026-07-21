import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LLM_VENDOR_DEFAULTS, type LLMVendor } from "../../../src/shared/llm-vendor-defaults.js";
import { DEFAULT_BUNDLE_ID } from "../../../src/shared/theme-bundles.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");
export const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

type JsonObject = Record<string, unknown>;

export type LaunchEnv = Record<string, string | undefined>;

const SAFE_PROCESS_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "CI",
  "GITHUB_ACTIONS",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const;

function safeProcessEnv(): LaunchEnv {
  const env: LaunchEnv = {};
  for (const key of SAFE_PROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function buildIsolatedElectronEnv(overrides: LaunchEnv): LaunchEnv {
  return {
    ...safeProcessEnv(),
    ...overrides,
  };
}

export function buildE2eBaseSettings(onboardingCompleted = true, locale: "ko" | "en" = "ko"): JsonObject {
  return {
    marketplace: {
      backend: "real-cloud",
      cloudBaseUrl: "",
      updateCheckEnabled: false,
      updateCheckIntervalMs: 0,
    },
    updates: {
      autoCheckEnabled: false,
    },
    features: {
      onboardingCompleted,
    },
    // Pin the UI locale for e2e. Defaults to Korean: after #1200 the production
    // default is English (DEFAULT_LOCALE), but the specs assert the Korean
    // catalog (mirroring src/i18n/testing/vitest-locale-ko.ts, which pins the
    // renderer unit suite to ko for the same reason). The English boot path is
    // covered by the english-default-smoke spec, which passes locale:"en".
    // schemaVersion:2 is REQUIRED — settings-store normalizeAppearance only
    // reads `language` inside the v2 branch, so without it the seed is silently
    // ignored and the UI stays en.
    appearance: {
      schemaVersion: 2,
      bundleId: DEFAULT_BUNDLE_ID,
      language: locale,
    },
  };
}

/**
 * Secrets to seed into `lvis-secrets.json` so the host reports a usable LLM key
 * at boot (`lvis:settings:has-api-key` → `getSecret("llm.apiKey.<provider>")`),
 * which enables the chat composer. Before #1201 a fixture-key path resolved this
 * implicitly; that path is gone, so e2e seeds an explicit key for every vendor
 * (covers whichever `llm.provider` a spec ends up with — default azure-foundry).
 *
 * The `plain:` prefix is honored by `getSecret` unconditionally (it is checked
 * before the safeStorage branch), so this works in headless CI where no OS
 * keychain / safeStorage is available.
 */
export function buildE2eSecrets(): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const vendor of Object.keys(LLM_VENDOR_DEFAULTS)) {
    secrets[`llm.apiKey.${vendor}`] = `plain:sk-e2e-${vendor}`;
  }
  return secrets;
}

export type SeededElectronContext = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  tempHome: string;
  lvisHome: string;
};

export function builtMainExists(): boolean {
  return existsSync(MAIN_ENTRY);
}

export function buildLlmSettings(vendor: LLMVendor = "openai", model?: string): JsonObject {
  const vendors = Object.fromEntries(
    Object.entries(LLM_VENDOR_DEFAULTS).map(([id, defaults]) => [
      id,
      {
        model: defaults.model,
        enableThinking: defaults.enableThinking,
        thinkingBudgetTokens: defaults.thinkingBudgetTokens,
      },
    ]),
  ) as unknown as Record<LLMVendor, JsonObject>;
  vendors[vendor] = {
    ...vendors[vendor],
    model: model ?? LLM_VENDOR_DEFAULTS[vendor].model,
  };

  return {
    ...buildE2eBaseSettings(true),
    llm: {
      provider: vendor,
      vendors,
      streamSmoothing: "none",
      fallbackChain: [],
    },
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPersistedHistoryRow(row: JsonObject): JsonObject {
  const {
    createdAt,
    displayText,
    routeSkill,
    importedTrigger,
    toolDisplay,
    turnSummary,
    checkpointMeta,
    systemNotice,
    meta,
    ...message
  } = row;
  const nextMeta: JsonObject = isJsonObject(meta) ? { ...meta } : {};
  for (const [key, value] of Object.entries({
    createdAt,
    displayText,
    routeSkill,
    importedTrigger,
    toolDisplay,
    turnSummary,
    checkpointMeta,
    systemNotice,
  })) {
    if (value !== undefined) nextMeta[key] = value;
  }
  return Object.keys(nextMeta).length > 0 ? { ...message, meta: nextMeta } : message;
}

export async function launchSeededElectron(opts: {
  historyRows: JsonObject[];
  sessionId?: string;
  sessionTitle?: string;
  settings?: JsonObject;
  userDataPrefix?: string;
  homePrefix?: string;
}): Promise<SeededElectronContext> {
  const sessionId = opts.sessionId ?? "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const userDataDir = mkdtempSync(resolve(tmpdir(), opts.userDataPrefix ?? "lvis-seeded-e2e-user-data-"));
  const tempHome = mkdtempSync(resolve(tmpdir(), opts.homePrefix ?? "lvis-seeded-e2e-home-"));
  const lvisHome = resolve(tempHome, ".lvis");

  writeFileSync(
    resolve(userDataDir, "lvis-settings.json"),
    `${JSON.stringify(opts.settings ?? buildLlmSettings(), null, 2)}\n`,
    "utf-8",
  );

  const sessionsDir = resolve(lvisHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    resolve(sessionsDir, `${sessionId}.jsonl`),
    `${opts.historyRows.map((row) => JSON.stringify(toPersistedHistoryRow(row))).join("\n")}\n`,
    "utf-8",
  );
  writeFileSync(
    resolve(sessionsDir, `${sessionId}.meta.json`),
    `${JSON.stringify({ title: opts.sessionTitle ?? "Seeded e2e session" }, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(
    resolve(sessionsDir, ".active-session.json"),
    `${JSON.stringify(
      {
        mainActiveMode: "resume",
        mainActiveSessionId: sessionId,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
    env: buildIsolatedElectronEnv({
      HOME: tempHome,
      USERPROFILE: tempHome,
      LVIS_HOME: lvisHome,
      LVIS_DEV: "1",
      LVIS_E2E: "1",
      LVIS_MAIN_ENTRY: MAIN_ENTRY,
      NODE_ENV: "test",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    }),
    timeout: 30_000,
  });

  app.process().stdout?.on("data", (d: Buffer) => process.stdout.write(`[electron:stdout] ${d}`));
  app.process().stderr?.on("data", (d: Buffer) => process.stdout.write(`[electron:stderr] ${d}`));

  const page = await app.firstWindow();
  await page.locator('[data-testid="main-toolbar"]').first().waitFor({
    state: "visible",
    timeout: 60_000,
  });

  return { app, page, userDataDir, tempHome, lvisHome };
}

export async function teardownSeededElectron(ctx: SeededElectronContext): Promise<void> {
  await ctx.app.close().catch(() => {});
  rmSync(ctx.userDataDir, { recursive: true, force: true });
  rmSync(ctx.tempHome, { recursive: true, force: true });
}

export async function sendRendererStreamEvent(
  app: ElectronApplication,
  event: JsonObject,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ev) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    win.webContents.send("lvis:chat:stream", ev);
  }, event);
}
