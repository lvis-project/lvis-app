import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalApiHttpServer, type LocalApiHttpServer } from "../../api/http-server.js";
import { createStreamBroadcaster } from "../../api/stream-broadcaster.js";
import {
  A2ASubAgentHandler,
  type A2ASubAgentLifecycleRunner,
} from "../../api/a2a-subagent-handler.js";
import { createInMemoryFeatureNamespace } from "../../__tests__/test-helpers.js";
import { makeStubLocalApi } from "../../api/__tests__/a2a-test-helpers.js";
import { A2AJsonRpcMethod } from "../../shared/a2a-wire.js";
import { A2ARole } from "../../shared/a2a.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import type { LoadedAgentProfile } from "../agent-profile-store.js";
import {
  createA2ALoopbackRuntime,
  deriveA2ALoopbackHandlerId,
  type CreateA2ALoopbackRuntimeOptions,
} from "../a2a-loopback-runtime.js";

const SECRET = "runtime-test-secret-0123456789abcdef";
const PROJECT = { root: "C:/workspace/project", name: "private-project-marker" };

function profile(name: string, filePath: string): LoadedAgentProfile {
  return {
    name,
    description: name === "alpha" ? "Contact owner@example.com" : "Safe profile description",
    sourceTools: ["private-tool-marker"],
    triggers: ["private-trigger-marker"],
    model: "private-model-marker",
    mode: "plan",
    body: `private-body-marker-${name}`,
    filePath,
  };
}

function makeRunner(): A2ASubAgentLifecycleRunner {
  return {
    spawnFromA2AWire: vi.fn(),
    resumeFromA2AWire: vi.fn(),
    getA2AWireRunSnapshot: vi.fn(() => null),
    cancelA2AWireRun: vi.fn(),
  };
}

function makeOptions(
  profiles: LoadedAgentProfile[],
  overrides: Partial<CreateA2ALoopbackRuntimeOptions> = {},
): CreateA2ALoopbackRuntimeOptions {
  const runner = makeRunner();
  return {
    services: {
      agentProfileStore: { list: vi.fn(async () => profiles) } as never,
      getSubAgentRunner: () => runner as never,
      auditLogger: { log: vi.fn() } as never,
    },
    project: PROJECT,
    appVersion: "1.2.3",
    approveAgentAction: undefined,
    namespace: createInMemoryFeatureNamespace().handle,
    ...overrides,
  };
}

let servers: LocalApiHttpServer[] = [];

afterEach(async () => {
  const current = servers;
  servers = [];
  for (const server of current) await server.close();
});

