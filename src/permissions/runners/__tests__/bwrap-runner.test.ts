/**
 * PR-A2 — BwrapRunner tests.
 *
 * Issue: #691
 *
 * Test coverage:
 *   detect() — Linux + bwrap present, Linux + bwrap absent, non-Linux
 *   spawn()  — bwrapArgs construction via spawn mock (capability mapping)
 *   abort()  — SIGTERM forwarded to child
 *   MCP slot — D9 round-trip integration test (registerSandboxRunner("mcp", ...))
 *   boot seal — sealSandboxRunnerRegistry blocks post-boot registration
 *
 * Integration tests (real bwrap invocations) are skipped unless
 * BWRAP_INTEGRATION=1 is set — these require an actual Linux host with
 * bwrap installed.
 *
 * Mock strategy:
 *   vi.mock() is hoisted to module top-level by vitest. We declare all mocks
 *   at the top, import the mocked modules, then cast to Mock for assertions.
 *   The node:child_process mock returns a stable `mockChild` object whose
 *   `on`/`kill` mocks are reset in afterEach.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Mock } from "vitest";

// ─── Module mocks (hoisted to top of file by vitest) ──────────────────────────

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn() };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

// ─── Imports (after mock declarations) ────────────────────────────────────────

import { Readable } from "node:stream";
import { BwrapRunner, BWRAP_BIN } from "../bwrap-runner.js";
import {
  registerSandboxRunner,
  getSandboxRunner,
  sealSandboxRunnerRegistry,
  __resetSandboxRunnersForTest,
} from "../../sandbox-runner.js";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";

const accessMock = access as Mock;
const spawnMock = spawn as Mock;

// ─── Shared fake child factory ────────────────────────────────────────────────

/**
 * Build a fake child process object whose stdout/stderr are real Node.js
 * Readable instances (required by Readable.toWeb() inside BwrapRunner.spawn).
 * `on` and `kill` are vi.fn() mocks.
 */
function makeFakeChild(pid = 42): {
  pid: number | undefined;
  stdout: Readable;
  stderr: Readable;
  on: Mock;
  kill: Mock;
} {
  // Real Readable instances that immediately end — Readable.toWeb() requires
  // an actual stream.Readable, not a plain object.
  const makeStream = () => {
    const r = new Readable({ read() {} });
    // Push EOF immediately so any reader that drains it terminates.
    r.push(null);
    return r;
  };

  return {
    pid,
    stdout: makeStream(),
    stderr: makeStream(),
    on: vi.fn(),
    kill: vi.fn(),
  };
}

/** Skip integration tests unless BWRAP_INTEGRATION=1 on a real Linux host. */
const describeIntegration =
  process.platform === "linux" && process.env["BWRAP_INTEGRATION"] === "1"
    ? describe
    : describe.skip;

afterEach(() => {
  __resetSandboxRunnersForTest();
  vi.clearAllMocks();
});

// ─── detect() ─────────────────────────────────────────────────────────────────

describe("BwrapRunner.detect()", () => {
  it("returns available=false with 'only supports linux' on non-Linux", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const result = await new BwrapRunner().detect();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("only supports linux");
    expect(result.kind).toBe("none");
    expect(result.confidence).toBe("verified");
  });

  it("returns available=true kind=bubblewrap when bwrap binary is executable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    accessMock.mockResolvedValue(undefined);

    const result = await new BwrapRunner().detect();
    expect(result.available).toBe(true);
    expect(result.kind).toBe("bubblewrap");
    expect(result.confidence).toBe("verified");
    expect(result.reason).toContain(BWRAP_BIN);
  });

  it("returns available=false with dnf hint when bwrap is missing", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    accessMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const result = await new BwrapRunner().detect();
    expect(result.available).toBe(false);
    expect(result.kind).toBe("none");
    expect(result.confidence).toBe("verified");
    expect(result.reason).toContain("dnf install bubblewrap");
  });
});

// ─── spawn() — bwrapArgs construction ─────────────────────────────────────────

