/**
 * PR #182 — dev-mode sibling-repo entry resolution.
 *
 * `resolveDevLinkedPackageEntry` is private; we exercise it through the
 * public load() flow, which calls `resolveEntryPath` when `LVIS_DEV=1`
 * and the manifest `entry` is a relative path targeting
 * `node_modules/@lvis/plugin-*`.
 *
 * Asserted behavior:
 *   1. Normal POSIX path matches the `@lvis/plugin-*` pattern and
 *      resolves to the sibling `lvis-<pkg>` checkout.
 *   2. A Windows-style path with backslashes is normalized to forward
 *      slashes before the regex match (so dev on Windows works).
 *   3. Non-plugin packages (e.g. `@lvis/some-other-package`) do NOT
 *      trigger sibling resolution, so load fails when the relative
 *      entry has no file.
 *   4. When the sibling-repo checkout is missing, the resolver returns
 *      undefined and load fails (does not silently import a stale path).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";

describe("PluginRuntime — resolveDevLinkedPackageEntry (via resolveEntryPath)", () => {
  let testDir: string;
  /** hostRoot is one level below testDir so that `resolve(hostRoot, "..")`
   *  lands inside testDir, keeping the sibling-repo tree contained. */
  let hostRoot: string;
  let installedDir: string;
  let registryPath: string;
  let prevDev: string | undefined;

  beforeEach(async () => {
    testDir = join(
      homedir(),
      ".lvis",
      "test-tmp",
      `lvis-dev-linked-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    hostRoot = join(testDir, "host");
    installedDir = join(hostRoot, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(hostRoot, "plugins", "registry.json");

    prevDev = process.env.LVIS_DEV;
    process.env.LVIS_DEV = "1";
  });

  afterEach(async () => {
    if (prevDev === undefined) delete process.env.LVIS_DEV;
    else process.env.LVIS_DEV = prevDev;
    await rm(testDir, { recursive: true, force: true });
  });

  /** Minimal valid ESM plugin entry — exports a `createPlugin` default. */
  async function writeSiblingEntry(packageName: string, subpath: string): Promise<void> {
    const filePath = join(testDir, `lvis-${packageName}`, subpath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(
      filePath,
      `export default async function createPlugin(ctx) {
  return { handlers: { p_dev_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
  }

  async function writeManifestAndRegistry(id: string, entry: string): Promise<void> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      entry,
      tools: ["p_dev_ping"],
    };
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(manifest), "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id, manifestPath: join(pluginDir, "plugin.json") }],
      }),
      "utf-8",
    );
  }

  function makeRuntime(): PluginRuntime {
    return new PluginRuntime({ hostRoot, registryPath });
  }

  it("resolves a POSIX path ../../../node_modules/@lvis/plugin-*/… to the sibling repo", async () => {
    await writeSiblingEntry("plugin-meeting", "dist/hostPlugin.mjs");
    await writeManifestAndRegistry(
      "p_dev_posix",
      "../../../node_modules/@lvis/plugin-meeting/dist/hostPlugin.mjs",
    );

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p_dev_posix");
  });

  it("normalizes a Windows-style path with backslashes before regex matching", async () => {
    await writeSiblingEntry("plugin-meeting", "dist/hostPlugin.mjs");
    // Literal backslashes — on POSIX this string, passed to resolve(), does
    // NOT produce an existing file, so the fallback must kick in and match
    // the normalized forward-slash form.
    await writeManifestAndRegistry(
      "p_dev_win",
      "..\\..\\..\\node_modules\\@lvis\\plugin-meeting\\dist\\hostPlugin.mjs",
    );

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p_dev_win");
  });

  it("returns undefined for non-@lvis/plugin-* packages (load fails)", async () => {
    // Pattern requires `plugin-` prefix; `@lvis/some-other-package` does
    // NOT match, so resolveDevLinkedPackageEntry returns undefined and
    // the fallback `resolved` path points at a non-existent file.
    await writeManifestAndRegistry(
      "p_dev_nomatch",
      "../../../node_modules/@lvis/some-other-package/dist/hostPlugin.mjs",
    );

    const runtime = makeRuntime();
    await expect(runtime.load()).rejects.toThrow();
    expect(runtime.listPluginIds()).not.toContain("p_dev_nomatch");
  });

  it("returns undefined when the sibling-repo checkout is missing (load fails)", async () => {
    // Pattern matches, but no `testDir/lvis-plugin-meeting/...` tree
    // exists, so existsSync(siblingRepoEntry) is false → undefined.
    await writeManifestAndRegistry(
      "p_dev_missing",
      "../../../node_modules/@lvis/plugin-meeting/dist/hostPlugin.mjs",
    );

    const runtime = makeRuntime();
    await expect(runtime.load()).rejects.toThrow();
    expect(runtime.listPluginIds()).not.toContain("p_dev_missing");
  });
});
