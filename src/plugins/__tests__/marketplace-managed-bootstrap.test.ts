import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

import { dirname, join, resolve } from "node:path";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "../marketplace.js";
import type { PluginMarketplaceItem } from "../types.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import {
  makeTestPluginPaths,
  TestPluginMarketplaceService,
} from "./test-helpers.js";
import * as removalTransaction from "../plugin-removal-transaction.js";
import { removeQuiescentPluginResidualState } from "../uninstall-lifecycle.js";

function makeManagedService(testDir: string, marketplacePath: string): PluginMarketplaceService {
  const paths = makeTestPluginPaths({ rootDir: testDir });
  const fetcher = new MockMarketplaceFetcher(marketplacePath);
  return new TestPluginMarketplaceService(paths, fetcher);
}

/**
 * The mode boot uses; spelled out so these calls typecheck. The remover is a
 * bare pass-through here — the cases that pin what it must actually do bind
 * the real `removeQuiescentPluginResidualState` instead.
 */
const PRE_START_SYNC = {
  mode: "pre-start-sync",
  ensurePluginStateReadyForInstall: async () => {},
  removeDelistedAdminInstall: async (
    _removal: { pluginId: string; secretKeys: readonly string[] },
    commitRegistryRemoval: () => Promise<void>,
  ) => { await commitRegistryRemoval(); },
} as const;

/** Just the fetcher members these tests stub. */
interface MarketplaceFetcherSpyTarget {
  listPlugins: () => Promise<PluginMarketplaceItem[]>;
  getPluginDetail: (slug: string) => Promise<PluginMarketplaceItem | null>;
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
    // Keep injected filesystem roots repository-local so CodeQL does not
    // propagate an OS-temp path into production registry/artifact sinks.
    testDir = mkdtempSync(join(process.cwd(), ".lvis-managed-"));
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

