import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import {
  WorkloadBrokerConfigurationError,
  loadWorkloadBrokerCapabilityFile,
} from "../capability-file.js";
import {
  __resetActiveWorkloadBrokerForTests,
  acquireBrokeredWorkloadCapability,
  executeBrokeredWorkloadRequest,
  getActiveWorkloadBrokerProjection,
  initializeWorkloadBroker,
  issueWorkloadBackgroundParent,
  issueWorkloadToolCorrelationAuthority,
  isActiveWorkloadBrokerCwd,
  isIssuedActiveBrokeredWorkloadCapability,
  resolveBrokeredWorkloadPath,
} from "../runtime.js";

const HEX = "a".repeat(64);
const BROKER_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const BROKER_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const WORKLOAD = {
  id: HEX,
  generation: "trial-1",
  boundaryFingerprint: "b".repeat(64),
  imageDigest: `sha256:${"c".repeat(64)}`,
  cwd: "/app",
  home: "/home/agent",
  platform: "linux" as const,
};

let root: string;
let server: Server | undefined;
let expiresAt: string;

function capability(socketPath: string) {
  return {
    version: "lvis-workload-broker-capability/v1",
    socketPath,
    token: Buffer.alloc(32, 9).toString("base64url"),
    expiresAt,
    workload: WORKLOAD,
    allowedOperations: ["handshake", "shell.run", "shell.start", "file.read_binary"],
    maxRequestBytes: 65_536,
    maxResponseBytes: 1_048_576,
  } as const;
}

