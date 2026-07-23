import { describe, expect, it, vi } from "vitest";

import {
  handlePluginBundleE2eSnapshot,
  handlePluginCards,
} from "../plugins.js";
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
        installFailureMessage:
          'plugin "meeting" artifact manifest external-auth-consumer capability does not match the catalog-approved grant',
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

describe("handlePluginBundleE2eSnapshot", () => {
  it("returns only the requested plugin generation, Skill body, and owned tools", async () => {
    const release = vi.fn();
    const generation = {
      pluginId: "ep-api",
      pluginVersion: "2.0.0",
      generationId: "runtime-g2",
      artifactGenerationId: "a".repeat(64),
      contributions: [],
      state: {},
    };
    const deps = {
      pluginBundleLifecycle: {
        acquire: vi.fn(async () => ({ generation, release })),
      },
      skillStore: {
        loadPluginGeneration: vi.fn(() => ({
          name: "plugin:ep-api:lifecycle",
          body: "fixture-version:2.0.0",
          pluginOwner: {
            pluginId: "ep-api",
            pluginVersion: "2.0.0",
            generationId: "runtime-g2",
            localId: "lifecycle",
            fingerprint: "b".repeat(64),
          },
        })),
      },
      toolRegistry: {
        listAll: vi.fn(() => [
          {
            name: "ep_api_read",
            source: "plugin",
            version: "2.0.0",
            pluginId: "ep-api",
            pluginGeneration: { pluginId: "ep-api", generationId: "runtime-g2" },
          },
          {
            name: "mcp_ep_api_bundle_echo",
            source: "mcp",
            version: "1.0.0",
            mcpServerId: "plugin_server_g2",
            pluginGeneration: { pluginId: "ep-api", generationId: "runtime-g2" },
          },
          {
            name: "other_read",
            source: "plugin",
            version: "1.0.0",
            pluginId: "other-plugin",
            pluginGeneration: { pluginId: "other-plugin", generationId: "runtime-g2" },
          },
          {
            name: "ep_api_old_read",
            source: "plugin",
            version: "1.0.0",
            pluginId: "ep-api",
            pluginGeneration: { pluginId: "ep-api", generationId: "runtime-g1" },
          },
        ]),
      },
      scriptHookManager: {
        hooksOfType: vi.fn(() => [
          {
            id: "plugin:ep-api:audit:matching",
            event: "pre",
            matcher: "ep_api_*",
            command: ["node", "matching.mjs"],
            source: "config",
            timeoutMs: 5_000,
            owner: {
              pluginId: "ep-api",
              pluginVersion: "2.0.0",
              activationId: "runtime-g2",
              generationId: "artifact-g2",
              localId: "audit",
              fingerprint: "c".repeat(64),
            },
          },
          {
            id: "plugin:ep-api:audit:not-matching",
            event: "pre",
            matcher: "other_*",
            command: ["node", "not-matching.mjs"],
            source: "config",
            timeoutMs: 5_000,
            owner: {
              pluginId: "ep-api",
              pluginVersion: "2.0.0",
              activationId: "runtime-g2",
              generationId: "artifact-g2",
              localId: "audit",
              fingerprint: "d".repeat(64),
            },
          },
          {
            id: "plugin:other-plugin:audit:matching",
            event: "pre",
            matcher: "ep_api_*",
            command: ["node", "other-plugin.mjs"],
            source: "config",
            timeoutMs: 5_000,
            owner: {
              pluginId: "other-plugin",
              pluginVersion: "1.0.0",
              activationId: "runtime-other",
              generationId: "artifact-other",
              localId: "audit",
              fingerprint: "e".repeat(64),
            },
          },
        ]),
      },
    } as unknown as IpcDeps;

    await expect(
      handlePluginBundleE2eSnapshot(
        deps,
        "ep-api",
        "lifecycle",
        "ep_api_read",
      ),
    ).resolves.toEqual({
      ok: true,
      pluginId: "ep-api",
      active: {
        version: "2.0.0",
        generationId: "runtime-g2",
        artifactGenerationId: "a".repeat(64),
      },
      skill: {
        name: "plugin:ep-api:lifecycle",
        body: "fixture-version:2.0.0",
        owner: {
          pluginId: "ep-api",
          pluginVersion: "2.0.0",
          generationId: "runtime-g2",
          localId: "lifecycle",
          fingerprint: "b".repeat(64),
        },
      },
      tools: [
        {
          name: "ep_api_read",
          source: "plugin",
          version: "2.0.0",
          pluginId: "ep-api",
          generationId: "runtime-g2",
        },
        {
          name: "mcp_ep_api_bundle_echo",
          source: "mcp",
          version: "1.0.0",
          mcpServerId: "plugin_server_g2",
          generationId: "runtime-g2",
        },
      ],
      hooks: {
        probeToolName: "ep_api_read",
        registered: [
          {
            id: "plugin:ep-api:audit:matching",
            event: "pre",
            matcher: "ep_api_*",
            owner: {
              pluginId: "ep-api",
              pluginVersion: "2.0.0",
              activationId: "runtime-g2",
              generationId: "artifact-g2",
              localId: "audit",
              fingerprint: "c".repeat(64),
            },
          },
          {
            id: "plugin:ep-api:audit:not-matching",
            event: "pre",
            matcher: "other_*",
            owner: {
              pluginId: "ep-api",
              pluginVersion: "2.0.0",
              activationId: "runtime-g2",
              generationId: "artifact-g2",
              localId: "audit",
              fingerprint: "d".repeat(64),
            },
          },
        ],
        matchingPreToolUse: ["plugin:ep-api:audit:matching"],
      },
    });
    expect(deps.skillStore.loadPluginGeneration).toHaveBeenCalledWith(
      generation,
      "plugin:ep-api:lifecycle",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("holds one generation lease while a transition publishes another generation", async () => {
    const release = vi.fn();
    const leasedGeneration = {
      pluginId: "ep-api",
      pluginVersion: "1.0.0",
      generationId: "runtime-g1",
      artifactGenerationId: "a".repeat(64),
      contributions: [],
      state: {},
    };
    const deps = {
      pluginBundleLifecycle: {
        acquire: vi.fn(async () => ({
          generation: leasedGeneration,
          release,
        })),
      },
      skillStore: {
        loadPluginGeneration: vi.fn(() => ({
          name: "plugin:ep-api:lifecycle",
          body: "fixture-version:1.0.0",
          pluginOwner: {
            pluginId: "ep-api",
            pluginVersion: "1.0.0",
            generationId: "runtime-g1",
            localId: "lifecycle",
            fingerprint: "b".repeat(64),
          },
        })),
      },
      toolRegistry: {
        listAll: vi.fn(() => [
          {
            name: "ep_api_read_g1",
            source: "plugin",
            version: "1.0.0",
            pluginId: "ep-api",
            pluginGeneration: { pluginId: "ep-api", generationId: "runtime-g1" },
          },
          {
            name: "ep_api_read_g2",
            source: "plugin",
            version: "2.0.0",
            pluginId: "ep-api",
            pluginGeneration: { pluginId: "ep-api", generationId: "runtime-g2" },
          },
        ]),
      },
      scriptHookManager: {
        hooksOfType: vi.fn(() => []),
      },
    } as unknown as IpcDeps;

    const snapshot = await handlePluginBundleE2eSnapshot(
      deps,
      "ep-api",
      "lifecycle",
      "ep_api_read",
    );

    expect(snapshot).toMatchObject({
      ok: true,
      active: { generationId: "runtime-g1" },
      skill: { owner: { generationId: "runtime-g1" } },
      tools: [{ name: "ep_api_read_g1", generationId: "runtime-g1" }],
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports orphaned Hook registry and matcher state without an active generation", async () => {
    const deps = {
      pluginBundleLifecycle: {
        acquire: vi.fn(async () => {
          throw new Error("plugin 'ep-api' has no active generation");
        }),
      },
      skillStore: { loadPluginGeneration: vi.fn() },
      toolRegistry: { listAll: vi.fn() },
      scriptHookManager: {
        hooksOfType: vi.fn(() => [{
          id: "plugin:ep-api:audit:orphan",
          event: "pre",
          matcher: "ep_api_*",
          command: ["node", "orphan.mjs"],
          source: "config",
          timeoutMs: 5_000,
          owner: {
            pluginId: "ep-api",
            pluginVersion: "1.0.0",
            activationId: "retired-runtime",
            generationId: "retired-artifact",
            localId: "audit",
            fingerprint: "f".repeat(64),
          },
        }]),
      },
    } as unknown as IpcDeps;

    await expect(handlePluginBundleE2eSnapshot(
      deps,
      "ep-api",
      "lifecycle",
      "ep_api_read",
    )).resolves.toMatchObject({
      ok: true,
      active: null,
      skill: null,
      tools: [],
      hooks: {
        registered: [{ id: "plugin:ep-api:audit:orphan" }],
        matchingPreToolUse: ["plugin:ep-api:audit:orphan"],
      },
    });
    expect(deps.skillStore!.loadPluginGeneration).not.toHaveBeenCalled();
    expect(deps.toolRegistry.listAll).not.toHaveBeenCalled();
  });

  it("rejects traversal-shaped plugin ids before reading Host state", async () => {
    const deps = {
      pluginBundleLifecycle: { acquire: vi.fn() },
      skillStore: { loadPluginGeneration: vi.fn() },
      toolRegistry: { listAll: vi.fn() },
      scriptHookManager: { hooksOfType: vi.fn() },
    } as unknown as IpcDeps;

    await expect(
      handlePluginBundleE2eSnapshot(
        deps,
        "../ep-api",
        "lifecycle",
        "ep_api_read",
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-plugin-id" });
    expect(deps.pluginBundleLifecycle!.acquire).not.toHaveBeenCalled();
    expect(deps.skillStore!.loadPluginGeneration).not.toHaveBeenCalled();
    expect(deps.toolRegistry.listAll).not.toHaveBeenCalled();
    expect(deps.scriptHookManager!.hooksOfType).not.toHaveBeenCalled();
  });

  it("rejects invalid Hook probe tool names before reading Host state", async () => {
    const deps = {
      pluginBundleLifecycle: { acquire: vi.fn() },
      skillStore: { loadPluginGeneration: vi.fn() },
      toolRegistry: { listAll: vi.fn() },
      scriptHookManager: { hooksOfType: vi.fn() },
    } as unknown as IpcDeps;

    await expect(
      handlePluginBundleE2eSnapshot(
        deps,
        "ep-api",
        "lifecycle",
        "ep-api.read",
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-hook-probe-tool-name" });
    expect(deps.pluginBundleLifecycle!.acquire).not.toHaveBeenCalled();
    expect(deps.scriptHookManager!.hooksOfType).not.toHaveBeenCalled();
  });
});
