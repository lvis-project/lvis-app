/**
 * Phase 1 — Plugin trust-boundary hardening tests.
 *
 * Covers four orthogonal hardening fixes:
 *
 *   1. (CRITICAL §Step 1) `isTrustedRegistryManifestPath` accepts BOTH
 *      hostRoot and userInstalledDir; rejects symlink escape.
 *   2. (HIGH §Step 2) Unsigned user plugins are fail-closed by default;
 *      `allowUnsignedUserPlugins=true` opt-in restores legacy behaviour.
 *   3. (HIGH §Step 3) `installedBy` recorded on the registry entry is
 *      authoritative; manifest `installPolicy` is advisory only.
 *   4. (MEDIUM §Step 4) `dev-flags.ts` helpers hard-gate on `app.isPackaged`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { PluginRuntime } from "../runtime.js";
import { PluginSignatureVerifier } from "../signature-verifier.js";
import { PluginDeploymentGuard } from "../deployment-guard.js";
import {
  _resetForTest,
  devLinkedEntryAllowed,
  devSkipSignature,
  isDevModeUnlocked,
  setIsPackaged,
  testMarketplaceKeysAllowed,
} from "../../boot/dev-flags.js";

const ENTRY_SOURCE = `export default async function createPlugin(ctx) {
  return { handlers: { tb_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`;

interface AuditCall {
  level: "info" | "warn" | "error";
  message: string;
  data?: unknown;
}

function makeAuditSink(): { calls: AuditCall[]; log: (l: "info" | "warn" | "error", m: string, d?: unknown) => void } {
  const calls: AuditCall[] = [];
  return {
    calls,
    log: (level, message, data) => calls.push({ level, message, data }),
  };
}

describe("Phase 1 — plugin trust boundary", () => {
  let testDir: string;
  let hostRoot: string;
  let userInstalledDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = join(
      homedir(),
      ".lvis",
      "test-tmp",
      `lvis-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    hostRoot = join(testDir, "host");
    userInstalledDir = join(testDir, "userInstalled");
    await mkdir(join(hostRoot, "plugins"), { recursive: true });
    await mkdir(userInstalledDir, { recursive: true });
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
      entry: "entry.mjs",
      tools: ["tb_ping"],
    };
    if (opts?.installPolicy) manifest.installPolicy = opts.installPolicy;
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    return manifestPath;
  }

  async function writeRegistry(
    entries: Array<{ id: string; manifestPath: string; installedBy?: "admin" | "user" }>,
  ): Promise<void> {
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: entries }), "utf-8");
  }

  // ───────────────────────────── §Step 1 ─────────────────────────────

  describe("isTrustedRegistryManifestPath dual-root containment", () => {
    it("accepts a registry manifest path under hostRoot", async () => {
      const manifestPath = await writePluginAt(
        join(hostRoot, "plugins", "installed", "p-host"),
        "tb.host",
      );
      await writeRegistry([{ id: "tb.host", manifestPath }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        userInstalledDir,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).toContain("tb.host");
    });

    it("accepts a registry manifest path under userInstalledDir (outside hostRoot)", async () => {
      const manifestPath = await writePluginAt(
        join(userInstalledDir, "p-user"),
        "tb.user",
      );
      await writeRegistry([{ id: "tb.user", manifestPath }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        userInstalledDir,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).toContain("tb.user");
    });

    it("rejects a registry manifest path outside both hostRoot and userInstalledDir", async () => {
      const manifestPath = await writePluginAt(
        join(testDir, "rogue", "p-rogue"),
        "tb.rogue",
      );
      await writeRegistry([{ id: "tb.rogue", manifestPath }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        userInstalledDir,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).not.toContain("tb.rogue");
    });

    // Symlink creation on Windows requires admin or developer mode. Skip
    // there — the other branches still exercise the realpath containment
    // check via a real on-disk path.
    const symlinkSkip = process.platform === "win32";
    it.skipIf(symlinkSkip)(
      "rejects a symlink under userInstalledDir that points outside both trust roots",
      async () => {
        // Real plugin lives at testDir/outside/p-evil/plugin.json — outside
        // both hostRoot and userInstalledDir.
        const realDir = join(testDir, "outside", "p-evil");
        const realManifest = await writePluginAt(realDir, "tb.evil");
        // Plant a symlink inside userInstalledDir that points at the real
        // directory. Without realpath defeat, this would naively pass the
        // containment check.
        const linkDir = join(userInstalledDir, "p-evil");
        await symlink(realDir, linkDir, "dir");
        const linkedManifest = join(linkDir, "plugin.json");
        // Sanity check both paths resolve to the same file before runtime.
        expect(realManifest).not.toEqual(linkedManifest);
        await writeRegistry([{ id: "tb.evil", manifestPath: linkedManifest }]);

        const runtime = new PluginRuntime({
          hostRoot,
          registryPath,
          userInstalledDir,
        });
        await runtime.load();
        expect(runtime.listPluginIds()).not.toContain("tb.evil");
      },
    );
  });

  // ───────────────────────────── §Step 2 ─────────────────────────────

  describe("unsigned user plugin fail-closed (allowUnsignedUserPlugins)", () => {
    let publicKeyPem: string;

    beforeEach(() => {
      const keypair = generateKeyPairSync("ed25519");
      publicKeyPem = keypair.publicKey.export({ type: "spki", format: "pem" }).toString();
    });

    it("rejects an unsigned user plugin by default and emits plugin_unsigned_user_rejected", async () => {
      const manifestPath = await writePluginAt(
        join(userInstalledDir, "p-unsigned"),
        "tb.unsigned",
        { installPolicy: "user" },
      );
      await writeRegistry([{ id: "tb.unsigned", manifestPath }]);

      const audit = makeAuditSink();
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        userInstalledDir,
        signatureVerifier: new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] }),
        auditLog: audit.log,
      });
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("tb.unsigned");
      // Audit level is `error` for parity with `plugin_signature_rejected` —
      // both signal "plugin failed the signature gate", and a warn for one
      // and error for the other obscures forensics.
      expect(
        audit.calls.some(
          (c) => c.level === "error" && c.message === "plugin_unsigned_user_rejected",
        ),
      ).toBe(true);
    });

    it("loads an unsigned user plugin when allowUnsignedUserPlugins=true and emits plugin_unsigned_user_loaded_with_optin", async () => {
      const manifestPath = await writePluginAt(
        join(userInstalledDir, "p-unsigned-optin"),
        "tb.unsigned.optin",
        { installPolicy: "user" },
      );
      await writeRegistry([{ id: "tb.unsigned.optin", manifestPath }]);

      const audit = makeAuditSink();
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        userInstalledDir,
        allowUnsignedUserPlugins: true,
        signatureVerifier: new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] }),
        auditLog: audit.log,
      });
      await runtime.load();

      expect(runtime.listPluginIds()).toContain("tb.unsigned.optin");
      expect(
        audit.calls.some(
          (c) => c.level === "warn" && c.message === "plugin_unsigned_user_loaded_with_optin",
        ),
      ).toBe(true);
    });
  });

  // ───────────────────────────── §Step 3 ─────────────────────────────

  describe("installedBy authoritative over manifest installPolicy", () => {
    it("rejects user uninstall when registry installedBy=admin even if manifest installPolicy=user (tampered)", async () => {
      // Plugin physically lives under userInstalledDir but the manifest is
      // stamped `installPolicy: "user"` (the tamper). The registry was
      // recorded with installedBy="admin" at install time — that record is
      // authoritative.
      const userDir = join(userInstalledDir, "p-tampered");
      const manifestPath = await writePluginAt(userDir, "tb.tampered", {
        installPolicy: "user",
      });
      await writeRegistry([
        { id: "tb.tampered", manifestPath, installedBy: "admin" },
      ]);

      const guard = new PluginDeploymentGuard({
        registryPath,
        userInstalledDir,
      });
      const result = await guard.canUninstall("tb.tampered", "user");

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/registry installedBy="admin"/);
    });

    it("falls back to manifest installPolicy when registry has no installedBy (legacy data)", async () => {
      // Legacy entry with no `installedBy` recorded — guard must not break;
      // the manifest field is the only signal so it's used.
      const userDir = join(userInstalledDir, "p-legacy");
      const manifestPath = await writePluginAt(userDir, "tb.legacy", {
        installPolicy: "admin",
      });
      await writeRegistry([{ id: "tb.legacy", manifestPath }]);

      const guard = new PluginDeploymentGuard({
        registryPath,
        userInstalledDir,
      });
      const result = await guard.canUninstall("tb.legacy", "user");

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/installPolicy="admin"/);
    });
  });

  // ───────────────────────────── §Step 4 ─────────────────────────────

  describe("dev-flags helpers hard-gate on app.isPackaged", () => {
    const ENV_NAMES = [
      "LVIS_DEV",
      "LVIS_ALLOW_LINKED_PLUGIN_ENTRY",
      "LVIS_ALLOW_TEST_MARKETPLACE_KEYS",
      "LVIS_DEV_SKIP_SIG",
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
      expect(testMarketplaceKeysAllowed()).toBe(false);
      expect(devSkipSignature()).toBe(false);
    });

    it("returns true when isPackaged=false and the matching flag is set", () => {
      // Clear all first so each helper sees only its own flag.
      for (const name of ENV_NAMES) delete process.env[name];
      setIsPackaged(false);
      expect(isDevModeUnlocked()).toBe(false); // no flag set yet
      process.env.LVIS_DEV = "1";
      expect(isDevModeUnlocked()).toBe(true);
      expect(devLinkedEntryAllowed()).toBe(true);
      expect(testMarketplaceKeysAllowed()).toBe(true);
      delete process.env.LVIS_DEV;
      process.env.LVIS_DEV_SKIP_SIG = "1";
      expect(devSkipSignature()).toBe(true);
    });

    it("explicit packaged parameter overrides cached state for testability", () => {
      process.env.LVIS_DEV = "1";
      setIsPackaged(false);
      expect(isDevModeUnlocked(false)).toBe(true);
      expect(isDevModeUnlocked(true)).toBe(false);
    });
  });
});
