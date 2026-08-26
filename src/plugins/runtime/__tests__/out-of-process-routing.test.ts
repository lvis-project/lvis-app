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

/**
 * The in-process counter-example.
 *
 * It used to be a real plugin id, and it moved each time one was admitted —
 * `local-indexer`, then `meeting`, then `ep-api`. The note here predicted the
 * end of that: `ep-api` was the LAST first-party id on this side, so this
 * admission had nowhere left to move it to.
 *
 * So it is a FIXTURE now, exactly as that note said it would have to be. The
 * in-process arm is still reachable — a third-party plugin the SOT does not
 * name takes it — and deleting the case because no first-party plugin uses it
 * would retire coverage for a live code path.
 *
 * Its absence from the SOT is still asserted by the first case below, which is
 * what keeps this from silently testing the isolated arm twice. Deliberately
 * not a real id and deliberately hyphen-free, so it cannot collide with a
 * plugin name or read as one.
 */
const IN_PROCESS_PLUGIN_ID = "inprocessroutingfixture";

describe("importPluginFactoryForLifecycle chooses one arm per plugin", () => {
  it("has an in-process plugin left to be the counter-example", () => {
    expect(OUT_OF_PROCESS_PLUGIN_IDS.has(IN_PROCESS_PLUGIN_ID)).toBe(false);
  });

  // EVERY id in the SOT, not just the first. A per-plugin routing decision that
  // only ever checked `[0]` would let every addition after the pilot ship with
  // no evidence that the lifecycle actually routes it.
  it.each([...OUT_OF_PROCESS_PLUGIN_IDS])(
    "does not import %s into main — it returns a child-spawning factory",
    async (isolatedId) => {
      // A path that CANNOT be imported. In-process the import is the first
      // thing that happens and this would reject; out-of-process nothing is
      // imported in main at all, so a factory comes back and the path is the
      // child's problem.
      const unimportable = join(tmpdir(), "no-such-plugin-entry.mjs");
      const factory = await routing().importPluginFactoryForLifecycle(
        isolatedId,
        unimportable,
        manifestFor(isolatedId),
      );
      expect(typeof factory).toBe("function");
    },
  );

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
        IN_PROCESS_PLUGIN_ID,
        entryPath,
        manifestFor(IN_PROCESS_PLUGIN_ID),
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
        IN_PROCESS_PLUGIN_ID,
        join(tmpdir(), "no-such-plugin-entry.mjs"),
        manifestFor(IN_PROCESS_PLUGIN_ID),
      ),
    ).rejects.toThrow();
  });
});
