import { describe, expect, it, vi } from "vitest";
import type { StreamEvent, ToolSchema } from "../../engine/llm/types.js";
import {
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
} from "../../shared/subscription-runtime.js";
import type { AcpSubscriptionStatus } from "../../shared/acp-subscription.js";
import type { CodexSubscriptionStatus } from "../../shared/codex-subscription.js";
import type { CodexAppServerClient, CodexAppServerClientOptions } from "../codex-app-server-client.js";
import type {
  CodexConversationRuntime,
  CodexConversationRuntimeOptions,
} from "../codex-conversation-runtime.js";
import type { AcpSubscriptionRuntimeRegistry } from "../acp-subscription-runtime-registry.js";
import { AcpSubscriptionSessionError } from "../acp-subscription-session-client.js";
import { MAX_ACP_SUBSCRIPTION_IMAGE_BYTES } from "../acp-subscription-session-client.js";
import { DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS } from "../subscription-attachment-input.js";
import {
  SubscriptionRuntimeService,
} from "../subscription-runtime-service.js";
import {
  SubscriptionToolBridgeClient,
  readSubscriptionToolMcpServerConfig,
} from "../subscription-tool-mcp-server.js";
import { SubscriptionToolBridge } from "../subscription-tool-bridge.js";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";

const CODEX_CONNECTED: CodexSubscriptionStatus = {
  runtime: "ready",
  connection: "connected",
  planType: "plus",
  pendingLogin: null,
  pendingDeviceCode: null,
};

const KIMI_CONNECTED: AcpSubscriptionStatus = {
  provider: "kimi-code",
  runtime: "ready",
  connection: "connected",
  pendingLogin: null,
  pendingDeviceCode: null,
  canOpenVerificationUrl: false,
  version: "test",
  promptCapabilities: { image: false, embeddedContext: false },
};

const GROK_CONNECTED: AcpSubscriptionStatus = {
  provider: "grok-build",
  runtime: "ready",
  connection: "connected",
  pendingLogin: null,
  pendingDeviceCode: null,
  canOpenVerificationUrl: false,
  version: "test",
  promptCapabilities: { image: false, embeddedContext: false },
};

