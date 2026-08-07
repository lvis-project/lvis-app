/**
 * Agent/skill install failures must reach the renderer the way plugin install
 * failures do: on the DECLARED channel, carrying a stable code the toast can
 * localize.
 *
 * Two defects lived here. The deep-link handler built its channel names by
 * template (`lvis:${ns}:install-result`) instead of reading
 * `CHANNELS.agents.*` / `CHANNELS.skills.*`, and it hand-built
 * `{ error: err.message }` — so a marketplace-disabled agent install rendered
 * the raw English sentence "Agent marketplace install is unavailable: ..." in
 * the status-bar toast, while the SAME failure through the IPC handler carried
 * the `marketplace-disabled` code the renderer maps to localized copy.
 *
 * Both producers here are real: `handleLvisUri` for the deep link and the
 * handler `registerPluginsHandlers` registers for the IPC path. The payloads
 * are read off the real `sendToWindow` / the real handler return value;
 * `plugin-install-result.js` and `app-contract.js` are NOT mocked — they are
 * what is under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { MARKETPLACE_DISABLED_CODE } from "../../shared/plugin-install-result.js";

const sendToWindow = vi.fn();
const getMainWindow = vi.fn();
const getServices = vi.fn();
const installAgentPackageFromMarketplace = vi.fn();
const installSkillPackageFromMarketplace = vi.fn();
const ipcHandlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { isPackaged: false },
  // response 0 === the install button, so the confirm dialog proceeds.
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  ipcMain: {
    handle: (channel: string, handler: (e: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    },
    on: vi.fn(),
  },
  webContents: { fromId: vi.fn() },
  shell: { openExternal: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
}));
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual };
});
vi.mock("../../i18n/index.js", () => ({ t: (k: string) => k }));
vi.mock("../../ipc/safe-send.js", () => ({
  sendToWindow: (...a: unknown[]) => sendToWindow(...a),
}));
vi.mock("../../boot/types.js", () => ({ emitEvent: vi.fn() }));
vi.mock("../../shared/lvis-home.js", () => ({ lvisHome: () => "/tmp/lvis" }));
vi.mock("../../plugins/install-lifecycle.js", () => ({
  installMarketplacePluginWithLifecycle: vi.fn(),
}));
vi.mock("../../plugins/uninstall-lifecycle.js", () => ({
  uninstallPluginWithLifecycle: vi.fn(),
  ensurePluginStateReadyForInstall: vi.fn(async () => undefined),
  drainPluginInstallLockOperations: vi.fn(async () => undefined),
}));
vi.mock("../../shared/network-access.js", () => ({
  buildNetworkAccessAcknowledgement: vi.fn(() => undefined),
  hasNetworkAccessDisclosure: vi.fn(() => false),
}));
vi.mock("../app-menu.js", () => ({ activateInlineSettings: vi.fn() }));
vi.mock("../../agents/agent-installer.js", () => ({
  installAgentPackageFromMarketplace: (...a: unknown[]) =>
    installAgentPackageFromMarketplace(...a),
  uninstallAgentPackage: vi.fn(),
}));
vi.mock("../../skills/skill-installer.js", () => ({
  installSkillPackageFromMarketplace: (...a: unknown[]) =>
    installSkillPackageFromMarketplace(...a),
  uninstallSkillPackage: vi.fn(),
}));

const APP_WINDOW = { id: "win-1" };
vi.mock("../main-window.js", () => ({
  createWindow: vi.fn(),
  getAppWindows: vi.fn(() => [APP_WINDOW]),
  loadMainInterface: vi.fn(async () => undefined),
  registerMainWindowPluginEventBridge: vi.fn(),
  showMainWindow: vi.fn(),
}));
vi.mock("../app-state.js", () => ({
  getMainWindow: (...a: unknown[]) => getMainWindow(...a),
  getServices: (...a: unknown[]) => getServices(...a),
  setPendingLvisUri: vi.fn(),
}));
vi.mock("../../ipc/gated.js", () => ({
  validateSender: () => true,
  validateHostRendererSender: () => true,
  validatePluginFrame: () => true,
  auditUnauthorized: vi.fn(),
  UNAUTHORIZED_FRAME: { ok: false, error: "unauthorized-frame" },
}));

/**
 * `artifactStores: false` is the marketplace-disabled build: the agent/skill
 * artifact stores the installers need were never constructed.
 */
function makeServices(opts: { artifactStores: boolean }) {
  return {
    pluginMarketplace: {
      list: vi.fn(async () => [
        { id: "sample-pkg", slug: "sample-pkg", name: "Sample", installed: false },
      ]),
      getFetcher: vi.fn(() => ({})),
    },
    agentArtifactStore: opts.artifactStores ? {} : undefined,
    skillArtifactStore: opts.artifactStores ? {} : undefined,
    pluginRuntime: {},
    settingsService: {},
    mcpManager: { getConfigs: vi.fn(async () => []) },
    pluginPaths: {},
    clearAuthPartitionService: vi.fn(),
    listPluginAuthPartitionsService: vi.fn(),
    forgetPluginAuthPartitionsService: vi.fn(),
    refreshPluginNotifications: vi.fn(),
    getMainWindow: () => APP_WINDOW,
    getAppWindows: () => [APP_WINDOW],
  };
}

