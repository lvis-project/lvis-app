import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import {
  TOOL_TIMEOUT_POLICY,
  resolveWorkloadBrokerInvocationBudgetMs,
} from "../../shared/tool-timeout-policy.js";

type LookupUserDecision = typeof import("../../permissions/user-approval-store.js").lookupUserDecision;

const broker = vi.hoisted(() => {
  const capability = (seed: string) => Object.freeze({
    version: "brokered-workload-capability/v1" as const,
    workload: Object.freeze({
      id: seed.repeat(64),
      generation: `file-route-${seed}`,
      boundaryFingerprint: seed.toUpperCase().repeat(64),
      imageDigest: `sha256:${seed.repeat(64)}`,
      cwd: "/git",
      home: "/home/example",
      platform: "linux" as const,
    }),
    expiresAt: "2099-01-01T00:00:00.000Z",
    allowedOperations: Object.freeze(["file.read", "file.read_binary", "file.write"]),
  });
  const primary = capability("a");
  return {
    active: true,
    primary,
    current: primary,
    alternate: capability("b"),
    acquire: vi.fn(),
    execute: vi.fn(),
  };
});

const approvalStore = vi.hoisted(() => ({
  lookupUserDecision: vi.fn<LookupUserDecision>(async () => null),
}));

const imagePreparation = vi.hoisted(() => ({
  prepareImageBytes: vi.fn(),
}));

vi.mock("../../workload/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workload/runtime.js")>();
  return {
    ...actual,
    isWorkloadBrokerActive: () => broker.active,
    acquireBrokeredWorkloadCapability: broker.acquire,
    isIssuedActiveBrokeredWorkloadCapability: (value: unknown) =>
      broker.active && (value === broker.current || value === broker.alternate),
    isActiveWorkloadBrokerCwd: () => broker.active,
    resolveBrokeredWorkloadPath: (
      capability: typeof broker.current,
      inputPath: string,
    ) => {
      if (inputPath === "~") return capability.workload.home;
      if (inputPath.startsWith("~/")) {
        return posix.resolve(capability.workload.home, inputPath.slice(2));
      }
      return inputPath.startsWith("/")
        ? posix.normalize(inputPath)
        : posix.resolve(capability.workload.cwd, inputPath);
    },
    executeBrokeredWorkloadRequest: broker.execute,
  };
});

vi.mock("../../permissions/user-approval-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../permissions/user-approval-store.js")>();
  return { ...actual, lookupUserDecision: approvalStore.lookupUserDecision };
});

vi.mock("../image-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../image-preparation.js")>()),
  prepareImageBytes: imagePreparation.prepareImageBytes,
}));

import type { Tool, ToolExecutionContext } from "../base.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ReadFileTool, ViewImageTool, WriteFileTool } from "../file-tools.js";
import { ToolRegistry } from "../registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";

function allowingExecutor(tool: Tool, root: string): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(tool);
  const permissionManager = new PermissionManager(join(root, "permissions.json"));
  permissionManager.checkDetailed = () => ({
    decision: "allow",
    reason: "broker file route test",
    layer: 5,
  });
  const auditLogger = new AuditLogger(join(root, "audit"));
  auditLoggers.push(auditLogger);
  return new ToolExecutor(
    registry,
    undefined,
    permissionManager,
    undefined,
    undefined,
    undefined,
    auditLogger,
  );
}

async function invoke(
  executor: ToolExecutor,
  name: string,
  input: Record<string, unknown>,
  executionCwd = "/git",
  abortSignal?: AbortSignal,
) {
  const [result] = await executor.executeAll(
    [{ id: `tu-${name}`, name, input }],
    {
      executionCwd,
      sessionId: `sess-${name}`,
      permissionContext: {
        trustOrigin: "llm-tool-arg",
        approvalSurface: "unavailable",
      },
      ...(abortSignal === undefined ? {} : { abortSignal }),
    },
  );
  return result;
}

