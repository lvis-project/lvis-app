/**
 * Host-mediated worker-spawn primitive (worker-confinement PR D-1).
 *
 * Confines a LONG-LIVED HTTP plugin worker the host connects INBOUND to, under
 * ASRT with a bind-mounted UDS control channel. These tests stub ASRT
 * (`wrapWorkerCommand` / `cleanupAsrtSandboxAfterCommand` / the gate) +
 * `child_process.spawn` + `node:fs` to assert the WIRING — they do NOT exercise
 * the real Seatbelt/bwrap backend (that is the macOS runtime smoke, run
 * separately in worker-spawn-uds.smoke.test.ts). Covered:
 *   - gate OFF → plain spawn, args UNCHANGED, no wrap, no UDS dir, socketPath
 *     null, reviewer 'none'.
 *   - gate ON (mac/linux) → registerWorkerUnixSocketDir(socketDir) called BEFORE
 *     the wrap (the UDS allow is SHARED-config, not per-command); wrapWorkerCommand
 *     called with allowWrite=[socketDir,…] (FS jail only — no per-command UDS
 *     option, which is inert in ASRT 0.0.59); spawn gets the wrapped argv
 *     (shell:false, stdin ignored); socketPath non-null; the worker is marked
 *     wrapped so the reviewer reports genuine asrt for its plugin tool.
 *   - udsArgName injection (arg form + env form).
 *   - idempotent any-exit cleanup → unmark + cleanup once on exit (and stop()
 *     does not double-run); reviewer falls back to none after.
 *   - win32 + gate ON → LEGACY plain spawn (no UDS fabrication), socketPath null.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";

// ─── node:fs / node:fs/promises mocks (no real disk touch) ──
const mkdirMock = vi.fn<(path: unknown, opts?: unknown) => Promise<undefined>>(() =>
  Promise.resolve(undefined),
);
const unlinkSyncMock = vi.fn<(path: unknown) => void>(() => undefined);
const rmdirSyncMock = vi.fn<(path: unknown) => void>(() => undefined);
vi.mock("node:fs/promises", () => ({
  mkdir: (path: unknown, opts?: unknown) => mkdirMock(path, opts),
}));
vi.mock("node:fs", () => ({
  unlinkSync: (path: unknown) => unlinkSyncMock(path),
  rmdirSync: (path: unknown) => rmdirSyncMock(path),
}));

// ─── child_process mock ─────────────────────────────────────
const spawnMock = vi.fn<
  (cmd: string, args?: readonly string[], opts?: unknown) => unknown
>();
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args?: readonly string[], opts?: unknown) =>
    spawnMock(cmd, args, opts),
}));

// ─── managed-child tracker is a no-op stub here ─────────────
vi.mock("../../main/managed-child-processes.js", () => ({
  trackManagedChildProcess: () => () => {},
}));

// ─── ASRT mock — gate + wrap controllable per test ──────────
let gateActive = false;
const wrapWorkerCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>();
const cleanupMock = vi.fn(() => Promise.resolve());
const registerUdsMock = vi.fn<(dir: string) => Promise<void>>(() => Promise.resolve());
const unregisterUdsMock = vi.fn<(dir: string) => Promise<void>>(() => Promise.resolve());
vi.mock("../asrt-sandbox.js", () => ({
  isAsrtSandboxActive: () => gateActive,
  wrapWorkerCommand: (command: string, options?: unknown) =>
    wrapWorkerCommandMock(command, options),
  cleanupAsrtSandboxAfterCommand: () => cleanupMock(),
  registerWorkerUnixSocketDir: (dir: string) => registerUdsMock(dir),
  unregisterWorkerUnixSocketDir: (dir: string) => unregisterUdsMock(dir),
}));

// Module imports AFTER the mocks.
import { spawnWorker } from "../worker-spawn.js";
import { lvisHome } from "../../shared/lvis-home.js";
import {
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedPluginWorkersForTest,
  isPluginWorkerWrapped,
} from "../sandbox-capability.js";

/** A minimal child-process double (NOT a shared helper — local to this file). */
class StubWorkerChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  pid = 4242;
  kill(_signal?: string): boolean {
    return true;
  }
}

