import { EventEmitter } from "node:events";
import { spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

// These unit tests hand FAKE children with real-looking pids (4321, 5432) to a
// module whose tree-kill path shells out to the REAL taskkill/pgrep against
// those pids. When such a pid happens to exist on the loaded host, `taskkill
// /T /F` kills an innocent live process tree AND returns 0 — skipping the
// `child.kill("SIGKILL")` fallback these assertions pin (the observed
// full-suite-only failure). Neutralize the shell-out: a "failed" taskkill and
// a "no children" pgrep force the deterministic in-process fallback on every
// platform, and no real process is ever signalled.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
    })),
  };
});
import {
  __resetManagedChildProcessesForTest,
  assertManagedChildProcessAdmissionOpen,
  forceKillAndDrainManagedChildProcesses,
  forceKillManagedChildProcesses,
  forceKillManagedChildProcess,
  getManagedChildProcessCount,
  sealManagedChildProcessAdmission,
  trackManagedChildProcess,
} from "../managed-child-processes.js";

class FakeChildProcess extends EventEmitter {
  pid = -1;
  exitCode: number | null = null;
  kill = vi.fn(() => true);
}

function makeChild(): ChildProcess & FakeChildProcess {
  return new FakeChildProcess() as ChildProcess & FakeChildProcess;
}

