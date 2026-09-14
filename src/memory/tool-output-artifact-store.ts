import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, unlinkSync, write, writeSync,
  type Stats,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../lib/atomic-file.js";
import { createDlpSafeUuid } from "../shared/dlp-safe-id.js";
import { isValidSessionId } from "../shared/session-id.js";
import { isValidToolUseId } from "../shared/tool-use-id.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import {
  MAX_SESSION_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_PENDING_BYTES, MAX_TOOL_RESULT_ARTIFACT_BYTES,
  normalizeToolOutputArtifactInfo, type ToolOutputArtifactInfo, type ToolOutputCapture,
} from "../shared/tool-output-artifact.js";

type CaptureReason = NonNullable<ToolOutputArtifactInfo["reason"]>;
type ArtifactWrite = (fd: number, buffer: Buffer, offset: number, length: number, position: number) => Promise<number>;
interface OwnedPath { path: string; stat: Stats; realPath?: string }
interface ArtifactPaths { temporary: string; data: string; metadataTemporary: string; metadata: string }

const MAX_METADATA_BYTES = 4_096;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = constants.O_NONBLOCK ?? 0;
const PUBLISHED_TEMPORARY_PATTERN = /^\.([a-f0-9]{64}-([a-f0-9-]{36}))\.(part|json\.tmp)$/;
// Stores for main and auxiliary conversations can share a physical sessions root.
const reservations = new Map<string, Map<string, ArtifactPaths>>();

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function ownedByHost(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function safeFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && ownedByHost(stat)
    && (process.platform === "win32" || (stat.mode & 0o777) === PRIVATE_FILE_MODE);
}