  it("fails closed when a managed registry row points to a missing manifest", async () => {
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

    const result = await service.ensureManagedInstalled(PRE_START_SYNC);

    expect(installSpy).not.toHaveBeenCalled();
    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("fails closed when a managed manifest exists but its install receipt is missing", async () => {
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

    const result = await service.ensureManagedInstalled(PRE_START_SYNC);

    expect(installSpy).not.toHaveBeenCalled();
    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("does not treat an owned artifact directory without a registry row as structurally missing", async () => {
    await writeAdminCatalog("1.0.0");
    await mkdir(join(pluginsDir, "meeting"), { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }));
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    );
    const cleanupGate = vi.fn(async () => undefined);
    const activatePreparedArtifact = vi.fn();
    const result = await service.ensureManagedInstalled({
      mode: "repair-missing-only",
      ensurePluginStateReadyForInstall: cleanupGate,
      activatePreparedArtifact: activatePreparedArtifact as never,
    });

    expect(cleanupGate).not.toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled();
    expect(activatePreparedArtifact).not.toHaveBeenCalled();
    expect(result).toEqual({ installed: [], updated: [], removed: [], failed: [] });
  });

  it("repair-missing-only preserves an older disabled registry row without touching storage", async () => {
    await writeAdminCatalog("2.0.0");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: "meeting",
          manifestPath: "meeting/plugin.json",
          enabled: false,
          installSource: "admin",
        }],
      }),
      "utf-8",
    );
    const beforeRegistry = await readFile(registryPath, "utf-8");
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<unknown>;
      },
      "installWithDependencies",
    );
    const cleanupGate = vi.fn(async () => undefined);
    const activatePreparedArtifact = vi.fn();

    const result = await service.ensureManagedInstalled({
      mode: "repair-missing-only",
      ensurePluginStateReadyForInstall: cleanupGate,
      activatePreparedArtifact: activatePreparedArtifact as never,
    });

    expect(result).toEqual({ installed: [], updated: [], removed: [], failed: [] });
    expect(cleanupGate).not.toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled();
    expect(activatePreparedArtifact).not.toHaveBeenCalled();
    expect(await readFile(registryPath, "utf-8")).toBe(beforeRegistry);
    expect(existsSync(join(pluginsDir, "meeting"))).toBe(false);
  });

  it("repair-missing-only live-activates a true structural missing install once", async () => {
    await writeAdminCatalog("1.0.0");
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
    const service = makeManagedService(testDir, marketplacePath);
    const durableCommit = vi.fn(async () => "meeting/plugin.json");
    vi.spyOn(
      service as unknown as { installWithDependencies: (...args: unknown[]) => Promise<unknown> },
      "installWithDependencies",
    ).mockImplementation(async (...args: unknown[]) => {
      const activate = args[5] as ((prepared: unknown) => Promise<unknown>) | undefined;
      if (!activate) throw new Error("missing repair activation seam");
      await activate({
        installId: "meeting",
        pluginRoot: join(testDir, "staged-meeting"),
        manifest: { id: "meeting", version: "1.0.0" },
        receiptRaw: "{}",
        registryEntry: { installSource: "admin" },
        durableCommit,
      });
      return { pluginId: "meeting", installed: true };
    });
    const activatePreparedArtifact = vi.fn(async (prepared: { durableCommit(): Promise<string> }) => ({
      result: await prepared.durableCommit(),
      retirement: Promise.resolve(),
    }));

    const result = await service.ensureManagedInstalled({
      mode: "repair-missing-only",
      ensurePluginStateReadyForInstall: vi.fn(async () => undefined),
      activatePreparedArtifact: activatePreparedArtifact as never,
    });

    expect(result).toEqual({ installed: ["meeting"], updated: [], removed: [], failed: [] });
    expect(activatePreparedArtifact).toHaveBeenCalledOnce();
    expect(durableCommit).toHaveBeenCalledOnce();
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

  it("blocks a managed reinstall before registry or artifact mutation while cleanup is pending", async () => {
    await writeAdminCatalog("2.0.0");
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<unknown>;
      },
      "installWithDependencies",
    );
    const cleanupFailure = new Error("committed uninstall cleanup pending");
    const cleanupGate = vi.fn(async () => {
      throw cleanupFailure;
    });

    const result = await service.ensureManagedInstalled({
      mode: "pre-start-sync",
      ensurePluginStateReadyForInstall: cleanupGate,
      removeDelistedAdminInstall: PRE_START_SYNC.removeDelistedAdminInstall,
    });

    expect(cleanupGate).toHaveBeenCalledWith("meeting");
    expect(installSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      installed: [],
      updated: [],
      removed: [],
      failed: [{ id: "meeting", error: cleanupFailure.message }],
    });
  });

  function spyInstalledAtVersion(
    service: PluginMarketplaceService,
    installedVersion: string,
    pluginId = "meeting",
  ) {
    const pluginDir = join(pluginsDir, pluginId);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({
      id: pluginId,
      name: pluginId,
      version: installedVersion,
      entry: "dist/index.js",
      tools: [],
    }));
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      plugins: [{
        id: pluginId,
        manifestPath: `${pluginId}/plugin.json`,
        enabled: true,
        installSource: "admin",
      }],
    }));
    vi.spyOn(
      service as unknown as { readInstalledVersionFromRegistry: (r: unknown, id: string) => Promise<string | null> },
      "readInstalledVersionFromRegistry",
    ).mockResolvedValue(installedVersion);
    vi.spyOn(
      service as unknown as { getInstallReceiptValidation: (...args: unknown[]) => Promise<{ ok: boolean }> },
      "getInstallReceiptValidation",
    ).mockResolvedValue({ ok: true });
    return vi
      .spyOn(
        service as unknown as {
          installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
        },
        "installWithDependencies",
      )
      .mockResolvedValue({ pluginId, installed: true });
  }

  it("auto-updates an installed managed plugin when the catalog version is strictly newer", async () => {
    await writeAdminCatalog("2.0.0");
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = spyInstalledAtVersion(service, "1.0.0");

    const result = await service.ensureManagedInstalled(PRE_START_SYNC);

    expect(installSpy).toHaveBeenCalledTimes(1);
    const [pluginId, actor] = installSpy.mock.calls[0]!;
    expect(pluginId).toBe("meeting");
    expect(actor).toBe("it-admin"); // update still runs under the managed trust anchor
    expect(result.updated).toEqual(["meeting"]);
    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("does not enter the managed install path for an app-incompatible update", async () => {
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: "meeting",
          name: "Meeting",
          description: "fixture",
          packageSpec: "",
          packageName: "",
          tools: [],
          installPolicy: "admin",
          version: "0.5.32",
          upgradeRequired: {
            code: "upgrade_required",
            minAppVersion: "0.5.12",
            message: "LVIS 0.5.12+ is required.",
          },
        }],
      }),
      "utf-8",
    );
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = spyInstalledAtVersion(service, "0.5.31");
    const cleanupGate = vi.fn(async () => undefined);

    const result = await service.ensureManagedInstalled({
      mode: "pre-start-sync",
      ensurePluginStateReadyForInstall: cleanupGate,
      removeDelistedAdminInstall: PRE_START_SYNC.removeDelistedAdminInstall,
    });

    expect(cleanupGate).not.toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ installed: [], updated: [], removed: [], failed: [] });
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
    const installSpy = spyInstalledAtVersion(service, "0.5.19", "local-indexer");

    const result = await service.ensureManagedInstalled(PRE_START_SYNC);

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

    const result = await service.ensureManagedInstalled(PRE_START_SYNC);

    expect(installSpy).not.toHaveBeenCalled();
    expect(result.updated).toEqual([]);
    expect(result.installed).toEqual([]);
  });

  it("does NOT downgrade a managed plugin when the installed version is newer than the catalog", async () => {
    await writeAdminCatalog("1.0.0");
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = spyInstalledAtVersion(service, "2.0.0");

    const result = await service.ensureManagedInstalled(PRE_START_SYNC);

    expect(installSpy).not.toHaveBeenCalled();
    expect(result.updated).toEqual([]);
  });

  it("isolates a failed auto-update into result.failed without throwing", async () => {
    await writeAdminCatalog("2.0.0");
    const service = makeManagedService(testDir, marketplacePath);
    const installSpy = spyInstalledAtVersion(service, "1.0.0");
    installSpy.mockRejectedValue(new Error("download failed"));

    const result = await service.ensureManagedInstalled(PRE_START_SYNC);

    expect(result.failed).toEqual([{ id: "meeting", error: "download failed" }]);
    expect(result.updated).toEqual([]);
    expect(result.installed).toEqual([]);
  });

  it("commits a pre-start managed artifact without publishing or starting a candidate", async () => {
    await writeAdminCatalog("2.0.0");
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
    const beforeRegistry = await readFile(registryPath, "utf-8");
    const service = makeManagedService(testDir, marketplacePath);
    const durableCommit = vi.fn(async () => "meeting/plugin.json");
    vi.spyOn(
      service as unknown as { installWithDependencies: (...args: unknown[]) => Promise<unknown> },
      "installWithDependencies",
    ).mockImplementation(async (...args: unknown[]) => {
      const activate = args[5] as ((prepared: unknown) => Promise<unknown>) | undefined;
      if (!activate) throw new Error("missing managed generation activation seam");
      await activate({
        pluginRoot: join(testDir, "staged-meeting"),
        manifest: { id: "meeting", version: "2.0.0" },
        receiptRaw: "{}",
        durableCommit,
      });
      return { pluginId: "meeting", installed: true };
    });
    const result = await service.ensureManagedInstalled({
      mode: "pre-start-sync",
      ensurePluginStateReadyForInstall: vi.fn(async () => undefined),
      removeDelistedAdminInstall: PRE_START_SYNC.removeDelistedAdminInstall,
    });

    expect(result).toEqual({ installed: ["meeting"], updated: [], removed: [], failed: [] });
    expect(durableCommit).toHaveBeenCalledOnce();
    expect(await readFile(registryPath, "utf-8")).toBe(beforeRegistry);
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

    const failed = await service.ensureManagedInstalled(PRE_START_SYNC);

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

    const recovered = await service.ensureManagedInstalled(PRE_START_SYNC);

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

    const result = await service.ensureManagedInstalled(PRE_START_SYNC);

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
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      plugins: [{ id: "alpha", manifestPath: "alpha/plugin.json", enabled: true, installSource: "admin" }],
    }));
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

    const result = await service.ensureManagedInstalled(PRE_START_SYNC);

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
  describe("delisted admin installs", () => {
    // The catalog is the authority for an admin plugin — enforced sync is what
    // makes the install admin rather than the user's. These pin the evidence
    // required before boot deletes one on its own.
    //
    // The mock fetcher answers list and detail from the same file, so a test
    // that only writes a catalog cannot tell the listing apart from the
    // per-slug probe. Every case below stubs `getPluginDetail` explicitly so
    // the two can disagree — which is exactly the case that matters, since
    // `mapItem` drops rows whose app-version resolution is malformed.
    async function seedAdminInstall(
      manifestExtras: Record<string, unknown> = {},
    ): Promise<void> {
      await writeFile(
        marketplacePath,
        JSON.stringify({ version: 1, plugins: [] }),
        "utf-8",
      );
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: "ep-api",
              manifestPath: "ep-api/plugin.json",
              enabled: true,
              installSource: "admin",
            },
          ],
        }),
        "utf-8",
      );
      await mkdir(join(pluginsDir, "ep-api"), { recursive: true });
      await writeFile(
        join(pluginsDir, "ep-api", "plugin.json"),
        JSON.stringify({ id: "ep-api", version: "0.17.32", ...manifestExtras }),
        "utf-8",
      );
    }

    function stubDetail(
      service: PluginMarketplaceService,
      detail: () => Promise<PluginMarketplaceItem | null>,
    ) {
      return vi
        .spyOn(
          (service as unknown as { fetcher: MarketplaceFetcherSpyTarget }).fetcher,
          "getPluginDetail",
        )
        .mockImplementation(detail);
    }

    it("removes an admin install the marketplace no longer publishes", async () => {
      await seedAdminInstall();
      const service = makeManagedService(testDir, marketplacePath);
      stubDetail(service, async () => null);

      const result = await service.ensureManagedInstalled(PRE_START_SYNC);

      expect(result.removed).toEqual(["ep-api"]);
      expect(result.failed).toEqual([]);
      const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string }>;
      };
      expect(registry.plugins.map((entry) => entry.id)).toEqual([]);
    });

    it("keeps an admin install the listing omitted but the marketplace still serves", async () => {
      await seedAdminInstall();
      const service = makeManagedService(testDir, marketplacePath);
      // A published plugin the catalog listing dropped — the row carried no
      // usable app-version resolution. Absence from the listing is not proof.
      stubDetail(service, async () => ({
        id: "ep-api",
        name: "EP API",
        description: "still published",
        installPolicy: "admin",
      }) as unknown as PluginMarketplaceItem);

      const result = await service.ensureManagedInstalled(PRE_START_SYNC);

      expect(result.removed).toEqual([]);
      const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string }>;
      };
      expect(registry.plugins.map((entry) => entry.id)).toEqual(["ep-api"]);
    });

    it("keeps an admin install when the delisting probe cannot be answered", async () => {
      await seedAdminInstall();
      const service = makeManagedService(testDir, marketplacePath);
      stubDetail(service, async () => {
        throw new Error("ETIMEDOUT");
      });

      const result = await service.ensureManagedInstalled(PRE_START_SYNC);

      expect(result.removed).toEqual([]);
      expect(result.failed).toEqual([{ id: "ep-api", error: "ETIMEDOUT" }]);
      const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string }>;
      };
      expect(registry.plugins.map((entry) => entry.id)).toEqual(["ep-api"]);
    });

    it("removes nothing when the catalog itself is unreachable", async () => {
      await seedAdminInstall();
      const service = makeManagedService(testDir, marketplacePath);
      vi.spyOn(
        (service as unknown as { fetcher: MarketplaceFetcherSpyTarget }).fetcher,
        "listPlugins",
      ).mockRejectedValue(new Error("ENOTFOUND marketplace"));
      const detailSpy = stubDetail(service, async () => null);

      const result = await service.ensureManagedInstalled(PRE_START_SYNC);

      expect(result.removed).toEqual([]);
      // Not even probed: an unreachable catalog says nothing about any plugin.
      expect(detailSpy).not.toHaveBeenCalled();
      const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string }>;
      };
      expect(registry.plugins.map((entry) => entry.id)).toEqual(["ep-api"]);
    });

    it("leaves a user-installed plugin alone when the catalog drops it", async () => {
      await seedAdminInstall();
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: "ep-api",
              manifestPath: "ep-api/plugin.json",
              enabled: true,
              installSource: "user",
            },
          ],
        }),
        "utf-8",
      );
      const service = makeManagedService(testDir, marketplacePath);
      const detailSpy = stubDetail(service, async () => null);

      const result = await service.ensureManagedInstalled(PRE_START_SYNC);

      expect(result.removed).toEqual([]);
      expect(detailSpy).not.toHaveBeenCalled();
      const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string }>;
      };
      expect(registry.plugins.map((entry) => entry.id)).toEqual(["ep-api"]);
    });

    // `PluginMarketplaceService.uninstall` is only the registry+directories
    // half of a removal. Everything else a user-initiated uninstall does lives
    // in the uninstall lifecycle, and an enforced removal used to skip all of
    // it — leaving the plugin's config, its secrets, its auth partition and
    // its cache behind, which a later re-install then silently inherited.
    // The real lifecycle function is bound here, driven by the real producer.
    it("runs the host-owned residual cleanup when it removes a delisted admin install", async () => {
      await seedAdminInstall({
        configSchema: {
          properties: {
            token: { type: "string", format: "secret" },
            endpoint: { type: "string" },
          },
        },
      });
      const paths = makeTestPluginPaths({ rootDir: testDir });
      await mkdir(join(paths.cacheRoot, "ep-api"), { recursive: true });
      await writeFile(join(paths.cacheRoot, "ep-api", "state.json"), "{}", "utf-8");
      const partition = "persist:plugin-auth:ep-api";
      const deletePluginConfig = vi.fn(async () => undefined);
      const deletePluginSecrets = vi.fn(async () => 1);
      const clearAuthPartitionService = vi.fn(async () => undefined);
      const forgetPluginAuthPartitionsService = vi.fn();
      const clearConfigOverride = vi.fn();
      const emitHostEvent = vi.fn();
      const service = makeManagedService(testDir, marketplacePath);
      stubDetail(service, async () => null);

      const result = await service.ensureManagedInstalled({
        mode: "pre-start-sync",
        ensurePluginStateReadyForInstall: async () => {},
        removeDelistedAdminInstall: (removal, commitRegistryRemoval) =>
          removeQuiescentPluginResidualState(
            { ...removal, installPluginId: removal.pluginId },
            commitRegistryRemoval,
            {
              pluginRuntime: { clearConfigOverride } as never,
              settingsService: { deletePluginConfig, deletePluginSecrets },
              pluginPaths: { cacheRoot: paths.cacheRoot },
              clearAuthPartitionService,
              listPluginAuthPartitionsService: () => [partition],
              forgetPluginAuthPartitionsService,
              drainPluginInstallLockOperationsService: async () => undefined,
              emitHostEvent,
            },
          ),
      });

      expect(result.removed).toEqual(["ep-api"]);
      expect(result.failed).toEqual([]);
      expect(deletePluginConfig).toHaveBeenCalledWith("ep-api");
      // The secret key set is derived by the producer from the manifest still
      // on disk at removal time — not handed in by the test.
      expect(deletePluginSecrets).toHaveBeenCalledWith("ep-api", new Set(["token"]));
      expect(clearAuthPartitionService).toHaveBeenCalledWith(partition);
      expect(forgetPluginAuthPartitionsService).toHaveBeenCalledWith("ep-api");
      expect(clearConfigOverride).toHaveBeenCalledWith("ep-api");
      expect(existsSync(join(paths.cacheRoot, "ep-api"))).toBe(false);
      // The registry-entry cache, the uninstall telemetry track and every
      // per-plugin `plugin.uninstalled` subscriber hang off this event.
      expect(emitHostEvent).toHaveBeenCalledWith("plugin.uninstalled", {
        pluginId: "ep-api",
      });
    });

    it("refuses a pre-start sync that cannot clean up a removed install", async () => {
      await seedAdminInstall();
      const service = makeManagedService(testDir, marketplacePath);

      await expect(
        service.ensureManagedInstalled({
          mode: "pre-start-sync",
          ensurePluginStateReadyForInstall: async () => {},
        } as never),
      ).rejects.toThrow(/delisted-install residual cleanup/);
    });

    // Enforced removal is safe only because the pre-start pass commits before
    // `startPlugins()` reads its snapshot. The retry path runs long after that,
    // against live generations, so it must not delete registry rows out from
    // under them; the next boot's pre-start pass does the removal.
    it("does not remove a delisted admin install during live repair", async () => {
      await seedAdminInstall();
      const service = makeManagedService(testDir, marketplacePath);
      const detailSpy = stubDetail(service, async () => null);

      const result = await service.ensureManagedInstalled({
        mode: "repair-missing-only",
        ensurePluginStateReadyForInstall: async () => {},
        activatePreparedArtifact: vi.fn() as never,
      });

      expect(result.removed).toEqual([]);
      expect(detailSpy).not.toHaveBeenCalled();
      const liveRegistry = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string }>;
      };
      expect(liveRegistry.plugins.map((entry) => entry.id)).toEqual(["ep-api"]);
    });
  });
});
