import { describe, expect, it } from "vitest";
import { resolveManagedPluginBootstrap } from "../managed-marketplace.js";

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

  it("requires a base URL for real-cloud bootstrap", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "real-cloud" },
      isPackaged: true,
    })).toEqual({
      enabled: false,
      reason: "real-cloud backend has no configured base URL",
    });
  });

  it("allows real-cloud bootstrap when a base URL is configured", () => {
    expect(resolveManagedPluginBootstrap({
      marketplace: { backend: "real-cloud", realCloudBaseUrl: "https://marketplace.lvis.internal" },
      isPackaged: true,
    })).toEqual({ enabled: true });
  });
});
