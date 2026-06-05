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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "../marketplace.js";
import { PluginDeploymentGuard } from "../deployment-guard.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";

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

  function makeService(auditLogger?: { log: (e: CapturedAuditEntry) => void }) {
    const paths = makeTestPluginPaths({ rootDir: testDir, pluginsRoot: pluginsDir });
    const guard = new PluginDeploymentGuard({
      registryPath: paths.registryPath,
      pluginsRoot: paths.pluginsRoot,
    });
    const fetcher = new MockMarketplaceFetcher(marketplacePath);
    // The AuditLogger interface accepts a structural subset, the test
    // fixture mock matches it via the `log({ ... })` shape only.
    return new PluginMarketplaceService(
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

  it("falls back to actor=user when the catalog snapshot fetch throws", async () => {
    // #1098 — escalation now reads from the single listPlugins snapshot. If that
    // fetch fails, install proceeds with actor="user" (the deployment guard then
    // re-blocks an admin policy; here a user-policy catalog just fails on the
    // artifact backend).
    await writeCatalog("user");
    const audit = makeAuditSink();
    const paths = makeTestPluginPaths({ rootDir: testDir, pluginsRoot: pluginsDir });
    const guard = new PluginDeploymentGuard({
      registryPath: paths.registryPath,
      pluginsRoot: paths.pluginsRoot,
    });
    const fetcher = new MockMarketplaceFetcher(marketplacePath);
    vi.spyOn(fetcher, "listPlugins").mockRejectedValue(new Error("network down"));
    const service = new PluginMarketplaceService(
      paths,
      fetcher,
      guard,
      audit.logger as unknown as ConstructorParameters<typeof PluginMarketplaceService>[3],
    );

    await expect(service.install("mp-test")).rejects.toBeDefined();
    // No escalation emitted — fetch failed, actor stayed "user".
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
    const detailSpy = vi.spyOn(fetcher, "getPluginDetail");
    const service = new PluginMarketplaceService(
      paths,
      fetcher,
      guard,
      audit.logger as unknown as ConstructorParameters<typeof PluginMarketplaceService>[3],
    );

    await expect(service.install("mp-test")).rejects.toBeDefined();

    // getPluginDetail is no longer part of the install path — the snapshot is
    // the listPlugins() result, shared by escalation + guard + artifact.
    expect(detailSpy).not.toHaveBeenCalled();
    expect(findEscalation(audit.entries)?.pluginInstall?.catalogSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
