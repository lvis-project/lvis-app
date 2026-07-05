/**
 * E4 cluster-review — settings.update shortcut/startup reconcile.
 *
 * Covers:
 *  - MINOR-2 (security M1 drift): a combined patch that changes shortcuts/system
 *    AND fails the reviewer rewire must STILL reconcile the OS state — the
 *    shortcuts/system fields are already persisted by `patch`, so the early
 *    return on rewire failure must not skip the reconcile.
 *  - MINOR-3 (security M2 / critic M2): a login-item apply failure
 *    (reconcileStartupLaunch → applied:false) is surfaced via
 *    notifyStartupLaunchFailureIfNeeded, not silently dropped.
 *  - What's-Missing §6b: the shortcutStartupSignature gate triggers the reconcile
 *    ONLY when shortcuts/system launch fields change — an unrelated patch does
 *    not reconcile.
 *
 * MUTATION CONTRACT:
 *  - Removing the reconcile call from the rewire-fail early-return makes the
 *    "reconciles on combined patch even when rewire fails" test fail.
 *  - Reverting the signature gate to always-fire makes the "does NOT reconcile"
 *    test fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: {},
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const reconcileGlobalShortcuts = vi.fn(() => ({ status: "registered", accelerator: "Alt+Space" }));
const reconcileStartupLaunch = vi.fn(() => ({
  openAtLogin: true,
  openAsHidden: false,
  wasOpenedAsHidden: false,
  applied: true,
}));
const notifyStartupLaunchFailureIfNeeded = vi.fn();

vi.mock("../../../main/global-shortcuts.js", () => ({
  reconcileGlobalShortcuts: (...a: unknown[]) => reconcileGlobalShortcuts(...a),
}));
vi.mock("../../../main/startup-launch.js", () => ({
  reconcileStartupLaunch: (...a: unknown[]) => reconcileStartupLaunch(...a),
  notifyStartupLaunchFailureIfNeeded: (...a: unknown[]) => notifyStartupLaunchFailureIfNeeded(...a),
}));

// Shared fixture (test-helpers.ts) — no senderFrame set, so validateSender's
// `!frame` early-allow applies, same as this file's former inline `invoke`.
const invoke = makeAppIpcInvoker(handlers);

/**
 * Key-based settings mock. `shortcuts`/`system` flip to their "after" value once
 * `patch` runs, reproducing the prev→new signature transition the handler
 * detects. `flip` selects which blocks change.
 */
function makeDeps(opts: {
  flip: "shortcuts" | "none";
  rewireThrows?: boolean;
  llmChanges?: boolean;
}) {
  let patched = false;
  const rewire = opts.rewireThrows
    ? vi.fn().mockImplementationOnce(() => {
        throw new Error("reviewer down");
      }).mockImplementation(() => undefined)
    : vi.fn();
  const prevLlm = { provider: "openai", vendors: { "azure-foundry": { baseUrl: null } } };
  const nextLlm = opts.llmChanges
    ? { provider: "claude", vendors: { "azure-foundry": { baseUrl: null } } }
    : prevLlm;
  return {
    settingsService: {
      getAll: vi.fn(() => ({ llm: nextLlm })),
      get: vi.fn((key: string) => {
        if (key === "llm") return patched ? nextLlm : prevLlm;
        if (key === "marketplace") return { cloudAllowPrivateNetwork: false };
        if (key === "shortcuts") {
          return opts.flip === "shortcuts" && patched
            ? { toggleWindow: "Alt+Space", enabled: true }
            : { toggleWindow: null, enabled: false };
        }
        if (key === "system") return { launchAtStartup: false, launchMinimized: false };
        return {};
      }),
      patch: vi.fn(async (p: unknown) => {
        patched = true;
        return p;
      }),
      replaceLlm: vi.fn(async (llm: unknown) => llm),
    },
    conversationLoop: { refreshProvider: vi.fn() },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn(() => []),
    rewireReviewerAgent: rewire,
    refreshActiveLlmWildcard: vi.fn(),
  };
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("settings.update shortcut/startup reconcile", () => {
  it("reconciles OS state when the shortcut block changes (baseline)", async () => {
    const deps = makeDeps({ flip: "shortcuts" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", { shortcuts: { toggleWindow: "Alt+Space", enabled: true } });

    expect(reconcileGlobalShortcuts).toHaveBeenCalledOnce();
    expect(reconcileStartupLaunch).toHaveBeenCalledOnce();
    expect(notifyStartupLaunchFailureIfNeeded).toHaveBeenCalledOnce();
  });

  it("MINOR-3: surfaces a login-item apply failure via notifyStartupLaunchFailureIfNeeded", async () => {
    const failedState = {
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAsHidden: false,
      applied: false,
      reason: "platform-unsupported" as const,
    };
    reconcileStartupLaunch.mockReturnValue(failedState);
    const deps = makeDeps({ flip: "shortcuts" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", { shortcuts: { toggleWindow: "Alt+Space", enabled: true } });

    expect(notifyStartupLaunchFailureIfNeeded).toHaveBeenCalledWith(
      { launchAtStartup: false, launchMinimized: false },
      failedState,
    );
  });

  it("MINOR-2: reconciles even when a combined patch fails the reviewer rewire", async () => {
    // Combined patch: changes the active LLM (forces the rewire) AND the shortcut
    // block. The rewire throws → handler early-returns reviewer-rewire-failed, but
    // the shortcuts/system fields are already persisted, so the reconcile must
    // still fire.
    const deps = makeDeps({ flip: "shortcuts", rewireThrows: true, llmChanges: true });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:update", {
      llm: { provider: "claude" },
      shortcuts: { toggleWindow: "Alt+Space", enabled: true },
    });

    expect(result).toMatchObject({ ok: false, error: "reviewer-rewire-failed" });
    // The drift fix — reconcile ran on the early-return path.
    expect(reconcileGlobalShortcuts).toHaveBeenCalledOnce();
    expect(reconcileStartupLaunch).toHaveBeenCalledOnce();
    expect(notifyStartupLaunchFailureIfNeeded).toHaveBeenCalledOnce();
  });

  it("§6b: does NOT reconcile when shortcuts/system are unchanged", async () => {
    const deps = makeDeps({ flip: "none" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    // A patch that touches only an unrelated field.
    await invoke("lvis:settings:update", { chat: { fontScale: 1.1 } });

    expect(reconcileGlobalShortcuts).not.toHaveBeenCalled();
    expect(reconcileStartupLaunch).not.toHaveBeenCalled();
    expect(notifyStartupLaunchFailureIfNeeded).not.toHaveBeenCalled();
  });

  it("§6b: reconcile fires at most once per handler invocation on the failure path", async () => {
    const deps = makeDeps({ flip: "shortcuts", rewireThrows: true, llmChanges: true });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", {
      llm: { provider: "claude" },
      shortcuts: { toggleWindow: "Alt+Space", enabled: true },
    });

    // Guard against a double reconcile (early-return + tail both firing).
    expect(reconcileGlobalShortcuts).toHaveBeenCalledTimes(1);
    expect(reconcileStartupLaunch).toHaveBeenCalledTimes(1);
  });
});
