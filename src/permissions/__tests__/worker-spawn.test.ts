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
 *     option, which is inert in current ASRT); spawn gets the wrapped argv
 *     (shell:false, stdin ignored); socketPath non-null; the worker is marked
 *     wrapped so the reviewer reports genuine asrt for its plugin tool.
 *   - udsArgName injection (arg form + env form).
 *   - idempotent any-exit cleanup → unmark + cleanup once on exit (and stop()
 *     does not double-run); reviewer falls back to none after.
 *   - win32 + gate ON → dedicated holder PID ACL grant + srt-win wrapped TCP
 *     worker, no shared all-plugin grant and no UDS injection.
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
const chmodSyncMock = vi.fn<(path: unknown, mode: unknown) => void>(() => undefined);
// Default: the control dir is a real dir, NOT a symlink (the security check).
const lstatSyncMock = vi.fn<(path: unknown) => { isSymbolicLink: () => boolean }>(() => ({
  isSymbolicLink: () => false,
}));
vi.mock("node:fs/promises", () => ({
  mkdir: (path: unknown, opts?: unknown) => mkdirMock(path, opts),
}));
vi.mock("node:fs", () => ({
  unlinkSync: (path: unknown) => unlinkSyncMock(path),
  rmdirSync: (path: unknown) => rmdirSyncMock(path),
  chmodSync: (path: unknown, mode: unknown) => chmodSyncMock(path, mode),
  lstatSync: (path: unknown) => lstatSyncMock(path),
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
const grantReleaseMock = vi.fn<() => void>();
const grantWindowsWorkerFilesystemAccessMock = vi.fn<
  (opts: unknown) => Promise<{ allowRead: readonly string[]; allowWrite: readonly string[]; release: () => void }>
>(() =>
  Promise.resolve({
    allowRead: [],
    allowWrite: [],
    release: grantReleaseMock,
  }),
);
vi.mock("../asrt-sandbox.js", () => ({
  isAsrtSandboxActive: () => gateActive,
  wrapWorkerCommand: (command: string, options?: unknown) =>
    wrapWorkerCommandMock(command, options),
  cleanupAsrtSandboxAfterCommand: () => cleanupMock(),
  registerWorkerUnixSocketDir: (dir: string) => registerUdsMock(dir),
  unregisterWorkerUnixSocketDir: (dir: string) => unregisterUdsMock(dir),
  grantWindowsWorkerFilesystemAccess: (opts: unknown) =>
    grantWindowsWorkerFilesystemAccessMock(opts),
  // The host-secret read floor restated on the worker wrap (#1365 SOT).
  getDefaultSensitiveReadDenyPaths: () => ["/home/u/.lvis/secrets", "/home/u/.ssh"],
  // The persistence-vector write floor restated on the worker wrap (#1449 SOT).
  getDefaultSensitiveWriteDenyPaths: () => [
    "/home/u/.lvis/secrets",
    "/home/u/.ssh",
    "/home/u/.zshrc",
    "/home/u/.config",
    "/home/u/Library/LaunchAgents",
  ],
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
import { withPlatformForTest } from "../../__tests__/test-helpers.js";

/** A minimal child-process double (NOT a shared helper — local to this file). */
class StubWorkerChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  pid = 4242;
  killed = false;
  killCalls: Array<string | undefined> = [];
  kill(signal?: string): boolean {
    this.killCalls.push(signal);
    this.killed = true;
    return true;
  }
}

function setEnvForTest(values: Record<string, string | undefined>): () => void {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const REAL_PLATFORM = process.platform;
const REAL_SYSTEM_ROOT = process.env.SystemRoot;
const REAL_WINDIR = process.env.WINDIR;

beforeEach(() => {
  process.env.SystemRoot = "C:\\Windows";
  process.env.WINDIR = "C:\\Windows";
  spawnMock.mockReset();
  wrapWorkerCommandMock.mockReset();
  cleanupMock.mockClear();
  registerUdsMock.mockClear();
  unregisterUdsMock.mockClear();
  grantReleaseMock.mockClear();
  grantWindowsWorkerFilesystemAccessMock.mockClear();
  mkdirMock.mockClear();
  unlinkSyncMock.mockClear();
  rmdirSyncMock.mockClear();
  gateActive = false;
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedPluginWorkersForTest();
});

afterEach(() => {
  if (REAL_SYSTEM_ROOT === undefined) {
    delete process.env.SystemRoot;
  } else {
    process.env.SystemRoot = REAL_SYSTEM_ROOT;
  }
  if (REAL_WINDIR === undefined) {
    delete process.env.WINDIR;
  } else {
    process.env.WINDIR = REAL_WINDIR;
  }
  withPlatformForTest(REAL_PLATFORM);
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedPluginWorkersForTest();
});

// ─── Gate OFF — plain unwrapped spawn ───────────────────────

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
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed", "local-indexer");
    expect(cap.kind).toBe("none");
  });
});

// ─── Gate ON (macOS) — wrapped spawn + UDS + reviewer ───────

describe("spawnWorker — gate ON (macOS)", () => {
  it("registers the socketDir on the shared config, wraps with allowWrite=[socketDir,…] (FS jail only), marks wrapped, socketPath non-null", async () => {
    withPlatformForTest("darwin");
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
      allowReadPaths: ["/opt/worker", "/opt/scripts/embed.py"],
      allowWritePaths: ["/data/index"],
      udsArgName: "--uds",
    });

    const socketDir = join(lvisHome(), "plugins", "local-indexer", "run", "embed");
    const socketPath = join(socketDir, "control.sock");
    // socketDir created 0o700; stale socket unlinked before mkdir.
    expect(mkdirMock).toHaveBeenCalledWith(socketDir, { recursive: true, mode: 0o700 });
    expect(unlinkSyncMock).toHaveBeenCalledWith(socketPath);

    // The UDS allow is registered on the SHARED config (NOT per-command — that
    // channel is inert in current ASRT).
    expect(registerUdsMock).toHaveBeenCalledWith(socketDir);

    // The per-command wrap carries ONLY the FS jail (socketDir first); there is
    // NO per-command UDS option (allowUnixSocketPath / allowAllUnixSockets).
    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    const [cmdline, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowWrite: string[]; allowRead: string[]; denyRead?: string[]; denyWrite?: string[] }; allowUnixSocketPath?: string; allowAllUnixSockets?: boolean },
    ];
    expect(options.filesystem.allowWrite[0]).toBe(socketDir);
    expect(options.filesystem.allowWrite).toContain("/data/index");
    expect(options.filesystem.allowRead).toContain("/opt/worker");
    expect(options.filesystem.allowRead).toContain("/opt/scripts/embed.py");
    expect(options.allowUnixSocketPath).toBeUndefined();
    expect(options.allowAllUnixSockets).toBeUndefined();
    // The host-secret read floor MUST be restated on the worker wrap — a
    // per-command denyRead REPLACES (not unions) the shared boot array in ASRT,
    // so an absent/empty denyRead re-exposes ~/.lvis/secrets, ~/.ssh, … to the
    // worker. Non-empty array here proves the #1365 floor is carried.
    expect(Array.isArray(options.filesystem.denyRead)).toBe(true);
    expect(options.filesystem.denyRead?.length ?? 0).toBeGreaterThan(0);
    // The sensitive write floor is also restated — a per-command denyWrite
    // REPLACES the shared boot array, so worker/MCP wraps must carry it just as
    // the terminal does (#1449).
    expect(options.filesystem.denyWrite).toContain("/home/u/.zshrc");
    expect(options.filesystem.denyWrite).toContain("/home/u/.ssh");
    expect(options.filesystem.denyWrite).toContain("/home/u/.config");
    expect(options.filesystem.denyWrite).toContain("/home/u/Library/LaunchAgents");
    // The udsArgName was injected EXACTLY once (a duplicated injection would feed
    // the worker `--uds <path> --uds <path>` and break its arg contract).
    expect(cmdline).toContain("--uds");
    expect(cmdline).toContain(socketPath);
    expect((cmdline.match(/--uds/g) ?? []).length).toBe(1);

    // Spawn ran the WRAPPED argv, shell:false, stdin ignored.
    const [scmd, sargs, sopts] = spawnMock.mock.calls[0] as [string, string[], { shell: boolean }];
    expect(scmd).toBe("/bin/bash");
    expect(sargs[0]).toBe("-c");
    expect(sopts.shell).toBe(false);

    // Non-null socketPath + reviewer reports genuine asrt for the plugin tool.
    expect(worker.socketPath).toBe(socketPath);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed", "local-indexer");
    expect(cap.kind).toBe("asrt");
    expect(cap.reason).toContain("plugin worker 'local-indexer/embed' ASRT-wrapped");
  });

  it("injects the UDS path via env when udsArgName is the env form", async () => {
    withPlatformForTest("darwin");
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
    withPlatformForTest("linux");
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
    withPlatformForTest("darwin");
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
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);

    const socketDir = join(lvisHome(), "plugins", "local-indexer", "run", "embed");
    // Child dies unexpectedly → exit fires cleanup.
    child.emit("exit", 1, null);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    // The shared-config UDS allow is released exactly once.
    expect(unregisterUdsMock).toHaveBeenCalledTimes(1);
    expect(unregisterUdsMock).toHaveBeenCalledWith(socketDir);
    // Reviewer falls back to none (no stale asrt) after the worker is gone.
    expect(resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed", "local-indexer").kind).toBe("none");

    // stop() after exit must NOT double-run cleanup.
    worker.stop();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(unregisterUdsMock).toHaveBeenCalledTimes(1);
  });

  it("stop() before exit runs cleanup once; a later exit does not re-run it", async () => {
    withPlatformForTest("linux");
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
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);

    child.emit("exit", 0, "SIGTERM");
    expect(cleanupMock).toHaveBeenCalledTimes(1);
  });

  it("onExit forwards the child's exit (code + signal) to the consumer", async () => {
    withPlatformForTest("darwin");
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

    // The consumer owns lifecycle via the handle — onExit is how it learns the
    // worker died (a crash with no onExit would leave the consumer's state stuck).
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    worker.onExit((info) => exits.push(info));
    child.emit("exit", 3, null);
    expect(exits).toEqual([{ code: 3, signal: null }]);
  });
});

