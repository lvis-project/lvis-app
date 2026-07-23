import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";
import { FileLockReleaseError, withFileLock } from "../lib/with-file-lock.js";

const DOCUMENT_VERSION = 1;
const FILE_MODE = 0o600;
const MAX_SECRET_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_SECRET_KEY_LENGTH = 1_024;
const MAX_STABLE_READ_ATTEMPTS = 3;
const log = createLogger("secret-document-store");

export type SecretPolicy = "packaged" | "development";

export interface SecretEncryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend():
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "unknown";
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

type SecretEntry =
  | { encoding: "safe-storage"; value: string }
  | { encoding: "plain-development"; value: string };

interface SecretDocument {
  version: typeof DOCUMENT_VERSION;
  entries: Record<string, SecretEntry>;
}

interface SecretStoreRuntime {
  read(path: string): string;
  exists(path: string): boolean;
  repairMode(path: string, mode: number): boolean;
  writeAtomic(path: string, content: string, mode: number): void;
  lock<T>(anchorPath: string, callback: () => Promise<T>): Promise<T>;
  warn(event: SecretStoreReconciliationWarning): void;
}

export interface SecretStoreReconciliationWarning {
  reason: "atomic-directory-sync-unconfirmed" | "lock-release-failed-after-commit";
  path: string;
  error: unknown;
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isSameRegularFile(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size;
}

function openSecretFileNoFollow(path: string): number {
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  return openSync(path, constants.O_RDONLY | noFollow);
}

function readStableSecretFile(path: string): string {
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    let fd: number | undefined;
    try {
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new SecretDocumentValidationError("Secret document must be a regular file");
      }
      if (before.size > MAX_SECRET_DOCUMENT_BYTES) {
        throw new SecretDocumentValidationError("Secret document exceeds the size limit");
      }
      fd = openSecretFileNoFollow(path);
      const opened = fstatSync(fd);
      if (!isSameRegularFile(before, opened)) continue;
      const bytes = readFileSync(fd);
      const afterHandle = fstatSync(fd);
      const afterPath = lstatSync(path);
      if (!isSameRegularFile(opened, afterHandle)
        || !isSameRegularFile(opened, afterPath)
        || bytes.byteLength !== opened.size) {
        continue;
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new SecretDocumentValidationError("Secret document is not valid UTF-8", error);
      }
    } catch (error) {
      if (error instanceof SecretDocumentValidationError) throw error;
      if (attempt + 1 >= MAX_STABLE_READ_ATTEMPTS) {
        throw new SecretDocumentValidationError("Secret document could not be read safely", error);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new SecretDocumentValidationError("Secret document changed during read");
}

function repairSecretFileMode(path: string, mode: number): boolean {
  if (process.platform === "win32") return false;
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new SecretDocumentValidationError("Secret document must be a regular file");
    }
    fd = openSecretFileNoFollow(path);
    const opened = fstatSync(fd);
    if (!isSameRegularFile(before, opened)) {
      throw new SecretDocumentValidationError("Secret document changed during mode repair");
    }
    const changed = (opened.mode & 0o777) !== mode;
    if (changed) fchmodSync(fd, mode);
    if (!isSameRegularFile(opened, lstatSync(path))) {
      throw new SecretDocumentValidationError("Secret document changed during mode repair");
    }
    return changed;
  } catch (error) {
    if (error instanceof SecretDocumentValidationError) throw error;
    throw new SecretDocumentValidationError("Secret document mode could not be repaired", error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const DEFAULT_RUNTIME: SecretStoreRuntime = {
  read: readStableSecretFile,
  exists: pathEntryExists,
  repairMode: repairSecretFileMode,
  writeAtomic: writeUtf8FileAtomicSync,
  lock: withFileLock,
  warn: (event) => {
    log.warn(
      { err: event.error, path: event.path, reason: event.reason },
      event.reason === "atomic-directory-sync-unconfirmed"
        ? "secret document rename committed; exact bytes verified after parent directory sync failure"
        : "secret document commit completed but lock release failed; exact bytes verified and stale-lock recovery may be required",
    );
  },
};

interface StoredState {
  kind: "absent" | "canonical" | "legacy";
  document: SecretDocument;
  raw: string | null;
}

interface ExpectedState {
  exists: boolean;
  bytes: string | null;
}

interface MutationResult<T> {
  value: T;
  expected: ExpectedState;
}

const mutationQueues = new Map<string, Promise<void>>();

export class SecretDocumentValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SecretDocumentValidationError";
  }
}

export class SecretDocumentDecryptionError extends Error {
  constructor() {
    super("Stored secret could not be decrypted");
    this.name = "SecretDocumentDecryptionError";
  }
}

export class SecretEncryptionUnavailableError extends Error {
  constructor() {
    super("Electron safeStorage encryption is unavailable for encrypted secret storage");
    this.name = "SecretEncryptionUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSecretKey(key: string): void {
  if (typeof key !== "string"
    || key.length === 0
    || key.length > MAX_SECRET_KEY_LENGTH
    || key.includes("\0")) {
    throw new SecretDocumentValidationError("Secret document contains an invalid key");
  }
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function cloneDocument(document: SecretDocument): SecretDocument {
  const entries = Object.create(null) as Record<string, SecretEntry>;
  for (const [key, entry] of Object.entries(document.entries)) {
    entries[key] = { ...entry };
  }
  return {
    version: DOCUMENT_VERSION,
    entries,
  };
}

function emptyDocument(): SecretDocument {
  return { version: DOCUMENT_VERSION, entries: Object.create(null) as Record<string, SecretEntry> };
}

function validateCanonicalDocument(value: unknown): SecretDocument {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["version", "entries"])
    || value.version !== DOCUMENT_VERSION
    || !isRecord(value.entries)) {
    throw new SecretDocumentValidationError("Invalid versioned secret document");
  }
  const entries = Object.create(null) as Record<string, SecretEntry>;
  for (const [key, candidate] of Object.entries(value.entries)) {
    validateSecretKey(key);
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, ["encoding", "value"])
      || typeof candidate.value !== "string") {
      throw new SecretDocumentValidationError("Secret document contains an invalid entry");
    }
    if (candidate.encoding === "safe-storage") {
      if (!isCanonicalBase64(candidate.value)) {
        throw new SecretDocumentValidationError("Secret document contains invalid ciphertext encoding");
      }
      entries[key] = { encoding: "safe-storage", value: candidate.value };
    } else if (candidate.encoding === "plain-development") {
      entries[key] = { encoding: "plain-development", value: candidate.value };
    } else {
      throw new SecretDocumentValidationError("Secret document contains an invalid entry encoding");
    }
  }
  return { version: DOCUMENT_VERSION, entries };
}