/** Force `process.platform` for one test (restored in afterEach). */
function withPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}
const REAL_PLATFORM = process.platform;

beforeEach(() => {
  spawnMock.mockReset();
  wrapWorkerCommandMock.mockReset();
  cleanupMock.mockClear();
  registerUdsMock.mockClear();
  unregisterUdsMock.mockClear();
  mkdirMock.mockClear();
  unlinkSyncMock.mockClear();
  rmdirSyncMock.mockClear();
  gateActive = false;
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedPluginWorkersForTest();
});

afterEach(() => {
  withPlatform(REAL_PLATFORM);
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedPluginWorkersForTest();
});

// ─── Gate OFF — plain spawn, byte-for-byte legacy ───────────

describe("spawnWorker — gate OFF (default)", () => {
  it("plain-spawns the worker UNCHANGED, no wrap, no UDS, socketPath null, reviewer none", async () => {
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "/opt/worker",
      args: ["--serve"],
    });

    // No wrap, no UDS dir creation.
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    // Plain spawn with the EXACT command + args, stdin ignored, shell:false.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { shell: boolean; stdio: unknown[] }];
    expect(cmd).toBe("/opt/worker");
    expect(args).toEqual(["--serve"]);
    expect(opts.shell).toBe(false);
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    // Legacy path signal: socketPath null.
    expect(worker.socketPath).toBeNull();
    expect(worker.pid).toBe(4242);
    // Worker NOT marked wrapped → reviewer stays none.
    expect(isPluginWorkerWrapped("embed")).toBe(false);
    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed");
    expect(cap.kind).toBe("none");
  });
});

// ─── Gate ON (macOS) — wrapped spawn + UDS + reviewer ───────

describe("spawnWorker — gate ON (macOS)", () => {
  it("registers the socketDir on the shared config, wraps with allowWrite=[socketDir,…] (FS jail only), marks wrapped, socketPath non-null", async () => {
    withPlatform("darwin");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "sandbox-exec … /opt/worker --serve --uds /sock"],
      env: { ...process.env },
    });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "/opt/worker",
      args: ["--serve"],
      allowWritePaths: ["/data/index"],
      udsArgName: "--uds",
    });

    const socketDir = join(lvisHome(), "plugins", "local-indexer", "run", "embed");
    const socketPath = join(socketDir, "control.sock");
    // socketDir created 0o700; stale socket unlinked before mkdir.
    expect(mkdirMock).toHaveBeenCalledWith(socketDir, { recursive: true, mode: 0o700 });
    expect(unlinkSyncMock).toHaveBeenCalledWith(socketPath);

    // The UDS allow is registered on the SHARED config (NOT per-command — that
    // channel is inert in ASRT 0.0.59).
    expect(registerUdsMock).toHaveBeenCalledWith(socketDir);

    // The per-command wrap carries ONLY the FS jail (socketDir first); there is
    // NO per-command UDS option (allowUnixSocketPath / allowAllUnixSockets).
    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    const [cmdline, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowWrite: string[]; allowRead: string[] }; allowUnixSocketPath?: string; allowAllUnixSockets?: boolean },
    ];
    expect(options.filesystem.allowWrite[0]).toBe(socketDir);
    expect(options.filesystem.allowWrite).toContain("/data/index");
    expect(options.allowUnixSocketPath).toBeUndefined();
    expect(options.allowAllUnixSockets).toBeUndefined();
    // The udsArgName was injected into the command before wrapping.
    expect(cmdline).toContain("--uds");
    expect(cmdline).toContain(socketPath);

    // Spawn ran the WRAPPED argv, shell:false, stdin ignored.
    const [scmd, sargs, sopts] = spawnMock.mock.calls[0] as [string, string[], { shell: boolean }];
    expect(scmd).toBe("/bin/bash");
    expect(sargs[0]).toBe("-c");
    expect(sopts.shell).toBe(false);

    // Non-null socketPath + reviewer reports genuine asrt for the plugin tool.
    expect(worker.socketPath).toBe(socketPath);
    expect(isPluginWorkerWrapped("embed")).toBe(true);
    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed");
    expect(cap.kind).toBe("asrt");
    expect(cap.reason).toContain("plugin worker 'embed' ASRT-wrapped");
  });

  it("injects the UDS path via env when udsArgName is the env form", async () => {
    withPlatform("darwin");
    gateActive = true;
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    let capturedEnv: NodeJS.ProcessEnv = {};
    spawnMock.mockImplementationOnce((_c, _a, opts) => {
      capturedEnv = (opts as { env: NodeJS.ProcessEnv }).env;
      return new StubWorkerChild();
    });

    await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "/opt/worker",
      udsArgName: { env: "LVIS_CONTROL_SOCKET" },
    });

    const socketPath = join(lvisHome(), "plugins", "local-indexer", "run", "embed", "control.sock");
    expect(capturedEnv.LVIS_CONTROL_SOCKET).toBe(socketPath);
  });
});

