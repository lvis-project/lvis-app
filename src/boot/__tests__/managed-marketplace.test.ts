import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetBootstrapInFlightForTest,
  resolveManagedPluginBootstrap,
  runManagedBootstrap,
} from "../managed-marketplace.js";
import type { PluginMarketplaceService } from "../../plugins/marketplace.js";
import { PluginRuntimePreStartPhase } from "../steps/plugin-runtime/pre-start-phase.js";

describe("resolveManagedPluginBootstrap", () => {
  it("disables network-managed bootstrap in isolated E2E test mode", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "real-cloud", cloudBaseUrl: "https://marketplace.lvis.internal" },
      e2eTestMode: true,
    })).toEqual({ enabled: false, reason: "e2e-isolated" });
  });

  it("disables bootstrap when no base URL is configured", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "real-cloud" },
    })).toEqual({ enabled: false, reason: "no-base-url" });
  });

  it("enables bootstrap when a base URL is configured", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "real-cloud", cloudBaseUrl: "https://marketplace.lvis.internal" },
    })).toEqual({ enabled: true });
  });
});

/**
 * The unreachable-catalog outcome is the one the status surface exists for, and
 * it is the one that looks identical to a clean run on the wire: empty
 * `installed`, empty `failed`. Only the forwarded skip code separates them.
 */
describe("runManagedBootstrap skip reporting", () => {
  afterEach(() => {
    _resetBootstrapInFlightForTest();
  });

  function captureStatusWindow(): {
    window: never;
    sends: Array<[string, unknown]>;
  } {
    const sends: Array<[string, unknown]> = [];
    const window = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sends.push([channel, payload]);
        },
      },
    } as unknown as never;
    return { window, sends };
  }

  it("forwards the ensure result's skip code and detail on the complete event", async () => {
    const { window, sends } = captureStatusWindow();
    const ensureManagedInstalled = vi.fn(async () => ({
      installed: [],
      updated: [],
      removed: [],
      failed: [],
      skipped: { reason: "catalog-unreachable" as const, detail: "ENOTFOUND marketplace" },
    }));

    await runManagedBootstrap({
      pluginMarketplace: { ensureManagedInstalled } as unknown as PluginMarketplaceService,
      ensurePluginStateReadyForInstall: vi.fn(async () => undefined),
      mainWindow: window,
      mode: "repair-missing-only",
      activatePreparedArtifact: vi.fn(),
      marketplace: {
        backend: "real-cloud" as const,
        cloudBaseUrl: "https://marketplace.example.com",
      },
    });

    expect(sends.map(([, payload]) => payload)).toEqual([
      { phase: "start" },
      {
        phase: "complete",
        installed: [],
        failed: [],
        skipped: { reason: "catalog-unreachable", detail: "ENOTFOUND marketplace" },
      },
    ]);
  });

  it("leaves skipped undefined when the pass actually ran", async () => {
    const { window, sends } = captureStatusWindow();
    const ensureManagedInstalled = vi.fn(async () => ({
      installed: ["calendar"],
      updated: [],
      removed: [],
      failed: [],
    }));

    await runManagedBootstrap({
      pluginMarketplace: { ensureManagedInstalled } as unknown as PluginMarketplaceService,
      ensurePluginStateReadyForInstall: vi.fn(async () => undefined),
      mainWindow: window,
      mode: "repair-missing-only",
      activatePreparedArtifact: vi.fn(),
      marketplace: {
        backend: "real-cloud" as const,
        cloudBaseUrl: "https://marketplace.example.com",
      },
    });

    const complete = sends.at(-1)?.[1] as { skipped?: unknown };
    expect(complete.skipped).toBeUndefined();
  });
});

