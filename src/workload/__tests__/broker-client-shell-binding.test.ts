import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ createConnection: vi.fn() }));

vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  createConnection: net.createConnection,
}));

import { sendWorkloadBrokerRequest } from "../broker-client.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import type {
  WorkloadBrokerCapabilityDocument,
  WorkloadBrokerOperation,
  WorkloadOperationPayloads,
} from "../protocol.js";

const HEX = "a".repeat(64);
const BROKER_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const BROKER_REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function capability(): WorkloadBrokerCapabilityDocument {
  return {
    version: "lvis-workload-broker-capability/v1",
    socketPath: "/tmp/lvis-broker-shell-binding-test.sock",
    token: Buffer.alloc(32, 3).toString("base64url"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    workload: {
      id: HEX,
      generation: "shell-binding-test",
      boundaryFingerprint: "b".repeat(64),
      imageDigest: `sha256:${"c".repeat(64)}`,
      cwd: "/workspace",
      home: "/home/agent",
      platform: "linux",
    },
    allowedOperations: ["handshake", "shell.read", "shell.kill"],
    maxRequestBytes: 64 * 1_024,
    maxResponseBytes: 1024 * 1024,
  };
}

type WireRequest = { id: string; operation: string; payload: unknown; correlation?: unknown };
type ResponseFactory = (request: WireRequest) => Buffer;

class ResponseSocket extends EventEmitter {
  constructor(private readonly response: ResponseFactory) {
    super();
    queueMicrotask(() => this.emit("connect"));
  }

  write(encoded: Buffer): boolean {
    const request = JSON.parse(encoded.toString("utf8")) as WireRequest;
    queueMicrotask(() => {
      this.emit("data", this.response(request));
      this.emit("end");
    });
    return true;
  }

  destroy(): this {
    return this;
  }
}

function jsonResponse(result: unknown): ResponseFactory {
  return (request) => Buffer.from(`${JSON.stringify({
    version: "lvis-workload-response/v2",
    id: request.id,
    brokerRequestId: BROKER_REQUEST_ID,
    brokerInstanceId: BROKER_INSTANCE_ID,
    payloadDigest: sha256Hex(canonicalStringify(request.payload)),
    admittedReceiptDigest: "d".repeat(64),
    terminalReceiptDigest: "e".repeat(64),
    correlation: request.correlation,
    correlationDigest: sha256Hex(canonicalStringify({
      brokerInstanceId: BROKER_INSTANCE_ID,
      brokerRequestId: BROKER_REQUEST_ID,
      clientRequestId: request.id,
      correlation: request.correlation,
      operation: request.operation,
      payloadDigest: sha256Hex(canonicalStringify(request.payload)),
      protocol: "lvis-workload-request/v2",
      workload: capability().workload,
    })),
    ok: true,
    result,
  })}\n`, "utf8");
}

function request<K extends Extract<WorkloadBrokerOperation, "shell.read" | "shell.kill">>(
  operation: K,
  payload: WorkloadOperationPayloads[K],
  response: ResponseFactory,
) {
  net.createConnection.mockReturnValueOnce(new ResponseSocket(response));
  const payloadDigest = sha256Hex(canonicalStringify(payload));
  return sendWorkloadBrokerRequest(capability(), operation, payload, undefined, {
    version: "lvis-workload-correlation/v1",
    kind: "background-lifecycle",
    parent: {
      clientRequestId: "33333333-3333-4333-8333-333333333333",
      brokerRequestId: "44444444-4444-4444-8444-444444444444",
      brokerInstanceId: BROKER_INSTANCE_ID,
      correlationDigest: "5".repeat(64),
      payloadDigest: "6".repeat(64),
      admittedReceiptDigest: "7".repeat(64),
      terminalReceiptDigest: "8".repeat(64),
      executionId: "job_1",
    },
    actor: operation === "shell.read"
      ? {
          kind: "tool-invocation", toolUseId: "tool-output", toolName: "bash_output",
          operation: "shell.read",
          grant: { identity: "1".repeat(64), effectDigest: "2".repeat(64), action: "builtin-tool", planIdentity: null },
        }
      : {
          kind: "tool-invocation", toolUseId: "tool-kill", toolName: "bash_kill",
          operation: "shell.kill",
          grant: { identity: "1".repeat(64), effectDigest: "2".repeat(64), action: "builtin-tool", planIdentity: null },
        },
    payloadDigest,
    operation,
  });
}

function runningRead(output: string, offset: number, nextOffset: number) {
  return {
    executionId: "job_1",
    offset,
    nextOffset,
    output,
    isError: false,
    running: true,
    truncated: false,
    status: "running",
  } as const;
}

function killed(output: string, nextOffset: number) {
  return {
    executionId: "job_1",
    nextOffset,
    output,
    isError: false,
    truncated: false,
    status: "exited",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    oomDelta: 0,
    ownedResourcesZero: true,
    receiptDigest: HEX,
  } as const;
}

describe("workload broker shell response binding", () => {
  beforeEach(() => net.createConnection.mockReset());

  it("binds a multibyte read cursor and maxBytes in UTF-8 bytes", async () => {
    const output = "한글🙂";
    const outputBytes = Buffer.byteLength(output, "utf8");

    await expect(request(
      "shell.read",
      { executionId: "job_1", offset: 7, maxBytes: outputBytes, waitMs: 0, waitFor: "output" },
      jsonResponse(runningRead(output, 7, 7 + outputBytes)),
    )).resolves.toMatchObject({ output, nextOffset: 7 + outputBytes });
  });

  it("rejects output whose UTF-8 bytes exceed the requested read window", async () => {
    const output = "한글";
    await expect(request(
      "shell.read",
      { executionId: "job_1", offset: 0, maxBytes: 4, waitMs: 0, waitFor: "output" },
      jsonResponse(runningRead(output, 0, Buffer.byteLength(output, "utf8"))),
    )).rejects.toThrow("workload-broker:response-shell-binding-mismatch");
  });

  it("rejects an empty read that advances the cursor", async () => {
    await expect(request(
      "shell.read",
      { executionId: "job_1", offset: 5, maxBytes: 4, waitMs: 0, waitFor: "output" },
      jsonResponse(runningRead("", 5, 6)),
    )).rejects.toThrow("workload-broker:response-result-invalid");
  });

  it("rejects a response split inside a multibyte UTF-8 scalar before binding", async () => {
    const malformed: ResponseFactory = (request) => Buffer.concat([
      Buffer.from(`{"version":"lvis-workload-response/v2","id":"${request.id}","ok":true,"result":{"output":"`),
      // First three bytes of a four-byte emoji, followed by the JSON quote.
      Buffer.from([0xf0, 0x9f, 0x99]),
      Buffer.from(`","isError":false}}\n`),
    ]);
    await expect(request(
      "shell.read",
      { executionId: "job_1", offset: 0, maxBytes: 4, waitMs: 0, waitFor: "output" },
      malformed,
    )).rejects.toThrow("workload-broker:response-json-invalid");
  });

  it("accepts shell.kill full retained output using a multibyte byte cursor", async () => {
    const output = "종료🙂";
    const outputBytes = Buffer.byteLength(output, "utf8");
    await expect(request(
      "shell.kill",
      { executionId: "job_1", timeoutMs: 1_000 },
      jsonResponse(killed(output, outputBytes)),
    )).resolves.toMatchObject({ output, nextOffset: outputBytes });
  });

  it("rejects shell.kill character-count cursors", async () => {
    const output = "종료🙂";
    await expect(request(
      "shell.kill",
      { executionId: "job_1", timeoutMs: 1_000 },
      jsonResponse(killed(output, output.length)),
    )).rejects.toThrow("workload-broker:response-result-invalid");
  });
});
