/**
 * E4 cluster-review critic M1 — shutdown ordering.
 *
 * `unregisterAllGlobalShortcuts()` must run BEFORE `getWindowManager().persistAll()`
 * in the shutdown cleanup pipeline. persistAll() can throw; if the accelerator
 * release were ordered after it, a throwing persistAll would leave the global
 * accelerator bound OS-wide after quit. These tests assert the call order and,
 * critically, that a throwing persistAll does not prevent the unregister.
 *
 * PR #1503 (log sink) landed on main after this test was authored and added a
 * `closeFileLogSink()` call as the LAST step of every exit path (completed /
 * failed / timed-out) so no shutdown-step log line is dropped by an early sink
 * close. That ordering is orthogonal to — and must survive — the
 * unregister-before-persistAll fix here: `closeFileLogSink` stays last while
 * `unregisterAllGlobalShortcuts` stays first.
 *
 * MUTATION CONTRACT:
 *  - Moving unregisterAllGlobalShortcuts() back after persistAll() makes the
 *    "throwing persistAll still releases accelerators" test fail.
 *  - Moving closeFileLogSink() off the tail of the completed path makes the
 *    "closes the file log sink LAST" test fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

const unregisterAllGlobalShortcuts = vi.fn(() => calls.push("unregister"));
const persistAll = vi.fn(() => calls.push("persistAll"));
const closeFileLogSink = vi.fn(() => calls.push("closeFileLogSink"));
const stopLocalApiServer = vi.fn(async () => { calls.push("stopLocalApi"); });
const stopRemoteA2AReceiverServer = vi.fn(async () => { calls.push("stopRemoteReceiver"); });

vi.mock("electron", () => ({ app: { exit: vi.fn() } }));
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { flush: (cb: () => void) => cb() },
  closeFileLogSink: (...a: unknown[]) => closeFileLogSink(...a),
}));
vi.mock("../shutdown-routines.js", () => ({ runShutdownRoutines: vi.fn(async () => undefined) }));
vi.mock("../local-api-server.js", () => ({ stopLocalApiServer: (...a: unknown[]) => stopLocalApiServer(...a) }));
vi.mock("../a2a-remote-receiver-server.js", () => ({
  stopRemoteA2AReceiverServer: (...a: unknown[]) => stopRemoteA2AReceiverServer(...a),
}));
vi.mock("../global-shortcuts.js", () => ({
  unregisterAllGlobalShortcuts: (...a: unknown[]) => unregisterAllGlobalShortcuts(...a),
}));
vi.mock("../managed-child-processes.js", () => ({ forceKillManagedChildProcesses: vi.fn(() => 0) }));
vi.mock("../terminal/pty-manager.js", () => ({ killAllTerminals: vi.fn() }));
vi.mock("../shutdown-timeout.js", () => ({
  resolveShutdownCleanupTimeoutMs: () => 5000,
  // Run the cleanup body with a never-aborted signal and report completion.
  runCleanupWithHardTimeout: async (fn: (signal: AbortSignal) => Promise<void>) => {
    try {
      await fn(new AbortController().signal);
      return { status: "completed" as const };
    } catch (error) {
      return { status: "failed" as const, error };
    }
  },
}));

const getServices = vi.fn();
const getWindowManager = vi.fn(() => ({ persistAll: (...a: unknown[]) => persistAll(...a) }));
let shutdownCompleted = false;
vi.mock("../app-state.js", () => ({
  getServices: (...a: unknown[]) => getServices(...a),
  getWindowManager: (...a: unknown[]) => getWindowManager(...a),
  isAppShutdownCompleted: () => shutdownCompleted,
  setAppShutdownCompleted: (v: boolean) => {
    shutdownCompleted = v;
  },
  setAppShutdownStarted: vi.fn(),
}));

function makeServices() {
  return {
    runPluginShutdownHandlers: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => { calls.push("servicesShutdown"); }),
    pluginRuntime: { stopAll: vi.fn(async () => undefined) },
  };
}

beforeEach(() => {
  calls.length = 0;
  shutdownCompleted = false;
  vi.clearAllMocks();
  getWindowManager.mockReturnValue({ persistAll: (...a: unknown[]) => persistAll(...a) });
});

describe("runAppShutdownCleanup ordering (critic M1)", () => {
  it("releases global shortcuts BEFORE persisting window state", async () => {
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await import("../app-shutdown.js");
    const outcome = await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false });
    expect(outcome).toBe("completed");
    expect(calls.indexOf("unregister")).toBeLessThan(calls.indexOf("persistAll"));
  });

  it("still releases global shortcuts when persistAll throws", async () => {
    getServices.mockReturnValue(makeServices());
    persistAll.mockImplementationOnce(() => {
      calls.push("persistAll-throw");
      throw new Error("persist failed");
    });
    vi.resetModules();
    const { runAppShutdownCleanup } = await import("../app-shutdown.js");
    await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false });
    // The unregister must have already run before the throwing persistAll.
    expect(calls).toContain("unregister");
    expect(calls.indexOf("unregister")).toBeLessThan(calls.indexOf("persistAll-throw"));
  });

  // PR #1503 cross-PR check: the log-sink close (added on main after this file
  // was authored) must remain the LAST step on the happy path, coexisting with
  // unregisterAllGlobalShortcuts staying FIRST — the two orderings are
  // independent constraints on opposite ends of the pipeline.
  it("closes the file log sink LAST, after unregister runs FIRST", async () => {
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await import("../app-shutdown.js");
    const outcome = await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false });
    expect(outcome).toBe("completed");
    expect(calls[0]).toBe("unregister");
    expect(calls.at(-1)).toBe("closeFileLogSink");
    expect(calls.indexOf("unregister")).toBeLessThan(calls.indexOf("closeFileLogSink"));
  });

  it("stops the independent receiver before disposing its owning services runtime", async () => {
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await import("../app-shutdown.js");
    await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false });
    expect(calls.indexOf("stopLocalApi")).toBeLessThan(calls.indexOf("stopRemoteReceiver"));
    expect(calls.indexOf("stopRemoteReceiver")).toBeLessThan(calls.indexOf("servicesShutdown"));
  });
});
