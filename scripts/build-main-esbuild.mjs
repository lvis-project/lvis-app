#!/usr/bin/env node
// esbuild main-process bundler. Replaces the per-file tsc emit so the
// runtime dependency tree (`ai`, `@ai-sdk/*`, `zod`, `ajv`, `undici`,
// `adm-zip`, `proper-lockfile`, `pino`) inlines into a single ESM
// module. Externals stay outside the bundle because they either ship
// native bindings, are provided by Electron at runtime, or must share
// a singleton across plugins.
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
  legalComments: "none",
  external: [
    "electron",
    "electron-updater",
    "better-sqlite3",
    "@lvis/plugin-sdk",
    "@sentry/electron",
    "fsevents",
  ],
  logLevel: "info",
  // Some inlined modules call `require(...)` directly (CommonJS interop);
  // expose a createRequire-backed `require` on the bundle scope so those
  // calls keep resolving from node_modules.
  banner: {
    js: `import { createRequire as __lvisCreateRequire } from "node:module";\nconst require = __lvisCreateRequire(import.meta.url);\n`,
  },
});

if (result.errors.length > 0) {
  process.stderr.write(`[esbuild-main] failed with ${result.errors.length} errors\n`);
  process.exit(1);
}

process.stdout.write(`[esbuild-main] OK -> ${outfile}\n`);
