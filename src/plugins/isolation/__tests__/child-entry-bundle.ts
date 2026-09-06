/**
 * Build a main-process module the way the shipped build bundles it — the
 * plugin-child entry for the suites that spawn a child, `tracing.ts` for the
 * telemetry suite — against the real bundle boundary.
 *
 * ONE copy, imported by every suite that needs a shipped-shape bundle, because
 * two copies are two chances for one suite to prove something about a bundle
 * that does not ship: the externals, the banner and the target here are the
 * shipped build's, and a suite that drifted from them would read like it
 * exercises this bundle while exercising a different one. This argument was
 * already written against the two cases inside `confined-plugin-child.test.ts`;
 * it holds across files for the same reason, which is why the function it
 * guarded now lives here.
 *
 * A module rather than an export from one of the suites: importing a `.test.ts`
 * would register that file's cases a second time under the importer.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
// The SAME external boundary the shipped entry is built against, so the child
// bundled here is the child that ships.
import { MAIN_BUNDLE_EXTERNALS } from "../../../../scripts/lib/main-bundle-externals.mjs";

/** The repository root, from this module's own location. */
export function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

/**
 * Where a suite's bundle is emitted.
 *
 * INSIDE the repository, not in a fixture's temp dir. The bundle keeps `pino`
 * and ASRT external — for reasons the shipped build documents at length — so it
 * must sit where `node_modules` resolves, which is exactly the relationship
 * `dist/src/main/` has in production. `cacheName` is per suite so one suite's
 * cleanup cannot delete a bundle another suite is still running against.
 */
export function childBundleDir(cacheName: string): string {
  return join(repositoryRoot(), ".cache", cacheName);
}

/**
 * Bundle one main-process module with the shipped build's external boundary,
 * banner, format, platform, target, minification and symlink handling.
 * `splitting` matters for what a suite can prove — the shipped build splits,
 * and a split ESM chunk exposes a CommonJS dependency differently from an
 * inlined one.
 */
export async function buildMainBoundaryBundle(options: {
  readonly entryPoints: Record<string, string>;
  readonly outdir: string;
  readonly splitting: boolean;
}): Promise<void> {
  await build({
    absWorkingDir: repositoryRoot(),
    entryPoints: options.entryPoints,
    outdir: options.outdir,
    entryNames: "[name]",
    // `.mjs` so the emitted entry is ESM wherever a suite copies or spawns it.
    outExtension: { ".js": ".mjs" },
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    format: "esm",
    splitting: options.splitting,
    preserveSymlinks: true,
    platform: "node",
    target: ["node22"],
    minifySyntax: true,
    minifyWhitespace: true,
    external: [...MAIN_BUNDLE_EXTERNALS],
    logLevel: "silent",
    banner: {
      js:
        'import { createRequire as __r } from "node:module";\n'
        + "const require = __r(import.meta.url);\n",
    },
  });
}

/** Bundle `plugin-child-main.ts` into {@link childBundleDir} and name the entry. */
export async function buildChildEntry(cacheName: string): Promise<string> {
  const outdir = childBundleDir(cacheName);
  await buildMainBoundaryBundle({
    entryPoints: {
      "plugin-child-main": join(repositoryRoot(), "src/plugins/isolation/plugin-child-main.ts"),
    },
    outdir,
    splitting: false,
  });
  return join(outdir, "plugin-child-main.mjs");
}
