/**
 * Deep-link install failures must send the SAME payload the IPC install
 * handler sends.
 *
 * Both entry points call `installMarketplacePluginWithLifecycle`, so an
 * `IncompatibleAppVersionError` propagates identically — but the deep-link
 * branch used to hand-build `{ error: err.message }`, sending the raw English
 * sentence where the IPC branch sends the stable `incompatible-app-version`
 * code plus its human detail. Both land on the same status-bar toast, which
 * calls `formatIpcError(error, message)`, so the deep-link user saw untranslated
 * English while the in-app user saw localized copy.
 *
 * These tests drive the REAL producer (`handleLvisUri`) and read the REAL
 * broadcast payload off `sendToWindow`. `plugin-install-result.js` and
 * `app-contract.js` are deliberately NOT mocked — they are what is under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import {
  IncompatibleAppVersionError,
  INCOMPATIBLE_APP_VERSION_CODE,
} from "../../plugins/public-contract.js";

const sendToWindow = vi.fn();
const installMarketplacePluginWithLifecycle = vi.fn();
const getMainWindow = vi.fn();
const getServices = vi.fn();

vi.mock("electron", () => ({
  app: { isPackaged: false },
  // response 0 === the install button, so the confirm dialog proceeds.
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));
vi.mock("node:path", () => ({ resolve: (...p: string[]) => p.join("/") }));
vi.mock("../../i18n/index.js", () => ({ t: (k: string) => k }));
vi.mock("../../ipc/safe-send.js", () => ({
  sendToWindow: (...a: unknown[]) => sendToWindow(...a),
}));
vi.mock("../../boot/types.js", () => ({ emitEvent: vi.fn() }));
vi.mock("../../shared/lvis-home.js", () => ({ lvisHome: () => "/tmp/lvis" }));
vi.mock("../../plugins/install-lifecycle.js", () => ({
  installMarketplacePluginWithLifecycle: (...a: unknown[]) =>
    installMarketplacePluginWithLifecycle(...a),
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

function makeServices() {
  return {
    pluginMarketplace: {
      list: vi.fn(async () => [
        { id: "test-plugin", slug: "test-plugin", name: "Test", installed: false },
      ]),
    },
    pluginRuntime: {},
    settingsService: {},
    mcpManager: { getConfigs: vi.fn(async () => []) },
    pluginPaths: {},
    clearAuthPartitionService: vi.fn(),
    listPluginAuthPartitionsService: vi.fn(),
    forgetPluginAuthPartitionsService: vi.fn(),
    refreshPluginNotifications: vi.fn(),
  };
}

/** The payload the deep-link install actually broadcast on the result channel. */
async function installResultPayload(): Promise<Record<string, unknown> | undefined> {
  const { handleLvisUri } = await import("../lvis-deep-link.js");
  await handleLvisUri("lvis://install/test-plugin");
  // The install runs in a detached `void (async () => ...)`; let it settle.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  const call = sendToWindow.mock.calls.find(
    (c) => c[1] === CHANNELS.plugins.installResult,
  );
  return call?.[2] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  // NOTE: deliberately no `vi.resetModules()`. It would give the dynamically
  // imported module graph its own copy of `public-contract.js`, so the
  // `IncompatibleAppVersionError` this file constructs would not be
  // `instanceof` the class `buildInstallFailureResult` checks against — the
  // test would fail for a module-identity reason that has nothing to do with
  // the behaviour under test.
  getMainWindow.mockReturnValue({ isDestroyed: vi.fn(() => false) });
  getServices.mockReturnValue(makeServices());
});

describe("lvis:// install failure payload", () => {
  it("sends the stable code plus its human detail, not the raw message", async () => {
    const err = new IncompatibleAppVersionError("2.0.0", "1.0.0");
    installMarketplacePluginWithLifecycle.mockRejectedValue(err);

    const payload = await installResultPayload();

    expect(payload).toBeDefined();
    expect(payload).toMatchObject({
      slug: "test-plugin",
      success: false,
      // The renderer's formatIpcError maps THIS to localized copy. Sending
      // `err.message` here is what showed the user untranslated English.
      error: INCOMPATIBLE_APP_VERSION_CODE,
      // The concrete text (carrying the version numbers) rides along as the
      // documented fallback — it must not be dropped.
      message: err.message,
    });
    expect(payload?.error).not.toBe(err.message);
  });

  it("puts the plain message in `error` when the failure has no stable code", async () => {
    // Guards against a fix that hardcodes the incompatible-version code.
    installMarketplacePluginWithLifecycle.mockRejectedValue(new Error("disk full"));

    const payload = await installResultPayload();

    expect(payload).toMatchObject({
      slug: "test-plugin",
      success: false,
      error: "disk full",
    });
    expect(payload).not.toHaveProperty("message");
  });
});
