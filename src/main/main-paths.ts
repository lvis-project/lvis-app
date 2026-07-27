/**
 * Resolved filesystem roots for the packaged/bundled main process.
 *
 * Main-process code is split by esbuild: a module can therefore execute from
 * `dist/src/main/main.js` *or* from `dist/src/main/chunks/*.js`. Do not derive
 * a runtime asset path by assuming the current module sits directly in
 * `dist/src/main`. Instead, walk up to the real `dist/src` asset directory,
 * identified by its main-entry and host-preload markers. This remains correct
 * for dev, packaged asar, and future chunk-layout changes.
 */
import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimePaths = {
  /** `dist/src` in a build; `src` as the source-tree fallback used by tests. */
  distSrcDir: string;
  /** Directory containing the main entry (`dist/src/main`). */
  mainDir: string;
  /** `dist` root in a build; project root in the source-tree fallback. */
  distRoot: string;
  /** App/project root (the asar root when packaged). */
  projectRoot: string;
};

/**
 * Resolve runtime roots from any main-process module URL.
 *
 * Exported for a regression test that models a code-split `chunks/*.js`
 * module. `exists` is injectable so the test does not need a real build tree.
 */
export function resolveRuntimePathsFromModuleUrl(
  moduleUrl: string,
  exists: (path: string) => boolean = existsSync,
): RuntimePaths {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const fsRoot = parse(moduleDir).root;
  let candidate = moduleDir;

  for (;;) {
    // These two files are emitted together in the only authoritative runtime
    // asset directory. Checking both avoids accepting an unrelated `src/`
    // ancestor in a source checkout.
    if (
      exists(join(candidate, "main", "main.js")) &&
      exists(join(candidate, "preload.cjs"))
    ) {
      const distSrcDir = candidate;
      const distRoot = resolve(distSrcDir, "..");
      return {
        distSrcDir,
        mainDir: join(distSrcDir, "main"),
        distRoot,
        projectRoot: resolve(distRoot, ".."),
      };
    }
    if (candidate === fsRoot) break;
    candidate = dirname(candidate);
  }

  // Source-tree / isolated-unit-test fallback. Runtime Electron launches only
  // happen after `dist/src` has been built, so this deliberately retains the
  // prior source-module semantics instead of guessing from cwd or app path.
  const mainDir = moduleDir;
  const distRoot = resolve(mainDir, "..", "..");
  return {
    distSrcDir: resolve(mainDir, ".."),
    mainDir,
    distRoot,
    projectRoot: distRoot,
  };
}

const runtimePaths = resolveRuntimePathsFromModuleUrl(import.meta.url);

const distSrcDir = runtimePaths.distSrcDir;
export const mainDir = runtimePaths.mainDir;
export const distRoot = runtimePaths.distRoot;
export const projectRoot = runtimePaths.projectRoot;

/** Resolve a host-owned asset emitted alongside `preload.cjs` in `dist/src`. */
export function runtimeAssetPath(...segments: string[]): string {
  return resolve(distSrcDir, ...segments);
}