function ensureDirectory(path: string, create: boolean, privateMode: boolean): OwnedPath {
  if (create) {
    try { mkdirSync(path, { mode: PRIVATE_DIR_MODE }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByHost(stat)
    || (process.platform !== "win32" && (privateMode
      ? (stat.mode & 0o777) !== PRIVATE_DIR_MODE
      : (stat.mode & 0o022) !== 0))) {
    throw new Error("tool-output-directory-invalid");
  }
  return { path, stat, realPath: realpathSync(path) };
}

function verifyDirectories(directories: readonly OwnedPath[]): void {
  for (const directory of directories) {
    const stat = lstatSync(directory.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByHost(stat)
      || !sameFile(stat, directory.stat) || realpathSync(directory.path) !== directory.realPath
      || (process.platform !== "win32" && (stat.mode & 0o777) !== (directory.stat.mode & 0o777))) {
      throw new Error("tool-output-directory-changed");
    }
  }
}

function pathsFor(directory: string, toolUseId: string, captureId: string): ArtifactPaths {
  const stem = `${createHash("sha256").update(toolUseId).digest("hex")}-${captureId}`;
  return {
    temporary: join(directory, `.${stem}.part`),
    data: join(directory, `${stem}.bin`),
    metadataTemporary: join(directory, `.${stem}.json.tmp`),
    metadata: join(directory, `${stem}.json`),
  };
}

function openOwnedTemporary(path: string): { fd: number; owned: OwnedPath } {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
  try {
    const stat = fstatSync(fd);
    if (!safeFile(stat) || !sameFile(stat, lstatSync(path))) throw new Error("tool-output-file-invalid");
    return { fd, owned: { path, stat } };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Cleanup never follows or removes a replacement for a temporary file. */
function removeOwnedTemporary(owned: OwnedPath | undefined, directories: readonly OwnedPath[]): void {
  if (!owned) return;
  try {
    verifyDirectories(directories);
    const stat = lstatSync(owned.path);
    if (stat.isFile() && ownedByHost(stat) && sameFile(stat, owned.stat)) unlinkSync(owned.path);
  } catch { /* Missing or replaced entries are not this capture's cleanup targets. */ }
}

function readOwnedFile(path: string, maxBytes: number): Buffer {
  const initial = lstatSync(path);
  if (!safeFile(initial) || initial.size > maxBytes) throw new Error("tool-output-file-invalid");
  // Nonblocking open also covers a FIFO swapped in after the path inspection.
  const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
  try {
    const before = fstatSync(fd);
    if (!safeFile(before) || before.size > maxBytes || !sameFile(before, initial) || !sameFile(before, lstatSync(path))) {
      throw new Error("tool-output-file-invalid");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error("tool-output-file-short-read");
      offset += read;
    }
    const after = fstatSync(fd);
    if (!safeFile(after) || after.size !== before.size || !sameFile(after, lstatSync(path))) {
      throw new Error("tool-output-file-changed");
    }
    return bytes;
  } finally { closeSync(fd); }
}

/** Finish only the duplicate-link cleanup of an inactive atomic publication. */
function recoverPublishedTemporaries(directories: readonly OwnedPath[]): void {
  const directory = directories.at(-1)!;
  const active = reservations.get(directory.realPath!);
  for (const name of readdirSync(directory.path)) {
    const match = PUBLISHED_TEMPORARY_PATTERN.exec(name);
    if (!match || !UUID_PATTERN.test(match[2]!) || active?.has(match[2]!)) continue;
    const temporary = join(directory.path, name);
    const published = join(directory.path, `${match[1]}.${match[3] === "part" ? "bin" : "json"}`);
    try {
      const source = lstatSync(temporary);
      const target = lstatSync(published);
      if (!source.isFile() || !target.isFile() || source.nlink !== 2 || target.nlink !== 2
        || !ownedByHost(source) || !sameFile(source, target)
        || (process.platform !== "win32" && (source.mode & 0o777) !== PRIVATE_FILE_MODE)) continue;
      verifyDirectories(directories);
      if (!sameFile(lstatSync(temporary), source) || !sameFile(lstatSync(published), target)) continue;
      // Both links name the same owned inode within this directory. Its published
      // link remains; an arbitrary orphan or an outside hard link is never removed.
      unlinkSync(temporary);
    } catch { /* Retain anything that cannot be proven to be a duplicate link. */ }
  }
}

function writeChunk(fd: number, buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
  return new Promise((resolveWrite, reject) => {
    write(fd, buffer, offset, length, position, (error, written) => {
      if (error) reject(error);
      else resolveWrite(written);
    });
  });
}

function decodedText(bytes: Buffer, complete: boolean): string {
  const decoder = new StringDecoder("utf8");
  return decoder.write(bytes) + (complete ? decoder.end() : "");
}

class ArtifactCapture implements ToolOutputCapture {
  private observedBytes = 0;
  private capturedBytes = 0;
  private acceptedBytes = 0;
  private capturedChars = 0;
  private pendingBytes = 0;
  private readonly queue: Buffer[] = [];
  private readonly decoder = new StringDecoder("utf8");
  private readonly hash = createHash("sha256");
  private pump: Promise<void> | undefined;
  private settlement: Promise<ToolOutputArtifactInfo> | undefined;
  private reason: CaptureReason | undefined;
  private fd: number | undefined;
  private owned: OwnedPath | undefined;

  constructor(
    readonly captureId: string,
    private readonly sessionId: string,
    private readonly toolUseId: string,
    private readonly directories: readonly OwnedPath[],
    private readonly paths: ArtifactPaths | undefined,
    private readonly release: () => void,
    private readonly writeBytes: ArtifactWrite,
    private readonly beforePublish: ((stage: "data" | "metadata") => void) | undefined,
    reason?: CaptureReason,
  ) {
    this.reason = reason;
    if (paths && !reason) {
      try {
        verifyDirectories(directories);
        const opened = openOwnedTemporary(paths.temporary);
        this.fd = opened.fd;
        this.owned = opened.owned;
      } catch { this.reason = "write-failed"; }
    }
  }

  append(chunk: Uint8Array): boolean {
    if (this.settlement) throw new Error("tool-output-capture-finished");
    if (!(chunk instanceof Uint8Array)) throw new TypeError("tool-output-chunk-invalid");
    this.observedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.observedBytes + chunk.byteLength);
    if (this.reason || chunk.byteLength === 0) return true;
    if (chunk.byteLength > MAX_TOOL_OUTPUT_PENDING_BYTES) {
      this.reason = "queue-limit";
      return true;
    }
    const size = Math.min(chunk.byteLength, MAX_TOOL_RESULT_ARTIFACT_BYTES - this.acceptedBytes);
    if (size === 0) {
      this.reason = "artifact-limit";
      return true;
    }
    if (this.pendingBytes + size > MAX_TOOL_OUTPUT_PENDING_BYTES) {
      this.reason = "queue-limit";
      return true;
    }
    this.queue.push(Buffer.from(chunk.subarray(0, size)));
    this.acceptedBytes += size;
    this.pendingBytes += size;
    if (size < chunk.byteLength) this.reason = "artifact-limit";
    this.pump ??= this.flushQueue();
    return this.pendingBytes < MAX_TOOL_OUTPUT_PENDING_BYTES / 2;
  }

  async waitForDrain(): Promise<void> {
    while (this.pump) await this.pump;
  }

  finish(interrupted = false): Promise<ToolOutputArtifactInfo> {
    if (!this.settlement) {
      if (interrupted) this.reason ??= "interrupted";
      this.settlement = this.settle();
    }
    return this.settlement;
  }

  private async flushQueue(): Promise<void> {
    // Yield before consuming so append can publish the single pump promise.
    await Promise.resolve();
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue.shift()!;
        let offset = 0;
        while (offset < chunk.length) {
          verifyDirectories(this.directories);
          if (this.fd === undefined || !this.owned
            || !sameFile(fstatSync(this.fd), this.owned.stat)
            || !sameFile(lstatSync(this.owned.path), this.owned.stat)) {
            throw new Error("tool-output-file-changed");
          }
          const written = await this.writeBytes(this.fd, chunk, offset, chunk.length - offset, this.capturedBytes);
          if (!Number.isSafeInteger(written) || written <= 0 || written > chunk.length - offset) {
            throw new Error("tool-output-write-incomplete");
          }
          const accepted = chunk.subarray(offset, offset + written);
          this.hash.update(accepted);
          this.capturedChars += this.decoder.write(accepted).length;
          this.capturedBytes += written;
          offset += written;
        }
        this.pendingBytes -= chunk.length;
      }
    } catch {
      this.reason = "write-failed";
      this.queue.length = 0;
      this.pendingBytes = 0;
    } finally { this.pump = undefined; }
  }

  private unavailable(reason: CaptureReason): ToolOutputArtifactInfo {
    return {
      version: 1, captureId: this.captureId, status: "unavailable", reason,
      capturedBytes: 0, capturedChars: 0, observedBytes: this.observedBytes,
    };
  }

  private async settle(): Promise<ToolOutputArtifactInfo> {
    let metadataTemporary: OwnedPath | undefined;
    try {
      await this.waitForDrain();
      if (this.fd === undefined || !this.owned || !this.paths || (this.reason && this.capturedBytes === 0)) {
        return this.unavailable(this.reason ?? "write-failed");
      }
      verifyDirectories(this.directories);
      const stat = fstatSync(this.fd);
      if (!safeFile(stat) || !sameFile(stat, this.owned.stat) || stat.size !== this.capturedBytes
        || !sameFile(lstatSync(this.owned.path), this.owned.stat)) throw new Error("tool-output-file-changed");
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = undefined;
      if (!this.reason) this.capturedChars += this.decoder.end().length;
      const info: ToolOutputArtifactInfo = {
        version: 1, captureId: this.captureId, status: this.reason ? "partial" : "complete",
        ...(this.reason ? { reason: this.reason } : {}), capturedBytes: this.capturedBytes,
        observedBytes: this.observedBytes, capturedChars: this.capturedChars, sha256: this.hash.digest("hex"),
      };
      this.beforePublish?.("data");
      verifyDirectories(this.directories);
      // Exclusive hard-link publication cannot overwrite an existing capture.
      linkSync(this.paths.temporary, this.paths.data);
      removeOwnedTemporary(this.owned, this.directories);
      if (!safeFile(lstatSync(this.paths.data))) throw new Error("tool-output-publication-incomplete");
      this.owned = undefined;
      this.beforePublish?.("metadata");
      verifyDirectories(this.directories);
      const opened = openOwnedTemporary(this.paths.metadataTemporary);
      metadataTemporary = opened.owned;
      try {
        const bytes = Buffer.from(JSON.stringify({ sessionId: this.sessionId, toolUseId: this.toolUseId, info }), "utf8");
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(opened.fd, bytes, offset, bytes.length - offset, offset);
          if (written <= 0) throw new Error("tool-output-metadata-write-failed");
          offset += written;
        }
        fsyncSync(opened.fd);
      } finally { closeSync(opened.fd); }
      verifyDirectories(this.directories);
      linkSync(this.paths.metadataTemporary, this.paths.metadata);
      removeOwnedTemporary(metadataTemporary, this.directories);
      if (!safeFile(lstatSync(this.paths.metadata))) throw new Error("tool-output-publication-incomplete");
      metadataTemporary = undefined;
      if (process.platform !== "win32") {
        const directoryFd = openSync(this.directories.at(-1)!.path, constants.O_RDONLY | NO_FOLLOW);
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
      return info;
    } catch { return this.unavailable("write-failed"); }
    finally {
      if (this.fd !== undefined) {
        try { closeSync(this.fd); } catch { /* Already failed capture; preserve its failure status. */ }
        this.fd = undefined;
      }
      removeOwnedTemporary(this.owned, this.directories);
      removeOwnedTemporary(metadataTemporary, this.directories);
      this.release();
    }
  }
}

/** Raw command output under the existing session store, separate from preview artifacts. */
export class ToolOutputArtifactStore {
  private readonly sessionsDir: string;
  _writeForTest?: ArtifactWrite;
  _beforePublishForTest?: (stage: "data" | "metadata") => void;

  constructor(sessionsDir: string) {
    if (!isAbsolute(sessionsDir)) throw new TypeError("tool-output-sessions-directory-invalid");
    this.sessionsDir = resolve(sessionsDir);
  }

  private directories(sessionId: string, create: boolean): OwnedPath[] {
    const root = ensureDirectory(this.sessionsDir, create, false);
    const session = ensureDirectory(join(root.path, sessionId), create, false);
    const output = ensureDirectory(join(session.path, "tool-output"), create, true);
    const directories = [root, session, output];
    verifyDirectories(directories);
    recoverPublishedTemporaries(directories);
    return directories;
  }

  start(sessionId: string, toolUseId: string): ToolOutputCapture {
    if (!isValidSessionId(sessionId)) throw new TypeError("tool-output-session-id-invalid");
    if (!isValidToolUseId(toolUseId)) throw new TypeError("tool-output-tool-use-id-invalid");
    const captureId = createDlpSafeUuid();
    let directories: OwnedPath[] = [];
    let paths: ArtifactPaths | undefined;
    let release = () => {};
    let reason: CaptureReason | undefined;
    try {
      directories = this.directories(sessionId, true);
      const directory = directories.at(-1)!;
      const key = directory.realPath!;
      const active = reservations.get(key) ?? new Map<string, ArtifactPaths>();
      const excluded = new Set([...active.values()].flatMap((value) => [basename(value.temporary), basename(value.data)]));
      let retained = 0;
      for (const name of readdirSync(directory.path)) {
        const path = join(directory.path, name);
        const stat = lstatSync(path);
        if (!safeFile(stat)) throw new Error("tool-output-retained-file-invalid");
        // Count payloads even when metadata is missing after an interrupted publication.
        if ((name.endsWith(".bin") || name.endsWith(".part")) && !excluded.has(name)) retained += stat.size;
      }
      if (retained + (active.size + 1) * MAX_TOOL_RESULT_ARTIFACT_BYTES > MAX_SESSION_TOOL_OUTPUT_BYTES) {
        reason = "session-limit";
      } else {
        paths = pathsFor(directory.path, toolUseId, captureId);
        active.set(captureId, paths);
        reservations.set(key, active);
        release = () => {
          active.delete(captureId);
          if (active.size === 0) reservations.delete(key);
        };
      }
    } catch { reason = "write-failed"; }
    return new ArtifactCapture(captureId, sessionId, toolUseId, directories, paths, release,
      this._writeForTest ?? writeChunk, this._beforePublishForTest, reason);
  }

  /** Validate persisted ownership without reading or hashing the output payload. */
  validateReference(sessionId: string, toolUseId: string, info: ToolOutputArtifactInfo): boolean {
    const expected = normalizeToolOutputArtifactInfo(info);
    if (!isValidSessionId(sessionId) || !isValidToolUseId(toolUseId) || !expected) return false;
    // An unavailable reference intentionally has no backing file to recover.
    if (expected.status === "unavailable") return true;
    try {
      const directories = this.directories(sessionId, false);
      const paths = pathsFor(directories.at(-1)!.path, toolUseId, expected.captureId);
      const metadata = JSON.parse(readOwnedFile(paths.metadata, MAX_METADATA_BYTES).toString("utf8")) as Record<string, unknown>;
      const stored = normalizeToolOutputArtifactInfo(metadata.info);
      if (Object.keys(metadata).some((key) => !["sessionId", "toolUseId", "info"].includes(key))
        || metadata.sessionId !== sessionId || metadata.toolUseId !== toolUseId
        || !stored || JSON.stringify(stored) !== JSON.stringify(expected)) return false;
      const data = lstatSync(paths.data);
      if (!safeFile(data) || data.size !== expected.capturedBytes || data.size > MAX_TOOL_RESULT_ARTIFACT_BYTES) return false;
      verifyDirectories(directories);
      const current = lstatSync(paths.data);
      return safeFile(current) && sameFile(current, data) && current.size === expected.capturedBytes;
    } catch { return false; }
  }

  read(sessionId: string, toolUseId: string, info: ToolOutputArtifactInfo): string | null {
    const expected = normalizeToolOutputArtifactInfo(info);
    if (!isValidSessionId(sessionId) || !isValidToolUseId(toolUseId) || !expected || expected.status === "unavailable") return null;
    try {
      const directories = this.directories(sessionId, false);
      const paths = pathsFor(directories.at(-1)!.path, toolUseId, expected.captureId);
      const metadata = JSON.parse(readOwnedFile(paths.metadata, MAX_METADATA_BYTES).toString("utf8")) as Record<string, unknown>;
      const stored = normalizeToolOutputArtifactInfo(metadata.info);
      if (Object.keys(metadata).some((key) => !["sessionId", "toolUseId", "info"].includes(key))
        || metadata.sessionId !== sessionId || metadata.toolUseId !== toolUseId
        || !stored || JSON.stringify(stored) !== JSON.stringify(expected)) return null;
      verifyDirectories(directories);
      const bytes = readOwnedFile(paths.data, MAX_TOOL_RESULT_ARTIFACT_BYTES);
      if (bytes.length !== expected.capturedBytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) return null;
      const text = decodedText(bytes, expected.status === "complete");
      verifyDirectories(directories);
      return text.length === expected.capturedChars ? text : null;
    } catch { return null; }
  }

  /** Remove only verified settled captures absent from every retained transcript. */
  prune(sessionId: string, retainedCaptureIds: ReadonlySet<string>): void {
    if (!isValidSessionId(sessionId)) throw new TypeError("tool-output-session-id-invalid");
    if ([...retainedCaptureIds].some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
      throw new TypeError("tool-output-capture-id-invalid");
    }
    let directories: OwnedPath[];
    try { directories = this.directories(sessionId, false); }
    catch { return; }
    const directory = directories.at(-1)!;
    const active = reservations.get(directory.realPath!);
    for (const name of readdirSync(directory.path)) {
      if (!name.endsWith(".json")) continue;
      try {
        verifyDirectories(directories);
        const metadataPath = join(directory.path, name);
        const metadata = JSON.parse(readOwnedFile(metadataPath, MAX_METADATA_BYTES).toString("utf8")) as Record<string, unknown>;
        const info = normalizeToolOutputArtifactInfo(metadata.info);
        if (metadata.sessionId !== sessionId || !isValidToolUseId(metadata.toolUseId) || !info
          || info.status === "unavailable" || retainedCaptureIds.has(info.captureId) || active?.has(info.captureId)) continue;
        const paths = pathsFor(directory.path, metadata.toolUseId, info.captureId);
        if (paths.metadata !== metadataPath || this.read(sessionId, metadata.toolUseId, info) === null) continue;
        const dataStat = lstatSync(paths.data);
        const metadataStat = lstatSync(paths.metadata);
        verifyDirectories(directories);
        if (!safeFile(dataStat) || !safeFile(metadataStat)) continue;
        unlinkSync(paths.data);
        // A failed data deletion leaves the reference and its quota intact.
        verifyDirectories(directories);
        if (sameFile(lstatSync(paths.metadata), metadataStat)) unlinkSync(paths.metadata);
      } catch { /* Keep unverifiable or undeletable files charged to the next quota scan. */ }
    }
  }
}
