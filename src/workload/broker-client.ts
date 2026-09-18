import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { parseStrictJson } from "../shared/strict-json.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  WORKLOAD_BROKER_LIMITS,
  WORKLOAD_BROKER_REQUEST_VERSION,
  WorkloadBrokerResponseSchema,
  WorkloadOperationPayloadSchemas,
  parseWorkloadBrokerSuccessResult,
  type WorkloadBrokerCapabilityDocument,
  type WorkloadBrokerCorrelation,
  type WorkloadBrokerOperation,
  type WorkloadBrokerSuccessResults,
  type WorkloadOperationPayloads,
} from "./protocol.js";

export interface WorkloadBrokerResponseReceipt {
  readonly clientRequestId: string;
  readonly brokerRequestId: string;
  readonly brokerInstanceId: string;
  readonly payloadDigest: string;
  readonly admittedReceiptDigest: string;
  readonly terminalReceiptDigest: string;
  readonly correlationDigest: string;
  readonly correlation: WorkloadBrokerCorrelation;
}

const responseReceipts = new WeakMap<object, WorkloadBrokerResponseReceipt>();
const issuedResponseReceipts = new WeakSet<WorkloadBrokerResponseReceipt>();
const brokerInstances = new WeakMap<WorkloadBrokerCapabilityDocument, string>();

export function getWorkloadBrokerResponseReceipt(
  result: object,
): WorkloadBrokerResponseReceipt | undefined {
  return responseReceipts.get(result);
}

export function isIssuedWorkloadBrokerResponseReceipt(
  receipt: WorkloadBrokerResponseReceipt,
): boolean {
  return issuedResponseReceipts.has(receipt);
}

export class WorkloadBrokerTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(`workload-broker:${code}`);
    this.name = "WorkloadBrokerTransportError";
  }
}

function fail(code: string, retryable = false): never {
  throw new WorkloadBrokerTransportError(code, retryable);
}

function operationDeadlineMs(
  operation: WorkloadBrokerOperation,
  payload: WorkloadOperationPayloads[WorkloadBrokerOperation],
): number {
  if (operation === "handshake") return WORKLOAD_BROKER_LIMITS.handshakeTimeoutMs;
  const record = payload as Record<string, unknown>;
  const requested = typeof record.timeoutMs === "number"
    ? record.timeoutMs
    : typeof record.waitMs === "number"
      ? record.waitMs
      : TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs;
  // The transport budget includes a short bounded interval for connect,
  // framing, and broker-side cleanup after the operation deadline fires.
  return Math.min(
    requested + TOOL_TIMEOUT_POLICY.workloadBrokerTransportGraceMs,
    WORKLOAD_BROKER_LIMITS.maximumTimeoutMs
      + TOOL_TIMEOUT_POLICY.workloadBrokerTransportGraceMs,
  );
}

function parseNdjsonResponse(bytes: Buffer, maxBytes: number): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) fail("response-size-invalid");
  if (bytes[bytes.byteLength - 1] !== 0x0a) fail("response-newline-missing");
  const line = bytes.subarray(0, bytes.byteLength - 1);
  if (line.includes(0x0a) || line.includes(0x0d)) fail("response-line-count-invalid");
  try {
    return parseStrictJson(line, {
      maxBytes,
      maxDepth: 24,
      maxNodes: 8_192,
      maxObjectMembers: 512,
      maxArrayItems: 4_096,
    });
  } catch {
    return fail("response-json-invalid");
  }
}

async function exchangeOneLine(
  socketPath: string,
  request: Buffer,
  maxResponseBytes: number,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal?.aborted) fail("request-aborted");
  return await new Promise<Buffer>((resolve, reject) => {
    let socket: Socket | undefined;
    let settled = false;
    let total = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: WorkloadBrokerTransportError, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket?.removeAllListeners();
      socket?.destroy();
      if (error) reject(error);
      else resolve(result ?? Buffer.alloc(0));
    };
    const onAbort = () => finish(new WorkloadBrokerTransportError("request-aborted"));
    const timer = setTimeout(
      () => finish(new WorkloadBrokerTransportError("request-deadline-exceeded")),
      deadlineMs,
    );
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      socket = createConnection({ path: socketPath });
      // Keep the write side open until the broker responds. A half-close after
      // the request would be indistinguishable from cancellation to a broker
      // that monitors client EOF while a long-running operation is active.
      // Abort/deadline paths destroy the socket, which is the explicit
      // cancellation signal for this one-request connection.
      socket.on("connect", () => socket?.write(request));
      socket.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > maxResponseBytes) {
          finish(new WorkloadBrokerTransportError("response-size-invalid"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      socket.on("end", () => finish(undefined, Buffer.concat(chunks, total)));
      socket.on("error", () => finish(new WorkloadBrokerTransportError("transport-unavailable", true)));
      socket.on("close", (hadError) => {
        if (!settled && !hadError) {
          finish(new WorkloadBrokerTransportError("response-truncated", true));
        }
      });
    } catch {
      finish(new WorkloadBrokerTransportError("transport-unavailable", true));
    }
  });
}

