#!/usr/bin/env node
// esbuild main-process bundler. Replaces the per-file tsc emit so the
// runtime dependency tree (`ai`, `@ai-sdk/*`, `zod`, `ajv`, `undici`,
// `adm-zip`, `proper-lockfile`) inlines into a single ESM module. Externals
// stay outside the bundle because they either ship native bindings, are
// provided by Electron at runtime, must share a singleton across plugins, or
// need real node_modules paths at runtime.
import { build, context } from "esbuild";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAIN_BUNDLE_BUDGETS,
  analyzeMainBundleMetafile,
  assertMainBundleBudget,
  createMainBundleManifest,
  formatMainBundleBudget,
} from "./lib/main-bundle-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outdir = resolve(repoRoot, "dist", "src", "main");
const outfile = resolve(outdir, "main.js");
const chunksDir = resolve(outdir, "chunks");
const manifestPath = resolve(outdir, "bundle-manifest.json");
const watchMode = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: { main: resolve(repoRoot, "src", "main.ts") },
  outdir,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  format: "esm",
  splitting: true,
  metafile: true,
  platform: "node",
  target: ["node22"],
  legalComments: "none",
  external: [
    "electron",
    "electron-updater",
    "better-sqlite3",
    // node-pty is a native addon (`.node` + spawn-helper) the main process
    // resolves unbundled from node_modules (asarUnpack'd). Bundling it inline
    // would break the prebuild `.node` resolution the same way better-sqlite3
    // / ASRT would — keep it external so it ships as a real node_modules entry.
    "node-pty",
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
    // ── ASRT (Anthropic sandbox-runtime) — MUST stay external ────────────
    // INVARIANT (PAIRED with the `asarUnpack` of
    // `node_modules/@anthropic-ai/sandbox-runtime/vendor/**` in package.json;
    // the foundation PR added that unpack): ASRT locates its own vendor
    // binaries (Linux seccomp loader, Windows srt-win.exe) filesystem-relative
    // to its module — `dist/sandbox/generate-seccomp-filter.js` does
    // `dirname(fileURLToPath(import.meta.url))` then joins `../../vendor/...`.
    // Because this bundle is `bundle:true` + `format:esm` with no splitting,
    // esbuild would INLINE a reachable dynamic import of ASRT into main.js,
    // which rewrites `import.meta.url` to main.js's own path — so the
    // `../../vendor/...` walk resolves to the wrong directory and the vendor
    // binaries cannot be found at runtime (the same failure class pino hit).
    // Keeping ASRT external makes it a real node_modules entry that resolves
    // its vendor dir at runtime. Its transitive deps (`@pondwader/socks5-server`,
    // `shell-quote`, `node-forge`, `commander`, `zod`) ride along automatically:
    // esbuild stops at the external boundary and never bundles them, so they
    // resolve from node_modules normally. If either side of the pair is
    // dropped, the runtime vendor smoke (scripts/asrt-runtime-smoke.mjs) fails.
    "@anthropic-ai/sandbox-runtime",
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

// In one-shot mode, force a clean build by removing the stale output first.
// In watch mode, esbuild atomically overwrites the output — pre-deleting
// would only force the dev launcher to wait an extra round trip for the
// initial build (and momentarily breaks fs.watch on the output).
if (!watchMode) {
  rmSync(outfile, { force: true });
  rmSync(chunksDir, { recursive: true, force: true });
  rmSync(manifestPath, { force: true });
}

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

  const bundleMeasurement = analyzeMainBundleMetafile(result.metafile, {
    entryPoint: resolve(repoRoot, "src", "main.ts"),
  });
  assertMainBundleBudget(bundleMeasurement, MAIN_BUNDLE_BUDGETS);
  const bundleManifest = createMainBundleManifest(result.metafile, { outdir });
  writeFileSync(manifestPath, `${JSON.stringify(bundleManifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${formatMainBundleBudget(bundleMeasurement)}\n`);

  process.stdout.write(`[esbuild-main] OK -> ${outfile}\n`);
}
