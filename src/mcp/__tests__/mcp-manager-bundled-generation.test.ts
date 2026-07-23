import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";

const disconnect = vi.fn(async () => undefined);
vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    constructor(
      private readonly config: { id: string },
      _governance: unknown,
      private readonly registry: ToolRegistry,
    ) {}
    async connect() {
      this.registry.register(createDynamicTool({
        name: "mcp_ep_api_ep_read",
        description: "read",
        source: "mcp",
        category: "network",
        mcpServerId: this.config.id,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: this.config.id, isError: false }),
      }));
    }
    disconnect = disconnect;
    getState() {
      return { id: this.config.id, status: "connected" as const, registeredTools: ["mcp_ep_api_ep_read"] };
    }
    async readResource(uri: string) { return { uri, html: "ok" }; }
    async callTool() { return { text: "ok" }; }
  },
  scrubSecrets: (value: string) => value,
}));

import { McpManager } from "../mcp-manager.js";
import { McpGovernance } from "../mcp-governance.js";
import { PluginMcpTrustStore, preparePluginMcpGeneration } from "../plugin-mcp-projection.js";

const root = mkdtempSync(join(tmpdir(), "lvis-mcp-generation-"));

function generation(generationId: string): ActivePluginGeneration {
  return {
    pluginId: "ep-api",
    pluginVersion: "1.0.0",
    artifactGenerationId: "a".repeat(64),
    generationId,
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [{
      ownerPluginId: "ep-api",
      ownerVersion: "1.0.0",
      kind: "mcpServer",
      localId: "ep",
      path: "mcp/ep.json",
      fingerprint: "a".repeat(64),
      files: [{
        path: "mcp/ep.json",
        sha256: "a".repeat(64),
        content: JSON.stringify({ transport: "http", url: "https://ep.example.test/mcp" }),
      }],
    }],
  };
}

afterAll(async () => rm(root, { recursive: true, force: true }));
beforeEach(() => {
  disconnect.mockReset();
  disconnect.mockResolvedValue(undefined);
});

describe("McpManager bundled generation", () => {
  it("prepares hidden, atomically swaps stable tools, and exact-gates stale calls", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(
      new McpGovernance(join(root, "policy.json")),
      registry,
      join(root, "servers.json"),
    );
    const active = { current: "g1" };
    const acquireExact = vi.fn(async (_pluginId: string, generationId: string) => {
      if (generationId !== active.current) throw new Error("stale generation");
      return { generation: { generationId } as never, release: vi.fn() };
    });
    manager.setPluginGenerationAccess({
      getActive: vi.fn(() => undefined),
      isExactAdmitted: vi.fn(() => true),
      acquire: vi.fn(async () => { throw new Error("not used"); }),
      acquireExact,
      runWithLease: vi.fn(async (_lease, operation) => operation()),
    });

    const trust = new PluginMcpTrustStore();
    const g1Projection = preparePluginMcpGeneration(generation("g1"), root)[0];
    trust.approve(g1Projection);
    const g1 = await manager.prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g1" },
      [g1Projection],
      trust,
    );
    expect(registry.findByName("mcp_ep_api_ep_read")).toBeUndefined();
    manager.publishBundledGeneration(g1);
    const oldTool = registry.findByName("mcp_ep_api_ep_read");
    expect(oldTool?.mcpServerId).toBe(g1Projection.serverId);

    const g2Projection = preparePluginMcpGeneration(generation("g2"), root)[0];
    expect(trust.isApproved(g2Projection)).toBe(true);
    const g2 = await manager.prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g2" },
      [g2Projection],
      trust,
    );
    expect(registry.findByName("mcp_ep_api_ep_read")?.mcpServerId).toBe(g1Projection.serverId);
    active.current = "g2";
    manager.publishBundledGeneration(g2);
    expect(registry.findByName("mcp_ep_api_ep_read")?.mcpServerId).toBe(g2Projection.serverId);
    await expect(oldTool?.execute({}, {} as never)).rejects.toThrow(/stale generation/);
    await expect(registry.findByName("mcp_ep_api_ep_read")?.execute({}, {} as never)).resolves.toMatchObject({ isError: false });
  });

  it("retains a discarded candidate handle until disconnect succeeds", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(
      new McpGovernance(join(root, "policy-retry.json")),
      registry,
      join(root, "servers-retry.json"),
    );
    const trust = new PluginMcpTrustStore();
    const projection = preparePluginMcpGeneration(generation("g-retry"), root)[0];
    trust.approve(projection);
    const prepared = await manager.prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g-retry" },
      [projection],
      trust,
    );

    disconnect.mockRejectedValueOnce(
      Object.assign(new Error("transport still owns child"), { code: "EBUSY" }),
    );
    await expect(manager.discardBundledGeneration(prepared)).rejects.toThrow(
      /cleanup remains pending/,
    );

    await expect(manager.discardBundledGeneration(prepared)).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
