/**
 * PR-A1 — SandboxRunner interface contract + registry tests.
 *
 * Issue: #691
 *
 * Tests the registry functions and the interface contract shape.
 * Per-OS runner implementations land in PR-A2/A3.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { SandboxRunner, SandboxRunnerDetect, SandboxedProcess } from "../sandbox-runner.js";
import {
  registerSandboxRunner,
  getSandboxRunner,
  __resetSandboxRunnersForTest,
} from "../sandbox-runner.js";

afterEach(() => {
  __resetSandboxRunnersForTest();
});

function makeMockRunner(): SandboxRunner {
  return {
    async spawn(_cmd, _args, _caps, _env): Promise<SandboxedProcess> {
      const encoder = new TextEncoderStream();
      return {
        pid: 12345,
        stdout: encoder.readable,  // already ReadableStream<Uint8Array> — no cast needed
        stderr: new ReadableStream<Uint8Array>(),
        exitCode: Promise.resolve(0),
        abort: async () => {},
      };
    },
    async detect(): Promise<SandboxRunnerDetect> {
      return {
        available: true,
        reason: "mock runner always available",
        kind: "bubblewrap",
        confidence: "verified",
      };
    },
  };
}

describe("sandbox runner registry", () => {
  it("getSandboxRunner returns undefined when no runner registered", () => {
    expect(getSandboxRunner("linux")).toBeUndefined();
  });

  it("registerSandboxRunner + getSandboxRunner round-trips the runner", () => {
    const runner = makeMockRunner();
    registerSandboxRunner("linux", runner);
    expect(getSandboxRunner("linux")).toBe(runner);
  });

  it("registers runners for multiple platforms independently", () => {
    const linuxRunner = makeMockRunner();
    const darwinRunner = makeMockRunner();
    registerSandboxRunner("linux", linuxRunner);
    registerSandboxRunner("darwin", darwinRunner);
    expect(getSandboxRunner("linux")).toBe(linuxRunner);
    expect(getSandboxRunner("darwin")).toBe(darwinRunner);
  });

  it("subsequent registration overwrites for the same platform", () => {
    const r1 = makeMockRunner();
    const r2 = makeMockRunner();
    registerSandboxRunner("linux", r1);
    registerSandboxRunner("linux", r2);
    expect(getSandboxRunner("linux")).toBe(r2);
  });

  it("__resetSandboxRunnersForTest clears all registrations", () => {
    registerSandboxRunner("linux", makeMockRunner());
    registerSandboxRunner("darwin", makeMockRunner());
    __resetSandboxRunnersForTest();
    expect(getSandboxRunner("linux")).toBeUndefined();
    expect(getSandboxRunner("darwin")).toBeUndefined();
  });
});

describe("SandboxRunner interface contract", () => {
  it("detect() returns a SandboxRunnerDetect with expected fields", async () => {
    const runner = makeMockRunner();
    const result = await runner.detect();
    expect(result).toMatchObject({
      available: expect.any(Boolean),
      reason: expect.any(String),
      kind: expect.stringMatching(/^(none|bubblewrap|sandbox-exec|appcontainer|partial|fs-only)$/),
      confidence: expect.stringMatching(/^(verified|assumed)$/),
    });
  });

  it("spawn() returns a SandboxedProcess with required fields", async () => {
    const runner = makeMockRunner();
    const proc = await runner.spawn("/bin/echo", ["hello"], {});
    expect(typeof proc.pid).toBe("number");
    expect(proc.stdout).toBeDefined();
    expect(proc.stderr).toBeDefined();
    expect(proc.exitCode).toBeInstanceOf(Promise);
    expect(typeof proc.abort).toBe("function");
  });

  it("spawn() with partial capabilities (empty) does not throw", async () => {
    const runner = makeMockRunner();
    await expect(runner.spawn("/bin/echo", [], {})).resolves.toBeDefined();
  });

  it("spawn() with full capabilities does not throw", async () => {
    const runner = makeMockRunner();
    await expect(
      runner.spawn("/bin/echo", ["arg"], {
        networkBlocked: true,
        fsReadPaths: ["/tmp"],
        fsWritePaths: ["/tmp/out"],
        processIsolated: true,
      }),
    ).resolves.toBeDefined();
  });
});
