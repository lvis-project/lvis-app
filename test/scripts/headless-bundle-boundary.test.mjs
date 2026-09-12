import { test } from "node:test";
import assert from "node:assert/strict";
import { assertHeadlessBundleBoundary } from "../../scripts/lib/headless-bundle-boundary.mjs";

function graph() {
  return {
    inputs: {
      "src/headless.ts": { imports: [{ path: "src/core.ts", kind: "dynamic-import" }] },
      "src/core.ts": { imports: [{ path: "node:fs", external: true }] },
    },
    outputs: {
      "dist/headless.js": { entryPoint: "src/headless.ts", bytes: 20, imports: [{ path: "./chunks/core.js", kind: "dynamic-import" }] },
      "dist/chunks/core.js": { bytes: 30, imports: [{ path: "node:fs", external: true }] },
    },
  };
}

test("inventories the whole emitted lazy closure", () => {
  const result = assertHeadlessBundleBoundary(graph());
  assert.deepEqual(result.files, [{ path: "chunks/core.js", bytes: 30 }, { path: "headless.js", bytes: 20 }]);
  assert.deepEqual(result.externals, ["node:fs"]);
});

test("rejects a desktop dependency even behind a lazy source import", () => {
  const input = graph();
  input.inputs["src/core.ts"].imports.push({ path: "electron", external: true });
  assert.throws(() => assertHeadlessBundleBoundary(input), /headless-desktop-dependency/);
});

test("rejects a desktop dependency introduced by emitted shared chunks", () => {
  const input = graph();
  input.outputs["dist/chunks/core.js"].imports.push({ path: "electron-updater", external: true });
  assert.throws(() => assertHeadlessBundleBoundary(input), /headless-desktop-dependency/);
});
