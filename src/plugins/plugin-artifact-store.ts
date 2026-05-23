/**
 * PluginArtifactStore — artifact-management seam.
 *
 * Pulls the artifact-management responsibilities out of the
 * 1100-line `PluginMarketplaceService` god-class so:
 *
 *   1. `marketplace.ts` becomes an orchestrator (catalog → install order →
 *      registry write) and stops owning download/extract/cache plumbing.
 *   2. The MCP marketplace install consumer instantiates a parallel store
 *      rooted at `~/.lvis/mcp/<slug>/` without copying the entire pipeline.
 *
 * What this module owns:
 *   - signed-zip download + envelope verification (delegates to
 *     `installFromMarketplace` in marketplace-installer.ts)
 *   - atomic stage → swap zip extraction (Windows-safe rename)
 *   - per-plugin install/rollback history journal (`history.json`)
 *   - per-version manifest snapshot under `cacheRoot/<slug>/<version>/`
 *
 * What it does NOT own (caller's domain):
 *   - the marketplace catalog / fetcher selection
 *   - `registry.json` updates
 *   - dependency resolution
 *   - per-plugin lifecycle locks
 *
 * The store is transport- and plugin-kind agnostic: callers supply
 * `installRoot` (where to extract) and `cacheRoot` (where to keep history
 * + version snapshots). Regular plugins point these at `~/.lvis/plugins/`;
 * MCP consumers point them at `~/.lvis/mcp/`.
 */

import AdmZip from "adm-zip";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  installFromMarketplace,
  type InstallerProgressEvent,
  type MarketplaceHttp,
} from "./marketplace-installer.js";
import { sanitizeZipEntryPath } from "./zip-entry-path.js";
import type { MarketplaceFetcher } from "./marketplace-fetcher.js";
import type { PublicKeyInput } from "./envelope-verifier.js";
import type { PluginAccessSpec, PluginMarketplaceItem, PluginRegistryEntryInstallSource } from "./types.js";
import {
  hashReceiptFiles,
  writeInstallReceipt,
  type PluginInstallReceipt,
} from "./plugin-install-receipt.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("plugin-artifact-store");

export interface ArtifactStoreHistoryEntry {
  version: string;
  /** ISO timestamp. */
  installedAt: string;
}

export interface CachedRegistryEntrySnapshot {
  installSource?: PluginRegistryEntryInstallSource;
  bundleRefs?: string[];
  approvedPluginAccess?: PluginAccessSpec;
}

export interface VerifiedArtifact {
  zipBuffer: Buffer;
  artifactSha256: string;
  signerKeyId: string;
}

export interface ArtifactStoreOptions {
  /**
   * Where artifacts are extracted (`{installRoot}/<slug>/...`). For
   * regular plugins this is `~/.lvis/plugins/`; for MCP servers it is
   * `~/.lvis/mcp/`.
   */
  installRoot: string;
  /**
   * Per-slug history + version snapshot root. For regular plugins this
   * is `~/.lvis/plugins/.cache/`; for MCP servers it is
   * `~/.lvis/mcp/.cache/`.
   */
  cacheRoot: string;
  /**
   * Marketplace fetcher used for verified-zip download. The store does
   * not call `fetcher.listPlugins()` — that's the catalog reader's
   * concern. It does need `downloadArtifact` + `fetchSignatureEnvelope`
   * (the {@link MarketplaceHttp} surface).
   */
  fetcher: MarketplaceFetcher;
  /** Map of `key_id → ed25519 public key` used to verify the envelope. */
  publicKeys: Record<string, PublicKeyInput>;
  /**
   * Tarball offline cache base directory. Pass `null` to disable the
   * cache entirely (test mock fetcher). Pass a path to enable. When
   * `undefined`, the store uses `cacheRoot/.tarballs` so the cache stays
   * inside the same `~/.lvis/<topic>/.cache/` tree as the SoT.
   */
  tarballCacheBase?: string | null;
}

type VerifiedMarketplaceFetcher = MarketplaceFetcher & MarketplaceHttp;

export const SAFE_ARTIFACT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeArtifactSlug(slug: string): string {
  if (!SAFE_ARTIFACT_SLUG_RE.test(slug)) {
    throw new Error(
      `invalid artifact slug "${slug}" — expected ${SAFE_ARTIFACT_SLUG_RE.source}`,
    );
  }
  return slug;
}

