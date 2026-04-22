import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveBundledManifestPaths } from "../plugin-runtime.js";

describe("resolveBundledManifestPaths", () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("resolves bundled file packageSpec relative to project root", async () => {
    testDir = join(
      homedir(),
      ".lvis",
      "test-tmp",
      `lvis-bundled-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const pluginDir = join(testDir, "..", "lvis-plugin-work-proactive");
    const pluginsDir = join(testDir, "plugins");
    await mkdir(pluginDir, { recursive: true });
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), "{}", "utf-8");
    await writeFile(
      join(pluginsDir, "marketplace.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "work-proactive",
            deployment: "bundled",
            packageSpec: "file:../lvis-plugin-work-proactive",
          },
        ],
      }),
      "utf-8",
    );

    const manifests = await resolveBundledManifestPaths(testDir);

    expect(manifests).toEqual([resolve(pluginDir, "plugin.json")]);
  });
});
