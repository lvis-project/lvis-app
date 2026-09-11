import type { Readable } from "node:stream";

export interface CopyPathInput {
  sourcePath: string;
  destinationPath: string;
}

export interface ExtractArchiveInput {
  archivePath: string;
  destinationPath: string;
}

export type ArchiveFormat = "tar" | "tar.gz";

export interface TransferSummary {
  sourcePath: string;
  destinationPath: string;
  files: number;
  directories: number;
  bytesWritten: number;
  archiveFormat?: ArchiveFormat;
}

export type TransferFailureCode =
  | "path-denied"
  | "destination-exists"
  | "invalid-destination-parent"
  | "source-destination-overlap"
  | "unsupported-entry"
  | "source-changed"
  | "invalid-archive"
  | "unsupported-archive-format"
  | "limit-exceeded"
  | "cancelled"
  | "io-error";

export type TransferResult =
  | { ok: true; summary: TransferSummary }
  | {
      ok: false;
      code: TransferFailureCode;
      message: string;
      cleanup: "not-created" | "removed" | "incomplete";
      residualPaths?: string[];
      cleanupErrors?: string[];
    };

export interface FileTransferLimits {
  bufferBytes: number;
  maxPayloadBytes: number;
  maxArchiveInputBytes: number;
  maxDecodedArchiveBytes: number;
  maxEntries: number;
  maxDepth: number;
  maxRelativePathBytes: number;
  maxArchiveMetaEntryBytes: number;
}

/** An owned destination: neither operation replaces an existing entry. */
export interface TransferTreeSink {
  directory(relativePath: string): Promise<void>;
  file(
    relativePath: string,
    body: AsyncIterable<Uint8Array>,
    attributes: { expectedBytes: number; ownerExecutable: boolean },
  ): Promise<void>;
}

export interface TransferSession {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly signal: AbortSignal;
  readonly limits: Readonly<FileTransferLimits>;
  readonly sink: TransferTreeSink;
  openSourceFile(path: string): Promise<Readable>;
}