function isVerifiedMarketplaceFetcher(fetcher: MarketplaceFetcher): fetcher is VerifiedMarketplaceFetcher {
  return (
    typeof (fetcher as Partial<VerifiedMarketplaceFetcher>).downloadArtifact === "function" &&
    typeof (fetcher as Partial<VerifiedMarketplaceFetcher>).fetchSignatureEnvelope === "function"
  );
}

export class PluginArtifactStore {
  private readonly installRoot: string;
  private readonly cacheRoot: string;
  private readonly fetcher: MarketplaceFetcher;
  private readonly publicKeys: Record<string, PublicKeyInput>;
  private readonly tarballCacheBase: string | null;

  constructor(options: ArtifactStoreOptions) {
    this.installRoot = options.installRoot;
    this.cacheRoot = options.cacheRoot;
    this.fetcher = options.fetcher;
    this.publicKeys = options.publicKeys;
    // The store owns the SoT for the tarball cache. `null` disables it
    // (test fetcher); `undefined` falls back to a sibling under cacheRoot.
    // `paths.cacheRoot` lives under the plugin tree's own `.cache/` so
    // disk usage tracks install state.
    this.tarballCacheBase =
      options.tarballCacheBase === null
        ? null
        : options.tarballCacheBase ?? resolve(options.cacheRoot, ".tarballs");
  }

  /** `{installRoot}/{slug}` — exposed for callers that need to know the path before download. */
  installDirFor(slug: string): string {
    const safeSlug = assertSafeArtifactSlug(slug);
    const installDir = resolve(this.installRoot, safeSlug);
    if (!isWithin(resolve(this.installRoot), installDir)) {
      throw new Error(`artifact slug "${slug}" escapes install root`);
    }
    return installDir;
  }

  /**
   * Download + envelope-verify the signed zip for `plugin@version`.
   * Returns the raw bytes; extraction is a separate step so MCP-side
   * callers can read the manifest off the zip before deciding where to
   * extract.
   */
  async downloadVerifiedZip(
    plugin: PluginMarketplaceItem,
    version: string,
    onProgress?: (event: InstallerProgressEvent) => void,
  ): Promise<Buffer> {
    return (await this.downloadVerifiedArtifact(plugin, version, onProgress)).zipBuffer;
  }

  async downloadVerifiedArtifact(
    plugin: PluginMarketplaceItem,
    version: string,
    onProgress?: (event: InstallerProgressEvent) => void,
  ): Promise<VerifiedArtifact> {
    const slug = assertSafeArtifactSlug(plugin.slug ?? plugin.id);
    if (!isVerifiedMarketplaceFetcher(this.fetcher)) {
      throw new Error(
        `marketplace fetcher for "${plugin.id}" does not support signed artifact verification`,
      );
    }
    const expectedArtifactSha256 =
      !plugin.version || plugin.version === version || version === "latest"
        ? plugin.artifactSha256
        : undefined;
    const verified = await installFromMarketplace(slug, version, {
      http: this.fetcher,
      publicKeys: this.publicKeys,
      downloadRoot: resolve(this.cacheRoot, "verified-downloads"),
      cacheBase: this.tarballCacheBase,
      // Catalog rows expose the latest artifact hash. Explicit prior-version
      // installs (rollback, pinned installPlugin) must rely on the versioned
      // download header + signature envelope instead of comparing against the
      // latest hash.
      expectedArtifactSha256,
      onProgress,
    });
    return {
      zipBuffer: await readFile(verified.tarballPath),
      artifactSha256: verified.sha256,
      signerKeyId: verified.signerKeyId,
    };
  }

  /**
   * Atomically extract `zipBuffer` into `{installRoot}/{slug}/`. The
   * extraction is staged under a UUID-suffixed directory and swapped
   * into place via Windows-safe rename — concurrent installers can't
   * interleave on the same slug because the stage dir is unique.
   *
   * Throws if any zip entry escapes the install root (defense-in-depth
   * against `..` traversal that slipped through `sanitizeZipEntryPath`).
   */
  async extractZip(slug: string, zipBuffer: Buffer): Promise<string[]> {
    return (await this.extractZipWithCommit(slug, zipBuffer, async () => undefined)).files;
  }

