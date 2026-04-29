import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "../marketplace.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";

function makeManagedService(testDir: string, marketplacePath: string): PluginMarketplaceService {
  const paths = makeTestPluginPaths({ rootDir: testDir });
  const fetcher = new MockMarketplaceFetcher(marketplacePath);
  return new PluginMarketplaceService(paths, fetcher);
}

describe("PluginMarketplaceService managed bootstrap", () => {
  let testDir: string;
  let pluginsDir: string;
  let registryPath: string;
  let marketplacePath: string;

  beforeEach(async () => {
    setIsPackaged(false);
    // Phase 2b-1: file:-spec catalog entries route through the dev branch.
    // Round-3: LVIS_DEV=1 subsumes the deprecated LVIS_ALLOW_LINKED_PLUGIN_ENTRY.
    process.env.LVIS_DEV = "1";
    testDir = join(
      tmpdir(),
      `lvis-managed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // Phase 2a: registry.json lives under pluginsRoot (= testDir/plugins
    // when the helper picks defaults). marketplace.json is the dev mock
    // catalog and lives outside that tree so writes never collide with the
    // installed-plugin registry.
    pluginsDir = join(testDir, "plugins");
    registryPath = join(pluginsDir, "registry.json");
    marketplacePath = join(testDir, "marketplace.json");
    await mkdir(pluginsDir, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.LVIS_DEV;
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
    _resetForTest();
  });

  it("reinstalls managed plugins when registry entry is stale", async () => {
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "meeting",
            name: "Meeting",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-meeting",
            packageName: "@lvis/plugin-meeting",
            tools: [],
            installPolicy: "admin",
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "meeting",
            manifestPath: join(testDir, "missing", "plugin.json"),
            enabled: true,
          },
        ],
      }),
      "utf-8",
    );

    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = vi
      .spyOn(service, "install")
      .mockResolvedValue({ pluginId: "meeting", installed: true });

    const result = await service.ensureManagedInstalled();

    expect(installSpy).toHaveBeenCalledWith("meeting", "it-admin");
    expect(result.installed).toEqual(["meeting"]);
    expect(result.failed).toEqual([]);
  });

  it("installs bundle companion plugins before the bundle root plugin", async () => {
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "calendar",
            name: "Calendar",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-calendar",
            packageName: "@lvis/plugin-calendar",
            tools: [],
            installPolicy: "admin",
          },
          {
            id: "email",
            name: "Email",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-email",
            packageName: "@lvis/plugin-email",
            tools: [],
            installPolicy: "admin",
          },
          {
            id: "meeting",
            name: "Meeting",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-meeting",
            packageName: "@lvis/plugin-meeting",
            tools: [],
            installPolicy: "admin",
          },
          {
            id: "work-proactive",
            name: "Work Proactive",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-work-proactive",
            packageName: "@lvis/plugin-work-proactive",
            tools: [],
            installPolicy: "user",
            dependencies: ["calendar", "email", "meeting"],
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");

    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = vi
      .spyOn(service as unknown as { installArtifact: (...args: unknown[]) => Promise<string> }, "installArtifact")
      .mockImplementation(async (plugin: unknown) => {
        const item = plugin as { id: string };
        return join(testDir, "installed", item.id, "plugin.json");
      });
    const cacheSpy = vi
      .spyOn((service as unknown as { artifactStore: { cacheVersionFromManifest: (...args: unknown[]) => Promise<void> } }).artifactStore, "cacheVersionFromManifest")
      .mockResolvedValue();

    const result = await service.install("work-proactive", "it-admin");

    expect(result).toEqual({ pluginId: "work-proactive", installed: true });
    expect(installSpy.mock.calls.map(([plugin]) => (plugin as { id: string }).id)).toEqual([
      "calendar",
      "email",
      "meeting",
      "work-proactive",
    ]);
    expect(cacheSpy).toHaveBeenCalledTimes(4);
  });

  it("satisfies dependency root capability requirements via auto-installed dependencies", async () => {
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "calendar",
            name: "Calendar",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-calendar",
            packageName: "@lvis/plugin-calendar",
            tools: [],
            installPolicy: "admin",
            capabilities: ["calendar-source"],
          },
          {
            id: "work-proactive",
            name: "Work Proactive",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-work-proactive",
            packageName: "@lvis/plugin-work-proactive",
            tools: [],
            installPolicy: "user",
            dependencies: ["calendar"],
            requires: { capabilities: ["calendar-source"] },
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");

    const service = makeManagedService(testDir, marketplacePath);
    vi
      .spyOn(service as unknown as { installArtifact: (...args: unknown[]) => Promise<string> }, "installArtifact")
      .mockImplementation(async (plugin: unknown) => {
        const item = plugin as { id: string };
        const manifestPath = join(testDir, "plugins", "installed", item.id, "plugin.json");
        await mkdir(join(testDir, "plugins", "installed", item.id), { recursive: true });
        await writeFile(
          manifestPath,
          JSON.stringify({
            id: item.id,
            name: item.id,
            version: "1.0.0",
            entry: "dist/index.js",
            tools: [],
            capabilities: item.id === "calendar" ? ["calendar-source"] : [],
          }),
          "utf-8",
        );
        return manifestPath;
      });
    vi
      .spyOn((service as unknown as { artifactStore: { cacheVersionFromManifest: (...args: unknown[]) => Promise<void> } }).artifactStore, "cacheVersionFromManifest")
      .mockResolvedValue();
    await expect(service.install("work-proactive", "it-admin")).resolves.toEqual({
      pluginId: "work-proactive",
      installed: true,
    });
  });

  it("lets a user install a bundle marketplace root plugin", async () => {
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "calendar",
            name: "Calendar",
            description: "fixture",
            packageSpec: "file:./plugin-src/calendar",
            packageName: "@lvis/plugin-calendar",
            tools: [],
            installPolicy: "user",
            capabilities: ["calendar-source"],
          },
          {
            id: "email",
            name: "Email",
            description: "fixture",
            packageSpec: "file:./plugin-src/email",
            packageName: "@lvis/plugin-email",
            tools: [],
            installPolicy: "user",
          },
          {
            id: "meeting",
            name: "Meeting",
            description: "fixture",
            packageSpec: "file:./plugin-src/meeting",
            packageName: "@lvis/plugin-meeting",
            tools: [],
            installPolicy: "user",
          },
          {
            id: "work-proactive",
            name: "Work Proactive",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-work-proactive",
            packageName: "@lvis/plugin-work-proactive",
            tools: [],
            installPolicy: "user",
            dependencies: ["calendar", "email", "meeting"],
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");

    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = vi
      .spyOn(service as unknown as { installArtifact: (...args: unknown[]) => Promise<string> }, "installArtifact")
      .mockImplementation(async (plugin: unknown) => {
        const item = plugin as { id: string };
        return join(testDir, "installed", item.id, "plugin.json");
      });
    vi
      .spyOn((service as unknown as { artifactStore: { cacheVersionFromManifest: (...args: unknown[]) => Promise<void> } }).artifactStore, "cacheVersionFromManifest")
      .mockResolvedValue();

    await expect(service.install("work-proactive", "user")).resolves.toEqual({
      pluginId: "work-proactive",
      installed: true,
    });
    expect(installSpy.mock.calls.map(([plugin]) => (plugin as { id: string }).id)).toEqual([
      "calendar",
      "email",
      "meeting",
      "work-proactive",
    ]);
  });

  // Removed in Phase 2-final: the synthesized-manifest code path was the
  // file:-spec / npm-install branch's `writeInstalledManifest`, which is
  // gone. The signed-zip path uses the plugin.json the publisher shipped
  // in the artifact verbatim — there is nothing to "synthesize" anymore.
  // Test kept as a `it.skip` placeholder so future readers know why.
  it.skip("preserves rich manifest metadata when synthesizing an installed manifest", async () => {
    await mkdir(join(testDir, "plugin-src", "calendar"), { recursive: true });
    await mkdir(join(testDir, "plugin-src", "email"), { recursive: true });
    await mkdir(join(testDir, "plugin-src", "meeting"), { recursive: true });
    await mkdir(join(testDir, "plugin-src", "work-proactive"), { recursive: true });
    const providerDir = join(testDir, "plugins", "installed", "calendar");
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      join(providerDir, "plugin.json"),
      JSON.stringify({
        id: "calendar",
        name: "Calendar",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
        capabilities: ["calendar-source"],
      }),
      "utf-8",
    );
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "calendar",
            name: "Calendar",
            description: "fixture",
            packageSpec: "file:./plugin-src/calendar",
            packageName: "@lvis/plugin-calendar",
            tools: [],
            installPolicy: "user",
            capabilities: ["calendar-source"],
          },
          {
            id: "email",
            name: "Email",
            description: "fixture",
            packageSpec: "file:./plugin-src/email",
            packageName: "@lvis/plugin-email",
            tools: [],
            installPolicy: "user",
          },
          {
            id: "meeting",
            name: "Meeting",
            description: "fixture",
            packageSpec: "file:./plugin-src/meeting",
            packageName: "@lvis/plugin-meeting",
            tools: [],
            installPolicy: "user",
          },
          {
            id: "work-proactive",
            name: "Work Proactive",
            description: "fixture",
            packageSpec: "file:./plugin-src/work-proactive",
            packageName: "@lvis/plugin-work-proactive",
            tools: ["work_proactive_generate_wakeup_briefing"],
            installPolicy: "user",
            dependencies: [
              { pluginId: "calendar", required: true },
              { pluginId: "email", required: true },
              { pluginId: "meeting", required: true },
            ],
            pluginAccess: {
              plugins: [
                { pluginId: "calendar", tools: ["calendar_today"] },
                { pluginId: "email", events: ["email.action.needed"] },
                { pluginId: "meeting", events: ["meeting.summary.created", "meeting.ended"] },
              ],
            },
            capabilities: ["work-proactive-provider"],
            requires: { capabilities: ["calendar-source"] },
            toolSchemas: {
              work_proactive_generate_wakeup_briefing: {
                description: "Generate wakeup briefing",
                inputSchema: {
                  type: "object",
                  properties: {},
                },
              },
            },
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "calendar", manifestPath: "installed/calendar/plugin.json", enabled: true }],
      }),
      "utf-8",
    );

    const service = makeManagedService(testDir, marketplacePath);
    vi
      .spyOn(service as unknown as { runNpmInstall: (spec: string) => Promise<void> }, "runNpmInstall")
      .mockResolvedValue();

    await expect(service.install("work-proactive", "it-admin")).resolves.toEqual({
      pluginId: "work-proactive",
      installed: true,
    });

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; manifestPath: string }>;
    };
    const manifestPath = registry.plugins.find((entry) => entry.id === "work-proactive")?.manifestPath;
    expect(manifestPath).toBeTruthy();
    // Phase 2a: registry entries hold manifest paths relative to
    // dirname(registryPath). Resolve to absolute before reading the file.
    const absoluteManifestPath = resolve(dirname(registryPath), manifestPath!);
    const manifest = JSON.parse(await readFile(absoluteManifestPath, "utf-8"));
    expect(manifest.installPolicy).toBe("user");
    expect(manifest.dependencies).toEqual([
      { pluginId: "calendar", required: true },
      { pluginId: "email", required: true },
      { pluginId: "meeting", required: true },
    ]);
    expect(manifest.pluginAccess).toEqual({
      plugins: [
        { pluginId: "calendar", tools: ["calendar_today"] },
        { pluginId: "email", events: ["email.action.needed"] },
        { pluginId: "meeting", events: ["meeting.summary.created", "meeting.ended"] },
      ],
    });
    expect(manifest.requires).toEqual({ capabilities: ["calendar-source"] });
    expect(manifest.capabilities).toEqual(["work-proactive-provider"]);
    expect(manifest.toolSchemas?.work_proactive_generate_wakeup_briefing?.description).toBe(
      "Generate wakeup briefing",
    );
  });

  // Removed in Phase 2-final: the file:-spec / npm-install branch and its
  // workspace-root containment check are gone. Production has a single
  // install path (signed-zip download), so there is no file:-spec to escape.

  it("rejects marketplace artifacts whose pluginAccess exceeds the catalog-approved grant", async () => {
    const pluginDir = join(testDir, "plugins", "installed", "user-plugin");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "user-plugin",
        name: "User Plugin",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
        pluginAccess: {
          plugins: [{ pluginId: "email", events: ["email.analyzed"] }],
        },
      }),
      "utf-8",
    );

    const service = makeManagedService(testDir, marketplacePath);
    await expect(
      (service as unknown as {
        assertInstalledManifestMatchesCatalog: (
          plugin: {
            id: string;
            installPolicy: "user";
            pluginAccess?: unknown;
          },
          version: string,
          manifestFile: string,
          pluginDir: string,
        ) => Promise<void>;
      }).assertInstalledManifestMatchesCatalog(
        {
          id: "user-plugin",
          installPolicy: "user",
          pluginAccess: undefined,
        },
        "1.0.0",
        manifestPath,
        pluginDir,
      ),
    ).rejects.toThrow(/pluginAccess does not match the catalog-approved grant/i);
  });

  it("restores registry state during dependency rollback cleanup", async () => {
    const calendarDir = join(testDir, "plugins", "installed", "calendar");
    const emailDir = join(testDir, "plugins", "installed", "email");
    await mkdir(calendarDir, { recursive: true });
    await mkdir(emailDir, { recursive: true });
    await writeFile(
      join(calendarDir, "plugin.json"),
      JSON.stringify({
        id: "calendar",
        name: "Calendar",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
      }),
      "utf-8",
    );
    await writeFile(
      join(emailDir, "plugin.json"),
      JSON.stringify({
        id: "email",
        name: "Email",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "calendar",
            manifestPath: "installed/calendar/plugin.json",
            enabled: false,
            installedBy: "user",
          },
          {
            id: "email",
            manifestPath: "installed/email/plugin.json",
            enabled: true,
            installedBy: "user",
            bundleRefs: ["work-proactive"],
          },
        ],
      }),
      "utf-8",
    );

    const service = makeManagedService(testDir, marketplacePath);
    await (
      service as unknown as {
        rollbackInstallOperation: (state: {
          installedPluginIds: string[];
          touchedEntries: Map<string, { enabled?: boolean; bundleRefs?: string[]; installedBy?: "admin" | "user" }>;
        }) => Promise<void>;
      }
    ).rollbackInstallOperation({
      installedPluginIds: ["email"],
      touchedEntries: new Map([
        [
          "calendar",
          {
            enabled: false,
            bundleRefs: undefined,
            installedBy: "user",
          },
        ],
      ]),
    });

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; enabled?: boolean; bundleRefs?: string[] }>;
    };
    expect(registry.plugins).toEqual([
      {
        id: "calendar",
        manifestPath: "installed/calendar/plugin.json",
        enabled: false,
        installedBy: "user",
      },
    ]);
  });

  it("removes bundle members only when explicitly requested and still unreferenced", async () => {
    for (const pluginId of ["work-proactive", "email", "meeting", "calendar"]) {
      const pluginDir = join(testDir, "plugins", "installed", pluginId);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "plugin.json"),
        JSON.stringify({
          id: pluginId,
          name: pluginId,
          version: "1.0.0",
          entry: "dist/index.js",
          tools: [],
        }),
        "utf-8",
      );
    }
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "work-proactive",
            manifestPath: "installed/work-proactive/plugin.json",
            enabled: true,
            installedBy: "user",
          },
          {
            id: "email",
            manifestPath: "installed/email/plugin.json",
            enabled: true,
            installedBy: "user",
            bundleRefs: ["work-proactive"],
          },
          {
            id: "meeting",
            manifestPath: "installed/meeting/plugin.json",
            enabled: true,
            installedBy: "user",
            bundleRefs: ["work-proactive", "other-bundle"],
          },
          {
            id: "calendar",
            manifestPath: "installed/calendar/plugin.json",
            enabled: true,
            installedBy: "admin",
            bundleRefs: ["work-proactive"],
          },
        ],
      }),
      "utf-8",
    );

    const service = makeManagedService(testDir, marketplacePath);
    await expect(service.uninstall("work-proactive", { removeBundleMembers: true })).resolves.toEqual({
      pluginId: "work-proactive",
      uninstalled: true,
    });

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; bundleRefs?: string[] }>;
    };
    expect(registry.plugins).toEqual([
      {
        id: "meeting",
        manifestPath: "installed/meeting/plugin.json",
        enabled: true,
        installedBy: "user",
        bundleRefs: ["other-bundle"],
      },
      {
        id: "calendar",
        manifestPath: "installed/calendar/plugin.json",
        enabled: true,
        installedBy: "admin",
        bundleRefs: [],
      },
    ]);
  });
});
