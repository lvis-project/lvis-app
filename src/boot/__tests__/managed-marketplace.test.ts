import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetBootstrapInFlightForTest,
  resolveManagedPluginBootstrap,
  runManagedBootstrap,
} from "../managed-marketplace.js";
import type { PluginMarketplaceService } from "../../plugins/marketplace.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import { withPluginInstallLock } from "../../plugins/install-lifecycle.js";

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
    const restartAll = vi.fn(async () => undefined);
    const pluginMarketplace = { ensureManagedInstalled } as unknown as PluginMarketplaceService;
    const cancelAllPendingRestarts = vi.fn();
    const pluginRuntime = {
      restartAll,
      cancelAllPendingRestarts,
    } as unknown as PluginRuntime;

    const input = {
      pluginMarketplace,
      pluginRuntime,
      mainWindow: null,
      marketplace: {
        backend: "real-cloud" as const,
        cloudBaseUrl: "https://marketplace.example.com",
      },
    };

    // Three concurrent callers — the first kicks off ensureManagedInstalled,
    // the next two await the same in-flight promise instead of starting
    // fresh runs that would race on the registry write + restartAll.
    const promises = [
      runManagedBootstrap(input),
      runManagedBootstrap(input),
      runManagedBootstrap(input),
    ];
    expect(ensureManagedInstalled).toHaveBeenCalledTimes(1);

    releaseEnsure();
    await Promise.all(promises);

    expect(ensureManagedInstalled).toHaveBeenCalledTimes(1);
    expect(restartAll).toHaveBeenCalledTimes(1);
    expect(cancelAllPendingRestarts).toHaveBeenCalledTimes(1);
    expect(cancelAllPendingRestarts.mock.invocationCallOrder[0])
      .toBeLessThan(ensureManagedInstalled.mock.invocationCallOrder[0]);
  });

  it("triggers a single restartAll when a managed plugin was auto-updated (nothing freshly installed)", async () => {
    const ensureResult = { installed: [], updated: ["meeting"], failed: [] };
    const ensureManagedInstalled = vi.fn(async () => ensureResult);
    const restartAll = vi.fn(async () => undefined);
    const pluginMarketplace = { ensureManagedInstalled } as unknown as PluginMarketplaceService;
    const pluginRuntime = {
      restartAll,
      cancelAllPendingRestarts: vi.fn(),
    } as unknown as PluginRuntime;

    await runManagedBootstrap({
      pluginMarketplace,
      pluginRuntime,
      mainWindow: null,
      marketplace: {
        backend: "real-cloud" as const,
        cloudBaseUrl: "https://marketplace.example.com",
      },
    });

    // The auto-updated plugin must be reloaded even though `installed` is empty.
    expect(restartAll).toHaveBeenCalledTimes(1);
  });

  it("a fresh call after the in-flight settles starts a new run", async () => {
    const ensureResult = { installed: [], failed: [] };
    const ensureManagedInstalled = vi.fn(async () => ensureResult);
    const pluginMarketplace = { ensureManagedInstalled } as unknown as PluginMarketplaceService;
    const pluginRuntime = {
      restartAll: vi.fn(),
      cancelAllPendingRestarts: vi.fn(),
    } as unknown as PluginRuntime;

    const input = {
      pluginMarketplace,
      pluginRuntime,
      mainWindow: null,
      marketplace: {
        backend: "real-cloud" as const,
        cloudBaseUrl: "https://marketplace.example.com",
      },
    };

    await runManagedBootstrap(input);
    await runManagedBootstrap(input);
    expect(ensureManagedInstalled).toHaveBeenCalledTimes(2);
  });

  it("cancels pending per-plugin work before the managed all-plugin lock queues", async () => {
    let releaseRestart!: () => void;
    let restartEntered!: () => void;
    const restartGate = new Promise<void>((resolve) => { releaseRestart = resolve; });
    const restartStarted = new Promise<void>((resolve) => { restartEntered = resolve; });
    const restart = withPluginInstallLock("managed-plugin", async () => {
      restartEntered();
      await restartGate;
    });
    await restartStarted;

    const ensureManagedInstalled = vi.fn(async () => ({
      installed: [],
      updated: [],
      failed: [],
    }));
    const pluginRuntime = {
      cancelAllPendingRestarts: vi.fn(() => releaseRestart()),
      restartAll: vi.fn(),
    } as unknown as PluginRuntime;

    await expect(runManagedBootstrap({
      pluginMarketplace: { ensureManagedInstalled } as unknown as PluginMarketplaceService,
      pluginRuntime,
      mainWindow: null,
      marketplace: {
        backend: "real-cloud",
        cloudBaseUrl: "https://marketplace.example.com",
      },
    })).resolves.toBeUndefined();
    await restart;
    expect(ensureManagedInstalled).toHaveBeenCalledTimes(1);
  });
});
