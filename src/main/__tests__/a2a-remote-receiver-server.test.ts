import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../../boot.js";
import type { A2ARequestHandler } from "../../api/a2a-router.js";
import {
  A2A_REMOTE_RECEIVER_TASK_FEATURE,
  maybeStartRemoteA2AReceiverServer,
  resetRemoteA2AReceiverServerForTests,
  stopRemoteA2AReceiverServer,
} from "../a2a-remote-receiver-server.js";

const card = Object.freeze({
  name: "receiver",
  description: "receiver",
  version: "1",
  capabilities: {},
  skills: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
});

function handler(): A2ARequestHandler {
  return {
    id: "receiver",
    card,
    handle: vi.fn(),
  };
}

function fixture(
  receiverProfile: boolean,
  receiverPublicOrigin = "https://receiver.lvis.ai/",
) {
  const get = vi.fn((key: string) => key === "features"
    ? { a2aLoopbackServer: false, a2aRemoteReceiver: receiverProfile }
    : key === "a2aRemote"
      ? { receiverPublicOrigin }
      : undefined);
  const getEncryptedSecret = vi.fn(() => "receiver-secret");
  const wrapReceiver = vi.fn((value: A2ARequestHandler) => ({
    ...value,
    handleWire: vi.fn(),
  }));
  const agentActionApprover = vi.fn(async () => null);
  const services = {
    settingsService: { get, getEncryptedSecret },
    a2aRemoteRuntime: receiverProfile ? {
      gates: { outboundRouting: false, receiverProfile: true },
      wrapReceiver,
      agentActionApprover,
    } : undefined,
    conversationLoop: {
      getSessionProjectContext: () => ({ projectRoot: "/workspace/project" }),
      getSessionExecutionCwd: () => "/workspace/fallback",
    },
    approvalGate: undefined,
    agentProfileStore: {},
    getSubAgentRunner: () => undefined,
    auditLogger: { log: vi.fn() },
  } as unknown as AppServices;

  const runtimeDispose = vi.fn(async () => undefined);
  const runtime = {
    router: { handlerIds: ["receiver"] },
    discovery: { protocolVersion: "1.0", agentCardPaths: [] },
    dispose: runtimeDispose,
  };
  let runtimeOptions: Record<string, unknown> | undefined;
  const createRuntime = vi.fn(async (options: Record<string, unknown>) => {
    runtimeOptions = options;
    return runtime;
  });
  const serverClose = vi.fn(async () => undefined);
  let serverOptions: Record<string, unknown> | undefined;
  const startHttpServer = vi.fn(async (options: Record<string, unknown>) => {
    serverOptions = options;
    return { port: 43210, close: serverClose };
  });
  const openNamespace = vi.fn(() => ({
    dir: "/tmp/a2a-remote-receiver-tasks",
    readJson: vi.fn(),
    writeJson: vi.fn(),
    childDir: vi.fn(),
  }));
  return {
    services,
    get,
    getEncryptedSecret,
    wrapReceiver,
    runtimeDispose,
    runtimeOptions: () => runtimeOptions,
    createRuntime,
    serverClose,
    serverOptions: () => serverOptions,
    startHttpServer,
    openNamespace,
    agentActionApprover,
  };
}

afterEach(async () => {
  await stopRemoteA2AReceiverServer();
  resetRemoteA2AReceiverServerForTests();
});

