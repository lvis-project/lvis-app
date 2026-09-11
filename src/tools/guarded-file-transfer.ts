import { constants, createReadStream, read, type Stats, type ReadStream } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { canonicalizePathForMatch, caseFoldForMatch, foldCanonicalPathSeparators } from "../permissions/sensitive-paths.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { errorMessage } from "../shared/error-message.js";
import { ensureFileAccess } from "./file-access-policy.js";
import { FileTransferError } from "./file-transfer-error.js";
import { FILE_TRANSFER_LIMITS, validateFileTransferLimits } from "./file-transfer-policy.js";
import type { CopyPathInput, FileTransferLimits, TransferResult, TransferSession, TransferSummary } from "./file-transfer-types.js";
import type { ToolExecutionContext } from "./types.js";

type EntryKind = "file" | "directory";
type Identity = Pick<Stats, "dev" | "ino">;
type Anchor = { path: string; identity: Identity };
type OwnedHandle = { handle: FileHandle; path: string; closing?: Promise<void> };
type OwnedEntry = {
  relativePath: string;
  kind: EntryKind;
  identity?: Identity;
  parentIdentity: Identity;
  explicit: boolean;
  handle?: OwnedHandle;
};
type TransferRequest = { sourcePath: string; destinationPath: string; destinationKind: EntryKind };

const REPORT_PATH_LIMIT = 20;
const REPORT_ERROR_BYTES = 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const CREATE_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);

class FileTransferCleanupError extends FileTransferError {
  constructor(message: string, cause: unknown) {
    super("io-error", message, { cause });
  }
}

function transferError(message: string): FileTransferError {
  return new FileTransferError("source-changed", message);
}

function hasErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sameIdentity(actual: Stats, expected: Identity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function sameSource(actual: Stats, expected: Stats): boolean {
  return sameIdentity(actual, expected) && actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs &&
    actual.nlink === expected.nlink && actual.mode === expected.mode;
}

function pathKey(path: string): string {
  return caseFoldForMatch(canonicalizePathForMatch(path));
}

function ownedPathKey(path: string): string {
  return caseFoldForMatch(foldCanonicalPathSeparators(path));
}

function containsPath(parent: string, child: string): boolean {
  const suffix = relative(pathKey(parent), pathKey(child));
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function resolvedInput(path: string, context: ToolExecutionContext): string {
  if (typeof path !== "string" || path.length === 0 || /[\x00-\x1f\x7f]/.test(path)) {
    throw new FileTransferError("path-denied", "A transfer path must be a non-empty path without control characters");
  }
  if (!isAbsolute(context.cwd)) throw new Error("File transfer requires an absolute context cwd");
  return resolve(context.cwd, expandLeadingTilde(path));
}

function assertAccess(path: string, context: ToolExecutionContext): void {
  const denied = ensureFileAccess(path, context, "write");
  if (denied) throw new FileTransferError("path-denied", denied.output);
}

function assertSupported(stats: Stats, path: string): void {
  if ((!stats.isFile() && !stats.isDirectory()) || (stats.isFile() && stats.nlink > 1)) {
    throw new FileTransferError("unsupported-entry", `Unsupported source entry: ${path}`);
  }
}

async function sourceEndpoint(input: string, context: ToolExecutionContext): Promise<{ path: string; stats: Stats }> {
  const lexical = resolvedInput(input, context);
  assertAccess(lexical, context);
  const before = await lstat(lexical);
  assertSupported(before, lexical);
  const path = await realpath(lexical);
  assertAccess(path, context);
  const stats = await lstat(path);
  if (!sameSource(stats, before)) throw transferError(`Source changed during path resolution: ${lexical}`);
  return { path, stats };
}

async function ancestorChain(path: string): Promise<Anchor[]> {
  const paths: string[] = [];
  for (let cursor = path; ; cursor = dirname(cursor)) {
    paths.unshift(cursor);
    if (dirname(cursor) === cursor) break;
  }
  const chain: Anchor[] = [];
  for (const parent of paths) {
    const stats = await lstat(parent);
    if (!stats.isDirectory()) throw transferError(`Parent is no longer an ordinary directory: ${parent}`);
    chain.push({ path: parent, identity: { dev: stats.dev, ino: stats.ino } });
  }
  return chain;
}

async function verifyAnchors(anchors: readonly Anchor[]): Promise<void> {
  for (const anchor of anchors) {
    const stats = await lstat(anchor.path);
    if (!stats.isDirectory() || !sameIdentity(stats, anchor.identity)) {
      throw transferError(`Parent directory changed: ${anchor.path}`);
    }
  }
}

function failedResult(error: unknown, cleanup: "not-created" | "removed" | "incomplete"): Extract<TransferResult, { ok: false }> {
  return {
    ok: false,
    code: error instanceof FileTransferError ? error.code : "io-error",
    message: errorMessage(error).slice(0, REPORT_ERROR_BYTES),
    cleanup,
  };
}

class OwnedTransfer {
  readonly limits: Readonly<FileTransferLimits>;
  readonly signal: AbortSignal;
  readonly ledger: OwnedEntry[] = [];
  readonly entries = new Map<string, OwnedEntry>();
  readonly handles = new Set<OwnedHandle>();
  readonly streams = new Set<Readable>();
  readonly work = new Set<Promise<unknown>>();
  readonly sourceClosures = new Set<Promise<void>>();
  readonly cleanupErrors: string[] = [];
  readonly summary: TransferSummary;
  sourceAnchors: Anchor[] = [];
  destinationAnchors: Anchor[] = [];
  sourceStats!: Stats;
  firstFailure: unknown;
  accepting = true;
  stopping = false;
  sourceBusy = false;
  readonly onAbort = (): void => this.stop(new FileTransferError("cancelled", "File transfer was cancelled"));

  constructor(readonly request: TransferRequest, readonly context: ToolExecutionContext, limits: Readonly<FileTransferLimits>) {
    validateFileTransferLimits(limits);
    this.limits = Object.freeze({ ...limits });
    this.signal = context.abortSignal ?? new AbortController().signal;
    this.summary = { sourcePath: "", destinationPath: "", files: 0, directories: 0, bytesWritten: 0 };
    this.signal.addEventListener("abort", this.onAbort, { once: true });
    if (this.signal.aborted) this.onAbort();
  }

  check(): void {
    if (this.signal.aborted) throw new FileTransferError("cancelled", "File transfer was cancelled");
    if (this.stopping) throw this.firstFailure ?? new Error("File transfer is stopped");
  }

  stop(error: unknown): void {
    this.firstFailure ??= error;
    this.stopping = true;
    for (const stream of this.streams) stream.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = (async () => {
      if (!this.accepting) throw new Error("File transfer no longer accepts work");
      this.check();
      return operation();
    })();
    this.work.add(promise);
    void promise.then(() => this.work.delete(promise), (error: unknown) => {
      this.work.delete(promise);
      this.stop(error);
    });
    return promise;
  }

  addCleanupError(message: string): void {
    if (this.cleanupErrors.length < REPORT_PATH_LIMIT) this.cleanupErrors.push(message.slice(0, REPORT_ERROR_BYTES));
  }

  ownHandle(handle: FileHandle, path: string): OwnedHandle {
    const owned = { handle, path };
    this.handles.add(owned);
    return owned;
  }

  closeHandle(owned: OwnedHandle): Promise<void> {
    owned.closing ??= owned.handle.close().catch((error: unknown) => {
      this.addCleanupError(`Descriptor close failed for ${owned.path}: ${errorMessage(error)}`);
      throw error;
    }).finally(() => this.handles.delete(owned));
    return owned.closing;
  }

  async prepare(): Promise<void> {
    this.check();
    const source = await sourceEndpoint(this.request.sourcePath, this.context);
    this.summary.sourcePath = source.path;
    this.sourceStats = source.stats;
    const lexicalDestination = resolvedInput(this.request.destinationPath, this.context);
    assertAccess(lexicalDestination, this.context);
    if (containsPath(source.path, lexicalDestination) || containsPath(lexicalDestination, source.path)) {
      throw new FileTransferError("source-destination-overlap", "Source and destination paths overlap");
    }
    // Inspect the entry itself before canonical resolution can follow a link.
    try {
      await lstat(lexicalDestination);
      throw new FileTransferError("destination-exists", `Destination already exists: ${lexicalDestination}`);
    } catch (error) {
      if (!hasErrno(error, "ENOENT")) throw error;
    }
    let parent: string;
    try {
      parent = await realpath(dirname(lexicalDestination));
      if (!(await lstat(parent)).isDirectory()) throw new Error("Parent is not a directory");
    } catch (error) {
      throw new FileTransferError("invalid-destination-parent", `Destination parent must be an existing directory: ${dirname(lexicalDestination)}`, { cause: error });
    }
    assertAccess(parent, this.context);
    this.summary.destinationPath = join(parent, basename(lexicalDestination));
    assertAccess(this.summary.destinationPath, this.context);
    if (containsPath(source.path, this.summary.destinationPath) || containsPath(this.summary.destinationPath, source.path)) {
      throw new FileTransferError("source-destination-overlap", "Source and destination paths overlap");
    }
    this.sourceAnchors = await ancestorChain(dirname(source.path));
    this.destinationAnchors = await ancestorChain(parent);
    await this.verifySource(source.path, source.stats);
    await this.createEntry("", this.request.destinationKind, false);
  }

  relativePath(path: string): string {
    if (path === "") return path;
    if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || /[\\\x00-\x1f\x7f]/.test(path)) {
      throw new FileTransferError("path-denied", `Invalid transfer member path: ${path}`);
    }
    const components = path.split("/");
    if (components.some((part) => part === "" || part === "." || part === "..")) {
      throw new FileTransferError("path-denied", `Invalid transfer member path: ${path}`);
    }
    if (components.length > this.limits.maxDepth || Buffer.byteLength(path, "utf8") > this.limits.maxRelativePathBytes) {
      throw new FileTransferError("limit-exceeded", "Transfer member path exceeds the path or depth limit");
    }
    return components.join(sep);
  }

  entryPath(entry: OwnedEntry): string {
    return entry.relativePath === "" ? this.summary.destinationPath : join(this.summary.destinationPath, entry.relativePath);
  }

  ownedChain(entry: OwnedEntry): OwnedEntry[] {
    const parents: OwnedEntry[] = [];
    let current = entry;
    while (current.relativePath !== "") {
      const parentRelative = dirname(current.relativePath) === "." ? "" : dirname(current.relativePath);
      const parent = this.entries.get(ownedPathKey(join(this.summary.destinationPath, parentRelative)));
      if (!parent || parent.kind !== "directory" || !parent.identity ||
          parent.identity.dev !== current.parentIdentity.dev || parent.identity.ino !== current.parentIdentity.ino) {
        throw transferError(`Owned parent is missing: ${this.entryPath(current)}`);
      }
      parents.unshift(parent);
      current = parent;
    }
    return [...parents, entry];
  }

  async verifyOwned(entry: OwnedEntry): Promise<void> {
    await verifyAnchors(this.destinationAnchors);
    for (const owned of this.ownedChain(entry)) {
      const path = this.entryPath(owned);
      assertAccess(path, this.context);
      const stats = await lstat(path);
      if (!owned.identity || !sameIdentity(stats, owned.identity) ||
          (owned.kind === "file" ? !stats.isFile() || stats.nlink !== 1 : !stats.isDirectory())) {
        throw transferError(`Owned destination entry changed: ${path}`);
      }
    }
  }

  async createEntry(relativePath: string, kind: EntryKind, explicit: boolean): Promise<OwnedEntry> {
    this.check();
    if (this.ledger.length >= this.limits.maxEntries) throw new FileTransferError("limit-exceeded", "Transfer entry limit exceeded");
    const path = relativePath === "" ? this.summary.destinationPath : join(this.summary.destinationPath, relativePath);
    assertAccess(path, this.context);
    await verifyAnchors(this.destinationAnchors);
    let parentIdentity = this.destinationAnchors[this.destinationAnchors.length - 1].identity;
    if (relativePath !== "") {
      const parentRelative = dirname(relativePath) === "." ? "" : dirname(relativePath);
      const parent = this.entries.get(ownedPathKey(join(this.summary.destinationPath, parentRelative)));
      if (!parent || !parent.identity) throw new Error("Transfer parent must be owned before creating a child");
      await this.verifyOwned(parent);
      parentIdentity = parent.identity;
    }
    this.check();
    const entry: OwnedEntry = { relativePath, kind, parentIdentity, explicit };
    try {
      if (kind === "directory") {
        await mkdir(path, { mode: 0o700, recursive: false });
        this.ledger.push(entry);
        this.entries.set(ownedPathKey(path), entry);
        const stats = await lstat(path);
        if (!stats.isDirectory()) throw transferError(`Created directory changed: ${path}`);
        entry.identity = { dev: stats.dev, ino: stats.ino };
        this.summary.directories += 1;
      } else {
        const handle = await open(path, CREATE_FLAGS, 0o600);
        entry.handle = this.ownHandle(handle, path);
        this.ledger.push(entry);
        this.entries.set(ownedPathKey(path), entry);
        const stats = await handle.stat();
        if (!stats.isFile() || stats.nlink !== 1) throw transferError(`Created file changed: ${path}`);
        entry.identity = { dev: stats.dev, ino: stats.ino };
      }
    } catch (error) {
      if (hasErrno(error, "EEXIST")) throw new FileTransferError("destination-exists", `Destination already exists: ${path}`, { cause: error });
      throw error;
    }
    await this.verifyOwned(entry);
    this.check();
    return entry;
  }

  async ensureParents(relativePath: string): Promise<void> {
    const components = relativePath.split(sep).slice(0, -1);
    for (let count = 1; count <= components.length; count += 1) {
      this.check();
      const parentRelative = components.slice(0, count).join(sep);
      const parent = this.entries.get(ownedPathKey(join(this.summary.destinationPath, parentRelative)));
      if (parent) {
        if (parent.kind !== "directory") throw new FileTransferError("destination-exists", "A transfer member conflicts with its parent");
        await this.verifyOwned(parent);
      } else {
        await this.createEntry(parentRelative, "directory", false);
      }
    }
  }

  async directory(path: string): Promise<void> {
    const normalized = this.relativePath(path);
    if (this.request.destinationKind !== "directory") throw new FileTransferError("unsupported-entry", "A single-file destination cannot contain a directory");
    await this.ensureParents(normalized);
    const existing = this.entries.get(ownedPathKey(join(this.summary.destinationPath, normalized)));
    if (existing) {
      if (existing.kind !== "directory" || existing.explicit) throw new FileTransferError("destination-exists", "Duplicate transfer directory");
      await this.verifyOwned(existing);
      existing.explicit = true;
    } else {
      await this.createEntry(normalized, "directory", true);
    }
  }

  async file(path: string, body: AsyncIterable<Uint8Array>, attributes: { expectedBytes: number; ownerExecutable: boolean }): Promise<void> {
    const normalized = this.relativePath(path);
    if ((this.request.destinationKind === "file") !== (normalized === "")) {
      throw new FileTransferError("unsupported-entry", "File member does not match the destination kind");
    }
    const expected = attributes.expectedBytes;
    if (!Number.isSafeInteger(expected) || expected < 0) throw transferError("Invalid expected file size");
    if (expected > this.limits.maxPayloadBytes - this.summary.bytesWritten) {
      throw new FileTransferError("limit-exceeded", "Transfer payload limit exceeded");
    }
    await this.ensureParents(normalized);
    let entry = this.entries.get(ownedPathKey(join(this.summary.destinationPath, normalized)));
    if (entry) {
      if (normalized !== "" || entry.kind !== "file" || entry.explicit) {
        throw new FileTransferError("destination-exists", "Duplicate transfer file");
      }
      entry.explicit = true;
    } else {
      entry = await this.createEntry(normalized, "file", true);
    }
    const owned = entry.handle;
    if (!owned) throw new Error("Owned file descriptor is missing");
    const buffer = Buffer.allocUnsafe(this.limits.bufferBytes);
    let buffered = 0;
    let received = 0;
    const flush = async (): Promise<void> => {
      let offset = 0;
      while (offset < buffered) {
        this.check();
        await this.verifyOwned(entry);
        this.check();
        const { bytesWritten } = await owned.handle.write(buffer, offset, buffered - offset, null);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffered - offset) {
          throw new Error("File write made invalid progress");
        }
        offset += bytesWritten;
        this.summary.bytesWritten += bytesWritten;
      }
      buffered = 0;
    };
    try {
      for await (const chunk of body) {
        this.check();
        if (!(chunk instanceof Uint8Array)) throw new Error("Transfer source must provide byte chunks");
        if (chunk.byteLength > this.limits.maxPayloadBytes - this.summary.bytesWritten - buffered) {
          throw new FileTransferError("limit-exceeded", "Transfer payload limit exceeded");
        }
        received += chunk.byteLength;
        if (received > expected) throw transferError("Source provided more bytes than its declared size");
        let offset = 0;
        while (offset < chunk.byteLength) {
          const count = Math.min(buffer.length - buffered, chunk.byteLength - offset);
          buffer.set(chunk.subarray(offset, offset + count), buffered);
          buffered += count;
          offset += count;
          if (buffered === buffer.length) await flush();
        }
      }
      if (received !== expected) throw transferError("Source provided fewer bytes than its declared size");
      await flush();
      this.check();
      await this.verifyOwned(entry);
      this.check();
      await owned.handle.chmod(attributes.ownerExecutable ? 0o700 : 0o600);
      this.check();
      this.summary.files += 1;
    } finally {
      await this.closeHandle(owned);
      delete entry.handle;
    }
  }

  async verifySource(path: string, expected: Stats): Promise<void> {
    await verifyAnchors(this.sourceAnchors);
    assertAccess(path, this.context);
    const suffix = relative(this.summary.sourcePath, path);
    if (suffix !== "" && (!this.sourceStats.isDirectory() || !containsPath(this.summary.sourcePath, path))) {
      throw new FileTransferError("path-denied", "A source file is outside the transfer source");
    }
    let cursor = this.summary.sourcePath;
    for (const component of suffix === "" ? [] : suffix.split(sep).slice(0, -1)) {
      const stats = await lstat(cursor);
      if (!stats.isDirectory()) throw transferError(`Source parent changed: ${cursor}`);
      cursor = join(cursor, component);
    }
    if (suffix !== "" && !(await lstat(cursor)).isDirectory()) throw transferError(`Source parent changed: ${cursor}`);
    const actual = await lstat(path);
    assertSupported(actual, path);
    if (!sameSource(actual, expected)) throw transferError(`Source changed during transfer: ${path}`);
  }

  async openSourceFile(path: string): Promise<Readable> {
    if (this.sourceBusy) throw new Error("Transfer source files must be opened serially");
    this.sourceBusy = true;
    try {
      return await this.createSourceStream(path);
    } catch (error) {
      this.sourceBusy = false;
      throw error;
    }
  }

  async createSourceStream(path: string): Promise<Readable> {
    const { path: lexical, stats: before } = await sourceEndpoint(path, this.context);
    if (!before.isFile() || before.nlink > 1) throw new FileTransferError("unsupported-entry", `Unsupported source file: ${lexical}`);
    await this.verifySource(lexical, before);
    if (pathKey(lexical) === pathKey(this.summary.sourcePath) && !sameSource(before, this.sourceStats)) {
      throw transferError(`Source changed before opening: ${lexical}`);
    }
    this.check();
    const owned = this.ownHandle(await open(lexical, READ_FLAGS), lexical);
    let raw: ReadStream | undefined;
    try {
      const snapshot = await owned.handle.stat();
      if (!snapshot.isFile() || snapshot.nlink > 1 || !sameSource(snapshot, before)) throw transferError(`Source changed while opening: ${lexical}`);
      await this.verifySource(lexical, snapshot);
      this.check();
      raw = createReadStream(lexical, {
        fd: owned.handle.fd,
        autoClose: false,
        highWaterMark: this.limits.bufferBytes,
        // Stream destruction waits for pending reads; the session owns the real close.
        fs: { read, close: (_fd, callback) => callback(null) },
      });
      const input = raw;
      input.on("error", () => undefined);
      this.streams.add(input);
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        closing ??= (async () => {
          const closed = input.closed ? Promise.resolve() : new Promise<void>((done) => input.once("close", done));
          input.destroy();
          await closed;
          this.streams.delete(input);
          try { await this.closeHandle(owned); } finally { this.sourceBusy = false; }
        })();
        return closing;
      };
      const transfer = this;
      const output = Readable.from((async function* () {
        let bytesRead = 0;
        try {
          for await (const chunk of input) {
            transfer.check();
            bytesRead += (chunk as Buffer).length;
            if (bytesRead > snapshot.size) throw transferError(`Source grew during transfer: ${lexical}`);
            yield chunk as Buffer;
          }
          if (bytesRead !== snapshot.size) throw transferError(`Source size changed during transfer: ${lexical}`);
          const after = await owned.handle.stat();
          if (!sameSource(after, snapshot)) throw transferError(`Open source changed during transfer: ${lexical}`);
          await transfer.verifySource(lexical, snapshot);
          transfer.check();
        } finally {
          await close();
        }
      })(), { objectMode: false, highWaterMark: this.limits.bufferBytes });
      this.streams.add(output);
      const settlement = finished(output, { cleanup: true }).catch((error: unknown) => this.stop(error)).then(close).finally(() => {
        this.streams.delete(output);
        this.sourceClosures.delete(settlement);
      });
      this.sourceClosures.add(settlement);
      void settlement.catch((error: unknown) => this.stop(error));
      return output;
    } catch (error) {
      if (raw) {
        const closed = raw.closed ? Promise.resolve() : new Promise<void>((done) => raw!.once("close", done));
        raw.destroy();
        await closed;
      }
      await this.closeHandle(owned);
      throw error;
    }
  }

  async settle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
    if (!this.stopping && this.streams.size > 0) {
      this.stop(new Error("Transfer producer did not consume all source streams"));
    }
    for (const stream of this.streams) stream.destroy();
    await Promise.allSettled([...this.sourceClosures]);
    for (const handle of [...this.handles]) {
      try { await this.closeHandle(handle); } catch (error) { this.stop(error); }
    }
  }

  async rollback(): Promise<Pick<Extract<TransferResult, { ok: false }>, "cleanup" | "residualPaths" | "cleanupErrors">> {
    const residualPaths: string[] = [];
    let incomplete = this.cleanupErrors.length > 0;
    for (const entry of [...this.ledger].reverse()) {
      const path = this.entryPath(entry);
      try {
        await this.verifyOwned(entry);
        if (entry.kind === "file") await unlink(path);
        else await rmdir(path);
      } catch (error) {
        incomplete = true;
        this.addCleanupError(`Cleanup preserved ${path}: ${errorMessage(error)}`);
        // Inspect ancestors first, so residual reporting never follows a detected substitute.
        try {
          await verifyAnchors(this.destinationAnchors);
          for (const owned of this.ownedChain(entry)) {
            const observedPath = this.entryPath(owned);
            assertAccess(observedPath, this.context);
            const stats = await lstat(observedPath);
            if (owned === entry || !owned.identity || !stats.isDirectory() || !sameIdentity(stats, owned.identity)) {
              if (residualPaths.length < REPORT_PATH_LIMIT && !residualPaths.includes(observedPath)) residualPaths.push(observedPath);
              break;
            }
          }
        } catch (observationError) {
          if (!hasErrno(observationError, "ENOENT")) this.addCleanupError(`Cannot inspect residual ${path}: ${errorMessage(observationError)}`);
        }
      }
    }
    return {
      cleanup: incomplete ? "incomplete" : this.ledger.length === 0 ? "not-created" : "removed",
      ...(residualPaths.length > 0 ? { residualPaths } : {}),
      ...(this.cleanupErrors.length > 0 ? { cleanupErrors: this.cleanupErrors } : {}),
    };
  }

  async run(produce: (session: TransferSession) => Promise<void>): Promise<TransferResult> {
    let sinkBusy = false;
    const sinkOperation = (operation: () => Promise<void>): Promise<void> => this.track(async () => {
      if (sinkBusy) throw new Error("Transfer sink operations must be serial");
      sinkBusy = true;
      try { await operation(); } finally { sinkBusy = false; }
    });
    try {
      await this.prepare();
      await produce({
        sourcePath: this.summary.sourcePath,
        destinationPath: this.summary.destinationPath,
        signal: this.signal,
        limits: this.limits,
        sink: {
          directory: (path) => sinkOperation(() => this.directory(path)),
          file: (path, body, attributes) => sinkOperation(() => this.file(path, body, attributes)),
        },
        openSourceFile: (path) => this.track(() => this.openSourceFile(path)),
      });
      this.accepting = false;
      await this.settle();
      this.check();
      if (this.request.destinationKind === "file" && this.summary.files !== 1) throw new Error("Transfer producer did not write the destination file");
      await this.verifySource(this.summary.sourcePath, this.sourceStats);
      for (const entry of this.ledger) {
        this.check();
        await this.verifyOwned(entry);
      }
      this.check();
      return { ok: true, summary: this.summary };
    } catch (error) {
      this.accepting = false;
      if (error instanceof FileTransferCleanupError) this.addCleanupError(error.message);
      this.stop(error);
      await this.settle();
      const failure = this.signal.aborted ? new FileTransferError("cancelled", "File transfer was cancelled") : this.firstFailure ?? error;
      const result = failedResult(failure, "not-created");
      return { ...result, ...await this.rollback() };
    } finally {
      this.accepting = false;
      this.signal.removeEventListener("abort", this.onAbort);
    }
  }
}

