import type { TransferFailureCode } from "./file-transfer-types.js";

/** A failure from a validated transfer boundary, rather than an OS error code. */
export class FileTransferError extends Error {
  constructor(
    readonly code: TransferFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileTransferError";
  }
}