// ─── Gate ON (linux) — registers the socketDir; FS-jail-only wrap ───

describe("spawnWorker — gate ON (linux)", () => {
  it("registers the socketDir on the shared config and wraps with the FS jail only (no per-command UDS option)", async () => {
    withPlatform("linux");
    gateActive = true;
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(new StubWorkerChild());

    await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "/opt/worker",
    });

    const socketDir = join(lvisHome(), "plugins", "local-indexer", "run", "embed");
    // Platform-uniform: the socketDir is registered on the shared config (the
    // linux allowAllUnixSockets weakening is applied inside asrt-sandbox's
    // withWorkerUnixSockets, asserted in the asrt-sandbox unit tests).
    expect(registerUdsMock).toHaveBeenCalledWith(socketDir);
    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { allowUnixSocketPath?: string; allowAllUnixSockets?: boolean },
    ];
    expect(options.allowUnixSocketPath).toBeUndefined();
    expect(options.allowAllUnixSockets).toBeUndefined();
  });
});

// ─── Idempotent any-exit cleanup ────────────────────────────

describe("spawnWorker — idempotent any-exit cleanup", () => {
  it("unmarks the worker + cleans up ONCE on child exit, then reviewer is none", async () => {
    withPlatform("darwin");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "/opt/worker",
    });
    expect(isPluginWorkerWrapped("embed")).toBe(true);

    const socketDir = join(lvisHome(), "plugins", "local-indexer", "run", "embed");
    // Child dies unexpectedly → exit fires cleanup.
    child.emit("exit", 1, null);
    expect(isPluginWorkerWrapped("embed")).toBe(false);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    // The shared-config UDS allow is released exactly once.
    expect(unregisterUdsMock).toHaveBeenCalledTimes(1);
    expect(unregisterUdsMock).toHaveBeenCalledWith(socketDir);
    // Reviewer falls back to none (no stale asrt) after the worker is gone.
    expect(resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed").kind).toBe("none");

    // stop() after exit must NOT double-run cleanup.
    worker.stop();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(unregisterUdsMock).toHaveBeenCalledTimes(1);
  });

  it("stop() before exit runs cleanup once; a later exit does not re-run it", async () => {
    withPlatform("linux");
    gateActive = true;
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "/opt/worker",
    });

    worker.stop();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(isPluginWorkerWrapped("embed")).toBe(false);

    child.emit("exit", 0, "SIGTERM");
    expect(cleanupMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Windows + gate ON → legacy plain spawn (no UDS) ────────

describe("spawnWorker — Windows with gate ON", () => {
  it("uses the LEGACY plain-spawn path (no wrap, no UDS, socketPath null)", async () => {
    withPlatform("win32");
    gateActive = true;
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "C:/worker.exe",
      args: ["--serve"],
    });

    // No fabrication: no wrap, no UDS dir, socketPath null.
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(worker.socketPath).toBeNull();
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("C:/worker.exe");
    expect(args).toEqual(["--serve"]);
    expect(isPluginWorkerWrapped("embed")).toBe(false);
  });
});
