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
          "floating-dock",
          "floating-dock-window.html",
          "src/floating-dock-window.html",
          "dist/src/floating-dock-window.html",
        ],
        [
          "floating-dock",
          "floating-dock-window.js",
          "src/floating-dock-window.js",
          "dist/src/floating-dock-window.js",
        ],
        [
          "audio-capture",
          "audio-capture-window.html",
          "src/audio-capture-window.html",
          "dist/src/audio-capture-window.html",
        ],
        [
          "audio-capture",
          "audio-capture-window.js",
          "src/audio-capture-window.js",
          "dist/src/audio-capture-window.js",
        ],
        [
          "audio-capture",
          "audio-capture-window-preload.cjs",
          "src/audio-capture-window-preload.cjs",
          "dist/src/audio-capture-window-preload.cjs",
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
    // The capture window is three files that only work together — the page,
    // its script and its preload. A build that copied two of them would fail
    // at capture time rather than at build time.
    assert.equal(resolveBuildAssets(root, "audio-capture").length, 3);
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});