describe("runManagedBootstrap concurrency", () => {
  afterEach(() => {
    _resetBootstrapInFlightForTest();
  });

  it("coalesces concurrent retries onto a single ensureManagedInstalled call", async () => {
    let releaseEnsure: () => void = () => {};
    const ensureResult = { installed: ["calendar"], failed: [] };
    const ensureManagedInstalled = vi.fn(
      () =>
        new Promise<typeof ensureResult>((resolve) => {
          releaseEnsure = () => resolve(ensureResult);
        }),
    );
    const pluginMarketplace = { ensureManagedInstalled } as unknown as PluginMarketplaceService;
    const input = {
      pluginMarketplace,
      ensurePluginStateReadyForInstall: vi.fn(async () => undefined),
      mainWindow: null,
      mode: "repair-missing-only" as const,
      activatePreparedArtifact: vi.fn(),
      marketplace: {
        backend: "real-cloud" as const,
        cloudBaseUrl: "https://marketplace.example.com",
      },
    };

    // Three concurrent callers — the first kicks off ensureManagedInstalled,
    // the next two await the same in-flight promise instead of starting
    // fresh runs that would race on the generation transaction.
    const promises = [
      runManagedBootstrap(input),
      runManagedBootstrap(input),
      runManagedBootstrap(input),
    ];
    expect(ensureManagedInstalled).toHaveBeenCalledTimes(1);

    releaseEnsure();
    await Promise.all(promises);

    expect(ensureManagedInstalled).toHaveBeenCalledTimes(1);
    expect(ensureManagedInstalled).toHaveBeenCalledWith({
      mode: "repair-missing-only",
      ensurePluginStateReadyForInstall: expect.any(Function),
      activatePreparedArtifact: expect.any(Function),
    });
  });

  it("admits explicit durable-only sync without invoking live runtime activation", async () => {
    const ensureResult = { installed: [], updated: ["meeting"], failed: [] };
    const ensureManagedInstalled = vi.fn(async () => ensureResult);
    const pluginMarketplace = { ensureManagedInstalled } as unknown as PluginMarketplaceService;
    const admissionSpy = vi.fn();
    const admitPreStartOperation = <T>(operation: () => Promise<T>): Promise<T> => {
      admissionSpy();
      return operation();
    };

    await runManagedBootstrap({
      pluginMarketplace,
      ensurePluginStateReadyForInstall: vi.fn(async () => undefined),
      mainWindow: null,
      mode: "pre-start-sync",
      admitPreStartOperation,
      removeDelistedAdminInstall: async (
        _removal: { pluginId: string; secretKeys: readonly string[] },
        commitRegistryRemoval: () => Promise<void>,
      ) => { await commitRegistryRemoval(); },
      marketplace: {
        backend: "real-cloud" as const,
        cloudBaseUrl: "https://marketplace.example.com",
      },
    });

    expect(ensureManagedInstalled).toHaveBeenCalledWith({
      mode: "pre-start-sync",
      ensurePluginStateReadyForInstall: expect.any(Function),
      removeDelistedAdminInstall: expect.any(Function),
    });
    expect(admissionSpy).toHaveBeenCalledOnce();
  });

  it("a fresh call after the in-flight settles starts a new run", async () => {
    const ensureResult = { installed: [], failed: [] };
    const ensureManagedInstalled = vi.fn(async () => ensureResult);
    const pluginMarketplace = { ensureManagedInstalled } as unknown as PluginMarketplaceService;
    const input = {
      pluginMarketplace,
      ensurePluginStateReadyForInstall: vi.fn(async () => undefined),
      mainWindow: null,
      mode: "repair-missing-only" as const,
      activatePreparedArtifact: vi.fn(),
      marketplace: {
        backend: "real-cloud" as const,
        cloudBaseUrl: "https://marketplace.example.com",
      },
    };

    await runManagedBootstrap(input);
    await runManagedBootstrap(input);
    expect(ensureManagedInstalled).toHaveBeenCalledTimes(2);
  });

  it("boots the incumbent after managed sync failure without running a mutation seam", async () => {
    const events: string[] = [];
    const mutation = vi.fn();
    const phase = new PluginRuntimePreStartPhase();
    const pluginMarketplace = {
      ensureManagedInstalled: vi.fn(async () => {
        events.push("sync:failed");
        throw new Error("catalog unavailable");
      }),
    } as unknown as PluginMarketplaceService;

    const sync = runManagedBootstrap({
      pluginMarketplace,
      ensurePluginStateReadyForInstall: vi.fn(async () => {
        mutation();
      }),
      mainWindow: null,
      marketplace: {
        backend: "real-cloud",
        cloudBaseUrl: "https://marketplace.example.com",
      },
      mode: "pre-start-sync",
      admitPreStartOperation: (operation) => phase.admit(operation),
      removeDelistedAdminInstall: async (
        _removal: { pluginId: string; secretKeys: readonly string[] },
        commitRegistryRemoval: () => Promise<void>,
      ) => { await commitRegistryRemoval(); },
    });
    const start = phase.start(async () => {
      events.push("incumbent:start");
    });

    await Promise.all([sync, start]);
    expect(events).toEqual(["sync:failed", "incumbent:start"]);
    expect(mutation).not.toHaveBeenCalled();
  });
});
