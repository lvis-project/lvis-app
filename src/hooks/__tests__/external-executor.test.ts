/**
 * ExternalHookExecutor unit tests — Tier A4.
 *
 * All spawn() + fetch calls are mocked so tests never touch real processes
 * or the network. Command hooks are simulated via an EventEmitter that
 * emulates a child process, HTTP hooks via `vi.stubGlobal("fetch", ...)`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ─── spawn mock ──────────────────────────────────────
// Track every invocation + expose a FakeChild we can drive from tests.

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal: string) => void;
  killed: boolean;
}

const spawnMock = vi.fn<(cmd: string, args: readonly string[], opts: unknown) => FakeChild>();

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: readonly string[], opts: unknown) => spawnMock(cmd, args, opts),
}));

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn((_signal: string) => {
    child.killed = true;
    // Emit close with SIGKILL-style non-zero exit
    setImmediate(() => child.emit("close", 137));
  });
  return child;
}

// ─── NetworkGuard mock (after vi.mock) ──────────────
// H1: HTTP hooks route through fetchPublicHttpResponse which performs
// DNS resolution + public-address enforcement. For hostnames that the
// test fixture uses (hook.local) we stub the guard so tests can drive
// behaviour deterministically without a network.
vi.mock("../../core/network-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../../core/network-guard.js")>(
    "../../core/network-guard.js",
  );
  return {
    ...actual,
    fetchPublicHttpResponse: vi.fn(async (url: string, init?: RequestInit) => {
      // Delegate to the global `fetch` mock set up by tests. Default
      // behaviour preserves the existing contract: tests install
      // fetchMock via vi.stubGlobal("fetch", ...) and we just forward.
      return await (globalThis.fetch as typeof fetch)(url, init ?? {});
    }),
  };
});

// ─── Imports under test (after vi.mock) ──────────────

import { ExternalHookExecutor } from "../external-executor.js";
import type { HooksConfig } from "../schemas.js";
import {
  fetchPublicHttpResponse,
  NetworkGuardError,
} from "../../core/network-guard.js";

// ─── Helpers ─────────────────────────────────────────

function makeConfig(partial: Partial<HooksConfig>): HooksConfig {
  return {
    preToolUse: partial.preToolUse ?? [],
    postToolUse: partial.postToolUse ?? [],
  };
}

// ─── Tests ───────────────────────────────────────────

describe("ExternalHookExecutor — command hooks", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("exit 0 captures stdout output and does not block", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const exec = new ExternalHookExecutor(
      makeConfig({
        preToolUse: [
          {
            type: "command",
            command: "echo hi",
            timeoutSeconds: 5,
            blockOnFailure: false,
          },
        ],
      }),
      "/tmp",
    );

    const promise = exec.run("preToolUse", "read_file", { path: "/tmp/x" });
    // Drive the child: emit stdout then close(0)
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("hello stdout"));
      child.emit("close", 0);
    });

    const agg = await promise;
    expect(agg.results).toHaveLength(1);
    expect(agg.results[0].success).toBe(true);
    expect(agg.results[0].output).toBe("hello stdout");
    expect(agg.blocked).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("exit 1 with blockOnFailure=true blocks and surfaces reason", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const exec = new ExternalHookExecutor(
      makeConfig({
        preToolUse: [
          {
            type: "command",
            command: "false",
            timeoutSeconds: 5,
            blockOnFailure: true,
          },
        ],
      }),
      "/tmp",
    );

    const promise = exec.run("preToolUse", "write_file", { path: "/tmp/x" });
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("permission denied"));
      child.emit("close", 1);
    });

    const agg = await promise;
    expect(agg.results[0].success).toBe(false);
    expect(agg.blocked).toBe(true);
    expect(agg.reason).toBe("permission denied");
  });

  it("timeout triggers SIGKILL and blocks when blockOnFailure=true", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    vi.useFakeTimers();

    const exec = new ExternalHookExecutor(
      makeConfig({
        preToolUse: [
          {
            type: "command",
            command: "sleep 999",
            timeoutSeconds: 1,
            blockOnFailure: true,
          },
        ],
      }),
      "/tmp",
    );

    const promise = exec.run("preToolUse", "read_file", {});
    // Advance past the 1s timeout — triggers kill("SIGKILL") which emits close 137
    await vi.advanceTimersByTimeAsync(1500);
    const agg = await promise;

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(agg.results[0].success).toBe(false);
    expect(agg.blocked).toBe(true);
    vi.useRealTimers();
  });

  it("spawn error event yields blocked when blockOnFailure=true", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const exec = new ExternalHookExecutor(
      makeConfig({
        preToolUse: [
          {
            type: "command",
            command: "nonexistent",
            timeoutSeconds: 5,
            blockOnFailure: true,
          },
        ],
      }),
      "/tmp",
    );

    const promise = exec.run("preToolUse", "read_file", {});
    setImmediate(() => child.emit("error", new Error("ENOENT: spawn nonexistent")));
    const agg = await promise;

    expect(agg.results[0].success).toBe(false);
    expect(agg.blocked).toBe(true);
    expect(agg.reason).toContain("ENOENT");
  });
});

describe("ExternalHookExecutor — matchers", () => {
  beforeEach(() => spawnMock.mockReset());

  it("matcher 'read_*' matches read_file and runs the hook", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const exec = new ExternalHookExecutor(
      makeConfig({
        preToolUse: [
          {
            type: "command",
            command: "echo matched",
            timeoutSeconds: 5,
            blockOnFailure: false,
            matcher: "read_*",
          },
        ],
      }),
      "/tmp",
    );

    const promise = exec.run("preToolUse", "read_file", {});
    setImmediate(() => child.emit("close", 0));
    const agg = await promise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(agg.results).toHaveLength(1);
  });

  it("matcher 'write_*' does NOT match read_file and skips the hook", async () => {
    const exec = new ExternalHookExecutor(
      makeConfig({
        preToolUse: [
          {
            type: "command",
            command: "echo skipped",
            timeoutSeconds: 5,
            blockOnFailure: false,
            matcher: "write_*",
          },
        ],
      }),
      "/tmp",
    );

    const agg = await exec.run("preToolUse", "read_file", {});
    expect(spawnMock).not.toHaveBeenCalled();
    expect(agg.results).toHaveLength(0);
    expect(agg.blocked).toBe(false);
  });
});

describe("ExternalHookExecutor — http hooks", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("200 response returns success and does not block", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok body",
    });

    const exec = new ExternalHookExecutor(
      makeConfig({
        preToolUse: [
          {
            type: "http",
            url: "http://hook.local/pre",
            headers: { "x-custom": "1" },
            timeoutSeconds: 5,
            blockOnFailure: true,
          },
        ],
      }),
      "/tmp",
    );

    const agg = await exec.run("preToolUse", "read_file", { path: "/x" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://hook.local/pre",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "content-type": "application/json", "x-custom": "1" }),
      }),
    );
    expect(agg.results[0].success).toBe(true);
    expect(agg.blocked).toBe(false);
  });

  it("500 response with blockOnFailure=true blocks", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server err",
    });

    const exec = new ExternalHookExecutor(
      makeConfig({
        postToolUse: [
          {
            type: "http",
            url: "http://hook.local/post",
            headers: {},
            timeoutSeconds: 5,
            blockOnFailure: true,
          },
        ],
      }),
      "/tmp",
    );

    const agg = await exec.run("postToolUse", "write_file", {});
    expect(agg.results[0].success).toBe(false);
    expect(agg.blocked).toBe(true);
    expect(agg.reason).toBe("server err");
  });

  it("fetch throws (network error) yields blocked when blockOnFailure=true", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const exec = new ExternalHookExecutor(
      makeConfig({
        preToolUse: [
          {
            type: "http",
            url: "http://hook.local/pre",
            headers: {},
            timeoutSeconds: 5,
            blockOnFailure: true,
          },
        ],
      }),
      "/tmp",
    );

    const agg = await exec.run("preToolUse", "read_file", {});
    expect(agg.results[0].success).toBe(false);
    expect(agg.blocked).toBe(true);
    expect(agg.reason).toContain("ECONNREFUSED");
  });
});

describe("ExternalHookExecutor — H1 NetworkGuard SSRF defense", () => {
  beforeEach(() => {
    vi.mocked(fetchPublicHttpResponse).mockReset();
    vi.mocked(fetchPublicHttpResponse).mockImplementation(async (url: string) => {
      // Simulate NetworkGuard rejecting AWS metadata endpoint
      if (url.includes("169.254.169.254") || url.includes("metadata")) {
        throw new NetworkGuardError(
          "target resolves to non-public address(es): 169.254.169.254",
        );
      }
      // Anything else: 200 OK
      return new Response("ok", { status: 200 });
    });
  });

  afterEach(() => {
    vi.mocked(fetchPublicHttpResponse).mockReset();
  });

  it("HTTP hook targeting AWS metadata (169.254.169.254) is rejected by NetworkGuard", async () => {
    const exec = new ExternalHookExecutor(
      {
        preToolUse: [
          {
            type: "http",
            url: "http://169.254.169.254/latest/meta-data/",
            headers: {},
            timeoutSeconds: 5,
            blockOnFailure: true,
          },
        ],
        postToolUse: [],
      },
      "/tmp",
    );

    const agg = await exec.run("preToolUse", "read_file", {});

    expect(agg.results).toHaveLength(1);
    expect(agg.results[0].success).toBe(false);
    expect(agg.blocked).toBe(true);
    // Reason surfaces NetworkGuard specifically so admins can identify
    // the SSRF defense as the source of the block.
    expect(agg.reason).toContain("network guard");
    expect(agg.reason).toContain("169.254.169.254");
  });

  it("HTTP hook targeting an allowed host passes through NetworkGuard", async () => {
    const exec = new ExternalHookExecutor(
      {
        preToolUse: [
          {
            type: "http",
            url: "http://example.com/hook",
            headers: {},
            timeoutSeconds: 5,
            blockOnFailure: true,
          },
        ],
        postToolUse: [],
      },
      "/tmp",
    );

    const agg = await exec.run("preToolUse", "read_file", {});

    expect(agg.results[0].success).toBe(true);
    expect(agg.blocked).toBe(false);
  });
});
