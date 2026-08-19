/**
 * `settings.update` announces a host public preference change.
 *
 * The signal an isolated plugin's `getAppPreference` depends on is only as good
 * as the place that fires it. `publishAppPreferenceChange` owns the "did
 * anything a plugin can read actually move" decision, and the settings domain
 * owns the moment a save committed — this file proves those two are joined, and
 * joined at the one broadcast every settings mutation already passes through.
 *
 * MUTATION CONTRACT:
 *  - Deleting the `publishAppPreferenceChange` call from
 *    `broadcastSettingsSnapshot` makes "announces a webView.preferredFlow
 *    change" fail: nothing else in the app calls it.
 *  - Removing the signature comparison inside `publishAppPreferenceChange`
 *    makes "does NOT announce a save that moved no allow-listed preference"
 *    fail, because every unrelated settings save would then push to every
 *    isolated plugin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { subscribeAppPreferenceChange } from "../../../plugins/config-change-bus.js";
import { _resetAppPreferencePublisher } from "../../../boot/steps/plugin-runtime/app-preference.js";
import type { WebViewPreferredFlow } from "../../../data/settings-store.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: {},
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock("../../../main/global-shortcuts.js", () => ({
  reconcileGlobalShortcuts: vi.fn(() => ({ status: "registered", accelerator: "Alt+Space" })),
}));
vi.mock("../../../main/startup-launch.js", () => ({
  reconcileStartupLaunch: vi.fn(() => ({
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAsHidden: false,
    applied: true,
  })),
  notifyStartupLaunchFailureIfNeeded: vi.fn(),
}));

const invoke = makeAppIpcInvoker(handlers);

/**
 * A settings service whose `webView` block moves when the caller says so.
 *
 * `flipTo` is applied by `patch`, which is what reproduces the real
 * before/after the handler sees: the announcement is decided AFTER the write
 * committed, from live settings, not from the patch payload.
 */
function makeDeps(options: { initialFlow: WebViewPreferredFlow; flipTo?: WebViewPreferredFlow }) {
  let flow = options.initialFlow;
  const llm = { provider: "openai", vendors: { "azure-foundry": { baseUrl: null } } };
  return {
    settingsService: {
      getAll: vi.fn(() => ({ llm, webView: { preferredFlow: flow } })),
      get: vi.fn((key: string) => {
        if (key === "llm") return llm;
        if (key === "marketplace") return { cloudAllowPrivateNetwork: false };
        if (key === "shortcuts") return { toggleWindow: null, enabled: false };
        if (key === "system") return { launchAtStartup: false, launchMinimized: false };
        if (key === "webView") return { preferredFlow: flow };
        return {};
      }),
      patch: vi.fn(async (patched: unknown) => {
        if (options.flipTo) flow = options.flipTo;
        return patched;
      }),
      replaceLlm: vi.fn(async (next: unknown) => next),
    },
    conversationLoop: { refreshProvider: vi.fn() },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn(() => []),
    rewireReviewerAgent: vi.fn(),
    refreshActiveLlmWildcard: vi.fn(),
  };
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  // The publisher remembers what it last announced, so a suite that did not
  // reset it would inherit the previous test's baseline.
  _resetAppPreferencePublisher();
});

describe("settings.update and the host public preference signal", () => {
  it("announces a webView.preferredFlow change once the save has committed", async () => {
    const announcements: number[] = [];
    const stop = subscribeAppPreferenceChange(() => announcements.push(1));
    const deps = makeDeps({ initialFlow: "in-app", flipTo: "system-browser" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    try {
      await invoke("lvis:settings:update", { webView: { preferredFlow: "system-browser" } });
      expect(announcements).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("does NOT announce a save that moved no allow-listed preference", async () => {
    const announcements: number[] = [];
    const stop = subscribeAppPreferenceChange(() => announcements.push(1));
    const deps = makeDeps({ initialFlow: "in-app", flipTo: "system-browser" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    try {
      // First save moves it, so the publisher has a baseline that is not the
      // "never looked" one — otherwise the second assertion would pass for the
      // wrong reason.
      await invoke("lvis:settings:update", { webView: { preferredFlow: "system-browser" } });
      expect(announcements).toHaveLength(1);

      // A second save that leaves the allow-listed value where it is. Every
      // isolated plugin would otherwise take a push for a theme change.
      await invoke("lvis:settings:update", { chat: { fontScale: 1.1 } });
      expect(announcements).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
