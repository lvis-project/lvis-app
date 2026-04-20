/**
 * McpManager — Config mutation tests (addConfig / removeConfig / getConfigs).
 *
 * Uses tmp directory to avoid touching real ~/.lvis/mcp-servers.json.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: vi.fn(actual.rename),
  };
});

// ─── Mock McpClient so we never spawn real processes ─────────────
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockGetState = vi.fn().mockReturnValue({
  id: "test-server",
  status: "connected" as const,
  registeredTools: [],
});
const mockAuditLog = vi.fn();
const mockValidateServer = vi.fn(() => ({ valid: true as const }));

vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    connect = mockConnect;
    disconnect = mockDisconnect;
    getState = mockGetState;
  },
}));

// ─── Mock McpGovernance — allow everything ────────────────────────
vi.mock("../mcp-governance.js", () => ({
  McpGovernance: class {
    validateServer = mockValidateServer;
  },
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
    undefined,
    { log: mockAuditLog } as never,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  const actualFsPromises =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation(actualFsPromises.rename);
  if (!existsSync(testDir)) {
    await mkdir(testDir, { recursive: true });
  }
  await Promise.all([
    rm(testConfigPath, { force: true }),
    rm(`${testConfigPath}.bak`, { force: true }),
    rm(`${testConfigPath}.tmp`, { force: true }),
    rm(`${testConfigPath}.guard`, { force: true }),
  ]);
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
        apiKey: "stdio-api-secret",
        args: ["--token=abc123", "--verbose"],
        env: { SECRET_TOKEN: "abc123", PATH: "/usr/bin" },
      },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();
    const result = await mgr.getConfigs();
    expect(result).toHaveLength(2);
    // http server: apiKey and headers stripped
    expect(result[0]).not.toHaveProperty("apiKey");
    expect(result[0]).not.toHaveProperty("headers");
    // stdio server: apiKey, args, and env stripped (all can embed secrets)
    expect(result[1]).not.toHaveProperty("apiKey");
    expect(result[1]).not.toHaveProperty("args");
    expect(result[1]).not.toHaveProperty("env");
    expect(result[0].id).toBe("http-srv");
    expect(result[1].id).toBe("stdio-srv");
  });

  it("falls back to .bak when the main config file exists but is corrupt", async () => {
    const backupServers: McpServerConfig[] = [
      { id: "backup-srv", transport: "http", url: "https://example.com/mcp" },
    ];
    await writeFile(testConfigPath, "{not-json", "utf-8");
    await writeFile(`${testConfigPath}.bak`, JSON.stringify({ servers: backupServers }), "utf-8");

    const mgr = await makeManager();
    const result = await mgr.getConfigs();

    expect(result).toEqual([
      { id: "backup-srv", transport: "http", url: "https://example.com/mcp" },
    ]);
  });

  it("returns the resolved config path for renderer empty-state messaging", async () => {
    const mgr = await makeManager();
    expect(mgr.getConfigPath()).toBe(testConfigPath);
  });
});

describe("McpManager — addConfig()", () => {
  it("saves config and attempts connection", async () => {
    const mgr = await makeManager();
    const config: McpServerConfig = { id: "new-srv", transport: "stdio", command: "npx tool" };

    await expect(mgr.addConfig(config)).resolves.toEqual({ connected: true });

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers).toHaveLength(1);
    expect(raw.servers[0].id).toBe("new-srv");
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ type: "mcp_connect" }));
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

  it("returns warning when connection fails after save", async () => {
    mockConnect.mockRejectedValueOnce(new Error("connect boom"));
    const mgr = await makeManager();

    await expect(
      mgr.addConfig({ id: "warn-srv", transport: "stdio", command: "npx tool" }),
    ).resolves.toEqual({ connected: false, warning: "connect boom" });

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers.map((server) => server.id)).toContain("warn-srv");
  });

  it("does not create a new .bak when Windows rename hits EEXIST during save", async () => {
    const existingServers: McpServerConfig[] = [
      { id: "existing-srv", transport: "stdio", command: "cmd" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers: existingServers }), "utf-8");

    let firstRename = true;
    const actualFsPromises =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
      if (firstRename && oldPath === `${testConfigPath}.tmp` && newPath === testConfigPath) {
        firstRename = false;
        const err = new Error("dest exists") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      return actualFsPromises.rename(oldPath, newPath);
    });

    const mgr = await makeManager();
    await expect(
      mgr.addConfig({ id: "new-srv", transport: "stdio", command: "npx tool" }),
    ).resolves.toEqual({ connected: true });

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers.map((server) => server.id)).toEqual(["existing-srv", "new-srv"]);
    expect(existsSync(`${testConfigPath}.bak`)).toBe(false);
  });

  it("rejects governance-invalid config before save", async () => {
    mockValidateServer.mockReturnValueOnce({
      valid: false as const,
      layer: 0,
      reason: "revoked",
    });
    const mgr = await makeManager();

    await expect(
      mgr.addConfig({ id: "blocked", transport: "stdio", command: "npx tool" }),
    ).rejects.toThrow("거버넌스 검증 실패");

    expect(existsSync(testConfigPath)).toBe(false);
    expect(mockConnect).not.toHaveBeenCalled();
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

  it("emits kill-switch audit when a connected server is terminated", async () => {
    const mgr = await makeManager();
    const server = { id: "audit-srv", transport: "stdio", command: "cmd" } as const;

    await mgr.connectServer(server);
    await mgr.killSwitch(server.id);

    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ type: "kill_switch" }));
  });
});
