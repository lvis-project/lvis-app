import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";

const connect = vi.fn(async () => undefined);
const disconnect = vi.fn(async () => undefined);
const getState = vi.fn(() => ({ id: "plugin", status: "connected" as const, registeredTools: ["mcp_ep_read"] }));

vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    connect = connect;
    disconnect = disconnect;
    getState = getState;
  },
  scrubSecrets: (value: string) => value.replaceAll("secret", "[REDACTED]"),
}));

import { McpManager } from "../mcp-manager.js";
import { McpGovernance } from "../mcp-governance.js";
import { PluginMcpTrustStore, preparePluginMcpGeneration } from "../plugin-mcp-projection.js";

function generation(version = "1.0.0", generationId = "g1", fingerprint = "a".repeat(64)): ActivePluginGeneration {
  return {
    pluginId: "ep-api",
    pluginVersion: version,
    generationId,
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [{
      ownerPluginId: "ep-api",
      ownerVersion: version,
      kind: "mcpServer",
      localId: "ep",
      path: "mcp/ep.json",
      fingerprint,
      files: [{
        path: "mcp/ep.json",
        sha256: fingerprint,
        content: JSON.stringify({ transport: "http", url: "https://ep.example.test/mcp" }),
      }],
    }],
  };
}

const testDir = mkdtempSync(join(tmpdir(), "lvis-plugin-mcp-"));
const configPath = join(testDir, "servers.json");
const unregisterByMcp = vi.fn();
const registerRuntimeApproval = vi.fn();
const unregisterRuntimeApproval = vi.fn();

function manager(): McpManager {
  return new McpManager(
    {
      registerRuntimeApproval,
      unregisterRuntimeApproval,
      applyToolNamespace: (_serverId: string, toolName: string) => toolName,
    } as never,
    { unregisterByMcp, listAll: vi.fn(() => []) } as never,
    configPath,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  connect.mockResolvedValue(undefined);
  await writeFile(configPath, JSON.stringify({ servers: [] }), "utf8");
  await mkdir(join(testDir, "mcp"), { recursive: true });
  await writeFile(join(testDir, "mcp", "server.mjs"), "process.exit(0)", "utf8");
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("plugin-owned MCP projections", () => {
  it("prepares statically and requires exact approval before any connection side effect", async () => {
    const [projection] = preparePluginMcpGeneration(generation());
    const trust = new PluginMcpTrustStore();
    const result = await manager().connectBundledServer(projection, trust);
    expect(result).toEqual(expect.objectContaining({ status: "approval_required", registeredTools: [] }));
    expect(connect).not.toHaveBeenCalled();
    expect(registerRuntimeApproval).not.toHaveBeenCalled();
  });

  it("connects an approved descriptor without persisting it to global config", async () => {
    const [projection] = preparePluginMcpGeneration(generation());
    const trust = new PluginMcpTrustStore();
    trust.approve(projection);
    const result = await manager().connectBundledServer(projection, trust);
    expect(result).toEqual(expect.objectContaining({ status: "connected", registeredTools: ["mcp_ep_read"] }));
    expect(registerRuntimeApproval).toHaveBeenCalledWith(projection.approval);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ servers: [] });
  });

  it("degrades failed connection to zero tools without rolling back the bundle", async () => {
    connect.mockRejectedValueOnce(new Error("secret endpoint unavailable"));
    const [projection] = preparePluginMcpGeneration(generation());
    const trust = new PluginMcpTrustStore();
    trust.approve(projection);
    const mgr = manager();
    const result = await mgr.connectBundledServer(projection, trust);
    expect(result).toEqual(expect.objectContaining({
      status: "degraded",
      error: "[REDACTED] endpoint unavailable",
      registeredTools: [],
    }));
    expect(unregisterByMcp).toHaveBeenCalledWith(projection.serverId);
    expect(unregisterRuntimeApproval).toHaveBeenCalledWith(projection.serverId);
  });

  it("does not transfer approval across version or fingerprint, but restores identical bytes", () => {
    const trust = new PluginMcpTrustStore();
    const [approved] = preparePluginMcpGeneration(generation());
    trust.approve(approved);
    expect(trust.isApproved(preparePluginMcpGeneration(generation("2.0.0", "g2"))[0])).toBe(false);
    expect(trust.isApproved(preparePluginMcpGeneration(generation("1.0.0", "g2", "b".repeat(64)))[0])).toBe(false);
    expect(trust.isApproved(preparePluginMcpGeneration(generation("1.0.0", "restored"))[0])).toBe(true);
  });

  it("tears down only servers owned by the retired generation", async () => {
    const trust = new PluginMcpTrustStore();
    const first = preparePluginMcpGeneration(generation("1.0.0", "g1"))[0];
    const second = preparePluginMcpGeneration(generation("1.0.0", "g2"))[0];
    trust.approve(first);
    trust.approve(second);
    const mgr = manager();
    await mgr.connectBundledServer(first, trust);
    await mgr.connectBundledServer(second, trust);
    await mgr.disconnectBundledGeneration("ep-api", "g1");
    expect(unregisterByMcp).toHaveBeenCalledWith(first.serverId);
    expect(unregisterByMcp).not.toHaveBeenCalledWith(second.serverId);
    expect(mgr.getServerState(second.serverId)).toBeDefined();
  });

  it("rejects descriptor-owned identity and unsupported static fields", () => {
    const broken = generation();
    const contribution = broken.contributions[0];
    const candidate: ActivePluginGeneration = {
      ...broken,
      contributions: [{
        ...contribution,
        files: [{ ...contribution.files[0], content: JSON.stringify({ id: "shadow", transport: "http", url: "https://example.test" }) }],
      }],
    };
    expect(() => preparePluginMcpGeneration(candidate)).toThrow(/unsupported fields: id/);
  });

  it("anchors bundled stdio scripts and includes their bytes in the trust fingerprint", () => {
    const base = generation();
    const contribution = base.contributions[0];
    const stdio: ActivePluginGeneration = {
      ...base,
      contributions: [{
        ...contribution,
        files: [{
          ...contribution.files[0],
          content: JSON.stringify({ transport: "stdio", command: "node", args: ["./server.mjs"] }),
        }],
      }],
    };
    const [projection] = preparePluginMcpGeneration(stdio, testDir);
    expect(projection.config).toMatchObject({
      command: "node",
      args: [expect.stringMatching(/\/mcp\/server\.mjs$/)],
    });
    expect(projection.owner.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.owner.fingerprint).not.toBe(contribution.fingerprint);
  });

  it("installs and removes the ephemeral governance rule without changing managed policy", async () => {
    const policyPath = join(testDir, "policy.json");
    await writeFile(policyPath, JSON.stringify({
      version: "1.0",
      defaultPolicy: "deny",
      servers: [],
      globalRules: {
        maxServersTotal: 10,
        blockedUrlPatterns: [],
        allowedUrlPatterns: [],
        policyRefreshIntervalMs: 60_000,
      },
    }), "utf8");
    const governance = new McpGovernance(policyPath);
    const [projection] = preparePluginMcpGeneration(generation());
    expect(governance.validateServer(projection.config).valid).toBe(false);
    governance.registerRuntimeApproval(projection.approval);
    expect(governance.validateServer(projection.config)).toEqual({ valid: true });
    governance.unregisterRuntimeApproval(projection.serverId);
    expect(governance.validateServer(projection.config).valid).toBe(false);
  });
});
