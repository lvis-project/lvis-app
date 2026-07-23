/**
 * Resource ceilings for marketplace artifacts.
 *
 * Marketplace payloads are untrusted even after transport authentication:
 * signatures prove provenance, not that a payload is safe to hold in memory
 * or expand on disk. Keep the same contract at download, cache, and extraction
 * boundaries so alternate MarketplaceHttp implementations cannot bypass it.
 */
export interface MarketplaceArtifactLimits {
  /** Maximum wire/cache/zip buffer size before decompression. */
  maxCompressedBytes: number;
  /** Maximum number of central-directory entries in one zip. */
  maxEntryCount: number;
  /** Maximum declared or extracted bytes for one zip entry. */
  maxEntryUncompressedBytes: number;
  /** Maximum aggregate declared or extracted bytes for one zip. */
  maxTotalUncompressedBytes: number;
}

export const DEFAULT_MARKETPLACE_ARTIFACT_LIMITS: Readonly<MarketplaceArtifactLimits> =
  Object.freeze({
    // The public marketplace currently accepts at most 50 MiB per upload.
    // Leave enterprise headroom without letting chunk accumulation double the
    // process memory footprint into an OOM-sized allocation.
    maxCompressedBytes: 64 * 1024 * 1024,
    maxEntryCount: 10_000,
    maxEntryUncompressedBytes: 256 * 1024 * 1024,
    maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  });

export type MarketplaceArtifactLimitCode =
  | "ARTIFACT_TOO_LARGE"
  | "ARCHIVE_ENTRY_LIMIT_EXCEEDED"
  | "ARCHIVE_ENTRY_TOO_LARGE"
  | "ARCHIVE_UNCOMPRESSED_TOO_LARGE";

export class MarketplaceArtifactLimitError extends Error {
  constructor(
    readonly code: MarketplaceArtifactLimitCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceArtifactLimitError";
  }
}

export function resolveMarketplaceArtifactLimits(
  overrides: Partial<MarketplaceArtifactLimits> | undefined,
): Readonly<MarketplaceArtifactLimits> {
  const limits = { ...DEFAULT_MARKETPLACE_ARTIFACT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`marketplace artifact limit ${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

export function assertCompressedArtifactSize(
  bytes: number,
  limit: number,
  context: string,
): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) {
    throw new MarketplaceArtifactLimitError(
      "ARTIFACT_TOO_LARGE",
      `${context} is ${bytes} bytes; maximum allowed is ${limit} bytes`,
    );
  }
}
