import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { parseStrictJson } from "../shared/strict-json.js";
import {
  WORKLOAD_BROKER_LIMITS,
  WORKLOAD_BROKER_OPERATIONS,
  WorkloadBrokerCapabilityDocumentSchema,
  type WorkloadBrokerCapabilityDocument,
} from "./protocol.js";

export class WorkloadBrokerConfigurationError extends Error {
  constructor(readonly code: string) {
    super(`workload-broker:${code}`);
    this.name = "WorkloadBrokerConfigurationError";
  }
}

function fail(code: string): never {
  throw new WorkloadBrokerConfigurationError(code);
}

function currentUid(): number {
  if (typeof process.geteuid !== "function" || constants.O_NOFOLLOW === undefined) {
    return fail("protected-file-unavailable");
  }
  return process.geteuid();
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertCapabilityFile(stats: Stats, uid: number): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    fail("capability-file-type-invalid");
  }
  if (stats.uid !== uid) fail("capability-file-owner-invalid");
  if ((stats.mode & 0o7777) !== 0o400) fail("capability-file-mode-invalid");
  if (stats.size < 2 || stats.size > WORKLOAD_BROKER_LIMITS.capabilityBytes) {
    fail("capability-file-size-invalid");
  }
}

function assertCapabilityDirectory(stats: Stats, uid: number): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail("capability-directory-invalid");
  }
  if (stats.uid !== uid) fail("capability-directory-owner-invalid");
  if ((stats.mode & 0o7777) !== 0o700) fail("capability-directory-mode-invalid");
}

function openCapabilityDirectory(path: string): number {
  try {
    return openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      fail("capability-directory-invalid");
    }
    throw error;
  }
}

function readWholeFile(fd: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) fail("capability-file-short-read");
    offset += count;
  }
  return bytes;
}

export function assertSecureWorkloadBrokerSocket(socketPath: string): void {
  if (!isAbsolute(socketPath) || socketPath.includes("\0") || normalize(socketPath) !== socketPath) {
    fail("socket-path-invalid");
  }
  const uid = currentUid();
  try {
    const parent = lstatSync(dirname(socketPath));
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail("socket-directory-invalid");
    if (parent.uid !== uid) fail("socket-directory-owner-invalid");
    if ((parent.mode & 0o7777) !== 0o700) fail("socket-directory-mode-invalid");
    const socket = lstatSync(socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink() || socket.nlink !== 1) {
      fail("socket-type-invalid");
    }
    if (socket.uid !== uid) fail("socket-owner-invalid");
    if ((socket.mode & 0o7777) !== 0o600) fail("socket-mode-invalid");
    if (realpathSync.native(socketPath) !== socketPath) fail("socket-symlink-invalid");
  } catch (error) {
    if (error instanceof WorkloadBrokerConfigurationError) throw error;
    fail("socket-unavailable");
  }
}

export function loadWorkloadBrokerCapabilityFile(
  capabilityPath: string,
  expectedSocketPath: string,
  now = Date.now(),
): WorkloadBrokerCapabilityDocument {
  if (!isAbsolute(capabilityPath) || capabilityPath.includes("\0")
      || normalize(capabilityPath) !== capabilityPath) {
    fail("capability-path-invalid");
  }
  const uid = currentUid();
  const parentPath = dirname(capabilityPath);
  let parentFd: number | undefined;
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    parentFd = openCapabilityDirectory(parentPath);
    const openedParent = fstatSync(parentFd);
    assertCapabilityDirectory(openedParent, uid);
    const openedParentPath = lstatSync(parentPath);
    assertCapabilityDirectory(openedParentPath, uid);
    if (realpathSync.native(parentPath) !== parentPath) {
      fail("capability-directory-symlink-invalid");
    }
    if (!sameFile(openedParent, openedParentPath)) {
      fail("capability-directory-changed");
    }
    fd = openSync(
      capabilityPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd);
    assertCapabilityFile(opened, uid);
    bytes = readWholeFile(fd, opened.size);
    const afterHandle = fstatSync(fd);
    const afterPath = lstatSync(capabilityPath);
    assertCapabilityFile(afterHandle, uid);
    assertCapabilityFile(afterPath, uid);
    if (!sameFile(opened, afterHandle) || !sameFile(opened, afterPath)) {
      fail("capability-file-changed");
    }
    if (realpathSync.native(capabilityPath) !== capabilityPath) {
      fail("capability-path-symlink-invalid");
    }
    const finalPath = lstatSync(capabilityPath);
    assertCapabilityFile(finalPath, uid);
    if (!sameFile(opened, finalPath)) fail("capability-file-changed");
    const finalParentHandle = fstatSync(parentFd);
    const finalParentPath = lstatSync(parentPath);
    assertCapabilityDirectory(finalParentHandle, uid);
    assertCapabilityDirectory(finalParentPath, uid);
    if (realpathSync.native(parentPath) !== parentPath) {
      fail("capability-directory-symlink-invalid");
    }
    if (!sameFile(openedParent, finalParentHandle)
        || !sameFile(openedParent, finalParentPath)) {
      fail("capability-directory-changed");
    }
    let value: unknown;
    try {
      value = parseStrictJson(bytes, {
        maxBytes: WORKLOAD_BROKER_LIMITS.capabilityBytes,
        maxDepth: 8,
        maxNodes: 128,
        maxObjectMembers: 24,
        maxArrayItems: WORKLOAD_BROKER_OPERATIONS.length,
      });
    } catch {
      fail("capability-json-invalid");
    }
    const parsed = WorkloadBrokerCapabilityDocumentSchema.safeParse(value);
    if (!parsed.success) fail("capability-schema-invalid");
    if (parsed.data.socketPath !== expectedSocketPath) fail("socket-binding-mismatch");
    if (Date.parse(parsed.data.expiresAt) <= now) fail("capability-expired");
    return Object.freeze({
      ...parsed.data,
      workload: Object.freeze({ ...parsed.data.workload }),
      allowedOperations: Object.freeze([...parsed.data.allowedOperations]),
    });
  } catch (error) {
    if (error instanceof WorkloadBrokerConfigurationError) throw error;
    fail("capability-file-unavailable");
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) closeSync(fd);
    if (parentFd !== undefined) closeSync(parentFd);
  }
  return fail("capability-file-unavailable");
}