/** The payload the deep-link install actually broadcast, per package family. */
async function deepLinkInstallResult(
  packageType: "agent" | "skill",
): Promise<Record<string, unknown> | undefined> {
  const { handleLvisUri } = await import("../lvis-deep-link.js");
  await handleLvisUri(`lvis://install/${packageType}/sample-pkg`);
  // The install runs in a detached `void (async () => ...)`; let it settle.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  const channel = packageType === "agent"
    ? CHANNELS.agents.installResult
    : CHANNELS.skills.installResult;
  const call = sendToWindow.mock.calls.find((c) => c[1] === channel);
  return call?.[2] as Record<string, unknown> | undefined;
}

/** The `{ ok: false }` frame the real IPC install handler returns. */
async function ipcInstallResult(
  packageType: "agent" | "skill",
  services: ReturnType<typeof makeServices>,
): Promise<Record<string, unknown>> {
  const { registerPluginsHandlers } = await import("../../ipc/domains/plugins.js");
  registerPluginsHandlers(services as never);
  const channel = packageType === "agent" ? CHANNELS.agents.install : CHANNELS.skills.install;
  const handler = ipcHandlers.get(channel);
  expect(handler, `no IPC handler registered for ${channel}`).toBeDefined();
  return await handler!({}, "sample-pkg") as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcHandlers.clear();
  // NOTE: deliberately no `vi.resetModules()` — see the sibling
  // lvis-deep-link-install-result.test.ts. A second module copy would break the
  // `instanceof` check `buildInstallFailureResult` performs.
  getMainWindow.mockReturnValue({ isDestroyed: vi.fn(() => false) });
  getServices.mockReturnValue(makeServices({ artifactStores: false }));
});

describe.each(["agent", "skill"] as const)("lvis:// %s install failure payload", (packageType) => {
  const family = packageType === "agent" ? CHANNELS.agents : CHANNELS.skills;

  it("broadcasts on the declared install-result channel", async () => {
    const payload = await deepLinkInstallResult(packageType);

    expect(payload, `nothing was sent on ${family.installResult}`).toBeDefined();
    // The templated name happens to equal the constant today; what this pins is
    // that the renderer's channel is the one written to.
    const channels = sendToWindow.mock.calls.map((c) => c[1]);
    expect(channels).toContain(family.installResult);
    expect(channels).toContain(family.installProgress);
  });

  it("sends the stable marketplace-disabled code, not the raw English sentence", async () => {
    const payload = await deepLinkInstallResult(packageType);

    expect(payload).toMatchObject({
      slug: "sample-pkg",
      success: false,
      // The renderer's formatIpcError maps THIS to localized copy. Sending
      // `err.message` here is what showed the user untranslated English.
      error: MARKETPLACE_DISABLED_CODE,
    });
    expect(payload?.error).not.toContain("marketplace backend is disabled");
    // The concrete English detail rides along as the documented fallback.
    expect(payload?.message).toContain("marketplace backend is disabled");
  });

  it("agrees with the IPC install handler on the code for the same failure", async () => {
    const deepLink = await deepLinkInstallResult(packageType);
    const ipc = await ipcInstallResult(packageType, makeServices({ artifactStores: false }));

    expect(ipc.ok).toBe(false);
    // The parity that was missing: one failure, one code, both entry points.
    expect(ipc.error).toBe(deepLink?.error);
    expect(ipc.message).toBe(deepLink?.message);
  });

  it("puts the plain message in `error` when the failure has no stable code", async () => {
    // Guards against a fix that hardcodes the marketplace-disabled code.
    getServices.mockReturnValue(makeServices({ artifactStores: true }));
    installAgentPackageFromMarketplace.mockRejectedValue(new Error("disk full"));
    installSkillPackageFromMarketplace.mockRejectedValue(new Error("disk full"));

    const payload = await deepLinkInstallResult(packageType);

    expect(payload).toMatchObject({
      slug: "sample-pkg",
      success: false,
      error: "disk full",
    });
    expect(payload).not.toHaveProperty("message");
  });

  it("broadcasts the same shape from the IPC handler on an installer failure", async () => {
    const services = makeServices({ artifactStores: true });
    installAgentPackageFromMarketplace.mockRejectedValue(new Error("disk full"));
    installSkillPackageFromMarketplace.mockRejectedValue(new Error("disk full"));

    await ipcInstallResult(packageType, services);

    const call = sendToWindow.mock.calls.find((c) => c[1] === family.installResult);
    expect(call?.[2]).toMatchObject({ slug: "sample-pkg", success: false, error: "disk full" });
  });
});
