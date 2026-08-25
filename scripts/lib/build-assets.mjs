import { resolve } from "node:path";

export const BUILD_ASSETS = Object.freeze([
  {
    src: "src/index.html",
    out: "dist/src/index.html",
    label: "index.html",
    category: "app-shell",
  },
  {
    src: "src/plugin-ui-shell.html",
    out: "dist/src/plugin-ui-shell.html",
    label: "plugin-ui-shell.html",
    category: "plugin-shell",
  },
  {
    src: "src/plugin-ui-shell.js",
    out: "dist/src/plugin-ui-shell.js",
    label: "plugin-ui-shell.js",
    category: "plugin-shell",
  },
  {
    src: "src/audio-capture-window.html",
    out: "dist/src/audio-capture-window.html",
    label: "audio-capture-window.html",
    category: "audio-capture",
  },
  {
    src: "src/audio-capture-window.js",
    out: "dist/src/audio-capture-window.js",
    label: "audio-capture-window.js",
    category: "audio-capture",
  },
  {
    src: "src/audio-capture-window-preload.cjs",
    out: "dist/src/audio-capture-window-preload.cjs",
    label: "audio-capture-window-preload.cjs",
    category: "audio-capture",
  },
  {
    src: "scripts/electron-flags.mjs",
    out: "dist/scripts/electron-flags.mjs",
    label: "electron-flags.mjs",
    category: "runtime-script",
  },
  {
    src: "scripts/uv-targets.mjs",
    out: "dist/scripts/uv-targets.mjs",
    label: "uv-targets.mjs",
    category: "runtime-script",
  },
]);

export function resolveBuildAssets(repoRoot, category) {
  return BUILD_ASSETS.filter(
    (asset) => category === undefined || asset.category === category,
  ).map((asset) => ({
      src: resolve(repoRoot, asset.src),
      out: resolve(repoRoot, asset.out),
      label: asset.label,
      category: asset.category,
    }));
}
