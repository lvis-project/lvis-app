import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "../marketplace.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";
import * as removalTransaction from "../plugin-removal-transaction.js";

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
      service as unknown as { readInstalledVersionFromRegistry: (r: unknown, id: string) => Promise<string | null> },
      "readInstalledVersionFromRegistry",
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

  it("auto-migrates a legacy-`_meta` managed plugin: catalog advertises the migrated version → update-first, no user action", async () => {
    // The recovery ladder's tier-1 (≡ tier-2) rung for the `_meta` rename. The only
    // plugin that ever used the legacy `xyz.lvis/pathFields` key — local-indexer — is
    // `installPolicy:"admin"` (managed). At boot, ensureManagedInstalled sees the
    // catalog's migrated version (0.5.24, `lvisai/pathFields`) is strictly newer than
    // the installed pre-migration version (0.5.19, legacy key) and AUTO-UPDATES it,
    // overwriting the on-disk manifest with the migrated one. runManagedBootstrap
    // then restartAll()s, so the plugin reloads with the new key in the SAME boot —
    // no broken window, no user click. The host install path is a clean artifact
    // replace, so "update in place" and "uninstall + reinstall" are the same
    // operation (tiers 1 and 2 collapse); the only terminal fallback is the surfaced
    // Doctor remove-recommendation, covered by the classification test.
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "local-indexer",
            name: "LVIS Local Indexer",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-local-indexer",
            packageName: "@lvis/plugin-local-indexer",
            tools: [],
            installPolicy: "admin",
            version: "0.5.24",
          },
        ],
      }),
      "utf-8",
    );
    const service = makeManagedService(testDir, marketplacePath);
    vi.spyOn(
      service as unknown as { resolveInstalledIds: (e: unknown) => Promise<Set<string>> },
      "resolveInstalledIds",
    ).mockResolvedValue(new Set(["local-indexer"]));
    vi.spyOn(
      service as unknown as { readInstalledVersionFromRegistry: (r: unknown, id: string) => Promise<string | null> },
      "readInstalledVersionFromRegistry",
    ).mockResolvedValue("0.5.19");
    const installSpy = vi
      .spyOn(
        service as unknown as {
          installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
        },
        "installWithDependencies",
      )
      .mockResolvedValue({ pluginId: "local-indexer", installed: true });

    const result = await service.ensureManagedInstalled();

    expect(installSpy).toHaveBeenCalledTimes(1);
    const [pluginId, actor] = installSpy.mock.calls[0]!;
    expect(pluginId).toBe("local-indexer");
    expect(actor).toBe("it-admin");
    expect(result.updated).toEqual(["local-indexer"]);
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
      service as unknown as { readInstalledVersionFromRegistry: (r: unknown, id: string) => Promise<string | null> },
      "readInstalledVersionFromRegistry",
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

  it("keeps managed install failures as Doctor diagnostics until a later success", async () => {
    await writeAdminCatalog("2.0.0");
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = vi
      .spyOn(
        service as unknown as {
          installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
        },
        "installWithDependencies",
      )
      .mockRejectedValueOnce(
        new Error(
          'plugin "meeting" artifact manifest external-auth-consumer capability does not match the catalog-approved grant',
        ),
      )
      .mockResolvedValueOnce({ pluginId: "meeting", installed: true });

    const failed = await service.ensureManagedInstalled();

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(failed.installed).toEqual([]);
    expect(failed.failed).toEqual([
      {
        id: "meeting",
        error:
          'plugin "meeting" artifact manifest external-auth-consumer capability does not match the catalog-approved grant',
      },
    ]);
    expect(service.getInstallFailureDiagnostics()).toEqual([
      expect.objectContaining({
        id: "meeting",
        name: "Meeting",
        isManaged: true,
        installPolicy: "admin",
        installFailureKind: "catalog-grant-mismatch",
        error:
          'plugin "meeting" artifact manifest external-auth-consumer capability does not match the catalog-approved grant',
      }),
    ]);

    const recovered = await service.ensureManagedInstalled();

    expect(recovered.installed).toEqual(["meeting"]);
    expect(service.getInstallFailureDiagnostics()).toEqual([]);
  });

  it("classifies managed manifest validation failures for Doctor detail UI", async () => {
    await writeAdminCatalog("2.0.0");
    const service = makeManagedService(testDir, marketplacePath);
    vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    ).mockRejectedValue(
      new Error(
        "[manifest:meeting] schema validation failed (/tmp/plugin.json): / unknown property: 'startupTools'",
      ),
    );

    const result = await service.ensureManagedInstalled();

    expect(result.failed).toEqual([
      {
        id: "meeting",
        error: "[manifest:meeting] schema validation failed (/tmp/plugin.json): / unknown property: 'startupTools'",
      },
    ]);
    expect(service.getInstallFailureDiagnostics()).toEqual([
      expect.objectContaining({
        id: "meeting",
        name: "Meeting",
        installFailureKind: "manifest-validation-error",
        error: "[manifest:meeting] schema validation failed (/tmp/plugin.json): / unknown property: 'startupTools'",
      }),
    ]);
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
      service as unknown as { readInstalledVersionFromRegistry: (r: unknown, id: string) => Promise<string | null> },
      "readInstalledVersionFromRegistry",
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

  // Removed (Phase 2-final synthesized-manifest path + #885 Phase R): the
  // synthesized-manifest code path is gone (signed-zip installs use the
  // publisher's plugin.json verbatim), and the `toolSchemas` projection the
  // old placeholder test asserted was deleted with the legacy manifest triple
  // (tools[]/toolSchemas/uiActions) in #885 Phase R. Nothing left to pin.

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

  it("rejects marketplace artifacts whose networkAccess exceeds the catalog-approved grant", async () => {
    const pluginDir = join(testDir, "plugins", "installed", "network-plugin");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "network-plugin",
        name: "Network Plugin",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
        description: "Test fixture.",
        capabilities: ["external-auth-consumer"],
        networkAccess: {
          allowedDomains: ["api.example.com", "login.example.com"],
          reasoning: "Broader artifact grant.",
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
            capabilities?: string[];
            networkAccess?: {
              allowedDomains: string[];
              reasoning?: string;
              allowPrivateNetworks?: boolean;
            };
          },
          version: string,
          manifestFile: string,
          pluginDir: string,
        ) => Promise<void>;
      }).assertInstalledManifestMatchesCatalog(
        {
          id: "network-plugin",
          installPolicy: "user",
          capabilities: ["external-auth-consumer"],
          networkAccess: {
            allowedDomains: ["api.example.com"],
            reasoning: "Catalog-approved grant.",
          },
        },
        "1.0.0",
        manifestPath,
        pluginDir,
      ),
    ).rejects.toThrow(/networkAccess does not match the catalog-approved grant/i);
  });

  it("accepts matching runtime-enforced capabilities without a networkAccess grant", async () => {
    const pluginDir = join(testDir, "plugins", "installed", "network-capability-positive");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "network-capability-positive",
        name: "Network Capability Positive",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
        description: "Test fixture.",
        capabilities: ["external-auth-consumer", "host:overlay"],
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
            capabilities?: string[];
          },
          version: string,
          manifestFile: string,
          pluginDir: string,
        ) => Promise<void>;
      }).assertInstalledManifestMatchesCatalog(
        {
          id: "network-capability-positive",
          installPolicy: "user",
          capabilities: ["external-auth-consumer", "host:overlay"],
        },
        "1.0.0",
        manifestPath,
        pluginDir,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects unapproved external-auth-consumer capability even without a networkAccess grant", async () => {
    const pluginDir = join(testDir, "plugins", "installed", "network-capability-plugin");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "network-capability-plugin",
        name: "Network Capability Plugin",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
        description: "Test fixture.",
        capabilities: ["external-auth-consumer"],
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
            capabilities?: string[];
            requires?: { capabilities: string[] };
          },
          version: string,
          manifestFile: string,
          pluginDir: string,
        ) => Promise<void>;
      }).assertInstalledManifestMatchesCatalog(
        {
          id: "network-capability-plugin",
          installPolicy: "user",
          capabilities: [],
          // Dependency requirements are not catalog approval for capabilities
          // declared by the artifact itself.
          requires: { capabilities: ["external-auth-consumer"] },
        },
        "1.0.0",
        manifestPath,
        pluginDir,
      ),
    ).rejects.toThrow(/external-auth-consumer capability does not match the catalog-approved grant/i);
  });

  it("rejects an unapproved host:overlay capability", async () => {
    const pluginDir = join(testDir, "plugins", "installed", "overlay-capability-plugin");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "overlay-capability-plugin",
        name: "Overlay Capability Plugin",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
        description: "Test fixture.",
        capabilities: ["host:overlay"],
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
            capabilities?: string[];
          },
          version: string,
          manifestFile: string,
          pluginDir: string,
        ) => Promise<void>;
      }).assertInstalledManifestMatchesCatalog(
        {
          id: "overlay-capability-plugin",
          installPolicy: "user",
          capabilities: [],
        },
        "1.0.0",
        manifestPath,
        pluginDir,
      ),
    ).rejects.toThrow(/host:overlay capability does not match the catalog-approved grant/i);
  });

  it("restores registry state during dependency rollback cleanup", async () => {
    const calendarDir = join(testDir, "plugins", "calendar");
    const emailDir = join(testDir, "plugins", "email");
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
            manifestPath: "calendar/plugin.json",
            enabled: false,
            installSource: "user",
          },
          {
            id: "email",
            manifestPath: "email/plugin.json",
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
        manifestPath: "calendar/plugin.json",
        enabled: false,
        installSource: "user",
      },
    ]);
  });

  it("preserves registry and live files when install rollback staging fails", async () => {
    const emailDir = join(pluginsDir, "email");
    await mkdir(emailDir, { recursive: true });
    await writeFile(join(emailDir, "plugin.json"), JSON.stringify({
      id: "email",
      name: "Email",
      version: "1.0.0",
      entry: "dist/index.js",
    }), "utf-8");
    const originalRegistry = `${JSON.stringify({
      version: 1,
      plugins: [
        { id: "email", manifestPath: "email/plugin.json", enabled: true, installSource: "user" },
        { id: "unrelated", manifestPath: "unrelated/plugin.json", enabled: false, installSource: "user" },
      ],
    }, null, 2)}\n`;
    await writeFile(registryPath, originalRegistry, "utf-8");
    await writeFile(marketplacePath, JSON.stringify({
      version: 1,
      plugins: [{
        id: "email",
        name: "Email",
        description: "fixture",
        packageSpec: "file:email",
        version: "2.0.0",
        installPolicy: "user",
      }],
    }), "utf-8");

    const installFailure = new Error("dependency install failed");
    const stagingFailure = Object.assign(new Error("rollback rename blocked"), { code: "EACCES" });
    vi.spyOn(removalTransaction, "stageRemovalTransaction").mockRejectedValueOnce(stagingFailure);
    const service = makeManagedService(testDir, marketplacePath);
    vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<unknown>;
      },
      "installWithDependencies",
    ).mockImplementationOnce(async (...args: unknown[]) => {
      const state = args[4] as { installedPluginIds: string[] };
      state.installedPluginIds.push("email");
      throw installFailure;
    });

    const error = await service.install("email").catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([installFailure, stagingFailure]);
    expect(await readFile(registryPath, "utf-8")).toBe(originalRegistry);
    expect(existsSync(join(emailDir, "plugin.json"))).toBe(true);
  });

  it("removes bundle members only when explicitly requested and still unreferenced", async () => {
    for (const pluginId of ["work-assistant", "email", "meeting", "calendar"]) {
      const pluginDir = join(testDir, "plugins", pluginId);
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
            manifestPath: "work-assistant/plugin.json",
            enabled: true,
            installSource: "user",
          },
          {
            id: "email",
            manifestPath: "email/plugin.json",
            enabled: true,
            installSource: "user",
            bundleRefs: ["work-assistant"],
          },
          {
            id: "meeting",
            manifestPath: "meeting/plugin.json",
            enabled: true,
            installSource: "user",
            bundleRefs: ["work-assistant", "other-bundle"],
          },
          {
            id: "calendar",
            manifestPath: "calendar/plugin.json",
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
        id: "calendar",
        manifestPath: "calendar/plugin.json",
        enabled: true,
        installSource: "admin",
        bundleRefs: [],
      },
      {
        id: "meeting",
        manifestPath: "meeting/plugin.json",
        enabled: true,
        installSource: "user",
        bundleRefs: ["other-bundle"],
      },
    ]);
  });

  it("holds every bundle-member lock through staging and registry commit", async () => {
    for (const pluginId of ["work-assistant", "email"]) {
      const pluginDir = join(pluginsDir, pluginId);
      await mkdir(join(pluginDir, "dist"), { recursive: true });
      await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "dist/index.js",
      }), "utf-8");
      await writeFile(join(pluginDir, "dist", "index.js"), "export default {};\n", "utf-8");
    }
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [
        { id: "work-assistant", manifestPath: "work-assistant/plugin.json", enabled: true, installSource: "user" },
        { id: "email", manifestPath: "email/plugin.json", enabled: true, installSource: "user", bundleRefs: ["work-assistant"] },
      ],
    }), "utf-8");

    const sourceDir = join(testDir, "email-source");
    await mkdir(join(sourceDir, "dist"), { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
      id: "email",
      name: "email replacement",
      version: "2.0.0",
      entry: "dist/index.js",
    }), "utf-8");
    await writeFile(join(sourceDir, "dist", "index.js"), "export default { version: 2 };\n", "utf-8");

    let resumeStaging!: () => void;
    const stagingGate = new Promise<void>((resolveGate) => { resumeStaging = resolveGate; });
    let stagingStarted!: () => void;
    const stagingStartedPromise = new Promise<void>((resolveStarted) => { stagingStarted = resolveStarted; });
    const originalStage = removalTransaction.stageRemovalTransaction;
    let paused = false;
    vi.spyOn(removalTransaction, "stageRemovalTransaction").mockImplementation(async (...args) => {
      if (!paused) {
        paused = true;
        stagingStarted();
        await stagingGate;
      }
      return originalStage(...args);
    });

    const service = makeManagedService(testDir, marketplacePath);
    const uninstall = service.uninstall("work-assistant", { removeBundleMembers: true });
    await stagingStartedPromise;
    let installSettled = false;
    const install = service.installLocal(sourceDir).finally(() => { installSettled = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(installSettled).toBe(false);

    resumeStaging();
    await expect(uninstall).resolves.toEqual({ pluginId: "work-assistant", uninstalled: true });
    await expect(install).resolves.toEqual({ pluginId: "email", installed: true });

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; installSource?: string }>;
    };
    expect(registry.plugins).toEqual([
      expect.objectContaining({ id: "email", installSource: "local-dev" }),
    ]);
    expect(existsSync(join(pluginsDir, "email", "plugin.json"))).toBe(true);
  }, 20_000);

  it("preserves the exact durable registry when tombstone staging fails", async () => {
    const original = `${JSON.stringify({
      version: 1,
      plugins: [
        { id: "target", manifestPath: "target/plugin.json", enabled: true, installSource: "user" },
        { id: "unrelated", manifestPath: "unrelated/plugin.json", enabled: true, bundleRefs: ["target"] },
      ],
    }, null, 2)}\n`;
    await writeFile(registryPath, original, "utf-8");
    await mkdir(join(pluginsDir, "target"), { recursive: true });
    vi.spyOn(removalTransaction, "stageRemovalTransaction").mockRejectedValueOnce(
      Object.assign(new Error("locked by Windows handle"), { code: "EACCES" }),
    );

    const service = makeManagedService(testDir, marketplacePath);
    await expect(service.uninstall("target")).rejects.toThrow("locked by Windows handle");
    expect(await readFile(registryPath, "utf-8")).toBe(original);
  });
});
