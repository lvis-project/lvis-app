/**
 * PluginMarketplaceService.install — internal actor escalation.
 *
 * Post-#964 redesign: actor decision moved out of the IPC handler and into
 * `PluginMarketplaceService.install`. The IPC handler now passes only
 * pluginId. The marketplace fetches the catalog item, derives the actor
 * (admin → "it-admin", otherwise → "user"), and emits the escalation
 * audit entry — same trust anchor as boot-time `ensureManagedInstalled`.
 *
 * deployment-guard.ts §7.3:
 *   "IPC 핸들러에서 actor를 직접 받지 말 것 — 'it-admin'은
 *    ManagedPluginInstaller 같은 내부 플로우에서만 사용."
 *
 * This test exercises the escalation contract directly through the public
 * marketplace API, isolated from IPC wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  MockMarketplaceFetcher,
  PluginInstalledStateUnreadableError,
  PluginMarketplaceService,
  PluginUpdateRecoveryRequiredError,
} from "../marketplace.js";
import { PluginDeploymentGuard } from "../deployment-guard.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import {
  makeTestPluginPaths,
  TestPluginMarketplaceService,
} from "./test-helpers.js";

interface CapturedAuditEntry {
  timestamp: string;
  sessionId: string;
  type: string;
  input?: string;
  pluginInstall?: {
    event: string;
    pluginId: string;
    catalogPolicy: string;
    actorOriginal: string;
    actorEscalated: string;
    location: string;
    catalogSnapshotHash: string;
  };
}

function makeAuditSink() {
  const entries: CapturedAuditEntry[] = [];
  return {
    entries,
    logger: {
      log: vi.fn((entry: CapturedAuditEntry) => {
        entries.push(entry);
      }),
    },
  };
}

// #1098 — the escalation event is now a typed structured field (was an ad-hoc
// JSON.stringify blob in `input`).
const findEscalation = (entries: CapturedAuditEntry[]) =>
  entries.find((e) => e.pluginInstall?.event === "plugin-install-escalation");

describe("PluginMarketplaceService.install — actor escalation", () => {
  let testDir: string;
  let pluginsDir: string;
  let registryPath: string;
  let marketplacePath: string;

  beforeEach(async () => {
    setIsPackaged(false);
    process.env.LVIS_DEV = "1";
    testDir = mkdtempSync(join(tmpdir(), "lvis-mp-escalation-"));
    pluginsDir = join(testDir, "plugins");
    registryPath = join(pluginsDir, "registry.json");
    marketplacePath = join(testDir, "marketplace.json");
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
  });

  afterEach(async () => {
    delete process.env.LVIS_DEV;
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
    _resetForTest();
  });

  async function writeCatalog(installPolicy?: "admin" | "user") {
    const entry: Record<string, unknown> = {
      id: "mp-test",
      name: "Marketplace Test",
      description: "fixture",
      packageSpec: "file:./nonexistent",
      packageName: "@lvis-test/nonexistent",
      methods: [],
    };
    if (installPolicy) entry.installPolicy = installPolicy;
    await writeFile(
      marketplacePath,
      JSON.stringify({ version: 1, plugins: [entry] }),
      "utf-8",
    );
  }

  async function writeInstalled(version: string, installSource: "admin" | "user") {
    const pluginDir = join(pluginsDir, "mp-test");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        id: "mp-test",
        name: "Marketplace Test",
        version,
        entry: "dist/index.js",
        tools: [],
      }),
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: "mp-test",
          manifestPath: "mp-test/plugin.json",
          enabled: true,
          installSource,
        }],
      }),
    );
  }

  function makeService(auditLogger?: { log: (e: CapturedAuditEntry) => void }) {
    const paths = makeTestPluginPaths({ rootDir: testDir, pluginsRoot: pluginsDir });
    const guard = new PluginDeploymentGuard({
      registryPath: paths.registryPath,
      pluginsRoot: paths.pluginsRoot,
    });
    const fetcher = new MockMarketplaceFetcher(marketplacePath);
    // The AuditLogger interface accepts a structural subset, the test
    // fixture mock matches it via the `log({ ... })` shape only.
    return new TestPluginMarketplaceService(
      paths,
      fetcher,
      guard,
      auditLogger as unknown as ConstructorParameters<typeof PluginMarketplaceService>[3],
    );
  }

  it("emits escalation audit entry when catalog installPolicy === 'admin'", async () => {
    await writeCatalog("admin");
    const audit = makeAuditSink();
    const service = makeService(audit.logger);

    // Install will fail downstream (no real artifact backend in tests) but
    // the escalation audit + actor derivation happen *before* download.
    await expect(service.install("mp-test")).rejects.toBeDefined();

    const escalation = findEscalation(audit.entries);
    expect(escalation).toBeDefined();
    const payload = escalation!.pluginInstall!;
    expect(payload.event).toBe("plugin-install-escalation");
    expect(payload.pluginId).toBe("mp-test");
    expect(payload.catalogPolicy).toBe("admin");
    expect(payload.actorOriginal).toBe("user");
    expect(payload.actorEscalated).toBe("it-admin");
    expect(payload.location).toBe("marketplace.install");
    // #1098 — the exact catalog snapshot that drove escalation is pinned.
    expect(payload.catalogSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    // Concise human-readable summary populates the Audit UI preview column.
    expect(escalation!.input).toContain("plugin-install-escalation");
    expect(escalation!.input).toContain("mp-test");
  });

  it("does NOT emit escalation audit when catalog installPolicy === 'user'", async () => {
    await writeCatalog("user");
    const audit = makeAuditSink();
    const service = makeService(audit.logger);

    await expect(service.install("mp-test")).rejects.toBeDefined();

    expect(findEscalation(audit.entries)).toBeUndefined();
  });

  it("does NOT emit escalation audit when installPolicy is omitted (defaults to user)", async () => {
    await writeCatalog();
    const audit = makeAuditSink();
    const service = makeService(audit.logger);

    await expect(service.install("mp-test")).rejects.toBeDefined();

    expect(findEscalation(audit.entries)).toBeUndefined();
  });

  it("admin escalation bypasses deployment-guard (no 'installed by user' rejection)", async () => {
    // The pre-redesign behavior was that admin catalog items rejected
    // with 'Plugin admin … installed by user'. With escalation moved
    // inside install(), admin items pass the guard automatically — only
    // downstream artifact/install errors remain.
    await writeCatalog("admin");
    const service = makeService();
    await expect(service.install("mp-test")).rejects.not.toThrow(/installed by user/);
  });

  it("defers an installed older admin plugin update until app restart", async () => {
    await writeCatalog("admin");
    const raw = JSON.parse(await readFile(marketplacePath, "utf-8"));
    raw.plugins[0].version = "2.0.0";
    await writeFile(marketplacePath, JSON.stringify(raw));
    await writeInstalled("1.0.0", "admin");
    const service = makeService();
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    );
    const activatePreparedArtifact = vi.fn();

    await expect(service.install("mp-test", undefined, {
      activatePreparedArtifact: activatePreparedArtifact as never,
    })).rejects.toThrow(/managed plugin update.*restart/i);

    expect(installSpy).not.toHaveBeenCalled();
    expect(activatePreparedArtifact).not.toHaveBeenCalled();
  });

  it("keeps compatible missing admin plugins on the trusted install path", async () => {
    await writeCatalog("admin");
    const service = makeService();
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    ).mockResolvedValue({ pluginId: "mp-test", installed: true });

    await expect(service.install("mp-test")).resolves.toEqual({
      pluginId: "mp-test",
      installed: true,
    });
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(installSpy.mock.calls[0]?.[1]).toBe("it-admin");
  });

  it("keeps compatible installed user updates on the live install path", async () => {
    await writeCatalog("user");
    const raw = JSON.parse(await readFile(marketplacePath, "utf-8"));
    raw.plugins[0].version = "2.0.0";
    await writeFile(marketplacePath, JSON.stringify(raw));
    await writeInstalled("1.0.0", "user");
    const service = makeService();
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    ).mockResolvedValue({ pluginId: "mp-test", installed: true });

    await expect(service.install("mp-test")).resolves.toEqual({
      pluginId: "mp-test",
      installed: true,
    });
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(installSpy.mock.calls[0]?.[1]).toBe("user");
  });

  it("keeps an equal version on the existing integrity-check install path", async () => {
    await writeCatalog("user");
    const raw = JSON.parse(await readFile(marketplacePath, "utf-8"));
    raw.plugins[0].version = "1.0.0";
    await writeFile(marketplacePath, JSON.stringify(raw));
    await writeInstalled("1.0.0", "user");
    const service = makeService();
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    ).mockResolvedValue({ pluginId: "mp-test", installed: true });

    await expect(service.install("mp-test")).resolves.toEqual({
      pluginId: "mp-test",
      installed: true,
    });
    expect(installSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an older catalog version before downgrade side effects", async () => {
    await writeCatalog("user");
    const raw = JSON.parse(await readFile(marketplacePath, "utf-8"));
    raw.plugins[0].version = "1.0.0";
    await writeFile(marketplacePath, JSON.stringify(raw));
    await writeInstalled("2.0.0", "user");
    const audit = makeAuditSink();
    const service = makeService(audit.logger);
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    );
    const activatePreparedArtifact = vi.fn();

    await expect(service.install("mp-test", undefined, {
      activatePreparedArtifact: activatePreparedArtifact as never,
    })).rejects.toThrow(/downgrade.*not allowed/i);

    expect(findEscalation(audit.entries)).toBeUndefined();
    expect(installSpy).not.toHaveBeenCalled();
    expect(activatePreparedArtifact).not.toHaveBeenCalled();
  });

  it("fails closed when a registry row exists but its manifest version is unreadable", async () => {
    await writeCatalog("user");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: "mp-test",
          manifestPath: "mp-test/missing-plugin.json",
          enabled: true,
          installSource: "user",
        }],
      }),
    );
    const service = makeService();
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    );
    const activatePreparedArtifact = vi.fn();

    await expect(service.install("mp-test", undefined, {
      activatePreparedArtifact: activatePreparedArtifact as never,
    })).rejects.toBeInstanceOf(PluginInstalledStateUnreadableError);

    expect(installSpy).not.toHaveBeenCalled();
    expect(activatePreparedArtifact).not.toHaveBeenCalled();
  });

  it("requires recovery for a pending managed update instead of replacing it live", async () => {
    await writeCatalog("admin");
    const raw = JSON.parse(await readFile(marketplacePath, "utf-8"));
    raw.plugins[0].version = "2.0.0";
    await writeFile(marketplacePath, JSON.stringify(raw));
    await writeInstalled("1.0.0", "admin");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    registry.plugins[0].pendingUpdate = {
      kind: "marketplace",
      previousManifestFileSha256: "a".repeat(64),
      previousReceiptRaw: "{}",
    };
    await writeFile(registryPath, JSON.stringify(registry));
    const service = makeService();
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    );
    const activatePreparedArtifact = vi.fn();

    await expect(service.install("mp-test", undefined, {
      activatePreparedArtifact: activatePreparedArtifact as never,
    })).rejects.toBeInstanceOf(PluginUpdateRecoveryRequiredError);

    expect(installSpy).not.toHaveBeenCalled();
    expect(activatePreparedArtifact).not.toHaveBeenCalled();
  });

  it("fails fast with the original error when the catalog snapshot fetch throws (no masking)", async () => {
    // #1098 — the single listPlugins snapshot drives the whole install, so a
    // fetch failure is fatal. The original error must propagate (not be swallowed
    // and re-surfaced as a misleading "Plugin not found").
    await writeCatalog("user");
    const audit = makeAuditSink();
    const paths = makeTestPluginPaths({ rootDir: testDir, pluginsRoot: pluginsDir });
    const guard = new PluginDeploymentGuard({
      registryPath: paths.registryPath,
      pluginsRoot: paths.pluginsRoot,
    });
    const fetcher = new MockMarketplaceFetcher(marketplacePath);
    vi.spyOn(fetcher, "listPlugins").mockRejectedValue(new Error("network down"));
    const service = new TestPluginMarketplaceService(
      paths,
      fetcher,
      guard,
      audit.logger as unknown as ConstructorParameters<typeof PluginMarketplaceService>[3],
    );

    await expect(service.install("mp-test")).rejects.toThrow(/network down/);
    // No escalation emitted — fetch failed before any policy decision.
    expect(findEscalation(audit.entries)).toBeUndefined();
  });

  it("uses ONE catalog snapshot for escalation + install (no getPluginDetail re-fetch) — #1098 TOCTOU", async () => {
    // The escalation decision and the guard/artifact selection must read the
    // same snapshot. The redesign drops the separate getPluginDetail read that
    // created the TOCTOU window; install now derives everything from a single
    // listPlugins() snapshot.
    await writeCatalog("admin");
    const audit = makeAuditSink();
    const paths = makeTestPluginPaths({ rootDir: testDir, pluginsRoot: pluginsDir });
    const guard = new PluginDeploymentGuard({
      registryPath: paths.registryPath,
      pluginsRoot: paths.pluginsRoot,
    });
    const fetcher = new MockMarketplaceFetcher(marketplacePath);
    const listSpy = vi.spyOn(fetcher, "listPlugins");
    const detailSpy = vi.spyOn(fetcher, "getPluginDetail");
    const service = new TestPluginMarketplaceService(
      paths,
      fetcher,
      guard,
      audit.logger as unknown as ConstructorParameters<typeof PluginMarketplaceService>[3],
    );

    await expect(service.install("mp-test")).rejects.toBeDefined();

    // getPluginDetail is no longer part of the install path — the snapshot is
    // the listPlugins() result, shared by escalation + guard + artifact.
    expect(detailSpy).not.toHaveBeenCalled();
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(findEscalation(audit.entries)?.pluginInstall?.catalogSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("consumes the admitted catalog snapshot even if the catalog changes afterward", async () => {
    await writeCatalog("user");
    const service = makeService();
    const admission = await service.preflightInstall("mp-test");
    await writeCatalog("admin");
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    ).mockResolvedValue({ pluginId: "mp-test", installed: true });

    await expect(service.install("mp-test", undefined, {
      admission,
      activatePreparedArtifact: vi.fn() as never,
    })).resolves.toEqual({ pluginId: "mp-test", installed: true });

    const [, actor, snapshot] = installSpy.mock.calls[0]!;
    expect(actor).toBe("user");
    expect((snapshot as Array<{ installPolicy?: string }>)[0]?.installPolicy).toBe("user");
    await expect(service.install("mp-test", undefined, {
      admission,
      activatePreparedArtifact: vi.fn() as never,
    })).rejects.toThrow(/already been consumed/);
  });

  it("rejects fabricated admissions", async () => {
    await writeCatalog("user");
    const service = makeService();

    await expect(service.install("mp-test", undefined, {
      admission: Object.freeze({
        pluginId: "mp-test",
        catalogVersion: null,
        installed: false,
      }),
      activatePreparedArtifact: vi.fn() as never,
    })).rejects.toThrow(/invalid or fabricated/);
  });

  it("binds network acknowledgement by admitted value rather than caller object identity", async () => {
    await writeCatalog("user");
    const raw = JSON.parse(await readFile(marketplacePath, "utf-8"));
    raw.plugins[0].networkAccess = {
      allowedDomains: ["sync.example.com", "api.example.com"],
      reasoning: "Sync fixture",
      allowPrivateNetworks: true,
    };
    await writeFile(marketplacePath, JSON.stringify(raw));
    const service = makeService();
    const acknowledgement = {
      allowPrivateNetworks: true as const,
      allowedDomains: ["sync.example.com", "api.example.com"],
    };
    const admission = await service.preflightInstall("mp-test", {
      networkAccessAcknowledgement: acknowledgement,
    });
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    ).mockResolvedValue({ pluginId: "mp-test", installed: true });

    acknowledgement.allowedDomains.push("evil.example.com");
    await expect(service.install("mp-test", undefined, {
      admission,
      networkAccessAcknowledgement: acknowledgement,
      activatePreparedArtifact: vi.fn() as never,
    })).rejects.toThrow(/does not match network acknowledgement/);
    expect(installSpy).not.toHaveBeenCalled();

    await expect(service.install("mp-test", undefined, {
      admission,
      networkAccessAcknowledgement: {
        allowedDomains: ["api.example.com", "sync.example.com"],
        allowPrivateNetworks: true,
      },
      activatePreparedArtifact: vi.fn() as never,
    })).resolves.toEqual({ pluginId: "mp-test", installed: true });
    expect(installSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects using a valid admission for another requested plugin identity", async () => {
    await writeCatalog("user");
    const service = makeService();
    const admission = await service.preflightInstall("mp-test");
    const installSpy = vi.spyOn(
      service as unknown as {
        installWithDependencies: (...args: unknown[]) => Promise<{ pluginId: string; installed: true }>;
      },
      "installWithDependencies",
    );
    const activatePreparedArtifact = vi.fn();

    await expect(service.install("another-plugin", undefined, {
      admission,
      activatePreparedArtifact: activatePreparedArtifact as never,
    })).rejects.toThrow(/does not match requested plugin/);

    expect(installSpy).not.toHaveBeenCalled();
    expect(activatePreparedArtifact).not.toHaveBeenCalled();
  });
});
