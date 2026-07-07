import { describe, expect, it, vi } from "vitest";

import { handlePluginCards } from "../plugins.js";
import type { IpcDeps } from "../../types.js";
import type { PluginCard } from "../../../plugins/runtime/index.js";

function makeCard(id: string): PluginCard {
  return {
    id,
    name: id,
    description: "loaded plugin",
    sampleTools: [],
    tools: [],
    capabilities: [],
    loadStatus: "loaded",
    active: true,
    runtimeLoaded: true,
  };
}

describe("handlePluginCards", () => {
  it("adds marketplace install failures as failed Doctor cards", () => {
    const deps = {
      toolRegistry: {},
      pluginRuntime: {
        listPluginCards: vi.fn(() => [makeCard("loaded-plugin")]),
      },
      pluginMarketplace: {
        getInstallFailureDiagnostics: vi.fn(() => [
          {
            id: "meeting",
            name: "Meeting",
            description: "Meeting plugin",
            error:
              'plugin "meeting" artifact manifest external-auth-consumer capability does not match the catalog-approved grant',
            installFailureKind: "catalog-grant-mismatch",
            isManaged: true,
            installPolicy: "admin",
            installAliases: ["lvis-plugin-meeting"],
            networkAccess: {
              allowedDomains: ["graph.microsoft.com"],
              reasoning: "OAuth calls.",
            },
            version: "2.0.0",
          },
        ]),
      },
    } as unknown as IpcDeps;

    const cards = handlePluginCards(deps);

    expect(cards).toEqual([
      expect.objectContaining({ id: "loaded-plugin", loadStatus: "loaded" }),
      expect.objectContaining({
        id: "meeting",
        name: "Meeting",
        isManaged: true,
        installPolicy: "admin",
        loadStatus: "failed",
        active: false,
        runtimeLoaded: false,
        installFailureKind: "catalog-grant-mismatch",
        installAliases: ["lvis-plugin-meeting"],
        networkAccess: {
          allowedDomains: ["graph.microsoft.com"],
          reasoning: "OAuth calls.",
        },
        description:
          'Marketplace install failed: plugin "meeting" artifact manifest external-auth-consumer capability does not match the catalog-approved grant',
      }),
    ]);
  });

  it("does not duplicate failures already represented by runtime cards", () => {
    const deps = {
      toolRegistry: {},
      pluginRuntime: {
        listPluginCards: vi.fn(() => [makeCard("meeting")]),
      },
      pluginMarketplace: {
        getInstallFailureDiagnostics: vi.fn(() => [
          {
            id: "meeting",
            name: "Meeting",
            description: "Meeting plugin",
            error: "install failed",
            isManaged: true,
            installPolicy: "admin",
            installAliases: [],
          },
        ]),
      },
    } as unknown as IpcDeps;

    expect(handlePluginCards(deps)).toHaveLength(1);
  });
});
