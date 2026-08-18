/**
 * #893 Stage 2 — HTTP fetcher for the marketplace whitelist registry.
 *
 * Thin wrapper around the generic `fetchSignedDocument` (`../signed-doc-fetcher.js`,
 * extracted from this module's original implementation so the plugin
 * revocation registry can reuse the same fetch/fallback/ETag contract
 * instead of re-implementing it). Pins the URLs and filenames to the
 * whitelist's historical values so every existing caller keeps working
 * unmodified.
 *
 * Primary URL: `https://lvis-project.github.io/marketplace-whitelist/v1/whitelist.json`
 *              + detached sibling `whitelist.json.sig`
 * Fallback URL: GitHub Release asset
 *              `https://github.com/lvis-project/marketplace-whitelist/releases/download/v1-latest/whitelist.json`
 *              + sibling `.sig`
 *
 * Falls back to the release asset on 5xx / network errors against the
 * primary URL. ETag is sent on subsequent requests so the GitHub Pages CDN
 * can short-circuit with 304 Not Modified (no body transfer cost).
 */
import {
  fetchSignedDocument,
  type FetchSignedDocumentOptions,
  type SignedDocumentFetchOutcome,
  type SignedDocumentFetchResult,
  type SignedDocumentNotModified,
} from "../signed-doc-fetcher.js";

const PRIMARY_BASE = "https://lvis-project.github.io/marketplace-whitelist/v1";
const FALLBACK_BASE =
  "https://github.com/lvis-project/marketplace-whitelist/releases/download/v1-latest";

const SOURCE = {
  primaryBase: PRIMARY_BASE,
  fallbackBase: FALLBACK_BASE,
  docFilename: "whitelist.json",
  sigFilename: "whitelist.json.sig",
} as const;

export type WhitelistFetchResult = SignedDocumentFetchResult;
export type WhitelistNotModified = SignedDocumentNotModified;
export type FetchOutcome = SignedDocumentFetchOutcome;
export type WhitelistFetcherOptions = FetchSignedDocumentOptions;

/**
 * Fetch the whitelist document + signature. Tries the primary URL first;
 * falls back to the GitHub Release asset on 5xx or network failure. Throws
 * when both endpoints fail — the caller (registry) catches and routes the
 * error into the audit log + telemetry counter.
 */
export async function fetchWhitelist(
  opts: WhitelistFetcherOptions = {},
): Promise<FetchOutcome> {
  return fetchSignedDocument(SOURCE, opts, "lvis-app/whitelist-fetcher");
}
