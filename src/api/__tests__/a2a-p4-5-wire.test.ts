import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { A2AExactReplayHandler } from "../a2a-exact-replay-handler.js";
import type { A2AReplayBeginResult } from "../a2a-exact-replay-store.js";
import { A2A_EXACT_SEND_REPLAY_URI } from "../a2a-remote-contracts.js";
import { createA2AHttpRouter, type A2ARequestHandler } from "../a2a-router.js";
import { startLocalApiHttpServer, type LocalApiHttpServer } from "../http-server.js";
import { createStreamBroadcaster } from "../stream-broadcaster.js";
import { makeStubLocalApi } from "./a2a-test-helpers.js";
import {
  A2AJsonRpcErrorDefinition,
  A2AJsonRpcMethod,
  type A2ADirectJsonRpcMethod,
  type A2AJsonObject,
  type A2AJsonRpcId,
  type A2ASendMessageResult,
} from "../../shared/a2a-wire.js";
import { A2ARole, A2ATaskState } from "../../shared/a2a.js";

const SECRET = "p4-5-wire-receiver-secret";
const PUBLIC_ORIGIN = "https://receiver-a2a-383a1d70.com/";
const HANDLER_URL = `${PUBLIC_ORIGIN}a2a/receiver`;
const INTENT_DIGEST = "b".repeat(64);
const SPEC_DIGEST = createHash("sha256")
  .update(readFileSync(resolve(process.cwd(), "docs/protocols/lvis-a2a-exact-send-replay.md")))
  .digest("hex");

const vectorIds: string[] = [];
function vector(id: string, run: () => Promise<void> | void): void {
  vectorIds.push(id);
  it(id, run);
}

function task(state = A2ATaskState.COMPLETED) {
  return {
    id: "remote-task-1",
    contextId: "remote-context-1",
    status: { state, timestamp: "2026-07-16T00:00:00.000Z" },
  };
}

class FixedWireReplayStore {
  private readonly completed = new Map<string, A2ASendMessageResult>();
  private readonly owners = new Map<string, string>();

  async begin(input: Readonly<{ messageId: string; bodySha256: string; intentSha256: string }>): Promise<A2AReplayBeginResult> {
    const fixed = new Map<string, A2AReplayBeginResult["kind"]>([
      ["error-conflict", "conflict"],
      ["error-expired", "retention-expired"],
      ["error-progress", "in-progress"],
      ["error-unknown", "outcome-unknown"],
      ["error-capacity", "capacity-exhausted"],
    ]).get(input.messageId);
    if (fixed !== undefined) return { kind: fixed } as A2AReplayBeginResult;
    const key = `${input.messageId}:${input.bodySha256}:${input.intentSha256}`;
    const prior = this.completed.get(key);
    if (prior !== undefined) return { kind: "completed", result: structuredClone(prior) };
    const ownerToken = `owner-${this.owners.size + 1}`;
    this.owners.set(ownerToken, key);
    return { kind: "owner", ownerToken };
  }

  async complete(ownerToken: string, result: A2ASendMessageResult): Promise<boolean> {
    const key = this.owners.get(ownerToken);
    if (key === undefined) return false;
    this.completed.set(key, structuredClone(result));
    this.owners.delete(ownerToken);
    return true;
  }

  async markOutcomeUnknown(): Promise<boolean> {
    return true;
  }
}

const handle = vi.fn(async (method: A2ADirectJsonRpcMethod, params: A2AJsonObject) => {
  if (method === A2AJsonRpcMethod.SEND_MESSAGE) {
    const message = params.message as A2AJsonObject | undefined;
    if (message?.messageId === "message-branch") {
      return {
        message: {
          messageId: "remote-message-1",
          contextId: "remote-context-1",
          role: A2ARole.AGENT,
          parts: [{ text: "completed" }],
        },
      };
    }
    return { task: task() };
  }
  if (method === A2AJsonRpcMethod.GET_TASK) return task();
  if (method === A2AJsonRpcMethod.CANCEL_TASK) return task(A2ATaskState.CANCELED);
  return { tasks: [task()], nextPageToken: "", pageSize: 1, totalSize: 1 };
});

const baseHandler: A2ARequestHandler = {
  id: "receiver",
  card: {
    name: "P4-5 receiver",
    description: "Production-router P4-5 wire fixture",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    skills: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
  },
  handle,
};

let server: LocalApiHttpServer;
let localUrl: string;
let agentCardDigestSha256 = "";

function headers(extensions?: string): Record<string, string> {
  return {
    authorization: `Bearer ${SECRET}`,
    "content-type": "application/json",
    "a2a-version": "1.0",
    ...(extensions === undefined ? {} : { "a2a-extensions": extensions }),
  };
}

