/**
 * #885 b3 — McpManager `onServerDisconnected` emission.
 *
 * The sink must fire EXACTLY on the 3 *teardown* (permanent-retirement) paths —
 * killSwitch, removeConfig, disconnectAll — and NEVER on the 2 *reconnect*
 * paths (setApiKey, connectServer's error re-establish), which re-create the
 * same server id and would otherwise disable a card about to become valid again
 * with no reverse re-enable (MINOR-1). Uses http transport so connectServer
 * never mkdir's a stdio sandbox root.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockGetState = vi.fn().mockReturnValue({
  id: "test-server",
  status: "connected" as const,
  registeredTools: [],
});
const mockValidateServer = vi.fn(() => ({ valid: true as const }));
const mockUnregisterByMcp = vi.fn();

vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    connect = mockConnect;
    disconnect = mockDisconnect;
    getState = mockGetState;
  },
  scrubSecrets: (s: string) => s,
}));
vi.mock("../mcp-governance.js", () => ({
  McpGovernance: class {
    validateServer = mockValidateServer;
  },
}));
vi.mock("../../tools/registry.js", () => ({
  ToolRegistry: class {
    unregisterByMcp = mockUnregisterByMcp;
  },
}));

import { McpManager } from "../mcp-manager.js";
import type { McpServerConfig } from "../types.js";

// Unique random temp dir (mkdtempSync) — not a predictable tmpdir()+pid path, so
// no symlink/race on a shared temp dir (CodeQL js/insecure-temporary-file).
const testDir = mkdtempSync(join(tmpdir(), "lvis-mcp-disc-"));
const testConfigPath = join(testDir, "mcp-servers.json");

async function makeManager(onServerDisconnected: (id: string) => void) {
  const { McpGovernance } = await import("../mcp-governance.js");
  const { ToolRegistry } = await import("../../tools/registry.js");
  return new McpManager(
    new (McpGovernance as new () => InstanceType<typeof McpGovernance>)(),
    new (ToolRegistry as new () => InstanceType<typeof ToolRegistry>)(),
    testConfigPath,
    undefined,
    { log: vi.fn() } as never,
    undefined,
    onServerDisconnected,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockValidateServer.mockImplementation(() => ({ valid: true as const }));
  mockGetState.mockReturnValue({ id: "test-server", status: "connected" as const, registeredTools: [] });
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const httpServer = (id: string): McpServerConfig => ({
  id,
  transport: "http",
  url: "https://example.com/mcp",
});

describe("teardown paths EMIT onServerDisconnected (exactly once each)", () => {
  it("killSwitch emits once with the serverId", async () => {
    const sink = vi.fn();
    const mgr = await makeManager(sink);
    await mgr.connectServer(httpServer("kill-srv"));
    await mgr.killSwitch("kill-srv");
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith("kill-srv");
  });

  it("removeConfig emits once for a present, connected server", async () => {
    await writeFile(testConfigPath, JSON.stringify({ servers: [httpServer("rm-srv")] }), "utf-8");
    const sink = vi.fn();
    const mgr = await makeManager(sink);
    await mgr.connectServer(httpServer("rm-srv"));
    await mgr.removeConfig("rm-srv");
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith("rm-srv");
  });

  it("disconnectAll emits once per connected id", async () => {
    const sink = vi.fn();
    const mgr = await makeManager(sink);
    await mgr.connectServer(httpServer("a"));
    await mgr.connectServer(httpServer("b"));
    await mgr.disconnectAll();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
  });
});

describe("reconnect/replace paths EMIT ZERO (MINOR-1 regression)", () => {
  it("setApiKey does NOT emit (disconnect immediately followed by reconnect)", async () => {
    const servers: McpServerConfig[] = [
      { id: "key-srv", transport: "http", url: "https://example.com/mcp", auth: "api-key", apiKeyEnv: "MY_KEY" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const sink = vi.fn();
    const mgr = await makeManager(sink);
    await mgr.connectServer(servers[0]);
    await mgr.setApiKey("key-srv", "sk-new");
    expect(mockDisconnect).toHaveBeenCalled(); // it DID disconnect...
    expect(sink).not.toHaveBeenCalled(); // ...but MUST NOT emit a retirement
  });

  it("connectServer's error-reconnect path does NOT emit", async () => {
    const sink = vi.fn();
    const mgr = await makeManager(sink);
    await mgr.connectServer(httpServer("recon-srv"));
    // The existing client is now in an error/disconnected state → connectServer
    // disconnects + deletes it before re-connecting the same id (a reconnect).
    mockGetState.mockReturnValue({ id: "recon-srv", status: "error" as const, registeredTools: [] });
    await mgr.connectServer(httpServer("recon-srv"));
    expect(mockDisconnect).toHaveBeenCalled(); // the stale client was disconnected...
    expect(sink).not.toHaveBeenCalled(); // ...but that is NOT a retirement
  });
});
