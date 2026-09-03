import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SubscriptionRuntimeId,
  SubscriptionRuntimeStatus,
} from "../../../shared/subscription-runtime.js";
import { MAX_COMPOSER_ATTACHMENT_COUNT, MAX_COMPOSER_IMAGE_BYTES } from "../../../shared/composer-image-input.js";
import { SETTINGS } from "../../../shared/ipc-channels.js";
import { deferred } from "../../../__tests__/test-helpers.js";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const runtimeServiceMock = vi.hoisted(() => ({
  get: vi.fn(),
  errorCode: vi.fn((error: unknown) => {
    if (
      error !== null
      && typeof error === "object"
      && typeof (error as { code?: unknown }).code === "string"
    ) {
      return (error as { code: string }).code;
    }
    return "subscription-operation-failed";
  }),
  RuntimeError: class SubscriptionRuntimeServiceError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = "SubscriptionRuntimeServiceError";
    }
  },
}));
const shellOpenExternal = vi.hoisted(() => vi.fn(async () => undefined));
const localeMock = vi.hoisted(() => ({
  normalizeLocale: vi.fn((value: unknown) => typeof value === "string" ? value : "en"),
  setLocale: vi.fn(),
  tryLoadLocaleMessages: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {},
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  shell: { openExternal: shellOpenExternal },
}));

vi.mock("../../../main/subscription-runtime-service.js", () => ({
  getSubscriptionRuntimeService: runtimeServiceMock.get,
  subscriptionRuntimeErrorCode: runtimeServiceMock.errorCode,
  SubscriptionRuntimeServiceError: runtimeServiceMock.RuntimeError,
}));

vi.mock("../../../i18n/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../i18n/index.js")>()),
  normalizeLocale: localeMock.normalizeLocale,
  setLocale: localeMock.setLocale,
  tryLoadLocaleMessages: localeMock.tryLoadLocaleMessages,
}));

const invoke = makeAppIpcInvoker(handlers);

const READY_CAPABILITIES: SubscriptionRuntimeStatus["capabilities"] = Object.freeze({
  chat: true,
  images: true,
  imageAttachmentLimits: Object.freeze({
    maxCount: MAX_COMPOSER_ATTACHMENT_COUNT,
    maxBytesPerImage: MAX_COMPOSER_IMAGE_BYTES,
    maxTotalBytes: MAX_COMPOSER_IMAGE_BYTES,
  }),
  files: true,
  tools: true,
  projectAccess: true,
  plugins: true,
  mcp: true,
  generateText: true,
  compaction: true,
  routine: true,
  subagent: true,
});

function readyStatus(provider: SubscriptionRuntimeId): SubscriptionRuntimeStatus {
  return {
    provider,
    runtime: "ready",
    connection: "connected",
    planType: null,
    pendingLogin: null,
    pendingDeviceCode: null,
    canOpenVerificationUrl: false,
    version: "test",
    capabilities: READY_CAPABILITIES,
  };
}

const runtime = {
  getStatus: vi.fn(),
  getCachedStatus: vi.fn(),
  chooseExecutable: vi.fn(),
  forgetExecutable: vi.fn(),
  verify: vi.fn(),
  startLogin: vi.fn(),
  openPendingVerificationUrl: vi.fn(),
  cancelLogin: vi.fn(),
  logout: vi.fn(),
  listModels: vi.fn(),
};

type TestLlm = {
  provider: "openai";
  vendors: { openai: { model: string; baseUrl: null } };
  activeChatRuntime:
    | { kind: "api" }
    | { kind: "subscription"; provider: SubscriptionRuntimeId; model?: string };
};

type TestLlmPatch = {
  activeChatRuntime?: TestLlm["activeChatRuntime"];
  vendors?: { openai?: Partial<TestLlm["vendors"]["openai"]> };
};

