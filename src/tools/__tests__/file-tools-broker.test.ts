import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const broker = vi.hoisted(() => ({
  active: true,
  cwd: "/broker/workspace",
  capability: Object.freeze({
    version: "brokered-workload-capability/v1",
    workload: Object.freeze({
      id: "a".repeat(64),
      generation: "test-generation",
      boundaryFingerprint: "b".repeat(64),
      imageDigest: `sha256:${"c".repeat(64)}`,
      cwd: "/broker/workspace",
      home: "/home/agent",
      platform: "linux",
    }),
    expiresAt: "2999-01-01T00:00:00.000Z",
    allowedOperations: Object.freeze([]),
  }),
  execute: vi.fn(),
}));

const imagePreparation = vi.hoisted(() => ({
  prepareBytes: vi.fn(),
  prepareFile: vi.fn(),
}));

vi.mock("../../workload/runtime.js", () => ({
  isWorkloadBrokerActive: () => broker.active,
  isActiveWorkloadBrokerCwd: (cwd: string) => cwd === broker.cwd,
  isIssuedActiveBrokeredWorkloadCapability: (value: unknown) => value === broker.capability,
  issueWorkloadToolCorrelationAuthority: (input: unknown) => input,
  resolveBrokeredWorkloadPath: (capability: typeof broker.capability, inputPath: string) => {
    if (capability !== broker.capability) throw new Error("capability-invalid");
    if (inputPath === "~") return capability.workload.home;
    if (inputPath.startsWith("~/")) {
      return `${capability.workload.home}/${inputPath.slice(2)}`;
    }
    if (inputPath.startsWith("~")) throw new Error("guest-path-tilde-user-unsupported");
    if (inputPath === ".") return capability.workload.cwd;
    return inputPath.startsWith("/")
      ? inputPath
      : `${capability.workload.cwd}/${inputPath}`.replace(/\/$/, "");
  },
  executeBrokeredWorkloadRequest: broker.execute,
}));

vi.mock("../image-preparation.js", () => ({
  prepareImageBytes: imagePreparation.prepareBytes,
  prepareImageFile: imagePreparation.prepareFile,
}));

import type { BrokeredWorkloadCapability } from "../../workload/runtime.js";
import { issueBrokeredToolExecutionGrant } from "../../permissions/execution-router.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { Tool, ToolExecutionContext, ToolExecutionResult } from "../base.js";
import {
  ApplyPatchTool,
  CopyPathTool,
  DeleteFileTool,
  EditFileTool,
  ExtractArchiveTool,
  GlobFilesTool,
  GrepFilesTool,
  isCanonicalFileTool,
  ListFilesTool,
  MoveFileTool,
  normalizeCanonicalFileToolInput,
  ReadFileTool,
  ViewImageTool,
  WriteFileTool,
} from "../file-tools.js";

const capability = broker.capability as unknown as BrokeredWorkloadCapability;

function context(tool: Tool, rawInput: unknown, cwd = broker.cwd): ToolExecutionContext {
  const normalizedInput = normalizeCanonicalFileToolInput(tool, rawInput);
  return {
    cwd,
    extraAllowedDirectories: [],
    metadata: {},
    executionRouteGrant: issueBrokeredToolExecutionGrant({
      toolUseId: "tool-use-test",
      capability,
      toolName: tool.name,
      normalizedInput,
      cwd,
    }),
  };
}

afterEach(() => {
  broker.active = true;
  broker.cwd = "/broker/workspace";
  broker.execute.mockReset();
  imagePreparation.prepareBytes.mockReset();
  imagePreparation.prepareFile.mockReset();
});

