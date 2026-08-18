/**
 * HTTP fetcher for the plugin revocation registry.
 *
 * Thin wrapper around the generic `fetchSignedDocument` (`../signed-doc-fetcher.js`)
 * — the same fetch/fallback/ETag client the marketplace whitelist registry
 * uses — pointed at the revocation document instead.
 *
 * Primary URL: `https://lvis-project.github.io/marketplace-whitelist/v1/revocation.json`
 *              + detached sibling `revocation.json.sig`
 * Fallback URL: GitHub Release asset
 *              `https://github.com/lvis-project/marketplace-whitelist/releases/download/v1-latest/revocation.json`
 *              + sibling `.sig`
 *
 * Hosted alongside `whitelist.json` on the same `marketplace-whitelist` repo
 * (see `marketplace-keys.ts` for why the trust anchor is shared too) rather
 * than standing up a fourth repo/domain for one more small JSON file.
 */
import {
  fetchSignedDocument,
  type FetchSignedDocumentOptions,
  type SignedDocumentFetchOutcome,
} from "../signed-doc-fetcher.js";

const PRIMARY_BASE = "https://lvis-project.github.io/marketplace-whitelist/v1";
const FALLBACK_BASE =
  "https://github.com/lvis-project/marketplace-whitelist/releases/download/v1-latest";

const SOURCE = {
  primaryBase: PRIMARY_BASE,
  fallbackBase: FALLBACK_BASE,
  docFilename: "revocation.json",
  sigFilename: "revocation.json.sig",
} as const;

export type RevocationFetcherOptions = FetchSignedDocumentOptions;
export type FetchOutcome = SignedDocumentFetchOutcome;

/**
 * Fetch the revocation document + signature. Tries the primary URL first;
 * falls back to the GitHub Release asset on 5xx or network failure. Throws
 * when both endpoints fail — the caller (registry) catches it and treats it
 * exactly like any other fetch failure: keep the cached snapshot (if any),
 * fail-open only when there has never been one.
 */
export async function fetchRevocationDocument(
  opts: RevocationFetcherOptions = {},
): Promise<FetchOutcome> {
  return fetchSignedDocument(SOURCE, opts, "lvis-app/revocation-fetcher");
}
