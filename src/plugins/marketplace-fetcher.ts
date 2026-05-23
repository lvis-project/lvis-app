/**
 * Marketplace Fetcher — §9.5 M4
 *
 * Abstracts the source of marketplace catalog data. The current implementation has a
 * single production source: the lvis-marketplace REST service.
 *
 * Implementations:
 *   - `CloudMarketplaceFetcher` — talks to the lvis-marketplace server
 *     (default `https://marketplace.lvisai.xyz`; local dev operators can
 *     override via Settings → 마켓플레이스).
 *   - `DisabledMarketplaceFetcher`  — no-op fetcher used when boot finds
 *     no `realCloudBaseUrl`; every method throws `marketplace-disabled`.
 *   - `MockMarketplaceFetcher`      — dev/test-only stub backed by a JSON
 *     file; constructor is gated to fail in packaged builds. Production
 *     boot never instantiates it.
 *
 * Note: `listPlugins()` returns the pure catalog shape
 * ({@link PluginMarketplaceItem}). Installed/enabled/isManaged flags are
 * resolved by `PluginMarketplaceService.list` from the local plugin
 * registry, not by the fetcher.
 */
import type { PluginMarketplaceItem } from "./types.js";

export interface MarketplaceFetcher {
  /** Lists catalog entries (latest stable version per plugin). */
  listPlugins(): Promise<PluginMarketplaceItem[]>;
  /** Returns the full detail for a single plugin slug, or null on 404. */
  getPluginDetail(slug: string): Promise<PluginMarketplaceItem | null>;
  /** Downloads a specific version's .zip and returns bytes + sha256. */
  downloadVersion(
    slug: string,
    version: string,
  ): Promise<{ zipBuffer: Buffer; sha256: string }>;
}
