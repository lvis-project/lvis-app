import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pid, platform } from "node:process";

const DEFAULT_FILE_MODE = 0o600;
const DIRECTORY_SYNC_ERROR_CODE = "ATOMIC_FILE_DIRECTORY_SYNC_FAILED";

interface ParentDirectorySyncRuntime {
  platform: NodeJS.Platform;
  open(parentDir: string): number;
  fsync(fd: number): void;
  close(fd: number): void;
}

const DEFAULT_PARENT_DIRECTORY_SYNC_RUNTIME: ParentDirectorySyncRuntime = {
  platform,
  open: (parentDir) => openSync(parentDir, "r"),
  fsync: fsyncSync,
  close: closeSync,
};

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function syncParentDirectoryAfterRename(
  parentDir: string,
  runtime: ParentDirectorySyncRuntime,
): void {
  if (runtime.platform === "win32") return;

  let directoryFd: number | undefined;
  let syncError: unknown;
  try {
    directoryFd = runtime.open(parentDir);
    runtime.fsync(directoryFd);
  } catch (error) {
    syncError = error;
  } finally {
    if (directoryFd !== undefined) {
      try {
        runtime.close(directoryFd);
      } catch (error) {
        syncError = syncError === undefined
          ? error
          : new AggregateError(
              [syncError, error],
              "parent directory sync and close both failed",
            );
      }
    }
  }

  if (syncError !== undefined) {
    throw Object.assign(
      new Error("atomic file rename committed but parent directory sync failed"),
      {
        code: DIRECTORY_SYNC_ERROR_CODE,
        committed: true as const,
        cause: syncError,
      },
    );
  }
}

/**
 * Durably replace a UTF-8 file without exposing a partially-written target.
 *
 * The temporary file lives beside the destination so the final rename stays
 * on one filesystem. A random name plus exclusive creation prevents writers
 * from sharing a staging file. The staged bytes are fsynced before rename and
 * an uncommitted temporary file is removed on every failure path.
 */
export function writeUtf8FileAtomicSync(
  filePath: string,
  content: string,
  mode?: number,
): void;
export function writeUtf8FileAtomicSync(
  filePath: string,
  content: string,
  mode = DEFAULT_FILE_MODE,
  directorySyncRuntime: ParentDirectorySyncRuntime = DEFAULT_PARENT_DIRECTORY_SYNC_RUNTIME,
): void {
  writeUtf8FileAtomicSyncInternal(
    filePath,
    content,
    mode,
    directorySyncRuntime,
  );
}

/**
 * Atomically replace a UTF-8 file only while a caller-owned precondition still
 * holds. The candidate is fully written and fsynced before the final check, so
 * a false precondition or any staging failure leaves the destination intact.
 */
export function replaceUtf8FileAtomicSyncIf(
  filePath: string,
  content: string,
  precondition: () => boolean,
  mode = DEFAULT_FILE_MODE,
): boolean {
  return writeUtf8FileAtomicSyncInternal(
    filePath,
    content,
    mode,
    DEFAULT_PARENT_DIRECTORY_SYNC_RUNTIME,
    precondition,
  );
}

function writeUtf8FileAtomicSyncInternal(
  filePath: string,
  content: string,
  mode: number,
  directorySyncRuntime: ParentDirectorySyncRuntime,
  precondition?: () => boolean,
): boolean {
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const tempPath = join(
    parentDir,
    `.${basename(filePath)}.${pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  let committed = false;
  let operationError: unknown;

  try {
    fd = openSync(tempPath, "wx", mode);
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (precondition && !precondition()) return false;
    renameSync(tempPath, filePath);
    committed = true;
    syncParentDirectoryAfterRename(parentDir, directorySyncRuntime);
    return true;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!committed) {
      try {
        unlinkSync(tempPath);
      } catch (error) {
        if (!isMissingPathError(error)) cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          "atomic UTF-8 file write and cleanup both failed",
        );
      }
      throw cleanupErrors[0];
    }
  }
}
