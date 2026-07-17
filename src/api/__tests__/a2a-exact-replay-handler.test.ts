import { describe, expect, it, vi } from "vitest";
import {
  A2AJsonRpcErrorDefinition,
  A2AJsonRpcMethod,
  type A2AJsonRpcRequest,
} from "../../shared/a2a-wire.js";
import { A2AExactReplayHandler } from "../a2a-exact-replay-handler.js";
import { A2AExactReplayStore } from "../a2a-exact-replay-store.js";
import { A2A_EXACT_SEND_REPLAY_URI } from "../a2a-remote-contracts.js";
import {
  A2AWireResponseError,
  type A2ARequestHandler,
  type A2AWireRequestContext,
} from "../a2a-router.js";

const digest = "a".repeat(64);

function fixture() {
  let disk: unknown;
  const handle = vi.fn(async () => ({
    task: {
      id: "task-1",
      contextId: "context-1",
      status: { state: "TASK_STATE_COMPLETED" },
    },
  }));
  const base: A2ARequestHandler = {
    id: "receiver",
    card: {
      name: "receiver",
      description: "receiver",
      version: "1",
      capabilities: {},
      skills: [],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
    },
    handle,
  };
  const store = new A2AExactReplayStore({
    namespace: {
      readJson: async <T>(_name: string, fallback: T) => structuredClone((disk ?? fallback) as T),
      writeJson: async (_name: string, value: unknown) => { disk = structuredClone(value); },
    },
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    maxKeysPerGeneration: 4,
    random: (size) => Buffer.alloc(size, 2),
  });
  return {
    handle,
    handler: new A2AExactReplayHandler({
      enabled: true,
      handler: base,
      store,
      authenticator: {
        authenticate: async (authorization) => authorization === "Bearer receiver-secret"
          ? { callerGenerationId: "caller-generation" }
          : null,
      },
      specificationDigestSha256: digest,
    }),
  };
}

function getTaskRequest(): A2AJsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: A2AJsonRpcMethod.GET_TASK,
    params: { id: "task-1", historyLength: 0 },
  };
}

function sendRequest(metadata: Record<string, unknown> = {}): A2AJsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 2,
    method: A2AJsonRpcMethod.SEND_MESSAGE,
    params: {
      message: { messageId: "message-1", role: "ROLE_USER", parts: [{ text: "hello" }] },
      metadata,
    },
  };
}

function context(
  request: A2AJsonRpcRequest,
  extensions?: A2AWireRequestContext["extensions"],
  authorization = "Bearer receiver-secret",
): A2AWireRequestContext {
  return {
    authorization,
    ...(extensions === undefined ? {} : { extensions }),
    rawBody: Buffer.from(JSON.stringify(request)),
  };
}

async function expectExtensionRequired(promise: Promise<unknown>): Promise<void> {
  const error = await promise.catch((value) => value) as A2AWireResponseError;
  expect(error).toBeInstanceOf(A2AWireResponseError);
  expect(error.error).toMatchObject({
    code: A2AJsonRpcErrorDefinition.EXTENSION_SUPPORT_REQUIRED.code,
    message: A2AJsonRpcErrorDefinition.EXTENSION_SUPPORT_REQUIRED.message,
  });
}

describe("exact replay extension negotiation", () => {
  it("ignores unrelated optional extensions and forwards the base operation", async () => {
    const { handler, handle } = fixture();
    const request = getTaskRequest();
    await expect(handler.handleWire(
      request,
      context(request, "https://example.test/a2a/optional"),
    )).resolves.toMatchObject({ result: { task: { id: "task-1" } } });
    expect(handle).toHaveBeenCalledOnce();
  });

  it.each([
    ["exact token declared required", `${A2A_EXACT_SEND_REPLAY_URI};required`],
    ["duplicate field array", [A2A_EXACT_SEND_REPLAY_URI, A2A_EXACT_SEND_REPLAY_URI]],
    ["duplicate comma entry", `${A2A_EXACT_SEND_REPLAY_URI},${A2A_EXACT_SEND_REPLAY_URI}`],
    ["malformed token", "not-a-uri"],
    ["unreviewed URN", "urn:uuid:00000000-0000-4000-8000-000000000000"],
    ["unknown required token", "https://example.test/a2a/unknown;required"],
  ])("rejects %s without invoking the base handler", async (_label, extensions) => {
    const { handler, handle } = fixture();
    const request = getTaskRequest();
    await expectExtensionRequired(handler.handleWire(request, context(request, extensions)));
    expect(handle).not.toHaveBeenCalled();
  });

  it("requires exact header and metadata activation to match", async () => {
    const { handler, handle } = fixture();
    const metadataOnly = sendRequest({
      [A2A_EXACT_SEND_REPLAY_URI]: { intentSha256: digest },
    });
    await expectExtensionRequired(handler.handleWire(metadataOnly, context(metadataOnly)));

    const headerOnly = sendRequest();
    await expectExtensionRequired(handler.handleWire(
      headerOnly,
      context(headerOnly, A2A_EXACT_SEND_REPLAY_URI),
    ));
    expect(handle).not.toHaveBeenCalled();
  });

  it("authenticates before parsing malformed extension fields", async () => {
    const { handler, handle } = fixture();
    const request = getTaskRequest();
    const error = await handler.handleWire(
      request,
      context(request, ["malformed", "malformed"], "Bearer wrong"),
    ).catch((value) => value) as A2AWireResponseError;
    expect(error).toBeInstanceOf(A2AWireResponseError);
    expect(error.status).toBe(401);
    expect(error.headers).toEqual({ "WWW-Authenticate": "Bearer" });
    expect(handle).not.toHaveBeenCalled();
  });
});
