import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "../../context.js";

const state = vi.hoisted(() => {
  const canonicalAppVersion = "0.5.10";
  return {
    electronAppVersion: "0.0",
    canonicalAppVersion,
    fetcherConfigs: [] as Array<Record<string, unknown>>,
    getLvisAppVersion: vi.fn(() => canonicalAppVersion),
    refreshActiveLlmWildcard: vi.fn(),
    disposeRefreshActiveLlmWildcard: vi.fn(),
    refreshDeps: null as {
      getActiveVendor: () => string | undefined;
      cancelPendingRestarts: () => void;
    } | null,
  };
});

vi.mock("electron", () => ({
  app: {
    getVersion: vi.fn(() => state.electronAppVersion),
    getPath: vi.fn(() => "/tmp/lvis-marketplace-setup-test"),
  },
}));

vi.mock("../../../shared/app-version.js", () => ({
  getLvisAppVersion: state.getLvisAppVersion,
}));

vi.mock("../../../plugins/cloud-marketplace-fetcher.js", () => ({
  CloudMarketplaceFetcher: class {
    constructor(config: unknown) {
      state.fetcherConfigs.push(config as Record<string, unknown>);
    }

    updateAllowPrivateNetwork(): void {}
  },
}));

vi.mock("../../../plugins/marketplace.js", () => ({
  DisabledMarketplaceFetcher: class {},
  PluginMarketplaceService: class {},
}));

vi.mock("../refresh-active-llm-wildcard.js", () => ({
  activeHostApiVendor: (llm: { provider?: string; activeChatRuntime?: { kind?: string } }) =>
    llm.activeChatRuntime?.kind === "subscription" ? undefined : llm.provider,
  createRefreshActiveLlmWildcard: vi.fn((deps: unknown) => {
    state.refreshDeps = deps as {
      getActiveVendor: () => string | undefined;
      cancelPendingRestarts: () => void;
    };
    return {
      refresh: state.refreshActiveLlmWildcard,
      dispose: state.disposeRefreshActiveLlmWildcard,
    };
  }),
}));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

import { setupMarketplace } from "../marketplace-setup.js";

function makeContext(
  activeChatRuntime: { kind: "api" } | { kind: "subscription"; provider: "codex" } = { kind: "api" },
): BootContext {
  return {
    settingsService: {
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai", activeChatRuntime };
        if (key === "marketplace") {
          return {
            cloudBaseUrl: "https://marketplace.example.com",
            cloudAllowPrivateNetwork: false,
          };
        }
        return {};
      }),
      getSecret: vi.fn(() => undefined),
      getAll: vi.fn(() => ({})),
    },
    pluginPaths: {},
    deploymentGuard: {},
    bootAuditLogger: {},
    pluginRuntime: { cancelAllPendingRestarts: vi.fn() },
  } as unknown as BootContext;
}

describe("setupMarketplace app-version resolver wiring", () => {
  beforeEach(() => {
    state.fetcherConfigs.length = 0;
    state.getLvisAppVersion.mockClear();
    state.refreshActiveLlmWildcard.mockClear();
    state.disposeRefreshActiveLlmWildcard.mockClear();
    state.refreshDeps = null;
  });

  it("passes the canonical LVIS app version to CloudMarketplaceFetcher", async () => {
    const ctx = makeContext();

    await setupMarketplace(ctx);

    expect(state.fetcherConfigs).toEqual([
      expect.objectContaining({
        baseUrl: "https://marketplace.example.com",
        appVersion: state.canonicalAppVersion,
        allowPrivateNetwork: false,
      }),
    ]);
    expect(state.getLvisAppVersion).toHaveBeenCalledOnce();
    expect(state.refreshActiveLlmWildcard).toHaveBeenCalledOnce();
    expect(ctx.disposeRefreshActiveLlmWildcard).toBe(state.disposeRefreshActiveLlmWildcard);
  });
  it("omits stale API-provider metadata when a subscription runtime owns generation", async () => {
    const ctx = makeContext({ kind: "subscription", provider: "codex" });

    await setupMarketplace(ctx);

    expect(state.refreshDeps?.getActiveVendor()).toBeUndefined();
  });

  it("wires wildcard disposal to the runtime's in-flight restart cancellation", async () => {
    const ctx = makeContext();

    await setupMarketplace(ctx);

    state.refreshDeps!.cancelPendingRestarts();
    expect(ctx.pluginRuntime.cancelAllPendingRestarts).toHaveBeenCalledOnce();
  });
});
