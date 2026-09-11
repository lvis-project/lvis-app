import { constants as bufferConstants } from "node:buffer";
import type { FileTransferLimits } from "./file-transfer-types.js";

/** General per-operation ceilings for streamed project file transfers. */
export const FILE_TRANSFER_LIMITS: Readonly<FileTransferLimits> = Object.freeze({
  bufferBytes: 64 * 1024,
  maxPayloadBytes: 1024 * 1024 * 1024,
  maxArchiveInputBytes: 1024 * 1024 * 1024,
  maxDecodedArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 10_000,
  maxDepth: 64,
  maxRelativePathBytes: 4 * 1024,
  maxArchiveMetaEntryBytes: 1024 * 1024,
});

/** Limits are host configuration, never tool arguments. */
export function validateFileTransferLimits(limits: Readonly<FileTransferLimits>): void {
  for (const name of Object.keys(FILE_TRANSFER_LIMITS) as (keyof FileTransferLimits)[]) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid file transfer limit: ${name} must be a positive safe integer`);
    }
  }
  if (limits.bufferBytes > bufferConstants.MAX_LENGTH) {
    throw new Error("Invalid file transfer limit: bufferBytes exceeds the buffer capacity");
  }
}
