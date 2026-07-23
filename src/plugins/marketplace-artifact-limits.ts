import { open } from "node:fs/promises";

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
  /** Maximum uncompressed/compressed ratio for one non-empty zip entry. */
  maxCompressionRatio: number;
}

export const DEFAULT_MARKETPLACE_ARTIFACT_LIMITS: Readonly<MarketplaceArtifactLimits> =
  Object.freeze({
    // Match the public marketplace server defaults. Enterprise deployments
    // with different ceilings must pass one explicit policy through the fetcher.
    maxCompressedBytes: 50 * 1024 * 1024,
    maxEntryCount: 10_000,
    maxEntryUncompressedBytes: 200 * 1024 * 1024,
    maxTotalUncompressedBytes: 200 * 1024 * 1024,
    maxCompressionRatio: 100,
  });

export type MarketplaceArtifactLimitCode =
  | "ARTIFACT_TOO_LARGE"
  | "ARCHIVE_ENTRY_LIMIT_EXCEEDED"
  | "ARCHIVE_ENTRY_TOO_LARGE"
  | "ARCHIVE_UNCOMPRESSED_TOO_LARGE"
  | "ARCHIVE_COMPRESSION_RATIO_EXCEEDED"
  | "ARTIFACT_DOWNLOAD_TIMEOUT"
  | "ARTIFACT_DOWNLOAD_ABORTED";

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

export interface MarketplaceArtifactLimitProvider {
  getArtifactLimits(): Readonly<MarketplaceArtifactLimits>;
}

export function isMarketplaceArtifactLimitProvider(
  value: unknown,
): value is MarketplaceArtifactLimitProvider {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Partial<MarketplaceArtifactLimitProvider>).getArtifactLimits === "function",
  );
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

/**
 * Read at most `limit + 1` bytes from one stable file descriptor.
 *
 * A separate stat followed by readFile has a TOCTOU window where a concurrent
 * writer can grow the file after validation and force an unbounded allocation.
 * This reader keeps the descriptor stable and proves growth with one extra
 * byte before concatenating a bounded result.
 */
export async function readCompressedArtifactFile(
  filePath: string,
  limit: number,
  context: string,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`${context} is not a regular file`);
    }
    assertCompressedArtifactSize(metadata.size, limit, context);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= limit) {
      const probeRemaining = limit - totalBytes + 1;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, probeRemaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      assertCompressedArtifactSize(totalBytes, limit, context);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}
