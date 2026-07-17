import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import {
  createA2AHttpRouter,
  A2AHandlerError,
  A2AWireResponseError,
  type A2ARequestHandler,
} from "../a2a-router.js";
import {
  startLocalApiHttpServer,
  type LocalApiHttpServer,
} from "../http-server.js";
import { createStreamBroadcaster } from "../stream-broadcaster.js";
import { makeStubLocalApi } from "./a2a-test-helpers.js";
import {
  A2AHostJsonRpcErrorDefinition,
  A2AJsonRpcErrorDefinition,
  A2AJsonRpcMethod,
  StandardJsonRpcErrorDefinition,
  type A2ADirectJsonRpcMethod,
  type A2AJsonObject,
} from "../../shared/a2a-wire.js";
import { A2ARole, A2ATaskState, type A2ATask } from "../../shared/a2a.js";

const SECRET = "a2a-test-secret-0123456789abcdef";
const HANDLER_PATH = "/a2a/tck";

function task(state = A2ATaskState.COMPLETED): A2ATask {
  return {
    id: "task-1",
    contextId: "context-1",
    status: {
      state,
      timestamp: "2026-07-12T00:00:00.000Z",
    },
  };
}

function testHandler(): {
  handler: A2ARequestHandler;
  handle: ReturnType<typeof vi.fn>;
} {
  const handle = vi.fn(
    async (method: A2ADirectJsonRpcMethod, params: A2AJsonObject) => {
      if (method === A2AJsonRpcMethod.SEND_MESSAGE) {
        if (typeof params.message !== "object" || params.message === null) {
          throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
        }
        if ((params.message as A2AJsonObject).messageId === "consent-denied") {
          const error = new A2AHandlerError(
            A2AHostJsonRpcErrorDefinition.OPERATION_REJECTED,
          );
          error.message = "sensitive-consent-handler-detail";
          (error as A2AHandlerError & { metadata?: Record<string, string> }).metadata = {
            leaked: "sensitive-consent-handler-metadata",
          };
          throw error;
        }
        return { task: task() };
      }
      if (method === A2AJsonRpcMethod.GET_TASK) {
        if (params.id === "missing") {
          throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
        }
        if (params.id === "typed-secret") {
          const error = new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
          error.message = "sensitive-typed-handler-detail";
          (error as A2AHandlerError & { metadata?: Record<string, string> }).metadata = {
            leaked: "sensitive-typed-handler-metadata",
          };
          throw error;
        }
        if (params.id === "explode") {
          throw new Error("sensitive-handler-detail");
        }
        return task();
      }
      if (method === A2AJsonRpcMethod.CANCEL_TASK) {
        return task(A2ATaskState.CANCELED);
      }
      return { tasks: [task()], nextPageToken: "", pageSize: 1, totalSize: 1 };
    },
  );

  return {
    handle,
    handler: {
      id: "tck",
      card: {
        name: "TCK fixture",
        description: "Deterministic A2A v1 fixture",
        version: "1.0.0",
        capabilities: {
          streaming: false,
          pushNotifications: false,
          extendedAgentCard: false,
        },
        skills: [
          {
            id: "echo",
            name: "Echo",
            description: "Returns a deterministic task",
            tags: ["test"],
          },
        ],
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        securitySchemes: {
          bearerAuth: {
            httpAuthSecurityScheme: {
              scheme: "Bearer",
              description: "Per-boot loopback capability token",
            },
          },
        },
        securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
      },
      handle,
    },
  };
}

let servers: LocalApiHttpServer[] = [];

