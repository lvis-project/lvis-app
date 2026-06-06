import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
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
    // mkdtempSync (atomic, unpredictable suffix, mode 0700) — the secure temp
    // pattern; a `tmpdir()`+Date.now()/Math.random() path trips CodeQL
    // js/insecure-temporary-file.
    testDir = mkdtempSync(join(tmpdir(), "lvis-managed-"));
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
    // Redesign #964: ensureManagedInstalled drives `installWithDependencies`
    // directly with actor="it-admin" (catalog-derived escalation lives in
    // the public `install()`; the managed-bootstrap path already holds the
    // catalog item, so it bypasses the catalog re-fetch). Spy on the
    // internal method to assert the actor is still "it-admin".
    const installSpy = vi
      .spyOn(
        service as unknown as {
          installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
        },
        "installWithDependencies",
      )
      .mockResolvedValue({ pluginId: "meeting", installed: true });

    const result = await service.ensureManagedInstalled();

    expect(installSpy).toHaveBeenCalled();
    const [pluginId, actor, catalogSnapshot] = installSpy.mock.calls[0]!;
    expect(pluginId).toBe("meeting");
    expect(actor).toBe("it-admin");
    // #1098 — the managed path passes the catalog snapshot it already fetched
    // so the worker installs from one consistent snapshot (no re-fetch).
    expect(Array.isArray(catalogSnapshot)).toBe(true);
    expect((catalogSnapshot as Array<{ id: string }>).some((p) => p.id === "meeting")).toBe(true);
    expect(result.installed).toEqual(["meeting"]);
    expect(result.failed).toEqual([]);
  });

  it("reinstalls managed plugins when manifest exists but install receipt is missing", async () => {
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
    const pluginDir = join(pluginsDir, "meeting");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        id: "meeting",
        name: "Meeting",
        version: "1.0.0",
        entry: "dist/hostPlugin.js",
        tools: [],
        description: "fixture",
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
            manifestPath: "meeting/plugin.json",
            enabled: true,
            installSource: "admin",
          },
        ],
      }),
      "utf-8",
    );

    const service = makeManagedService(testDir, marketplacePath);
    // Redesign #964: spy on installWithDependencies (see note in the
    // first `reinstalls managed plugins …` case above).
    const installSpy = vi
      .spyOn(
        service as unknown as {
          installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
        },
        "installWithDependencies",
      )
      .mockResolvedValue({ pluginId: "meeting", installed: true });

    const result = await service.ensureManagedInstalled();

    expect(installSpy).toHaveBeenCalled();
    const [pluginId, actor, catalogSnapshot] = installSpy.mock.calls[0]!;
    expect(pluginId).toBe("meeting");
    expect(actor).toBe("it-admin");
    // #1098 — the managed path passes the catalog snapshot it already fetched
    // so the worker installs from one consistent snapshot (no re-fetch).
    expect(Array.isArray(catalogSnapshot)).toBe(true);
    expect((catalogSnapshot as Array<{ id: string }>).some((p) => p.id === "meeting")).toBe(true);
    expect(result.installed).toEqual(["meeting"]);
    expect(result.failed).toEqual([]);
  });

  async function writeAdminCatalog(version: string) {
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
            version,
          },
        ],
      }),
      "utf-8",
    );
  }

  function spyInstalledAtVersion(service: PluginMarketplaceService, installedVersion: string) {
    vi.spyOn(
      service as unknown as { resolveInstalledIds: (entries: unknown) => Promise<Set<string>> },
      "resolveInstalledIds",
    ).mockResolvedValue(new Set(["meeting"]));
    vi.spyOn(
      service as unknown as { getInstalledVersion: (id: string) => Promise<string | null> },
      "getInstalledVersion",
    ).mockResolvedValue(installedVersion);
    return vi
      .spyOn(
        service as unknown as {
          installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
        },
        "installWithDependencies",
      )
      .mockResolvedValue({ pluginId: "meeting", installed: true });
  }

  it("auto-updates an installed managed plugin when the catalog version is strictly newer", async () => {
    await writeAdminCatalog("2.0.0");
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = spyInstalledAtVersion(service, "1.0.0");

    const result = await service.ensureManagedInstalled();

    expect(installSpy).toHaveBeenCalledTimes(1);
    const [pluginId, actor] = installSpy.mock.calls[0]!;
    expect(pluginId).toBe("meeting");
    expect(actor).toBe("it-admin"); // update still runs under the managed trust anchor
    expect(result.updated).toEqual(["meeting"]);
    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("does NOT update a managed plugin already at the catalog version", async () => {
    await writeAdminCatalog("1.0.0");
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = spyInstalledAtVersion(service, "1.0.0");

    const result = await service.ensureManagedInstalled();

    expect(installSpy).not.toHaveBeenCalled();
    expect(result.updated).toEqual([]);
    expect(result.installed).toEqual([]);
  });

  it("does NOT downgrade a managed plugin when the installed version is newer than the catalog", async () => {
    await writeAdminCatalog("1.0.0");
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = spyInstalledAtVersion(service, "2.0.0");

    const result = await service.ensureManagedInstalled();

    expect(installSpy).not.toHaveBeenCalled();
    expect(result.updated).toEqual([]);
  });

  it("isolates a failed auto-update into result.failed without throwing", async () => {
    await writeAdminCatalog("2.0.0");
    const service = makeManagedService(testDir, marketplacePath);
    vi.spyOn(
      service as unknown as { resolveInstalledIds: (e: unknown) => Promise<Set<string>> },
      "resolveInstalledIds",
    ).mockResolvedValue(new Set(["meeting"]));
    vi.spyOn(
      service as unknown as { getInstalledVersion: (id: string) => Promise<string | null> },
      "getInstalledVersion",
    ).mockResolvedValue("1.0.0");
    vi.spyOn(
      service as unknown as { installWithDependencies: (...a: unknown[]) => Promise<unknown> },
      "installWithDependencies",
    ).mockRejectedValue(new Error("download failed"));

    const result = await service.ensureManagedInstalled();

    expect(result.failed).toEqual([{ id: "meeting", error: "download failed" }]);
    expect(result.updated).toEqual([]);
    expect(result.installed).toEqual([]);
  });

  it("a corrupt installed managed plugin's unreadable version does not abort install/update of others", async () => {
    // alpha installed but its manifest version cannot be read (getInstalledVersion
    // throws); beta is missing. The corrupt alpha must be skipped, NOT abort the
    // whole bootstrap — beta still installs (M1 per-plugin isolation).
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "alpha", name: "Alpha", description: "f", packageSpec: "file:../a", packageName: "@lvis/a", tools: [], installPolicy: "admin", version: "2.0.0" },
          { id: "beta", name: "Beta", description: "f", packageSpec: "file:../b", packageName: "@lvis/b", tools: [], installPolicy: "admin", version: "1.0.0" },
        ],
      }),
      "utf-8",
    );
    const service = makeManagedService(testDir, marketplacePath);
    vi.spyOn(
      service as unknown as { resolveInstalledIds: (e: unknown) => Promise<Set<string>> },
      "resolveInstalledIds",
    ).mockResolvedValue(new Set(["alpha"]));
    vi.spyOn(
      service as unknown as { getInstalledVersion: (id: string) => Promise<string | null> },
      "getInstalledVersion",
    ).mockRejectedValue(new Error("corrupt manifest"));
    const installSpy = vi
      .spyOn(
        service as unknown as { installWithDependencies: (...a: unknown[]) => Promise<{ pluginId: string; installed: true }> },
        "installWithDependencies",
      )
      .mockImplementation(async (id: unknown) => ({ pluginId: id as string, installed: true }));

    const result = await service.ensureManagedInstalled();

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(installSpy.mock.calls[0]![0]).toBe("beta");
    expect(result.installed).toEqual(["beta"]);
    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  // Issue #92 — auto-install of `dependencies[]` is REMOVED. The behavior
  // these tests pinned (cascading recursive install of plugin-id deps,
  // including admin-policy deps under the consumer's actor) is gone:
  //
  //   * `dependencies[].required = false` (or unset) is informational —
  //     install proceeds even when the dep is absent; the consumer plugin
  //     degrades its runtime feature surface.
  //   * `dependencies[].required = true` is a preflight contract —
  //     install throws `MissingPluginDependenciesError` if the dep is
  //     absent. The user must install the dep first.
  //
  // New-contract coverage lives in
  // `marketplace-plugin-dependencies.test.ts`. Capability-based preflight
  // (`requires.capabilities[]`) coverage remains in
  // `marketplace-dependency-guard.test.ts`.

  // Removed in Phase 2-final: the synthesized-manifest code path was the
  // file:-spec / npm-install branch's `writeInstalledManifest`, which is
  // gone. The signed-zip path uses the plugin.json the publisher shipped
  // in the artifact verbatim — there is nothing to "synthesize" anymore.
  // Test kept as a `it.skip` placeholder so future readers know why.
  it.skip("preserves rich manifest metadata when synthesizing an installed manifest", async () => {
    await mkdir(join(testDir, "plugin-src", "calendar"), { recursive: true });
    await mkdir(join(testDir, "plugin-src", "email"), { recursive: true });
    await mkdir(join(testDir, "plugin-src", "meeting"), { recursive: true });
    await mkdir(join(testDir, "plugin-src", "work-assistant"), { recursive: true });
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
        description: "Test fixture.",
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
            id: "work-assistant",
            name: "Work Proactive",
            description: "fixture",
            packageSpec: "file:./plugin-src/work-assistant",
            packageName: "@lvis/plugin-work-assistant",
            tools: ["work_assistant_generate_wakeup_briefing"],
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
            capabilities: ["work-assistant-provider"],
            requires: { capabilities: ["calendar-source"] },
            toolSchemas: {
              work_assistant_generate_wakeup_briefing: {
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

    await expect(service.install("work-assistant")).resolves.toEqual({
      pluginId: "work-assistant",
      installed: true,
    });

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; manifestPath: string }>;
    };
    const manifestPath = registry.plugins.find((entry) => entry.id === "work-assistant")?.manifestPath;
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
    expect(manifest.capabilities).toEqual(["work-assistant-provider"]);
    expect(manifest.toolSchemas?.work_assistant_generate_wakeup_briefing?.description).toBe(
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
        description: "Test fixture.",
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
        description: "Test fixture.",
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
        description: "Test fixture.",
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
            installSource: "user",
          },
          {
            id: "email",
            manifestPath: "installed/email/plugin.json",
            enabled: true,
            installSource: "user",
            bundleRefs: ["work-assistant"],
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
          touchedEntries: Map<string, {
            enabled?: boolean;
            bundleRefs?: string[];
            approvedPluginAccess?: unknown;
            installSource?: "admin" | "user" | "local-dev";
          }>;
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
            installSource: "user" as const,
            approvedPluginAccess: undefined,
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
        installSource: "user",
      },
    ]);
  });

  it("removes bundle members only when explicitly requested and still unreferenced", async () => {
    for (const pluginId of ["work-assistant", "email", "meeting", "calendar"]) {
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
          description: "Test fixture.",
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
            id: "work-assistant",
            manifestPath: "installed/work-assistant/plugin.json",
            enabled: true,
            installSource: "user",
          },
          {
            id: "email",
            manifestPath: "installed/email/plugin.json",
            enabled: true,
            installSource: "user",
            bundleRefs: ["work-assistant"],
          },
          {
            id: "meeting",
            manifestPath: "installed/meeting/plugin.json",
            enabled: true,
            installSource: "user",
            bundleRefs: ["work-assistant", "other-bundle"],
          },
          {
            id: "calendar",
            manifestPath: "installed/calendar/plugin.json",
            enabled: true,
            installSource: "admin",
            bundleRefs: ["work-assistant"],
          },
        ],
      }),
      "utf-8",
    );

    const service = makeManagedService(testDir, marketplacePath);
    await expect(service.uninstall("work-assistant", { removeBundleMembers: true })).resolves.toEqual({
      pluginId: "work-assistant",
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
        installSource: "user",
        bundleRefs: ["other-bundle"],
      },
      {
        id: "calendar",
        manifestPath: "installed/calendar/plugin.json",
        enabled: true,
        installSource: "admin",
        bundleRefs: [],
      },
    ]);
  });
});
