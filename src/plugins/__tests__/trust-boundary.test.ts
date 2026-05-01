/**
 * Phase 1 — Plugin trust-boundary hardening tests.
 *
 * Covers four orthogonal hardening fixes:
 *
 *   1. (CRITICAL §Step 1) `isTrustedRegistryManifestPath` accepts BOTH
 *      hostRoot and pluginsRoot; rejects symlink escape.
 *   2. (HIGH §Step 2) `installedBy` recorded on the registry entry is
 *      authoritative; manifest `installPolicy` is advisory only.
 *   3. (MEDIUM §Step 3) `dev-flags.ts` helpers hard-gate on `app.isPackaged`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";
import { PluginDeploymentGuard } from "../deployment-guard.js";
import {
  hashReceiptFiles,
  writeInstallReceipt,
  type PluginInstallReceipt,
} from "../plugin-install-receipt.js";
import {
  _resetForTest,
  devLinkedEntryAllowed,
  isDevModeUnlocked,
  setIsPackaged,
} from "../../boot/dev-flags.js";

const ENTRY_SOURCE = `export default async function createPlugin(ctx) {
  return { handlers: { tb_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`;

describe("Phase 1 — plugin trust boundary", () => {
  let testDir: string;
  let hostRoot: string;
  let pluginsRoot: string;
  let cacheRoot: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `lvis-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    hostRoot = join(testDir, "host");
    pluginsRoot = join(testDir, "userInstalled");
    cacheRoot = join(pluginsRoot, ".cache");
    await mkdir(join(hostRoot, "plugins"), { recursive: true });
    await mkdir(pluginsRoot, { recursive: true });
    registryPath = join(hostRoot, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePluginAt(
    pluginDir: string,
    id: string,
    opts?: { installPolicy?: "admin" | "user" },
  ): Promise<string> {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "entry.mjs"), ENTRY_SOURCE, "utf-8");
    const manifest: Record<string, unknown> = {
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry: "entry.mjs",
      tools: ["tb_ping"],
    };
    if (opts?.installPolicy) manifest.installPolicy = opts.installPolicy;
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    return manifestPath;
  }

  async function writeRegistry(
    entries: Array<{ id: string; manifestPath: string; installedBy?: "admin" | "user"; _devLinked?: boolean }>,
  ): Promise<void> {
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: entries }), "utf-8");
  }

  async function writeReceipt(pluginId: string, pluginDir: string): Promise<void> {
    const receipt: PluginInstallReceipt = {
      schemaVersion: 2,
      pluginId,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "poc-v1",
      installedAt: new Date(0).toISOString(),
      files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
    };
    await writeInstallReceipt(cacheRoot, receipt);
  }

  // ───────────────────────────── §Step 1 ─────────────────────────────

  describe("isTrustedRegistryManifestPath single-root containment", () => {
    it("accepts a registry manifest path under pluginsRoot", async () => {
      const manifestPath = await writePluginAt(
        join(pluginsRoot, "p-user"),
        "tb.user",
      );
      await writeRegistry([{ id: "tb.user", manifestPath }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).toContain("tb.user");
    });

    it("rejects a registry manifest path under hostRoot (no longer a trust root)", async () => {
      const manifestPath = await writePluginAt(
        join(hostRoot, "plugins", "installed", "p-host"),
        "tb.host",
      );
      await writeRegistry([{ id: "tb.host", manifestPath }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).not.toContain("tb.host");
    });

    it("rejects a registry manifest path outside pluginsRoot", async () => {
      const manifestPath = await writePluginAt(
        join(testDir, "rogue", "p-rogue"),
        "tb.rogue",
      );
      await writeRegistry([{ id: "tb.rogue", manifestPath }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).not.toContain("tb.rogue");
    });

    // Symlink creation on Windows requires admin or developer mode. Skip
    // there — the other branches still exercise the realpath containment
    // check via a real on-disk path.
    const symlinkSkip = process.platform === "win32";
    it.skipIf(symlinkSkip)(
      "rejects a symlink under pluginsRoot that points outside the trust root",
      async () => {
        // Real plugin lives at testDir/outside/p-evil/plugin.json — outside
        // pluginsRoot.
        const realDir = join(testDir, "outside", "p-evil");
        const realManifest = await writePluginAt(realDir, "tb.evil");
        // Plant a symlink inside pluginsRoot that points at the real
        // directory. Without realpath defeat, this would naively pass the
        // containment check.
        const linkDir = join(pluginsRoot, "p-evil");
        await symlink(realDir, linkDir, "dir");
        const linkedManifest = join(linkDir, "plugin.json");
        // Sanity check both paths resolve to the same file before runtime.
        expect(realManifest).not.toEqual(linkedManifest);
        await writeRegistry([{ id: "tb.evil", manifestPath: linkedManifest }]);

        const runtime = new PluginRuntime({
          hostRoot,
          registryPath,
          pluginsRoot,
        });
        await runtime.load();
        expect(runtime.listPluginIds()).not.toContain("tb.evil");
      },
    );
  });

  // ───────────────────────────── §Step 2 ─────────────────────────────

  describe("marketplace install receipt integrity", () => {
    it("loads a registry plugin when its install receipt matches installed files", async () => {
      const pluginDir = join(pluginsRoot, "p-receipted");
      const manifestPath = await writePluginAt(pluginDir, "tb.receipted");
      await writeReceipt("tb.receipted", pluginDir);
      await writeRegistry([{ id: "tb.receipted", manifestPath }]);

      const auditCalls: Array<{ level: string; message: string }> = [];
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
        auditLog: (level, message) => auditCalls.push({ level, message }),
      });
      await runtime.load();

      expect(runtime.listPluginIds()).toContain("tb.receipted");
      expect(auditCalls).toContainEqual({ level: "info", message: "plugin_integrity_verified" });
    });

    it("rejects a registry plugin when an installed file differs from its receipt", async () => {
      const pluginDir = join(pluginsRoot, "p-tampered");
      const manifestPath = await writePluginAt(pluginDir, "tb.receipt.tampered");
      await writeReceipt("tb.receipt.tampered", pluginDir);
      await writeFile(join(pluginDir, "entry.mjs"), `${ENTRY_SOURCE}\n// tampered`, "utf-8");
      await writeRegistry([{ id: "tb.receipt.tampered", manifestPath }]);

      const auditCalls: Array<{ level: string; message: string }> = [];
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
        auditLog: (level, message) => auditCalls.push({ level, message }),
      });
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("tb.receipt.tampered");
      expect(auditCalls).toContainEqual({ level: "error", message: "plugin_integrity_rejected" });
    });

    // dev-link receipt skip — bypass MUST be gated on dev mode, not just on
    // the registry flag. Otherwise a malicious actor who can write to
    // registry.json on a packaged install could plant `_devLinked: true`
    // and skip integrity verification entirely.
    describe("dev-link receipt skip is gated on dev mode", () => {
      const savedLvisDev = process.env.LVIS_DEV;
      afterEach(() => {
        _resetForTest();
        if (savedLvisDev === undefined) delete process.env.LVIS_DEV;
        else process.env.LVIS_DEV = savedLvisDev;
      });

      it("dev mode + _devLinked=true → loads without a receipt", async () => {
        process.env.LVIS_DEV = "1";
        setIsPackaged(false);
        const pluginDir = join(pluginsRoot, "p-devlinked");
        const manifestPath = await writePluginAt(pluginDir, "tb.devlinked");
        // No receipt written — the skip path is the only way this can load.
        await writeRegistry([{ id: "tb.devlinked", manifestPath, _devLinked: true }]);

        const runtime = new PluginRuntime({
          hostRoot,
          registryPath,
          pluginsRoot,
          installReceiptCacheRoot: cacheRoot,
        });
        await runtime.load();
        expect(runtime.listPluginIds()).toContain("tb.devlinked");
      });

      it("packaged + _devLinked=true → still rejected without a receipt", async () => {
        delete process.env.LVIS_DEV;
        setIsPackaged(true);
        const pluginDir = join(pluginsRoot, "p-devlinked-packaged");
        const manifestPath = await writePluginAt(pluginDir, "tb.devlinked.packaged");
        await writeRegistry([{ id: "tb.devlinked.packaged", manifestPath, _devLinked: true }]);

        const runtime = new PluginRuntime({
          hostRoot,
          registryPath,
          pluginsRoot,
          installReceiptCacheRoot: cacheRoot,
        });
        await runtime.load();
        expect(runtime.listPluginIds()).not.toContain("tb.devlinked.packaged");
      });
    });
  });

  // ───────────────────────────── §Step 3 ─────────────────────────────

  describe("installedBy authoritative over manifest installPolicy", () => {
    it("rejects user uninstall when registry installedBy=admin even if manifest installPolicy=user (tampered)", async () => {
      // Plugin physically lives under pluginsRoot but the manifest is
      // stamped `installPolicy: "user"` (the tamper). The registry was
      // recorded with installedBy="admin" at install time — that record is
      // authoritative.
      const userDir = join(pluginsRoot, "p-tampered");
      const manifestPath = await writePluginAt(userDir, "tb.tampered", {
        installPolicy: "user",
      });
      await writeRegistry([
        { id: "tb.tampered", manifestPath, installedBy: "admin" },
      ]);

      const guard = new PluginDeploymentGuard({
        registryPath,
        pluginsRoot,
      });
      const result = await guard.canUninstall("tb.tampered", "user");

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/registry installedBy="admin"/);
    });

    it("falls back to manifest installPolicy when registry has no installedBy (legacy data)", async () => {
      // Legacy entry with no `installedBy` recorded — guard must not break;
      // the manifest field is the only signal so it's used.
      const userDir = join(pluginsRoot, "p-legacy");
      const manifestPath = await writePluginAt(userDir, "tb.legacy", {
        installPolicy: "admin",
      });
      await writeRegistry([{ id: "tb.legacy", manifestPath }]);

      const guard = new PluginDeploymentGuard({
        registryPath,
        pluginsRoot,
      });
      const result = await guard.canUninstall("tb.legacy", "user");

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/installPolicy="admin"/);
    });
  });

  // ───────────────────────────── §Step 4 ─────────────────────────────

  describe("dev-flags helpers hard-gate on app.isPackaged", () => {
    // Round-3 cleanup: LVIS_ALLOW_LINKED_PLUGIN_ENTRY and
    // LVIS_ALLOW_TEST_MARKETPLACE_KEYS were removed — LVIS_DEV=1 is the
    // master dev unlock that already subsumed them.
    const ENV_NAMES = [
      "LVIS_DEV",
      "LVIS_DEV_RELOAD",
    ] as const;
    const saved: Partial<Record<string, string | undefined>> = {};

    beforeEach(() => {
      for (const name of ENV_NAMES) saved[name] = process.env[name];
    });

    afterEach(() => {
      _resetForTest();
      for (const name of ENV_NAMES) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });

    it("returns false when isPackaged=true even with every flag set", () => {
      for (const name of ENV_NAMES) process.env[name] = "1";
      setIsPackaged(true);
      expect(isDevModeUnlocked()).toBe(false);
      expect(devLinkedEntryAllowed()).toBe(false);
    });

    it("returns true when isPackaged=false and the matching flag is set", () => {
      // Clear all first so each helper sees only its own flag.
      for (const name of ENV_NAMES) delete process.env[name];
      setIsPackaged(false);
      expect(isDevModeUnlocked()).toBe(false); // no flag set yet
      process.env.LVIS_DEV = "1";
      expect(isDevModeUnlocked()).toBe(true);
      expect(devLinkedEntryAllowed()).toBe(true);
    });

    it("explicit packaged parameter overrides cached state for testability", () => {
      process.env.LVIS_DEV = "1";
      setIsPackaged(false);
      expect(isDevModeUnlocked(false)).toBe(true);
      expect(isDevModeUnlocked(true)).toBe(false);
    });
  });

  // ───────────────────────────── §Step 5: local-dev installSource guard ─────

  describe("local-dev installSource rejected in packaged builds", () => {
    const savedLvisDev = process.env.LVIS_DEV;
    beforeEach(() => {
      _resetForTest();
    });
    afterEach(() => {
      _resetForTest();
      if (savedLvisDev === undefined) delete process.env.LVIS_DEV;
      else process.env.LVIS_DEV = savedLvisDev;
    });

    it("packaged build + v2 local-dev receipt → plugin marked failed", async () => {
      delete process.env.LVIS_DEV;
      setIsPackaged(true);
      const pluginDir = join(pluginsRoot, "p-dev-signer");
      const manifestPath = await writePluginAt(pluginDir, "tb.dev-signer");

      const devReceipt: PluginInstallReceipt = {
        schemaVersion: 2,
        pluginId: "tb.dev-signer",
        version: "1.0.0",
        installSource: "local-dev",
        artifactSha256: null,
        signerKeyId: null,
        installedAt: new Date(0).toISOString(),
        files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
      };
      await writeInstallReceipt(cacheRoot, devReceipt);
      await writeRegistry([{ id: "tb.dev-signer", manifestPath, installedBy: "user" }]);

      const auditCalls: Array<{ level: string; message: string; extras?: Record<string, unknown> }> = [];
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
        auditLog: (level, message, extras) => auditCalls.push({ level, message, extras }),
      });
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("tb.dev-signer");
      expect(auditCalls).toContainEqual(
        expect.objectContaining({ level: "error", message: "plugin_integrity_rejected" }),
      );
    });

    it("packaged build + v1 dev: sentinel receipt → normalised to local-dev → rejected", async () => {
      // v1 receipts with signerKeyId starting with "dev:" are normalised to
      // installSource:"local-dev" for backward compat with old installLocal.
      delete process.env.LVIS_DEV;
      setIsPackaged(true);
      const pluginDir = join(pluginsRoot, "p-v1-dev-signer");
      const manifestPath = await writePluginAt(pluginDir, "tb.v1-dev-signer");

      // Write a raw v1 JSON receipt (bypassing writeInstallReceipt which would upgrade)
      const v1Receipt = {
        schemaVersion: 1,
        pluginId: "tb.v1-dev-signer",
        version: "1.0.0",
        artifactSha256: "dev:local-install",
        signerKeyId: "dev:local-install",
        installedAt: new Date(0).toISOString(),
        files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
      };
      const { writeFile: wf, mkdir: mk } = await import("node:fs/promises");
      const { resolve: res } = await import("node:path");
      const receiptPath = res(cacheRoot, "tb.v1-dev-signer", "install-receipt.json");
      await mk(res(cacheRoot, "tb.v1-dev-signer"), { recursive: true });
      await wf(receiptPath, `${JSON.stringify(v1Receipt, null, 2)}\n`, "utf-8");

      await writeRegistry([{ id: "tb.v1-dev-signer", manifestPath, installedBy: "user" }]);
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).not.toContain("tb.v1-dev-signer");
    });

    it("unpackaged build + local-dev receipt → plugin loads normally", async () => {
      process.env.LVIS_DEV = "1";
      setIsPackaged(false);
      const pluginDir = join(pluginsRoot, "p-dev-signer-unpkg");
      const manifestPath = await writePluginAt(pluginDir, "tb.dev-signer-unpkg");

      const devReceipt: PluginInstallReceipt = {
        schemaVersion: 2,
        pluginId: "tb.dev-signer-unpkg",
        version: "1.0.0",
        installSource: "local-dev",
        artifactSha256: null,
        signerKeyId: null,
        installedAt: new Date(0).toISOString(),
        files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
      };
      await writeInstallReceipt(cacheRoot, devReceipt);
      await writeRegistry([{ id: "tb.dev-signer-unpkg", manifestPath, installedBy: "user" }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
      });
      await runtime.load();

      expect(runtime.listPluginIds()).toContain("tb.dev-signer-unpkg");
    });

    it("packaged build + local-dev receipt via restartPlugin → rejected", async () => {
      process.env.LVIS_DEV = "1";
      setIsPackaged(false);
      const pluginDir = join(pluginsRoot, "p-restart-dev-signer");
      const manifestPath = await writePluginAt(pluginDir, "tb.restart-dev-signer");

      const devReceipt: PluginInstallReceipt = {
        schemaVersion: 2,
        pluginId: "tb.restart-dev-signer",
        version: "1.0.0",
        installSource: "local-dev",
        artifactSha256: null,
        signerKeyId: null,
        installedAt: new Date(0).toISOString(),
        files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
      };
      await writeInstallReceipt(cacheRoot, devReceipt);
      await writeRegistry([{ id: "tb.restart-dev-signer", manifestPath, installedBy: "user" }]);

      // Load successfully in dev mode
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).toContain("tb.restart-dev-signer");

      // Switch to packaged mode — restart should now reject
      delete process.env.LVIS_DEV;
      setIsPackaged(true);
      const auditCalls: Array<{ level: string; message: string }> = [];
      (runtime as unknown as { auditLog?: (level: string, msg: string) => void }).auditLog =
        (level, message) => auditCalls.push({ level, message });

      await runtime.restartPlugin("tb.restart-dev-signer");
      expect(runtime.listPluginIds()).not.toContain("tb.restart-dev-signer");
      expect(auditCalls).toContainEqual(
        expect.objectContaining({ level: "error", message: "plugin_integrity_rejected" }),
      );
    });
  });
});
