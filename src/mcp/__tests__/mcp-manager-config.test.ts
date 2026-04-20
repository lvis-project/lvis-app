/**
 * McpManager — Config mutation tests (addConfig / removeConfig / getConfigs).
 *
 * Uses tmp directory to avoid touching real ~/.lvis/mcp-servers.json.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

// ─── Mock McpClient so we never spawn real processes ─────────────
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockGetState = vi.fn().mockReturnValue({
  id: "test-server",
  status: "connected" as const,
  registeredTools: [],
});

vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    connect = mockConnect;
    disconnect = mockDisconnect;
    getState = mockGetState;
  },
}));

// ─── Mock McpGovernance — allow everything ────────────────────────
vi.mock("../mcp-governance.js", () => ({
  McpGovernance: class {},
}));

// ─── Mock ToolRegistry ────────────────────────────────────────────
const mockUnregisterByMcp = vi.fn();
vi.mock("../../tools/registry.js", () => ({
  ToolRegistry: class {
    unregisterByMcp = mockUnregisterByMcp;
  },
}));

import { McpManager } from "../mcp-manager.js";
import type { McpServerConfig } from "../types.js";

const testDir = join(tmpdir(), `lvis-mcp-test-${process.pid}`);
const testConfigPath = join(testDir, "mcp-servers.json");

async function makeManager() {
  const { McpGovernance } = await import("../mcp-governance.js");
  const { ToolRegistry } = await import("../../tools/registry.js");
  return new McpManager(
    new (McpGovernance as new () => InstanceType<typeof McpGovernance>)(),
    new (ToolRegistry as new () => InstanceType<typeof ToolRegistry>)(),
    testConfigPath,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (existsSync(testConfigPath)) {
    await rm(testConfigPath);
  }
  if (!existsSync(testDir)) {
    await mkdir(testDir, { recursive: true });
  }
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("McpManager — getConfigs()", () => {
  it("returns [] when config file does not exist", async () => {
    const mgr = await makeManager();
    const result = await mgr.getConfigs();
    expect(result).toEqual([]);
  });

  it("returns servers from config file", async () => {
    const servers: McpServerConfig[] = [
      { id: "srv-a", transport: "stdio", command: "uvx a" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();
    const result = await mgr.getConfigs();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("srv-a");
  });

  it("strips secret-bearing fields (apiKey, headers, env) before returning to renderer", async () => {
    const servers = [
      {
        id: "http-srv",
        transport: "http" as const,
        url: "https://example.com/mcp",
        apiKey: "super-secret",
        headers: { Authorization: "Bearer token" },
      },
      {
        id: "stdio-srv",
        transport: "stdio" as const,
        command: "npx tool",
        env: { SECRET_TOKEN: "abc123", PATH: "/usr/bin" },
      },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();
    const result = await mgr.getConfigs();
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty("apiKey");
    expect(result[0]).not.toHaveProperty("headers");
    expect(result[1]).not.toHaveProperty("env");
    expect(result[0].id).toBe("http-srv");
    expect(result[1].id).toBe("stdio-srv");
  });
});

describe("McpManager — addConfig()", () => {
  it("saves config and attempts connection", async () => {
    const mgr = await makeManager();
    const config: McpServerConfig = { id: "new-srv", transport: "stdio", command: "npx tool" };

    await mgr.addConfig(config);

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers).toHaveLength(1);
    expect(raw.servers[0].id).toBe("new-srv");
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it("throws if server id already exists", async () => {
    const servers: McpServerConfig[] = [
      { id: "dup", transport: "http", url: "https://example.com/mcp" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();

    await expect(
      mgr.addConfig({ id: "dup", transport: "stdio", command: "cmd" }),
    ).rejects.toThrow("이미 존재");
  });
});

describe("McpManager — removeConfig()", () => {
  it("removes server from config and disconnects", async () => {
    const servers: McpServerConfig[] = [
      { id: "to-remove", transport: "stdio", command: "cmd" },
      { id: "keep", transport: "stdio", command: "cmd2" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");

    const mgr = await makeManager();
    // Simulate a connected client
    await mgr.connectServer(servers[0]);

    await mgr.removeConfig("to-remove");

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers).toHaveLength(1);
    expect(raw.servers[0].id).toBe("keep");
    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockUnregisterByMcp).toHaveBeenCalledWith("to-remove");
  });

  it("is idempotent when server not in config", async () => {
    await writeFile(testConfigPath, JSON.stringify({ servers: [] }), "utf-8");
    const mgr = await makeManager();
    // Should not throw
    await expect(mgr.removeConfig("ghost")).resolves.toBeUndefined();
  });
});
