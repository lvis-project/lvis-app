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
  createRefreshActiveLlmWildcard: vi.fn(() => ({
    refresh: state.refreshActiveLlmWildcard,
  })),
}));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

import { setupMarketplace } from "../marketplace-setup.js";

function makeContext(): BootContext {
  return {
    settingsService: {
      get: vi.fn((key: string) => {
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
    pluginRuntime: {},
  } as unknown as BootContext;
}

describe("setupMarketplace app-version resolver wiring", () => {
  beforeEach(() => {
    state.fetcherConfigs.length = 0;
    state.getLvisAppVersion.mockClear();
    state.refreshActiveLlmWildcard.mockClear();
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
  });
});