describe("canonical file tool broker transport", () => {
  it("uses object identity and the exact instance schema for authority input", () => {
    const tool = new ReadFileTool();
    expect(isCanonicalFileTool(tool)).toBe(true);
    expect(normalizeCanonicalFileToolInput(tool, { path: "notes.txt" })).toEqual({
      path: "notes.txt",
      offset: 0,
      limit: 2_000,
    });

    const lookalike = { ...tool, name: "read_file" };
    expect(isCanonicalFileTool(lookalike)).toBe(false);
    expect(() => normalizeCanonicalFileToolInput(lookalike, { path: "notes.txt" }))
      .toThrow("host-created file tool");

    class DerivedReadFileTool extends ReadFileTool {}
    expect(isCanonicalFileTool(new DerivedReadFileTool())).toBe(false);
  });

  it.each([
    {
      tool: new ReadFileTool(), input: { path: "~/notes.txt" }, operation: "file.read",
      payload: { path: "/home/agent/notes.txt", offset: 0, limit: 2_000 },
    },
    {
      tool: new ListFilesTool(), input: { path: ".", depth: 3, limit: 17 }, operation: "file.list",
      payload: { path: "/broker/workspace", depth: 3, limit: 17 },
    },
    {
      tool: new GlobFilesTool(), input: { pattern: "src/**/*.ts", limit: 9 }, operation: "file.glob",
      payload: { path: "/broker/workspace", pattern: "src/**/*.ts", limit: 9 },
    },
    {
      tool: new GrepFilesTool(),
      input: { pattern: "needle", path: "src", include: "**/*.ts", caseSensitive: false, limit: 8 },
      operation: "file.grep",
      payload: {
        path: "/broker/workspace/src", pattern: "needle", include: "**/*.ts",
        caseSensitive: false, limit: 8,
      },
    },
    {
      tool: new WriteFileTool(), input: { path: "new.txt", content: "hello" }, operation: "file.write",
      payload: { path: "/broker/workspace/new.txt", content: "hello" },
    },
    {
      tool: new EditFileTool(), input: { path: "edit.txt", oldText: "old", newText: "new" },
      operation: "file.edit",
      payload: {
        path: "/broker/workspace/edit.txt", oldText: "old", newText: "new", replaceAll: false,
      },
    },
    {
      tool: new ApplyPatchTool(),
      input: { path: "patch.txt", replacements: [{ oldText: "old", newText: "new" }] },
      operation: "file.patch",
      payload: {
        path: "/broker/workspace/patch.txt",
        replacements: [{ oldText: "old", newText: "new", replaceAll: false }],
      },
    },
    {
      tool: new MoveFileTool(),
      input: { sourcePath: "from.txt", destinationPath: "to.txt", overwrite: true },
      operation: "file.move",
      payload: {
        sourcePath: "/broker/workspace/from.txt",
        destinationPath: "/broker/workspace/to.txt",
        overwrite: true,
      },
    },
    {
      tool: new CopyPathTool(), input: { sourcePath: "from", destinationPath: "to" },
      operation: "file.copy",
      payload: { sourcePath: "/broker/workspace/from", destinationPath: "/broker/workspace/to" },
    },
    {
      tool: new ExtractArchiveTool(), input: { archivePath: "in.tar", destinationPath: "out" },
      operation: "file.extract",
      payload: { archivePath: "/broker/workspace/in.tar", destinationPath: "/broker/workspace/out" },
    },
    {
      tool: new DeleteFileTool(), input: { path: "old.txt" }, operation: "file.delete",
      payload: { path: "/broker/workspace/old.txt" },
    },
  ] as const)("maps $operation without touching node:fs", async ({ tool, input, operation, payload }) => {
    const brokerResult: ToolExecutionResult = { output: `broker:${operation}`, isError: false };
    broker.execute.mockResolvedValueOnce(brokerResult);

    const result = await tool.execute(input, context(tool, input));

    expect(result).toBe(brokerResult);
    expect(broker.execute).toHaveBeenCalledOnce();
    expect(broker.execute).toHaveBeenCalledWith(
      capability,
      operation,
      { ...payload, timeoutMs: TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs },
      expect.objectContaining({ operation, toolName: tool.name }),
      undefined,
    );
  });

  it("routes view_image bytes through the bounded controller decoder and preserves image output", async () => {
    const tool = new ViewImageTool();
    const input = { path: "picture.png", maxBytes: 1_024, maxDimension: 64 };
    const raw = Buffer.from("broker-image-bytes");
    broker.execute.mockResolvedValueOnce({
      output: "binary loaded",
      isError: false,
      path: "/broker/workspace/picture.png",
      data: raw.toString("base64"),
      bytes: raw.byteLength,
    });
    imagePreparation.prepareBytes.mockResolvedValueOnce({
      data: Buffer.from("normalized-png").toString("base64"),
      mimeType: "image/png",
      bytes: 14,
      width: 32,
      height: 16,
      originalWidth: 32,
      originalHeight: 16,
      originalFormat: "png",
      inputBytes: raw.byteLength,
      frame: 0,
      frameCount: 1,
      orientationApplied: false,
      resized: false,
    });

    const result = await tool.execute(input, context(tool, input));

    expect(broker.execute).toHaveBeenCalledWith(
      capability,
      "file.read_binary",
      {
        path: "/broker/workspace/picture.png",
        maxBytes: 25 * 1_024 * 1_024,
        timeoutMs: TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
      },
      expect.objectContaining({ operation: "file.read_binary", toolName: "view_image" }),
      undefined,
    );
    expect(imagePreparation.prepareBytes).toHaveBeenCalledWith(
      raw,
      { maxBytes: 1_024, maxDimension: 64 },
      undefined,
    );
    expect(imagePreparation.prepareFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: false,
      image: { mimeType: "image/png", bytes: 14, width: 32, height: 16 },
    });
  });

  it("fails closed for a missing, mismatched, replayed, or failed broker authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lvis-file-broker-"));
    const path = join(directory, "host.txt");
    const tool = new WriteFileTool();
    try {
      await writeFile(path, "host-original", "utf8");

      const missing = await tool.execute(
        { path, content: "missing-grant" },
        { cwd: directory, extraAllowedDirectories: [], metadata: {} },
      );
      expect(missing).toMatchObject({ isError: true, metadata: { source: "workload-broker" } });

      broker.cwd = directory;
      const grantedInput = { path, content: "granted" };
      const mismatched = await tool.execute(
        { path, content: "different" },
        context(tool, grantedInput, directory),
      );
      expect(mismatched.isError).toBe(true);

      broker.execute.mockResolvedValueOnce({
        output: "Workload broker refused execution (transport-unavailable).",
        isError: true,
        metadata: { source: "workload-broker" },
      });
      const replayContext = context(tool, grantedInput, directory);
      const transportFailure = await tool.execute(grantedInput, replayContext);
      const replay = await tool.execute(grantedInput, replayContext);
      expect(transportFailure.isError).toBe(true);
      expect(replay.isError).toBe(true);
      expect(broker.execute).toHaveBeenCalledOnce();
      expect(await readFile(path, "utf8")).toBe("host-original");
    } finally {
      await cleanupTmpDir(directory);
    }
  });

  it("fails closed when the broker is released after canonical file grants are issued", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lvis-file-broker-release-"));
    const path = join(directory, "host.txt");
    const readTool = new ReadFileTool();
    const readInput = { path };
    const writeTool = new WriteFileTool();
    const writeInput = { path, content: "must-not-reach-host" };
    try {
      await writeFile(path, "host-original", "utf8");
      broker.cwd = directory;
      const readContext = context(readTool, readInput, directory);
      const writeContext = context(writeTool, writeInput, directory);

      broker.active = false;
      const readResult = await readTool.execute(readInput, readContext);
      const writeResult = await writeTool.execute(writeInput, writeContext);

      expect(readResult).toMatchObject({
        isError: true,
        metadata: { source: "workload-broker" },
      });
      expect(writeResult).toMatchObject({
        isError: true,
        metadata: { source: "workload-broker" },
      });
      expect(broker.execute).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe("host-original");
    } finally {
      await cleanupTmpDir(directory);
    }
  });
});
