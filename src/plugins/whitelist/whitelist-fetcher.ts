/**
 * #893 Stage 2 — HTTP fetcher for the marketplace whitelist registry.
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
 *
 * Pure HTTP — no signature verification, no cache, no monotonicity logic.
 * The registry composes those concerns; this module stays a thin client.
 */
import { createLogger } from "../../lib/logger.js";

const log = createLogger("whitelist-fetcher");

const PRIMARY_BASE = "https://lvis-project.github.io/marketplace-whitelist/v1";
const FALLBACK_BASE =
  "https://github.com/lvis-project/marketplace-whitelist/releases/download/v1-latest";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface WhitelistFetchResult {
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
export interface WhitelistNotModified {
  notModified: true;
  source: "primary" | "fallback";
}

export type FetchOutcome = WhitelistFetchResult | WhitelistNotModified;

export interface WhitelistFetcherOptions {
  /** Last-known ETag to send as If-None-Match. Empty string sends no header. */
  ifNoneMatch?: string;
  /** Optional cancellation hook — wired through Boot's shutdown signal. */
  signal?: AbortSignal;
  /** Per-request timeout. Defaults to 10s. */
  timeoutMs?: number;
}

async function fetchBoth(
  base: string,
  opts: WhitelistFetcherOptions,
): Promise<FetchOutcome | { error: string; status?: number }> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "lvis-app/whitelist-fetcher",
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
    const docRes = await fetch(`${base}/whitelist.json`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (docRes.status === 304) {
      return { notModified: true, source: base === PRIMARY_BASE ? "primary" : "fallback" };
    }
    if (!docRes.ok) {
      return { error: `whitelist.json HTTP ${docRes.status}`, status: docRes.status };
    }
    const body = await docRes.text();
    const etag = docRes.headers.get("etag") ?? undefined;
    const sigRes = await fetch(`${base}/whitelist.json.sig`, {
      method: "GET",
      headers: { "user-agent": "lvis-app/whitelist-fetcher", accept: "application/json" },
      signal: controller.signal,
    });
    if (!sigRes.ok) {
      return { error: `whitelist.json.sig HTTP ${sigRes.status}`, status: sigRes.status };
    }
    const signature = await sigRes.text();
    return {
      body,
      signature,
      etag,
      source: base === PRIMARY_BASE ? "primary" : "fallback",
    };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    clearTimeout(timer);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", onUpstreamAbort);
  }
}

function shouldFallback(status: number | undefined): boolean {
  // 5xx → fallback. 4xx (incl. 404) → terminal: a missing whitelist on the
  // primary host means the registry is intentionally absent (pre-prod or
  // emergency revocation); falling back to the release asset would mask
  // that signal. Network errors (no status) also fall back since the
  // primary host may simply be unreachable.
  if (status === undefined) return true;
  return status >= 500;
}

/**
 * Fetch the whitelist document + signature. Tries the primary URL first;
 * falls back to the GitHub Release asset on 5xx or network failure.
 * Throws when both endpoints fail — the caller (registry) catches and
 * routes the error into the audit log + telemetry counter.
 */
export async function fetchWhitelist(
  opts: WhitelistFetcherOptions = {},
): Promise<FetchOutcome> {
  const primary = await fetchBoth(PRIMARY_BASE, opts);
  if ("notModified" in primary) return primary;
  if ("body" in primary) return primary;
  // primary failed
  if (!shouldFallback(primary.status)) {
    throw new Error(`whitelist primary fetch failed: ${primary.error}`);
  }
  log.warn(
    `whitelist primary fetch failed (${primary.error}); trying fallback`,
  );
  const fallback = await fetchBoth(FALLBACK_BASE, opts);
  if ("notModified" in fallback) return fallback;
  if ("body" in fallback) return fallback;
  throw new Error(
    `whitelist fetch failed: primary=${primary.error}; fallback=${fallback.error}`,
  );
}
