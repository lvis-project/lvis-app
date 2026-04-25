/**
 * Marketplace Fetcher — §9.5 M4
 *
 * Abstracts the source of marketplace catalog data so the host can swap
 * between a local JSON catalog (legacy/default) and a remote REST
 * service (lvis-marketplace).
 *
 * Implementations:
 *   - {@link MockMarketplaceFetcher}       — reads plugins/marketplace.json
 *   - {@link RealCloudMarketplaceFetcher}  — talks to the LVIS cloud server
 *
 * Note: `listPlugins()` returns the pure catalog shape
 * ({@link PluginMarketplaceItem}). Installed/enabled/isManaged flags are
 * resolved by {@link PluginMarketplaceService.list} from the local
 * plugin registry, not by the fetcher.
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
