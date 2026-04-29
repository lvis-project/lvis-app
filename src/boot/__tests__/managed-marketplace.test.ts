import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetBootstrapInFlightForTest,
  resolveManagedPluginBootstrap,
  runManagedBootstrap,
} from "../managed-marketplace.js";
import type { PluginMarketplaceService } from "../../plugins/marketplace.js";
import type { PluginRuntime } from "../../plugins/runtime.js";

describe("resolveManagedPluginBootstrap", () => {
  it("allows mock backend bootstrap in dev", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "mock" },
      isPackaged: false,
    })).toEqual({ enabled: true });
  });

  it("skips mock backend bootstrap in packaged builds", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "mock" },
      isPackaged: true,
    })).toEqual({
      enabled: false,
      reason: "packaged apps skip managed bootstrap when using the mock marketplace backend",
    });
  });

  it("requires a base URL for marketplace-api bootstrap", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "marketplace-api" },
      isPackaged: true,
    })).toEqual({
      enabled: false,
      reason: "marketplace-api backend has no configured base URL",
    });
  });

  it("allows marketplace-api bootstrap when a base URL is configured", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "marketplace-api", marketplaceBaseUrl: "https://marketplace.lvis.internal" },
      isPackaged: true,
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
    const pluginRuntime = { restartAll } as unknown as PluginRuntime;

    const input = {
      pluginMarketplace,
      pluginRuntime,
      mainWindow: null,
      marketplace: {
        backend: "marketplace-api" as const,
        marketplaceBaseUrl: "https://marketplace.example.com",
      },
      isPackaged: false,
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
  });

  it("a fresh call after the in-flight settles starts a new run", async () => {
    const ensureResult = { installed: [], failed: [] };
    const ensureManagedInstalled = vi.fn(async () => ensureResult);
    const pluginMarketplace = { ensureManagedInstalled } as unknown as PluginMarketplaceService;
    const pluginRuntime = { restartAll: vi.fn() } as unknown as PluginRuntime;

    const input = {
      pluginMarketplace,
      pluginRuntime,
      mainWindow: null,
      marketplace: {
        backend: "marketplace-api" as const,
        marketplaceBaseUrl: "https://marketplace.example.com",
      },
      isPackaged: false,
    };

    await runManagedBootstrap(input);
    await runManagedBootstrap(input);
    expect(ensureManagedInstalled).toHaveBeenCalledTimes(2);
  });
});
