/**
 * Deep-link uninstall REFUSALS must broadcast a stable code, not an English
 * sentence.
 *
 * These three refusals have no IPC twin to drift from — they are produced only
 * here — so nothing but this test stands between them and the status-bar toast,
 * which renders `formatIpcError(error, message)`. With no code and no `message`
 * half, `formatIpcError` falls to its last branch and prints `error` verbatim:
 * a Korean user saw `에이전트 not installed` (a localized noun welded to an
 * English predicate), `Plugin not installed`, or `Admin plugin cannot be
 * uninstalled by user`.
 *
 * The payloads below come out of the REAL producer (`handleLvisUri`) and are
 * read off the REAL broadcast (`sendToWindow`). The final assertion in each
 * case closes the loop to the consumer: the emitted code must resolve in
 * `COMMON_IPC_ERROR_MESSAGES`, which is what makes the toast localize. See
 * `hooks/status-bar/__tests__/uninstall-refusal-copy.test.ts` for the rendered
 * copy itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import {
  ADMIN_PLUGIN_UNINSTALL_DENIED_CODE,
  PACKAGE_NOT_INSTALLED_CODE,
} from "../../shared/plugin-install-result.js";
import { resolveIpcErrorKey } from "../../ui/renderer/format-ipc-error.js";

const sendToWindow = vi.fn();
const getMainWindow = vi.fn();
const getServices = vi.fn();

vi.mock("electron", () => ({
  app: { isPackaged: false },
  // The refusal dialogs are single-button acknowledgements; response 0 is OK.
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));
vi.mock("node:path", () => ({ resolve: (...p: string[]) => p.join("/") }));
// `t` is the identity so a leaked *localized* string would be visible as its
// key. The English predicates this test forbids are literals in the producer,
// not keys, so identity `t` cannot mask them.
vi.mock("../../i18n/index.js", () => ({ t: (k: string) => k }));
vi.mock("../../ipc/safe-send.js", () => ({
  sendToWindow: (...a: unknown[]) => sendToWindow(...a),
}));
vi.mock("../../boot/types.js", () => ({ emitEvent: vi.fn() }));
vi.mock("../../shared/lvis-home.js", () => ({ lvisHome: () => "/tmp/lvis" }));
vi.mock("../../plugins/install-lifecycle.js", () => ({
  installMarketplacePluginWithLifecycle: vi.fn(),
  ensurePluginStateReadyForInstall: vi.fn(async () => undefined),
  drainPluginInstallLockOperations: vi.fn(async () => undefined),
}));
vi.mock("../../plugins/uninstall-lifecycle.js", () => ({
  uninstallPluginWithLifecycle: vi.fn(),
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

function makeServices(item: Record<string, unknown>) {
  return {
    pluginMarketplace: {
      list: vi.fn(async () => [
        { id: "test-package", slug: "test-package", name: "Test", ...item },
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

/** The payload the deep-link uninstall actually broadcast on `channel`. */
async function uninstallResultPayload(
  uri: string,
  channel: string,
): Promise<Record<string, unknown> | undefined> {
  const { handleLvisUri } = await import("../lvis-deep-link.js");
  await handleLvisUri(uri);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  const call = sendToWindow.mock.calls.find((c) => c[1] === channel);
  return call?.[2] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  getMainWindow.mockReturnValue({ isDestroyed: vi.fn(() => false) });
});

describe("lvis:// uninstall refusal payload", () => {
  it.each([
    ["agent", "lvis://uninstall/agent/test-package", CHANNELS.agents.uninstallResult],
    ["skill", "lvis://uninstall/skill/test-package", CHANNELS.skills.uninstallResult],
    ["plugin", "lvis://uninstall/test-package", CHANNELS.plugins.uninstallResult],
  ] as const)(
    "sends the package-not-installed code for a %s that is not installed",
    async (_packageType, uri, channel) => {
      getServices.mockReturnValue(makeServices({ installed: false }));

      const payload = await uninstallResultPayload(uri, channel);

      expect(payload).toBeDefined();
      expect(payload).toMatchObject({
        success: false,
        error: PACKAGE_NOT_INSTALLED_CODE,
      });
      // The exact regression: an English predicate in the `error` field.
      expect(String(payload?.error)).not.toContain("not installed");
      expect(resolveIpcErrorKey(String(payload?.error))).toBeDefined();
    },
  );

  it("sends a distinct code when an administrator deployed the plugin", async () => {
    getServices.mockReturnValue(makeServices({ installed: true, isManaged: true }));

    const payload = await uninstallResultPayload(
      "lvis://uninstall/test-package",
      CHANNELS.plugins.uninstallResult,
    );

    expect(payload).toMatchObject({
      success: false,
      error: ADMIN_PLUGIN_UNINSTALL_DENIED_CODE,
    });
    // Not collapsed into the not-installed code: the plugin IS installed, and
    // the user's remedy (ask the administrator) is different.
    expect(payload?.error).not.toBe(PACKAGE_NOT_INSTALLED_CODE);
    expect(String(payload?.error)).not.toContain("cannot be uninstalled");
    expect(resolveIpcErrorKey(String(payload?.error))).toBeDefined();
  });

  it("still uninstalls when nothing refuses, so the refusal branches are not the only path", async () => {
    const { uninstallPluginWithLifecycle } = await import("../../plugins/uninstall-lifecycle.js");
    vi.mocked(uninstallPluginWithLifecycle).mockResolvedValue({
      pluginId: "test-package",
    } as never);
    getServices.mockReturnValue(makeServices({ installed: true }));

    const payload = await uninstallResultPayload(
      "lvis://uninstall/test-package",
      CHANNELS.plugins.uninstallResult,
    );

    expect(payload).toMatchObject({ slug: "test-package", success: true });
  });
});
