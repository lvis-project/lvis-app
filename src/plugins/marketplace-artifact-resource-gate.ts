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
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const predecessor = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signal = options.signal;
  if (signal?.aborted) {
    void predecessor.then(release, release);
    throw abortedWhileQueued();
  }
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortedWhileQueued());
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : null;
  try {
    if (aborted) await Promise.race([predecessor, aborted]);
    else await predecessor;
  } catch (err) {
    void predecessor.then(release, release);
    throw err;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) {
    release();
    throw abortedWhileQueued();
  }
  try {
    return await operation();
  } finally {
    release();
  }
}

function abortedWhileQueued(): Error {
  const error = new Error("marketplace artifact operation aborted while waiting for the resource slot");
  error.name = "AbortError";
  return error;
}
