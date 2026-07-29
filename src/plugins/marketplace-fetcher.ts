



import type { PluginMarketplaceItem } from "./types.js";
import type { MarketplaceAnnouncement } from "../shared/marketplace-announcements.js";

export type { MarketplaceAnnouncement } from "../shared/marketplace-announcements.js";

export interface MarketplaceFetcher {
  /**
   * Optional cache partition for version-aware catalog responses. Null
   * disables caching when the host version cannot be safely normalized.
   */
  getCatalogCacheKey?(): string | null | undefined;
  /** Lists catalog entries (latest stable version per plugin). */
  listPlugins(): Promise<PluginMarketplaceItem[]>;
  /** Returns the full detail for a single plugin slug, or null on 404. */
  getPluginDetail(slug: string): Promise<PluginMarketplaceItem | null>;
  /** Downloads a specific version's .zip and returns bytes + sha256. */
  downloadVersion(
    slug: string,
    version: string,
  ): Promise<{ zipBuffer: Buffer; sha256: string }>;
  /** Lists currently-active marketplace announcements (server-filtered). */
  listAnnouncements(): Promise<MarketplaceAnnouncement[]>;
}
