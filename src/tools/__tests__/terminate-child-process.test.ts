import { afterEach, describe, expect, it, vi } from "vitest";

import { terminateChildProcess } from "../terminate-child-process.js";

function fakeChild(): {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>;
} {
  const kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>();
  const child = {
    exitCode: null,
    signalCode: null,
    killed: false,
    kill,
  };
  child.kill.mockImplementation(() => {
    // Match Node: this flips when a signal is sent, not when the child exits.
    child.killed = true;
    return true;
  });
  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("terminateChildProcess", () => {
  it("sends SIGKILL when SIGTERM was delivered but the child remains alive", () => {
    vi.useFakeTimers();
    const child = fakeChild();

    terminateChildProcess(child, 25);
    expect(child.killed).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    vi.advanceTimersByTime(25);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  });

  it("does not force-kill a child that exited normally", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    terminateChildProcess(child, 25);
    child.exitCode = 0;

    vi.advanceTimersByTime(25);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not force-kill a child that exited from SIGTERM", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    terminateChildProcess(child, 25);
    child.signalCode = "SIGTERM";

    vi.advanceTimersByTime(25);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