async function startBroker(
  socketPath: string,
  invalidBinaryBytes = false,
  responseDelayMs = 0,
): Promise<void> {
  server = createServer((socket) => {
    const chunks: Buffer[] = [];
    let responded = false;
    socket.on("data", (chunk: Buffer) => {
      if (responded) return;
      chunks.push(Buffer.from(chunk));
      const encoded = Buffer.concat(chunks);
      if (encoded.indexOf(0x0a) === -1) return;
      responded = true;
      const request = JSON.parse(encoded.toString("utf8")) as {
        id: string;
        operation: string;
        payload: unknown;
        correlation?: unknown;
      };
      const cap = capability(socketPath);
      const result = request.operation === "handshake"
        ? {
          workload: cap.workload,
          allowedOperations: cap.allowedOperations,
          maxRequestBytes: cap.maxRequestBytes,
          maxResponseBytes: cap.maxResponseBytes,
          expiresAt: cap.expiresAt,
        }
        : request.operation === "file.read_binary"
          ? {
            output: "binary",
            isError: false,
            path: "/app/image.png",
            data: Buffer.from("image-bytes").toString("base64"),
            bytes: invalidBinaryBytes ? 1 : Buffer.byteLength("image-bytes"),
          }
          : request.operation === "shell.start"
            ? {
              output: "",
              isError: false,
              executionId: "job_1",
              offset: 0,
              status: "running",
            }
            : {
          output: "ok\n",
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
      const response = `${JSON.stringify({
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
            workload: cap.workload,
          })),
        }),
        ok: true,
        result,
      })}\n`;
      const respond = () => {
        if (socket.readableEnded) {
          socket.destroy();
          return;
        }
        socket.end(response);
      };
      if (responseDelayMs > 0) setTimeout(respond, responseDelayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
}

beforeEach(() => {
  __resetActiveWorkloadBrokerForTests();
  root = realpathSync(mkdtempSync(join(tmpdir(), "lvis-workload-broker-")));
  chmodSync(root, 0o700);
  expiresAt = new Date(Date.now() + 60_000).toISOString();
});

afterEach(async () => {
  vi.restoreAllMocks();
  __resetActiveWorkloadBrokerForTests();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await cleanupTmpDir(root);
});

describe("brokered workload runtime", () => {
  const authority = (operation: "shell.run" | "shell.start" | "file.read_binary", toolName: "bash" | "view_image") =>
    issueWorkloadToolCorrelationAuthority({
      toolUseId: `tool-${toolName}`,
      toolName,
      operation,
      grant: {
        identity: "1".repeat(64),
        effectDigest: "2".repeat(64),
        action: operation === "shell.run" ? "shell" : "builtin-tool",
        planIdentity: operation === "shell.run" ? "3".repeat(64) : null,
      },
    });
  it("keeps the request write side open until the broker responds", async () => {
    const socketPath = join(root, "workload.sock");
    const capabilityPath = join(root, "capability.json");
    await startBroker(socketPath, false, 25);
    writeFileSync(capabilityPath, JSON.stringify(capability(socketPath)), { mode: 0o400 });

    await expect(initializeWorkloadBroker({ socketPath, capabilityPath })).resolves.toBeDefined();
  });

  it("boots only after an exact handshake and returns typed terminal proof", async () => {
    const socketPath = join(root, "workload.sock");
    const capabilityPath = join(root, "capability.json");
    await startBroker(socketPath);
    writeFileSync(capabilityPath, JSON.stringify(capability(socketPath)), { mode: 0o400 });

    const bootCapability = await initializeWorkloadBroker({ socketPath, capabilityPath });
    expect(isIssuedActiveBrokeredWorkloadCapability(bootCapability)).toBe(true);
    expect(isActiveWorkloadBrokerCwd("/app")).toBe(true);
    expect(isActiveWorkloadBrokerCwd(root)).toBe(false);
    expect(getActiveWorkloadBrokerProjection()).toMatchObject({ workload: WORKLOAD });
    expect(resolveBrokeredWorkloadPath(bootCapability, "notes.txt")).toBe("/app/notes.txt");
    expect(resolveBrokeredWorkloadPath(bootCapability, "~/notes.txt"))
      .toBe("/home/agent/notes.txt");
    expect(resolveBrokeredWorkloadPath(bootCapability, "~")).toBe("/home/agent");
    expect(resolveBrokeredWorkloadPath(bootCapability, "/tmp/../app/notes.txt"))
      .toBe("/app/notes.txt");
    expect(() => resolveBrokeredWorkloadPath(bootCapability, "~root/notes.txt"))
      .toThrow("guest-path-tilde-user-unsupported");

    const acquired = await acquireBrokeredWorkloadCapability();
    const result = await executeBrokeredWorkloadRequest(acquired, "shell.run", {
      command: "pwd",
      cwd: "/app",
      timeoutMs: 1_000,
    }, authority("shell.run", "bash"));
    expect(result).toMatchObject({
      output: "ok\n",
      isError: false,
      status: "exited",
      ownedResourcesZero: true,
      receiptDigest: HEX,
    });
  });

  it("rejects a structurally forged capability without contacting a fallback", async () => {
    const forged = {
      version: "brokered-workload-capability/v1",
      workload: WORKLOAD,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOperations: ["shell.run"],
    } as never;
    expect(isIssuedActiveBrokeredWorkloadCapability(forged)).toBe(false);
    const result = await executeBrokeredWorkloadRequest(forged, "shell.run", {
      command: "pwd",
      timeoutMs: 1_000,
    }, {} as never);
    expect(result).toMatchObject({
      isError: true,
      metadata: { source: "workload-broker", code: "capability-invalid" },
    });
  });

  it("rejects a binary response whose declared byte count does not match its data", async () => {
    const socketPath = join(root, "workload.sock");
    const capabilityPath = join(root, "capability.json");
    await startBroker(socketPath, true);
    writeFileSync(capabilityPath, JSON.stringify(capability(socketPath)), { mode: 0o400 });
    await initializeWorkloadBroker({ socketPath, capabilityPath });
    const acquired = await acquireBrokeredWorkloadCapability();
    const result = await executeBrokeredWorkloadRequest(acquired, "file.read_binary", {
      path: "/app/image.png",
      maxBytes: 25 * 1_024 * 1_024,
    }, authority("file.read_binary", "view_image"));
    expect(result).toMatchObject({
      isError: true,
      metadata: { code: "response-file-binding-mismatch" },
    });
  });

  it("binds each tool authority to one exact operation and consumes it once", async () => {
    const socketPath = join(root, "workload.sock");
    const capabilityPath = join(root, "capability.json");
    await startBroker(socketPath);
    writeFileSync(capabilityPath, JSON.stringify(capability(socketPath)), { mode: 0o400 });
    await initializeWorkloadBroker({ socketPath, capabilityPath });
    const acquired = await acquireBrokeredWorkloadCapability();

    const mismatched = authority("file.read_binary", "view_image");
    await expect(executeBrokeredWorkloadRequest(acquired, "shell.run", {
      command: "pwd",
      cwd: "/app",
      timeoutMs: 1_000,
    }, mismatched)).resolves.toMatchObject({
      isError: true,
      metadata: { code: "correlation-authority-invalid" },
    });

    const oneShot = authority("shell.run", "bash");
    await expect(executeBrokeredWorkloadRequest(acquired, "shell.run", {
      command: "pwd",
      cwd: "/app",
      timeoutMs: 1_000,
    }, oneShot)).resolves.toMatchObject({ isError: false, status: "exited" });
    await expect(executeBrokeredWorkloadRequest(acquired, "shell.run", {
      command: "pwd",
      cwd: "/app",
      timeoutMs: 1_000,
    }, oneShot)).resolves.toMatchObject({
      isError: true,
      metadata: { code: "correlation-authority-invalid" },
    });
  });

  it("issues a background parent only from the frozen successful shell.start result", async () => {
    const socketPath = join(root, "workload.sock");
    const capabilityPath = join(root, "capability.json");
    await startBroker(socketPath);
    writeFileSync(capabilityPath, JSON.stringify(capability(socketPath)), { mode: 0o400 });
    await initializeWorkloadBroker({ socketPath, capabilityPath });
    const acquired = await acquireBrokeredWorkloadCapability();
    const result = await executeBrokeredWorkloadRequest(acquired, "shell.start", {
      command: "sleep 1",
      cwd: "/app",
      timeoutMs: 1_000,
    }, authority("shell.start", "bash"));

    expect(result).toMatchObject({ isError: false, executionId: "job_1" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result as object, "executionId", "job_forged")).toBe(false);
    expect(issueWorkloadBackgroundParent(
      result as { output: string; isError: false; executionId: string; offset: 0; status: "running" },
    )).toMatchObject({ executionId: "job_1", payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(() => issueWorkloadBackgroundParent({
      output: "",
      isError: false,
      executionId: "job_1",
      offset: 0,
      status: "running",
    })).toThrow("background-parent-receipt-invalid");
  });

  it("requires an owned 0400 regular capability file and rejects symlinks", () => {
    const socketPath = join(root, "workload.sock");
    const capabilityPath = join(root, "capability.json");
    writeFileSync(capabilityPath, JSON.stringify(capability(socketPath)), { mode: 0o600 });
    expect(() => loadWorkloadBrokerCapabilityFile(capabilityPath, socketPath))
      .toThrow(new WorkloadBrokerConfigurationError("capability-file-mode-invalid"));
    chmodSync(capabilityPath, 0o400);
    const linkPath = join(root, "capability-link.json");
    symlinkSync(capabilityPath, linkPath);
    expect(() => loadWorkloadBrokerCapabilityFile(linkPath, socketPath))
      .toThrow(new WorkloadBrokerConfigurationError("capability-file-unavailable"));
  });

  it("requires an owned real 0700 parent directory", () => {
    const socketPath = join(root, "workload.sock");
    const secureParent = join(root, "secure");
    mkdirSync(secureParent, { mode: 0o700 });
    const capabilityPath = join(secureParent, "capability.json");
    writeFileSync(capabilityPath, JSON.stringify(capability(socketPath)), { mode: 0o400 });

    expect(loadWorkloadBrokerCapabilityFile(capabilityPath, socketPath))
      .toMatchObject({ socketPath });

    chmodSync(secureParent, 0o755);
    expect(() => loadWorkloadBrokerCapabilityFile(capabilityPath, socketPath))
      .toThrow(new WorkloadBrokerConfigurationError("capability-directory-mode-invalid"));
    chmodSync(secureParent, 0o700);

    if (typeof process.geteuid === "function") {
      const uid = process.geteuid();
      const owner = vi.spyOn(process, "geteuid").mockReturnValue(uid + 1);
      expect(() => loadWorkloadBrokerCapabilityFile(capabilityPath, socketPath))
        .toThrow(new WorkloadBrokerConfigurationError("capability-directory-owner-invalid"));
      owner.mockRestore();
    }
  });

  it("rejects a symlinked capability parent", () => {
    const socketPath = join(root, "workload.sock");
    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    mkdirSync(realParent, { mode: 0o700 });
    writeFileSync(join(realParent, "capability.json"), JSON.stringify(capability(socketPath)), {
      mode: 0o400,
    });
    symlinkSync(realParent, linkedParent);

    expect(() => loadWorkloadBrokerCapabilityFile(
      join(linkedParent, "capability.json"),
      socketPath,
    )).toThrow(new WorkloadBrokerConfigurationError("capability-directory-invalid"));
  });

  it("rejects capability parent replacement during validation", () => {
    const socketPath = join(root, "workload.sock");
    const secureParent = join(root, "parent-to-replace");
    const originalParent = join(root, "original-parent");
    const replacementParent = join(root, "replacement-parent");
    mkdirSync(secureParent, { mode: 0o700 });
    mkdirSync(replacementParent, { mode: 0o700 });
    const capabilityPath = join(secureParent, "capability.json");
    writeFileSync(capabilityPath, JSON.stringify(capability(socketPath)), { mode: 0o400 });
    writeFileSync(join(replacementParent, "capability.json"), JSON.stringify(capability(socketPath)), {
      mode: 0o400,
    });

    const nativeRealpath = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation((path) => {
      if (path === secureParent) {
        renameSync(secureParent, originalParent);
        symlinkSync(replacementParent, secureParent);
      }
      return nativeRealpath(path);
    });
    expect(() => loadWorkloadBrokerCapabilityFile(capabilityPath, socketPath))
      .toThrow(new WorkloadBrokerConfigurationError("capability-directory-symlink-invalid"));
  });

  it("rejects capability path replacement during validation", () => {
    const socketPath = join(root, "workload.sock");
    const secureParent = join(root, "replace-parent");
    mkdirSync(secureParent, { mode: 0o700 });
    const capabilityPath = join(secureParent, "capability.json");
    const originalPath = join(secureParent, "capability.original.json");
    const replacementPath = join(secureParent, "capability.replacement.json");
    writeFileSync(capabilityPath, JSON.stringify(capability(socketPath)), { mode: 0o400 });
    writeFileSync(replacementPath, JSON.stringify(capability(socketPath)), { mode: 0o400 });

    const nativeRealpath = realpathSync.native;
    const realpath = vi.spyOn(realpathSync, "native").mockImplementation((path) => {
      if (path === capabilityPath) {
        renameSync(capabilityPath, originalPath);
        renameSync(replacementPath, capabilityPath);
      }
      return nativeRealpath(path);
    });
    expect(() => loadWorkloadBrokerCapabilityFile(capabilityPath, socketPath))
      .toThrow(new WorkloadBrokerConfigurationError("capability-file-changed"));
    realpath.mockRestore();
  });
});
