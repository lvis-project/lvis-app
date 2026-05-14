#!/usr/bin/env node
// esbuild main-process bundler. Replaces the per-file tsc emit so the
// runtime dependency tree (`ai`, `@ai-sdk/*`, `zod`, `ajv`, `undici`,
// `adm-zip`, `proper-lockfile`, `pino`) inlines into a single ESM
// module. Externals stay outside the bundle because they either ship
// native bindings, are provided by Electron at runtime, or must share
// a singleton across plugins.
import { build, context } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outfile = resolve(repoRoot, "dist", "src", "main", "main.js");
const watchMode = process.argv.includes("--watch");

const buildOptions = {
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
  // Inlined CommonJS modules (pino's `thread-stream`, etc.) reference the
  // CJS-only globals `require` / `__dirname` / `__filename` directly. ESM
  // bundles don't define those, so esbuild leaves the references intact
  // and the bundle ReferenceErrors at startup. Recreate the three globals
  // from `import.meta.url` so the inlined CJS code keeps working.
  banner: {
    js:
      `import { createRequire as __lvisCreateRequire } from "node:module";\n` +
      `import { fileURLToPath as __lvisFileURLToPath } from "node:url";\n` +
      `import { dirname as __lvisDirname } from "node:path";\n` +
      `const require = __lvisCreateRequire(import.meta.url);\n` +
      `const __filename = __lvisFileURLToPath(import.meta.url);\n` +
      `const __dirname = __lvisDirname(__filename);\n`,
  },
};

rmSync(outfile, { force: true });

if (watchMode) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  process.stdout.write(`[esbuild-main] watching -> ${outfile}\n`);
} else {
  const result = await build(buildOptions);

  if (result.errors.length > 0) {
    process.stderr.write(`[esbuild-main] failed with ${result.errors.length} errors\n`);
    process.exit(1);
  }

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      process.stderr.write(`[esbuild-main] warning: ${warning.text}\n`);
    }
    if (process.env.LVIS_ALLOW_ESBUILD_WARN !== "1") {
      process.stderr.write(
        `[esbuild-main] ${result.warnings.length} warning(s); set LVIS_ALLOW_ESBUILD_WARN=1 to bypass\n`,
      );
      process.exit(1);
    }
  }

  process.stdout.write(`[esbuild-main] OK -> ${outfile}\n`);
}
