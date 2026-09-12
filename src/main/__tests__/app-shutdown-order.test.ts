import { createBootHostFixture, createDesktopHostFixture } from "../../__tests__/support/host-runtime.js";
/**
 * Shutdown ordering.
 *
 * `unregisterAllGlobalShortcuts()` must run FIRST in the shutdown cleanup pipeline:
 * a later step that throws or wedges must never leave the global accelerator bound
 * OS-wide after quit. `closeFileLogSink()` (PR #1503) must stay LAST on every exit
 * path (completed / failed / timed-out) so no shutdown-step log line is dropped by
 * an early sink close. The two are independent constraints on opposite ends of the
 * same pipeline.
 *
 * MUTATION CONTRACT:
 *  - Moving unregisterAllGlobalShortcuts() off the head of the pipeline makes the
 *    "closes the file log sink LAST, after unregister runs FIRST" test fail.
 *  - Moving closeFileLogSink() off the tail of the completed path makes the same
 *    test fail on its other assertion.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const calls: string[] = [];
const hostExit = vi.fn();

const unregisterAllGlobalShortcuts = vi.fn(() => calls.push("unregister"));
const closeFileLogSink = vi.fn(() => calls.push("closeFileLogSink"));
const logWarn = vi.fn();
const logError = vi.fn();
const stopLocalApiServer = vi.fn(async () => { calls.push("stopLocalApi"); });
const stopTailnetObserverServer = vi.fn(async () => { calls.push("stopTailnetObserver"); });
const stopTelegramBridgeServer = vi.fn(async () => { calls.push("stopTelegramBridge"); });
const stopRemoteA2AReceiverServer = vi.fn(async () => { calls.push("stopRemoteReceiver"); });
const stopSubscriptionRuntimes = vi.fn(async () => { calls.push("stopSubscriptionRuntimes"); });
const runShutdownRoutines = vi.fn(async () => { calls.push("shutdownRoutines"); });
const forceKillManagedChildProcesses = vi.fn((_reason: string) => {
  calls.push("forceKillManagedChildren");
  return 1;
});
const sealManagedChildProcessAdmission = vi.fn((_reason: string) => {
});
const forceKillAndDrainManagedChildProcesses = vi.fn(async (_reason: string) => {
  calls.push("drainManagedChildren");
  return { killedCount: 1, unresolvedCount: 0 };
});
const forceKillAllTerminalsForShutdown = vi.fn(async () => {
  calls.push("forceKillTerminals");
  return 1;
});

vi.mock("electron", () => ({ app: { exit: vi.fn() } }));
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: (...a: unknown[]) => logWarn(...a), error: (...a: unknown[]) => logError(...a), debug: vi.fn() }),
  logger: { flush: (cb: () => void) => cb() },
  closeFileLogSink: (...a: unknown[]) => closeFileLogSink(...a),
}));
vi.mock("../shutdown-routines.js", () => ({ runShutdownRoutines: (...a: unknown[]) => runShutdownRoutines(...a) }));
vi.mock("../local-api-server.js", () => ({ stopLocalApiServer: (...a: unknown[]) => stopLocalApiServer(...a) }));
vi.mock("../tailnet-surface-server.js", () => ({
  stopTailnetObserverServer: () => stopTailnetObserverServer(),
}));
vi.mock("../telegram-bridge-server.js", () => ({
  stopTelegramBridgeServer: () => stopTelegramBridgeServer(),
}));
vi.mock("../a2a-remote-receiver-server.js", () => ({
  stopRemoteA2AReceiverServer: () => stopRemoteA2AReceiverServer(),
}));
vi.mock("../subscription-runtime-service.js", () => ({
  stopSubscriptionRuntimes: () => stopSubscriptionRuntimes(),
}));
vi.mock("../global-shortcuts.js", () => ({
  unregisterAllGlobalShortcuts: (...a: unknown[]) => unregisterAllGlobalShortcuts(...a),
}));
vi.mock("../managed-child-processes.js", () => ({
  forceKillAndDrainManagedChildProcesses: (...a: [string]) => forceKillAndDrainManagedChildProcesses(...a),
  forceKillManagedChildProcesses: (...a: [string]) => forceKillManagedChildProcesses(...a),
  sealManagedChildProcessAdmission: (...a: [string]) => sealManagedChildProcessAdmission(...a),
}));
vi.mock("../terminal/pty-manager.js", () => ({
  forceKillAllTerminalsForShutdown: () => forceKillAllTerminalsForShutdown(),
}));
// A test that exercises the timed-out branch flips this; the body is not run
// then, exactly as a real deadline abandons a cleanup that never settles.
let hardTimeoutFires = false;
vi.mock("../shutdown-timeout.js", () => ({
  resolveShutdownCleanupTimeoutMs: (_settingMs?: number) => 5000,
  // Run the cleanup body with a never-aborted signal and report completion.
  runCleanupWithHardTimeout: async (fn: (signal: AbortSignal) => Promise<void>) => {
    if (hardTimeoutFires) return { status: "timed-out" as const };
    try {
      await fn(new AbortController().signal);
      return { status: "completed" as const };
    } catch (error) {
      return { status: "failed" as const, error };
    }
  },
}));

const getServices = vi.fn();
let shutdownCompleted = false;
vi.mock("../app-state.js", () => ({
  getServices: (...a: unknown[]) => getServices(...a),
  isAppShutdownCompleted: () => shutdownCompleted,
  setAppShutdownCompleted: (v: boolean) => {
    shutdownCompleted = v;
  },
  setAppShutdownStarted: vi.fn(),
}));

async function configuredShutdown() {
  const runtime = await import("../app-shutdown.js");
  runtime.configureAppShutdownHost(createBootHostFixture({
    exit: hostExit,
    desktop: createDesktopHostFixture({ beforeShutdown: unregisterAllGlobalShortcuts }),
  }));
  return runtime;
}

function makeServices() {
  return {
    runPluginShutdownHandlers: vi.fn(async () => { calls.push("pluginShutdownHandlers"); }),
    shutdown: vi.fn(async () => { calls.push("servicesShutdown"); }),
    pluginRuntime: { stopAll: vi.fn(async () => { calls.push("stopPluginRuntime"); }) },
    // The cleanup window is a Settings control now, so the shutdown path reads
    // the persisted value before it arms the deadline.
    settingsService: { get: vi.fn(() => ({})) },
  };
}

beforeEach(() => {
  calls.length = 0;
  shutdownCompleted = false;
  vi.clearAllMocks();
});

describe("runAppShutdownCleanup ordering (critic M1)", () => {
  it("drains partial bootstrap callbacks and children without published AppServices", async () => {
    getServices.mockReturnValue(undefined);
    vi.resetModules();
    const shutdown = await configuredShutdown();
    shutdown.registerBootPluginShutdown(async () => { calls.push("partialPluginShutdown"); });
    shutdown.registerShutdownHook("partial-watcher", () => { calls.push("partialWatcher"); });
    const host = createBootHostFixture({ close: async () => { calls.push("closeHost"); } });
    expect(await shutdown.runIncompleteBootShutdown(host)).toBe("completed");
    expect(calls).toEqual([
      "partialWatcher", "partialPluginShutdown", "stopSubscriptionRuntimes",
      "forceKillTerminals", "drainManagedChildren", "closeHost", "closeFileLogSink",
    ]);
    expect(sealManagedChildProcessAdmission).toHaveBeenCalledWith("host bootstrap interrupted or failed");
    shutdown.registerShutdownHook("late-watcher", () => { calls.push("lateWatcher"); });
    expect(calls.at(-1)).toBe("lateWatcher");
  });

  it("force-kills managed children when partial bootstrap cleanup exceeds its deadline", async () => {
    getServices.mockReturnValue(undefined);
    vi.resetModules();
    const shutdown = await configuredShutdown();
    hardTimeoutFires = true;
    try {
      expect(await shutdown.runIncompleteBootShutdown()).toBe("timed-out");
      expect(forceKillManagedChildProcesses).toHaveBeenCalledWith("host bootstrap interrupted or failed");
      expect(forceKillAllTerminalsForShutdown).toHaveBeenCalled();
      expect(calls.at(-1)).toBe("closeFileLogSink");
    } finally {
      hardTimeoutFires = false;
    }
  });

  it("attempts independent partial cleanup stages after a plugin shutdown rejection", async () => {
    getServices.mockReturnValue(undefined);
    vi.resetModules();
    const shutdown = await configuredShutdown();
    shutdown.registerBootPluginShutdown(async () => { throw new Error("plugin stop failed"); });
    const close = vi.fn(async () => {});
    expect(await shutdown.runIncompleteBootShutdown(createBootHostFixture({ close }))).toBe("failed");
    expect(stopSubscriptionRuntimes).toHaveBeenCalledOnce();
    expect(forceKillAllTerminalsForShutdown).toHaveBeenCalled();
    expect(forceKillAndDrainManagedChildProcesses).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toBe("closeFileLogSink");
  });

  it("exits a timed-out cleanup with the code a headless run already chose", async () => {
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();
    const previous = process.exitCode;
    process.exitCode = 2;
    hardTimeoutFires = true;
    try {
      const outcome = await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: true });
      expect(outcome).toBe("timed-out");
      expect(hostExit).toHaveBeenCalledWith(2);
    } finally {
      process.exitCode = previous;
      hardTimeoutFires = false;
    }
  });

  // PR #1503 cross-PR check: the log-sink close (added on main after this file
  // was authored) must remain the LAST step on the happy path, coexisting with
  // unregisterAllGlobalShortcuts staying FIRST — the two orderings are
  // independent constraints on opposite ends of the pipeline.
  it("closes the file log sink LAST, after unregister runs FIRST", async () => {
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();
    const outcome = await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false });
    expect(outcome).toBe("completed");
    expect(sealManagedChildProcessAdmission).toHaveBeenCalledWith("before-quit");
    expect(calls[0]).toBe("unregister");
    expect(calls.at(-1)).toBe("closeFileLogSink");
    expect(calls.indexOf("unregister")).toBeLessThan(calls.indexOf("closeFileLogSink"));
  });

  it("keeps subscription runtimes live through shutdown callbacks, then stops them at the service boundary", async () => {
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();
    await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false });
    expect(calls.indexOf("stopLocalApi")).toBeLessThan(calls.indexOf("stopRemoteReceiver"));
    expect(calls.indexOf("stopLocalApi")).toBeLessThan(calls.indexOf("stopTailnetObserver"));
    expect(calls.indexOf("stopTailnetObserver")).toBeLessThan(calls.indexOf("stopTelegramBridge"));
    expect(calls.indexOf("stopTelegramBridge")).toBeLessThan(calls.indexOf("stopRemoteReceiver"));
    expect(calls.indexOf("stopTailnetObserver")).toBeLessThan(calls.indexOf("servicesShutdown"));
    expect(calls.indexOf("stopTelegramBridge")).toBeLessThan(calls.indexOf("servicesShutdown"));
    expect(calls.indexOf("stopRemoteReceiver")).toBeLessThan(calls.indexOf("servicesShutdown"));
    expect(calls.indexOf("pluginShutdownHandlers")).toBeLessThan(calls.indexOf("shutdownRoutines"));
    expect(calls.indexOf("shutdownRoutines")).toBeLessThan(calls.indexOf("stopSubscriptionRuntimes"));
    expect(calls.indexOf("stopSubscriptionRuntimes")).toBeLessThan(calls.indexOf("servicesShutdown"));
    expect(calls.indexOf("servicesShutdown")).toBeLessThan(calls.indexOf("forceKillTerminals"));
    expect(calls.indexOf("forceKillTerminals")).toBeLessThan(calls.indexOf("stopPluginRuntime"));
    expect(calls.indexOf("stopPluginRuntime")).toBeLessThan(calls.indexOf("drainManagedChildren"));
    expect(forceKillAndDrainManagedChildProcesses)
      .toHaveBeenCalledWith("before-quit graceful shutdown");
    expect(calls.indexOf("stopRemoteReceiver")).toBeLessThan(calls.indexOf("stopSubscriptionRuntimes"));
  });

  it("stops subscription runtimes and preserves a plugin failure when its fallback stop also fails", async () => {
    const services = makeServices();
    services.runPluginShutdownHandlers.mockImplementationOnce(async () => {
      calls.push("pluginShutdownHandlers-throw");
      throw new Error("plugin root failure");
    });
    stopSubscriptionRuntimes.mockImplementationOnce(async () => {
      calls.push("stopSubscriptionRuntimes-throw");
      throw new Error("subscription fallback stop failure");
    });
    getServices.mockReturnValue(services);
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();

    await expect(runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false }))
      .resolves.toBe("failed");

    expect(calls.indexOf("pluginShutdownHandlers-throw"))
      .toBeLessThan(calls.indexOf("stopSubscriptionRuntimes-throw"));
    expect(calls).toContain("forceKillManagedChildren");
    expect(services.shutdown).not.toHaveBeenCalled();
    expect(runShutdownRoutines).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith("shutdown: subscription runtime fallback stop failed");
    expect(logError).toHaveBeenCalledWith(
      { killedChildCount: 1 },
      "%s: shutdown cleanup failed: %s",
      "before-quit",
      "plugin root failure",
    );
  });

  it("stops subscription runtimes after a routine failure and then uses the managed-child backstop", async () => {
    const services = makeServices();
    runShutdownRoutines.mockImplementationOnce(async () => {
      calls.push("shutdownRoutines-throw");
      throw new Error("routine root failure");
    });
    getServices.mockReturnValue(services);
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();

    await expect(runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false }))
      .resolves.toBe("failed");

    expect(calls.indexOf("pluginShutdownHandlers"))
      .toBeLessThan(calls.indexOf("shutdownRoutines-throw"));
    expect(calls.indexOf("shutdownRoutines-throw"))
      .toBeLessThan(calls.indexOf("stopSubscriptionRuntimes"));
    expect(calls.indexOf("stopSubscriptionRuntimes"))
      .toBeLessThan(calls.indexOf("forceKillManagedChildren"));
    expect(services.shutdown).not.toHaveBeenCalled();
    expect(forceKillManagedChildProcesses).toHaveBeenCalledWith("before-quit cleanup failed");
    expect(logError).toHaveBeenCalledWith(
      { killedChildCount: 1 },
      "%s: shutdown cleanup failed: %s",
      "before-quit",
      "routine root failure",
    );
  });
});

/**
 * Shutdown hooks, and the listener ceiling they exist to keep.
 *
 * Node warns once an emitter passes ten listeners for one event. Electron's
 * `App` is a single long-lived emitter and `before-quit` is the event every
 * subsystem wants, so one listener per subsystem put a
 * `MaxListenersExceededWarning` on stderr of every launch — which a one-shot
 * `--exec` run hands to its caller as if the run had leaked something.
 *
 * The bound is structural rather than a raised ceiling: teardown that needs no
 * ordering registers a hook and shares the one listener `src/main.ts` owns, so
 * the listener count does not move when a subsystem is added. The source scan
 * at the bottom is what holds that: it fails the moment a new module takes a
 * `before-quit` listener of its own.
 */
