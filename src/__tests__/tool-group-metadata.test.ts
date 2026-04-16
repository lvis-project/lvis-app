import { describe, it, expect, vi, beforeEach } from "vitest";

const runPreHooks = vi.fn(async () => ({ action: "allow" as const, feedback: "" }));
const runPostHooks = vi.fn(async () => "");
const auditLog = vi.fn();

vi.mock("../hooks/hook-runner.js", () => ({
  HookRunner: vi.fn().mockImplementation(() => ({
    runPreHooks,
    runPostHooks,
  })),
}));

vi.mock("../audit/audit-logger.js", () => ({
  AuditLogger: vi.fn().mockImplementation(() => ({
    log: auditLog,
    logTurn: vi.fn(),
  })),
}));

vi.mock("../audit/dlp-filter.js", () => ({
  maskSensitiveData: vi.fn((input: string) => ({ masked: input, detections: [] })),
}));

import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import { createDynamicTool } from "../tools/base.js";

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
        onToolStart: (_name, _input, meta) => startMetas.push(meta),
        onToolEnd: (_name, _result, _isError, meta) => endMetas.push(meta),
      },
      "session-1",
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
});
