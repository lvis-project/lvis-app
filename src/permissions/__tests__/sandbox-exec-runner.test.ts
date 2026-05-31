/**
 * SandboxExecRunner — PR-A3 unit tests.
 *
 * Issue: #691 PR-A3
 *
 * ESM mocking: vi.mock() for node built-ins at module level.
 * Per-test setup via beforeEach so vi.resetAllMocks() + vi.restoreAllMocks()
 * gives a clean slate between tests without leaking platform spies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SandboxExecRunner, SANDBOX_EXEC_BIN, buildSbplProfile } from "../runners/sandbox-exec-runner.js";

// ─── Module-level mocks ───────────────────────────────────────────────────────

vi.mock("node:fs/promises", async (importOriginal) => {
  // Import the real constants so access(path, constants.X_OK) works in detect().
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    constants: real.constants,
    access:    vi.fn(),
    mkdtemp:   vi.fn(),
    writeFile: vi.fn(),
    chmod:     vi.fn(),
    stat:      vi.fn(),
    rm:        vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:stream", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:stream")>();
  return {
    ...original,
    Readable: class extends original.Readable {
      static toWeb(_r: unknown): ReadableStream<Uint8Array> {
        return new ReadableStream({ start(ctrl) { ctrl.close(); } });
      }
    },
  };
});

// ─── Shared fake child factory ────────────────────────────────────────────────

const fakeKill = vi.fn();

function makeFakeChild() {
  const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  const child = {
    pid: 42,
    exitCode: null as number | null,
    killed: false,
    stdout: { on: vi.fn(), pipe: vi.fn() },
    stderr: { on: vi.fn(), pipe: vi.fn() },
    kill: fakeKill,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "exit") exitListeners.push(cb as (code: number | null, signal: string | null) => void);
    }),
  };
  setTimeout(() => {
    child.exitCode = 0;
    exitListeners.forEach((cb) => cb(0, null));
  }, 0);
  return child;
}

// ─── beforeEach: set up default mock implementations ─────────────────────────

beforeEach(async () => {
  const fsMod = await import("node:fs/promises");
  vi.mocked(fsMod.access).mockResolvedValue(undefined);    // binary present by default
  // mkdtemp returns a unique per-spawn dir path (CRITICAL-1 TOCTOU fix)
  vi.mocked(fsMod.mkdtemp).mockResolvedValue("/tmp/lvis-sandbox-exec-abcdef");
  vi.mocked(fsMod.writeFile).mockResolvedValue(undefined);
  vi.mocked(fsMod.chmod).mockResolvedValue(undefined);
  // stat returns current uid — ownership verification passes by default
  vi.mocked(fsMod.stat).mockResolvedValue({ uid: process.getuid?.() ?? 0 } as import("node:fs").Stats);
  vi.mocked(fsMod.rm).mockResolvedValue(undefined);

  const cpMod = await import("node:child_process");
  vi.mocked(cpMod.spawn).mockReturnValue(makeFakeChild() as never);
});

afterEach(() => {
  // resetAllMocks: clear call history + reset vi.fn() implementations to empty.
  // This keeps vi.spyOn() spies in place but clears their implementation.
  vi.resetAllMocks();
  // restoreAllMocks: restore the original implementation of vi.spyOn() overrides.
  // Must come AFTER resetAllMocks so it restores the real getter, not an empty fn.
  vi.restoreAllMocks();
});

// ─── detect() — platform guard ────────────────────────────────────────────────

describe("SandboxExecRunner.detect() — platform guard", () => {
  it("returns available=false on linux", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const result = await new SandboxExecRunner().detect();
    expect(result.available).toBe(false);
    expect(result.kind).toBe("none");
    expect(result.confidence).toBe("verified");
    expect(result.reason).toMatch(/only supports darwin/i);
  });

  it("returns available=false on win32", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const result = await new SandboxExecRunner().detect();
    expect(result.available).toBe(false);
    expect(result.kind).toBe("none");
  });
});

// ─── detect() — binary present/absent on darwin ───────────────────────────────

describe("SandboxExecRunner.detect() — binary on darwin", () => {
  it("returns available=true / kind=partial / confidence=policy-best-effort when binary executable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    // access already resolves via beforeEach — binary present
    const result = await new SandboxExecRunner().detect();
    expect(result.available).toBe(true);
    expect(result.kind).toBe("partial");
    expect(result.confidence).toBe("policy-best-effort");
    expect(result.reason).toMatch(/PARTIAL/);
    expect(result.reason).toMatch(/sandbox-exec/);
  });

  it("returns available=false when binary not found", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const fsMod = await import("node:fs/promises");
    vi.mocked(fsMod.access).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const result = await new SandboxExecRunner().detect();
    expect(result.available).toBe(false);
    expect(result.kind).toBe("none");
    expect(result.confidence).toBe("verified");
    expect(result.reason).toContain(SANDBOX_EXEC_BIN);
    expect(result.reason).toMatch(/not found/i);
  });
});

// ─── buildSbplProfile() — pure function, no mocks needed ─────────────────────

describe("buildSbplProfile() — baseline", () => {
  it("starts with (version 1) and contains (deny default)", () => {
    const p = buildSbplProfile({});
    expect(p).toMatch(/^\(version 1\)/);
    expect(p).toContain("(deny default)");
  });

  it("always allows process-fork and process-exec", () => {
    const p = buildSbplProfile({});
    expect(p).toContain("(allow process-fork)");
    expect(p).toContain("(allow process-exec)");
  });

  it("always allows signal (target self)", () => {
    expect(buildSbplProfile({})).toContain("(allow signal (target self))");
  });

  it("always allows mach-lookup and ipc-posix-shm", () => {
    const p = buildSbplProfile({});
    expect(p).toContain("(allow mach-lookup)");
    expect(p).toContain("(allow ipc-posix-shm)");
  });
});

describe("buildSbplProfile() — network policy", () => {
  it("does NOT include (allow network*) by default", () => {
    expect(buildSbplProfile({})).not.toContain("(allow network*)");
  });

  it("includes (allow network*) when networkBlocked=false", () => {
    expect(buildSbplProfile({ networkBlocked: false })).toContain("(allow network*)");
  });

  it("does NOT include (allow network*) when networkBlocked=true", () => {
    expect(buildSbplProfile({ networkBlocked: true })).not.toContain("(allow network*)");
  });
});

describe("buildSbplProfile() — filesystem policy", () => {
  it("renders fsReadPaths as file-read* subpath allows", () => {
    const p = buildSbplProfile({ fsReadPaths: ["/home/user/docs", "/etc/config"] });
    expect(p).toContain('(allow file-read* (subpath "/home/user/docs"))');
    expect(p).toContain('(allow file-read* (subpath "/etc/config"))');
  });

  it("renders fsWritePaths as file-write* subpath allows", () => {
    expect(buildSbplProfile({ fsWritePaths: ["/tmp/work"] })).toContain(
      '(allow file-write* (subpath "/tmp/work"))',
    );
  });

  it("always allows /tmp, /private/tmp, /private/var/folders RW", () => {
    const p = buildSbplProfile({});
    expect(p).toContain('(subpath "/tmp")');
    expect(p).toContain('(subpath "/private/tmp")');
    expect(p).toContain('(subpath "/private/var/folders")');
  });

  it("escapes double-quote in path to prevent SBPL injection", () => {
    const p = buildSbplProfile({ fsReadPaths: ['/path/with"quote'] });
    expect(p).toContain('\\"quote');
    expect(p).not.toMatch(/\(subpath "\/path\/with"quote"\)/);
  });
});

// ─── spawn() ──────────────────────────────────────────────────────────────────

describe("SandboxExecRunner.spawn()", () => {
  it("calls child_process.spawn with SANDBOX_EXEC_BIN", async () => {
    const { spawn: mockSpawn } = await import("node:child_process");
    await new SandboxExecRunner().spawn("/bin/echo", ["hello"], {}, { env: {} });
    expect(mockSpawn).toHaveBeenCalledWith(
      SANDBOX_EXEC_BIN,
      expect.arrayContaining(["-f", expect.stringContaining(".sb"), "/bin/echo", "hello"]),
      expect.any(Object),
    );
  });

  it("args order: -f <profile.sb> <cmd> [...args]", async () => {
    const { spawn: mockSpawn } = await import("node:child_process");
    await new SandboxExecRunner().spawn("/usr/bin/env", ["FOO=bar"], {}, { env: {} });
    const callArgs = vi.mocked(mockSpawn).mock.calls.at(-1)![1] as string[];
    expect(callArgs[0]).toBe("-f");
    expect(callArgs[1]).toMatch(/profile\.sb$/);
    expect(callArgs[2]).toBe("/usr/bin/env");
    expect(callArgs[3]).toBe("FOO=bar");
  });

  it("returns SandboxedProcess with pid, stdout, stderr, exitCode, abort", async () => {
    const proc = await new SandboxExecRunner().spawn("/bin/echo", [], {}, { env: {} });
    expect(typeof proc.pid).toBe("number");
    expect(proc.stdout).toBeDefined();
    expect(proc.stderr).toBeDefined();
    expect(proc.exitCode).toBeInstanceOf(Promise);
    expect(typeof proc.abort).toBe("function");
  });

  it("passes cwd to spawn options", async () => {
    const { spawn: mockSpawn } = await import("node:child_process");
    await new SandboxExecRunner().spawn("/bin/sh", [], {}, { env: {}, cwd: "/tmp/work" });
    const opts = vi.mocked(mockSpawn).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(opts["cwd"]).toBe("/tmp/work");
  });

  it("passes env to spawn options", async () => {
    const { spawn: mockSpawn } = await import("node:child_process");
    await new SandboxExecRunner().spawn("/bin/sh", [], {}, { env: { FOO: "bar" } });
    const opts = vi.mocked(mockSpawn).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(opts["env"]).toEqual({ FOO: "bar" });
  });

  it("abort() calls child.kill(SIGTERM)", async () => {
    const proc = await new SandboxExecRunner().spawn("/bin/sleep", ["10"], {}, { env: {} });
    await proc.abort();
    expect(fakeKill).toHaveBeenCalledWith("SIGTERM");
  });

  it("exitCode resolves to 0 on clean exit", async () => {
    const proc = await new SandboxExecRunner().spawn("/bin/true", [], {}, { env: {} });
    await expect(proc.exitCode).resolves.toBe(0);
  });

  it("calls writeFile with profile.sb path, (version 1) profile, mode 0o600", async () => {
    const { writeFile } = await import("node:fs/promises");
    await new SandboxExecRunner().spawn("/bin/echo", [], {}, { env: {} });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("profile.sb"),
      expect.stringContaining("(version 1)"),
      expect.objectContaining({ mode: 0o600 }),
    );
  });
});

// ─── spawn() — CRITICAL-1 TOCTOU: mkdtemp per-spawn ──────────────────────────

describe("SandboxExecRunner.spawn() — CRITICAL-1 mkdtemp per-spawn", () => {
  it("calls mkdtemp with lvis-sandbox-exec- prefix on each spawn", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    await new SandboxExecRunner().spawn("/bin/echo", [], {}, { env: {} });
    await new SandboxExecRunner().spawn("/bin/echo", [], {}, { env: {} });
    expect(mkdtemp).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(mkdtemp).mock.calls;
    expect(calls[0]![0]).toMatch(/lvis-sandbox-exec-$/);
    expect(calls[1]![0]).toMatch(/lvis-sandbox-exec-$/);
  });

  it("writes profile.sb inside the mkdtemp dir", async () => {
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    vi.mocked(mkdtemp).mockResolvedValue("/tmp/lvis-sandbox-exec-xyz123");
    await new SandboxExecRunner().spawn("/bin/echo", [], {}, { env: {} });
    const writtenPath = vi.mocked(writeFile).mock.calls[0]![0] as string;
    expect(writtenPath.replace(/\\/g, "/")).toBe("/tmp/lvis-sandbox-exec-xyz123/profile.sb");
  });

  it("calls chmod(profileDir, 0o700) after mkdtemp", async () => {
    const { chmod, mkdtemp } = await import("node:fs/promises");
    vi.mocked(mkdtemp).mockResolvedValue("/tmp/lvis-sandbox-exec-xyz123");
    await new SandboxExecRunner().spawn("/bin/echo", [], {}, { env: {} });
    expect(chmod).toHaveBeenCalledWith("/tmp/lvis-sandbox-exec-xyz123", 0o700);
  });

  it("calls rm(profileDir, recursive+force) on exit for cleanup", async () => {
    const { rm, mkdtemp } = await import("node:fs/promises");
    vi.mocked(mkdtemp).mockResolvedValue("/tmp/lvis-sandbox-exec-cleanup");
    const proc = await new SandboxExecRunner().spawn("/bin/echo", [], {}, { env: {} });
    // Wait for exit so finally() fires
    await proc.exitCode;
    // Allow micro-task queue to flush
    await Promise.resolve();
    expect(rm).toHaveBeenCalledWith(
      "/tmp/lvis-sandbox-exec-cleanup",
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("cleans up profileDir and rethrows when ownership check fails", async () => {
    const { stat, rm } = await import("node:fs/promises");
    const proc = process as typeof process & { getuid?: () => number };
    const originalGetuid = proc.getuid;
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: () => 1000,
    });
    // Return a different uid than process.getuid()
    const wrongUid = 1001;
    vi.mocked(stat).mockResolvedValue({ uid: wrongUid } as import("node:fs").Stats);
    try {
      await expect(
        new SandboxExecRunner().spawn("/bin/echo", [], {}, { env: {} }),
      ).rejects.toThrow("profile dir ownership mismatch");
      expect(rm).toHaveBeenCalledWith(
        expect.stringContaining("lvis-sandbox-exec-"),
        expect.objectContaining({ recursive: true, force: true }),
      );
    } finally {
      if (originalGetuid) {
        Object.defineProperty(process, "getuid", {
          configurable: true,
          value: originalGetuid,
        });
      } else {
        delete proc.getuid;
      }
    }
  });
});

// ─── spawn() — MEDIUM-2: env required ────────────────────────────────────────

describe("SandboxExecRunner.spawn() — MEDIUM-2 env required", () => {
  it("throws when options is undefined", async () => {
    await expect(
      new SandboxExecRunner().spawn("/bin/echo", [], {}),
    ).rejects.toThrow("options.env is REQUIRED");
  });

  it("throws when options.env is undefined", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new SandboxExecRunner().spawn("/bin/echo", [], {}, {} as any),
    ).rejects.toThrow("options.env is REQUIRED");
  });

  it("accepts empty env object", async () => {
    await expect(
      new SandboxExecRunner().spawn("/bin/echo", [], {}, { env: {} }),
    ).resolves.toBeDefined();
  });
});

// ─── buildSbplProfile() — MEDIUM-1: control character rejection ──────────────

describe("buildSbplProfile() — MEDIUM-1 SBPL control char escape", () => {
  it("rejects NUL byte (\\x00) in fsReadPaths", () => {
    expect(() => buildSbplProfile({ fsReadPaths: ["/path\x00evil"] })).toThrow(
      "control character in sandbox path",
    );
  });

  it("rejects newline (\\n) in fsReadPaths", () => {
    expect(() => buildSbplProfile({ fsReadPaths: ["/path\nevil"] })).toThrow(
      "control character in sandbox path",
    );
  });

  it("rejects carriage return (\\r) in fsReadPaths", () => {
    expect(() => buildSbplProfile({ fsReadPaths: ["/path\revil"] })).toThrow(
      "control character in sandbox path",
    );
  });

  it("rejects tab (\\t) in fsReadPaths", () => {
    expect(() => buildSbplProfile({ fsReadPaths: ["/path\tevil"] })).toThrow(
      "control character in sandbox path",
    );
  });

  it("rejects SBPL injection string containing )\\n(allow file-write*", () => {
    expect(() =>
      buildSbplProfile({ fsReadPaths: [')\n(allow file-write* (subpath "/"))'] }),
    ).toThrow("control character in sandbox path");
  });

  it("rejects DEL (\\x7f) in fsWritePaths", () => {
    expect(() => buildSbplProfile({ fsWritePaths: ["/path\x7fevil"] })).toThrow(
      "control character in sandbox path",
    );
  });

  it("still allows normal paths with backslash and double-quote", () => {
    // Windows-style path with backslash, and a path with embedded double-quote
    const p = buildSbplProfile({ fsReadPaths: ['/path/with"quote', "C:\\Windows"] });
    expect(p).toContain('\\"quote');
    expect(p).toContain("C:\\\\Windows");
  });
});