afterEach(() => {
  __resetManagedChildProcessesForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const itPosix = process.platform === "win32" ? it.skip : it;

describe("managed child process tracking", () => {
  it("tracks and untracks a child process on exit", () => {
    const child = makeChild();

    trackManagedChildProcess(child, { label: "test-child" });
    expect(getManagedChildProcessCount()).toBe(1);

    child.exitCode = 0;
    child.emit("exit", 0, null);

    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("keeps a live spawned child tracked after a signal-delivery error", async () => {
    const child = makeChild();
    child.pid = 4321;
    trackManagedChildProcess(child, { label: "stubborn-mcp" });

    child.emit("error", new Error("signal delivery failed"));
    expect(getManagedChildProcessCount()).toBe(1);

    const drain = forceKillAndDrainManagedChildProcesses("clean-shutdown");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.exitCode = 137;
    child.emit("exit", 137, "SIGKILL");
    await expect(drain).resolves.toEqual({ killedCount: 1, unresolvedCount: 0 });
  });

  it("seals admission before a deferred producer can spawn", async () => {
    let releaseSetup: (() => void) | undefined;
    const setup = new Promise<void>((resolve) => { releaseSetup = resolve; });
    let spawnAttempted = false;
    const deferredProducer = (async () => {
      await setup;
      assertManagedChildProcessAdmissionOpen("tool:bash:asrt");
      spawnAttempted = true;
    })();

    sealManagedChildProcessAdmission("before-quit");
    releaseSetup?.();
    await expect(deferredProducer).rejects.toThrow(/refusing to spawn.*after shutdown started/);
    expect(spawnAttempted).toBe(false);
  });

  it("force-kills a child registered after the admission seal and retains it until exit", () => {
    const child = makeChild();
    child.pid = 5432;
    sealManagedChildProcessAdmission("before-quit");

    trackManagedChildProcess(child, { label: "late-unmigrated-producer" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(getManagedChildProcessCount()).toBe(1);

    child.exitCode = 137;
    child.emit("exit", 137, "SIGKILL");
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("force kills tracked running child processes", () => {
    const child = makeChild();
    trackManagedChildProcess(child, { label: "test-child" });

    expect(forceKillManagedChildProcesses("test-timeout")).toBe(1);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("force kills and drains a child only after its definitive exit", async () => {
    const child = makeChild();
    trackManagedChildProcess(child, { label: "stubborn-mcp" });

    const drain = forceKillAndDrainManagedChildProcesses("clean-shutdown");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(getManagedChildProcessCount()).toBe(1);

    child.exitCode = 137;
    child.emit("exit", 137, "SIGKILL");
    await expect(drain).resolves.toEqual({ killedCount: 1, unresolvedCount: 0 });
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("returns a bounded unresolved result when a child never exits", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      trackManagedChildProcess(child, { label: "unkillable-mcp" });

      const drain = forceKillAndDrainManagedChildProcesses("clean-shutdown", 20);
      await vi.advanceTimersByTimeAsync(20);
      await expect(drain).resolves.toEqual({ killedCount: 1, unresolvedCount: 1 });
      expect(getManagedChildProcessCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the kill call when the tracked child already exited (exitCode set)", () => {
    // Regression guard for the race between `before-quit` shutdown and a
    // child that resolved on its own a microtask earlier. `isKillable`
    // must short-circuit so the SIGKILL is not sent to a dead pid (which

    // could otherwise race with PID reuse and signal an unrelated
    // process on long-lived hosts).
    const child = makeChild();
    child.exitCode = 0;
    trackManagedChildProcess(child, { label: "test-already-dead" });

    expect(forceKillManagedChildProcesses("test-timeout")).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(getManagedChildProcessCount()).toBe(0);
  });


  it("force kills and untracks one specifically cancelled child", () => {
    const child = makeChild();
    trackManagedChildProcess(child, { label: "device-code-login" });

    forceKillManagedChildProcess(child, "device-code-login-cancelled");

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("does not signal a specifically cancelled child that already exited", () => {
    const child = makeChild();
    child.exitCode = 0;
    trackManagedChildProcess(child, { label: "device-code-login" });

    forceKillManagedChildProcess(child, "device-code-login-cancelled");

    expect(child.kill).not.toHaveBeenCalled();
    expect(getManagedChildProcessCount()).toBe(0);
  });
  it.each([false, true])("never signals a signal-exited root with no owned group (tracked: %s)", (tracked) => {
    const child = makeChild();
    child.pid = 4321;
    Object.assign(child, { signalCode: "SIGTERM" });
    if (tracked) trackManagedChildProcess(child, { label: "signal-exited" });
    vi.mocked(spawnSync).mockClear();
    const signal = vi.spyOn(process, "kill");

    forceKillManagedChildProcess(child, "already-exited");

    expect(spawnSync).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(getManagedChildProcessCount()).toBe(0);
  });

  itPosix("keeps a detached process group tracked after the root exits", () => {
    const child = makeChild();
    child.pid = 1234;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -1234 && (signal === 0 || signal === "SIGKILL")) return true;
      return true;
    });
    trackManagedChildProcess(child, { label: "detached-hook", killProcessGroup: true });

    child.exitCode = 0;
    child.emit("exit", 0, null);

    expect(getManagedChildProcessCount()).toBe(1);
    expect(forceKillManagedChildProcesses("test-timeout")).toBe(1);
    expect(killSpy).toHaveBeenCalledWith(-1234, "SIGKILL");
    expect(getManagedChildProcessCount()).toBe(0);
  });

  itPosix("retains cancellation ownership past the group warning threshold and warns once", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    child.pid = 1234;
    let groupAlive = true;
    const signal = vi.spyOn(process, "kill").mockImplementation((_pid, kind) => {
      if (!groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (kind === "SIGKILL") groupAlive = false;
      return true;
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    trackManagedChildProcess(child, { label: "surviving-workers", killProcessGroup: true });
    child.exitCode = 0;
    child.emit("exit", 0, null);

    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processGroupRetentionWarningMs * 2);
    expect(getManagedChildProcessCount()).toBe(1);
    expect(warning).toHaveBeenCalledOnce();
    expect(signal.mock.calls.every(([, kind]) => kind === 0)).toBe(true);

    forceKillManagedChildProcess(child, "later-shell-timeout");
    expect(signal).toHaveBeenCalledWith(-1234, "SIGKILL");
    expect(getManagedChildProcessCount()).toBe(0);
  });

  itPosix("retains an owned group after denied cancellation for a later retry", () => {
    const child = makeChild();
    child.pid = 1234;
    let denied = true;
    let groupAlive = true;
    const signal = vi.spyOn(process, "kill").mockImplementation((_pid, kind) => {
      if (!groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (kind === "SIGKILL") {
        if (denied) throw Object.assign(new Error("denied"), { code: "EPERM" });
        groupAlive = false;
      }
      return true;
    });
    trackManagedChildProcess(child, { label: "temporarily-inaccessible-group", killProcessGroup: true });
    child.exitCode = 0;
    child.emit("exit", 0, null);

    forceKillManagedChildProcess(child, "first-cancellation");
    expect(getManagedChildProcessCount()).toBe(1);
    denied = false;
    forceKillManagedChildProcess(child, "second-cancellation");
    expect(signal.mock.calls.filter(([, kind]) => kind === "SIGKILL")).toHaveLength(2);
    expect(getManagedChildProcessCount()).toBe(0);
  });

  itPosix("waits for group disappearance after signalling and never reuses a released handle", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    child.pid = 1234;
    let groupAlive = true;
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      if (!groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    trackManagedChildProcess(child, { label: "terminating-group", killProcessGroup: true });
    child.exitCode = 0;
    child.emit("exit", 0, null);

    forceKillManagedChildProcess(child, "cancellation");
    expect(getManagedChildProcessCount()).toBe(1);
    groupAlive = false;
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processGroupPollMs);
    expect(getManagedChildProcessCount()).toBe(0);

    groupAlive = true;
    signal.mockClear();
    forceKillManagedChildProcess(child, "already-released");
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processGroupPollMs);
    expect(signal).not.toHaveBeenCalled();
  });

  itPosix("bounds shutdown drain while an inaccessible group remains owned", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    child.pid = 1234;
    vi.spyOn(process, "kill").mockImplementation((_pid, kind) => {
      if (kind === "SIGKILL") throw Object.assign(new Error("denied"), { code: "EPERM" });
      return true;
    });
    trackManagedChildProcess(child, { label: "inaccessible-group", killProcessGroup: true });
    child.exitCode = 0;
    child.emit("exit", 0, null);

    const drain = forceKillAndDrainManagedChildProcesses("bounded-shutdown", 20);
    await vi.advanceTimersByTimeAsync(20);
    await expect(drain).resolves.toEqual({ killedCount: 0, unresolvedCount: 1 });
    expect(getManagedChildProcessCount()).toBe(1);
  });

  itPosix("releases immediately when signalling observes group absence", () => {
    const child = makeChild();
    child.pid = 1234;
    const signal = vi.spyOn(process, "kill").mockImplementation((_pid, kind) => {
      if (kind === "SIGKILL") throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    trackManagedChildProcess(child, { label: "disappearing-group", killProcessGroup: true });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    signal.mockClear();

    forceKillManagedChildProcess(child, "cancellation-race");
    expect(getManagedChildProcessCount()).toBe(0);
    expect(signal.mock.calls).toEqual([[-1234, 0], [-1234, "SIGKILL"]]);
    signal.mockClear();
    forceKillManagedChildProcess(child, "released-group");
    expect(signal).not.toHaveBeenCalled();
  });
});
