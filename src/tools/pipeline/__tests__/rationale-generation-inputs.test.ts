import { afterEach, describe, expect, it } from "vitest";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedMcpServersForTest,
  __resetWrappedPluginWorkersForTest,
  clearWrappedMcpServers,
  clearWrappedPluginWorkers,
  getSandboxGeneration,
  markMcpServerWrapped,
  markPluginWorkerWrapped,
  setActiveSandboxCapability,
  unmarkMcpServerWrapped,
  unmarkPluginWorkerWrapped,
} from "../../../permissions/sandbox-capability.js";
import { createDynamicTool } from "../../base.js";
import { ToolRegistry } from "../../registry.js";

afterEach(() => {
  __resetWrappedMcpServersForTest();
  __resetWrappedPluginWorkersForTest();
  __resetActiveSandboxCapabilityForTest();
});

describe("rationale action generation inputs", () => {
  it("propagates parent ToolRegistry mutations into a scoped generation and ignores missing MCP removals", () => {
    const parent = new ToolRegistry();
    const scoped = parent.createScopedView([]);
    const initial = scoped.getGeneration();

    parent.register(createDynamicTool({
      name: "rationale_probe",
      description: "probe",
      source: "builtin",
      category: "read",
      version: "1.0.0",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }));
    const changed = scoped.getGeneration();
    expect(changed).not.toBe(initial);

    parent.unregisterByMcp("missing-server");
    expect(scoped.getGeneration()).toBe(changed);
  });

  it.each(["win32", "darwin", "linux"] as const)(
    "changes sandbox capability generation on %s through the common setter",
    (platform) => {
      __resetActiveSandboxCapabilityForTest();
      const before = getSandboxGeneration();
      setActiveSandboxCapability({
        kind: "asrt",
        confidence: "verified",
        platform,
        reason: "test capability",
        confines: {
          filesystem: true,
          process: platform !== "win32",
          network: true,
        },
      });
      expect(getSandboxGeneration()).not.toBe(before);
    },
  );

  it("changes MCP and plugin-worker generations exactly once per real membership mutation", () => {
    clearWrappedMcpServers();
    clearWrappedPluginWorkers();
    const empty = getSandboxGeneration();
    clearWrappedMcpServers();
    clearWrappedPluginWorkers();
    expect(getSandboxGeneration()).toBe(empty);

    markMcpServerWrapped("mcp-a");
    const mcpAdded = getSandboxGeneration();
    expect(mcpAdded).not.toBe(empty);
    markMcpServerWrapped("mcp-a");
    unmarkMcpServerWrapped("missing-mcp");
    expect(getSandboxGeneration()).toBe(mcpAdded);

    unmarkMcpServerWrapped("mcp-a");
    const mcpRemoved = getSandboxGeneration();
    expect(mcpRemoved).not.toBe(mcpAdded);

    markPluginWorkerWrapped("plugin-a", "worker-a");
    const workerAdded = getSandboxGeneration();
    expect(workerAdded).not.toBe(mcpRemoved);
    markPluginWorkerWrapped("plugin-a", "worker-a");
    unmarkPluginWorkerWrapped("plugin-a", "missing-worker");
    expect(getSandboxGeneration()).toBe(workerAdded);

    unmarkPluginWorkerWrapped("plugin-a", "worker-a");
    expect(getSandboxGeneration()).not.toBe(workerAdded);
  });
});