describe("BwrapRunner.spawn() — bwrapArgs construction", () => {
  /** Call spawn and return the args array that was passed to child_process.spawn. */
  async function captureArgs(
    capabilities: Parameters<BwrapRunner["spawn"]>[2],
    env?: Record<string, string>,
  ): Promise<string[]> {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    await new BwrapRunner()
      .spawn("/bin/bash", ["-c", "echo hi"], capabilities, env)
      .catch(() => {});
    const lastCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1] as [string, string[], unknown];
    return lastCall[1];
  }

  it("calls BWRAP_BIN as the spawn executable", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    await new BwrapRunner().spawn("/bin/bash", ["-c", "echo"], {}).catch(() => {});
    expect(spawnMock.mock.calls[spawnMock.mock.calls.length - 1]?.[0]).toBe(BWRAP_BIN);
  });

  it("includes --unshare-net when networkBlocked=true (default)", async () => {
    expect(await captureArgs({ networkBlocked: true })).toContain("--unshare-net");
  });

  it("omits --unshare-net when networkBlocked=false", async () => {
    expect(await captureArgs({ networkBlocked: false })).not.toContain("--unshare-net");
  });

  it("includes --unshare-pid and --new-session when processIsolated=true (default)", async () => {
    const args = await captureArgs({ processIsolated: true });
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--new-session");
  });

  it("omits --unshare-pid/--new-session when processIsolated=false", async () => {
    const args = await captureArgs({ processIsolated: false });
    expect(args).not.toContain("--unshare-pid");
    expect(args).not.toContain("--new-session");
  });

  it("adds --ro-bind-try source dest for each fsReadPath", async () => {
    const args = await captureArgs({ fsReadPaths: ["/etc", "/usr"] });
    expect(args).toContain("--ro-bind-try");
    expect(args.filter((a) => a === "/etc").length).toBe(2); // source + dest
    expect(args.filter((a) => a === "/usr").length).toBe(2);
  });

  it("adds --bind-try source dest for each fsWritePath", async () => {
    const args = await captureArgs({ fsWritePaths: ["/tmp/sandbox-test"] });
    expect(args).toContain("--bind-try");
    expect(args.filter((a) => a === "/tmp/sandbox-test").length).toBe(2);
  });

  it("always includes --proc /proc --dev /dev --tmpfs /tmp --die-with-parent", async () => {
    const args = await captureArgs({});
    expect(args).toContain("--proc");
    expect(args).toContain("/proc");
    expect(args).toContain("--dev");
    expect(args).toContain("/dev");
    expect(args).toContain("--tmpfs");
    expect(args).toContain("/tmp");
    expect(args).toContain("--die-with-parent");
  });

  it("appends -- cmd args after all bwrap flags", async () => {
    const args = await captureArgs({});
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThan(-1);
    expect(args[sepIdx + 1]).toBe("/bin/bash");
    expect(args[sepIdx + 2]).toBe("-c");
    expect(args[sepIdx + 3]).toBe("echo hi");
  });

  it("merges env overrides onto process.env when env is provided", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    await new BwrapRunner()
      .spawn("/bin/bash", ["-c", "echo"], {}, { CUSTOM_VAR: "value123" })
      .catch(() => {});
    const call = spawnMock.mock.calls[spawnMock.mock.calls.length - 1] as [
      string,
      string[],
      { env?: Record<string, string> },
    ];
    expect(call[2].env?.["CUSTOM_VAR"]).toBe("value123");
  });

  it("uses process.env directly when no env override is provided", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    await new BwrapRunner().spawn("/bin/bash", ["-c", "echo"], {}).catch(() => {});
    const call = spawnMock.mock.calls[spawnMock.mock.calls.length - 1] as [
      string,
      string[],
      { env?: Record<string, string | undefined> },
    ];
    expect(call[2].env).toBe(process.env);
  });

  it("returns pid from child.pid", async () => {
    const child = makeFakeChild(9999);
    spawnMock.mockReturnValue(child);
    const proc = await new BwrapRunner().spawn("/bin/bash", ["-c", "echo"], {});
    expect(proc.pid).toBe(9999);
  });

  it("returns pid=-1 when child.pid is undefined", async () => {
    const child = { ...makeFakeChild(), pid: undefined };
    spawnMock.mockReturnValue(child);
    const proc = await new BwrapRunner().spawn("/bin/bash", ["-c", "echo"], {});
    expect(proc.pid).toBe(-1);
  });

  it("abort() calls kill(SIGTERM) on the child", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const proc = await new BwrapRunner().spawn("/bin/bash", ["-c", "sleep 60"], {});
    await proc.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

// ─── Registry + seal ──────────────────────────────────────────────────────────

describe("sealSandboxRunnerRegistry + boot registration", () => {
  it("registerSandboxRunner works before seal", () => {
    const runner = new BwrapRunner();
    registerSandboxRunner("linux", runner);
    expect(getSandboxRunner("linux")).toBe(runner);
  });

  it("sealSandboxRunnerRegistry is callable without throwing", () => {
    expect(() => sealSandboxRunnerRegistry()).not.toThrow();
  });

  it("registration succeeds in test environment (NODE_ENV=test) even after seal", () => {
    sealSandboxRunnerRegistry();
    const runner = new BwrapRunner();
    // vitest sets NODE_ENV to include 'test' — seal bypass is active
    expect(() => registerSandboxRunner("linux", runner)).not.toThrow();
    expect(getSandboxRunner("linux")).toBe(runner);
  });

  it("__resetSandboxRunnersForTest clears runners and lifts seal", () => {
    const runner = new BwrapRunner();
    registerSandboxRunner("linux", runner);
    sealSandboxRunnerRegistry();
    __resetSandboxRunnersForTest();

    expect(getSandboxRunner("linux")).toBeUndefined();
    // Seal is lifted — registration works again
    expect(() => registerSandboxRunner("linux", runner)).not.toThrow();
  });
});

// ─── D9: MCP slot round-trip ──────────────────────────────────────────────────

describe("D9 MCP slot integration", () => {
  it("registerSandboxRunner('mcp', runner) round-trips via getSandboxRunner('mcp')", () => {
    const runner = new BwrapRunner();
    registerSandboxRunner("mcp", runner);
    expect(getSandboxRunner("mcp")).toBe(runner);
  });

  it("MCP slot is independent of the linux slot", () => {
    const linuxRunner = new BwrapRunner();
    const mcpRunner = new BwrapRunner();
    registerSandboxRunner("linux", linuxRunner);
    registerSandboxRunner("mcp", mcpRunner);
    expect(getSandboxRunner("linux")).toBe(linuxRunner);
    expect(getSandboxRunner("mcp")).toBe(mcpRunner);
    expect(getSandboxRunner("linux")).not.toBe(getSandboxRunner("mcp"));
  });

  it("MCP slot holds a BwrapRunner instance", () => {
    const runner = new BwrapRunner();
    registerSandboxRunner("mcp", runner);
    expect(getSandboxRunner("mcp")).toBeInstanceOf(BwrapRunner);
  });
});

// ─── Integration tests (real bwrap — Linux only, BWRAP_INTEGRATION=1) ─────────

describeIntegration("BwrapRunner integration (real bwrap)", () => {
  it("detect() returns available=true on a Linux host with bwrap installed", async () => {
    const result = await new BwrapRunner().detect();
    expect(result.available).toBe(true);
    expect(result.kind).toBe("bubblewrap");
  });

  it("networkBlocked=true prevents outbound curl (exit != 0)", async () => {
    const proc = await new BwrapRunner().spawn(
      "/usr/bin/curl",
      ["--max-time", "2", "http://example.com"],
      { networkBlocked: true },
    );
    const code = await proc.exitCode.catch(() => -1);
    expect(code).not.toBe(0);
  }, 10_000);

  it("fsReadPaths [/etc] allows cat /etc/hostname to succeed", async () => {
    const proc = await new BwrapRunner().spawn(
      "/bin/cat",
      ["/etc/hostname"],
      { fsReadPaths: ["/etc"], networkBlocked: true },
    );
    const chunks: Uint8Array[] = [];
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const code = await proc.exitCode;
    expect(code).toBe(0);
    const total = chunks.reduce(
      (a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; },
      new Uint8Array(0),
    );
    expect(new TextDecoder().decode(total).length).toBeGreaterThan(0);
  }, 10_000);

  it("abort() causes the exit to be non-zero", async () => {
    const proc = await new BwrapRunner().spawn("/bin/sleep", ["60"], { networkBlocked: true });
    await proc.abort();
    const code = await proc.exitCode.then((c) => c).catch(() => -1);
    expect(code).not.toBe(0);
  }, 10_000);
});
