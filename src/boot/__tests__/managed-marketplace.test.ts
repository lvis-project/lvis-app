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
    })).toEqual({
      enabled: false,
      reason: "managed plugin bootstrap disabled in isolated E2E test mode",
    });
  });

  it("disables bootstrap when no base URL is configured", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "real-cloud" },
    })).toEqual({
      enabled: false,
      reason: "marketplace backend has no configured base URL",
    });
  });

  it("enables bootstrap when a base URL is configured", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "real-cloud", cloudBaseUrl: "https://marketplace.lvis.internal" },
    })).toEqual({ enabled: true });
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
      marketplace: {
        backend: "real-cloud" as const,
        cloudBaseUrl: "https://marketplace.example.com",
      },
    });

    expect(ensureManagedInstalled).toHaveBeenCalledWith({
      mode: "pre-start-sync",
      ensurePluginStateReadyForInstall: expect.any(Function),
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
    });
    const start = phase.start(async () => {
      events.push("incumbent:start");
    });

    await Promise.all([sync, start]);
    expect(events).toEqual(["sync:failed", "incumbent:start"]);
    expect(mutation).not.toHaveBeenCalled();
  });
});
