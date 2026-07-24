import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetBootstrapInFlightForTest,
  resolveManagedPluginBootstrap,
  runManagedBootstrap,
} from "../managed-marketplace.js";
import type { PluginMarketplaceService } from "../../plugins/marketplace.js";
import type { PluginRuntime } from "../../plugins/runtime.js";

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
    const activatePreparedArtifact = vi.fn();
    const pluginRuntime = {
      activatePreparedArtifact,
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
      activatePreparedArtifact: expect.any(Function),
    });
  });

  it("passes the atomic activation seam when a managed plugin is auto-updated", async () => {
    const ensureResult = { installed: [], updated: ["meeting"], failed: [] };
    const ensureManagedInstalled = vi.fn(async () => ensureResult);
    const pluginMarketplace = { ensureManagedInstalled } as unknown as PluginMarketplaceService;
    const activatePreparedArtifact = vi.fn();
    const pluginRuntime = {
      activatePreparedArtifact,
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

    expect(ensureManagedInstalled).toHaveBeenCalledWith({
      activatePreparedArtifact: expect.any(Function),
    });
    expect(activatePreparedArtifact).not.toHaveBeenCalled();
  });

  it("a fresh call after the in-flight settles starts a new run", async () => {
    const ensureResult = { installed: [], failed: [] };
    const ensureManagedInstalled = vi.fn(async () => ensureResult);
    const pluginMarketplace = { ensureManagedInstalled } as unknown as PluginMarketplaceService;
    const pluginRuntime = {
      activatePreparedArtifact: vi.fn(),
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
});