  /**
   * Extract and promote a zip, then run a caller-supplied commit action before
   * deleting the previous install directory. If commit fails, restore the old
   * directory or remove the fresh install so external state (for example MCP
   * config registration) cannot fail after the executable payload changed.
   */
  async extractZipWithCommit<T>(
    slug: string,
    zipBuffer: Buffer,
    commit: (installDir: string, files: string[]) => Promise<T>,
  ): Promise<{ files: string[]; result: T }> {
    const safeSlug = assertSafeArtifactSlug(slug);
    const installDir = this.installDirFor(safeSlug);
    const stageDir = resolve(this.installRoot, `.${safeSlug}.stage-${randomUUID()}`);
    if (!isWithin(resolve(this.installRoot), stageDir)) {
      throw new Error(`artifact slug "${slug}" escapes install root`);
    }
    await rm(stageDir, { recursive: true, force: true });
    await mkdir(stageDir, { recursive: true });
    const extractedFiles: string[] = [];

    try {
      let zip: AdmZip;
      try {
        zip = new AdmZip(zipBuffer);
      } catch (err) {
        throw new Error(`invalid zip format for "${safeSlug}": ${(err as Error).message}`);
      }

      for (const entry of zip.getEntries()) {
        const safeEntryPath = sanitizeZipEntryPath(safeSlug, entry.entryName);
        if (!safeEntryPath) continue;
        const targetPath = resolve(stageDir, safeEntryPath);
        if (!isWithin(stageDir, targetPath)) {
          throw new Error(`"${safeSlug}" zip entry escapes install root: ${entry.entryName}`);
        }
        if (entry.isDirectory) {
          await mkdir(targetPath, { recursive: true });
          continue;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, entry.getData());
        extractedFiles.push(safeEntryPath.split("\\").join("/"));
      }

      // Windows-safe atomic swap: rename existing installDir to a unique
      // .old before promoting stageDir, so a half-promoted state is never
      // observable. `rename()` refuses to overwrite a non-empty directory
      // on Windows; macOS/Linux would also reject the no-op rename.
      const oldDir = resolve(this.installRoot, `.${safeSlug}.old-${randomUUID()}`);
      let hadOldDir = false;
      try {
        await rename(installDir, oldDir);
        hadOldDir = true;
      } catch {
        // installDir didn't exist (first install).
      }
      try {
        await rename(stageDir, installDir);
      } catch (renameErr) {
        if (hadOldDir) {
          await rename(oldDir, installDir).catch(() => undefined);
        }
        throw renameErr;
      }
      const files = extractedFiles.sort();
      let result: T;
      try {
        result = await commit(installDir, files);
      } catch (commitErr) {
        await rm(installDir, { recursive: true, force: true }).catch(() => undefined);
        if (hadOldDir) {
          await rename(oldDir, installDir).catch(() => undefined);
        }
        throw commitErr;
      }
      if (hadOldDir) {
        await rm(oldDir, { recursive: true, force: true }).catch(() => undefined);
      }
      return { files, result };
    } catch (err) {
      if (existsSync(stageDir)) {
        await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
    }
  }

  async writeInstallReceipt(
    slug: string,
    input: {
      version: string;
      installSource: "marketplace" | "local-dev";
      artifactSha256: string | null;
      signerKeyId: string | null;
      files: string[];
      installedAt?: string;
    },
  ): Promise<PluginInstallReceipt> {
    const safeSlug = assertSafeArtifactSlug(slug);
    const pluginRoot = this.installDirFor(safeSlug);
    const receipt: PluginInstallReceipt = {
      schemaVersion: 2,
      pluginId: safeSlug,
      version: input.version,
      installSource: input.installSource,
      artifactSha256: input.artifactSha256,
      signerKeyId: input.signerKeyId,
      installedAt: input.installedAt ?? new Date().toISOString(),
      files: await hashReceiptFiles(pluginRoot, input.files),
    };
    await writeInstallReceipt(this.cacheRoot, receipt);
    return receipt;
  }

  /**
   * Snapshot a currently-installed manifest under
   * `{cacheRoot}/{slug}/{version}/plugin.json`. Used before overwrite
   * by `installArtifact` so {@link findRollbackTarget} can return to a
   * known-good prior version.
   *
   * Best-effort: a missing/unreadable manifest emits a warning but does
   * not throw — the install path should not be blocked by cache hygiene.
   */
  async cacheVersionFromManifest(
    slug: string,
    manifestPath: string,
    registryEntry?: CachedRegistryEntrySnapshot,
  ): Promise<void> {
    try {
      const safeSlug = assertSafeArtifactSlug(slug);
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      const version = parsed.version ?? "unknown";
      const dir = resolve(this.cacheRoot, safeSlug, version);
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, "plugin.json"), raw, "utf-8");
      if (registryEntry) {
        await writeFile(
          resolve(dir, "registry-entry.json"),
          `${JSON.stringify({
            installSource: registryEntry.installSource,
            bundleRefs: registryEntry.bundleRefs,
            approvedPluginAccess: registryEntry.approvedPluginAccess,
          }, null, 2)}\n`,
          "utf-8",
        );
      }
    } catch (err) {
      log.warn(
        `cacheVersion failed for ${slug}: ${(err as Error).message}`,
      );
    }
  }

  async readCachedRegistryEntrySnapshot(
    slug: string,
    version: string,
  ): Promise<CachedRegistryEntrySnapshot | null> {
    try {
      const safeSlug = assertSafeArtifactSlug(slug);
      const raw = await readFile(resolve(this.cacheRoot, safeSlug, version, "registry-entry.json"), "utf-8");
      const parsed = JSON.parse(raw) as Partial<CachedRegistryEntrySnapshot>;
      return {
        installSource: parsed.installSource,
        bundleRefs: Array.isArray(parsed.bundleRefs) ? parsed.bundleRefs : undefined,
        approvedPluginAccess: parsed.approvedPluginAccess,
      };
    } catch {
      return null;
    }
  }

  /**
   * Append a history entry. `history.json` is the order-of-record for
   * which versions have been installed for a slug; rollback walks it
   * newest → oldest.
   *
   * Best-effort: history file write failures don't block install.
   */
  async appendHistory(slug: string, entry: ArtifactStoreHistoryEntry): Promise<void> {
    try {
      const safeSlug = assertSafeArtifactSlug(slug);
      const dir = resolve(this.cacheRoot, safeSlug);
      await mkdir(dir, { recursive: true });
      const entries = await this.readHistory(safeSlug);
      entries.push(entry);
      await writeFile(this.historyPath(safeSlug), `${JSON.stringify({ entries }, null, 2)}\n`, "utf-8");
    } catch (err) {
      log.warn(
        `appendHistory failed for ${slug}: ${(err as Error).message}`,
      );
    }
  }

  /** Read all history entries for `slug` (chronological order). */
  async readHistory(slug: string): Promise<ArtifactStoreHistoryEntry[]> {
    try {
      const raw = await readFile(this.historyPath(slug), "utf-8");
      const parsed = JSON.parse(raw) as { entries?: ArtifactStoreHistoryEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  /**
   * Walk history newest → oldest, return the first version that is
   * (a) different from `currentVersion` and (b) has a cached manifest
   * still on disk that parses as valid JSON with a matching `version`
   * field. Returns `null` when no rollback target is available.
   *
   * Bad-input guards: empty/whitespace/non-string
   * version dirs are skipped rather than surfaced as missing — they
   * were never legal history entries to begin with.
   */
  async findRollbackTarget(
    slug: string,
    currentVersion?: string,
  ): Promise<string | null> {
    const safeSlug = assertSafeArtifactSlug(slug);
    const entries = await this.readHistory(safeSlug);
    if (entries.length === 0) return null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i].version;
      if (!candidate || typeof candidate !== "string" || candidate.trim().length === 0) continue;
      if (candidate === currentVersion) continue;
      const cachedManifest = resolve(this.cacheRoot, safeSlug, candidate, "plugin.json");
      try {
        const raw = await readFile(cachedManifest, "utf-8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (!parsed.version) continue;
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  private historyPath(slug: string): string {
    return resolve(this.cacheRoot, assertSafeArtifactSlug(slug), "history.json");
  }
}

/**
 * Path-relative containment check. `path.relative` returns empty when
 * `parent === candidate` (degenerate — a directory, not a file we'd
 * import) and `..`-prefixed when candidate is outside parent. Mirrors
 * the helper in `runtime.ts` rather than importing across a layer.
 */
function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