function validateLegacyDocument(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new SecretDocumentValidationError("Invalid legacy secret document");
  const entries = Object.entries(value);
  for (const [key, stored] of entries) {
    validateSecretKey(key);
    if (typeof stored !== "string") {
      throw new SecretDocumentValidationError("Legacy secret document must be a flat string map");
    }
    if (!stored.startsWith("plain:") && !isCanonicalBase64(stored)) {
      throw new SecretDocumentValidationError("Legacy secret document contains invalid ciphertext encoding");
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseStoredState(raw: string, allowLegacy: boolean): StoredState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SecretDocumentValidationError("Secret document contains invalid JSON");
  }
  const hasVersionedMarker = isRecord(parsed)
    && (Object.hasOwn(parsed, "version") || Object.hasOwn(parsed, "entries"));
  if (hasVersionedMarker) {
    return { kind: "canonical", document: validateCanonicalDocument(parsed), raw };
  }
  try {
    return { kind: "canonical", document: validateCanonicalDocument(parsed), raw };
  } catch (canonicalError) {
    if (!allowLegacy) throw canonicalError;
  }
  const legacy = validateLegacyDocument(parsed);
  return {
    kind: "legacy",
    document: {
      version: DOCUMENT_VERSION,
      entries: Object.fromEntries(
        Object.entries(legacy).map(([key, value]) => [
          key,
          value.startsWith("plain:")
            ? { encoding: "plain-development" as const, value: value.slice(6) }
            : { encoding: "safe-storage" as const, value },
        ]),
      ),
    },
    raw,
  };
}

function canonicalBytes(document: SecretDocument): string {
  const entries = Object.fromEntries(
    Object.keys(document.entries).sort().map((key) => [key, document.entries[key]]),
  );
  return `${JSON.stringify({ version: DOCUMENT_VERSION, entries }, null, 2)}\n`;
}

async function enqueueMutation<T>(path: string, callback: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolvePending) => { release = resolvePending; });
  const tail = previous.catch(() => undefined).then(() => pending);
  mutationQueues.set(path, tail);
  await previous.catch(() => undefined);
  try {
    return await callback();
  } finally {
    release();
    if (mutationQueues.get(path) === tail) mutationQueues.delete(path);
  }
}

