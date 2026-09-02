/**
 * Process-wide marketplace artifact gate.
 *
 * Each install temporarily retains compressed chunks, a contiguous zip
 * buffer, and decompressed entry buffers. Per-artifact ceilings alone do not
 * bound aggregate memory when different plugin IDs install concurrently, so
 * production plugin and MCP install orchestration share this one FIFO slot.
 */
import { createSerialQueue } from "../lib/with-file-lock.js";

const slot = createSerialQueue();

export async function withMarketplaceArtifactResourceSlot<T>(
  operation: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const signal = options.signal;
  if (signal?.aborted) throw abortedWhileQueued();
  let started = false;
  const turn = slot(async () => {
    // A caller that gave up while queued must not consume the slot.
    if (signal?.aborted) throw abortedWhileQueued();
    started = true;
    return operation();
  });
  if (!signal) return turn;
  // Only the wait is abortable: once `operation` runs, its own signal handling
  // decides, and this gate no longer stands between the caller and the result.
  let onAbort: (() => void) | undefined;
  const abortedWhileWaiting = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (!started) reject(abortedWhileQueued());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([turn, abortedWhileWaiting]);
  } catch (err) {
    if (!started) void turn.catch(() => undefined);
    throw err;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortedWhileQueued(): Error {
  const error = new Error("marketplace artifact operation aborted while waiting for the resource slot");
  error.name = "AbortError";
  return error;
}