describe("A2A production loopback runtime", () => {
  it("derives a DLP-safe opaque stable Windows address from source identity", async () => {
    const first = deriveA2ALoopbackHandlerId("C:\\Profiles\\Reviewer.md", "win32");
    const same = deriveA2ALoopbackHandlerId("c:/profiles/reviewer.md", "win32");

    expect(first).toBe(same);
    expect(first).toMatch(/^agent-[abcdefghjkmnpqrs]{32}$/);
    expect(first).not.toContain("reviewer");

    const priorFalsePositive = deriveA2ALoopbackHandlerId(
      "C:/profiles/p178.md",
      "win32",
    );
    expect(maskSensitiveData(priorFalsePositive).detections).toEqual([]);
    await expect(createA2ALoopbackRuntime(makeOptions([
      profile("p178", "C:/profiles/p178.md"),
    ]))).resolves.not.toBeNull();
  });

  it("returns null only when no profile is available and rejects a missing runner", async () => {
    await expect(createA2ALoopbackRuntime(makeOptions([]))).resolves.toBeNull();
    const options = makeOptions([profile("alpha", "C:/profiles/alpha.md")]);
    options.services.getSubAgentRunner = () => undefined;
    await expect(createA2ALoopbackRuntime(options)).rejects.toThrow("a2a-runtime-unavailable");
  });

  it("fails the whole route-family snapshot on an id collision", async () => {
    const options = makeOptions([
      profile("alpha", "C:/profiles/alpha.md"),
      profile("zeta", "C:/profiles/zeta.md"),
    ], {
      deriveHandlerId: () => "agent-00000000000000000000000000000000",
    });

    await expect(createA2ALoopbackRuntime(options)).rejects.toThrow(
      "a2a-handler-id-collision",
    );
  });

  it("publishes sorted minimal cards and no host-private profile or project fields", async () => {
    const profiles = [
      profile("zeta", "C:/profiles/zeta.md"),
      profile("alpha", "C:/profiles/alpha.md"),
    ];
    const runtime = await createA2ALoopbackRuntime(makeOptions(profiles));
    expect(runtime).not.toBeNull();
    const expectedIds = profiles
      .map((item) => deriveA2ALoopbackHandlerId(item.filePath))
      .sort();
    expect(runtime!.router.handlerIds).toEqual(expectedIds);
    expect(runtime!.discovery.agentCardPaths).toEqual(
      expectedIds.map((id) => `/a2a/${id}/.well-known/agent-card.json`),
    );

    const server = await startLocalApiHttpServer({
      api: makeStubLocalApi(),
      secret: SECRET,
      broadcaster: createStreamBroadcaster(),
      a2aRouter: runtime!.router,
      routeFamilies: { localApi: false, a2a: true },
      host: "127.0.0.1",
      port: 0,
    });
    servers.push(server);
    const alphaId = deriveA2ALoopbackHandlerId("C:/profiles/alpha.md");
    const response = await fetch(
      `http://127.0.0.1:${server.port}/a2a/${alphaId}/.well-known/agent-card.json`,
    );
    expect(response.status).toBe(200);
    const card = await response.json() as Record<string, unknown>;
    expect(card).toMatchObject({
      name: "alpha",
      description: "Host-managed local sub-agent profile.",
      version: "1.2.3",
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extendedAgentCard: false,
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
    });
    const wire = JSON.stringify(card);
    for (const privateMarker of [
      "private-body-marker",
      "private-tool-marker",
      "private-trigger-marker",
      "private-model-marker",
      "private-project-marker",
      "C:/profiles",
      "owner@example.com",
    ]) {
      expect(wire).not.toContain(privateMarker);
    }
  });

  it("keeps mutations fail-closed when no ApprovalGate coordinator exists", async () => {
    const runner = makeRunner();
    const options = makeOptions([profile("alpha", "C:/profiles/alpha.md")], {
      services: {
        agentProfileStore: {
          list: vi.fn(async () => [profile("alpha", "C:/profiles/alpha.md")]),
        } as never,
        getSubAgentRunner: () => runner as never,
        auditLogger: { log: vi.fn() } as never,
      },
    });
    const runtime = await createA2ALoopbackRuntime(options);
    const handlerId = runtime!.router.handlerIds[0]!;
    const server = await startLocalApiHttpServer({
      api: makeStubLocalApi(),
      secret: SECRET,
      broadcaster: createStreamBroadcaster(),
      a2aRouter: runtime!.router,
      routeFamilies: { localApi: false, a2a: true },
      host: "127.0.0.1",
      port: 0,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/a2a/${handlerId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
        "a2a-version": "1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: A2AJsonRpcMethod.SEND_MESSAGE,
        params: {
          message: {
            messageId: "message-no-gate",
            role: A2ARole.USER,
            parts: [{ text: "hello" }],
          },
        },
      }),
    });
    expect(await response.json()).toMatchObject({
      error: { code: -32010, message: "Operation rejected" },
    });
    expect(runner.spawnFromA2AWire).not.toHaveBeenCalled();
  });

  it("starts and disposes one expiry lifecycle per immutable handler", async () => {
    const start = vi.spyOn(
      A2ASubAgentHandler.prototype,
      "startInputRequiredExpiry",
    ).mockResolvedValue(undefined);
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const dispose = vi.spyOn(
      A2ASubAgentHandler.prototype,
      "dispose",
    ).mockImplementation(async () => await disposeGate);
    try {
      const runtime = await createA2ALoopbackRuntime(makeOptions([
        profile("alpha", "C:/profiles/alpha.md"),
        profile("zeta", "C:/profiles/zeta.md"),
      ]));
      expect(start).toHaveBeenCalledTimes(2);

      let secondSettled = false;
      const first = runtime!.dispose();
      const second = runtime!.dispose().then(() => {
        secondSettled = true;
      });
      await Promise.resolve();
      expect(dispose).toHaveBeenCalledTimes(2);
      expect(secondSettled).toBe(false);
      releaseDispose();
      await Promise.all([first, second]);
      expect(secondSettled).toBe(true);
    } finally {
      start.mockRestore();
      dispose.mockRestore();
    }
  });
});
