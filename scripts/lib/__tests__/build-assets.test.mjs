import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveBuildAssets } from "../build-assets.mjs";

test("resolveBuildAssets exposes one SOT for build and dev watched assets", () => {
  const root = mkdtempSync(join(tmpdir(), "lvis-build-assets-"));
  try {
    const assets = resolveBuildAssets(root);
    assert.deepEqual(
      assets.map((asset) => [
        asset.category,
        asset.label,
        asset.src.replace(`${root}/`, ""),
        asset.out.replace(`${root}/`, ""),
      ]),
      [
        ["app-shell", "index.html", "src/index.html", "dist/src/index.html"],
        [
          "plugin-shell",
          "plugin-ui-shell.html",
          "src/plugin-ui-shell.html",
          "dist/src/plugin-ui-shell.html",
        ],
        [
          "plugin-shell",
          "plugin-ui-shell.js",
          "src/plugin-ui-shell.js",
          "dist/src/plugin-ui-shell.js",
        ],
        [
          "runtime-script",
          "electron-flags.mjs",
          "scripts/electron-flags.mjs",
          "dist/scripts/electron-flags.mjs",
        ],
        [
          "runtime-script",
          "uv-targets.mjs",
          "scripts/uv-targets.mjs",
          "dist/scripts/uv-targets.mjs",
        ],
      ],
    );
    assert.equal(resolveBuildAssets(root, "runtime-script").length, 2);
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});
