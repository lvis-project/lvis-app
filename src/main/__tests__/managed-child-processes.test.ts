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
  __resetManagedChildProcessesForTest();
});

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
});
