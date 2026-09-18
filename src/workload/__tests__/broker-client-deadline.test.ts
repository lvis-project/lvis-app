import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  createConnection: vi.fn(),
}));

vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  createConnection: net.createConnection,
}));

import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { sendWorkloadBrokerRequest } from "../broker-client.js";
import type { WorkloadBrokerCapabilityDocument } from "../protocol.js";

const HEX = "a".repeat(64);
const BROKER_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const BROKER_REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function capability(): WorkloadBrokerCapabilityDocument {
  return {
    version: "lvis-workload-broker-capability/v1",
    socketPath: "/tmp/lvis-broker-deadline-test.sock",
    token: Buffer.alloc(32, 7).toString("base64url"),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    workload: {
      id: HEX,
      generation: "deadline-test",
      boundaryFingerprint: "b".repeat(64),
      imageDigest: `sha256:${"c".repeat(64)}`,
      cwd: "/workspace",
      home: "/home/agent",
      platform: "linux",
    },
    allowedOperations: ["handshake", "file.copy"],
    maxRequestBytes: 64 * 1_024,
    maxResponseBytes: 1024 * 1024,
  };
}

class ControlledSocket extends EventEmitter {
  destroyed = false;

  constructor(private readonly responseDelayMs: number) {
    super();
    queueMicrotask(() => this.emit("connect"));
  }

  write(encoded: Buffer): boolean {
    const request = JSON.parse(encoded.toString("utf8")) as {
      id: string;
      operation: string;
      payload: unknown;
      correlation?: unknown;
    };
    setTimeout(() => {
      if (this.destroyed) return;
      const response = Buffer.from(`${JSON.stringify({
        version: "lvis-workload-response/v2",
        id: request.id,
        brokerRequestId: BROKER_REQUEST_ID,
        brokerInstanceId: BROKER_INSTANCE_ID,
        payloadDigest: sha256Hex(canonicalStringify(request.payload)),
        admittedReceiptDigest: "d".repeat(64),
        terminalReceiptDigest: "e".repeat(64),
        ...(request.correlation === undefined ? {} : {
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
        }),
        ok: true,
        result: request.operation === "handshake"
          ? {
              workload: capability().workload,
              allowedOperations: capability().allowedOperations,
              maxRequestBytes: capability().maxRequestBytes,
              maxResponseBytes: capability().maxResponseBytes,
              expiresAt: capability().expiresAt,
            }
          : { output: "copied", isError: false },
      })}\n`);
      this.emit("data", response);
      this.emit("end");
    }, this.responseDelayMs);
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function copyRequest(timeoutMs: number, responseDelayMs: number, signal?: AbortSignal) {
  const socket = new ControlledSocket(responseDelayMs);
  net.createConnection.mockReturnValueOnce(socket);
  const document = capability();
  const payload = {
    sourcePath: "/workspace/source",
    destinationPath: "/workspace/destination",
    timeoutMs,
  };
  const request = sendWorkloadBrokerRequest(
    document,
    "file.copy",
    payload,
    signal,
    {
      version: "lvis-workload-correlation/v1",
      kind: "tool-invocation",
      toolUseId: "tool-copy",
      toolName: "copy_path",
      grant: {
        identity: "1".repeat(64), effectDigest: "2".repeat(64),
        action: "builtin-tool", planIdentity: null,
      },
      payloadDigest: sha256Hex(canonicalStringify(payload)),
      operation: "file.copy",
    },
  );
  return { request, socket };
}

function handshakeRequest(responseDelayMs: number, signal?: AbortSignal) {
  const socket = new ControlledSocket(responseDelayMs);
  net.createConnection.mockReturnValueOnce(socket);
  const document = capability();
  return sendWorkloadBrokerRequest(
    document,
    "handshake",
    { workload: document.workload },
    signal,
  );
}

describe("workload broker file deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T00:00:00.000Z"));
    net.createConnection.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a broker file operation to finish after 30 seconds but before the host ceiling", async () => {
    const { request } = copyRequest(
      TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
      31_000,
    );

    await vi.advanceTimersByTimeAsync(31_000);

    await expect(request).resolves.toMatchObject({ output: "copied", isError: false });
  });

  it("allows exact Docker identity admission to outlive the broker's 10 second inspect bound", async () => {
    const request = handshakeRequest(10_001);

    await vi.advanceTimersByTimeAsync(10_001);

    await expect(request).resolves.toMatchObject({ workload: capability().workload });
  });

  it("cancels a delayed identity handshake when the shutdown signal fires", async () => {
    const controller = new AbortController();
    const request = handshakeRequest(
      TOOL_TIMEOUT_POLICY.workloadBrokerPreEffectHandshakeMs - 1,
      controller.signal,
    );
    const rejection = expect(request).rejects.toThrow("workload-broker:request-aborted");

    controller.abort(new Error("shutdown deadline elapsed"));

    await rejection;
  });

  it("fails cleanly only after the explicit operation deadline plus receipt grace", async () => {
    const { request, socket } = copyRequest(1, 30_000);
    const rejection = expect(request).rejects.toThrow("workload-broker:request-deadline-exceeded");

    await vi.advanceTimersByTimeAsync(1 + TOOL_TIMEOUT_POLICY.workloadBrokerTransportGraceMs);

    await rejection;
    expect(socket.destroyed).toBe(true);
  });

  it("keeps caller cancellation authoritative before the operation deadline", async () => {
    const controller = new AbortController();
    const { request, socket } = copyRequest(
      TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
      31_000,
      controller.signal,
    );
    const rejection = expect(request).rejects.toThrow("workload-broker:request-aborted");

    controller.abort();

    await rejection;
    expect(socket.destroyed).toBe(true);
  });
});