type TestAppWindow = {
  isDestroyed: () => boolean;
  webContents: {
    isDestroyed: () => boolean;
    send: (...args: unknown[]) => void;
  };
};

function makeDeps() {
  const llm: TestLlm = {
    provider: "openai",
    vendors: { openai: { model: "gpt-5", baseUrl: null } },
    activeChatRuntime: { kind: "api" },
  };
  return {
    settingsService: {
      getAll: vi.fn(() => ({ appearance: { language: "en" }, llm })),
      get: vi.fn((key: string) => {
        if (key === "llm") return llm;
        if (key === "marketplace") return { cloudAllowPrivateNetwork: false };
        if (key === "shortcuts") return { toggleWindow: null, enabled: false };
        if (key === "system") return { launchAtStartup: false, launchMinimized: false };
        return {};
      }),
      patch: vi.fn(async (value: unknown) => {
        const patch = (value as { llm?: TestLlmPatch }).llm;
        if (patch?.activeChatRuntime) {
          llm.activeChatRuntime = structuredClone(patch.activeChatRuntime);
        }
        if (patch?.vendors?.openai) {
          llm.vendors.openai = { ...llm.vendors.openai, ...patch.vendors.openai };
        }
        return value;
      }),
      replaceLlm: vi.fn(async (value: unknown) => value),
      getSecret: vi.fn(() => null),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
    },
    conversationLoop: { refreshProvider: vi.fn(), abortCurrentTurn: vi.fn() },
    sideChatConversationLoop: { refreshProvider: vi.fn(), abortCurrentTurn: vi.fn() },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn<() => TestAppWindow[]>(() => []),
    refreshActiveLlmWildcard: vi.fn(),
    rewireReviewerAgent: vi.fn(),
  };
}

function makeStatefulSelectionDeps(initialLlm: TestLlm) {
  let llm: TestLlm = structuredClone(initialLlm);
  const deps = makeDeps();
  const snapshot = () => ({ appearance: { language: "en" }, llm });
  deps.settingsService.getAll = vi.fn(snapshot);
  deps.settingsService.get = vi.fn((key: string) => {
    if (key === "llm") return llm;
    if (key === "marketplace") return { cloudAllowPrivateNetwork: false };
    if (key === "shortcuts") return { toggleWindow: null, enabled: false };
    if (key === "system") return { launchAtStartup: false, launchMinimized: false };
    return {};
  });
  const applyLlmPatch = (value: unknown) => {
    const patch = (value as { llm?: TestLlmPatch }).llm;
    if (patch?.activeChatRuntime) {
      llm = { ...llm, activeChatRuntime: structuredClone(patch.activeChatRuntime) };
    }
    if (patch?.vendors?.openai) {
      llm = {
        ...llm,
        vendors: {
          ...llm.vendors,
          openai: { ...llm.vendors.openai, ...patch.vendors.openai },
        },
      };
    }
    return snapshot();
  };
  deps.settingsService.patch = vi.fn(async (value: unknown) => applyLlmPatch(value));
  deps.settingsService.replaceLlm = vi.fn(async (replacement: unknown) => {
    llm = structuredClone(replacement as TestLlm);
    return snapshot();
  });
  return { deps, currentLlm: () => llm, applyLlmPatch };
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  localeMock.normalizeLocale.mockImplementation((value: unknown) => typeof value === "string" ? value : "en");
  localeMock.tryLoadLocaleMessages.mockResolvedValue(true);
  runtimeServiceMock.get.mockResolvedValue(runtime);
  runtime.getStatus.mockImplementation(async (provider: SubscriptionRuntimeId) => readyStatus(provider));
  runtime.getCachedStatus.mockReturnValue(undefined);
  runtime.chooseExecutable.mockImplementation(async (provider: SubscriptionRuntimeId) => readyStatus(provider));
  runtime.forgetExecutable.mockImplementation(async (provider: SubscriptionRuntimeId) => readyStatus(provider));
  runtime.verify.mockImplementation(async (provider: SubscriptionRuntimeId) => readyStatus(provider));
  runtime.startLogin.mockImplementation(async (provider: SubscriptionRuntimeId) => readyStatus(provider));
  runtime.openPendingVerificationUrl.mockImplementation(async (provider: SubscriptionRuntimeId) => readyStatus(provider));
  runtime.cancelLogin.mockImplementation(async (provider: SubscriptionRuntimeId) => readyStatus(provider));
  runtime.logout.mockImplementation(async (provider: SubscriptionRuntimeId) => readyStatus(provider));
  runtime.listModels.mockResolvedValue({
    status: readyStatus("codex"),
    models: [{ id: "gpt-5", displayName: "GPT-5", isDefault: true }],
  });
  vi.resetModules();
});

