import { describe, expect, it } from "vitest";
import {
  WorkloadBrokerCapabilityDocumentSchema,
  WorkloadOperationPayloadSchemas,
  WorkloadShellKillResultSchema,
  WorkloadShellReadResultSchema,
  WorkloadShellRunResultSchema,
  parseWorkloadBrokerRequest,
} from "../protocol.js";

const HEX = "a".repeat(64);
const WORKLOAD = {
  id: HEX,
  generation: "trial-1",
  boundaryFingerprint: "b".repeat(64),
  imageDigest: `sha256:${"c".repeat(64)}`,
  cwd: "/app",
  home: "/home/agent",
  platform: "linux" as const,
};

describe("workload broker protocol", () => {
  it("accepts a bounded exact capability document", () => {
    expect(WorkloadBrokerCapabilityDocumentSchema.parse({
      version: "lvis-workload-broker-capability/v1",
      socketPath: "/run/lvis/workload.sock",
      token: Buffer.alloc(32, 7).toString("base64url"),
      expiresAt: "2030-01-01T00:00:00.000Z",
      workload: WORKLOAD,
      allowedOperations: ["handshake", "shell.run"],
      maxRequestBytes: 65_536,
      maxResponseBytes: 1_048_576,
    })).toMatchObject({ workload: WORKLOAD });
  });

  it("requires an exact guest home in the workload identity", () => {
    const { home: _home, ...workloadWithoutHome } = WORKLOAD;
    expect(WorkloadBrokerCapabilityDocumentSchema.safeParse({
      version: "lvis-workload-broker-capability/v1",
      socketPath: "/run/lvis/workload.sock",
      token: Buffer.alloc(32, 7).toString("base64url"),
      expiresAt: "2030-01-01T00:00:00.000Z",
      workload: workloadWithoutHome,
      allowedOperations: ["handshake"],
      maxRequestBytes: 65_536,
      maxResponseBytes: 1_048_576,
    }).success).toBe(false);
  });

  it("rejects extra request fields and non-clean guest paths", () => {
    expect(() => parseWorkloadBrokerRequest({
      version: "lvis-workload-request/v1",
      id: "6f56e930-e2ff-4970-b073-cc47decd1b31",
      token: Buffer.alloc(32, 7).toString("base64url"),
      operation: "shell.run",
      payload: { command: "pwd", cwd: "/app/../host", timeoutMs: 1_000 },
      fallback: "host",
    })).toThrow();
    expect(() => parseWorkloadBrokerRequest({
      version: "lvis-workload-request/v1",
      id: "6f56e930-e2ff-4970-b073-cc47decd1b31",
      token: Buffer.alloc(32, 7).toString("base64url"),
      operation: "shell.run",
      payload: { command: "pwd", cwd: "/app/../host", timeoutMs: 1_000 },
    })).toThrow();
  });

  it("requires terminal cleanup and receipt evidence", () => {
    const terminal = {
      output: "done",
      isError: false,
      status: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      oomDelta: 0,
      ownedResourcesZero: true,
      receiptDigest: HEX,
    };
    expect(WorkloadShellRunResultSchema.parse(terminal)).toEqual(terminal);
    const { receiptDigest: _receipt, ...withoutReceipt } = terminal;
    expect(WorkloadShellRunResultSchema.safeParse(withoutReceipt).success).toBe(false);
    expect(WorkloadShellRunResultSchema.safeParse({
      ...terminal,
      status: "oom-killed",
      oomDelta: 0,
    }).success).toBe(false);
    expect(WorkloadShellRunResultSchema.safeParse({
      ...terminal,
      status: "cleanup-unproven",
      exitCode: null,
      ownedResourcesZero: true,
    }).success).toBe(false);
  });

  it("keeps running and terminal background snapshots distinct", () => {
    expect(WorkloadShellReadResultSchema.safeParse({
      executionId: "job_1",
      offset: 0,
      nextOffset: 4,
      output: "data",
      isError: false,
      running: true,
      truncated: false,
      status: "running",
    }).success).toBe(true);
    expect(WorkloadShellReadResultSchema.safeParse({
      executionId: "job_1",
      offset: 0,
      nextOffset: 4,
      output: "data",
      isError: false,
      running: false,
      truncated: false,
      status: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      oomDelta: 0,
      ownedResourcesZero: true,
      receiptDigest: HEX,
    }).success).toBe(true);
    expect(WorkloadShellReadResultSchema.safeParse({
      executionId: "job_1",
      offset: 4,
      nextOffset: 3,
      output: "",
      isError: false,
      running: true,
      truncated: false,
      status: "running",
    }).success).toBe(false);
  });

  it("defines background cursors as complete UTF-8 byte ranges", () => {
    const unicode = "é🙂";
    expect(Buffer.byteLength(unicode, "utf8")).toBe(6);
    expect(WorkloadOperationPayloadSchemas["shell.read"].safeParse({
      executionId: "job_1",
      offset: 7,
      maxBytes: 4,
      waitMs: 0,
      waitFor: "output",
    }).success).toBe(true);
    expect(WorkloadOperationPayloadSchemas["shell.read"].safeParse({
      executionId: "job_1",
      offset: 7,
      maxBytes: 3,
      waitMs: 0,
      waitFor: "output",
    }).success).toBe(false);

    const read = {
      executionId: "job_1",
      offset: 7,
      nextOffset: 13,
      output: unicode,
      isError: false as const,
      running: true as const,
      truncated: false,
      status: "running" as const,
    };
    expect(WorkloadShellReadResultSchema.safeParse(read).success).toBe(true);
    expect(WorkloadShellReadResultSchema.safeParse({
      ...read,
      // JavaScript string length is four UTF-16 code units here, not six
      // UTF-8 bytes. A character-count cursor must never cross the wire.
      nextOffset: read.offset + unicode.length,
    }).success).toBe(false);
    expect(WorkloadShellReadResultSchema.safeParse({
      ...read,
      nextOffset: read.offset + 3,
      output: "\ud800",
    }).success).toBe(false);

    const killed = {
      executionId: "job_1",
      nextOffset: 9,
      output: `${unicode}終`,
      isError: true,
      truncated: false,
      status: "cancelled" as const,
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      cancelled: true,
      oomDelta: 0,
      ownedResourcesZero: true,
      receiptDigest: HEX,
    };
    expect(WorkloadShellKillResultSchema.safeParse(killed).success).toBe(true);
    expect(WorkloadShellKillResultSchema.safeParse({
      ...killed,
      nextOffset: unicode.length + 1,
    }).success).toBe(false);
  });
});
