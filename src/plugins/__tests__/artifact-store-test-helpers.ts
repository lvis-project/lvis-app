/**
 * Shared fixtures for the `PluginArtifactStore` suites.
 *
 * `plugin-artifact-store.test.ts` and
 * `plugin-artifact-store-windows-lock.test.ts` both need a store rooted at a
 * throwaway temp dir with a no-op marketplace fetcher. Keeping a single
 * implementation here is what `scripts/check-test-duplicates.mjs` enforces —
 * copying `makeStore` into each suite trips the `--fail-on-duplicates` gate.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PluginArtifactStore } from "../plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";

/** A store rooted at `{tmpDir}/installed` + `{tmpDir}/cache`, tarball cache off. */
export function makeStore(tmpDir: string): PluginArtifactStore {
  const fetcher = {
    listPlugins: async () => [],
    getPluginDetail: async () => null,
    downloadVersion: async () => ({ zipBuffer: Buffer.alloc(0), sha256: "x" }),
    listAnnouncements: async () => [],
  } satisfies MarketplaceFetcher;
  return new PluginArtifactStore({
    installRoot: resolve(tmpDir, "installed"),
    cacheRoot: resolve(tmpDir, "cache"),
    fetcher,
    publicKeys: {},
    tarballCacheBase: null,
  });
}

/** Throwaway temp dir; callers are responsible for `rmSync(..., {recursive, force})`. */
export function makeTmpDir(prefix = "artifact-store-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
