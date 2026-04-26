/**
 * uiCallable security model — subset + runtime scope enforcement.
 *
 * The runtime no longer blocks verbs by suffix. Instead:
 *   1. uiCallable ⊆ tools[] is enforced at manifest load time. Any entry not
 *      declared in tools[] fails the load.
 *   2. callFromUi() re-checks the method is declared in that plugin's
 *      uiCallable at invocation time (defense in depth against stale maps).
 *
 * Security properties come from:
 *   - code review of the plugin source,
 *   - marketplace approval before publish,
 *   - signature verification at load (PluginSignatureVerifier),
 * NOT from naming conventions. Any suffix (_delete, _remove, _send, _reply,
 * _create, _update, …) is permitted regardless of install policy. The
 * plugin developer is responsible for destructive-action confirmation UX in
 * their own renderer surface — see `index_remove_folder` which ships this way
 * today (note: `email_reply` is in tools[] only, not uiCallable[]).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PluginRuntime } from "../runtime.js";
import type { PluginSignatureVerifier } from "../signature-verifier.js";

// ESM compatibility: `__dirname` is not defined under NodeNext/ESM. Derive it
// from `import.meta.url` so this suite runs under both vitest's CJS shim and
// a future pure-ESM runner.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const installedRoot = resolve(__dirname, "..", "..", "..", "plugins", "installed");

function listInstalledManifests(): Array<{ id: string; path: string; manifest: Record<string, unknown> }> {
  if (!existsSync(installedRoot)) return [];
  const entries = readdirSync(installedRoot);
  const manifests: Array<{ id: string; path: string; manifest: Record<string, unknown> }> = [];
  for (const entry of entries) {
    const dir = join(installedRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    manifests.push({ id: entry, path: manifestPath, manifest });
  }
  return manifests;
}

async function writeTempPlugin(opts: {
  installPolicy: "admin" | "user";
  tools: string[];
  uiCallable: string[];
}): Promise<string> {
  const root = mkdtempSync(join(homedir(), ".lvis", "test-tmp", "lvis-uicallable-"));
  const manifest = {
    id: `com.lge.test-${Math.random().toString(36).slice(2, 8)}`,
    name: "uiCallable Test",
    version: "1.0.0",
    entry: "dist/index.js",
    tools: opts.tools,
    uiCallable: opts.uiCallable,
    installPolicy: opts.installPolicy,
  };
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest, null, 2));
  return join(root, "plugin.json");
}

// Mock signature verifier used as runtime test scaffolding. This suite
// validates manifest parsing/subset checks and does not itself exercise the
// signature-verification path (that requires `load()`).
const mockVerifier = {
  verifyManifestFile: async () => ({ valid: true, sha256: "x" }),
} as unknown as PluginSignatureVerifier;

// Previously rejected on user plugins; must now be accepted on every
// install policy so plugin authors can own their confirmation UX.
const PREVIOUSLY_BLOCKED_VERBS = [
  "thing_delete",
  "thing_remove",
  "thing_send",
  "thing_destroy",
  "thing_erase",
  "thing_purge",
  "thing_reply",
  "thing_create",
  "thing_update",
  "thing_drop",
  "thing_wipe",
  "thing_reset",
  "thing_revoke",
  "thing_clear",
  "thing_archive",
  "thing_truncate",
];

describe("uiCallable subset validation", () => {
  it("rejects manifest whose uiCallable entry is not in tools[]", async () => {
    const manifestPath = await writeTempPlugin({
      installPolicy: "user",
      tools: ["foo_get"],
      uiCallable: ["foo_get", "foo_missing"],
    });
    const rt = new PluginRuntime({
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [manifestPath],
    });
    const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
    await expect(parse(manifestPath)).rejects.toThrow(/uiCallable\[1\].*not declared in tools/);
  });

  it("rejects non-string uiCallable entries", async () => {
    const manifestPath = await writeTempPlugin({
      installPolicy: "user",
      tools: ["foo_get"],
      uiCallable: [123 as unknown as string],
    });
    const rt = new PluginRuntime({
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [manifestPath],
    });
    const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
    await expect(parse(manifestPath)).rejects.toThrow(/uiCallable/);
  });

  it("accepts when every uiCallable entry is declared in tools[]", async () => {
    const manifestPath = await writeTempPlugin({
      installPolicy: "user",
      tools: ["foo_get", "foo_list"],
      uiCallable: ["foo_get", "foo_list"],
    });
    const rt = new PluginRuntime({
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [manifestPath],
    });
    const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
    await expect(parse(manifestPath)).resolves.toBeDefined();
  });
});

describe("uiCallable accepts any suffix regardless of install policy", () => {
  for (const verb of PREVIOUSLY_BLOCKED_VERBS) {
    it(`[user] accepts '${verb}' when it is in tools[]`, async () => {
      const manifestPath = await writeTempPlugin({
        installPolicy: "user",
        tools: [verb],
        uiCallable: [verb],
      });
      const rt = new PluginRuntime({
        hostRoot: resolve(__dirname, "..", "..", ".."),
        manifestPaths: [manifestPath],
      });
      const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
      await expect(parse(manifestPath)).resolves.toBeDefined();
    });

    it(`[admin] accepts '${verb}' when it is in tools[]`, async () => {
      const manifestPath = await writeTempPlugin({
        installPolicy: "admin",
        tools: [verb],
        uiCallable: [verb],
      });
      const rt = new PluginRuntime({
        hostRoot: resolve(__dirname, "..", "..", ".."),
        manifestPaths: [manifestPath],
        signatureVerifier: mockVerifier,
      });
      const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
      await expect(parse(manifestPath)).resolves.toBeDefined();
    });
  }
});

describe("callFromUi scope enforcement", () => {
  it("throws when method is unknown", async () => {
    const rt = new PluginRuntime({
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [],
    });
    await expect(rt.callFromUi("nonexistent_method")).rejects.toThrow(/not found/);
  });

  it("throws when method is declared in tools[] but missing from uiCallable[]", async () => {
    // Build a runtime with a hand-crafted plugin map so we can exercise
    // callFromUi without spinning up a real plugin entry file.
    const rt = new PluginRuntime({
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [],
    });
    const internals = rt as unknown as {
      plugins: Map<string, { manifest: { uiCallable: string[] } }>;
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    internals.plugins.set("test.plugin", {
      manifest: { uiCallable: ["foo_get"] },
    } as unknown as never);
    internals.methodMap.set("foo_delete", {
      pluginId: "test.plugin",
      handler: async () => "should-never-run",
    });
    internals.methodMap.set("foo_get", {
      pluginId: "test.plugin",
      handler: async () => "ok",
    });

    await expect(rt.callFromUi("foo_delete")).rejects.toThrow(/not UI-callable/);
    await expect(rt.callFromUi("foo_get")).resolves.toBe("ok");
  });
});

describe.skip("installed manifests: uiCallable ⊂ tools (Phase 2-final: scan moved to marketplace server)", () => {
  // Phase 2-final removed `<appRoot>/plugins/installed/`. Static manifest
  // scanning lives in the lvis-marketplace publish-time validator now.
  // This block is kept skipped (not deleted) so the test data structure
  // stays available if/when an in-app userData scan is wired up.
  const manifests = listInstalledManifests();

  it("discovers at least one installed manifest", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  for (const { id, path, manifest } of manifests) {
    it(`[${id}] every uiCallable entry is declared in tools[]`, () => {
      const uiCallable = Array.isArray(manifest.uiCallable) ? (manifest.uiCallable as unknown[]) : [];
      const tools = Array.isArray(manifest.tools) ? (manifest.tools as unknown[]) : [];
      const toolSet = new Set(tools.filter((t): t is string => typeof t === "string"));
      const offenders = uiCallable.filter(
        (name): name is string => typeof name === "string" && !toolSet.has(name),
      );
      expect(
        offenders,
        `manifest ${path} exposes uiCallable entries not in tools[]: ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  }
});
