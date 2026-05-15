import { describe, it, expect, vi, beforeEach } from "vitest";

const runPreHooks = vi.fn(async () => ({ action: "allow" as const, feedback: "" }));
const runPostHooks = vi.fn(async () => "");
const auditLog = vi.fn();

vi.mock("../hooks/hook-runner.js", () => ({
  HookRunner: vi.fn().mockImplementation(function () {
    return {
    runPreHooks,
    runPostHooks,
    };
  }),
}));

vi.mock("../audit/audit-logger.js", () => ({
  AuditLogger: vi.fn().mockImplementation(function () {
    return {
    log: auditLog,
    logTurn: vi.fn(),
    isPermissionAuditChainReady: vi.fn(() => false),
    assertPermissionAuditWritable: vi.fn(),
    };
  }),
}));

vi.mock("../audit/dlp-filter.js", () => ({
  maskSensitiveData: vi.fn((input: string) => ({ masked: input, detections: [] })),
}));

import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import { createDynamicTool } from "../tools/base.js";

const userPermissionContext = { trustOrigin: "user-keyboard" as const };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ToolExecutor metadata", () => {
  it("passes stable group metadata to tool callbacks", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "fake_tool",
      description: "fake",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object" },
      execute: async () => ({ output: "ok", isError: false }),
    }));

    const executor = new ToolExecutor(registry);
    const startMetas = [] as Array<import("../tools/executor.js").ToolCallMeta>;
    const endMetas = [] as Array<import("../tools/executor.js").ToolCallMeta>;

    const results = await executor.executeAll(
      [
        { id: "tu-1", name: "fake_tool", input: { n: 1 } },
        { id: "tu-2", name: "fake_tool", input: { n: 2 } },
        { id: "tu-3", name: "fake_tool", input: { n: 3 } },
      ],
      {
        callbacks: {
          onToolStart: (_name, _input, meta) => startMetas.push(meta),
          onToolEnd: (_name, _result, _isError, meta) => endMetas.push(meta),
        },
        sessionId: "session-1",
        permissionContext: userPermissionContext,
      },
    );

    expect(results).toHaveLength(3);
    expect(startMetas).toHaveLength(3);
    expect(endMetas).toHaveLength(3);

    const groupIds = new Set([...startMetas, ...endMetas].map((meta) => meta.groupId));
    expect(groupIds.size).toBe(1);

    const orderedStarts = [...startMetas].sort((a, b) => a.displayOrder - b.displayOrder);
    const orderedEnds = [...endMetas].sort((a, b) => a.displayOrder - b.displayOrder);

    expect(orderedStarts.map((meta) => meta.displayOrder)).toEqual([0, 1, 2]);
    expect(orderedEnds.map((meta) => meta.displayOrder)).toEqual([0, 1, 2]);
    expect(orderedStarts.map((meta) => meta.toolUseId)).toEqual(["tu-1", "tu-2", "tu-3"]);
    expect(orderedEnds.map((meta) => meta.toolUseId)).toEqual(["tu-1", "tu-2", "tu-3"]);
  });

  it("attaches durationMs to every ToolResult and forwards it to onToolEnd", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "slow_tool",
      description: "deliberately slow",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object" },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { output: "ok", isError: false };
      },
    }));

    const executor = new ToolExecutor(registry);
    const callbackDurations: number[] = [];

    const results = await executor.executeAll(
      [{ id: "tu-1", name: "slow_tool", input: {} }],
      {
        callbacks: {
          onToolEnd: (_name, _result, _isError, _meta, _ui, durationMs) =>
            callbackDurations.push(durationMs),
        },
        sessionId: "session-1",
        permissionContext: userPermissionContext,
      },
    );

    expect(results).toHaveLength(1);
    expect(typeof results[0]?.durationMs).toBe("number");
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(20);
    expect(callbackDurations).toHaveLength(1);
    expect(callbackDurations[0]).toBe(results[0]?.durationMs);
  });

  it("attaches durationMs to ToolResult on missing-tool error path", async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);
    const callbackDurations: number[] = [];

    const results = await executor.executeAll(
      [{ id: "tu-1", name: "nonexistent_tool", input: {} }],
      {
        callbacks: {
          onToolEnd: (_name, _result, _isError, _meta, _ui, durationMs) =>
            callbackDurations.push(durationMs),
        },
        sessionId: "session-1",
        permissionContext: userPermissionContext,
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.is_error).toBe(true);
    expect(typeof results[0]?.durationMs).toBe("number");
    expect(callbackDurations).toHaveLength(1);
  });
});