/** Exclusively creates one destination and rolls back only entries it still owns.
 * Path rechecks detect replacements; they do not close the final ancestor syscall race.
 */
export async function runOwnedTransfer(
  request: TransferRequest,
  context: ToolExecutionContext,
  produce: (session: TransferSession) => Promise<void>,
  limits: Readonly<FileTransferLimits> = FILE_TRANSFER_LIMITS,
): Promise<TransferResult> {
  try {
    return await new OwnedTransfer(request, context, limits).run(produce);
  } catch (error) {
    return failedResult(error, "not-created");
  }
}

export async function copyPath(input: CopyPathInput, context: ToolExecutionContext): Promise<TransferResult> {
  try {
    if (context.abortSignal?.aborted) throw new FileTransferError("cancelled", "File transfer was cancelled");
    const source = await sourceEndpoint(input.sourcePath, context);
    return await runOwnedTransfer({ ...input, destinationKind: source.stats.isDirectory() ? "directory" : "file" }, context, async (session) => {
      const check = (): void => {
        if (session.signal.aborted) throw new FileTransferError("cancelled", "File transfer was cancelled");
      };
      const copyFile = async (sourcePath: string, destinationRelative: string, before: Stats): Promise<void> => {
        const body = await session.openSourceFile(sourcePath);
        await session.sink.file(destinationRelative, body, { expectedBytes: before.size, ownerExecutable: (before.mode & 0o100) !== 0 });
        if (!sameSource(await lstat(sourcePath), before)) throw transferError(`Source changed during copy: ${sourcePath}`);
      };
      const visit = async (sourcePath: string, destinationRelative: string, before: Stats): Promise<void> => {
        check();
        assertAccess(sourcePath, context);
        assertSupported(before, sourcePath);
        if (before.isFile()) return copyFile(sourcePath, destinationRelative, before);
        await session.sink.directory(destinationRelative);
        check();
        assertAccess(sourcePath, context);
        if (!sameSource(await lstat(sourcePath), before)) throw transferError(`Source directory changed before opening: ${sourcePath}`);
        const directory = await opendir(sourcePath, { bufferSize: 1 });
        try {
          while (true) {
            check();
            if (!sameSource(await lstat(sourcePath), before)) throw transferError(`Source directory changed: ${sourcePath}`);
            const entry = await directory.read();
            if (!entry) break;
            check();
            const childSource = join(sourcePath, entry.name);
            assertAccess(childSource, context);
            const childRelative = destinationRelative === "" ? entry.name : `${destinationRelative}/${entry.name}`;
            if (childRelative.split("/").length > session.limits.maxDepth || Buffer.byteLength(childRelative) > session.limits.maxRelativePathBytes) {
              throw new FileTransferError("limit-exceeded", "Source tree exceeds the path or depth limit");
            }
            await visit(childSource, childRelative, await lstat(childSource));
          }
          if (!sameSource(await lstat(sourcePath), before)) throw transferError(`Source directory changed: ${sourcePath}`);
        } finally {
          try { await directory.close(); } catch (error) {
            throw new FileTransferCleanupError(`Source directory close failed: ${sourcePath}`, error);
          }
        }
      };
      const current = await lstat(session.sourcePath);
      if (!sameSource(current, source.stats)) throw transferError("Source changed before copying");
      await visit(session.sourcePath, "", current);
    });
  } catch (error) {
    return failedResult(error, "not-created");
  }
}