// ─── Windows + gate ON → holder ACL grant + srt-win wrapped TCP ─

describe("spawnWorker — Windows with gate ON", () => {
  it("wraps the worker with a dedicated holder PID ACL grant and keeps TCP control", async () => {
    withPlatformForTest("win32");
    gateActive = true;
    const restoreEnv = setEnvForTest({
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      TEMP: "C:\\Users\\test\\AppData\\Local\\Temp",
      TMP: "C:\\Users\\test\\AppData\\Local\\Temp",
      ANTHROPIC_API_KEY: "sk-should-not-reach-worker",
      LVIS_INTERNAL_SECRET: "lvis-should-not-reach-worker",
    });
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["srt-win.exe", "exec", "--", "powershell.exe", "-Command", "wrapped"],
      env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:60080" },
    });
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    const child = new StubWorkerChild();
    child.pid = 5102;
    spawnMock.mockReturnValueOnce(holder).mockReturnValueOnce(child);

    const pluginDataDir = join(lvisHome(), "plugins", "local-indexer", "data");
    const indexDir = join(pluginDataDir, "index");
    const workerScript = "C:/lvis/local-indexer/dist/worker/local_indexer_worker.py";
    const pythonExecutable = "C:/Python/python.exe";
    const worker = await (async () => {
      try {
        return await spawnWorker({
          pluginId: "local-indexer",
          workerId: "embed",
          command: pythonExecutable,
          args: [workerScript, "--host", "127.0.0.1", "--port", "17037"],
          allowReadPaths: [pythonExecutable, workerScript],
          allowWritePaths: [indexDir],
          udsArgName: "--uds",
        });
      } finally {
        restoreEnv();
      }
    })();

    expect(mkdirMock).not.toHaveBeenCalled();
    expect(registerUdsMock).not.toHaveBeenCalled();
    expect(unregisterUdsMock).not.toHaveBeenCalled();
    expect(grantWindowsWorkerFilesystemAccessMock).toHaveBeenCalledWith({
      holderPid: 5101,
      allowRead: [pythonExecutable, workerScript],
      allowWrite: [indexDir],
    });

    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    const [cmdline, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowRead?: string[]; allowWrite?: string[]; denyRead?: string[]; denyWrite?: string[] }; binShell?: string },
    ];
    expect(cmdline).toContain("& 'C:/Python/python.exe'");
    expect(cmdline).toContain("'C:/lvis/local-indexer/dist/worker/local_indexer_worker.py'");
    expect(cmdline).not.toContain("--uds");
    expect(options.binShell).toBe("powershell");
    expect(options.filesystem.allowRead).toBeUndefined();
    expect(options.filesystem.allowWrite).toBeUndefined();
    expect(options.filesystem.denyRead).toContain("/home/u/.lvis/secrets");
    expect(options.filesystem.denyWrite).toContain("/home/u/.zshrc");

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [holderCmd, holderArgs, holderOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string; env?: NodeJS.ProcessEnv; shell: boolean; stdio: unknown[] },
    ];
    expect(holderCmd).toBe("C:\\Windows\\System32\\more.com");
    expect(holderArgs).toEqual([]);
    expect(holderOpts.cwd).toBe("C:\\Windows\\System32");
    expect(holderOpts.env?.PATH).toBeUndefined();
    expect(holderOpts.shell).toBe(false);
    expect(holderOpts.stdio).toEqual(["pipe", "ignore", "ignore"]);
    const [workerCmd, workerArgs, workerOpts] = spawnMock.mock.calls[1] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv; shell: boolean; stdio: unknown[] },
    ];
    expect(workerCmd).toBe("srt-win.exe");
    expect(workerArgs[0]).toBe("exec");
    expect(workerOpts.env?.SystemRoot).toBe("C:\\Windows");
    expect(workerOpts.env?.WINDIR).toBe("C:\\Windows");
    expect(workerOpts.env?.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(workerOpts.env?.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
    expect(workerOpts.env?.LOCALAPPDATA).toBe("C:\\Users\\test\\AppData\\Local");
    expect(workerOpts.env?.TEMP).toBe("C:\\Users\\test\\AppData\\Local\\Temp");
    expect(workerOpts.env?.TMP).toBe("C:\\Users\\test\\AppData\\Local\\Temp");
    expect(workerOpts.env?.HTTPS_PROXY).toBe("http://127.0.0.1:60080");
    expect(workerOpts.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(workerOpts.env?.LVIS_INTERNAL_SECRET).toBeUndefined();
    expect(workerOpts.shell).toBe(false);
    expect(workerOpts.stdio).toEqual(["ignore", "pipe", "pipe"]);

    expect(worker.socketPath).toBeNull();
    expect(worker.pid).toBe(5102);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed", "local-indexer");
    expect(cap.kind).toBe("asrt");

    worker.stop();
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
    expect(holder.killed).toBe(true);
    const workerKillCalls = child.killCalls.length;
    holder.emit("exit", 0, "SIGTERM");
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
    expect(child.killCalls).toHaveLength(workerKillCalls);
  });

  it("terminates the Windows worker and releases grants when the holder exits first", async () => {
    withPlatformForTest("win32");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["srt-win.exe", "exec", "--", "powershell.exe", "-Command", "wrapped"],
      env: { ...process.env },
    });
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    const child = new StubWorkerChild();
    child.pid = 5102;
    spawnMock.mockReturnValueOnce(holder).mockReturnValueOnce(child);

    await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "C:/Python/python.exe",
      args: ["C:/worker.py"],
      allowReadPaths: ["C:/worker.py"],
      allowWritePaths: ["C:/index"],
    });

    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    holder.emit("exit", 1, null);

    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
    expect(child.killed).toBe(true);

    child.emit("exit", 0, null);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
  });

  it("aborts Windows worker spawn if the holder exits during grant setup", async () => {
    withPlatformForTest("win32");
    gateActive = true;
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    spawnMock.mockReturnValueOnce(holder);
    grantWindowsWorkerFilesystemAccessMock.mockImplementationOnce(async () => {
      holder.emit("exit", 1, null);
      return {
        allowRead: [],
        allowWrite: [],
        release: grantReleaseMock,
      };
    });

    await expect(
      spawnWorker({
        pluginId: "local-indexer",
        workerId: "embed",
        command: "C:/Python/python.exe",
        args: ["C:/worker.py"],
        allowReadPaths: ["C:/worker.py"],
        allowWritePaths: ["C:/index"],
      }),
    ).rejects.toThrow(/Windows ACL grant holder exited/);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
  });

  it("consumes the Windows holder spawn error when no holder pid is published", async () => {
    withPlatformForTest("win32");
    gateActive = true;
    const holder = new StubWorkerChild();
    (holder as unknown as { pid?: number }).pid = undefined;
    spawnMock.mockReturnValueOnce(holder);

    await expect(
      spawnWorker({
        pluginId: "local-indexer",
        workerId: "embed",
        command: "C:/Python/python.exe",
        args: ["C:/worker.py"],
      }),
    ).rejects.toThrow(/Windows ACL grant holder started without a pid/);

    expect(holder.listenerCount("error")).toBeGreaterThan(0);
    expect(() => holder.emit("error", new Error("spawn ENOENT"))).not.toThrow();
    expect(grantWindowsWorkerFilesystemAccessMock).not.toHaveBeenCalled();
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
  });

  it("continues Windows cleanup when grant release throws", async () => {
    withPlatformForTest("win32");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });
    grantReleaseMock.mockImplementationOnce(() => {
      throw new Error("already revoked");
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["srt-win.exe", "exec", "--", "powershell.exe", "-Command", "wrapped"],
      env: { ...process.env },
    });
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    const child = new StubWorkerChild();
    child.pid = 5102;
    spawnMock.mockReturnValueOnce(holder).mockReturnValueOnce(child);

    const worker = await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "C:/Python/python.exe",
      args: ["C:/worker.py"],
      allowReadPaths: ["C:/worker.py"],
      allowWritePaths: ["C:/index"],
    });

    expect(() => worker.stop()).not.toThrow();
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    expect(holder.killed).toBe(true);
  });

  it("rolls back the holder grant when the Windows wrap fails", async () => {
    withPlatformForTest("win32");
    gateActive = true;
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    spawnMock.mockReturnValueOnce(holder);
    wrapWorkerCommandMock.mockRejectedValueOnce(new Error("wrap failed"));

    await expect(
      spawnWorker({
        pluginId: "local-indexer",
        workerId: "embed",
        command: "C:/Python/python.exe",
        args: ["C:/worker.py"],
        allowReadPaths: ["C:/worker.py"],
        allowWritePaths: ["C:/index"],
      }),
    ).rejects.toThrow(/wrap failed/);

    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(registerUdsMock).not.toHaveBeenCalled();
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
  });
});
