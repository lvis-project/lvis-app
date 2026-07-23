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
    });

    expect(measurement).toMatchObject({
      entryBytes: 100,
      initialBytes: 150,
      asyncBytes: 250,
      totalBytes: 400,
      initialFiles: 2,
      totalFiles: 5,
      hasAsyncBoundary: true,
    });
  });

  it("fails closed on a missing split or any exceeded byte budget", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
    });
    expect(() => assertMainBundleBudget(measurement, {
      entryBytes: 99,
      initialBytes: 149,
      totalBytes: 399,
    })).toThrow(/entryBytes 100 exceeds 99[\s\S]*initialBytes 150 exceeds 149[\s\S]*totalBytes 400 exceeds 399/);
    expect(() => assertMainBundleBudget(
      { ...measurement, hasAsyncBoundary: false },
      { entryBytes: 100, initialBytes: 150, totalBytes: 400 },
    )).toThrow(/no async bundle boundary/);
  });

  it("reports the measured legacy initial-load reduction", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
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
    const awaitCorporateCaAt = mainSource.indexOf("await ensureCorporateCaInjected();");
    const awaitBootAt = mainSource.indexOf("await bootModulePromise");
    expect(createWindowAt).toBeGreaterThan(-1);
    expect(createWindowAt).toBeLessThan(loadBootAt);
    expect(loadBootAt).toBeLessThan(awaitCorporateCaAt);
    expect(awaitCorporateCaAt).toBeLessThan(awaitBootAt);
  });
});