describe("shutdown hooks", () => {
  it("runs every hook once, in registration order", async () => {
    vi.resetModules();
    const { registerShutdownHook, runShutdownHooks } = await configuredShutdown();
    const ran: string[] = [];
    registerShutdownHook("first", () => ran.push("first"));
    registerShutdownHook("second", () => ran.push("second"));

    runShutdownHooks();
    runShutdownHooks();

    expect(ran).toEqual(["first", "second"]);
  });

  it("runs a hook registered after the drain immediately, and only once", async () => {
    // Boot can still be registering while a quit is in flight: the drain has
    // already happened, the ordered cleanup declined because AppServices did
    // not exist yet, and the plugin runtime deferred the quit. A hook that
    // arrives then belongs to a drain that has passed, and a second drain
    // never comes — so it has to run on the spot.
    vi.resetModules();
    const { registerShutdownHook, runShutdownHooks } = await configuredShutdown();
    runShutdownHooks();

    const late = vi.fn();
    registerShutdownHook("registered-after-drain", late);
    expect(late).toHaveBeenCalledTimes(1);

    runShutdownHooks();
    expect(late).toHaveBeenCalledTimes(1);

    // Same containment as the drain: a late hook that throws must not surface
    // in the middle of the boot step that registered it.
    expect(() =>
      registerShutdownHook("late-and-throws", () => {
        throw new Error("timer already gone");
      }),
    ).not.toThrow();
    expect(logWarn).toHaveBeenCalledWith(
      "shutdown hook failed (%s): %s",
      "late-and-throws",
      "timer already gone",
    );
  });

  it("contains a throwing hook so the ones after it still run", async () => {
    vi.resetModules();
    const { registerShutdownHook, runShutdownHooks } = await configuredShutdown();
    const ran: string[] = [];
    registerShutdownHook("throws", () => {
      throw new Error("timer already gone");
    });
    registerShutdownHook("after", () => ran.push("after"));

    runShutdownHooks();

    expect(ran).toEqual(["after"]);
    expect(logWarn).toHaveBeenCalledWith(
      "shutdown hook failed (%s): %s",
      "throws",
      "timer already gone",
    );
  });
});

