/**
 * MCP stdio worker ASRT-wrap wiring (worker-egress PR1).
 *
 * Confines EXTERNAL MCP stdio servers (the ones StdioTransport spawns) under the
 * ASRT sandbox: filesystem jail (write-confined to the host-derived per-server
 * sandbox root, read-deny of `~/.lvis/secrets`) + the shared strict-union
 * network (enforced by the boot config, not per command). Gate DEFAULT-OFF.
 *
 * These tests stub ASRT (`wrapWorkerCommand`) + `child_process.spawn` to assert
 * the WIRING — they do NOT exercise the real Seatbelt/bwrap backend (that is the
 * macOS runtime smoke run separately). Covered:
 *   - gate OFF  → plain spawn, args UNCHANGED, no wrap, reviewer reports `none`.
 *   - gate ON   → wrapWorkerCommand called with the FS jail (allowWrite=[root],
 *                 denyRead includes the secrets dir), spawn receives the wrapped
 *                 argv with shell:false + stdin pipe; per-platform env preserves
 *                 the secret-stripped base + the apiKey and overlays ASRT proxy
 *                 keys on win32.
 *   - reviewer  → a wrapped server's tool call reports the genuine `asrt`
 *                 capability; an UNWRAPPED server stays `none` (no-leak).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

// ─── child_process mock ─────────────────────────────────────
const spawnMock = vi.fn<
  (cmd: string, args?: readonly string[], opts?: unknown) => unknown
>();
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args?: readonly string[], opts?: unknown) =>
    spawnMock(cmd, args, opts),
}));

// ─── ASRT mock — gate + wrap controllable per test ──────────
let gateActive = false;
const wrapWorkerCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>();
const cleanupMock = vi.fn(() => Promise.resolve());
vi.mock("../../permissions/asrt-sandbox.js", () => ({
  isAsrtSandboxActive: () => gateActive,
  wrapWorkerCommand: (command: string, options?: unknown) =>
    wrapWorkerCommandMock(command, options),
  cleanupAsrtSandboxAfterCommand: () => cleanupMock(),
}));

// Module imports must come AFTER the mocks above.
import { McpClient } from "../mcp-client.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedMcpServersForTest,
  isMcpServerWrapped,
} from "../../permissions/sandbox-capability.js";
import { lvisHome } from "../../shared/lvis-home.js";
import {
  governanceWithPolicy,
  stdioApproval,
  buildPolicy,
  FakeChildProcess,
} from "./test-helpers.js";
import type { McpStdioServerConfig } from "../types.js";

// ─── Shared helpers ─────────────────────────────────────────

function handshakeResponses(serverName: string): FakeChildProcess["responses"] {
  return {
    "server/discover": (id) => ({
      id,
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "public",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      serverInfo: { name: serverName, version: "1.0.0" },
    }),
    initialize: (id) => ({
      id,
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: serverName, version: "1.0.0" },
    }),
    "tools/list": () => ({ tools: [] }),
  };
}

beforeEach(() => {
  spawnMock.mockReset();
  wrapWorkerCommandMock.mockReset();
  cleanupMock.mockClear();
  gateActive = false;
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedMcpServersForTest();
});

afterEach(() => {
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedMcpServersForTest();
});

// ─── Gate OFF — plain spawn, unchanged ──────────────────────

describe("StdioTransport ASRT wrap — gate OFF (default)", () => {
  it("spawns the worker PLAIN (no wrap) and reports reviewer 'none'", async () => {
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("fs");
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("fs", "lvis-mcp-fs")]),
    );
    const config: McpStdioServerConfig = {
      id: "fs",
      transport: "stdio",
      command: "lvis-mcp-fs",
      args: ["--root", "/tmp"],
      // Host would set this at connect time, but the gate is OFF so it is ignored.
      sandboxRoot: join(lvisHome(), "mcp", "fs", "sandbox"),
    };
    const client = new McpClient(config, gov, new ToolRegistry());

    await client.connect();

    // No wrap was attempted.
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    // The plain spawn ran with the UNMODIFIED resolved command + args.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("lvis-mcp-fs");
    expect(args).toEqual(["--root", "/tmp"]);
    // The server is NOT marked wrapped → reviewer stays none even gate-OFF.
    expect(isMcpServerWrapped("fs")).toBe(false);
    const cap = resolveReviewerSandboxCapability("mcp", "mcp_fs_read", "fs");
    expect(cap.kind).toBe("none");

    await client.disconnect();
  });
});

// ─── Gate ON — wrapped spawn + FS jail + per-platform env ───

describe("StdioTransport ASRT wrap — gate ON", () => {
  it("routes the spawn through wrapWorkerCommand with the FS jail + secrets read-deny", async () => {
    gateActive = true;
    const sandboxRoot = join(lvisHome(), "mcp", "fs", "sandbox");
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("fs");
    // ASRT (mac/linux shape): proxy baked into the command string, env=process.env.
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "sandbox-exec ... lvis-mcp-fs --root /tmp"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("fs", "lvis-mcp-fs")]),
    );
    const config: McpStdioServerConfig = {
      id: "fs",
      transport: "stdio",
      command: "lvis-mcp-fs",
      args: ["--root", "/tmp"],
      sandboxRoot,
    };
    const client = new McpClient(config, gov, new ToolRegistry());

    await client.connect();

    // wrapWorkerCommand received the quoted command line + the FS jail.
    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    const [cmdline, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowWrite: string[]; allowRead: string[]; denyRead: string[] } },
    ];
    // Command + args are shell-quoted (defensive against spaces/injection).
    expect(cmdline).toContain("'lvis-mcp-fs'");
    expect(cmdline).toContain("'--root'");
    expect(cmdline).toContain("'/tmp'");
    // Write-jail = ONLY the per-server sandbox root.
    expect(options.filesystem.allowWrite).toEqual([sandboxRoot]);
    // Read-jail re-allows the root; never HOME.
    expect(options.filesystem.allowRead).toContain(sandboxRoot);
    // The host secrets dir is read-DENIED (closes the read-jail leak).
    expect(options.filesystem.denyRead).toContain(join(lvisHome(), "secrets"));

    // spawn ran the WRAPPED argv with shell:false + a writable stdin pipe.
    const [spawnedCmd, spawnedArgs, spawnOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { stdio: unknown[]; shell: boolean },
    ];
    expect(spawnedCmd).toBe("/bin/bash");
    expect(spawnedArgs[0]).toBe("-c");
    expect(spawnOpts.shell).toBe(false);
    expect(spawnOpts.stdio[0]).toBe("pipe"); // stdin must stay writable for framing

    // The server is now marked wrapped → reviewer can report genuine asrt.
    expect(isMcpServerWrapped("fs")).toBe(true);

    await client.disconnect();
    // Close releases per-command ASRT state and clears the wrapped marker.
    expect(cleanupMock).toHaveBeenCalled();
    expect(isMcpServerWrapped("fs")).toBe(false);
  });

  it("absent sandboxRoot ⇒ DENY-ALL-WRITES wrap (fail-closed, never HOME/cwd)", async () => {
    gateActive = true;
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("nojail");
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("nojail", "lvis-mcp-nojail")]),
    );
    // Directly construct WITHOUT sandboxRoot (simulates the host invariant not
    // holding) — the wrap must grant NO writable path.
    const config: McpStdioServerConfig = {
      id: "nojail",
      transport: "stdio",
      command: "lvis-mcp-nojail",
    };
    const client = new McpClient(config, gov, new ToolRegistry());

    await client.connect();

    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowWrite: string[]; allowRead: string[]; denyRead: string[] } },
    ];
    expect(options.filesystem.allowWrite).toEqual([]); // deny-all-writes
    // No HOME / cwd ever re-allowed for write.
    expect(options.filesystem.allowWrite).not.toContain(process.env.HOME);
    expect(options.filesystem.allowWrite).not.toContain(process.cwd());

    await client.disconnect();
  });

  it("win32-shape: overlays ONLY the ASRT proxy keys, preserves apiKey + strips host secrets", async () => {
    gateActive = true;
    const sandboxRoot = join(lvisHome(), "mcp", "secure", "sandbox");
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("secure");
    // win32 shape: ASRT returns a proxy-CARRYING env (NOT process.env). It also
    // includes a host secret that must NOT propagate (it is not allow-listed).
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["C:/Git/bin/bash.exe", "-c", "wrapped"],
      env: {
        ...process.env,
        HTTP_PROXY: "http://127.0.0.1:60080",
        HTTPS_PROXY: "http://127.0.0.1:60080",
        NODE_EXTRA_CA_CERTS: "C:/tmp/ca.pem",
        SOME_HOST_SECRET: "leaked-value", // not allow-listed → must be dropped
      },
    });
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([
        stdioApproval("secure", "lvis-mcp-secure", {
          requiredAuth: "api-key",
          apiKeyEnv: "MCP_API_KEY",
        }),
      ]),
    );
    const config: McpStdioServerConfig = {
      id: "secure",
      transport: "stdio",
      command: "lvis-mcp-secure",
      auth: "api-key",
      apiKey: "secret-key",
      apiKeyEnv: "MCP_API_KEY",
      sandboxRoot,
    };
    const client = new McpClient(config, gov, new ToolRegistry());

    await client.connect();

    const [, , spawnOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    const env = spawnOpts.env;
    // ASRT proxy/CA overlay propagated (the win32 "spread").
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:60080");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("C:/tmp/ca.pem");
    // Approved per-server apiKey preserved.
    expect(env.MCP_API_KEY).toBe("secret-key");
    // A non-allow-listed host secret ASRT carried is NOT propagated.
    expect(env.SOME_HOST_SECRET).toBeUndefined();

    await client.disconnect();
  });
});

// ─── Reviewer reconciliation — wrapped→asrt, unwrapped→none ──

describe("resolveReviewerSandboxCapability — wrapped MCP worker (no-leak)", () => {
  beforeEach(() => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });
  });

  it("reports genuine asrt for a wrapped server's tool call", async () => {
    gateActive = true;
    const sandboxRoot = join(lvisHome(), "mcp", "fs", "sandbox");
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("fs");
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(fake);
    const gov = governanceWithPolicy(buildPolicy([stdioApproval("fs", "lvis-mcp-fs")]));
    const client = new McpClient(
      { id: "fs", transport: "stdio", command: "lvis-mcp-fs", sandboxRoot },
      gov,
      new ToolRegistry(),
    );
    await client.connect();

    const cap = resolveReviewerSandboxCapability("mcp", "mcp_fs_read", "fs");
    expect(cap.kind).toBe("asrt");
    expect(cap.confines).toEqual({ filesystem: true, process: true, network: true });

    await client.disconnect();
    // After close the marker is gone → back to none (no stale leak).
    expect(resolveReviewerSandboxCapability("mcp", "mcp_fs_read", "fs").kind).toBe("none");
  });

  it("reports none for an UNWRAPPED server even when the global capability is asrt", () => {
    gateActive = true;
    // A server that was never wrapped (not in the registry).
    expect(isMcpServerWrapped("other")).toBe(false);
    const cap = resolveReviewerSandboxCapability("mcp", "mcp_other_x", "other");
    expect(cap.kind).toBe("none");
  });

  it("reports none for a wrapped id once the sandbox is torn down (gate off)", () => {
    // Mark wrapped but flip the gate off (simulates teardown without unmark).
    __resetWrappedMcpServersForTest();
    gateActive = false;
    const cap = resolveReviewerSandboxCapability("mcp", "mcp_fs_read", "fs");
    expect(cap.kind).toBe("none");
  });

  it("reports none for an mcp call with NO serverId (back-compat default)", () => {
    gateActive = true;
    const cap = resolveReviewerSandboxCapability("mcp", "mcp_fs_read");
    expect(cap.kind).toBe("none");
  });
});