export async function sendWorkloadBrokerRequest<K extends WorkloadBrokerOperation>(
  document: WorkloadBrokerCapabilityDocument,
  operation: K,
  payload: WorkloadOperationPayloads[K],
  signal?: AbortSignal,
  correlation?: WorkloadBrokerCorrelation,
): Promise<WorkloadBrokerSuccessResults[K]> {
  if (Date.parse(document.expiresAt) <= Date.now()) fail("capability-expired");
  if (!document.allowedOperations.includes(operation)) fail("operation-not-allowed");
  const parsedPayload = WorkloadOperationPayloadSchemas[operation].safeParse(payload);
  if (!parsedPayload.success) fail("request-payload-invalid");
  const payloadDigest = sha256Hex(canonicalStringify(parsedPayload.data));
  if (operation === "handshake" ? correlation !== undefined
    : correlation === undefined || correlation.operation !== operation ||
      correlation.payloadDigest !== payloadDigest) {
    fail("request-correlation-invalid");
  }
  const id = randomUUID();
  const encoded = Buffer.from(`${JSON.stringify({
    version: WORKLOAD_BROKER_REQUEST_VERSION,
    id,
    token: document.token,
    operation,
    payload: parsedPayload.data,
    ...(correlation === undefined ? {} : { correlation }),
  })}\n`, "utf8");
  if (encoded.byteLength > document.maxRequestBytes) fail("request-size-invalid");
  const responseBytes = await exchangeOneLine(
    document.socketPath,
    encoded,
    document.maxResponseBytes,
    operationDeadlineMs(operation, parsedPayload.data),
    signal,
  );
  const rawResponse = parseNdjsonResponse(responseBytes, document.maxResponseBytes);
  const response = WorkloadBrokerResponseSchema.safeParse(rawResponse);
  if (!response.success) fail("response-schema-invalid");
  if (response.data.id !== id) fail("response-id-mismatch");
  const pinnedBrokerInstance = brokerInstances.get(document);
  if (pinnedBrokerInstance === undefined) {
    brokerInstances.set(document, response.data.brokerInstanceId);
  } else if (pinnedBrokerInstance !== response.data.brokerInstanceId) {
    fail("response-broker-instance-mismatch");
  }
  if (response.data.payloadDigest !== payloadDigest) fail("response-payload-digest-mismatch");
  if (operation === "handshake") {
    if (response.data.correlation !== undefined || response.data.correlationDigest !== undefined) {
      fail("response-correlation-unexpected");
    }
  } else {
    if (correlation === undefined || response.data.correlation === undefined ||
        canonicalStringify(response.data.correlation) !== canonicalStringify(correlation)) {
      fail("response-correlation-mismatch");
    }
    const expectedCorrelationDigest = sha256Hex(canonicalStringify({
      brokerInstanceId: response.data.brokerInstanceId,
      brokerRequestId: response.data.brokerRequestId,
      clientRequestId: id,
      correlation,
      operation,
      payloadDigest,
      protocol: WORKLOAD_BROKER_REQUEST_VERSION,
      workload: document.workload,
    }));
    if (response.data.correlationDigest !== expectedCorrelationDigest) {
      fail("response-correlation-digest-mismatch");
    }
  }
  if (!response.data.ok) {
    throw new WorkloadBrokerTransportError(
      `broker-${response.data.error.code}`,
      response.data.error.retryable,
    );
  }
  try {
    const parsedResult = parseWorkloadBrokerSuccessResult(operation, response.data.result);
    const result = parsedResult;
    if (typeof result === "object" && result !== null) Object.freeze(result);
    if (operation !== "handshake" && correlation !== undefined &&
        response.data.correlationDigest !== undefined && typeof result === "object" && result !== null) {
      const receipt = Object.freeze({
        clientRequestId: id,
        brokerRequestId: response.data.brokerRequestId,
        brokerInstanceId: response.data.brokerInstanceId,
        payloadDigest,
        admittedReceiptDigest: response.data.admittedReceiptDigest,
        terminalReceiptDigest: response.data.terminalReceiptDigest,
        correlationDigest: response.data.correlationDigest,
        correlation,
      });
      issuedResponseReceipts.add(receipt);
      responseReceipts.set(result, receipt);
    }
    if (operation === "shell.read") {
      const request = parsedPayload.data as WorkloadOperationPayloads["shell.read"];
      const read = result as unknown as WorkloadBrokerSuccessResults["shell.read"];
      const outputBytes = Buffer.byteLength(read.output, "utf8");
      if (read.executionId !== request.executionId
          || read.offset !== request.offset
          || outputBytes > request.maxBytes
          || read.nextOffset !== request.offset + outputBytes) {
        fail("response-shell-binding-mismatch");
      }
    }
    if (operation === "shell.kill") {
      const request = parsedPayload.data as WorkloadOperationPayloads["shell.kill"];
      const killed = result as unknown as WorkloadBrokerSuccessResults["shell.kill"];
      if (killed.executionId !== request.executionId
          || killed.nextOffset !== Buffer.byteLength(killed.output, "utf8")) {
        fail("response-shell-binding-mismatch");
      }
    }
    if (operation === "file.read") {
      const request = parsedPayload.data as WorkloadOperationPayloads["file.read"];
      const read = result as unknown as WorkloadBrokerSuccessResults["file.read"];
      if (!read.isError && (
        read.metadata.path !== request.path
        || read.metadata.startLine !== request.offset + 1
        || read.metadata.lineCount > request.limit
        || read.metadata.endLine !== request.offset + read.metadata.lineCount
      )) {
        fail("response-file-binding-mismatch");
      }
    }
    if (operation === "file.read_binary") {
      const request = parsedPayload.data as WorkloadOperationPayloads["file.read_binary"];
      const binary = result as unknown as WorkloadBrokerSuccessResults["file.read_binary"];
      if (!binary.isError) {
        const decoded = Buffer.from(binary.data, "base64");
        if (binary.path !== request.path
            || binary.bytes !== decoded.byteLength
            || binary.bytes > request.maxBytes
            || decoded.toString("base64") !== binary.data) {
          fail("response-file-binding-mismatch");
        }
      }
    }
    return result;
  } catch (error) {
    if (error instanceof WorkloadBrokerTransportError) throw error;
    return fail("response-result-invalid");
  }
}