async function start(handlerOverride?: A2ARequestHandler): Promise<{
  server: LocalApiHttpServer;
  handle: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}> {
  const { handler, handle } = testHandler();
  const audit = vi.fn();
  const log = vi.fn();
  const server = await startLocalApiHttpServer({
    api: makeStubLocalApi(),
    secret: SECRET,
    broadcaster: createStreamBroadcaster(),
    a2aRouter: createA2AHttpRouter({ handlers: [handlerOverride ?? handler], audit, log }),
    host: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  return { server, handle, audit, log };
}

function url(server: LocalApiHttpServer, path = HANDLER_PATH): string {
  return "http://127.0.0.1:" + String(server.port) + path;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: "Bearer " + SECRET,
    "content-type": "application/json",
    "a2a-version": "1.0",
    ...extra,
  };
}

function rpc(method: string, params: unknown, id: string | number | null = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

afterEach(async () => {
  const toClose = servers;
  servers = [];
  for (const server of toClose) await server.close();
});

describe("A2A v1 loopback router", () => {
  it("serves only the exact Agent Card GET without bearer auth", async () => {
    const { server } = await start();
    const response = await fetch(url(server, HANDLER_PATH + "/.well-known/agent-card.json"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=60");
    expect(response.headers.get("etag")).toBeTruthy();
    expect(response.headers.get("last-modified")).toBeTruthy();
    expect(await response.json()).toMatchObject({
      name: "TCK fixture",
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extendedAgentCard: false,
      },
      supportedInterfaces: [
        {
          url: url(server),
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ],
    });

    const wrongMethod = await fetch(
      url(server, HANDLER_PATH + "/.well-known/agent-card.json"),
      { method: "POST" },
    );
    expect(wrongMethod.status).toBe(401);
  });

  it("keeps every operation and pre-existing route bearer authenticated", async () => {
    const { server, handle } = await start();

    const operation = await fetch(url(server), {
      method: "POST",
      headers: { "content-type": "application/json", "a2a-version": "1.0" },
      body: rpc(A2AJsonRpcMethod.LIST_TASKS, {}),
    });
    expect(operation.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();

    const health = await fetch(url(server, "/v1/health"));
    expect(health.status).toBe(401);
  });

  it("returns 413 and closes an over-cap upload without waiting for its end", async () => {
    const { server, handle } = await start();
    const result = await new Promise<{
      status: number | undefined;
      body: string;
      connection: string | undefined;
    }>((resolve, reject) => {
      let responseEnded = false;
      let requestClosed = false;
      let responseStatus: number | undefined;
      let responseBody = "";
      let responseConnection: string | undefined;
      let receivedResponse = false;
      const timeout = setTimeout(() => {
        request.destroy();
        reject(new Error("oversized A2A request was not terminated"));
      }, 2_000);
      const finish = () => {
        if (!responseEnded || !requestClosed) return;
        clearTimeout(timeout);
        resolve({ status: responseStatus, body: responseBody, connection: responseConnection });
      };
      const request = httpRequest(url(server), {
        method: "POST",
        headers: { ...headers(), "content-length": String(2 * 1024 * 1024) },
      }, (response) => {
        receivedResponse = true;
        responseStatus = response.statusCode;
        responseConnection = response.headers.connection;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { responseBody += chunk; });
        response.on("end", () => {
          responseEnded = true;
          finish();
        });
      });
      request.on("close", () => {
        requestClosed = true;
        finish();
      });
      request.on("error", (error) => {
        if (!receivedResponse) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      request.write(Buffer.alloc(1024 * 1024 + 1, 0x61));
      // Deliberately do not call end(); the server must terminate the upload.
    });

    expect(result).toEqual({
      status: 413,
      body: JSON.stringify({ ok: false, error: "payload-too-large" }),
      connection: "close",
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("preserves a numeric zero request id and delegates direct methods", async () => {
    const { server, handle } = await start();
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(
        A2AJsonRpcMethod.SEND_MESSAGE,
        {
          message: {
            messageId: "message-1",
            role: A2ARole.USER,
            parts: [{ text: "hello" }],
          },
        },
        0,
      ),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("a2a-version")).toBe("1.0");
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: { task: task() },
    });
    expect(handle).toHaveBeenCalledOnce();
  });

  it("accepts a successful wire handler result without optional response headers", async () => {
    const fixture = testHandler();
    const handleWire = vi.fn(async () => ({ result: task() }));
    const { server } = await start({ ...fixture.handler, handleWire });
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(A2AJsonRpcMethod.GET_TASK, { id: "task-1" }, "wire-no-headers"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("a2a-version")).toBe("1.0");
    expect(response.headers.get("a2a-extensions")).toBeNull();
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "wire-no-headers", result: task() });
    expect(handleWire).toHaveBeenCalledOnce();
  });

  it("returns VersionNotSupported with mandatory ErrorInfo", async () => {
    const { server } = await start();
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers({ "a2a-version": "99.0" }),
      body: rpc(A2AJsonRpcMethod.LIST_TASKS, {}, "version-id"),
    });
    const body = (await response.json()) as any;

    expect(body.id).toBe("version-id");
    expect(body.error.code).toBe(-32009);
    expect(body.error.data).toEqual([
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "VERSION_NOT_SUPPORTED",
        domain: "a2a-protocol.org",
        metadata: { supportedVersions: "1.0" },
      },
    ]);
  });

  it("accepts 1.0 patch versions and rejects empty or missing versions", async () => {
    const { server } = await start();

    const patchVersion = await fetch(url(server), {
      method: "POST",
      headers: headers({ "a2a-version": "1.0.17" }),
      body: rpc(A2AJsonRpcMethod.LIST_TASKS, {}),
    });
    expect((await patchVersion.json()) as any).toMatchObject({
      jsonrpc: "2.0",
      result: { pageSize: 1, totalSize: 1 },
    });

    const emptyVersion = await fetch(url(server), {
      method: "POST",
      headers: headers({ "a2a-version": "" }),
      body: rpc(A2AJsonRpcMethod.LIST_TASKS, {}, "empty"),
    });
    expect((await emptyVersion.json()) as any).toMatchObject({
      id: "empty",
      error: { code: -32009 },
    });

    const missingHeaders = headers();
    delete missingHeaders["a2a-version"];
    const missingVersion = await fetch(url(server), {
      method: "POST",
      headers: missingHeaders,
      body: rpc(A2AJsonRpcMethod.LIST_TASKS, {}, "missing"),
    });
    expect((await missingVersion.json()) as any).toMatchObject({
      id: "missing",
      error: { code: -32009 },
    });
  });

  it.each([true, false, {}, []])("rejects an invalid JSON-RPC id %j", async (id) => {
    const { server, handle, audit } = await start();
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: A2AJsonRpcMethod.LIST_TASKS,
        params: {},
      }),
    });

    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
    expect(handle).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      type: "a2a-wire-drop",
      reason: "invalid-request",
      handlerId: "tck",
    });
  });

  it.each([
    [A2AJsonRpcMethod.SEND_STREAMING_MESSAGE, -32004, "UNSUPPORTED_OPERATION"],
    [A2AJsonRpcMethod.SUBSCRIBE_TO_TASK, -32004, "UNSUPPORTED_OPERATION"],
    [A2AJsonRpcMethod.GET_EXTENDED_AGENT_CARD, -32004, "UNSUPPORTED_OPERATION"],
    [
      A2AJsonRpcMethod.CREATE_TASK_PUSH_NOTIFICATION_CONFIG,
      -32003,
      "PUSH_NOTIFICATION_NOT_SUPPORTED",
    ],
    [
      A2AJsonRpcMethod.GET_TASK_PUSH_NOTIFICATION_CONFIG,
      -32003,
      "PUSH_NOTIFICATION_NOT_SUPPORTED",
    ],
    [
      A2AJsonRpcMethod.LIST_TASK_PUSH_NOTIFICATION_CONFIGS,
      -32003,
      "PUSH_NOTIFICATION_NOT_SUPPORTED",
    ],
    [
      A2AJsonRpcMethod.DELETE_TASK_PUSH_NOTIFICATION_CONFIG,
      -32003,
      "PUSH_NOTIFICATION_NOT_SUPPORTED",
    ],
  ])("gates unsupported %s with the exact A2A error", async (method, code, reason) => {
    const { server } = await start();
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(method, {}),
    });
    const body = (await response.json()) as any;

    expect(body.error.code).toBe(code);
    expect(body.error.data[0]).toMatchObject({
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: "a2a-protocol.org",
    });
  });

  it("rejects inline push configuration when push capability is false", async () => {
    const { server, handle } = await start();
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(A2AJsonRpcMethod.SEND_MESSAGE, {
        message: { messageId: "message-2", role: A2ARole.USER, parts: [{ text: "hello" }] },
        configuration: { taskPushNotificationConfig: { url: "https://example.invalid" } },
      }),
    });
    const body = (await response.json()) as any;

    expect(body.error.code).toBe(-32003);
    expect(handle).not.toHaveBeenCalled();
  });

  it("maps content type, parse, method, params, and task errors without leaking throws", async () => {
    const { server } = await start();

    const contentType = await fetch(url(server), {
      method: "POST",
      headers: headers({ "content-type": "text/plain" }),
      body: "not-json",
    });
    expect((await contentType.json() as any).error.code).toBe(-32005);

    const parse = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: "{",
    });
    expect((await parse.json() as any).error.code).toBe(-32700);

    const method = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc("NoSuchMethod", {}),
    });
    const methodBody = (await method.json()) as any;
    expect(methodBody.error.code).toBe(-32601);
    expect(methodBody.error).not.toHaveProperty("data");

    const params = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(A2AJsonRpcMethod.SEND_MESSAGE, {}),
    });
    expect((await params.json() as any).error.code).toBe(-32602);

    const missing = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(A2AJsonRpcMethod.GET_TASK, { id: "missing" }),
    });
    const missingBody = (await missing.json()) as any;
    expect(missingBody.error.code).toBe(-32001);
    expect(missingBody.error.data[0].reason).toBe("TASK_NOT_FOUND");
  });

  it("returns a generic internal error and never logs the thrown message", async () => {
    const { server, log } = await start();
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(A2AJsonRpcMethod.GET_TASK, { id: "explode" }),
    });
    const body = (await response.json()) as any;

    expect(body.error).toEqual({
      code: -32603,
      message: "Internal error",
    });
    expect(JSON.stringify(body)).not.toContain("sensitive-handler-detail");
    expect(log).toHaveBeenCalledWith("A2A handler tck failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-handler-detail");
  });

  it.each([
    ["Content-Type", "text/plain"],
    ["A2A-Version", "0.1"],
  ])("rejects a successful wire handler overriding core header %s", async (headerName, headerValue) => {
    const { handler } = testHandler();
    const { server, audit, log } = await start({
      ...handler,
      handleWire: async () => ({
        result: { task: task() },
        headers: {
          [headerName]: headerValue,
          "a2a-extensions": "https://example.test/extension",
        },
      }),
    });
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(A2AJsonRpcMethod.GET_TASK, { id: "task-1" }),
    });

    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("a2a-version")).toBe("1.0");
    expect(response.headers.get("a2a-extensions")).toBeNull();
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Internal error" },
    });
    expect(audit).toHaveBeenCalledWith({
      type: "a2a-wire-drop",
      reason: "handler-error",
      handlerId: "tck",
      method: A2AJsonRpcMethod.GET_TASK,
    });
    expect(log).toHaveBeenCalledWith("A2A handler tck failed");
  });

  it.each([
    ["Content-Type", "text/plain"],
    ["A2A-Version", "0.1"],
  ])("rejects a wire error overriding core header %s", async (headerName, headerValue) => {
    const { handler } = testHandler();
    const { server, audit, log } = await start({
      ...handler,
      handleWire: async () => {
        throw new A2AWireResponseError(
          422,
          { code: -32099, message: "handler-selected-error" },
          {
            [headerName]: headerValue,
            "a2a-extensions": "https://example.test/extension",
          },
        );
      },
    });
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(A2AJsonRpcMethod.GET_TASK, { id: "task-1" }),
    });

    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("a2a-version")).toBe("1.0");
    expect(response.headers.get("a2a-extensions")).toBeNull();
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Internal error" },
    });
    expect(audit).toHaveBeenCalledWith({
      type: "a2a-wire-drop",
      reason: "handler-error",
      handlerId: "tck",
      method: A2AJsonRpcMethod.GET_TASK,
    });
    expect(log).toHaveBeenCalledWith("A2A handler tck failed");
  });

  it("exposes only definition-owned handler errors", async () => {
    const { server } = await start();
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(A2AJsonRpcMethod.GET_TASK, { id: "typed-secret" }),
    });
    const body = (await response.json()) as any;

    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe("Task not found");
    expect(body.error.data[0]).toEqual({
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "TASK_NOT_FOUND",
      domain: "a2a-protocol.org",
    });
    expect(JSON.stringify(body)).not.toContain("sensitive-typed-handler");
  });

  it("uses the host ErrorInfo domain for an exact consent rejection", async () => {
    const { server } = await start();
    const response = await fetch(url(server), {
      method: "POST",
      headers: headers(),
      body: rpc(
        A2AJsonRpcMethod.SEND_MESSAGE,
        { message: { messageId: "consent-denied" } },
        "consent-id",
      ),
    });

    const body = await response.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: "consent-id",
      error: {
        code: -32010,
        message: "Operation rejected",
        data: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "OPERATION_REJECTED",
          domain: "lvis-project.github.io",
        }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("sensitive-consent-handler");
  });

  it("fails closed and audits an unknown handler without exposing registered cards", async () => {
    const { server, audit } = await start();
    const response = await fetch(
      url(server, "/a2a/unknown/.well-known/agent-card.json"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: "a2a-handler-not-found",
    });
    expect(audit).toHaveBeenCalledWith({
      type: "a2a-wire-drop",
      reason: "unknown-handler",
      handlerId: "unknown",
    });
  });
});

describe("A2A handler registration", () => {
  it("exposes a sorted immutable handler-id snapshot for local discovery", () => {
    const { handler } = testHandler();
    const router = createA2AHttpRouter({
      handlers: [{ ...handler, id: "zeta" }, { ...handler, id: "alpha" }],
    });

    expect(router.handlerIds).toEqual(["alpha", "zeta"]);
    expect(Object.isFrozen(router.handlerIds)).toBe(true);
  });

  it("rejects unsafe ids, duplicates, and capabilities the router cannot serve", () => {
    const { handler } = testHandler();
    expect(() =>
      createA2AHttpRouter({ handlers: [{ ...handler, id: "../unsafe" }] }),
    ).toThrow(/invalid A2A handler id/);
    expect(() => createA2AHttpRouter({ handlers: [handler, handler] })).toThrow(
      /duplicate A2A handler id/,
    );
    expect(() =>
      createA2AHttpRouter({
        handlers: [
          {
            ...handler,
            card: {
              ...handler.card,
              capabilities: { ...handler.card.capabilities, streaming: true },
            },
          },
        ],
      }),
    ).toThrow(/unsupported wire capability/);
  });
});
