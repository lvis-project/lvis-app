/**
 * PluginArtifactStore — Phase 2 §FU#267 decomposition seam.
 *
 * Pulls the artifact-management responsibilities out of the
 * 1100-line `PluginMarketplaceService` god-class so:
 *
 *   1. `marketplace.ts` becomes an orchestrator (catalog → install order →
 *      registry write) and stops owning download/extract/cache plumbing.
 *   2. The MCP marketplace install consumer (lvis-app#259) can instantiate
 *      a parallel store rooted at `userData/mcp-servers/` without copying
 *      the entire pipeline.
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
 * + version snapshots). The MCP consumer points these at
 * `mcp-servers/` instead of `plugins/` and gets the same primitives.
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
import type { PluginMarketplaceItem } from "./types.js";

export interface ArtifactStoreHistoryEntry {
  version: string;
  /** ISO timestamp. */
  installedAt: string;
}

export interface ArtifactStoreOptions {
  /**
   * Where artifacts are extracted (`{installRoot}/<slug>/...`). For
   * regular plugins this is `userData/plugins/`; for MCP servers (#259)
   * it will be `userData/mcp-servers/`.
   */
  installRoot: string;
  /**
   * Per-slug history + version snapshot root. For regular plugins this
   * is the existing `paths.cacheRoot`; for MCP servers it will be a
   * sibling under `userData/mcp-servers/.cache/`.
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
   * `undefined`, the store uses `cacheRoot/.tarballs` so the SoT stays
   * inside `userData` — historically this defaulted to `homedir()` which
   * leaked outside `PluginPaths` (cleared in lvis-app#266).
   */
  tarballCacheBase?: string | null;
}

type VerifiedMarketplaceFetcher = MarketplaceFetcher & MarketplaceHttp;

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
    // (test fetcher); `undefined` falls back to a sibling under cacheRoot
    // — never to homedir(). `paths.cacheRoot` lives under userData, so
    // disk usage tracks plugin install state.
    this.tarballCacheBase =
      options.tarballCacheBase === null
        ? null
        : options.tarballCacheBase ?? resolve(options.cacheRoot, ".tarballs");
  }

  /** `{installRoot}/{slug}` — exposed for callers that need to know the path before download. */
  installDirFor(slug: string): string {
    return resolve(this.installRoot, slug);
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
    const slug = plugin.slug ?? plugin.id;
    if (!isVerifiedMarketplaceFetcher(this.fetcher)) {
      throw new Error(
        `marketplace fetcher for "${plugin.id}" does not support signed artifact verification`,
      );
    }
    const verified = await installFromMarketplace(slug, version, {
      http: this.fetcher,
      publicKeys: this.publicKeys,
      downloadRoot: resolve(this.cacheRoot, "verified-downloads"),
      cacheBase: this.tarballCacheBase,
      onProgress,
    });
    return readFile(verified.tarballPath);
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
  async extractZip(slug: string, zipBuffer: Buffer): Promise<void> {
    const installDir = this.installDirFor(slug);
    const stageDir = resolve(this.installRoot, `.${slug}.stage-${randomUUID()}`);
    await rm(stageDir, { recursive: true, force: true });
    await mkdir(stageDir, { recursive: true });

    try {
      let zip: AdmZip;
      try {
        zip = new AdmZip(zipBuffer);
      } catch (err) {
        throw new Error(`invalid zip format for "${slug}": ${(err as Error).message}`);
      }

      for (const entry of zip.getEntries()) {
        const safeEntryPath = sanitizeZipEntryPath(slug, entry.entryName);
        if (!safeEntryPath) continue;
        const targetPath = resolve(stageDir, safeEntryPath);
        if (!isWithin(stageDir, targetPath)) {
          throw new Error(`"${slug}" zip entry escapes install root: ${entry.entryName}`);
        }
        if (entry.isDirectory) {
          await mkdir(targetPath, { recursive: true });
          continue;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, entry.getData());
      }

      // Windows-safe atomic swap: rename existing installDir to a unique
      // .old before promoting stageDir, so a half-promoted state is never
      // observable. `rename()` refuses to overwrite a non-empty directory
      // on Windows; macOS/Linux would also reject the no-op rename.
      const oldDir = resolve(this.installRoot, `.${slug}.old-${randomUUID()}`);
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
      if (hadOldDir) {
        await rm(oldDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (err) {
      if (existsSync(stageDir)) {
        await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
    }
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
  async cacheVersionFromManifest(slug: string, manifestPath: string): Promise<void> {
    try {
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      const version = parsed.version ?? "unknown";
      const dir = resolve(this.cacheRoot, slug, version);
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, "plugin.json"), raw, "utf-8");
    } catch (err) {
      console.warn(
        `[plugin-artifact-store] cacheVersion failed for ${slug}: ${(err as Error).message}`,
      );
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
      const dir = resolve(this.cacheRoot, slug);
      await mkdir(dir, { recursive: true });
      const entries = await this.readHistory(slug);
      entries.push(entry);
      await writeFile(this.historyPath(slug), `${JSON.stringify({ entries }, null, 2)}\n`, "utf-8");
    } catch (err) {
      console.warn(
        `[plugin-artifact-store] appendHistory failed for ${slug}: ${(err as Error).message}`,
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
   * Bad-input guards (PR#44 Copilot): empty/whitespace/non-string
   * version dirs are skipped rather than surfaced as missing — they
   * were never legal history entries to begin with.
   */
  async findRollbackTarget(
    slug: string,
    currentVersion?: string,
  ): Promise<string | null> {
    const entries = await this.readHistory(slug);
    if (entries.length === 0) return null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i].version;
      if (!candidate || typeof candidate !== "string" || candidate.trim().length === 0) continue;
      if (candidate === currentVersion) continue;
      const cachedManifest = resolve(this.cacheRoot, slug, candidate, "plugin.json");
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
    return resolve(this.cacheRoot, slug, "history.json");
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
