#!/usr/bin/env node
/**
 * esbuild main process bundler.
 *
 * Replaces `tsc -p tsconfig.build.json` for runtime emission. The bundle
 * inlines the `ai` + `@ai-sdk/*` + `zod` + `ajv` + `undici` + `adm-zip` +
 * `proper-lockfile` + `pino` trees plus all `src/` main-process modules
 * into a single ESM file, then asks electron-builder to copy that file
 * into `app.asar` alongside webpack's preload bundles.
 *
 * Externals stay outside the bundle because they either resolve native
 * bindings (`better-sqlite3`), are provided by Electron at runtime
 * (`electron`), or must share the host singleton across plugins
 * (`@lvis/plugin-sdk`). `electron-updater` is external so its lazy
 * `createRequire("electron-updater")` path continues to resolve from
 * `node_modules`. `fsevents` and `@sentry/electron` are optional and
 * left external to avoid load-time `require` failures.
 *
 * Output sits at `dist/src/main/main.js` so the bundled `__dirname`
 * matches the directory the pre-bundle `tsc` layout produced for the
 * other main-process files (the bundle inlines them, so they each see
 * `dist/src/main/` as their own __dirname). This keeps every relative
 * resource path (`resolve(__dirname, "..", "..", "..", "resources", "uv")`
 * in python-runtime.ts, the icon search in app-icon.ts, the plugin
 * preview wiring in html-preview-partition.ts) working without code
 * changes. Only main.ts itself has to step out one extra directory for
 * its preload + index.html paths because its tsc home was `dist/src/`.
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outfile = resolve(repoRoot, "dist", "src", "main", "main.js");

rmSync(outfile, { force: true });

const result = await build({
  entryPoints: [resolve(repoRoot, "src", "main.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  sourcemap: false,
  minify: false,
  legalComments: "none",
  packages: undefined,
  external: [
    "electron",
    "electron-updater",
    "better-sqlite3",
    "@lvis/plugin-sdk",
    "@sentry/electron",
    "fsevents",
  ],
  logLevel: "info",
  banner: {
    js:
      // ESM bundles still need __dirname / __filename for resolve() calls
      // inlined from CommonJS-shaped helpers. The shim mirrors the
      // existing per-file polyfills (main.ts:53-55, python-runtime.ts:27-28)
      // so removing the per-file declarations later does not break.
      `import { fileURLToPath as __lvis_fileURLToPath } from "node:url";\n` +
      `import { dirname as __lvis_dirname } from "node:path";\n` +
      `import { createRequire as __lvis_createRequire } from "node:module";\n` +
      `const require = __lvis_createRequire(import.meta.url);\n`,
  },
});

if (result.errors.length > 0) {
  process.stderr.write(`[esbuild-main] failed with ${result.errors.length} errors\n`);
  process.exit(1);
}

process.stdout.write(`[esbuild-main] OK -> ${outfile}\n`);