describe("common subscription runtime IPC", () => {
  it("uses the central service, verifies Codex, validates its exact model, and persists the chat selection", async () => {
    const deps = makeDeps();
    const rewire = vi.fn();
    deps.rewireReviewerAgent = rewire;
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:subscription:use-for-chat", "codex", "gpt-5");

    expect(result).toMatchObject({ ok: true, status: { provider: "codex", capabilities: READY_CAPABILITIES } });
    expect(runtime.verify).toHaveBeenCalledWith("codex");
    expect(runtime.listModels).toHaveBeenCalledWith("codex");
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: { activeChatRuntime: { kind: "subscription", provider: "codex", model: "gpt-5" } },
    });
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(rewire).toHaveBeenCalledOnce();
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalledOnce();
    expect(deps.settingsService.patch.mock.invocationCallOrder[0])
      .toBeLessThan(deps.conversationLoop.refreshProvider.mock.invocationCallOrder[0]!);
    expect(deps.sideChatConversationLoop.refreshProvider.mock.invocationCallOrder[0])
      .toBeLessThan(rewire.mock.invocationCallOrder[0]!);
  });

  it("binds every execution consumer before delayed subscription persistence resolves", async () => {
    const state = makeStatefulSelectionDeps({
      provider: "openai",
      vendors: { openai: { model: "gpt-5", baseUrl: null } },
      activeChatRuntime: { kind: "api" },
    });
    const selectionApplied = deferred<void>();
    const releasePersistence = deferred<void>();
    const patch = vi.fn((value: unknown) => {
      const snapshot = state.applyLlmPatch(value);
      selectionApplied.resolve();
      return releasePersistence.promise.then(() => snapshot);
    });
    const rewire = vi.fn();
    const deps = { ...state.deps, rewireReviewerAgent: rewire };
    deps.settingsService.patch = patch;
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const pending = invoke("lvis:settings:subscription:use-for-chat", "codex", "gpt-5");
    await selectionApplied.promise;

    expect(state.currentLlm().activeChatRuntime).toEqual({
      kind: "subscription",
      provider: "codex",
      model: "gpt-5",
    });
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(rewire).toHaveBeenCalledOnce();
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalledOnce();
    expect(deps.conversationLoop.abortCurrentTurn).toHaveBeenCalledOnce();
    expect(deps.sideChatConversationLoop.abortCurrentTurn).toHaveBeenCalledOnce();

    releasePersistence.resolve();
    await expect(pending).resolves.toMatchObject({ ok: true, status: { provider: "codex" } });
  });

  it("restores every execution binding before waiting for rollback persistence", async () => {
    const state = makeStatefulSelectionDeps({
      provider: "openai",
      vendors: { openai: { model: "gpt-5", baseUrl: null } },
      activeChatRuntime: { kind: "api" },
    });
    const firstPersist = deferred<void>();
    const rollbackApplied = deferred<void>();
    const releaseRollbackPersist = deferred<void>();
    let patchCalls = 0;
    const patch = vi.fn((value: unknown) => {
      const snapshot = state.applyLlmPatch(value);
      patchCalls += 1;
      if (patchCalls === 1) return firstPersist.promise.then(() => snapshot);
      rollbackApplied.resolve();
      return releaseRollbackPersist.promise.then(() => snapshot);
    });
    const rewire = vi.fn()
      .mockImplementationOnce(() => { throw new Error("reviewer unavailable"); })
      .mockImplementationOnce(() => undefined);
    const deps = { ...state.deps, rewireReviewerAgent: rewire };
    deps.settingsService.patch = patch;
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const pending = invoke("lvis:settings:subscription:use-for-chat", "codex", "gpt-5");
    await vi.waitFor(() => expect(state.currentLlm().activeChatRuntime).toEqual({
      kind: "subscription",
      provider: "codex",
      model: "gpt-5",
    }));
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledOnce();

    firstPersist.resolve();
    await rollbackApplied.promise;

    expect(state.currentLlm().activeChatRuntime).toEqual({ kind: "api" });
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledTimes(2);
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledTimes(2);
    expect(rewire).toHaveBeenCalledTimes(2);
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalledOnce();

    releaseRollbackPersist.resolve();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "subscription-operation-failed",
    });
  });

  it("supports ACP subscriptions through the same verification-and-selection path", async () => {
    const deps = makeDeps();
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:subscription:use-for-chat", "kimi-code");

    expect(result).toMatchObject({ ok: true, status: { provider: "kimi-code", capabilities: READY_CAPABILITIES } });
    expect(runtime.verify).toHaveBeenCalledWith("kimi-code");
    expect(runtime.listModels).not.toHaveBeenCalled();
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: { activeChatRuntime: { kind: "subscription", provider: "kimi-code" } },
    });
  });
  it("emits revision-only status invalidations for runtime mutations, including failures", async () => {
    const deps = makeDeps();
    const send = vi.fn();
    deps.getAppWindows = vi.fn(() => [{
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send },
    }]);
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:subscription:status", "codex");
    expect(send).not.toHaveBeenCalled();

    await expect(invoke("lvis:settings:subscription:verify", "codex")).resolves.toMatchObject({
      ok: true,
      status: { provider: "codex" },
    });
    runtime.logout.mockRejectedValueOnce(
      new runtimeServiceMock.RuntimeError("subscription-operation-failed"),
    );
    await expect(invoke("lvis:settings:subscription:logout", "codex")).resolves.toEqual({
      ok: false,
      error: "subscription-operation-failed",
    });

    const events = send.mock.calls
      .filter(([channel]) => channel === "lvis:settings:subscription:status-updated")
      .map(([, event]) => event as { provider: string; revision: number });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ provider: "codex", revision: expect.any(Number) });
    expect(events[1]).toEqual({ provider: "codex", revision: expect.any(Number) });
    expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
  });

  it("invalidates the prior active subscription after switching back to API keys", async () => {
    const state = makeStatefulSelectionDeps({
      provider: "openai",
      vendors: { openai: { model: "gpt-5", baseUrl: null } },
      activeChatRuntime: { kind: "subscription", provider: "codex", model: "gpt-5" },
    });
    const send = vi.fn();
    const deps = state.deps;
    deps.getAppWindows = vi.fn(() => [{
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send },
    }]);
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await expect(invoke("lvis:settings:subscription:use-api-for-chat")).resolves.toEqual({ ok: true });

    const settingsUpdateIndex = send.mock.calls.findIndex(([channel]) => channel === SETTINGS.updated);
    const statusUpdateIndex = send.mock.calls.findIndex(
      ([channel]) => channel === "lvis:settings:subscription:status-updated",
    );
    expect(settingsUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(statusUpdateIndex).toBeGreaterThan(settingsUpdateIndex);
    expect(send.mock.calls[statusUpdateIndex]?.[1]).toEqual({
      provider: "codex",
      revision: expect.any(Number),
    });
  });


  it("rewires the reviewer when returning from subscription chat to the API-key runtime", async () => {
    const deps = makeDeps();
    const rewire = vi.fn();
    deps.rewireReviewerAgent = rewire;
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:subscription:use-api-for-chat");

    expect(result).toEqual({ ok: true });
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: { activeChatRuntime: { kind: "api" } },
    });
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(rewire).toHaveBeenCalledOnce();
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalledOnce();
  });

  it("restores API chat, both loops, and reviewer wiring when subscription rewire fails", async () => {
    const previousLlm: TestLlm = {
      provider: "openai",
      vendors: { openai: { model: "gpt-5", baseUrl: null } },
      activeChatRuntime: { kind: "api" },
    };
    const state = makeStatefulSelectionDeps(previousLlm);
    const send = vi.fn();
    const rewire = vi.fn()
      .mockImplementationOnce(() => { throw new Error("reviewer unavailable"); })
      .mockImplementationOnce(() => undefined);
    const deps = { ...state.deps, rewireReviewerAgent: rewire };
    deps.getAppWindows = vi.fn(() => [{
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send },
    }]);
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:subscription:use-for-chat", "codex", "gpt-5");

    expect(result).toMatchObject({
      ok: false,
      error: "subscription-operation-failed",
      status: { provider: "codex" },
    });
    expect(deps.settingsService.replaceLlm).not.toHaveBeenCalled();
    expect(deps.settingsService.patch).toHaveBeenNthCalledWith(2, {
      llm: { activeChatRuntime: { kind: "api" } },
    });
    expect(state.currentLlm().activeChatRuntime).toEqual({ kind: "api" });
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledTimes(2);
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledTimes(2);
    expect(rewire).toHaveBeenCalledTimes(2);
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      SETTINGS.updated,
      expect.objectContaining({
        llm: expect.objectContaining({ activeChatRuntime: { kind: "api" } }),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      "lvis:settings:subscription:status-updated",
      { provider: "codex", revision: expect.any(Number) },
    );
  });

  it("restores a subscription selection if API-key reviewer rewiring fails", async () => {
    const previousLlm: TestLlm = {
      provider: "openai",
      vendors: { openai: { model: "gpt-5", baseUrl: null } },
      activeChatRuntime: { kind: "subscription", provider: "codex", model: "gpt-5" },
    };
    const state = makeStatefulSelectionDeps(previousLlm);
    const rewire = vi.fn()
      .mockImplementationOnce(() => { throw new Error("reviewer unavailable"); })
      .mockImplementationOnce(() => undefined);
    const deps = { ...state.deps, rewireReviewerAgent: rewire };
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:subscription:use-api-for-chat");

    expect(result).toEqual({ ok: false, error: "subscription-operation-failed" });
    expect(deps.settingsService.replaceLlm).not.toHaveBeenCalled();
    expect(deps.settingsService.patch).toHaveBeenNthCalledWith(2, {
      llm: {
        activeChatRuntime: { kind: "subscription", provider: "codex", model: "gpt-5" },
      },
    });
    expect(state.currentLlm().activeChatRuntime).toEqual({
      kind: "subscription",
      provider: "codex",
      model: "gpt-5",
    });
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledTimes(2);
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledTimes(2);
    expect(rewire).toHaveBeenCalledTimes(2);
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalledOnce();
  });

  it("restores only the failed runtime selection while preserving an overlapping LLM update", async () => {
    const state = makeStatefulSelectionDeps({
      provider: "openai",
      vendors: { openai: { model: "gpt-5", baseUrl: null } },
      activeChatRuntime: { kind: "api" },
    });
    const rewire = vi.fn()
      .mockImplementationOnce(() => {
        void state.deps.settingsService.patch({
          llm: { vendors: { openai: { model: "gpt-5.1" } } },
        });
        throw new Error("reviewer unavailable");
      })
      .mockImplementationOnce(() => undefined);
    const deps = { ...state.deps, rewireReviewerAgent: rewire };
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:subscription:use-for-chat", "codex", "gpt-5");

    expect(result).toMatchObject({ ok: false, error: "subscription-operation-failed" });
    expect(deps.settingsService.replaceLlm).not.toHaveBeenCalled();
    expect(deps.settingsService.patch).toHaveBeenNthCalledWith(3, {
      llm: { activeChatRuntime: { kind: "api" } },
    });
    expect(state.currentLlm()).toMatchObject({
      activeChatRuntime: { kind: "api" },
      vendors: { openai: { model: "gpt-5.1", baseUrl: null } },
    });
  });

  it("does not let a failed older selection roll back a newer selection or publish stale status", async () => {
    const state = makeStatefulSelectionDeps({
      provider: "openai",
      vendors: { openai: { model: "gpt-5", baseUrl: null } },
      activeChatRuntime: { kind: "api" },
    });
    const send = vi.fn();
    const rewire = vi.fn()
      .mockImplementationOnce(() => {
        void invoke("lvis:settings:subscription:use-api-for-chat");
        throw new Error("reviewer unavailable");
      })
      .mockImplementationOnce(() => undefined);
    const deps = { ...state.deps, rewireReviewerAgent: rewire };
    deps.getAppWindows = vi.fn(() => [{
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send },
    }]);
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const first = await invoke("lvis:settings:subscription:use-for-chat", "codex", "gpt-5");

    expect(first).toMatchObject({ ok: false, error: "subscription-operation-failed" });
    await vi.waitFor(() => expect(state.currentLlm().activeChatRuntime).toEqual({ kind: "api" }));
    expect(deps.settingsService.replaceLlm).not.toHaveBeenCalled();
    expect(deps.settingsService.patch).toHaveBeenCalledTimes(2);
    expect(deps.settingsService.patch).toHaveBeenNthCalledWith(1, {
      llm: { activeChatRuntime: { kind: "subscription", provider: "codex", model: "gpt-5" } },
    });
    expect(deps.settingsService.patch).toHaveBeenNthCalledWith(2, {
      llm: { activeChatRuntime: { kind: "api" } },
    });
    expect(send.mock.calls.filter(([channel]) => channel === SETTINGS.updated)).toHaveLength(1);
    expect(send.mock.calls.filter(([channel]) => channel === "lvis:settings:subscription:status-updated"))
      .toHaveLength(2);
  });

  it("suppresses stale selection effects when a newer selection persists while the older write is pending", async () => {
    const state = makeStatefulSelectionDeps({
      provider: "openai",
      vendors: { openai: { model: "gpt-5", baseUrl: null } },
      activeChatRuntime: { kind: "api" },
    });
    const firstApplied = deferred<void>();
    const releaseFirstPersist = deferred<void>();
    let patchCalls = 0;
    const patch = vi.fn((value: unknown) => {
      const snapshot = state.applyLlmPatch(value);
      patchCalls += 1;
      if (patchCalls === 1) {
        firstApplied.resolve();
        return releaseFirstPersist.promise.then(() => snapshot);
      }
      return Promise.resolve(snapshot);
    });
    const send = vi.fn();
    const rewire = vi.fn();
    const deps = { ...state.deps, rewireReviewerAgent: rewire };
    deps.settingsService.patch = patch;
    deps.getAppWindows = vi.fn(() => [{
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send },
    }]);
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const older = invoke("lvis:settings:subscription:use-for-chat", "codex", "gpt-5");
    await firstApplied.promise;
    await expect(invoke("lvis:settings:subscription:use-api-for-chat")).resolves.toEqual({ ok: true });
    releaseFirstPersist.resolve();
    await expect(older).resolves.toMatchObject({ ok: true, status: { provider: "codex" } });

    expect(state.currentLlm().activeChatRuntime).toEqual({ kind: "api" });
    expect(rewire).toHaveBeenCalledTimes(2);
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledTimes(2);
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledTimes(2);
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalledTimes(2);
    const settingsSnapshots = send.mock.calls
      .filter(([channel]) => channel === SETTINGS.updated)
      .map(([, snapshot]) => snapshot as { llm: TestLlm });
    expect(settingsSnapshots).toEqual([
      expect.objectContaining({ llm: expect.objectContaining({ activeChatRuntime: { kind: "api" } }) }),
    ]);
    expect(send.mock.calls.filter(([channel]) => channel === "lvis:settings:subscription:status-updated"))
      .toHaveLength(2);
  });

  it("does not let a late pre-selection verification override a newer API selection", async () => {
    const state = makeStatefulSelectionDeps({
      provider: "openai",
      vendors: { openai: { model: "gpt-5", baseUrl: null } },
      activeChatRuntime: { kind: "subscription", provider: "codex", model: "gpt-5" },
    });
    const delayedVerify = deferred<SubscriptionRuntimeStatus>();
    runtime.verify.mockImplementationOnce(() => delayedVerify.promise);
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(state.deps as never);

    // Kimi's selection must verify before it can persist. While that awaits,
    // a newer API choice is valid and must own the final runtime.
    const olderSubscription = invoke("lvis:settings:subscription:use-for-chat", "kimi-code");
    await vi.waitFor(() => expect(runtime.verify).toHaveBeenCalledWith("kimi-code"));
    await expect(invoke("lvis:settings:subscription:use-api-for-chat")).resolves.toEqual({ ok: true });

    delayedVerify.resolve(readyStatus("kimi-code"));
    await expect(olderSubscription).resolves.toMatchObject({
      ok: false,
      error: "subscription-operation-failed",
      status: { provider: "kimi-code" },
    });

    expect(state.currentLlm().activeChatRuntime).toEqual({ kind: "api" });
    expect(state.deps.settingsService.patch).toHaveBeenCalledTimes(1);
    expect(state.deps.settingsService.patch).toHaveBeenCalledWith({
      llm: { activeChatRuntime: { kind: "api" } },
    });
  });

  it("does not apply a stale locale, settings snapshot, or status after delayed selection broadcast", async () => {
    const state = makeStatefulSelectionDeps({
      provider: "openai",
      vendors: { openai: { model: "gpt-5", baseUrl: null } },
      activeChatRuntime: { kind: "api" },
    });
    const firstLocaleRequested = deferred<void>();
    const releaseFirstLocale = deferred<boolean>();
    let localeRequests = 0;
    localeMock.tryLoadLocaleMessages.mockImplementation(() => {
      localeRequests += 1;
      if (localeRequests === 1) {
        firstLocaleRequested.resolve();
        return releaseFirstLocale.promise;
      }
      return Promise.resolve(true);
    });
    const send = vi.fn();
    const rewire = vi.fn();
    const deps = { ...state.deps, rewireReviewerAgent: rewire };
    deps.getAppWindows = vi.fn(() => [{
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send },
    }]);
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const older = invoke("lvis:settings:subscription:use-for-chat", "codex", "gpt-5");
    await firstLocaleRequested.promise;
    await expect(invoke("lvis:settings:subscription:use-api-for-chat")).resolves.toEqual({ ok: true });
    releaseFirstLocale.resolve(true);
    await expect(older).resolves.toMatchObject({ ok: true, status: { provider: "codex" } });

    expect(localeMock.setLocale).toHaveBeenCalledTimes(1);
    expect(localeMock.setLocale).toHaveBeenCalledWith("en");
    const settingsSnapshots = send.mock.calls
      .filter(([channel]) => channel === SETTINGS.updated)
      .map(([, snapshot]) => snapshot as { llm: TestLlm });
    expect(settingsSnapshots).toEqual([
      expect.objectContaining({ llm: expect.objectContaining({ activeChatRuntime: { kind: "api" } }) }),
    ]);
    expect(send.mock.calls.filter(([channel]) => channel === "lvis:settings:subscription:status-updated"))
      .toHaveLength(2);
    expect(rewire).toHaveBeenCalledTimes(2);
  });

  it("selects Grok Build through the shared verified ACP path", async () => {
    const deps = makeDeps();
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:subscription:use-for-chat", "grok-build");

    expect(result).toMatchObject({ ok: true, status: { provider: "grok-build", capabilities: READY_CAPABILITIES } });
    expect(runtime.verify).toHaveBeenCalledWith("grok-build");
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: { activeChatRuntime: { kind: "subscription", provider: "grok-build" } },
    });
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledOnce();
  });
  it("rejects an unlisted Codex model and a model supplied to an ACP runtime before persisting", async () => {
    const deps = makeDeps();
    runtime.listModels.mockResolvedValue({
      status: readyStatus("codex"),
      models: [{ id: "gpt-5", displayName: "GPT-5", isDefault: true }],
    });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    expect(await invoke("lvis:settings:subscription:use-for-chat", "codex", "not-listed")).toMatchObject({
      ok: false,
      error: "subscription-chat-unavailable",
    });
    expect(await invoke("lvis:settings:subscription:use-for-chat", "grok-build", "not-allowed")).toMatchObject({
      ok: false,
      error: "subscription-chat-unavailable",
    });
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
    expect(runtime.verify).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy Codex and ACP callers on the same central service", async () => {
    const deps = makeDeps();
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const codex = await invoke("lvis:settings:codex-subscription:status");
    const kimi = await invoke("lvis:settings:acp-subscription:status", "kimi-code");

    expect(codex).toMatchObject({ ok: true, status: { connection: "connected" } });
    expect(kimi).toMatchObject({
      ok: true,
      status: {
        provider: "kimi-code",
        connection: "connected",
        promptCapabilities: { image: true, embeddedContext: true },

      },
    });
    expect(runtime.getStatus).toHaveBeenCalledWith("codex");
    expect(runtime.getStatus).toHaveBeenCalledWith("kimi-code");
    expect(runtimeServiceMock.get).toHaveBeenCalled();
  });

  it("rejects invalid generic subscription inputs before the runtime service", async () => {
    const deps = makeDeps();
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await expect(invoke("lvis:settings:subscription:status", "not-a-provider")).resolves.toEqual({
      ok: false,
      error: "subscription-provider-not-supported",
    });
    await expect(invoke("lvis:settings:subscription:start-login", "kimi-code", "browser")).resolves.toEqual({
      ok: false,
      error: "subscription-provider-not-supported",
    });

    expect(runtimeServiceMock.get).not.toHaveBeenCalled();
    expect(runtime.startLogin).not.toHaveBeenCalled();
  });

  it("validates a runtime-supplied verification URL before opening it", async () => {
    const deps = makeDeps();
    runtime.openPendingVerificationUrl.mockImplementation(
      async (_provider: SubscriptionRuntimeId, openExternal: (url: string) => Promise<void>) => {
        await openExternal("javascript:alert('unsafe')");
        return readyStatus("kimi-code");
      },
    );
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:subscription:open-login-browser", "kimi-code");

    expect(result).toEqual({
      ok: false,
      error: "subscription-verification-url-unavailable",
    });
    expect(shellOpenExternal).not.toHaveBeenCalled();
  });

  it("rejects a non-host frame before it reaches the common runtime service", async () => {
    const deps = makeDeps();
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);
    const handler = handlers.get("lvis:settings:subscription:verify")!;

    const result = await handler(
      { senderFrame: { url: "https://untrusted.example/settings" } } as never,
      "codex",
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(runtimeServiceMock.get).not.toHaveBeenCalled();
    expect(runtime.verify).not.toHaveBeenCalled();
  });
});
