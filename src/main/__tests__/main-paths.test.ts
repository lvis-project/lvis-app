import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRuntimePathsFromModuleUrl } from "../main-paths.js";

describe("resolveRuntimePathsFromModuleUrl", () => {
  it("anchors a code-split main chunk at the emitted dist/src asset directory", () => {
    const distSrcDir = resolve("runtime-paths-fixture", "dist", "src");
    const emittedMarkers = new Set([
      join(distSrcDir, "main", "main.js"),
      join(distSrcDir, "preload.cjs"),
    ]);
    const chunkUrl = pathToFileURL(join(distSrcDir, "main", "chunks", "boot-test.js")).href;

    const paths = resolveRuntimePathsFromModuleUrl(chunkUrl, (candidate) => emittedMarkers.has(candidate));

    expect(paths).toMatchObject({
      distSrcDir,
      mainDir: join(distSrcDir, "main"),
      distRoot: dirname(distSrcDir),
      projectRoot: dirname(dirname(distSrcDir)),
    });
    expect(join(paths.distSrcDir, "plugin-preload.cjs")).toBe(join(distSrcDir, "plugin-preload.cjs"));
    expect(join(paths.distSrcDir, "mcp-app-preload.cjs")).toBe(join(distSrcDir, "mcp-app-preload.cjs"));
  });

  it("retains source-module roots when no emitted asset directory is present", () => {
    const sourceModule = resolve("runtime-paths-fixture", "src", "main", "policy.ts");
    const paths = resolveRuntimePathsFromModuleUrl(pathToFileURL(sourceModule).href, () => false);

    expect(paths.mainDir).toBe(dirname(sourceModule));
    expect(paths.distSrcDir).toBe(dirname(dirname(sourceModule)));
    expect(paths.projectRoot).toBe(resolve(sourceModule, "..", "..", ".."));
  });
});
