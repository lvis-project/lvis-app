/**
 * The routing decision itself.
 *
 * Every instantiation path — boot load, add, restart, capability reload —
 * reaches a plugin's factory through `importPluginFactoryForLifecycle`, so this
 * is the one place the in-process and out-of-process arms are chosen. What
 * matters is both directions: the pilot must not be imported into main, and
 * every other plugin must still be.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginRuntime, createNoopHostApiForTests } from "../../runtime.js";
import type { PluginManifest, RuntimePluginFactory } from "../../types.js";
import { OUT_OF_PROCESS_PLUGIN_IDS } from "../../isolation/out-of-process-plugins.js";

const HOST_ROOT = "/tmp/lvis-out-of-process-routing";

interface LifecycleRouting {
  importPluginFactoryForLifecycle(
    pluginId: string,
    resolvedEntryPath: string,
    manifest: PluginManifest,
    bustCache?: boolean,
  ): Promise<RuntimePluginFactory | undefined>;
}

function routing(): LifecycleRouting {
  return new PluginRuntime({
    hostRoot: HOST_ROOT,
    manifestPaths: [],
    createHostApi: createNoopHostApiForTests,
  }) as unknown as LifecycleRouting;
}

function manifestFor(pluginId: string): PluginManifest {
  return {
    id: pluginId,
    name: pluginId,
    version: "1.0.0",
    entry: "plugin.mjs",
    description: "a plugin used to observe which arm the lifecycle chose",
    tools: [],
  } as PluginManifest;
}

describe("importPluginFactoryForLifecycle chooses one arm per plugin", () => {
  it("does not import the pilot into main — it returns a child-spawning factory", async () => {
    const [pilot] = [...OUT_OF_PROCESS_PLUGIN_IDS];
    expect(pilot).toBeTypeOf("string");
    // A path that CANNOT be imported. In-process the import is the first thing
    // that happens and this would reject; out-of-process nothing is imported in
    // main at all, so a factory comes back and the path is the child's problem.
    const unimportable = join(tmpdir(), "no-such-plugin-entry.mjs");
    const factory = await routing().importPluginFactoryForLifecycle(
      pilot!,
      unimportable,
      manifestFor(pilot!),
    );
    expect(typeof factory).toBe("function");
  });

  it("still imports every other plugin into main, unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "in-process-plugin-"));
    const entryPath = join(dir, "plugin.mjs");
    writeFileSync(
      entryPath,
      // `import.meta.url` rather than an interpolated marker: the module
      // names ITSELF, so the assertion proves the instance came from this
      // exact file, and the generated source embeds no value at all.
      "export default () => ({ handlers: {}, marker: import.meta.url });\n",
      "utf-8",
    );
    try {
      const factory = await routing().importPluginFactoryForLifecycle(
        "meeting",
        entryPath,
        manifestFor("meeting"),
      );
      expect(typeof factory).toBe("function");
      // The module's OWN export, which only an in-main dynamic import produces.
      const instance = (await factory!({} as never)) as { marker?: string };
      expect(instance.marker).toBe(pathToFileURL(entryPath).href);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails an in-process plugin whose entry cannot be imported, as it always has", async () => {
    await expect(
      routing().importPluginFactoryForLifecycle(
        "meeting",
        join(tmpdir(), "no-such-plugin-entry.mjs"),
        manifestFor("meeting"),
      ),
    ).rejects.toThrow();
  });
});
