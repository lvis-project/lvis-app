import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";
import { ToolRegistry } from "../../tools/registry.js";

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
    artifactGenerationId: version === "1.0.0" && fingerprint === "a".repeat(64)
      ? "a".repeat(64)
      : "b".repeat(64),
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

function stdioGeneration(generationId: string): ActivePluginGeneration {
  const base = generation("1.0.0", generationId);
  const contribution = base.contributions[0];
  return {
    ...base,
    contributions: [{
      ...contribution,
      files: [{
        ...contribution.files[0],
        content: JSON.stringify({
          transport: "stdio",
          command: "node",
          args: ["./server.mjs"],
        }),
      }],
    }],
  };
}

const testDir = mkdtempSync(join(tmpdir(), "lvis-plugin-mcp-"));
const previousLvisHome = process.env.LVIS_HOME;
const configPath = join(testDir, "servers.json");
const registerRuntimeApproval = vi.fn();
const unregisterRuntimeApproval = vi.fn();
const replaceRuntimeApprovals = vi.fn();
const prepareRuntimeApprovals = vi.fn((predecessors, approvals) => ({
  publish: () => replaceRuntimeApprovals(predecessors, approvals),
}));
const scopedRuntimeApproval = vi.fn(() => ({
  applyToolNamespace: (_serverId: string, toolName: string) => toolName,
}));

function manager(): McpManager {
  return new McpManager(
    {
      registerRuntimeApproval,
      unregisterRuntimeApproval,
      replaceRuntimeApprovals,
      prepareRuntimeApprovals,
      scopedRuntimeApproval,
      applyToolNamespace: (_serverId: string, toolName: string) => toolName,
    } as never,
    new ToolRegistry(),
    configPath,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.LVIS_HOME = testDir;
  connect.mockResolvedValue(undefined);
  await writeFile(configPath, JSON.stringify({ servers: [] }), "utf8");
  await mkdir(join(testDir, "mcp"), { recursive: true });
  await writeFile(join(testDir, "mcp", "server.mjs"), "process.exit(0)", "utf8");
});