const HOST_TOOL: ToolSchema = {
  name: "read_project_file",
  description: "Read one project file through the normal LVIS tool loop.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

function namespace(): FeatureNamespaceHandle {
  return {
    dir: "C:\\isolated\\subscription-runtimes",
    childDir: vi.fn(async (name: string) => `C:\\isolated\\subscription-runtimes\\${name}`),
    readJson: vi.fn(async (_name: string, fallback: unknown) => fallback),
    writeJson: vi.fn(async () => undefined),
  } as unknown as FeatureNamespaceHandle;
}

function fakeCodexClient(): CodexAppServerClient {
  return {
    getStatus: vi.fn(async () => CODEX_CONNECTED),
    getCachedStatus: vi.fn(() => CODEX_CONNECTED),
    listModels: vi.fn(async () => ({
      status: CODEX_CONNECTED,
      models: [],
    })),
    stop: vi.fn(),
  } as unknown as CodexAppServerClient;
}

describe("SubscriptionRuntimeService", () => {
  it("requires isolation verification and shares the fresh v3 Codex auth home with text chat", async () => {
    const clientOptions: CodexAppServerClientOptions[] = [];
    const runtimeOptions: CodexConversationRuntimeOptions[] = [];
    const runtime = {
      verifyIsolation: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as CodexConversationRuntime;
    const registry = { stopAll: vi.fn(async () => undefined) } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      acpRegistry: registry,
      createCodexAppServerClient: (options) => {
        clientOptions.push(options);
        return fakeCodexClient();
      },
      createCodexConversationRuntime: (options) => {
        runtimeOptions.push(options);
        return runtime;
      },
    });

    expect((await service.getStatus("codex")).capabilities.chat).toBe(false);
    const verified = await service.verify("codex");
    expect(verified.capabilities).toMatchObject({
      chat: true,
      images: true,
      imageAttachmentLimits: DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS,
    });

    expect(runtime.verifyIsolation).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(clientOptions).toHaveLength(1);
    expect(runtimeOptions).toHaveLength(1);
    expect(clientOptions[0]?.runtimeHome).toBe(runtimeOptions[0]?.runtimeHome);
    expect(clientOptions[0]?.sqliteHome).toBe(runtimeOptions[0]?.sqliteHome);
    expect(clientOptions[0]?.workspaceDir).not.toBe(runtimeOptions[0]?.workspaceDir);
    expect(clientOptions[0]?.runtimeHome).toContain("codex-v3-home");
    expect(clientOptions[0]?.sqliteHome).toContain("codex-v3-sqlite");
    expect(clientOptions[0]?.runtimeTempDir).not.toBe(runtimeOptions[0]?.runtimeTempDir);
    expect(clientOptions[0]?.runtimeTempDir).toContain("codex-login-v2-tmp");
  });
  it("projects the negotiated Kimi ACP image budget only after verification", async () => {
    const KIMI_WITH_IMAGES: AcpSubscriptionStatus = {
      ...KIMI_CONNECTED,
      promptCapabilities: { image: true, embeddedContext: false },
    };
    const registry = {
      getStatus: vi.fn(async () => KIMI_WITH_IMAGES),
      verify: vi.fn(async () => KIMI_WITH_IMAGES),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });

    expect((await service.getStatus("kimi-code")).capabilities).toMatchObject({
      chat: false,
      images: false,
      imageAttachmentLimits: null,
    });
    expect((await service.verify("kimi-code")).capabilities).toMatchObject({
      chat: true,
      images: true,
      imageAttachmentLimits: {
        maxCount: 5,
        maxBytesPerImage: MAX_ACP_SUBSCRIPTION_IMAGE_BYTES,
        maxTotalBytes: MAX_ACP_SUBSCRIPTION_IMAGE_BYTES,
      },
    });
  });

  it("rejects model ids above the shared subscription cap before opening a runtime", async () => {
    const registry = { stopAll: vi.fn(async () => undefined) } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });

    await expect(service.openTextSession({
      kind: "subscription",
      provider: "codex",
      model: "x".repeat(MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH + 1),
    })).rejects.toMatchObject({ code: "subscription-chat-unavailable" });
  });

  it("enables Grok Build after shared ACP verification and exposes negotiated image input", async () => {
    const GROK_WITH_IMAGES: AcpSubscriptionStatus = {
      ...GROK_CONNECTED,
      promptCapabilities: { image: true, embeddedContext: false },
    };
    const rawSession = {
      provider: "grok-build" as const,
      streamTurn: async function* (): AsyncGenerator<StreamEvent> {},
      cancelActiveTurn: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const registry = {
      getStatus: vi.fn(async () => GROK_WITH_IMAGES),
      verify: vi.fn(async () => GROK_WITH_IMAGES),
      openTextSession: vi.fn(async () => rawSession),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });

    const verified = await service.verify("grok-build");
    expect(verified).toMatchObject({
      provider: "grok-build",
      runtime: "ready",
      connection: "connected",
      capabilities: {
        chat: true,
        images: true,
        imageAttachmentLimits: {
          maxCount: 5,
          maxBytesPerImage: MAX_ACP_SUBSCRIPTION_IMAGE_BYTES,
        },
      },
    });
    expect((await service.getStatus("grok-build")).capabilities).toMatchObject({ chat: true, images: true });

    const session = await service.openTextSession({
      kind: "subscription",
      provider: "grok-build",
    });
    expect(session.provider).toBe("grok-build");
    expect(registry.openTextSession).toHaveBeenCalledWith("grok-build", expect.any(Object));
    await session.stop();
  });
  it("prevents a held service reference from opening an in-flight session after stop", async () => {
    let resolveStatus!: (status: AcpSubscriptionStatus) => void;
    const pendingStatus = new Promise<AcpSubscriptionStatus>((resolve) => {
      resolveStatus = resolve;
    });
    const registry = {
      getStatus: vi.fn(() => pendingStatus),
      verify: vi.fn(async () => KIMI_CONNECTED),
      openTextSession: vi.fn(),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });

    // The caller holds this instance while status is still resolving. Stopping
    // the singleton must make that retained reference terminal before the
    // pending operation can reach verify/openTextSession.
    const opening = service.openTextSession({ kind: "subscription", provider: "kimi-code" });
    expect(registry.getStatus).toHaveBeenCalledOnce();
    const stopping = service.stop();
    resolveStatus(KIMI_CONNECTED);
    await stopping;

    await expect(opening).rejects.toMatchObject({ code: "subscription-operation-failed" });
    expect(registry.verify).not.toHaveBeenCalled();
    expect(registry.openTextSession).not.toHaveBeenCalled();
    await expect(service.getStatus("kimi-code")).rejects.toMatchObject({
      code: "subscription-operation-failed",
    });
  });

  it("stops a raw ACP session that resolves after the held service stops", async () => {
    const rawSession = {
      provider: "kimi-code" as const,
      streamTurn: async function* (): AsyncGenerator<StreamEvent> {},
      cancelActiveTurn: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    let resolveSession!: (session: typeof rawSession) => void;
    let markOpen!: () => void;
    const pendingSession = new Promise<typeof rawSession>((resolve) => {
      resolveSession = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      markOpen = resolve;
    });
    const registry = {
      getStatus: vi.fn(async () => KIMI_CONNECTED),
      verify: vi.fn(async () => KIMI_CONNECTED),
      openTextSession: vi.fn(() => {
        markOpen();
        return pendingSession;
      }),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });
    await service.verify("kimi-code");

    const opening = service.openTextSession({ kind: "subscription", provider: "kimi-code" });
    await opened;
    const stopping = service.stop();
    resolveSession(rawSession);
    await stopping;

    await expect(opening).rejects.toMatchObject({ code: "subscription-operation-failed" });
    expect(rawSession.stop).toHaveBeenCalledOnce();
  });

  it("does not restore verified availability when a pending ACP verification loses an executable mutation", async () => {
    let resolveVerification!: (status: AcpSubscriptionStatus) => void;
    let markVerificationStarted!: () => void;
    const pendingVerification = new Promise<AcpSubscriptionStatus>((resolve) => {
      resolveVerification = resolve;
    });
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    const registry = {
      getStatus: vi.fn(async () => KIMI_CONNECTED),
      verify: vi.fn(() => {
        markVerificationStarted();
        return pendingVerification;
      }),
      setExecutable: vi.fn(async () => KIMI_CONNECTED),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });

    const verifying = service.verify("kimi-code");
    await verificationStarted;
    await service.chooseExecutable("kimi-code", "C:\\approved\\kimi.exe");
    resolveVerification(KIMI_CONNECTED);

    await expect(verifying).resolves.toMatchObject({
      capabilities: { chat: false },
    });
    await expect(service.getStatus("kimi-code")).resolves.toMatchObject({
      capabilities: { chat: false },
    });
  });

  it("stops a raw ACP session that resolves after an executable mutation", async () => {
    const rawSession = {
      provider: "kimi-code" as const,
      streamTurn: async function* (): AsyncGenerator<StreamEvent> {},
      cancelActiveTurn: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    let resolveSession!: (session: typeof rawSession) => void;
    let markOpen!: () => void;
    const pendingSession = new Promise<typeof rawSession>((resolve) => {
      resolveSession = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      markOpen = resolve;
    });
    const registry = {
      getStatus: vi.fn(async () => KIMI_CONNECTED),
      verify: vi.fn(async () => KIMI_CONNECTED),
      setExecutable: vi.fn(async () => KIMI_CONNECTED),
      openTextSession: vi.fn(() => {
        markOpen();
        return pendingSession;
      }),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });
    await service.verify("kimi-code");

    const opening = service.openTextSession({ kind: "subscription", provider: "kimi-code" });
    await opened;
    await service.chooseExecutable("kimi-code", "C:\\approved\\kimi.exe");
    resolveSession(rawSession);

    await expect(opening).rejects.toMatchObject({ code: "subscription-chat-unavailable" });
    expect(rawSession.stop).toHaveBeenCalledOnce();
  });

  it("fails an open result if an executable mutation lands after tracking but before return", async () => {
    const rawSession = {
      provider: "kimi-code" as const,
      streamTurn: async function* (): AsyncGenerator<StreamEvent> {},
      cancelActiveTurn: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    let service!: SubscriptionRuntimeService;
    let markMutationDone!: () => void;
    const mutationDone = new Promise<void>((resolve) => {
      markMutationDone = resolve;
    });
    const registry = {
      getStatus: vi.fn(async () => KIMI_CONNECTED),
      verify: vi.fn(async () => KIMI_CONNECTED),
      setExecutable: vi.fn(async () => KIMI_CONNECTED),
      openTextSession: vi.fn(async () => {
        // The first queued microtask lets trackSession add the wrapper. The
        // second invalidates it before trackVerifiedSession resumes its await.
        queueMicrotask(() => {
          queueMicrotask(() => {
            void service.chooseExecutable("kimi-code", "C:\\approved\\kimi.exe").then(markMutationDone);
          });
        });
        return rawSession;
      }),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });
    await service.verify("kimi-code");

    await expect(service.openTextSession({ kind: "subscription", provider: "kimi-code" }))
      .rejects.toMatchObject({ code: "subscription-chat-unavailable" });
    await mutationDone;
    expect(rawSession.stop).toHaveBeenCalledOnce();
  });

  it("rejects stale and unsupported persisted subscription model selections", async () => {
    const runtimeOptions: CodexConversationRuntimeOptions[] = [];
    const runtime = {
      verifyIsolation: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as CodexConversationRuntime;
    const listModels = vi.fn(async () => ({
      status: CODEX_CONNECTED,
      models: [{ id: "current-model", displayName: "Current model", isDefault: true }],
    }));
    const codexClient = {
      getStatus: vi.fn(async () => CODEX_CONNECTED),
      getCachedStatus: vi.fn(() => CODEX_CONNECTED),
      listModels,
      stop: vi.fn(),
    } as unknown as CodexAppServerClient;
    const registry = { stopAll: vi.fn(async () => undefined) } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient,
      acpRegistry: registry,
      createCodexConversationRuntime: (options) => {
        runtimeOptions.push(options);
        return runtime;
      },
    });

    expect((await service.verify("codex")).capabilities.chat).toBe(true);
    await expect(service.openTextSession({
      kind: "subscription",
      provider: "codex",
      model: "removed-model",
    })).rejects.toMatchObject({ code: "subscription-chat-unavailable" });
    expect(listModels).toHaveBeenCalledOnce();
    expect(runtimeOptions).toHaveLength(1);

    await expect(service.openTextSession({
      kind: "subscription",
      provider: "kimi-code",
      model: "not-supported",
    })).rejects.toMatchObject({ code: "subscription-chat-unavailable" });
    expect(runtimeOptions).toHaveLength(1);
  });

  it("uses the active parent Codex model only when a sub-agent profile candidate is absent from the live catalog", async () => {
    type StartTurnInput = { readonly model?: string | null };
    type TurnCallbacks = {
      onTextDelta?: (event: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
      }) => void;
    };
    const startTurnInputs: StartTurnInput[] = [];
    const listModels = vi.fn(async () => ({
      status: CODEX_CONNECTED,
      models: [
        { id: "parent-model", displayName: "Parent", isDefault: true },
        { id: "profile-model", displayName: "Profile", isDefault: false },
      ],
    }));
    const codexClient = {
      getStatus: vi.fn(async () => CODEX_CONNECTED),
      getCachedStatus: vi.fn(() => CODEX_CONNECTED),
      listModels,
      stop: vi.fn(),
    } as unknown as CodexAppServerClient;
    const verificationRuntime = {
      verifyIsolation: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as CodexConversationRuntime;
    const createTextRuntime = (): CodexConversationRuntime => ({
      startTurn: vi.fn(async (input: StartTurnInput, callbacks: TurnCallbacks) => {
        startTurnInputs.push(input);
        callbacks.onTextDelta?.({
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "ok",
        });
        return { threadId: "thread-1", turnId: "turn-1", status: "completed" };
      }),
      isTurnActive: vi.fn(() => false),
      interrupt: vi.fn(async () => undefined),
      stop: vi.fn(),
    }) as unknown as CodexConversationRuntime;
    let runtimeCalls = 0;
    const audit = vi.fn();
    const registry = { stopAll: vi.fn(async () => undefined) } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient,
      acpRegistry: registry,
      audit,
      createCodexConversationRuntime: () => {
        runtimeCalls += 1;
        return runtimeCalls === 1 ? verificationRuntime : createTextRuntime();
      },
    });

    try {
      await service.verify("codex");
      const parentSelection = {
        kind: "subscription" as const,
        provider: "codex" as const,
        model: "parent-model",
      };
      const staleProfileSession = await service.openTextSession(
        { kind: "subscription", provider: "codex", model: "removed-profile-model" },
        { fallbackSelection: parentSelection },
      );
      for await (const _event of staleProfileSession.streamTurn("Run the child task.")) {
        // Drain the short fake turn so its selected model reaches startTurn.
      }
      await staleProfileSession.stop();

      const verifiedProfileSession = await service.openTextSession(
        { kind: "subscription", provider: "codex", model: "profile-model" },
        { fallbackSelection: parentSelection },
      );
      for await (const _event of verifiedProfileSession.streamTurn("Run the child task.")) {
        // Drain the short fake turn so its selected model reaches startTurn.
      }
      await verifiedProfileSession.stop();

      expect(startTurnInputs.map((input) => input.model)).toEqual([
        "parent-model",
        "profile-model",
      ]);
      expect(listModels).toHaveBeenCalledTimes(2);
      expect(audit.mock.calls).toEqual([[
        { provider: "codex", outcome: "model-fallback" },
      ]]);

    } finally {
      await service.stop();
    }
  });


  it("invalidates safe availability when an ACP runtime requests a native host capability", async () => {
    let onHostRequest: ((request: { kind: "permission" | "tool" | "other" }) => void | Promise<void>) | undefined;
    const session = {
      provider: "kimi-code" as const,
      streamTurn: vi.fn(),
      cancelActiveTurn: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const verify = vi.fn(async () => KIMI_CONNECTED);
    const registry = {
      getStatus: vi.fn(async () => KIMI_CONNECTED),
      verify,
      openTextSession: vi.fn(async (_provider: string, options?: {
        onHostRequest?: (request: { kind: "permission" | "tool" | "other" }) => void | Promise<void>;
      }) => {
        onHostRequest = options?.onHostRequest;
        return session;
      }),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });

    await service.openTextSession({ kind: "subscription", provider: "kimi-code" });
    expect(verify).toHaveBeenCalledOnce();
    expect((await service.getStatus("kimi-code")).capabilities.chat).toBe(true);
    // Any auth/runtime mutation terminates an existing provider session first.
    await service.verify("kimi-code");
    expect(session.stop).toHaveBeenCalledOnce();
    await onHostRequest?.({ kind: "tool" });

    expect((await service.getStatus("kimi-code")).capabilities.chat).toBe(false);
  });
  it("fails closed before emitting a bridged tool call when a native ACP tool request races it", async () => {
    let onHostRequest: ((request: { kind: "permission" | "tool" | "other" }) => void | Promise<void>) | undefined;
    let signalTransportStarted: (() => void) | undefined;
    const transportStarted = new Promise<void>((resolve) => {
      signalTransportStarted = resolve;
    });
    const session = {
      provider: "kimi-code" as const,
      streamTurn: vi.fn(async function* () {
        signalTransportStarted?.();
        await new Promise<void>(() => undefined);
      }),
      cancelActiveTurn: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const registry = {
      getStatus: vi.fn(async () => KIMI_CONNECTED),
      verify: vi.fn(async () => KIMI_CONNECTED),
      openTextSession: vi.fn(async (_provider: string, options?: {
        onHostRequest?: (request: { kind: "permission" | "tool" | "other" }) => void | Promise<void>;
      }) => {
        onHostRequest = options?.onHostRequest;
        return session;
      }),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const setHandler = vi.spyOn(SubscriptionToolBridge.prototype, "setHandler");
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });

    try {
      const textSession = await service.openTextSession(
        { kind: "subscription", provider: "kimi-code" },
        { tools: [HOST_TOOL] },
      );
      const iterator = textSession.streamTurn("Use the LVIS project tool.")[Symbol.asyncIterator]();
      const emitted: StreamEvent[] = [];
      const firstEvent = iterator.next().then((result) => {
        if (!result.done) emitted.push(result.value);
        return result;
      });
      await transportStarted;

      const bridgeHandler = setHandler.mock.calls[0]?.[0];
      expect(bridgeHandler).toBeTypeOf("function");
      expect(onHostRequest).toBeTypeOf("function");
      if (!bridgeHandler || !onHostRequest) throw new Error("test-bridge-handler-missing");

      // Do not await: this schedules the bridge emission, then the raw ACP
      // host request arrives within the same event-loop turn.
      void bridgeHandler({
        id: "subscription_test_tool",
        name: HOST_TOOL.name,
        input: { path: "README.md" },
      });
      void onHostRequest({ kind: "tool" });

      await expect(firstEvent).rejects.toMatchObject({ code: "subscription-operation-failed" });
      expect(emitted).toEqual([]);
    } finally {
      await service.stop();
      setHandler.mockRestore();
    }
  });
  it("converts a safe ACP transport diagnostic into a generic stream event", async () => {
    const session = {
      provider: "kimi-code" as const,
      streamTurn: async function* () {
        throw new AcpSubscriptionSessionError("acp-session-operation-failed", {
          origin: "provider",
          statusCode: 400,
          providerCode: "invalid_function_parameters",
          classification: "unknown",
          messagePreview: "Invalid schema for function 'read_project_file'.",
        });
      },
      cancelActiveTurn: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const registry = {
      getStatus: vi.fn(async () => KIMI_CONNECTED),
      verify: vi.fn(async () => KIMI_CONNECTED),
      openTextSession: vi.fn(async () => session),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });

    try {
      await service.verify("kimi-code");
      const textSession = await service.openTextSession({ kind: "subscription", provider: "kimi-code" });
      const events: StreamEvent[] = [];
      for await (const event of textSession.streamTurn("read the project")) events.push(event);

      expect(events).toEqual([{
        type: "error",
        error: "Subscription runtime operation failed.",
        providerError: {
          origin: "provider",
          statusCode: 400,
          providerCode: "invalid_function_parameters",
          classification: "unknown",
          messagePreview: "Invalid schema for function 'read_project_file'.",
        },
      }]);
      await textSession.stop();
    } finally {
      await service.stop();
    }
  });

  it("turns an ACP MCP bridge call into the normal LVIS tool boundary", async () => {
    let mcpServers: readonly {
      readonly env: Readonly<Record<string, string>>;
    }[] | undefined;
    const session = {
      provider: "kimi-code" as const,
      streamTurn: async function* () {
        const descriptor = mcpServers?.[0];
        if (!descriptor) throw new Error("missing-lvis-mcp-bridge");
        const client = new SubscriptionToolBridgeClient(readSubscriptionToolMcpServerConfig({
          LVIS_SUBSCRIPTION_TOOL_BRIDGE_URL: descriptor.env.LVIS_SUBSCRIPTION_TOOL_BRIDGE_URL,
          LVIS_SUBSCRIPTION_TOOL_BRIDGE_TOKEN: descriptor.env.LVIS_SUBSCRIPTION_TOOL_BRIDGE_TOKEN,
        }));
        await client.callTool(HOST_TOOL.name, { path: "README.md" });
      },
      cancelActiveTurn: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const registry = {
      getStatus: vi.fn(async () => KIMI_CONNECTED),
      verify: vi.fn(async () => KIMI_CONNECTED),
      openTextSession: vi.fn(async (_provider: string, options?: {
        mcpServers?: readonly { readonly env: Readonly<Record<string, string>> }[];
      }) => {
        mcpServers = options?.mcpServers;
        return session;
      }),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
    });

    try {
      const textSession = await service.openTextSession(
        { kind: "subscription", provider: "kimi-code" },
        { tools: [HOST_TOOL] },
      );
      const events: StreamEvent[] = [];
      for await (const event of textSession.streamTurn("Read the project README.")) events.push(event);

      expect(events).toEqual([
        {
          type: "tool_call",
          id: expect.stringMatching(/^subscription_[A-Za-z0-9-]+$/u),
          name: "read_project_file",
          input: { path: "README.md" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ]);
      await textSession.stop();
      expect(session.stop).toHaveBeenCalledOnce();
    } finally {
      await service.stop();
    }
  });
  it("does not forward late ACP output after abort before cancellation settles", async () => {
    let signalTransportStarted: () => void = () => {};
    const transportStarted = new Promise<void>((resolve) => {
      signalTransportStarted = resolve;
    });
    let releaseLateOutput: () => void = () => {};
    const lateOutputReleased = new Promise<void>((resolve) => {
      releaseLateOutput = resolve;
    });
    let signalLateOutputConsumed: () => void = () => {};
    const lateOutputConsumed = new Promise<void>((resolve) => {
      signalLateOutputConsumed = resolve;
    });
    let signalCancellationStarted: () => void = () => {};
    const cancellationStarted = new Promise<void>((resolve) => {
      signalCancellationStarted = resolve;
    });
    let releaseCancellation: () => void = () => {};
    const cancellationReleased = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const session = {
      provider: "kimi-code" as const,
      streamTurn: async function* () {
        signalTransportStarted();
        await lateOutputReleased;
        yield { type: "text_delta", text: "late ACP output" } as StreamEvent;
        signalLateOutputConsumed();
      },
      cancelActiveTurn: vi.fn(async () => {
        signalCancellationStarted();
        await cancellationReleased;
      }),
      stop: vi.fn(async () => undefined),
    };
    const registry = {
      getStatus: vi.fn(async () => KIMI_CONNECTED),
      verify: vi.fn(async () => KIMI_CONNECTED),
      openTextSession: vi.fn(async () => session),
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const audit = vi.fn();
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
      audit,
    });
    try {
      await service.verify("kimi-code");
      const textSession = await service.openTextSession({ kind: "subscription", provider: "kimi-code" });
      const controller = new AbortController();
      const iterator = textSession.streamTurn("Cancel before output.", controller.signal)[Symbol.asyncIterator]();
      const firstEvent = iterator.next();
      await transportStarted;

      controller.abort();
      await cancellationStarted;
      releaseLateOutput();
      await lateOutputConsumed;
      releaseCancellation();

      await expect(firstEvent).rejects.toMatchObject({ code: "subscription-operation-failed" });
      expect(session.cancelActiveTurn).toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      expect((await service.getStatus("kimi-code")).capabilities.chat).toBe(true);
    } finally {
      releaseLateOutput();
      releaseCancellation();
      await service.stop();
    }
  });

  it("does not forward late Codex deltas after abort before interruption settles", async () => {
    type FakeTurnResult = {
      threadId: string;
      turnId: string;
      status: "completed" | "interrupted" | "failed";
    };
    type CallbackProbe = {
      onTextDelta?: (event: { delta: string }) => void;
      onReasoningDelta?: (event: { delta: string }) => void;
    };
    let callbacks: CallbackProbe | undefined;
    let signalTurnStarted: () => void = () => {};
    const turnStarted = new Promise<void>((resolve) => {
      signalTurnStarted = resolve;
    });
    let resolveTurn: (result: FakeTurnResult) => void = () => {};
    let signalInterruptStarted: () => void = () => {};
    const interruptStarted = new Promise<void>((resolve) => {
      signalInterruptStarted = resolve;
    });
    let releaseInterrupt: () => void = () => {};
    const interruptReleased = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const verificationRuntime = {
      verifyIsolation: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as CodexConversationRuntime;
    const textRuntime = {
      startTurn: vi.fn((_input: unknown, nextCallbacks: CallbackProbe) => {
        callbacks = nextCallbacks;
        signalTurnStarted();
        return new Promise<FakeTurnResult>((resolve) => {
          resolveTurn = resolve;
        });
      }),
      isTurnActive: vi.fn(() => true),
      interrupt: vi.fn(async () => {
        signalInterruptStarted();
        await interruptReleased;
      }),
      stop: vi.fn(),
    } as unknown as CodexConversationRuntime;
    const runtimes = [verificationRuntime, textRuntime];
    const registry = { stopAll: vi.fn(async () => undefined) } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
      createCodexConversationRuntime: () => {
        const runtime = runtimes.shift();
        if (!runtime) throw new Error("missing-codex-test-runtime");
        return runtime;
      },
    });
    try {
      await service.verify("codex");
      const textSession = await service.openTextSession({ kind: "subscription", provider: "codex" });
      const controller = new AbortController();
      const iterator = textSession.streamTurn("Cancel before output.", controller.signal)[Symbol.asyncIterator]();
      const firstEvent = iterator.next();
      await turnStarted;
      expect(callbacks).toBeDefined();

      controller.abort();
      await interruptStarted;
      callbacks?.onTextDelta?.({ delta: "late text" });
      callbacks?.onReasoningDelta?.({ delta: "late reasoning" });
      releaseInterrupt();
      resolveTurn({ threadId: "thread-1", turnId: "turn-1", status: "interrupted" });

      await expect(firstEvent).rejects.toMatchObject({ code: "subscription-operation-failed" });
      expect(textRuntime.interrupt).toHaveBeenCalled();
    } finally {
      releaseInterrupt();
      await service.stop();
    }
  });

  it("drops late Codex text and reasoning deltas after the bridged tool boundary", async () => {
    type FakeTurnResult = {
      threadId: string;
      turnId: string;
      status: "completed" | "interrupted" | "failed";
    };
    type CallbackProbe = {
      onTextDelta?: (event: { delta: string }) => void;
      onReasoningDelta?: (event: { delta: string }) => void;
    };
    let callbacks: CallbackProbe | undefined;
    let signalTurnStart: (() => void) | undefined;
    const turnStarted = new Promise<void>((resolve) => {
      signalTurnStart = resolve;
    });
    let resolveTurn: ((result: FakeTurnResult) => void) | undefined;
    const verificationRuntime = {
      verifyIsolation: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as CodexConversationRuntime;
    const textRuntime = {
      startTurn: vi.fn((_input: unknown, nextCallbacks: CallbackProbe) => {
        callbacks = nextCallbacks;
        signalTurnStart?.();
        return new Promise<FakeTurnResult>((resolve) => {
          resolveTurn = resolve;
        });
      }),
      isTurnActive: vi.fn(() => true),
      interrupt: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as CodexConversationRuntime;
    const runtimes = [verificationRuntime, textRuntime];
    const registry = { stopAll: vi.fn(async () => undefined) } as unknown as AcpSubscriptionRuntimeRegistry;
    const setHandler = vi.spyOn(SubscriptionToolBridge.prototype, "setHandler");
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
      createCodexConversationRuntime: () => {
        const runtime = runtimes.shift();
        if (!runtime) throw new Error("missing-codex-test-runtime");
        return runtime;
      },
    });

    try {
      const textSession = await service.openTextSession(
        { kind: "subscription", provider: "codex" },
        { tools: [HOST_TOOL] },
      );
      const iterator = textSession.streamTurn("Use the LVIS project tool.")[Symbol.asyncIterator]();
      const firstEvent = iterator.next();
      await turnStarted;

      const bridgeHandler = setHandler.mock.calls.find(([handler]) => typeof handler === "function")?.[0];
      expect(bridgeHandler).toBeTypeOf("function");
      expect(callbacks).toBeDefined();
      expect(resolveTurn).toBeTypeOf("function");
      if (typeof bridgeHandler !== "function" || !callbacks || !resolveTurn) {
        throw new Error("test-bridge-handler-missing");
      }

      bridgeHandler({
        id: "subscription_test_tool",
        name: HOST_TOOL.name,
        input: { path: "README.md" },
      });
      callbacks.onTextDelta?.({ delta: "late text" });
      callbacks.onReasoningDelta?.({ delta: "late reasoning" });
      resolveTurn({ threadId: "thread-1", turnId: "turn-1", status: "interrupted" });

      const events: StreamEvent[] = [];
      const first = await firstEvent;
      const second = await iterator.next();
      if (!first.done) events.push(first.value);
      if (!second.done) events.push(second.value);
      expect(events).toEqual([
        {
          type: "tool_call",
          id: "subscription_test_tool",
          name: HOST_TOOL.name,
          input: { path: "README.md" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ]);
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    } finally {
      await service.stop();
      setHandler.mockRestore();
    }
  });
});