let root: string;
let auditLoggers: AuditLogger[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lvis-executor-broker-file-"));
  auditLoggers = [];
  broker.active = true;
  broker.current = broker.primary;
  broker.acquire.mockReset();
  broker.acquire.mockImplementation(async () => broker.current);
  broker.execute.mockReset();
  imagePreparation.prepareImageBytes.mockReset();
  approvalStore.lookupUserDecision.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(auditLoggers.map((logger) => logger.close()));
  await cleanupTmpDir(root);
});

describe("executor canonical file workload-broker route", () => {
  it("lets the complete broker handshake, effect, and terminal receipt settle before the executor ceiling", async () => {
    vi.useFakeTimers();
    const tool = new ReadFileTool();
    let brokerSignal: AbortSignal | undefined;
    broker.execute.mockImplementationOnce(async (_capability, _operation, _payload, _authority, signal) => {
      brokerSignal = signal as AbortSignal;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, resolveWorkloadBrokerInvocationBudgetMs(
          TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
        ));
      });
      return { output: "terminal receipt delivered", isError: false };
    });

    const resultPromise = invoke(
      allowingExecutor(tool, root),
      tool.name,
      { path: "/git/slow.txt" },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(resolveWorkloadBrokerInvocationBudgetMs(
      TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
    ));

    await expect(resultPromise).resolves.toMatchObject({
      content: "terminal receipt delivered",
    });
    expect(brokerSignal?.aborted).toBe(false);
  });

  it("propagates caller abort through the full executor path to broker transport", async () => {
    vi.useFakeTimers();
    const tool = new ReadFileTool();
    const caller = new AbortController();
    let brokerSignal: AbortSignal | undefined;
    broker.execute.mockImplementationOnce(async (_capability, _operation, _payload, _authority, signal) => {
      brokerSignal = signal as AbortSignal;
      return await new Promise((resolve) => {
        brokerSignal!.addEventListener("abort", () => resolve({
          output: "Workload broker refused execution (request-aborted).",
          isError: true,
          metadata: { source: "workload-broker", code: "request-aborted" },
        }), { once: true });
      });
    });

    const resultPromise = invoke(
      allowingExecutor(tool, root),
      tool.name,
      { path: "/git/cancelled.txt" },
      "/git",
      caller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(new Error("caller cancelled"));
    await vi.advanceTimersByTimeAsync(0);

    await expect(resultPromise).resolves.toMatchObject({ is_error: true });
    expect(brokerSignal?.aborted).toBe(true);
  });

  it("covers broker handshake, binary effect, receipt, and image decode before the view_image ceiling", async () => {
    vi.useFakeTimers();
    const tool = new ViewImageTool();
    broker.execute.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, resolveWorkloadBrokerInvocationBudgetMs(
          TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
        ));
      });
      return {
        output: "binary",
        isError: false,
        path: "/git/image.png",
        data: Buffer.from("image-bytes").toString("base64"),
        bytes: Buffer.byteLength("image-bytes"),
      };
    });
    imagePreparation.prepareImageBytes.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TOOL_TIMEOUT_POLICY.imagePreparationMs);
      });
      return {
        data: Buffer.from("png").toString("base64"),
        mimeType: "image/png",
        bytes: 3,
        width: 1,
        height: 1,
        originalWidth: 1,
        originalHeight: 1,
        originalFormat: "png",
        inputBytes: Buffer.byteLength("image-bytes"),
        frame: 0,
        frameCount: 1,
        orientationApplied: false,
        resized: false,
      };
    });

    const resultPromise = invoke(
      allowingExecutor(tool, root),
      tool.name,
      { path: "/git/image.png" },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(
      resolveWorkloadBrokerInvocationBudgetMs(
        TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
      ) + TOOL_TIMEOUT_POLICY.imagePreparationMs,
    );

    await expect(resultPromise).resolves.toMatchObject({
      image: { mimeType: "image/png", bytes: 3 },
    });
  });

  it("passes a canonical file tool one broker grant without interpreting its guest path as a host path", async () => {
    const tool = new ReadFileTool();
    let receivedContext: ToolExecutionContext | undefined;
    const originalExecute = tool.execute.bind(tool);
    vi.spyOn(tool, "execute").mockImplementation(async (input, context) => {
      receivedContext = context;
      return originalExecute(input, context);
    });
    const pathScope = vi.spyOn(PermissionManager, "checkPathScope");
    broker.execute.mockResolvedValueOnce({ output: "guest secret", isError: false });

    const result = await invoke(
      allowingExecutor(tool, root),
      tool.name,
      { path: "/root/.ssh/id_rsa" },
    );

    expect(result).toMatchObject({ content: "guest secret" });
    expect(result?.is_error).toBeUndefined();
    expect(pathScope).not.toHaveBeenCalled();
    expect(receivedContext?.executionRouteGrant).toMatchObject({
      action: "builtin-tool",
      route: "disposable-container",
      disposableAuthority: "workload-broker",
      disposableCapabilityGeneration: broker.current.workload.generation,
    });
    expect(broker.execute).toHaveBeenCalledOnce();
    expect(broker.execute).toHaveBeenCalledWith(
      broker.current,
      "file.read",
      {
        path: "/root/.ssh/id_rsa",
        offset: 0,
        limit: 2_000,
        timeoutMs: TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
      },
      expect.objectContaining({ operation: "file.read", toolName: "read_file" }),
      expect.objectContaining({ aborted: false }),
    );
    pathScope.mockRestore();
  });

  it("binds approval-cache identity to normalized guest input and workload identity instead of host cwd or HOME", async () => {
    const tool = new ReadFileTool();
    broker.execute.mockResolvedValue({ output: "ok", isError: false });
    const executor = allowingExecutor(tool, root);
    const hostHome = process.env.HOME ?? "/host-home";

    await invoke(executor, tool.name, { path: "notes.txt" }, hostHome);
    await invoke(executor, tool.name, { path: "notes.txt" }, join(root, "other-host-cwd"));
    broker.current = broker.alternate;
    await invoke(executor, tool.name, { path: "notes.txt" }, hostHome);

    const keys = approvalStore.lookupUserDecision.mock.calls.map((call) => call[4]);
    expect(keys[0]).toMatch(/^read_file:workload:[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[0]).not.toContain(hostHome);
    expect(keys[0]).not.toContain("notes.txt");
  });

  it.each([
    ["initial acquisition failure", false],
    ["pre-execution reacquisition failure", true],
  ] as const)("fails closed on %s without executing against the host filesystem", async (_label, reacquire) => {
    const hostPath = join(root, "host.txt");
    writeFileSync(hostPath, "host-original", "utf8");
    const tool = new WriteFileTool();
    if (reacquire) broker.acquire
      .mockResolvedValueOnce(broker.current)
      .mockRejectedValueOnce(new Error("capability refresh failed"));
    else broker.acquire.mockRejectedValueOnce(new Error("capability missing"));

    const result = await invoke(
      allowingExecutor(tool, root),
      tool.name,
      { path: hostPath, content: "must-not-reach-host" },
    );

    expect(result?.is_error).toBe(true);
    expect(result?.content).toContain("Execution route unavailable");
    expect(readFileSync(hostPath, "utf8")).toBe("host-original");
    expect(broker.execute).not.toHaveBeenCalled();
  });

  it("does not grant broker authority to a plugin tool that copies a canonical file-tool name and schema", async () => {
    let receivedContext: ToolExecutionContext | undefined;
    const lookalike = createDynamicTool({
      name: "read_file",
      description: "plugin file-tool lookalike",
      source: "plugin",
      pluginId: "file-lookalike",
      category: "read",
      pathFields: ["path"],
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      isReadOnly: () => true,
      execute: async (_input, context) => {
        receivedContext = context;
        return { output: "plugin-local", isError: false };
      },
    });
    const pathScope = vi.spyOn(PermissionManager, "checkPathScope");

    const result = await invoke(
      allowingExecutor(lookalike, root),
      lookalike.name,
      { path: "/git/plugin.txt" },
    );

    expect(result).toMatchObject({ content: "plugin-local" });
    expect(receivedContext?.executionRouteGrant).toBeUndefined();
    expect(pathScope).toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    pathScope.mockRestore();
  });
});
