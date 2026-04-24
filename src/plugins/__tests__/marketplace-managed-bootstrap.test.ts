import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginMarketplaceService } from "../marketplace.js";

describe("PluginMarketplaceService managed bootstrap", () => {
  let testDir: string;
  let pluginsDir: string;
  let registryPath: string;
  let marketplacePath: string;

  beforeEach(async () => {
    testDir = join(
      homedir(),
      ".lvis",
      "test-tmp",
      `lvis-managed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    pluginsDir = join(testDir, "plugins");
    registryPath = join(pluginsDir, "registry.json");
    marketplacePath = join(pluginsDir, "marketplace.json");
    await mkdir(pluginsDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
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
            deployment: "managed",
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

    const service = new PluginMarketplaceService(testDir);
    const installSpy = vi
      .spyOn(service, "install")
      .mockResolvedValue({ pluginId: "meeting", installed: true });

    const result = await service.ensureManagedInstalled();

    expect(installSpy).toHaveBeenCalledWith("meeting", "it-admin");
    expect(result.installed).toEqual(["meeting"]);
    expect(result.failed).toEqual([]);
  });

  it("installs bundled companion plugins before the bundled root plugin", async () => {
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
            deployment: "managed",
          },
          {
            id: "email",
            name: "Email",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-email",
            packageName: "@lvis/plugin-email",
            tools: [],
            deployment: "managed",
          },
          {
            id: "meeting",
            name: "Meeting",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-meeting",
            packageName: "@lvis/plugin-meeting",
            tools: [],
            deployment: "managed",
          },
          {
            id: "work-proactive",
            name: "Work Proactive",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-work-proactive",
            packageName: "@lvis/plugin-work-proactive",
            tools: [],
            deployment: "managed",
            deliveryMode: "bundled",
            bundleDependencies: ["calendar", "email", "meeting"],
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");

    const service = new PluginMarketplaceService(testDir);
    const installSpy = vi
      .spyOn(service as unknown as { installArtifact: (...args: unknown[]) => Promise<string> }, "installArtifact")
      .mockImplementation(async (plugin: unknown) => {
        const item = plugin as { id: string };
        return join(testDir, "installed", item.id, "plugin.json");
      });
    const cacheSpy = vi
      .spyOn(service as unknown as { cacheVersionFromManifest: (...args: unknown[]) => Promise<void> }, "cacheVersionFromManifest")
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

  it("lets a user install a bundled marketplace root plugin", async () => {
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
            deployment: "managed",
            capabilities: ["calendar-source"],
          },
          {
            id: "email",
            name: "Email",
            description: "fixture",
            packageSpec: "file:./plugin-src/email",
            packageName: "@lvis/plugin-email",
            tools: [],
            deployment: "managed",
          },
          {
            id: "meeting",
            name: "Meeting",
            description: "fixture",
            packageSpec: "file:./plugin-src/meeting",
            packageName: "@lvis/plugin-meeting",
            tools: [],
            deployment: "managed",
          },
          {
            id: "work-proactive",
            name: "Work Proactive",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-work-proactive",
            packageName: "@lvis/plugin-work-proactive",
            tools: [],
            deployment: "user",
            deliveryMode: "bundled",
            bundleDependencies: ["calendar", "email", "meeting"],
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");

    const service = new PluginMarketplaceService(testDir);
    vi
      .spyOn(service as unknown as { installArtifact: (...args: unknown[]) => Promise<string> }, "installArtifact")
      .mockResolvedValue(join(testDir, "installed", "work-proactive", "plugin.json"));
    vi
      .spyOn(service as unknown as { cacheVersionFromManifest: (...args: unknown[]) => Promise<void> }, "cacheVersionFromManifest")
      .mockResolvedValue();

    await expect(service.install("work-proactive", "user")).resolves.toEqual({
      pluginId: "work-proactive",
      installed: true,
    });
  });

  it("preserves rich manifest metadata when synthesizing an installed manifest", async () => {
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
            deployment: "managed",
            capabilities: ["calendar-source"],
          },
          {
            id: "email",
            name: "Email",
            description: "fixture",
            packageSpec: "file:./plugin-src/email",
            packageName: "@lvis/plugin-email",
            tools: [],
            deployment: "managed",
          },
          {
            id: "meeting",
            name: "Meeting",
            description: "fixture",
            packageSpec: "file:./plugin-src/meeting",
            packageName: "@lvis/plugin-meeting",
            tools: [],
            deployment: "managed",
          },
          {
            id: "work-proactive",
            name: "Work Proactive",
            description: "fixture",
            packageSpec: "file:./plugin-src/work-proactive",
            packageName: "@lvis/plugin-work-proactive",
            tools: ["work_proactive_generate_wakeup_briefing"],
            deployment: "managed",
            deliveryMode: "bundled",
            bundleDependencies: ["calendar", "email", "meeting"],
            capabilities: ["work-proactive-provider"],
            requires: { capabilities: ["calendar-source"] },
            routineTools: {
              wakeupBriefing: "work_proactive_generate_wakeup_briefing",
            },
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

    const service = new PluginMarketplaceService(testDir);
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
    const manifest = JSON.parse(await readFile(manifestPath!, "utf-8"));
    expect(manifest.deliveryMode).toBe("bundled");
    expect(manifest.bundleDependencies).toEqual(["calendar", "email", "meeting"]);
    expect(manifest.requires).toEqual({ capabilities: ["calendar-source"] });
    expect(manifest.capabilities).toEqual(["work-proactive-provider"]);
    expect(manifest.routineTools).toEqual({
      wakeupBriefing: "work_proactive_generate_wakeup_briefing",
    });
    expect(manifest.toolSchemas?.work_proactive_generate_wakeup_briefing?.description).toBe(
      "Generate wakeup briefing",
    );
  });

  it("rejects local file package specs that escape the isolated workspace root", async () => {
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "escape-test",
            name: "Escape",
            description: "fixture",
            packageSpec: `file:${homedir()}`,
            packageName: "@lvis/escape",
            tools: [],
            deployment: "user",
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );

    const service = new PluginMarketplaceService(testDir);
    await expect(service.install("escape-test")).rejects.toThrow(/escapes workspace root/i);
  });
});