/**
 * Every `before-quit` listener in the shipped main process, by file.
 *
 * Source inspection rather than a runtime count: the registrations are spread
 * across boot steps that a single test cannot execute together, and the
 * property being locked is "no module takes its own listener", which is a
 * property of the source.
 */
describe("before-quit listener inventory", () => {
  /**
   * One entry per file allowed to register an Electron `before-quit` listener,
   * with the reason it cannot be a shutdown hook instead.
   */
  const ALLOWED_LISTENER_FILES: ReadonlyMap<string, string> = new Map([
    [
      "src/main.ts",
      "the quit orchestrator: runs the hooks, then defers the quit for the ordered cleanup",
    ],
    [
      "src/boot/desktop-host-runtime.ts",
      "defers the quit to await plugin shutdown handlers during the boot window, before AppServices is published",
    ],
  ]);

  function collectSourceFiles(dir: string, out: string[]): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "__mocks__") continue;
        collectSourceFiles(full, out);
      } else if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  it("is exactly the two listeners the host documents", () => {
    const srcRoot = resolve(process.cwd(), "src");
    const registration =
      /\bapp\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*"before-quit"/u;
    const found = collectSourceFiles(srcRoot, [])
      .filter((file) => registration.test(readFileSync(file, "utf-8")))
      .map((file) => relative(process.cwd(), file))
      .sort();

    const allowed = [...ALLOWED_LISTENER_FILES.keys()].sort();
    const why = [...ALLOWED_LISTENER_FILES]
      .map(([file, reason]) => `  ${file} — ${reason}`)
      .join("\n");
    expect(
      found,
      [
        "The set of files registering an Electron `before-quit` listener changed.",
        "Allow-list (src/main/__tests__/app-shutdown-order.test.ts, ALLOWED_LISTENER_FILES):",
        why,
        "A new listener needs an entry here only when its teardown CANNOT be a",
        "shutdown hook — it has to call event.preventDefault(), or its position",
        "relative to another teardown step matters. Everything else belongs in",
        "registerShutdownHook() (src/main/app-shutdown.ts), which shares the one",
        "listener main.ts owns and keeps the App emitter under Node's ceiling.",
      ].join("\n"),
    ).toEqual(allowed);
  });
});
