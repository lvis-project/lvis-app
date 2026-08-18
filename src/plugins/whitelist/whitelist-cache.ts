/**
 * #893 Stage 2 — Disk cache for the marketplace whitelist registry.
 *
 * Thin wrapper around the generic `SignedDocumentCache` (`../signed-doc-cache.js`,
 * extracted from this module's original implementation so the plugin
 * revocation registry can reuse the same atomic-write/tolerant-read
 * contract instead of re-implementing it). Pins the subdirectory to
 * `marketplace-whitelist/` and the historical `whitelist.json` /
 * `whitelist.json.sig` filenames so every existing caller and test keeps
 * working unmodified.
 *
 * Layout under `<userData>/marketplace-whitelist/`:
 *   whitelist.json       — last good document body (utf-8 JSON)
 *   whitelist.json.sig   — sidecar signature envelope (utf-8 JSON)
 *   meta.json            — { etag?, highestSeenIssuedAt?, lastFetchAt? }
 */
import {
  SignedDocumentCache,
  type SignedDocCacheSnapshot,
} from "../signed-doc-cache.js";

// `WhitelistCacheMeta` (the `{etag?, highestSeenIssuedAt?, lastFetchAt?}`
// shape) has no external consumer, so — unlike `WhitelistCacheSnapshot`
// below (used by `whitelist-registry.ts`) — it is not re-exported here;
// import `SignedDocCacheMeta` directly from `../signed-doc-cache.js` if one
// is ever needed.
export type WhitelistCacheSnapshot = SignedDocCacheSnapshot;

/** Wraps the on-disk cache for one userData directory. */
export class WhitelistCache extends SignedDocumentCache {
  constructor(userDataDir: string) {
    super(userDataDir, "marketplace-whitelist", "whitelist.json", "whitelist.json.sig");
  }
}
