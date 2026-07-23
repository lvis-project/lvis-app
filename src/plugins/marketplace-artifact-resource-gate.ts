/**
 * Process-wide marketplace artifact gate.
 *
 * Each install temporarily retains compressed chunks, a contiguous zip
 * buffer, and decompressed entry buffers. Per-artifact ceilings alone do not
 * bound aggregate memory when different plugin IDs install concurrently, so
 * production plugin and MCP install orchestration share this one FIFO slot.
 */
let tail: Promise<void> = Promise.resolve();

export async function withMarketplaceArtifactResourceSlot<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
}
