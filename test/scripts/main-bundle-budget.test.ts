import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
