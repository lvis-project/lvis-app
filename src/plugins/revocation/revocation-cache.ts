/**
 * Disk cache for the plugin revocation registry.
 *
 * Thin wrapper around the generic `SignedDocumentCache` (`../signed-doc-cache.js`)
 * — the same cache the marketplace whitelist registry uses — pinned to the
 * `marketplace-revocation/` subdirectory and `revocation.json` /
 * `revocation.json.sig` filenames.
 *
 * Layout under `<userData>/marketplace-revocation/`:
 *   revocation.json       — last good document body (utf-8 JSON)
 *   revocation.json.sig   — sidecar signature envelope (utf-8 JSON)
 *   meta.json              — { etag?, highestSeenIssuedAt?, lastFetchAt? }
 */
import {
  SignedDocumentCache,
  type SignedDocCacheSnapshot,
} from "../signed-doc-cache.js";

// `RevocationCacheMeta` has no external consumer (see the identical
// decision in `whitelist-cache.ts`), so only `RevocationCacheSnapshot` —
// used by `revocation-registry.ts` — is re-exported here.
export type RevocationCacheSnapshot = SignedDocCacheSnapshot;

/** Wraps the on-disk cache for one userData directory. */
export class RevocationCache extends SignedDocumentCache {
  constructor(userDataDir: string) {
    super(userDataDir, "marketplace-revocation", "revocation.json", "revocation.json.sig");
  }
}
