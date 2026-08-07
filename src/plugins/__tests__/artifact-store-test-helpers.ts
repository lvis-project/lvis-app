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
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  PluginArtifactStore,
  retryOnTransientFsLock,
  type ArtifactStoreOptions,
} from "../plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";

/** A store rooted at `{tmpDir}/installed` + `{tmpDir}/cache`, tarball cache off. */
export function makeStore(
  tmpDir: string,
  overrides: Partial<Pick<ArtifactStoreOptions, "artifactLimits">> = {},
): PluginArtifactStore {
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
    ...overrides,
  });
}

/** Throwaway temp dir; tear down with {@link cleanupTmpDir}, never a bare `rmSync`. */
export function makeTmpDir(prefix = "artifact-store-"): string {
  return mkdtempSync(join(process.cwd(), `.${prefix}`));
}

/**
 * Tear down a {@link makeTmpDir} directory, retrying the transient Windows
 * lock codes.
 *
 * A bare `rmSync(tmp, {recursive, force})` in a `finally` block is not safe on
 * Windows: an antivirus scanner or the shell indexer can still hold a handle
 * inside the tree microseconds after the test's last write, and `rm` then
 * fails `ENOTEMPTY`. The assertions have already passed at that point, so the
 * suite reports a failure for a test that did its job — and it reproduces only
 * in full-suite runs, which is what makes it read as flake.
 *
 * This delegates to the production `retryOnTransientFsLock` rather than
 * open-coding a second retry ladder: that helper already owns the list of
 * codes worth retrying, and a divergent copy here would be exactly the
 * duplicate authority the suite exists to prevent.
 */
export async function cleanupTmpDir(dir: string): Promise<void> {
  await retryOnTransientFsLock(() => rm(dir, { recursive: true, force: true }));
}