describe("independent remote A2A receiver listener", () => {
  it("has zero secret, namespace, handler, and listener effect while receiver is OFF", async () => {
    const f = fixture(false);
    await expect(maybeStartRemoteA2AReceiverServer({
      services: f.services,
      dependencies: {
        createRuntime: f.createRuntime as never,
        startHttpServer: f.startHttpServer as never,
        openNamespace: f.openNamespace as never,
      },
    })).resolves.toBeNull();

    expect(f.getEncryptedSecret).not.toHaveBeenCalled();
    expect(f.openNamespace).not.toHaveBeenCalled();
    expect(f.createRuntime).not.toHaveBeenCalled();
    expect(f.startHttpServer).not.toHaveBeenCalled();
  });

  it.each([
    ["", "a2a-remote-receiver-public-origin-missing"],
    ["http://receiver.example.test/", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver.example.test/extra", "a2a-remote-receiver-public-origin-invalid"],
    ["https://127.0.0.1/", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver/", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver.lvis.ai./", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver.lvis.ai/?", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver.lvis.ai/#", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver.local/", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver.internal/", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver.home.arpa/", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver.test/", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver.invalid/", "a2a-remote-receiver-public-origin-invalid"],
    ["https://receiver.example/", "a2a-remote-receiver-public-origin-invalid"],
  ])("rejects missing or non-canonical public origin before receiver side effects", async (origin, error) => {
    const f = fixture(true, origin);
    await expect(maybeStartRemoteA2AReceiverServer({
      services: f.services,
      dependencies: {
        createRuntime: f.createRuntime as never,
        startHttpServer: f.startHttpServer as never,
        openNamespace: f.openNamespace as never,
      },
    })).rejects.toThrow(error);
    expect(f.getEncryptedSecret).not.toHaveBeenCalled();
    expect(f.openNamespace).not.toHaveBeenCalled();
    expect(f.createRuntime).not.toHaveBeenCalled();
    expect(f.startHttpServer).not.toHaveBeenCalled();
  });

  it("starts with ph3 OFF on an independent task namespace and A2A-only loopback", async () => {
    const f = fixture(true);
    await expect(maybeStartRemoteA2AReceiverServer({
      services: f.services,
      dependencies: {
        createRuntime: f.createRuntime as never,
        startHttpServer: f.startHttpServer as never,
        openNamespace: f.openNamespace as never,
      },
    })).resolves.toEqual({ port: 43210 });

    expect(f.get("features")).toMatchObject({ a2aLoopbackServer: false });
    expect(f.openNamespace).toHaveBeenCalledWith(A2A_REMOTE_RECEIVER_TASK_FEATURE);
    expect(f.runtimeOptions()).toMatchObject({
      advertisedOrigin: "https://receiver.lvis.ai/",
      wireTrustOrigin: "a2a-remote-wire",
      approvalReason: expect.stringContaining("[A2A Wire: Remote]"),
      auditSessionId: "a2a-remote-wire",
      auditScope: "a2a-remote-wire",
      approveAgentAction: f.agentActionApprover,
    });
    expect(f.serverOptions()).toMatchObject({
      secret: "receiver-secret",
      routeFamilies: { localApi: false, a2a: true },
      host: "127.0.0.1",
      port: 0,
    });
    const transform = f.runtimeOptions()?.transformHandler as
      | ((value: A2ARequestHandler) => A2ARequestHandler)
      | undefined;
    const base = handler();
    expect(transform?.(base)).toMatchObject({ id: "receiver" });
    expect(f.wrapReceiver).toHaveBeenCalledWith(base);
  });

  it("closes the listener before disposing its handler runtime and is idempotent", async () => {
    const order: string[] = [];
    const f = fixture(true);
    f.serverClose.mockImplementation(async () => { order.push("listener"); });
    f.runtimeDispose.mockImplementation(async () => { order.push("handlers"); });
    await maybeStartRemoteA2AReceiverServer({
      services: f.services,
      dependencies: {
        createRuntime: f.createRuntime as never,
        startHttpServer: f.startHttpServer as never,
        openNamespace: f.openNamespace as never,
      },
    });

    await Promise.all([
      stopRemoteA2AReceiverServer(),
      stopRemoteA2AReceiverServer(),
    ]);
    expect(order).toEqual(["listener", "handlers"]);
    expect(f.serverClose).toHaveBeenCalledOnce();
    expect(f.runtimeDispose).toHaveBeenCalledOnce();
  });
});
