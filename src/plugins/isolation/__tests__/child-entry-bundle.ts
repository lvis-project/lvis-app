/**
 * Build the REAL plugin-child entry, against the real bundle boundary.
 *
 * ONE copy, imported by every suite that spawns a child, because two copies are
 * two chances for one suite to prove something about a child that does not
 * ship: the externals, the banner and the target here are the shipped build's,
 * and a suite that drifted from them would read like it exercises this bundle
 * while exercising a different one. `confined-plugin-child.test.ts` says
 * exactly that about its own two cases; this module is the same argument
 * carried across files.
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
 * Where a suite's bundled child entry is emitted.
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

/** Bundle `plugin-child-main.ts` into {@link childBundleDir} and name the entry. */
export async function buildChildEntry(cacheName: string): Promise<string> {
  const repoRoot = repositoryRoot();
  const childEntryPath = join(childBundleDir(cacheName), "plugin-child-main.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [join(repoRoot, "src/plugins/isolation/plugin-child-main.ts")],
    outfile: childEntryPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node22"],
    external: [...MAIN_BUNDLE_EXTERNALS],
    logLevel: "silent",
    banner: {
      js:
        'import { createRequire as __r } from "node:module";\n'
        + "const require = __r(import.meta.url);\n",
    },
  });
  return childEntryPath;
}
