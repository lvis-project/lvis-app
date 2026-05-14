#!/usr/bin/env node
// esbuild main-process bundler. Replaces the per-file tsc emit so the
// runtime dependency tree (`ai`, `@ai-sdk/*`, `zod`, `ajv`, `undici`,
// `adm-zip`, `proper-lockfile`) inlines into a single ESM module. Externals
// stay outside the bundle because they either ship native bindings, are
// provided by Electron at runtime, must share a singleton across plugins, or
// need real node_modules paths at runtime.
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
    // Pino transports spawn worker_threads via thread-stream and resolve the
    // worker entry + transport target (e.g. pino-pretty) as filesystem paths
    // under node_modules. Bundling pino inlines the source but leaves the
    // worker unable to resolve those paths — first log call exits with
    // "the worker has exited" (reproduced on Windows after PR #706). Keep
    // pino + its transitive worker deps external so they ship as real
    // node_modules entries the worker can resolve.
    "pino",
    "pino-pretty",
    "thread-stream",
    "@pinojs/redact",
    "pino-abstract-transport",
    "pino-std-serializers",
    "sonic-boom",
    "quick-format-unescaped",
    "split2",
    "safe-stable-stringify",
    "process-warning",
    "real-require",
    "atomic-sleep",
    "on-exit-leak-free",
  ],
  logLevel: "info",
  // Inlined CommonJS modules reference CJS-only `require` directly; the ESM
  // bundle doesn't define it, so we shim it from `import.meta.url`. We
  // intentionally do NOT declare `__dirname` / `__filename` here — esbuild
  // hoists `var __dirname = ...` from inlined CJS modules to the bundle's
  // top-level scope, which collides with `const __dirname = ...` from this
  // banner and produces `SyntaxError: Identifier '__dirname' has already
  // been declared` at load time. The inlined CJS modules compute their own
  // `__dirname` / `__filename` locally, so a banner shim is not needed.
  banner: {
    js:
      `import { createRequire as __lvisCreateRequire } from "node:module";\n` +
      `const require = __lvisCreateRequire(import.meta.url);\n`,
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
