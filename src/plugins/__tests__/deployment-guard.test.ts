import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginDeploymentGuard } from "../deployment-guard.js";

/**
 * Phase 1.5 test gate — PluginDeploymentGuard §7.2-§7.3
 *
 * Guard는 default-deny 정책: userInstalledDir 하위에 있는 플러그인만 "user"로 간주.
 * 그 외는 모두 "managed"로 간주하여 user actor의 제거/비활성화를 거부.
 */
describe("PluginDeploymentGuard", () => {
  let testDir: string;
  let registryPath: string;
  let installedDir: string;

  beforeEach(async () => {
    testDir = join(homedir(), ".lvis", "test-tmp", `lvis-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    registryPath = join(testDir, "registry.json");
    installedDir = join(testDir, "installed");
    await mkdir(installedDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeRegistry(entries: Array<{ id: string; manifestPath: string; enabled?: boolean }>) {
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: entries }), "utf-8");
  }

  it("rejects user uninstalling a managed plugin (outside installedDir)", async () => {
    const managedRoot = join(testDir, "bundle-root");
    await mkdir(join(managedRoot, "p-managed"), { recursive: true });
    const pluginManifest = join(managedRoot, "p-managed", "plugin.json");
    await writeFile(pluginManifest, "{}", "utf-8");
    await writeRegistry([{ id: "p-managed", manifestPath: pluginManifest }]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canUninstall("p-managed", "user");

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Managed plugin/);
  });

  it("allows user uninstalling a user-installed plugin (inside installedDir)", async () => {
    const userDir = join(installedDir, "p-user");
    await mkdir(userDir, { recursive: true });
    const manifestPath = join(userDir, "plugin.json");
    await writeFile(manifestPath, "{}", "utf-8");
    await writeRegistry([{ id: "p-user", manifestPath }]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canUninstall("p-user", "user");

    expect(result.allowed).toBe(true);
  });

  it("always allows it-admin actor (trust boundary bypass)", async () => {
    const managedRoot = join(testDir, "bundle-root");
    await mkdir(join(managedRoot, "p-managed"), { recursive: true });
    const pluginManifest = join(managedRoot, "p-managed", "plugin.json");
    await writeFile(pluginManifest, "{}", "utf-8");
    await writeRegistry([{ id: "p-managed", manifestPath: pluginManifest }]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canUninstall("p-managed", "it-admin");

    expect(result.allowed).toBe(true);
  });

  it("rejects unknown pluginId with 'not found' reason", async () => {
    await writeRegistry([]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canUninstall("missing", "user");

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it("SECURITY_GATE: prefix confusion — installed-foo/ is NOT under installed/", async () => {
    const spoofDir = join(testDir, "installed-foo");
    await mkdir(spoofDir, { recursive: true });
    const manifestPath = join(spoofDir, "plugin.json");
    await writeFile(manifestPath, "{}", "utf-8");
    await writeRegistry([{ id: "spoof", manifestPath }]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canUninstall("spoof", "user");

    // 'installed-foo'는 'installed/'의 prefix confusion. relative()가 '..'로 시작하는 값을
    // 반환하므로 installedDir 하위가 아님 → managed로 판정 → 거부 (default-deny).
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Managed plugin/);
  });

  it("SECURITY_GATE: registry entry with relative path escaping installedDir → managed", async () => {
    const escapeDir = join(testDir, "elsewhere");
    await mkdir(escapeDir, { recursive: true });
    const escapeManifest = join(escapeDir, "plugin.json");
    await writeFile(escapeManifest, "{}", "utf-8");
    // relative manifestPath가 registry dirname 기준으로 resolve되어 installedDir 밖으로 탈출.
    await writeRegistry([{ id: "escape", manifestPath: "elsewhere/plugin.json" }]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canUninstall("escape", "user");

    // default-deny: installedDir 밖에 있으므로 managed로 처리 → user actor 거부.
    expect(result.allowed).toBe(false);
  });

  it("rejects managed plugin inside installedDir via manifest deployment field", async () => {
    const userDir = join(installedDir, "p-managed-inside");
    await mkdir(userDir, { recursive: true });
    const manifestPath = join(userDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ id: "p-managed-inside", deployment: "managed" }),
      "utf-8",
    );
    await writeRegistry([{ id: "p-managed-inside", manifestPath }]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canUninstall("p-managed-inside", "user");

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/installPolicy="admin"|deployment="managed"/);
  });

  it("allows user plugin inside installedDir with explicit deployment: user", async () => {
    const userDir = join(installedDir, "p-user-explicit");
    await mkdir(userDir, { recursive: true });
    const manifestPath = join(userDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ id: "p-user-explicit", deployment: "user" }),
      "utf-8",
    );
    await writeRegistry([{ id: "p-user-explicit", manifestPath }]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canUninstall("p-user-explicit", "user");

    expect(result.allowed).toBe(true);
  });

  it("BACKCOMPAT: absent deployment field in legacy manifest → allowed for user", async () => {
    const userDir = join(installedDir, "p-legacy");
    await mkdir(userDir, { recursive: true });
    const manifestPath = join(userDir, "plugin.json");
    // legacy manifest without deployment field (predates Phase 1.5)
    await writeFile(
      manifestPath,
      JSON.stringify({ id: "p-legacy", name: "Legacy", version: "0.9.0" }),
      "utf-8",
    );
    await writeRegistry([{ id: "p-legacy", manifestPath }]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canUninstall("p-legacy", "user");

    expect(result.allowed).toBe(true);
  });

  it("canInstall: rejects user installing a managed catalog item", async () => {
    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canInstall("p-managed", "user", "managed");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/installed by user/);
  });

  it("canInstall: allows user installing a non-managed catalog item", async () => {
    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canInstall("p-user", "user", "user");
    expect(result.allowed).toBe(true);
  });

  it("canInstall: allows user installing when deployment field is absent (backward compat)", async () => {
    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canInstall("p-legacy", "user", undefined);
    expect(result.allowed).toBe(true);
  });

  it("canInstall: always allows it-admin actor (trust boundary bypass)", async () => {
    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const result = await guard.canInstall("p-managed", "it-admin", "managed");
    expect(result.allowed).toBe(true);
  });

  it("canDisable mirrors canUninstall semantics", async () => {
    const managedRoot = join(testDir, "bundle-root");
    await mkdir(join(managedRoot, "p-managed"), { recursive: true });
    const pluginManifest = join(managedRoot, "p-managed", "plugin.json");
    await writeFile(pluginManifest, "{}", "utf-8");
    await writeRegistry([{ id: "p-managed", manifestPath: pluginManifest }]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const uninstall = await guard.canUninstall("p-managed", "user");
    const disable = await guard.canDisable("p-managed", "user");

    expect(uninstall.allowed).toBe(disable.allowed);
    expect(uninstall.allowed).toBe(false);
  });
});
