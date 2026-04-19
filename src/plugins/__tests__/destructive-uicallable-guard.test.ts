/**
 * Regression guard: ensure no installed plugin manifest exposes a destructive
 * tool name via `uiCallable[]`. uiCallable tools bypass the chat approval gate,
 * so anything matching the destructive blocklist below would allow the renderer
 * to trigger an irreversible action (delete, remove, send, destroy, erase,
 * purge, reply, create, update) without user confirmation.
 *
 * Context:
 *  - PR #57 claimed to remove `email_reply`, `calendar_delete`,
 *    `calendar_create`, `calendar_update` from uiCallable — but audit on
 *    2026-04-18 showed `email_reply` and `calendar_delete` still present.
 *  - This test exists so that regression never happens silently again.
 *
 * Pre-GA hardening (M1): the runtime gate flipped from blocklist to
 * allowlist. Read-like verbs (_get/_list/_search/_read/_show/_query/_preview/
 * _count/_status/_find/_describe/_inspect) may be uiCallable on user
 * plugins; everything else requires deployment=managed + signatureVerifier
 * present. We now assert both directions: (a) newly-blocked verbs fail on
 * user plugins, (b) they pass on managed+signed plugins.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PluginRuntime } from "../runtime.js";
import type { PluginSignatureVerifier } from "../signature-verifier.js";

const DESTRUCTIVE_SUFFIX = /_(delete|remove|send|destroy|erase|purge|reply|create|update)$/i;

// ESM compatibility: `__dirname` is not defined under NodeNext/ESM. Derive it
// from `import.meta.url` so this suite runs under both vitest's CJS shim and
// a future pure-ESM runner. (Audit finding: CRITICAL+.)
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

describe("destructive uiCallable guard (installed manifests)", () => {
  const manifests = listInstalledManifests();

  it("discovers at least one installed manifest", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  for (const { id, path, manifest } of manifests) {
    it(`[${id}] uiCallable does not expose destructive tool names`, () => {
      const uiCallable = Array.isArray(manifest.uiCallable) ? (manifest.uiCallable as unknown[]) : [];
      const offenders = uiCallable.filter(
        (name): name is string => typeof name === "string" && DESTRUCTIVE_SUFFIX.test(name),
      );
      expect(
        offenders,
        `manifest ${path} exposes destructive tool(s) via uiCallable: ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  }
});

/**
 * M1 inverted allowlist — the runtime now rejects any uiCallable entry that
 * does not end in a read-like verb unless the plugin is managed + signed.
 * These unit tests exercise the new verbs (drop/wipe/reset/revoke/clear/
 * archive/truncate/disable/uninstall/publish/write/update/set/overwrite)
 * in both directions.
 */
const NEWLY_BLOCKED_VERBS = [
  "thing_drop",
  "thing_wipe",
  "thing_reset",
  "thing_revoke",
  "thing_clear",
  "thing_archive",
  "thing_truncate",
  "thing_disable",
  "thing_uninstall",
  "thing_publish",
  "thing_write",
  "thing_update",
  "thing_set",
  "thing_overwrite",
];

async function writeTempPlugin(opts: {
  deployment: "managed" | "user";
  tools: string[];
  uiCallable: string[];
}): Promise<string> {
  const root = mkdtempSync(join(homedir(), ".lvis", "test-tmp", "lvis-m1-"));
  const manifest = {
    id: `com.lge.test-${Math.random().toString(36).slice(2, 8)}`,
    name: "M1 Test",
    version: "1.0.0",
    entry: "dist/index.js",
    tools: opts.tools,
    uiCallable: opts.uiCallable,
    deployment: opts.deployment,
  };
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest, null, 2));
  return join(root, "plugin.json");
}

// Mock signature verifier that treats every manifest as valid — we only want
// to prove the "managed + verifier present" branch takes effect; the actual
// crypto check is exercised elsewhere.
const mockVerifier = {
  verifyManifestFile: async () => ({ valid: true, sha256: "x" }),
} as unknown as PluginSignatureVerifier;

describe("M1 uiCallable allowlist (runtime enforcement)", () => {
  it("read-like verbs are allowed on user plugins", async () => {
    const manifestPath = await writeTempPlugin({
      deployment: "user",
      tools: ["foo_get", "foo_list", "foo_search", "foo_read", "foo_show", "foo_query",
              "foo_preview", "foo_count", "foo_status", "foo_find", "foo_describe", "foo_inspect"],
      uiCallable: ["foo_get", "foo_list", "foo_search", "foo_read", "foo_show", "foo_query",
                   "foo_preview", "foo_count", "foo_status", "foo_find", "foo_describe", "foo_inspect"],
    });
    const rt = new PluginRuntime({
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [manifestPath],
    });
    // readManifest is private; exercise it via the public resolveManifestPaths
    // path by invoking the internal method reflectively.
    const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
    await expect(parse(manifestPath)).resolves.toBeDefined();
  });

  for (const verb of NEWLY_BLOCKED_VERBS) {
    it(`[user] rejects uiCallable '${verb}' without managed+signed`, async () => {
      const manifestPath = await writeTempPlugin({
        deployment: "user",
        tools: [verb],
        uiCallable: [verb],
      });
      const rt = new PluginRuntime({
        hostRoot: resolve(__dirname, "..", "..", ".."),
        manifestPaths: [manifestPath],
      });
      const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
      await expect(parse(manifestPath)).rejects.toThrow(/uiCallable/);
    });

    it(`[managed+signed] accepts uiCallable '${verb}'`, async () => {
      const manifestPath = await writeTempPlugin({
        deployment: "managed",
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