afterAll(async () => {
  if (previousLvisHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = previousLvisHome;
  await rm(testDir, { recursive: true, force: true });
});

describe("plugin-owned MCP projections", () => {
  it("prepares statically and requires exact approval before any connection side effect", async () => {
    const [projection] = preparePluginMcpGeneration(generation(), testDir);
    const trust = new PluginMcpTrustStore();
    const prepared = await manager().prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g1" },
      [projection],
      trust,
    );
    expect(prepared.records).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(registerRuntimeApproval).not.toHaveBeenCalled();
  });

  it("rejects a bundled MCP projection without an exact activation identity", async () => {
    const [projection] = preparePluginMcpGeneration(generation(), testDir);
    const missingActivation = {
      ...projection,
      owner: { ...projection.owner, activationId: undefined },
    };
    await expect(manager().prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g1" },
      [missingActivation] as never,
      new PluginMcpTrustStore(),
    )).rejects.toThrow(/activation identity is missing/);
  });

  it("connects an approved descriptor without persisting it to global config", async () => {
    const [projection] = preparePluginMcpGeneration(generation(), testDir);
    const trust = new PluginMcpTrustStore();
    trust.approve(projection);
    const mgr = manager();
    const prepared = await mgr.prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g1" },
      [projection],
      trust,
    );
    mgr.publishBundledGeneration(prepared);
    expect(mgr.getServerState(projection.serverId)).toEqual(expect.objectContaining({
      status: "connected",
      registeredTools: ["mcp_ep_read"],
    }));
    expect(replaceRuntimeApprovals).toHaveBeenCalledWith([], [projection.approval]);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ servers: [] });
  });

  it("degrades failed connection to zero tools without rolling back the bundle", async () => {
    connect.mockRejectedValueOnce(new Error("secret endpoint unavailable"));
    const [projection] = preparePluginMcpGeneration(generation(), testDir);
    const trust = new PluginMcpTrustStore();
    trust.approve(projection);
    const mgr = manager();
    const prepared = await mgr.prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g1" },
      [projection],
      trust,
    );
    expect(prepared.records).toEqual([]);
    expect(mgr.getServerState(projection.serverId)).toBeUndefined();
    expect(unregisterRuntimeApproval).not.toHaveBeenCalled();
  });

  it("does not transfer approval across version or fingerprint, but restores identical bytes", () => {
    const trust = new PluginMcpTrustStore();
    const [approved] = preparePluginMcpGeneration(generation(), testDir);
    trust.approve(approved);
    expect(trust.isApproved(preparePluginMcpGeneration(generation("2.0.0", "g2"), testDir)[0])).toBe(false);
    expect(trust.isApproved(preparePluginMcpGeneration(generation("1.0.0", "g2", "b".repeat(64)), testDir)[0])).toBe(false);
    expect(trust.isApproved(preparePluginMcpGeneration(generation("1.0.0", "restored"), testDir)[0])).toBe(true);
  });

  it("tears down only servers owned by the retired generation", async () => {
    const trust = new PluginMcpTrustStore();
    const first = preparePluginMcpGeneration(generation("1.0.0", "g1"), testDir)[0];
    const second = preparePluginMcpGeneration(
      generation("1.0.0", "g2", "b".repeat(64)),
      testDir,
    )[0];
    trust.approve(first);
    trust.approve(second);
    const mgr = manager();
    const firstPrepared = await mgr.prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g1" },
      [first],
      trust,
    );
    mgr.publishBundledGeneration(firstPrepared);
    const secondPrepared = await mgr.prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g2" },
      [second],
      trust,
    );
    mgr.publishBundledGeneration(secondPrepared);
    await mgr.disconnectBundledGeneration("ep-api", "g1");
    expect(mgr.getServerState(first.serverId)).toBeUndefined();
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
    expect(() => preparePluginMcpGeneration(candidate, testDir)).toThrow(/unsupported fields: id/);
  });

  it("anchors bundled stdio scripts and includes their bytes in the trust fingerprint", () => {
    const stdio = stdioGeneration("g1");
    const contribution = stdio.contributions[0];
    const [projection] = preparePluginMcpGeneration(stdio, testDir);
    expect(projection.config).toMatchObject({
      command: "node",
      args: [expect.stringMatching(/[\\/]mcp[\\/]server\.mjs$/)],
    });
    expect(projection.owner.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.owner.fingerprint).not.toBe(contribution.fingerprint);
  });

  it("reuses identical HTTP identity but restarts identical stdio for each activation", async () => {
    const httpG1 = preparePluginMcpGeneration(generation("1.0.0", "g1"), testDir)[0];
    const httpG2 = preparePluginMcpGeneration(generation("1.0.0", "g2"), testDir)[0];
    expect(httpG2.serverId).toBe(httpG1.serverId);

    const stdioG1 = preparePluginMcpGeneration(stdioGeneration("g1"), testDir)[0];
    const stdioG2 = preparePluginMcpGeneration(stdioGeneration("g2"), testDir)[0];
    expect(stdioG2.serverId).not.toBe(stdioG1.serverId);

    const trust = new PluginMcpTrustStore();
    trust.approve(stdioG1);
    expect(trust.isApproved(stdioG2)).toBe(true);
    const mgr = manager();
    const first = await mgr.prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g1" },
      [stdioG1],
      trust,
    );
    mgr.publishBundledGeneration(first);
    const second = await mgr.prepareBundledGeneration(
      { pluginId: "ep-api", generationId: "g2" },
      [stdioG2],
      trust,
    );
    mgr.publishBundledGeneration(second);

    expect(connect).toHaveBeenCalledTimes(2);
    await mgr.disconnectBundledGeneration("ep-api", "g1");
    expect(mgr.getServerState(stdioG1.serverId)).toBeUndefined();
    expect(mgr.getServerState(stdioG2.serverId)).toBeDefined();
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
    const [projection] = preparePluginMcpGeneration(generation(), testDir);
    expect(governance.validateServer(projection.config).valid).toBe(false);
    governance.registerRuntimeApproval(projection.approval);
    expect(governance.validateServer(projection.config)).toEqual({ valid: true });
    governance.unregisterRuntimeApproval(projection.serverId);
    expect(governance.validateServer(projection.config).valid).toBe(false);
  });
});