export interface SecretDocumentStoreOptions {
  path: string;
  policy: SecretPolicy;
  encryption: SecretEncryption;
  platform?: NodeJS.Platform;
  runtime?: Partial<SecretStoreRuntime>;
}

export class SecretDocumentStore {
  readonly path: string;
  readonly lockAnchorPath: string;
  private readonly policy: SecretPolicy;
  private readonly encryption: SecretEncryption;
  private readonly platform: NodeJS.Platform;
  private readonly runtime: SecretStoreRuntime;

  constructor(options: SecretDocumentStoreOptions) {
    this.path = resolve(options.path);
    this.lockAnchorPath = resolve(dirname(this.path), `${basename(this.path)}.lock-anchor`);
    this.policy = options.policy;
    this.encryption = options.encryption;
    this.platform = options.platform ?? process.platform;
    this.runtime = { ...DEFAULT_RUNTIME, ...options.runtime };
  }

  get(key: string): string | null {
    validateSecretKey(key);
    const state = this.readState(false);
    if (!Object.hasOwn(state.document.entries, key)) return null;
    const entry = state.document.entries[key];
    if (entry.encoding === "plain-development") {
      if (this.policy === "packaged") throw new SecretEncryptionUnavailableError();
      return entry.value;
    }
    if (!this.isEncryptionUsable()) throw new SecretEncryptionUnavailableError();
    return this.decrypt(entry.value);
  }

  getEncrypted(key: string): string | null {
    validateSecretKey(key);
    const state = this.readState(false);
    if (!Object.hasOwn(state.document.entries, key)) return null;
    const entry = state.document.entries[key];
    if (entry.encoding !== "safe-storage") {
      if (this.policy === "packaged") throw new SecretEncryptionUnavailableError();
      return null;
    }
    if (!this.isEncryptionUsable()) throw new SecretEncryptionUnavailableError();
    return this.decrypt(entry.value);
  }

  async set(key: string, value: string): Promise<void> {
    validateSecretKey(key);
    await this.mutate(false, (document) => {
      this.assertWritesAvailable();
      this.upgradePlainEntries(document);
      document.entries[key] = this.encode(value);
    });
  }

  async delete(key: string): Promise<boolean> {
    validateSecretKey(key);
    return this.mutate(false, (document) => {
      this.assertWritesAvailable();
      this.upgradePlainEntries(document);
      if (!Object.hasOwn(document.entries, key)) return false;
      delete document.entries[key];
      return true;
    });
  }

  async deleteMany(keys: Iterable<string>): Promise<number> {
    const requested = [...keys];
    for (const key of requested) validateSecretKey(key);
    return this.mutate(false, (document) => {
      this.assertWritesAvailable();
      this.upgradePlainEntries(document);
      let deleted = 0;
      for (const key of requested) {
        if (!Object.hasOwn(document.entries, key)) continue;
        delete document.entries[key];
        deleted += 1;
      }
      return deleted;
    });
  }

  async migrate(): Promise<boolean> {
    if (!this.runtime.exists(this.path)) return false;
    return this.mutate(true, (document, source, modeWasRepaired) => {
      const encryptionAvailable = this.isEncryptionUsable();
      const hasPlain = Object.values(document.entries)
        .some((entry) => entry.encoding === "plain-development");
      const hasStoredSecrets = Object.keys(document.entries).length > 0;
      const needsWrite = source === "legacy" || hasPlain && encryptionAvailable;
      if (this.policy === "packaged" && !encryptionAvailable && hasStoredSecrets) {
        throw new SecretEncryptionUnavailableError();
      }
      if (source === "legacy" && encryptionAvailable) this.reencryptLegacyEntries(document);
      this.upgradePlainEntries(document);
      if (source === "legacy" && !encryptionAvailable) {
        for (const [key, entry] of Object.entries(document.entries)) {
          if (entry.encoding === "safe-storage") {
            throw new SecretEncryptionUnavailableError();
          }
          document.entries[key] = { ...entry };
        }
      }
      return needsWrite || modeWasRepaired;
    }, { repairModeBeforeRead: true, rewriteLegacy: true });
  }

  private readState(allowLegacy: boolean): StoredState {
    if (!this.runtime.exists(this.path)) {
      return { kind: "absent", document: emptyDocument(), raw: null };
    }
    try {
      return parseStoredState(this.runtime.read(this.path), allowLegacy);
    } catch (error) {
      if (error instanceof SecretDocumentValidationError) throw error;
      throw new SecretDocumentValidationError("Secret document could not be read safely", error);
    }
  }

