import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetManagedChildProcessesForTest,
  forceKillManagedChildProcesses,
  getManagedChildProcessCount,
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
  vi.restoreAllMocks();
  __resetManagedChildProcessesForTest();
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

  it("force kills tracked running child processes", () => {
    const child = makeChild();
    trackManagedChildProcess(child, { label: "test-child" });

    expect(forceKillManagedChildProcesses("test-timeout")).toBe(1);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(getManagedChildProcessCount()).toBe(0);
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
});
