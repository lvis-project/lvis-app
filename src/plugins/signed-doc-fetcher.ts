/**
 * Generic HTTP fetcher for a signed remote policy document (a JSON body plus
 * a detached `.sig` sibling), with primary→fallback failover and conditional
 * GET via ETag.
 *
 * Extracted from the marketplace whitelist registry's original private
 * fetcher so the plugin revocation and admission registries can reuse the
 * exact same fetch/fallback/ETag contract instead of re-implementing it.
 * Callers supply
 * their own base URLs and filenames; this module stays a thin,
 * schema-agnostic HTTP client — no signature verification, no cache, no
 * monotonicity logic (those stay in each domain's registry, same as before).
 */
import { createLogger } from "../lib/logger.js";

const log = createLogger("signed-doc-fetcher");

const DEFAULT_TIMEOUT_MS = 10_000;

export interface SignedDocSource {
  primaryBase: string;
  fallbackBase: string;
  /** e.g. `"whitelist.json"` / `"revocation.json"`. */
  docFilename: string;
  /** e.g. `"whitelist.json.sig"` / `"revocation.json.sig"`. */
  sigFilename: string;
}

// The two arms below are reachable through the exported
// `SignedDocumentFetchOutcome` union and narrowed structurally by callers
// (`"notModified" in outcome`), so neither needs an export of its own.
interface SignedDocumentFetchResult {
  /** Raw JSON body (utf-8 decoded). */
  body: string;
  /** Raw signature envelope JSON (utf-8 decoded). */
  signature: string;
  /** ETag header from the primary URL (when present) for conditional GET reuse. */
  etag: string | undefined;
  /** Which base URL the response actually came from — used for telemetry. */
  source: "primary" | "fallback";
}

/** 304 case — caller should keep its cached copy. */
interface SignedDocumentNotModified {
  notModified: true;
  source: "primary" | "fallback";
}

export type SignedDocumentFetchOutcome = SignedDocumentFetchResult | SignedDocumentNotModified;

export interface FetchSignedDocumentOptions {
  /** Last-known ETag to send as If-None-Match. Empty string sends no header. */
  ifNoneMatch?: string;
  /** Optional cancellation hook — wired through Boot's shutdown signal. */
  signal?: AbortSignal;
  /** Per-request timeout. Defaults to 10s. */
  timeoutMs?: number;
}

async function fetchBoth(
  base: string,
  isPrimary: boolean,
  source: SignedDocSource,
  opts: FetchSignedDocumentOptions,
  userAgent: string,
  networkFetch: typeof fetch,
): Promise<SignedDocumentFetchOutcome | { error: string; status?: number }> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": userAgent,
  };
  if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const upstreamSignal = opts.signal;
  const onUpstreamAbort = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
  }
  try {
    const docRes = await networkFetch(`${base}/${source.docFilename}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (docRes.status === 304) {
      return { notModified: true, source: isPrimary ? "primary" : "fallback" };
    }
    if (!docRes.ok) {
      return { error: `${source.docFilename} HTTP ${docRes.status}`, status: docRes.status };
    }
    const body = await docRes.text();
    const etag = docRes.headers.get("etag") ?? undefined;
    const sigRes = await networkFetch(`${base}/${source.sigFilename}`, {
      method: "GET",
      headers: { "user-agent": userAgent, accept: "application/json" },
      signal: controller.signal,
    });
    if (!sigRes.ok) {
      return { error: `${source.sigFilename} HTTP ${sigRes.status}`, status: sigRes.status };
    }
    const signature = await sigRes.text();
    return {
      body,
      signature,
      etag,
      source: isPrimary ? "primary" : "fallback",
    };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    clearTimeout(timer);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", onUpstreamAbort);
  }
}

function shouldFallback(status: number | undefined): boolean {
  // 5xx → fallback. 4xx (incl. 404) → terminal: a missing document on the
  // primary host means it is intentionally absent (pre-prod or emergency
  // takedown); falling back to the release asset would mask that signal.
  // Network errors (no status) also fall back since the primary host may
  // simply be unreachable.
  if (status === undefined) return true;
  return status >= 500;
}

/**
 * Fetch a signed document + its detached signature over `networkFetch`,
 * which every caller must supply — see `WhitelistInitOptions.networkFetch`
 * for why this module refuses to default to the ambient `fetch`.
 *
 * Tries the primary URL
 * first; falls back to the secondary URL on 5xx or network failure. Throws
 * when both endpoints fail — the caller (a domain registry) catches and
 * routes the error into its own audit log + telemetry counter.
 */
export async function fetchSignedDocument(
  source: SignedDocSource,
  networkFetch: typeof fetch,
  opts: FetchSignedDocumentOptions = {},
  userAgent = "lvis-app/signed-doc-fetcher",
): Promise<SignedDocumentFetchOutcome> {
  const primary = await fetchBoth(source.primaryBase, true, source, opts, userAgent, networkFetch);
  if ("notModified" in primary) return primary;
  if ("body" in primary) return primary;
  // primary failed
  if (!shouldFallback(primary.status)) {
    throw new Error(`${source.docFilename} primary fetch failed: ${primary.error}`);
  }
  log.warn(
    `${source.docFilename} primary fetch failed (${primary.error}); trying fallback`,
  );
  const fallback = await fetchBoth(source.fallbackBase, false, source, opts, userAgent, networkFetch);
  if ("notModified" in fallback) return fallback;
  if ("body" in fallback) return fallback;
  throw new Error(
    `${source.docFilename} fetch failed: primary=${primary.error}; fallback=${fallback.error}`,
  );
}