  private encode(value: string): SecretEntry {
    if (this.isEncryptionUsable()) {
      return { encoding: "safe-storage", value: this.encryption.encryptString(value).toString("base64") };
    }
    if (this.policy === "packaged") throw new SecretEncryptionUnavailableError();
    return { encoding: "plain-development", value };
  }

  private assertWritesAvailable(): void {
    if (this.policy === "packaged" && !this.isEncryptionUsable()) {
      throw new SecretEncryptionUnavailableError();
    }
  }

  private isEncryptionUsable(): boolean {
    if (!this.encryption.isEncryptionAvailable()) return false;
    if (this.policy !== "packaged" || this.platform !== "linux") return true;
    try {
      const backend = this.encryption.getSelectedStorageBackend();
      return backend !== "basic_text" && backend !== "unknown";
    } catch {
      return false;
    }
  }

  private decrypt(value: string): string {
    try {
      return this.encryption.decryptString(Buffer.from(value, "base64"));
    } catch {
      throw new SecretDocumentDecryptionError();
    }
  }

  private reencryptLegacyEntries(document: SecretDocument): void {
    const replacements: Array<[string, SecretEntry]> = [];
    for (const [key, entry] of Object.entries(document.entries)) {
      const plaintext = entry.encoding === "safe-storage"
        ? this.decrypt(entry.value)
        : entry.value;
      replacements.push([key, this.encode(plaintext)]);
    }
    for (const [key, entry] of replacements) document.entries[key] = entry;
  }

  private upgradePlainEntries(document: SecretDocument): void {
    if (!this.isEncryptionUsable()) {
      if (this.policy === "packaged"
        && Object.values(document.entries).some((entry) => entry.encoding === "plain-development")) {
        throw new SecretEncryptionUnavailableError();
      }
      return;
    }
    const upgrades: Array<[string, SecretEntry]> = [];
    for (const [key, entry] of Object.entries(document.entries)) {
      if (entry.encoding !== "plain-development") continue;
      upgrades.push([key, this.encode(entry.value)]);
    }
    for (const [key, entry] of upgrades) document.entries[key] = entry;
  }

  private matchesExpected(expected: ExpectedState): boolean {
    if (!expected.exists) return !this.runtime.exists(this.path);
    return this.runtime.exists(this.path) && this.runtime.read(this.path) === expected.bytes;
  }

  private async mutate<T>(
    allowLegacy: boolean,
    callback: (
      document: SecretDocument,
      source: StoredState["kind"],
      modeWasRepaired: boolean,
    ) => T,
    options: { repairModeBeforeRead?: boolean; rewriteLegacy?: boolean } = {},
  ): Promise<T> {
    return enqueueMutation(this.path, async () => {
      let completed: MutationResult<T>;
      try {
        completed = await this.runtime.lock(this.lockAnchorPath, async () => {
          const modeWasRepaired = options.repairModeBeforeRead === true
            && this.platform !== "win32"
            && this.runtime.exists(this.path)
            ? this.runtime.repairMode(this.path, FILE_MODE)
            : false;
          const state = this.readState(allowLegacy);
          const document = cloneDocument(state.document);
          const before = canonicalBytes(state.document);
          const value = callback(document, state.kind, modeWasRepaired);
          const intended = canonicalBytes(document);
          const contentChanged = intended !== before
            || (options.rewriteLegacy === true && state.kind === "legacy");
          const shouldWrite = contentChanged
            && (state.kind !== "absent" || Object.keys(document.entries).length > 0);
          if (shouldWrite) {
            try {
              this.runtime.writeAtomic(this.path, intended, FILE_MODE);
            } catch (error) {
              if ((error as { committed?: unknown }).committed !== true
                || this.runtime.read(this.path) !== intended) {
                throw error;
              }
              this.runtime.warn({
                reason: "atomic-directory-sync-unconfirmed",
                path: this.path,
                error,
              });
            }
          }
          return {
            value,
            expected: shouldWrite
              ? { exists: true, bytes: intended }
              : { exists: state.kind !== "absent", bytes: state.raw },
          };
        });
      } catch (error) {
        if (!(error instanceof FileLockReleaseError)) throw error;
        const result = error.result as MutationResult<T>;
        if (!this.matchesExpected(result.expected)) throw error;
        this.runtime.warn({
          reason: "lock-release-failed-after-commit",
          path: this.path,
          error: error.releaseError,
        });
        completed = result;
      }
      return completed.value;
    });
  }
}
