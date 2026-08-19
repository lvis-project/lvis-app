#!/usr/bin/env node
// esbuild main-process bundler. Replaces the per-file tsc emit so the
// runtime dependency tree (`ai`, `@ai-sdk/*`, `zod`, `ajv`, `undici`,
// `adm-zip`, `proper-lockfile`) inlines into a split ESM graph. Externals
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
import { MAIN_BUNDLE_EXTERNALS } from "./lib/main-bundle-externals.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outdir = resolve(repoRoot, "dist", "src", "main");
const outfile = resolve(outdir, "main.js");
const chunksDir = resolve(outdir, "chunks");
const manifestPath = resolve(outdir, "bundle-manifest.json");
const watchMode = process.argv.includes("--watch");

const buildOptions = {
  // esbuild uses the caller's cwd for the module-label comments it emits. Pin
  // it to this repository so the byte-budget is independent of invocation cwd.
  absWorkingDir: repoRoot,
  entryPoints: {
    main: resolve(repoRoot, "src", "main.ts"),
    "subscription-grok-tool-policy-hook": resolve(repoRoot, "src", "main", "subscription-grok-tool-policy-hook.ts"),
    "subscription-tool-mcp-server": resolve(repoRoot, "src", "main", "subscription-tool-mcp-server.ts"),
    // The entry of a confined plugin child process. It is its OWN entry point
    // rather than a module of the main bundle because a different process
    // executes it: `spawnConfinedPluginChild` runs `dist/src/main/plugin-child-main.js`
    // directly, and a module buried inside `main.js` has no path to be run from.
    "plugin-child-main": resolve(repoRoot, "src", "plugins", "isolation", "plugin-child-main.ts"),
  },
  outdir,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  format: "esm",
  splitting: true,
  metafile: true,
  // A worktree may link node_modules to another checkout. Keep the logical
  // import path so generated wrapper labels stay independent of that target.
  preserveSymlinks: true,
  platform: "node",
  target: ["node22"],
  legalComments: "none",
  // Keep emitted public names stable for runtime diagnostics, while letting
  // esbuild fold equivalent syntax and eliminate unreachable branches. The
  // main bundle budget measures shipped bytes, so this is a production-safe
  // optimization rather than a budget increase.
  minifySyntax: true,
  // Whitespace minification preserves emitted identifiers and runtime behavior.
  minifyWhitespace: true,
  external: MAIN_BUNDLE_EXTERNALS,
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
    requiredAsyncEntryPoint: resolve(repoRoot, "src", "boot.ts"),
  });
  assertMainBundleBudget(bundleMeasurement, MAIN_BUNDLE_BUDGETS);
  const bundleManifest = createMainBundleManifest(result.metafile, {
    outdir,
    absWorkingDir: repoRoot,
  });
  writeFileSync(manifestPath, `${JSON.stringify(bundleManifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${formatMainBundleBudget(bundleMeasurement)}\n`);

  process.stdout.write(`[esbuild-main] OK -> ${outfile}\n`);
}