function rpc(id: A2AJsonRpcId, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function initialParams(messageId: string): A2AJsonObject {
  return {
    message: { messageId, role: A2ARole.USER, parts: [{ text: "hello" }] },
    metadata: { [A2A_EXACT_SEND_REPLAY_URI]: { intentSha256: INTENT_DIGEST } },
  };
}

async function post(body: string, extensions?: string): Promise<Response> {
  return await fetch(localUrl, { method: "POST", headers: headers(extensions), body });
}

beforeAll(async () => {
  const handler = new A2AExactReplayHandler({
    enabled: true,
    handler: baseHandler,
    store: new FixedWireReplayStore() as never,
    authenticator: {
      authenticate: async (authorization) => authorization === `Bearer ${SECRET}`
        ? { callerGenerationId: "wire-caller-generation" }
        : null,
    },
    specificationDigestSha256: SPEC_DIGEST,
  });
  server = await startLocalApiHttpServer({
    api: makeStubLocalApi(),
    secret: SECRET,
    broadcaster: createStreamBroadcaster(),
    a2aRouter: createA2AHttpRouter({ handlers: [handler], advertisedOrigin: PUBLIC_ORIGIN }),
    host: "127.0.0.1",
    port: 0,
  });
  localUrl = `http://127.0.0.1:${server.port}/a2a/receiver`;
});

afterAll(async () => {
  await server.close();
  const output = process.env.A2A_P4_5_VECTOR_REPORT;
  if (output) {
    writeFileSync(output, JSON.stringify({
      schema_version: "lvis-a2a-p4-5-wire-vectors/v1",
      vector_ids: vectorIds,
      vector_count: vectorIds.length,
      agent_card_digest_sha256: agentCardDigestSha256,
      extension_spec_digest_sha256: SPEC_DIGEST,
      verification_state: "passed",
    }));
  }
});

describe("P4-5 production wire vectors", () => {
  vector("agent-card-exact-interface-and-optional-extension", async () => {
    const response = await fetch(`${localUrl}/.well-known/agent-card.json`);
    const bytes = Buffer.from(await response.arrayBuffer());
    agentCardDigestSha256 = createHash("sha256").update(bytes).digest("hex");
    const card = JSON.parse(bytes.toString("utf8"));
    expect(response.status).toBe(200);
    expect(card.supportedInterfaces).toEqual([{
      url: HANDLER_URL,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    }]);
    expect(card.capabilities.extensions).toContainEqual({
      uri: A2A_EXACT_SEND_REPLAY_URI,
      description: expect.any(String),
      required: false,
      params: {
        profile: "lvis-exact-send-replay",
        profileVersion: "1",
        requestBody: "exact-serialized-jsonrpc",
        resultRetentionSeconds: "604800",
        specDigestSha256: SPEC_DIGEST,
      },
    });
  });

  vector("task-oneof-and-numeric-zero-id", async () => {
    const body = rpc(0, A2AJsonRpcMethod.SEND_MESSAGE, initialParams("task-branch"));
    const response = await post(body, A2A_EXACT_SEND_REPLAY_URI);
    expect(response.headers.get("a2a-version")).toBe("1.0");
    expect(response.headers.get("a2a-extensions")).toBe(A2A_EXACT_SEND_REPLAY_URI);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 0, result: { task: task() } });
  });

  vector("message-oneof-and-string-id", async () => {
    const body = rpc("message-id", A2AJsonRpcMethod.SEND_MESSAGE, initialParams("message-branch"));
    const response = await post(body, A2A_EXACT_SEND_REPLAY_URI);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "message-id",
      result: {
        message: {
          messageId: "remote-message-1",
          contextId: "remote-context-1",
          role: A2ARole.AGENT,
          parts: [{ text: "completed" }],
        },
      },
    });
  });

  vector("exact-byte-replay-executes-once", async () => {
    handle.mockClear();
    const body = rpc("replay-id", A2AJsonRpcMethod.SEND_MESSAGE, initialParams("replay-once"));
    const first = await post(body, A2A_EXACT_SEND_REPLAY_URI);
    const second = await post(body, A2A_EXACT_SEND_REPLAY_URI);
    expect(await second.json()).toEqual(await first.json());
    expect(handle).toHaveBeenCalledOnce();
  });

  for (const [messageId, code, reason] of [
    ["error-conflict", -32090, "EXACT_SEND_REPLAY_CONFLICT"],
    ["error-expired", -32091, "EXACT_SEND_REPLAY_RETENTION_EXPIRED"],
    ["error-progress", -32092, "EXACT_SEND_REPLAY_IN_PROGRESS"],
    ["error-unknown", -32093, "EXACT_SEND_REPLAY_OUTCOME_UNKNOWN"],
    ["error-capacity", -32094, "EXACT_SEND_REPLAY_CAPACITY_EXHAUSTED"],
  ] as const) {
    vector(`exact-error-${code}`, async () => {
      const id = `id-${code}`;
      const response = await post(
        rpc(id, A2AJsonRpcMethod.SEND_MESSAGE, initialParams(messageId)),
        A2A_EXACT_SEND_REPLAY_URI,
      );
      const body = await response.json() as any;
      expect(response.headers.get("a2a-version")).toBe("1.0");
      expect(response.headers.get("a2a-extensions")).toBe(A2A_EXACT_SEND_REPLAY_URI);
      expect(response.headers.get("retry-after")).toBe(code === -32092 ? "1" : null);
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id,
        error: {
          code,
          data: [{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason,
            domain: A2A_EXACT_SEND_REPLAY_URI,
          }],
        },
      });
      if (code === -32092) {
        expect(body.error.data[0].metadata).toEqual({ retryAfterSeconds: "1" });
      } else {
        expect(body.error.data[0]).not.toHaveProperty("metadata");
      }
    });
  }

  vector("header-only-activation-fails-closed", async () => {
    const response = await post(
      rpc("header-only", A2AJsonRpcMethod.SEND_MESSAGE, {
        message: { messageId: "header-only", role: A2ARole.USER, parts: [{ text: "hello" }] },
      }),
      A2A_EXACT_SEND_REPLAY_URI,
    );
    expect((await response.json() as any).error.code).toBe(A2AJsonRpcErrorDefinition.EXTENSION_SUPPORT_REQUIRED.code);
  });

  vector("metadata-only-activation-fails-closed", async () => {
    const response = await post(rpc("metadata-only", A2AJsonRpcMethod.SEND_MESSAGE, initialParams("metadata-only")));
    expect((await response.json() as any).error.code).toBe(A2AJsonRpcErrorDefinition.EXTENSION_SUPPORT_REQUIRED.code);
  });

  vector("advertised-optional-extension-cannot-be-declared-required", async () => {
    const response = await post(
      rpc("exact-required", A2AJsonRpcMethod.GET_TASK, { id: "remote-task-1" }),
      `${A2A_EXACT_SEND_REPLAY_URI};required`,
    );
    expect((await response.json() as any).error.code).toBe(A2AJsonRpcErrorDefinition.EXTENSION_SUPPORT_REQUIRED.code);
  });

  vector("unrelated-required-extension-fails-closed", async () => {
    const response = await post(
      rpc("unknown-required", A2AJsonRpcMethod.GET_TASK, { id: "remote-task-1" }),
      "https://example.test/a2a/required;required",
    );
    expect((await response.json() as any).error.code).toBe(A2AJsonRpcErrorDefinition.EXTENSION_SUPPORT_REQUIRED.code);
  });

  vector("unrelated-optional-extension-is-ignored", async () => {
    const response = await post(
      rpc("optional-id", A2AJsonRpcMethod.GET_TASK, { id: "remote-task-1", historyLength: 0 }),
      "https://example.test/a2a/optional",
    );
    expect(response.headers.get("a2a-version")).toBe("1.0");
    expect(response.headers.get("a2a-extensions")).toBeNull();
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "optional-id", result: task() });
  });

  vector("continuation-does-not-activate-exact-replay", async () => {
    const continuation = {
      message: {
        messageId: "continuation-message",
        taskId: "remote-task-1",
        contextId: "remote-context-1",
        role: A2ARole.USER,
        parts: [{ text: "continue" }],
      },
    };
    const rejected = await post(
      rpc("continuation-rejected", A2AJsonRpcMethod.SEND_MESSAGE, continuation),
      A2A_EXACT_SEND_REPLAY_URI,
    );
    expect((await rejected.json() as any).error.code).toBe(A2AJsonRpcErrorDefinition.EXTENSION_SUPPORT_REQUIRED.code);
    const accepted = await post(rpc("continuation-ok", A2AJsonRpcMethod.SEND_MESSAGE, continuation));
    expect(accepted.headers.get("a2a-version")).toBe("1.0");
    expect(accepted.headers.get("a2a-extensions")).toBeNull();
    expect((await accepted.json() as any).id).toBe("continuation-ok");
  });

  vector("version-header-covers-get-cancel-and-list-without-activation", async () => {
    for (const [id, method, params] of [
      ["get-id", A2AJsonRpcMethod.GET_TASK, { id: "remote-task-1", historyLength: 0 }],
      ["cancel-id", A2AJsonRpcMethod.CANCEL_TASK, { id: "remote-task-1" }],
      ["list-id", A2AJsonRpcMethod.LIST_TASKS, {}],
    ] as const) {
      const response = await post(rpc(id, method, params));
      expect(response.headers.get("a2a-version")).toBe("1.0");
      expect(response.headers.get("a2a-extensions")).toBeNull();
      expect((await response.json() as any).id).toBe(id);
    }
  });

  vector("exact-extension-is-rejected-on-get-task", async () => {
    const response = await post(
      rpc("get-exact", A2AJsonRpcMethod.GET_TASK, { id: "remote-task-1", historyLength: 0 }),
      A2A_EXACT_SEND_REPLAY_URI,
    );
    expect(response.headers.get("a2a-version")).toBe("1.0");
    expect(response.headers.get("a2a-extensions")).toBeNull();
    expect((await response.json() as any).error.code).toBe(A2AJsonRpcErrorDefinition.EXTENSION_SUPPORT_REQUIRED.code);
  });

  vector("authentication-precedes-extension-negotiation", async () => {
    const response = await fetch(localUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong",
        "content-type": "application/json",
        "a2a-version": "1.0",
        "a2a-extensions": "not-a-uri",
      },
      body: rpc("auth-first", A2AJsonRpcMethod.GET_TASK, { id: "remote-task-1" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("a2a-extensions")).toBeNull();
  });
});
