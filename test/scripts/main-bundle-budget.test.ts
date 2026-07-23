import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  analyzeMainBundleMetafile,
  assertMainBundleBudget,
  createMainBundleManifest,
  formatMainBundleBudget,
} from "../../scripts/lib/main-bundle-budget.mjs";

const syntheticMetafile = {
  outputs: {
    "/repo/dist/main.js": {
      bytes: 100,
      entryPoint: "/repo/src/main.ts",
      imports: [
        { path: "./chunks/shared.js", kind: "import-statement" },
        { path: "./chunks/boot.js", kind: "dynamic-import" },
        { path: "electron", kind: "import-statement", external: true },
      ],
    },
    "/repo/dist/chunks/shared.js": { bytes: 50, imports: [] },
    "/repo/dist/chunks/boot.js": {
      bytes: 200,
      entryPoint: "/repo/src/boot.ts",
      imports: [{ path: "./async-shared.js", kind: "import-statement" }],
    },
    "/repo/dist/chunks/async-shared.js": { bytes: 20, imports: [] },
    "/repo/dist/chunks/locale.js": { bytes: 30, imports: [] },
  },
};

describe("main bundle budget", () => {
  it("counts only statically reachable outputs in the initial load", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });

    expect(measurement).toMatchObject({
      entryBytes: 100,
      initialBytes: 150,
      asyncBytes: 250,
      totalBytes: 400,
      initialFiles: 2,
      totalFiles: 5,
      hasRequiredAsyncBoundary: true,
      requiredAsyncEntryIsInitial: false,
    });
  });

  it("fails closed on a missing split or any exceeded byte budget", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    expect(() => assertMainBundleBudget(measurement, {
      entryBytes: 99,
      initialBytes: 149,
      totalBytes: 399,
    })).toThrow(/entryBytes 100 exceeds 99[\s\S]*initialBytes 150 exceeds 149[\s\S]*totalBytes 400 exceeds 399/);
    expect(() => assertMainBundleBudget(
      { ...measurement, hasRequiredAsyncBoundary: false },
      { entryBytes: 100, initialBytes: 150, totalBytes: 400 },
    )).toThrow(/required boot entry has no async bundle boundary/);
  });

  it("rejects a static boot edge even when an unrelated dynamic import remains", () => {
    const metafile = structuredClone(syntheticMetafile);
    metafile.outputs["/repo/dist/main.js"].imports = [
      { path: "./chunks/shared.js", kind: "import-statement" },
      { path: "./chunks/boot.js", kind: "import-statement" },
      { path: "./chunks/locale.js", kind: "dynamic-import" },
    ];
    expect(analyzeMainBundleMetafile(metafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    }).hasRequiredAsyncBoundary).toBe(false);
  });

  it("rejects boot when a dynamic edge is shadowed by a transitive static edge", () => {
    const metafile = structuredClone(syntheticMetafile);
    metafile.outputs["/repo/dist/chunks/shared.js"].imports = [
      { path: "./boot.js", kind: "import-statement" },
    ];
    const measurement = analyzeMainBundleMetafile(metafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    expect(measurement).toMatchObject({
      hasRequiredAsyncBoundary: true,
      requiredAsyncEntryIsInitial: true,
    });
    expect(() => assertMainBundleBudget(measurement, {
      entryBytes: 1_000,
      initialBytes: 1_000,
      totalBytes: 1_000,
    })).toThrow(/boot entry remains statically reachable/);
  });

  it("rejects real esbuild factoring that moves boot into an initial shared chunk", async () => {
    const modules = new Map([
      ["v:main.ts", 'import { shared } from "v:shared.ts"; void shared; void import("v:boot.ts");'],
      ["v:shared.ts", 'export { boot as shared } from "v:boot.ts";'],
      ["v:boot.ts", 'export const boot = "loaded";'],
    ]);
    const result = await build({
      entryPoints: ["v:main.ts"],
      bundle: true,
      splitting: true,
      format: "esm",
      outdir: "/virtual-out",
      write: false,
      metafile: true,
      plugins: [{
        name: "virtual-main-bundle",
        setup(esbuild) {
          esbuild.onResolve({ filter: /^v:/ }, ({ path }) => ({ path, namespace: "virtual" }));
          esbuild.onLoad({ filter: /.*/, namespace: "virtual" }, ({ path }) => ({
            contents: modules.get(path),
            loader: "ts",
          }));
        },
      }],
    });
    const entryPoints = Object.values(result.metafile.outputs)
      .map((output) => output.entryPoint)
      .filter((entryPoint): entryPoint is string => typeof entryPoint === "string");
    const mainEntryPoint = entryPoints.find((entryPoint) => entryPoint.includes("main.ts"));
    const bootEntryPoint = entryPoints.find((entryPoint) => entryPoint.includes("boot.ts"));
    expect(mainEntryPoint).toBeDefined();
    expect(bootEntryPoint).toBeDefined();

    const measurement = analyzeMainBundleMetafile(result.metafile, {
      entryPoint: mainEntryPoint!,
      requiredAsyncEntryPoint: bootEntryPoint!,
    });
    expect(measurement).toMatchObject({
      hasRequiredAsyncBoundary: true,
      requiredAsyncEntryIsInitial: true,
    });
    expect(() => assertMainBundleBudget(measurement, {
      entryBytes: Number.MAX_SAFE_INTEGER,
      initialBytes: Number.MAX_SAFE_INTEGER,
      totalBytes: Number.MAX_SAFE_INTEGER,
    })).toThrow(/boot entry remains statically reachable/);
  });

  it("reports the measured legacy initial-load reduction", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    expect(formatMainBundleBudget(measurement)).toContain("legacy-initial-reduction=");
  });

  it("creates a sorted package manifest for every emitted main file", () => {
    expect(createMainBundleManifest(syntheticMetafile, { outdir: "/repo/dist" })).toEqual({
      schemaVersion: 1,
      entry: "main.js",
      files: [
        { path: "chunks/async-shared.js", bytes: 20 },
        { path: "chunks/boot.js", bytes: 200 },
        { path: "chunks/locale.js", bytes: 30 },
        { path: "chunks/shared.js", bytes: 50 },
        { path: "main.js", bytes: 100 },
      ],
    });
  });

  it("keeps window creation ahead of asynchronous boot loading", () => {
    const mainSource = readFileSync(resolve("src/main.ts"), "utf8");
    expect(mainSource).not.toMatch(/^import .* from "\.\/boot\.js";$/m);
    const createWindowAt = mainSource.indexOf("createWindow();");
    const loadBootAt = mainSource.indexOf('import("./boot.js")');
    const attachStartupAt = mainSource.indexOf("loadMainStartupDependencies(", createWindowAt);
    const loadCorporateCaAt = mainSource.indexOf("ensureCorporateCaInjected,");
    expect(createWindowAt).toBeGreaterThan(-1);
    expect(createWindowAt).toBeLessThan(attachStartupAt);
    expect(createWindowAt).toBeLessThan(loadBootAt);
    expect(attachStartupAt).toBeLessThan(loadBootAt);
    expect(loadBootAt).toBeLessThan(loadCorporateCaAt);
  });
});
