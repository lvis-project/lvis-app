/**
 * Linux ASRT runtime probe — adapter-level regression coverage.
 *
 * ASRT's dependency check is binary-only on Linux. These mocks prove LVIS only
 * reports the adapter active after the exact initialized wrapper can spawn a
 * fixed, no-I/O command; any wrapper, timeout, or cleanup failure resets the
 * initialized singleton before boot can publish a verified capability.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { setProcessPlatform } from "../../testing/process-platform.js";

const h = vi.hoisted(() => ({
  initialize: vi.fn(),
  wrapWithSandboxArgv: vi.fn(),
  cleanupAfterCommand: vi.fn(),
  reset: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: h.initialize,
    wrapWithSandboxArgv: h.wrapWithSandboxArgv,
    cleanupAfterCommand: h.cleanupAfterCommand,
    reset: h.reset,
  },
}));

vi.mock("node:child_process", () => ({
  spawn: h.spawn,
}));

import {
  ASRT_LINUX_RUNTIME_PROBE_ERROR_CODE,
  initializeAsrtSandbox,
  isAsrtLinuxRuntimeProbeError,
  isAsrtSandboxActive,
  resetAsrtSandbox,
} from "../asrt-sandbox.js";

const ORIGINAL_PLATFORM = process.platform;
const CONFIGURED_LINUX_BWRAP_COMMAND =
  "/configured/asrt/bwrap --new-session --die-with-parent --unshare-user --cap-drop ALL --proc /proc -- /bin/bash -c true";

interface ProbeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
}

function childThatCloses(
  code: number | null,
  signal: NodeJS.Signals | null = null,
): ProbeChild {
  const child = new EventEmitter() as ProbeChild;
  child.kill = vi.fn(() => true);
  // Queue after spawn() returns so the adapter has registered close/error
  // listeners. Real ChildProcess events are asynchronous too.
  queueMicrotask(() => child.emit("close", code, signal));
  return child;
}

function childThatNeverCloses(): ProbeChild {
  const child = new EventEmitter() as ProbeChild;
  child.kill = vi.fn(() => true);
  return child;
}

function childThatErrors(code: string): ProbeChild {
  const child = new EventEmitter() as ProbeChild;
  child.kill = vi.fn(() => true);
  queueMicrotask(() => {
    child.emit("error", Object.assign(new Error("configured wrapper denied"), { code }));
  });
  return child;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  setProcessPlatform("linux");
  h.initialize.mockResolvedValue(undefined);
  h.wrapWithSandboxArgv.mockResolvedValue({
    // This is the exact shape ASRT uses on Linux: its outer shell runs a
    // rendered bwrap command. The adapter must spawn it untouched, not `true`.
    argv: ["/bin/bash", "-c", CONFIGURED_LINUX_BWRAP_COMMAND],
    env: { ASRT_PROBE_ENV: "configured" },
  });
  h.cleanupAfterCommand.mockImplementation(() => undefined);
  h.reset.mockResolvedValue(undefined);
  h.spawn.mockImplementation(() => childThatCloses(0));
});

afterEach(async () => {
  vi.useRealTimers();
  if (isAsrtSandboxActive()) {
    await resetAsrtSandbox();
  }
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("initializeAsrtSandbox — Linux configured-wrapper runtime probe", () => {
  it("runs the fixed no-I/O command through ASRT's exact configured argv before activation", async () => {
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

    expect(h.wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
    const wrapCall = h.wrapWithSandboxArgv.mock.calls[0];
    expect(wrapCall?.[0]).toBe("true");
    expect(wrapCall?.[1]).toBeUndefined();
    expect(wrapCall?.[2]).toBeUndefined();
    expect(wrapCall?.[3]).toBeInstanceOf(AbortSignal);
    expect(wrapCall?.[4]).toBe(process.cwd());
    expect(h.spawn).toHaveBeenCalledWith(
      "/bin/bash",
      ["-c", CONFIGURED_LINUX_BWRAP_COMMAND],
      {
        cwd: process.cwd(),
        env: { ASRT_PROBE_ENV: "configured" },
        shell: false,
        stdio: "ignore",
      },
    );
    const spawnedBwrapCommand = h.spawn.mock.calls[0]?.[1]?.[1];
    expect(spawnedBwrapCommand).toContain("bwrap");
    expect(spawnedBwrapCommand).toContain("--unshare-user");
    expect(spawnedBwrapCommand).toContain("--cap-drop");
    expect(spawnedBwrapCommand).toContain("ALL");
    // The wrapper descriptor, not `true` directly, is the only spawn target.
    expect(h.spawn).not.toHaveBeenCalledWith("true", expect.anything(), expect.anything());
    expect(h.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(isAsrtSandboxActive()).toBe(true);
  });

  it.each(["darwin", "win32"] as const)(
    "does not invoke the Linux probe on %s",
    async (platform) => {
      setProcessPlatform(platform);

      await initializeAsrtSandbox({ allowedDomains: [] });

      expect(isAsrtSandboxActive()).toBe(true);
      expect(h.wrapWithSandboxArgv).not.toHaveBeenCalled();
      expect(h.spawn).not.toHaveBeenCalled();
    },
  );
  it("resets the initialized manager and leaves the adapter inactive when the configured wrapper exits non-zero", async () => {
    h.spawn.mockImplementation(() => childThatCloses(1));

    const failure = initializeAsrtSandbox({ allowedDomains: [] });
    await expect(failure).rejects.toSatisfy((error: unknown) => {
      return (
        isAsrtLinuxRuntimeProbeError(error) &&
        error.code === ASRT_LINUX_RUNTIME_PROBE_ERROR_CODE
      );
    });

    expect(isAsrtSandboxActive()).toBe(false);
    expect(h.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });

  it("turns an EPERM configured-wrapper error into degradation, never verified capability", async () => {
    // A hardened Linux host can deny the bwrap/user-namespace setup with EPERM.
    // We intentionally do not scrape wrapper stderr; the typed probe result is
    // enough for boot to degrade and keep the capability source of truth inactive.
    h.spawn.mockImplementation(() => childThatErrors("EPERM"));

    const failure = initializeAsrtSandbox({ allowedDomains: [] });
    await expect(failure).rejects.toSatisfy((error: unknown) => {
      return (
        isAsrtLinuxRuntimeProbeError(error) &&
        error.code === ASRT_LINUX_RUNTIME_PROBE_ERROR_CODE
      );
    });

    expect(isAsrtSandboxActive()).toBe(false);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });

  it("treats a cleanup failure as a typed degradation and resets before capability publication", async () => {
    h.cleanupAfterCommand.mockImplementation(() => {
      throw new Error("cleanup failed");
    });

    const failure = initializeAsrtSandbox({ allowedDomains: [] });
    await expect(failure).rejects.toSatisfy((error: unknown) => {
      return isAsrtLinuxRuntimeProbeError(error);
    });

    expect(isAsrtSandboxActive()).toBe(false);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });

  it("times out without a plain fallback, waits a bounded close grace, and resets the manager", async () => {
    vi.useFakeTimers();
    let child: ProbeChild | undefined;
    h.spawn.mockImplementation(() => {
      child = childThatNeverCloses();
      return child;
    });

    const failure = initializeAsrtSandbox({ allowedDomains: [] });
    // Attach the rejection observer before advancing fake time so Vitest does
    // not see the expected timeout as an unhandled rejection.
    const expectedFailure = expect(failure).rejects.toSatisfy((error: unknown) => {
      return isAsrtLinuxRuntimeProbeError(error);
    });
    // Fake timers also own queueMicrotask in this runner. Flush zero-time work
    // before advancing to the fixed five-second timeout.
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(h.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child?.kill).toHaveBeenCalledWith("SIGKILL");
    expect(h.cleanupAfterCommand).not.toHaveBeenCalled();
    expect(h.reset).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(h.cleanupAfterCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expectedFailure;

    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(isAsrtSandboxActive()).toBe(false);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });

  it("waits for a SIGKILL close before ASRT cleanup and reset", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let child: ProbeChild | undefined;
    h.spawn.mockImplementation(() => {
      child = childThatNeverCloses();
      child.kill.mockImplementation(() => {
        order.push("kill");
        return true;
      });
      return child;
    });
    h.cleanupAfterCommand.mockImplementation(() => {
      order.push("cleanup");
    });
    h.reset.mockImplementation(async () => {
      order.push("reset");
    });

    const failure = initializeAsrtSandbox({ allowedDomains: [] });
    const expectedFailure = expect(failure).rejects.toSatisfy((error: unknown) => {
      return isAsrtLinuxRuntimeProbeError(error);
    });
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(order).toEqual(["kill"]);
    expect(h.cleanupAfterCommand).not.toHaveBeenCalled();
    child?.emit("close", null, "SIGKILL");
    await expectedFailure;

    expect(order).toEqual(["kill", "cleanup", "reset"]);
    expect(isAsrtSandboxActive()).toBe(false);
  });
});